/**
 * Tests for WKB Reader - WKB → GeoArrow conversion
 *
 * Tests cover:
 * - All 6 geometry types (Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon)
 * - Endianness (little-endian and big-endian)
 * - Empty geometries
 * - NULL handling (validity bitmap)
 * - Mixed type promotion (Polygon + MultiPolygon → MultiPolygon)
 * - EWKB with SRID
 * - 3D geometries (Z dimension projected to 2D)
 * - Integration with parseGeometry pipeline
 */

import { describe, it, expect } from 'vitest';
import {
  Table,
  Field,
  Schema,
  RecordBatch,
  makeData,
  Binary,
  Struct,
  vectorFromArray,
} from 'apache-arrow';
import { geoIdentity } from 'd3-geo';
import {
  decodeWkbColumn,
  isWkbGeometryColumn,
  parseGeometry,
  parsePoints,
  parsePolygonsToSolid,
  detectGeometryType,
} from '../index.js';

// =============================================================================
// WKB BUILDER HELPERS
// =============================================================================

/**
 * Build a WKB Point (type=1) from x,y coordinates.
 * Uses little-endian byte order.
 */
function wkbPoint(x: number, y: number, le = true): Uint8Array {
  const buf = new ArrayBuffer(21); // 1 + 4 + 8 + 8
  const dv = new DataView(buf);
  const arr = new Uint8Array(buf);
  arr[0] = le ? 1 : 0;
  dv.setUint32(1, 1, le); // type = Point
  dv.setFloat64(5, x, le);
  dv.setFloat64(13, y, le);
  return arr;
}

/**
 * Build a WKB Point with Z (type=1001 ISO or 0x80000001 EWKB).
 */
function wkbPointZ(x: number, y: number, z: number, useISO = true): Uint8Array {
  const buf = new ArrayBuffer(29); // 1 + 4 + 8 + 8 + 8
  const dv = new DataView(buf);
  const arr = new Uint8Array(buf);
  arr[0] = 1; // LE
  dv.setUint32(1, useISO ? 1001 : (0x80000000 | 1), true);
  dv.setFloat64(5, x, true);
  dv.setFloat64(13, y, true);
  dv.setFloat64(21, z, true);
  return arr;
}

/**
 * Build a WKB Point with EWKB SRID flag.
 */
function wkbPointWithSRID(x: number, y: number, srid: number): Uint8Array {
  const buf = new ArrayBuffer(25); // 1 + 4 + 4(srid) + 8 + 8
  const dv = new DataView(buf);
  const arr = new Uint8Array(buf);
  arr[0] = 1; // LE
  dv.setUint32(1, 0x20000000 | 1, true); // type=Point + SRID flag
  dv.setUint32(5, srid, true);
  dv.setFloat64(9, x, true);
  dv.setFloat64(17, y, true);
  return arr;
}

/**
 * Build a WKB LineString from an array of [x, y] pairs.
 */
function wkbLineString(coords: [number, number][], le = true): Uint8Array {
  const n = coords.length;
  const buf = new ArrayBuffer(9 + n * 16); // 1 + 4 + 4 + n*(8+8)
  const dv = new DataView(buf);
  const arr = new Uint8Array(buf);
  arr[0] = le ? 1 : 0;
  dv.setUint32(1, 2, le); // type = LineString
  dv.setUint32(5, n, le);
  let off = 9;
  for (const [x, y] of coords) {
    dv.setFloat64(off, x, le);
    dv.setFloat64(off + 8, y, le);
    off += 16;
  }
  return arr;
}

/**
 * Build a WKB Polygon from an array of rings, each being [x,y] pairs.
 */
function wkbPolygon(rings: [number, number][][], le = true): Uint8Array {
  const numRings = rings.length;
  let totalPts = 0;
  for (const ring of rings) totalPts += ring.length;
  const size = 9 + numRings * 4 + totalPts * 16;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const arr = new Uint8Array(buf);
  arr[0] = le ? 1 : 0;
  dv.setUint32(1, 3, le); // type = Polygon
  dv.setUint32(5, numRings, le);
  let off = 9;
  for (const ring of rings) {
    dv.setUint32(off, ring.length, le);
    off += 4;
    for (const [x, y] of ring) {
      dv.setFloat64(off, x, le);
      dv.setFloat64(off + 8, y, le);
      off += 16;
    }
  }
  return arr;
}

/**
 * Build a WKB MultiPoint from inner Point WKBs.
 */
function wkbMultiPoint(points: [number, number][], le = true): Uint8Array {
  const innerWkbs = points.map(([x, y]) => wkbPoint(x, y, le));
  const innerSize = innerWkbs.reduce((sum, w) => sum + w.length, 0);
  const buf = new ArrayBuffer(9 + innerSize);
  const dv = new DataView(buf);
  const arr = new Uint8Array(buf);
  arr[0] = le ? 1 : 0;
  dv.setUint32(1, 4, le); // type = MultiPoint
  dv.setUint32(5, points.length, le);
  let off = 9;
  for (const inner of innerWkbs) {
    arr.set(inner, off);
    off += inner.length;
  }
  return arr;
}

/**
 * Build a WKB MultiLineString from inner LineString coord arrays.
 */
function wkbMultiLineString(lines: [number, number][][], le = true): Uint8Array {
  const innerWkbs = lines.map(coords => wkbLineString(coords, le));
  const innerSize = innerWkbs.reduce((sum, w) => sum + w.length, 0);
  const buf = new ArrayBuffer(9 + innerSize);
  const dv = new DataView(buf);
  const arr = new Uint8Array(buf);
  arr[0] = le ? 1 : 0;
  dv.setUint32(1, 5, le); // type = MultiLineString
  dv.setUint32(5, lines.length, le);
  let off = 9;
  for (const inner of innerWkbs) {
    arr.set(inner, off);
    off += inner.length;
  }
  return arr;
}

/**
 * Build a WKB MultiPolygon from inner Polygon ring arrays.
 */
function wkbMultiPolygon(polygons: [number, number][][][], le = true): Uint8Array {
  const innerWkbs = polygons.map(rings => wkbPolygon(rings, le));
  const innerSize = innerWkbs.reduce((sum, w) => sum + w.length, 0);
  const buf = new ArrayBuffer(9 + innerSize);
  const dv = new DataView(buf);
  const arr = new Uint8Array(buf);
  arr[0] = le ? 1 : 0;
  dv.setUint32(1, 6, le); // type = MultiPolygon
  dv.setUint32(5, polygons.length, le);
  let off = 9;
  for (const inner of innerWkbs) {
    arr.set(inner, off);
    off += inner.length;
  }
  return arr;
}

// =============================================================================
// ARROW TABLE BUILDER 
// =============================================================================

/**
 * Build an Arrow Table with a Binary geometry column from WKB buffers.
 * Handles null entries. Adds optional attribute columns.
 */
function buildWkbTable(
  wkbs: (Uint8Array | null)[],
  columnName = 'geometry',
  attributes: Record<string, readonly unknown[]> = {},
): Table {
  const n = wkbs.length;

  // Build Binary column offsets and value buffer
  const offsets = new Int32Array(n + 1);
  let totalBytes = 0;
  for (let i = 0; i < n; i++) {
    offsets[i] = totalBytes;
    if (wkbs[i]) totalBytes += wkbs[i]!.length;
  }
  offsets[n] = totalBytes;

  const valueBuffer = new Uint8Array(totalBytes);
  let pos = 0;
  const nullBitmap = new Uint8Array(Math.ceil(n / 8));
  let nullCount = 0;
  for (let i = 0; i < n; i++) {
    const wkb = wkbs[i];
    if (wkb) {
      nullBitmap[i >> 3] |= 1 << (i & 7);
      valueBuffer.set(wkb, pos);
      pos += wkb.length;
    } else {
      nullCount++;
    }
  }

  const binaryData = makeData({
    type: new Binary(),
    length: n,
    nullCount,
    nullBitmap,
    valueOffsets: offsets,
    data: valueBuffer,
  });

  const geomField = new Field(columnName, new Binary(), true);
  const fields: Field[] = [geomField];
  const columns: any[] = [binaryData];

  for (const [name, values] of Object.entries(attributes)) {
    const vector = vectorFromArray(values);
    fields.push(new Field(name, vector.type, vector.nullable));
    columns.push(vector.data[0]);
  }

  const schema = new Schema(fields);
  const structType = new Struct(fields);
  const structData = makeData({
    type: structType,
    length: n,
    children: columns,
  });
  const batch = new RecordBatch(schema, structData);
  return new Table(schema, batch);
}

function splitTableIntoTwoBatches(table: Table): Table {
  const midpoint = Math.ceil(table.numRows / 2);
  return table.slice(0, midpoint).concat(table.slice(midpoint));
}


// =============================================================================
// TESTS
// =============================================================================

describe('WKB Reader - decodeWkbColumn', () => {

  describe('isWkbGeometryColumn', () => {
    it('should detect Binary column as WKB', () => {
      const table = buildWkbTable([wkbPoint(1, 2)]);
      expect(isWkbGeometryColumn(table)).toBe(true);
    });

    it('should return false for non-existent column', () => {
      const table = buildWkbTable([wkbPoint(1, 2)], 'geom');
      expect(isWkbGeometryColumn(table, 'other')).toBe(false);
    });
  });

  describe('detectGeometryType', () => {
    it('should return wkb for Binary geometry column', () => {
      const table = buildWkbTable([wkbPoint(1, 2)]);
      expect(detectGeometryType(table)).toBe('wkb');
    });
  });

  describe('Point', () => {
    it('should decode Point WKBs', () => {
      const wkbs = [wkbPoint(1.5, 2.5), wkbPoint(3.0, 4.0)];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      expect(result.geometryType).toBe('point');
      const geomCol = result.table.getChild('geometry')!;
      expect(geomCol.length).toBe(2);

      // Check coordinates
      const d = geomCol.data[0];
      const values = d.children[0].values as Float64Array;
      expect(values[0]).toBeCloseTo(1.5);
      expect(values[1]).toBeCloseTo(2.5);
      expect(values[2]).toBeCloseTo(3.0);
      expect(values[3]).toBeCloseTo(4.0);
    });

    it('should handle big-endian Points', () => {
      const wkbs = [wkbPoint(10, 20, false)];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      const values = result.table.getChild('geometry')!.data[0].children[0].values as Float64Array;
      expect(values[0]).toBeCloseTo(10);
      expect(values[1]).toBeCloseTo(20);
    });

    it('should handle 3D Points (Z projected to 2D)', () => {
      const wkbs = [wkbPointZ(5, 10, 100)];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      const values = result.table.getChild('geometry')!.data[0].children[0].values as Float64Array;
      expect(values[0]).toBeCloseTo(5);
      expect(values[1]).toBeCloseTo(10);
    });

    it('should handle EWKB Points with SRID', () => {
      const wkbs = [wkbPointWithSRID(2.35, 48.85, 4326)];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      const values = result.table.getChild('geometry')!.data[0].children[0].values as Float64Array;
      expect(values[0]).toBeCloseTo(2.35);
      expect(values[1]).toBeCloseTo(48.85);
    });

    it('should handle NULL entries with validity bitmap', () => {
      const wkbs: (Uint8Array | null)[] = [wkbPoint(1, 2), null, wkbPoint(3, 4)];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      expect(result.geometryType).toBe('point');
      const geomCol = result.table.getChild('geometry')!;
      expect(geomCol.length).toBe(3);

      // The null row should have NaN coordinates
      const d = geomCol.data[0];
      expect(d.nullCount).toBe(1);
      const values = d.children[0].values as Float64Array;
      expect(values[0]).toBeCloseTo(1);
      expect(values[1]).toBeCloseTo(2);
      expect(Number.isNaN(values[2])).toBe(true);
      expect(Number.isNaN(values[3])).toBe(true);
      expect(values[4]).toBeCloseTo(3);
      expect(values[5]).toBeCloseTo(4);
    });
  });

  describe('LineString', () => {
    it('should decode LineString WKBs', () => {
      const wkbs = [
        wkbLineString([[0, 0], [1, 1], [2, 0]]),
        wkbLineString([[10, 10], [20, 20]]),
      ];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      expect(result.geometryType).toBe('linestring');
      const geomCol = result.table.getChild('geometry')!;
      expect(geomCol.length).toBe(2);
    });

    it('should handle empty LineStrings (0 points)', () => {
      const wkbs = [
        wkbLineString([]),
        wkbLineString([[1, 2], [3, 4]]),
      ];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);
      expect(result.geometryType).toBe('linestring');
    });
  });

  describe('Polygon', () => {
    it('should decode Polygon WKBs', () => {
      const exterior: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
      const wkbs = [wkbPolygon([exterior])];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      expect(result.geometryType).toBe('polygon');
      const geomCol = result.table.getChild('geometry')!;
      expect(geomCol.length).toBe(1);
    });

    it('should decode Polygon with holes', () => {
      const exterior: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
      const hole: [number, number][] = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]];
      const wkbs = [wkbPolygon([exterior, hole])];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      expect(result.geometryType).toBe('polygon');
    });

    it('should handle empty Polygons (0 rings)', () => {
      const wkbs = [
        wkbPolygon([]),
        wkbPolygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]),
      ];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);
      expect(result.geometryType).toBe('polygon');
    });
  });

  describe('MultiPoint', () => {
    it('should decode MultiPoint WKBs', () => {
      const wkbs = [wkbMultiPoint([[1, 2], [3, 4], [5, 6]])];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      expect(result.geometryType).toBe('multipoint');
    });
  });

  describe('MultiLineString', () => {
    it('should decode MultiLineString WKBs', () => {
      const wkbs = [
        wkbMultiLineString([
          [[0, 0], [1, 1]],
          [[2, 2], [3, 3], [4, 4]],
        ]),
      ];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      expect(result.geometryType).toBe('multilinestring');
    });
  });

  describe('MultiPolygon', () => {
    it('should decode MultiPolygon WKBs', () => {
      const poly1: [number, number][][] = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
      const poly2: [number, number][][] = [[[5, 5], [6, 5], [6, 6], [5, 5]]];
      const wkbs = [wkbMultiPolygon([poly1, poly2])];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      expect(result.geometryType).toBe('multipolygon');
    });
  });

  describe('Mixed type promotion', () => {
    it('should promote Polygon to MultiPolygon when mixed', () => {
      const simplePolygon = wkbPolygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]);
      const multiPolygon = wkbMultiPolygon([[[[5, 5], [6, 5], [6, 6], [5, 5]]]]);
      const wkbs = [simplePolygon, multiPolygon];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      expect(result.geometryType).toBe('multipolygon');
      expect(result.table.getChild('geometry')!.length).toBe(2);
    });
  });

  describe('GeoArrow metadata', () => {
    it('should set ARROW:extension:name on geometry field', () => {
      const wkbs = [wkbLineString([[0, 0], [1, 1]])];
      const table = buildWkbTable(wkbs);
      const result = decodeWkbColumn(table);

      const geomField = result.table.schema.fields.find(f => f.name === 'geometry');
      expect(geomField).toBeDefined();
      const extName = geomField!.metadata?.get('ARROW:extension:name');
      expect(extName).toBe('geoarrow.linestring');
    });
  });

  describe('Custom column name', () => {
    it('should work with non-default geometry column name', () => {
      const wkbs = [wkbPoint(1, 2)];
      const table = buildWkbTable(wkbs, 'geom');
      const result = decodeWkbColumn(table, { geometryColumn: 'geom' });

      expect(result.geometryType).toBe('point');
    });
  });
});

// =============================================================================
// INTEGRATION TESTS: WKB → parseGeometry pipeline
// =============================================================================

describe('WKB Integration - parseGeometry pipeline', () => {
  it('should parse LineString WKBs through full pipeline', () => {
    const wkbs = [
      wkbLineString([[0, 0], [10, 0], [10, 10]]),
      wkbLineString([[20, 20], [30, 30]]),
    ];
    const table = buildWkbTable(wkbs);
    const identity = geoIdentity().reflectY(false) as any;

    const result = parseGeometry(table, { projection: identity });

    expect(result.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
    expect(result.startIndices.length).toBeGreaterThan(0);
    expect(result.featureIds.length).toBeGreaterThan(0);
  });

  it('should parse Polygon WKBs through full pipeline', () => {
    const exterior: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const wkbs = [wkbPolygon([exterior])];
    const table = buildWkbTable(wkbs);
    const identity = geoIdentity().reflectY(false) as any;

    const result = parseGeometry(table, { projection: identity });

    expect(result.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
  });

  it('should parse MultiLineString WKBs through full pipeline', () => {
    const wkbs = [
      wkbMultiLineString([
        [[0, 0], [5, 5], [10, 0]],
        [[20, 0], [25, 5]],
      ]),
    ];
    const table = buildWkbTable(wkbs);
    const identity = geoIdentity().reflectY(false) as any;

    const result = parseGeometry(table, { projection: identity });

    expect(result.length).toBe(2); // 2 sub-linestrings
    expect(result.featureIds[0]).toBe(0);
    expect(result.featureIds[1]).toBe(0); // Both map to feature 0
  });

  it('should parse Point WKBs through parsePoints', () => {
    const wkbs = [wkbPoint(2.35, 48.85), wkbPoint(4.83, 45.76)];
    const table = buildWkbTable(wkbs);
    const identity = geoIdentity().reflectY(false) as any;

    const result = parsePoints(table, { projection: identity });

    expect(result.length).toBe(2);
    expect(result.positions[0]).toBeCloseTo(2.35);
    expect(result.positions[1]).toBeCloseTo(48.85);
    expect(result.positions[2]).toBeCloseTo(4.83);
    expect(result.positions[3]).toBeCloseTo(45.76);
  });

  it('should preserve rows and attributes when decoding multi-batch WKB tables', () => {
    const inputTable = splitTableIntoTwoBatches(
      buildWkbTable(
        [wkbPoint(1, 2), wkbPoint(3, 4), wkbPoint(5, 6)],
        'geometry',
        { label: ['a', 'b', 'c'] }
      )
    );

    const { table } = decodeWkbColumn(inputTable);
    const labelColumn = table.getChild('label');

    expect(inputTable.batches.length).toBeGreaterThan(1);
    expect(table.numRows).toBe(3);
    expect(table.batches.length).toBe(2);
    expect(labelColumn?.get(0)).toBe('a');
    expect(labelColumn?.get(1)).toBe('b');
    expect(labelColumn?.get(2)).toBe('c');
  });

  it('should parse multi-batch WKB points without dropping features', () => {
    const table = splitTableIntoTwoBatches(
      buildWkbTable([wkbPoint(2.35, 48.85), wkbPoint(4.83, 45.76)])
    );
    const identity = geoIdentity().reflectY(false) as any;

    const result = parsePoints(table, { projection: identity });

    expect(table.batches.length).toBeGreaterThan(1);
    expect(result.length).toBe(2);
    expect(Array.from(result.featureIds)).toEqual([0, 1]);
    expect(result.positions[0]).toBeCloseTo(2.35);
    expect(result.positions[1]).toBeCloseTo(48.85);
    expect(result.positions[2]).toBeCloseTo(4.83);
    expect(result.positions[3]).toBeCloseTo(45.76);
  });

  it('should parse Polygon WKBs through parsePolygonsToSolid', () => {
    const exterior: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const wkbs = [wkbPolygon([exterior])];
    const table = buildWkbTable(wkbs);
    const identity = geoIdentity().reflectY(false) as any;

    const result = parsePolygonsToSolid(table, { projection: identity });

    expect(result.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
    expect(result.polygonIndices.length).toBeGreaterThan(0);
  });

  it('should handle NULL WKBs in pipeline without crashing', () => {
    const wkbs: (Uint8Array | null)[] = [
      wkbLineString([[0, 0], [1, 1]]),
      null,
      wkbLineString([[5, 5], [6, 6]]),
    ];
    const table = buildWkbTable(wkbs);
    const identity = geoIdentity().reflectY(false) as any;

    const result = parseGeometry(table, { projection: identity });

    // Should have at least 2 paths (from the 2 non-null linestrings)
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});
