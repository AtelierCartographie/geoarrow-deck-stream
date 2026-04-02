/**
 * WKB Reader - Direct WKB binary → GeoArrow Arrow Table conversion
 *
 * Reads raw WKB/EWKB binary from Arrow Binary columns and produces
 * native GeoArrow-encoded Arrow Tables (interleaved FixedSizeList encoding).
 *
 * This enables a DuckDB WASM workflow where ST_AsWKB() is used as a workaround
 * for the lack of native GeoArrow export (duckdb/duckdb-wasm#2187).
 *
 * Data flow:
 *   Arrow Table (Binary column with WKB blobs)
 *     → Two-pass decode (count, then extract)
 *     → Arrow Table with native GeoArrow geometry column + ARROW:extension:name metadata
 *     → Feed into geoarrow-deck-stream pipeline
 *
 * Supports: Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon
 * Handles: EWKB (SRID flag), ISO Z/M dimensions (projected to 2D), EMPTY geometries, NULL values
 */

import type { Data } from 'apache-arrow';
import {
  Field,
  FixedSizeList,
  Float64,
  List,
  makeData,
  RecordBatch,
  Schema,
  Struct,
  Table,
  Vector,
} from 'apache-arrow';

// ─── WKB geometry type constants ─────────────────────────────────────

export type WkbGeomType =
  | 'point'
  | 'linestring'
  | 'polygon'
  | 'multipoint'
  | 'multilinestring'
  | 'multipolygon';

const EXTENSION_NAMES: Record<WkbGeomType, string> = {
  point: 'geoarrow.point',
  linestring: 'geoarrow.linestring',
  polygon: 'geoarrow.polygon',
  multipoint: 'geoarrow.multipoint',
  multilinestring: 'geoarrow.multilinestring',
  multipolygon: 'geoarrow.multipolygon',
};

// ─── WKB header parsing ──────────────────────────────────────────────

interface WkbHeader {
  /** Base geometry type (1=Point, 2=LineString, ..., 6=MultiPolygon) */
  baseType: number;
  /** Little-endian byte order */
  le: boolean;
  /** Bytes per coordinate (16=XY, 24=XYZ or XYM, 32=XYZM) */
  coordStride: number;
  /** Byte offset where geometry-specific data begins (after header + optional SRID) */
  dataOffset: number;
}

/**
 * Parse WKB/EWKB header. Returns null for invalid data.
 * Handles both ISO and EWKB dimension flags.
 */
function readWkbHeader(wkb: Uint8Array): WkbHeader | null {
  if (wkb.length < 5) return null;

  const le = wkb[0] === 1;
  const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
  const rawType = dv.getUint32(1, le);

  let headerSize = 5;

  // EWKB SRID flag — 4 extra bytes after type
  if ((rawType & 0x20000000) !== 0) headerSize += 4;

  // EWKB dimension flags
  const ewkbZ = (rawType & 0x80000000) !== 0;
  const ewkbM = (rawType & 0x40000000) !== 0;

  // Strip all EWKB flags to get base type
  let baseType = rawType & 0x0fffffff;

  // ISO dimension ranges: 1001–1006 (Z), 2001–2006 (M), 3001–3006 (ZM)
  let isoZ = false;
  let isoM = false;
  if (baseType > 3000) {
    isoZ = true;
    isoM = true;
    baseType -= 3000;
  } else if (baseType > 2000) {
    isoM = true;
    baseType -= 2000;
  } else if (baseType > 1000) {
    isoZ = true;
    baseType -= 1000;
  }

  const dims = (ewkbZ || isoZ ? 1 : 0) + (ewkbM || isoM ? 1 : 0);
  const coordStride = (2 + dims) * 8;

  return { baseType, le, coordStride, dataOffset: headerSize };
}

/**
 * Classify WKB type from first 5 bytes without full parse.
 */
function classifyWkbType(wkb: Uint8Array): WkbGeomType | null {
  const h = readWkbHeader(wkb);
  if (!h) return null;
  switch (h.baseType) {
    case 1: return 'point';
    case 2: return 'linestring';
    case 3: return 'polygon';
    case 4: return 'multipoint';
    case 5: return 'multilinestring';
    case 6: return 'multipolygon';
    default: return null;
  }
}

// ─── Shared Arrow type helpers ───────────────────────────────────────

const coordChildField = new Field('xy', new Float64());
const coordType = new FixedSizeList(2, coordChildField);

function makeCoordData(coords: Float64Array, numPoints: number): Data<FixedSizeList> {
  const floatData = makeData({ type: new Float64(), length: coords.length, data: coords });
  return makeData({ type: coordType, length: numPoints, nullCount: 0, child: floatData });
}

// ─── Per-type WKB decoders ───────────────────────────────────────────
// Each follows a two-pass pattern: count first, then extract.
// Only X and Y are extracted; Z/M are skipped via coordStride.

/**
 * Decode Point WKBs into FixedSizeList<Float64>[2]
 */
function decodePoints(
  wkbs: (Uint8Array | null)[],
  nullBitmap: Uint8Array,
  validCount: number,
): Data {
  const n = wkbs.length;
  const coords = new Float64Array(n * 2);

  for (let i = 0; i < n; i++) {
    const wkb = wkbs[i];
    if (!wkb) {
      coords[i * 2] = NaN;
      coords[i * 2 + 1] = NaN;
      continue;
    }
    const h = readWkbHeader(wkb);
    if (!h || h.baseType !== 1 || wkb.byteLength < h.dataOffset + 16) {
      coords[i * 2] = NaN;
      coords[i * 2 + 1] = NaN;
      continue;
    }
    const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    coords[i * 2] = dv.getFloat64(h.dataOffset, h.le);
    coords[i * 2 + 1] = dv.getFloat64(h.dataOffset + 8, h.le);
  }

  const floatData = makeData({ type: new Float64(), length: coords.length, data: coords });
  return makeData({
    type: coordType,
    length: n,
    nullCount: n - validCount,
    nullBitmap,
    child: floatData,
  });
}

/**
 * Decode LineString WKBs into List<FixedSizeList<Float64>[2]>
 */
function decodeLineStrings(
  wkbs: (Uint8Array | null)[],
  nullBitmap: Uint8Array,
  validCount: number,
): Data {
  const n = wkbs.length;
  const geomOffsets = new Int32Array(n + 1);
  let totalCoords = 0;

  // Pass 1: count
  for (let i = 0; i < n; i++) {
    geomOffsets[i] = totalCoords;
    const wkb = wkbs[i];
    if (!wkb) continue;
    const h = readWkbHeader(wkb);
    if (!h || h.baseType !== 2) continue;
    if (wkb.byteLength < h.dataOffset + 4) continue;
    const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    totalCoords += dv.getUint32(h.dataOffset, h.le);
  }
  geomOffsets[n] = totalCoords;

  // Pass 2: extract
  const coords = new Float64Array(totalCoords * 2);
  let ci = 0;

  for (let i = 0; i < n; i++) {
    const wkb = wkbs[i];
    if (!wkb) continue;
    const h = readWkbHeader(wkb);
    if (!h || h.baseType !== 2) continue;
    if (wkb.byteLength < h.dataOffset + 4) continue;
    const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    const numPts = dv.getUint32(h.dataOffset, h.le);
    let off = h.dataOffset + 4;
    for (let j = 0; j < numPts; j++) {
      coords[ci++] = dv.getFloat64(off, h.le);
      coords[ci++] = dv.getFloat64(off + 8, h.le);
      off += h.coordStride;
    }
  }

  const fslData = makeCoordData(coords, totalCoords);
  const listType = new List(new Field('vertices', coordType));
  return makeData({
    type: listType,
    length: n,
    nullCount: n - validCount,
    nullBitmap,
    valueOffsets: geomOffsets,
    child: fslData,
  });
}

/**
 * Read ring data from a polygon WKB at a given offset.
 * Returns the updated byte offset after reading all rings.
 */
function readPolygonRings(
  dv: DataView,
  le: boolean,
  coordStride: number,
  startOff: number,
  numRings: number,
  coords: Float64Array,
  ci: { value: number },
  ringOffsets: Int32Array,
  ri: { value: number },
): number {
  let off = startOff;
  for (let r = 0; r < numRings; r++) {
    ringOffsets[ri.value++] = ci.value >> 1;
    const numPts = dv.getUint32(off, le);
    off += 4;
    for (let j = 0; j < numPts; j++) {
      coords[ci.value++] = dv.getFloat64(off, le);
      coords[ci.value++] = dv.getFloat64(off + 8, le);
      off += coordStride;
    }
  }
  return off;
}

/**
 * Decode Polygon WKBs into List<List<FixedSizeList<Float64>[2]>>
 */
function decodePolygons(
  wkbs: (Uint8Array | null)[],
  nullBitmap: Uint8Array,
  validCount: number,
): Data {
  const n = wkbs.length;
  const geomOffsets = new Int32Array(n + 1);
  let totalRings = 0;
  let totalCoords = 0;

  // Pass 1: count rings and coordinates
  for (let i = 0; i < n; i++) {
    geomOffsets[i] = totalRings;
    const wkb = wkbs[i];
    if (!wkb) continue;
    const h = readWkbHeader(wkb);
    if (!h || h.baseType !== 3) continue;
    if (wkb.byteLength < h.dataOffset + 4) continue;
    const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    const numRings = dv.getUint32(h.dataOffset, h.le);
    let off = h.dataOffset + 4;
    for (let r = 0; r < numRings; r++) {
      const numPts = dv.getUint32(off, h.le);
      off += 4 + numPts * h.coordStride;
      totalCoords += numPts;
      totalRings++;
    }
  }
  geomOffsets[n] = totalRings;

  // Pass 2: extract
  const ringOffsets = new Int32Array(totalRings + 1);
  const coords = new Float64Array(totalCoords * 2);
  const ri = { value: 0 };
  const ci = { value: 0 };

  for (let i = 0; i < n; i++) {
    const wkb = wkbs[i];
    if (!wkb) continue;
    const h = readWkbHeader(wkb);
    if (!h || h.baseType !== 3) continue;
    if (wkb.byteLength < h.dataOffset + 4) continue;
    const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    const numRings = dv.getUint32(h.dataOffset, h.le);
    readPolygonRings(dv, h.le, h.coordStride, h.dataOffset + 4, numRings, coords, ci, ringOffsets, ri);
  }
  ringOffsets[totalRings] = ci.value >> 1;

  const fslData = makeCoordData(coords, ci.value >> 1);
  const ringListType = new List(new Field('vertices', coordType));
  const ringListData = makeData({
    type: ringListType,
    length: totalRings,
    nullCount: 0,
    valueOffsets: ringOffsets,
    child: fslData,
  });

  const polyType = new List(new Field('rings', ringListType));
  return makeData({
    type: polyType,
    length: n,
    nullCount: n - validCount,
    nullBitmap,
    valueOffsets: geomOffsets,
    child: ringListData,
  });
}

/**
 * Decode MultiPoint WKBs into List<FixedSizeList<Float64>[2]>
 */
function decodeMultiPoints(
  wkbs: (Uint8Array | null)[],
  nullBitmap: Uint8Array,
  validCount: number,
): Data {
  const n = wkbs.length;
  const geomOffsets = new Int32Array(n + 1);
  let totalCoords = 0;

  // Pass 1: count
  for (let i = 0; i < n; i++) {
    geomOffsets[i] = totalCoords;
    const wkb = wkbs[i];
    if (!wkb) continue;
    const h = readWkbHeader(wkb);
    if (!h || h.baseType !== 4) continue;
    if (wkb.byteLength < h.dataOffset + 4) continue;
    const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    totalCoords += dv.getUint32(h.dataOffset, h.le);
  }
  geomOffsets[n] = totalCoords;

  // Pass 2: extract from inner point WKBs
  const coords = new Float64Array(totalCoords * 2);
  let ci = 0;

  for (let i = 0; i < n; i++) {
    const wkb = wkbs[i];
    if (!wkb) continue;
    const h = readWkbHeader(wkb);
    if (!h || h.baseType !== 4) continue;
    if (wkb.byteLength < h.dataOffset + 4) continue;
    const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    const numPts = dv.getUint32(h.dataOffset, h.le);
    let off = h.dataOffset + 4;
    for (let j = 0; j < numPts; j++) {
      // Each inner point has its own WKB header
      const innerWkb = new Uint8Array(wkb.buffer, wkb.byteOffset + off, wkb.byteLength - off);
      const innerH = readWkbHeader(innerWkb);
      if (innerH && innerH.baseType === 1) {
        coords[ci++] = dv.getFloat64(off + innerH.dataOffset, innerH.le);
        coords[ci++] = dv.getFloat64(off + innerH.dataOffset + 8, innerH.le);
        off += innerH.dataOffset + innerH.coordStride;
      } else {
        coords[ci++] = NaN;
        coords[ci++] = NaN;
        off += 21; // Minimum Point WKB size (1+4+8+8)
      }
    }
  }

  const fslData = makeCoordData(coords, totalCoords);
  const listType = new List(new Field('vertices', coordType));
  return makeData({
    type: listType,
    length: n,
    nullCount: n - validCount,
    nullBitmap,
    valueOffsets: geomOffsets,
    child: fslData,
  });
}

/**
 * Decode MultiLineString WKBs into List<List<FixedSizeList<Float64>[2]>>
 */
function decodeMultiLineStrings(
  wkbs: (Uint8Array | null)[],
  nullBitmap: Uint8Array,
  validCount: number,
): Data {
  const n = wkbs.length;
  const geomOffsetsArr: number[] = [0];
  let totalLines = 0;
  let totalCoords = 0;

  // Pass 1: count
  for (let i = 0; i < n; i++) {
    const wkb = wkbs[i];
    if (!wkb) {
      geomOffsetsArr.push(totalLines);
      continue;
    }
    const h = readWkbHeader(wkb);
    if (!h || h.baseType !== 5) {
      geomOffsetsArr.push(totalLines);
      continue;
    }
    if (wkb.byteLength < h.dataOffset + 4) {
      geomOffsetsArr.push(totalLines);
      continue;
    }
    const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    const numLines = dv.getUint32(h.dataOffset, h.le);
    let off = h.dataOffset + 4;
    for (let l = 0; l < numLines; l++) {
      const innerWkb = new Uint8Array(wkb.buffer, wkb.byteOffset + off, wkb.byteLength - off);
      const innerH = readWkbHeader(innerWkb);
      if (!innerH) break;
      const innerDv = new DataView(wkb.buffer, wkb.byteOffset + off, wkb.byteLength - off);
      const numPts = innerDv.getUint32(innerH.dataOffset, innerH.le);
      totalCoords += numPts;
      off += innerH.dataOffset + 4 + numPts * innerH.coordStride;
      totalLines++;
    }
    geomOffsetsArr.push(totalLines);
  }

  // Pass 2: extract
  const geomOffsets = new Int32Array(geomOffsetsArr);
  const lineOffsets = new Int32Array(totalLines + 1);
  const coords = new Float64Array(totalCoords * 2);
  let li = 0;
  let ci = 0;

  for (let i = 0; i < n; i++) {
    const wkb = wkbs[i];
    if (!wkb) continue;
    const h = readWkbHeader(wkb);
    if (!h || h.baseType !== 5) continue;
    if (wkb.byteLength < h.dataOffset + 4) continue;
    const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    const numLines = dv.getUint32(h.dataOffset, h.le);
    let off = h.dataOffset + 4;
    for (let l = 0; l < numLines; l++) {
      lineOffsets[li++] = ci >> 1;
      const innerWkb = new Uint8Array(wkb.buffer, wkb.byteOffset + off, wkb.byteLength - off);
      const innerH = readWkbHeader(innerWkb);
      if (!innerH) break;
      const innerDv = new DataView(wkb.buffer, wkb.byteOffset + off, wkb.byteLength - off);
      const numPts = innerDv.getUint32(innerH.dataOffset, innerH.le);
      let ptOff = off + innerH.dataOffset + 4;
      for (let j = 0; j < numPts; j++) {
        coords[ci++] = dv.getFloat64(ptOff, innerH.le);
        coords[ci++] = dv.getFloat64(ptOff + 8, innerH.le);
        ptOff += innerH.coordStride;
      }
      off = ptOff;
    }
  }
  lineOffsets[totalLines] = ci >> 1;

  const fslData = makeCoordData(coords, ci >> 1);
  const lineListType = new List(new Field('vertices', coordType));
  const lineListData = makeData({
    type: lineListType,
    length: totalLines,
    nullCount: 0,
    valueOffsets: lineOffsets,
    child: fslData,
  });

  const multiLineType = new List(new Field('lines', lineListType));
  return makeData({
    type: multiLineType,
    length: n,
    nullCount: n - validCount,
    nullBitmap,
    valueOffsets: geomOffsets,
    child: lineListData,
  });
}

/**
 * Decode MultiPolygon WKBs into List<List<List<FixedSizeList<Float64>[2]>>>
 */
function decodeMultiPolygons(
  wkbs: (Uint8Array | null)[],
  nullBitmap: Uint8Array,
  validCount: number,
): Data {
  const n = wkbs.length;
  const geomOffsetsArr: number[] = [0];
  let totalPolys = 0;
  let totalRings = 0;
  let totalCoords = 0;

  // Pass 1: count polygons, rings, coordinates
  for (let i = 0; i < n; i++) {
    const wkb = wkbs[i];
    if (!wkb) {
      geomOffsetsArr.push(totalPolys);
      continue;
    }
    const h = readWkbHeader(wkb);
    if (!h || h.baseType !== 6) {
      geomOffsetsArr.push(totalPolys);
      continue;
    }
    if (wkb.byteLength < h.dataOffset + 4) {
      geomOffsetsArr.push(totalPolys);
      continue;
    }
    const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    const numPolys = dv.getUint32(h.dataOffset, h.le);
    let off = h.dataOffset + 4;
    for (let p = 0; p < numPolys; p++) {
      const innerWkb = new Uint8Array(wkb.buffer, wkb.byteOffset + off, wkb.byteLength - off);
      const innerH = readWkbHeader(innerWkb);
      if (!innerH) break;
      const innerDv = new DataView(wkb.buffer, wkb.byteOffset + off, wkb.byteLength - off);
      const numRings = innerDv.getUint32(innerH.dataOffset, innerH.le);
      let ringOff = innerH.dataOffset + 4;
      for (let r = 0; r < numRings; r++) {
        const numPts = innerDv.getUint32(ringOff, innerH.le);
        ringOff += 4 + numPts * innerH.coordStride;
        totalCoords += numPts;
        totalRings++;
      }
      off += ringOff;
      totalPolys++;
    }
    geomOffsetsArr.push(totalPolys);
  }

  // Pass 2: extract
  const geomOffsets = new Int32Array(geomOffsetsArr);
  const polyOffsets = new Int32Array(totalPolys + 1);
  const ringOffsets = new Int32Array(totalRings + 1);
  const coords = new Float64Array(totalCoords * 2);
  let pi = 0;
  let ri = 0;
  let ci = 0;

  for (let i = 0; i < n; i++) {
    const wkb = wkbs[i];
    if (!wkb) continue;
    const h = readWkbHeader(wkb);
    if (!h || h.baseType !== 6) continue;
    if (wkb.byteLength < h.dataOffset + 4) continue;
    const dv = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    const numPolys = dv.getUint32(h.dataOffset, h.le);
    let off = h.dataOffset + 4;
    for (let p = 0; p < numPolys; p++) {
      polyOffsets[pi++] = ri;
      const innerWkb = new Uint8Array(wkb.buffer, wkb.byteOffset + off, wkb.byteLength - off);
      const innerH = readWkbHeader(innerWkb);
      if (!innerH) break;
      const innerDv = new DataView(wkb.buffer, wkb.byteOffset + off, wkb.byteLength - off);
      const numRings = innerDv.getUint32(innerH.dataOffset, innerH.le);
      let ringOff = off + innerH.dataOffset + 4;
      for (let r = 0; r < numRings; r++) {
        ringOffsets[ri++] = ci >> 1;
        const numPts = dv.getUint32(ringOff, innerH.le);
        ringOff += 4;
        for (let j = 0; j < numPts; j++) {
          coords[ci++] = dv.getFloat64(ringOff, innerH.le);
          coords[ci++] = dv.getFloat64(ringOff + 8, innerH.le);
          ringOff += innerH.coordStride;
        }
      }
      off = ringOff;
    }
  }
  polyOffsets[totalPolys] = ri;
  ringOffsets[totalRings] = ci >> 1;

  const fslData = makeCoordData(coords, ci >> 1);
  const ringListType = new List(new Field('vertices', coordType));
  const ringListData = makeData({
    type: ringListType,
    length: totalRings,
    nullCount: 0,
    valueOffsets: ringOffsets,
    child: fslData,
  });

  const polyListType = new List(new Field('rings', ringListType));
  const polyListData = makeData({
    type: polyListType,
    length: totalPolys,
    nullCount: 0,
    valueOffsets: polyOffsets,
    child: ringListData,
  });

  const multiPolyType = new List(new Field('polygons', polyListType));
  return makeData({
    type: multiPolyType,
    length: n,
    nullCount: n - validCount,
    nullBitmap,
    valueOffsets: geomOffsets,
    child: polyListData,
  });
}

// ─── Geometry type promotion ─────────────────────────────────────────

/**
 * Given a set of geometry types found in a column, determine the
 * unified type (promoting simple → multi when mixed).
 */
function resolveUnifiedType(types: Set<WkbGeomType>): WkbGeomType {
  if (types.size === 1) return types.values().next().value!;

  // If we have both simple and multi of the same kind, promote to multi
  if (types.has('polygon') && types.has('multipolygon')) return 'multipolygon';
  if (types.has('linestring') && types.has('multilinestring')) return 'multilinestring';
  if (types.has('point') && types.has('multipoint')) return 'multipoint';

  // Fallback: use the first multi type, or the first type
  for (const t of types) {
    if (t.startsWith('multi')) return t;
  }
  return types.values().next().value!;
}

// ─── WKB wrapping for promotion ──────────────────────────────────────

/**
 * Wrap a simple geometry WKB as a multi-geometry WKB.
 * E.g., wraps a Polygon WKB as a MultiPolygon with 1 sub-geometry.
 */
function wrapAsMulti(wkb: Uint8Array, _fromType: WkbGeomType): Uint8Array {
  const h = readWkbHeader(wkb);
  if (!h) return wkb;

  // Multi type number = simple type number + 3
  const multiTypeNum = h.baseType + 3;

  // Build: [byte_order:1][multi_type:4][count:4=1][original WKB]
  const result = new Uint8Array(9 + wkb.length);
  const dv = new DataView(result.buffer);

  // Use little-endian for the wrapper
  result[0] = 1;
  dv.setUint32(1, multiTypeNum, true);
  dv.setUint32(5, 1, true); // count = 1
  result.set(wkb, 9);

  return result;
}

// ─── Null bitmap helper ──────────────────────────────────────────────

function buildNullBitmap(wkbs: (Uint8Array | null)[]): { bitmap: Uint8Array; validCount: number } {
  const n = wkbs.length;
  const bitmap = new Uint8Array(Math.ceil(n / 8));
  let validCount = 0;

  for (let i = 0; i < n; i++) {
    if (wkbs[i] !== null) {
      bitmap[i >> 3] |= 1 << (i & 7);
      validCount++;
    }
  }

  return { bitmap, validCount };
}

// ─── Extract WKB buffers from Arrow table ────────────────────────────

/**
 * Extract WKB Uint8Array blobs from an Arrow Binary/LargeBinary column.
 * Returns null entries for null rows (preserving validity).
 */
function extractWkbBuffers(table: Table, columnName: string): (Uint8Array | null)[] {
  const column = table.getChild(columnName);
  if (!column) {
    throw new Error(`Column "${columnName}" not found. Available: ${table.schema.fields.map(f => f.name).join(', ')}`);
  }

  const result: (Uint8Array | null)[] = [];
  const numRows = table.numRows;

  for (let i = 0; i < numRows; i++) {
    const val = column.get(i);
    if (val === null || val === undefined) {
      result.push(null);
    } else if (val instanceof Uint8Array) {
      result.push(val);
    } else {
      // Some Arrow implementations return ArrayBuffer or other views
      result.push(new Uint8Array(val));
    }
  }

  return result;
}

// ─── Build the result table ──────────────────────────────────────────

/**
 * Detect the dominant geometry type from a WKB column.
 * Inspects the first non-null WKBs to classify, then scans all for mixed types.
 */
function detectWkbGeometryType(wkbs: (Uint8Array | null)[]): WkbGeomType | null {
  const types = new Set<WkbGeomType>();

  for (const wkb of wkbs) {
    if (!wkb) continue;
    const t = classifyWkbType(wkb);
    if (t) types.add(t);
    // Once we've seen enough variety, stop scanning
    if (types.size > 2) break;
  }

  if (types.size === 0) return null;
  return resolveUnifiedType(types);
}

// ─── Public API ──────────────────────────────────────────────────────

export interface DecodeWkbOptions {
  /** Name of the WKB geometry column (default: "geometry") */
  geometryColumn?: string;
  /** Force a specific geometry type instead of auto-detecting */
  geometryType?: WkbGeomType;
}

export interface DecodeWkbResult {
  /** Arrow Table with native GeoArrow geometry column + non-geometry attribute columns */
  table: Table;
  /** Detected/resolved geometry type */
  geometryType: WkbGeomType;
}

/**
 * Convert an Arrow Table with a WKB-encoded geometry column to a native GeoArrow Table.
 *
 * The input table should have a Binary/LargeBinary column containing WKB blobs
 * (e.g., from DuckDB WASM's `ST_AsWKB(geom)` function).
 *
 * The output table replaces the WKB column with a native GeoArrow-encoded column
 * (interleaved FixedSizeList encoding) and preserves all other attribute columns.
 * The geometry column carries `ARROW:extension:name` metadata per the GeoArrow spec.
 *
 * @example
 * ```typescript
 * // DuckDB WASM query
 * const result = await conn.query(`
 *   SELECT name, population, ST_AsWKB(geom) as geometry FROM cities
 * `);
 * const arrowTable = result; // Arrow Table with Binary geometry column
 *
 * // Convert WKB → native GeoArrow
 * const { table, geometryType } = decodeWkbColumn(arrowTable);
 *
 * // Feed into geoarrow-deck-stream
 * const pathData = parseGeometry(table, { projection: geoMercator() });
 * ```
 */
export function decodeWkbColumn(
  inputTable: Table,
  options: DecodeWkbOptions = {},
): DecodeWkbResult {
  const { geometryColumn = 'geometry', geometryType: forcedType } = options;

  // Extract WKB buffers
  const wkbs = extractWkbBuffers(inputTable, geometryColumn);

  if (wkbs.length === 0) {
    throw new Error('Table has no rows');
  }

  // Detect or use forced geometry type
  const detectedType = forcedType ?? detectWkbGeometryType(wkbs);
  if (!detectedType) {
    throw new Error('Could not detect geometry type from WKB data');
  }

  // Handle mixed types via promotion (e.g., Polygon → MultiPolygon)
  const needsPromotion = !forcedType && detectedType.startsWith('multi');
  let processedWkbs = wkbs;

  if (needsPromotion) {
    // Find the simple counterpart
    const simpleType = detectedType.replace('multi', '') as WkbGeomType;
    processedWkbs = wkbs.map(wkb => {
      if (!wkb) return null;
      const t = classifyWkbType(wkb);
      if (t === simpleType) return wrapAsMulti(wkb, simpleType);
      return wkb;
    });
  }

  // Build null bitmap
  const { bitmap: nullBitmap, validCount } = buildNullBitmap(processedWkbs);

  // Decode geometry
  let geomData: Data;
  switch (detectedType) {
    case 'point':
      geomData = decodePoints(processedWkbs, nullBitmap, validCount);
      break;
    case 'linestring':
      geomData = decodeLineStrings(processedWkbs, nullBitmap, validCount);
      break;
    case 'polygon':
      geomData = decodePolygons(processedWkbs, nullBitmap, validCount);
      break;
    case 'multipoint':
      geomData = decodeMultiPoints(processedWkbs, nullBitmap, validCount);
      break;
    case 'multilinestring':
      geomData = decodeMultiLineStrings(processedWkbs, nullBitmap, validCount);
      break;
    case 'multipolygon':
      geomData = decodeMultiPolygons(processedWkbs, nullBitmap, validCount);
      break;
  }

  // Build the geometry field with GeoArrow extension metadata
  const extensionName = EXTENSION_NAMES[detectedType];
  const geomMetadata = new Map<string, string>([
    ['ARROW:extension:name', extensionName],
  ]);
  const geomField = new Field(geometryColumn, geomData!.type, true, geomMetadata);

  // Collect non-geometry columns from input table while preserving chunk layout.
  const fields: Field[] = [geomField];
  const nonGeometryColumns: Array<{ index: number }> = [];

  for (let index = 0; index < inputTable.schema.fields.length; index++) {
    const field = inputTable.schema.fields[index];
    if (field.name === geometryColumn) continue;
    fields.push(field);
    nonGeometryColumns.push({ index });
  }

  const schema = new Schema(fields, new Map(inputTable.schema.metadata));
  const structType = new Struct(fields);
  const geometryVector = new Vector([geomData!]);
  const batches: RecordBatch[] = [];
  let rowOffset = 0;

  for (const batch of inputTable.batches) {
    const batchRowCount = batch.numRows;
    const geometryChunk = geometryVector.slice(rowOffset, rowOffset + batchRowCount).data[0];
    const children: Data[] = [geometryChunk];

    for (const column of nonGeometryColumns) {
      children.push(batch.data.children[column.index]);
    }

    const structData = makeData({
      type: structType,
      length: batchRowCount,
      children,
    });
    batches.push(new RecordBatch(schema, structData));
    rowOffset += batchRowCount;
  }

  return {
    table: new Table(schema, batches),
    geometryType: detectedType,
  };
}

/**
 * Check if an Arrow Table contains a WKB-encoded geometry column.
 *
 * Detection criteria (any of):
 * 1. Column has ARROW:extension:name = "geoarrow.wkb"
 * 2. Column is Binary type without GeoArrow extension metadata
 *    (common for DuckDB WASM ST_AsWKB output)
 */
export function isWkbGeometryColumn(
  table: Table,
  columnName = 'geometry',
): boolean {
  const field = table.schema.fields.find(f => f.name === columnName);
  if (!field) return false;

  // Check for explicit geoarrow.wkb extension name (and legacy ogc.wkb)
  const extensionName = field.metadata?.get('ARROW:extension:name');
  if (extensionName === 'geoarrow.wkb' || extensionName === 'ogc.wkb') return true;

  // Check for Binary type (typeId 4 = Binary in Apache Arrow)
  // DuckDB WASM produces Binary columns from ST_AsWKB without GeoArrow metadata
  const typeId = field.type?.typeId;
  if (typeId === 4 /* Binary */ || typeId === 13 /* LargeBinary */) {
    // Verify it's not a native geoarrow type with binary storage
    if (!extensionName || !extensionName.startsWith('geoarrow.')) {
      return true;
    }
  }

  return false;
}
