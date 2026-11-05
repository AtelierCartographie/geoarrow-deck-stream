/**
 * WKB Stream - stream WKB geometries straight into a d3 GeoStream
 *
 * The parse entry points used to convert a WKB column to native GeoArrow
 * first (`decodeWkbColumn`): a Float64Array holding every coordinate (16
 * bytes per vertex) plus offsets, allocated only to be read once by the
 * streaming loop. This module walks the WKB bytes of each Arrow Binary chunk
 * in place with a DataView and calls `stream.point()` directly: no
 * intermediate coordinate buffer, no per-row Uint8Array.
 *
 * Semantics mirror `decodeWkbColumn` followed by the native streaming loops,
 * so outputs are identical: same type detection and simple → multi promotion,
 * null / unreadable / other-type rows treated as empty geometries, Z/M
 * skipped, one feature id per row.
 */

import type { Data, Table } from 'apache-arrow';
import type { GeoStream } from 'd3-geo';

import {
  readWkbHeaderAt,
  resolveUnifiedType,
  wkbBaseTypeName,
  type WkbGeomType,
  type WkbHeader,
} from './wkb-reader.js';

/** One Arrow Binary / LargeBinary chunk, read in place. */
interface WkbChunk {
  readonly data: Data;
  readonly dv: DataView;
  readonly offsets: Int32Array | BigInt64Array;
  readonly length: number;
}

/** A WKB geometry column ready to be streamed. */
export interface WkbColumn {
  readonly chunks: readonly WkbChunk[];
  /** Absolute row index of each chunk's first row (feature ids). */
  readonly rowOffsets: readonly number[];
  readonly numRows: number;
  /** Unified geometry type (simple types promoted to multi when mixed). */
  readonly geomType: WkbGeomType;
}

/** Location of one row's WKB inside its chunk, with its parsed header. */
interface WkbRow {
  base: number;
  length: number;
  header: WkbHeader;
}

/** Sink side channel: the driver tags every row with its feature id. */
interface FeatureSink {
  setFeatureId(id: number): void;
}

/**
 * Open the WKB geometry column of a table for direct streaming.
 *
 * Throws like `decodeWkbColumn` on an empty table or when no row holds a
 * recognizable WKB geometry.
 */
export function openWkbColumn(table: Table, columnName = 'geometry'): WkbColumn {
  const column = table.getChild(columnName);
  if (!column) {
    throw new Error(
      `Column "${columnName}" not found. Available: ${table.schema.fields.map((f) => f.name).join(', ')}`,
    );
  }
  if (table.numRows === 0) {
    throw new Error('Table has no rows');
  }

  const chunks: WkbChunk[] = [];
  const rowOffsets: number[] = [];
  let numRows = 0;
  for (const data of column.data as Data[]) {
    const values = (data.values as Uint8Array | undefined) ?? new Uint8Array(0);
    chunks.push({
      data,
      dv: new DataView(values.buffer, values.byteOffset, values.byteLength),
      offsets: data.valueOffsets as unknown as Int32Array | BigInt64Array,
      length: data.length,
    });
    rowOffsets.push(numRows);
    numRows += data.length;
  }

  const geomType = detectType(chunks);
  if (!geomType) {
    throw new Error('Could not detect geometry type from WKB data');
  }
  return { chunks, rowOffsets, numRows, geomType };
}

/** Read row `index` of a chunk: null for null rows and unreadable headers. */
function readRow(chunk: WkbChunk, index: number, row: WkbRow): WkbRow | null {
  if (!chunk.data.getValid(index)) return null;
  const start = Number(chunk.offsets[index]);
  const length = Number(chunk.offsets[index + 1]) - start;
  const header = readWkbHeaderAt(chunk.dv, start, length);
  if (!header) return null;
  row.base = start;
  row.length = length;
  row.header = header;
  return row;
}

/**
 * Same scan as `decodeWkbColumn`: collect types until a third one shows up,
 * then unify.
 */
function detectType(chunks: readonly WkbChunk[]): WkbGeomType | null {
  const types = new Set<WkbGeomType>();
  const row = {} as WkbRow;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const name = wkbBaseTypeName(readRow(chunk, i, row)?.header.baseType);
      if (name) types.add(name);
      if (types.size > 2) return resolveUnifiedType(types);
    }
  }
  return types.size === 0 ? null : resolveUnifiedType(types);
}

/** WKB base type number of each geometry type, and of its simple counterpart. */
const BASE_TYPE: Record<WkbGeomType, number> = {
  point: 1,
  linestring: 2,
  polygon: 3,
  multipoint: 4,
  multilinestring: 5,
  multipolygon: 6,
};

// =============================================================================
// COUNTING (buffer preallocation)
// =============================================================================

/** Byte offset just past a `numPts` + coordinates sequence starting at `off`. */
function skipLine(dv: DataView, off: number, h: WkbHeader): [number, number] {
  const numPts = dv.getUint32(off, h.le);
  return [off + 4 + numPts * h.coordStride, numPts];
}

/** Byte offset past a polygon body (`numRings` + rings) at `off`, and its coordinate count. */
function skipPolygon(dv: DataView, off: number, h: WkbHeader): [number, number] {
  const numRings = dv.getUint32(off, h.le);
  let pos = off + 4;
  let count = 0;
  for (let r = 0; r < numRings; r++) {
    const [next, numPts] = skipLine(dv, pos, h);
    pos = next;
    count += numPts;
  }
  return [pos, count];
}

/**
 * Number of coordinates the column holds for its unified type — the count
 * `countCoordinates` returns on the `decodeWkbColumn` output, used to size
 * the output buffers.
 */
export function countWkbCoordinates(column: WkbColumn): number {
  if (column.geomType === 'point') return column.numRows;
  // Parts are read by the column type, whatever their own header says.
  const polygonal =
    column.geomType === 'polygon' || column.geomType === 'multipolygon';
  let total = 0;
  forEachRowGeometry(column, {
    single(dv, off, h) {
      if (polygonal) total += skipPolygon(dv, off, h)[1];
      else if (h.baseType === 1) total += 1; // promoted Point in a MultiPoint column
      else total += skipLine(dv, off, h)[1];
    },
  });
  return total;
}

// =============================================================================
// ROW WALKER
// =============================================================================

interface RowVisitor {
  /** Called before each row (null rows included). */
  row?(featureId: number, hasGeometry: boolean): void;
  /**
   * One geometry body at `off`, read with header `h`: a line body (`numPts`
   * + coordinates), a polygon body (`numRings` + rings), a whole MultiPoint
   * body (`numPts` + point WKBs) or, for a promoted Point, its coordinate.
   * MultiLineString / MultiPolygon rows call it once per part. `rowEnd` is
   * the byte offset where the row's WKB ends.
   */
  single(dv: DataView, off: number, h: WkbHeader, rowEnd: number): void;
}

/**
 * Walk every row and hand each geometry body of the unified type to the
 * visitor, following `decodeWkbColumn`'s rules: rows of the multi type are
 * split into parts (each with its own header; an unreadable part header ends
 * the row), rows of the simple counterpart count as a one-part multi, and
 * any other row is empty.
 */
function forEachRowGeometry(column: WkbColumn, visitor: RowVisitor): void {
  const multiBase = BASE_TYPE[column.geomType];
  const isMulti = column.geomType.startsWith('multi');
  const simpleBase = isMulti ? multiBase - 3 : -1;
  // MultiPoint members are read by the point visitor itself (with its own
  // fallback for unreadable members), like decodeWkbColumn does.
  const splitParts = isMulti && column.geomType !== 'multipoint';
  const row = {} as WkbRow;

  for (let c = 0; c < column.chunks.length; c++) {
    const chunk = column.chunks[c];
    const { dv } = chunk;
    const rowOffset = column.rowOffsets[c];

    for (let i = 0; i < chunk.length; i++) {
      const r = readRow(chunk, i, row);
      const h = r?.header;
      const matches =
        r !== null &&
        ((h!.baseType === multiBase && r.length >= h!.dataOffset + 4) ||
          h!.baseType === simpleBase);
      visitor.row?.(rowOffset + i, matches);
      if (!matches) continue;

      const { base, length, header } = r!;
      const rowEnd = base + length;
      // A promoted simple geometry is one part, read with its own header.
      if (header.baseType === simpleBase || !splitParts) {
        visitor.single(dv, base + header.dataOffset, header, rowEnd);
        continue;
      }
      const numParts = dv.getUint32(base + header.dataOffset, header.le);
      let off = base + header.dataOffset + 4;
      for (let p = 0; p < numParts; p++) {
        const part = readWkbHeaderAt(dv, off, length - (off - base));
        if (!part) break;
        const body = off + part.dataOffset;
        visitor.single(dv, body, part, rowEnd);
        off =
          column.geomType === 'multipolygon'
            ? skipPolygon(dv, body, part)[0]
            : skipLine(dv, body, part)[0];
      }
    }
  }
}

// =============================================================================
// STREAMING
// =============================================================================

/** Stream one line / ring (`numPts` + coordinates at `off`) if long enough. */
function streamLine(
  dv: DataView,
  off: number,
  h: WkbHeader,
  minPoints: number,
  stream: GeoStream,
): number {
  const numPts = dv.getUint32(off, h.le);
  let pos = off + 4;
  if (numPts < minPoints) return pos + numPts * h.coordStride;
  const { le, coordStride } = h;
  stream.lineStart();
  for (let j = 0; j < numPts; j++, pos += coordStride) {
    stream.point(dv.getFloat64(pos, le), dv.getFloat64(pos + 8, le));
  }
  stream.lineEnd();
  return pos;
}

/**
 * Stream a WKB column as paths (PathLayer semantics of `parseGeometry`):
 * every line and every polygon ring with at least 2 points becomes a line,
 * without polygon events. Point columns stream nothing.
 */
export function streamWkbPaths(
  column: WkbColumn,
  stream: GeoStream,
  sink: FeatureSink,
): void {
  const { geomType } = column;
  if (geomType === 'point' || geomType === 'multipoint') return;
  const polygonal = geomType === 'polygon' || geomType === 'multipolygon';

  forEachRowGeometry(column, {
    row(featureId) {
      sink.setFeatureId(featureId);
    },
    single(dv, off, h) {
      if (!polygonal) {
        streamLine(dv, off, h, 2, stream);
        return;
      }
      const numRings = dv.getUint32(off, h.le);
      let pos = off + 4;
      for (let r = 0; r < numRings; r++) pos = streamLine(dv, pos, h, 2, stream);
    },
  });
}

/**
 * Stream a Polygon / MultiPolygon WKB column as filled polygons
 * (`parsePolygonsToSolid` semantics): polygonStart/polygonEnd around each
 * polygon — around each row for Polygon columns, empty rows included — and
 * rings with at least 3 points.
 */
export function streamWkbSolidPolygons(
  column: WkbColumn,
  stream: GeoStream,
  sink: FeatureSink,
): void {
  const perRowPolygon = column.geomType === 'polygon';

  forEachRowGeometry(column, {
    row(featureId, hasGeometry) {
      sink.setFeatureId(featureId);
      if (perRowPolygon && !hasGeometry) {
        stream.polygonStart();
        stream.polygonEnd();
      }
    },
    single(dv, off, h) {
      const numRings = dv.getUint32(off, h.le);
      let pos = off + 4;
      stream.polygonStart();
      for (let r = 0; r < numRings; r++) pos = streamLine(dv, pos, h, 3, stream);
      stream.polygonEnd();
    },
  });
}

/**
 * Visit every point of a Point / MultiPoint WKB column (`parsePoints`
 * semantics). Like the decoded path, null or unreadable Point rows and
 * unreadable MultiPoint members yield (NaN, NaN), which the caller filters.
 */
export function forEachWkbPoint(
  column: WkbColumn,
  visit: (x: number, y: number, featureId: number) => void,
): void {
  if (column.geomType === 'point') {
    const row = {} as WkbRow;
    for (let c = 0; c < column.chunks.length; c++) {
      const chunk = column.chunks[c];
      const rowOffset = column.rowOffsets[c];
      for (let i = 0; i < chunk.length; i++) {
        const r = readRow(chunk, i, row);
        if (!r || r.header.baseType !== 1 || r.length < r.header.dataOffset + 16) {
          visit(NaN, NaN, rowOffset + i);
          continue;
        }
        const off = r.base + r.header.dataOffset;
        visit(
          chunk.dv.getFloat64(off, r.header.le),
          chunk.dv.getFloat64(off + 8, r.header.le),
          rowOffset + i,
        );
      }
    }
    return;
  }
  if (column.geomType !== 'multipoint') return;

  let featureId = 0;
  forEachRowGeometry(column, {
    row(id) {
      featureId = id;
    },
    single(dv, off, h, rowEnd) {
      if (h.baseType === 1) {
        // Promoted Point row: the body is the coordinate itself.
        visit(dv.getFloat64(off, h.le), dv.getFloat64(off + 8, h.le), featureId);
        return;
      }
      const numPts = dv.getUint32(off, h.le);
      let pos = off + 4;
      for (let j = 0; j < numPts; j++) {
        const inner = readWkbHeaderAt(dv, pos, rowEnd - pos);
        if (inner && inner.baseType === 1) {
          visit(
            dv.getFloat64(pos + inner.dataOffset, inner.le),
            dv.getFloat64(pos + inner.dataOffset + 8, inner.le),
            featureId,
          );
          pos += inner.dataOffset + inner.coordStride;
        } else {
          visit(NaN, NaN, featureId);
          pos += 21; // Minimum Point WKB size (1+4+8+8)
        }
      }
    },
  });
}
