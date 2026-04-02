/**
 * Tests for GeoArrow Deck Stream
 * 
 * Uses real Arrow files created with GDAL from GeoJSON test data.
 * Tests cover both INTERLEAVED and SEPARATED coordinate encodings.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { geoIdentity, geoOrthographic, geoMercator } from 'd3-geo';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { tableFromIPC, Table, Vector } from 'apache-arrow';

import {
  parseGeometry,
  parseGeometryWithStats,
  parsePolygonsToSolid,
  createBinarySink,
  createPathLayerProps,
  createSolidPolygonLayerProps,
  calculateBounds,
  toGeoJSON,
  GrowableBuffer,
  detectGeometryType,
} from '../index.js';

// =============================================================================
// TEST DATA LOADING HELPERS
// =============================================================================

const PRIMITIVES_DIR = resolve(__dirname, '../../examples/test-data/primitives');

function loadArrowTable(filename: string): Table {
  const buffer = readFileSync(resolve(PRIMITIVES_DIR, filename));
  return tableFromIPC(buffer);
}

function getGeometryVector(table: Table): Vector {
  // GeoArrow tables typically have a 'geometry' or 'wkb_geometry' column
  const geomCol = table.getChild('geometry') ?? table.getChild('wkb_geometry');
  if (!geomCol) {
    throw new Error(`No geometry column found in table. Columns: ${table.schema.fields.map(f => f.name).join(', ')}`);
  }
  return geomCol;
}

function splitTableIntoTwoBatches(table: Table): Table {
  const midpoint = Math.ceil(table.numRows / 2);
  return table.slice(0, midpoint).concat(table.slice(midpoint));
}

// =============================================================================
// UNIT TESTS: GrowableBuffer
// =============================================================================

describe('GrowableBuffer', () => {
  it('should grow automatically when capacity exceeded', () => {
    const buffer = new GrowableBuffer(Float32Array, 4);
    
    expect(buffer.capacity).toBe(4);
    
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);
    buffer.push(5); // Should trigger growth
    
    expect(buffer.length).toBe(5);
    expect(buffer.capacity).toBeGreaterThan(4);
    expect(buffer.get(4)).toBe(5);
  });

  it('should push2 correctly for coordinate pairs', () => {
    const buffer = new GrowableBuffer(Float32Array, 10);
    
    buffer.push2(1.5, 2.5);
    buffer.push2(3.5, 4.5);
    
    expect(buffer.length).toBe(4);
    expect(buffer.get(0)).toBe(1.5);
    expect(buffer.get(1)).toBe(2.5);
    expect(buffer.get(2)).toBe(3.5);
    expect(buffer.get(3)).toBe(4.5);
  });

  it('should return trimmed array', () => {
    const buffer = new GrowableBuffer(Float32Array, 100);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    
    const result = buffer.toArray();
    expect(result.length).toBe(3);
    expect(result).toEqual(new Float32Array([1, 2, 3]));
  });
});

// =============================================================================
// UNIT TESTS: BinarySink
// =============================================================================

describe('BinarySink', () => {
  it('should collect points from stream', () => {
    const sink = createBinarySink();
    
    sink.setFeatureId(0);
    sink.lineStart();
    sink.point(10, 20);
    sink.point(30, 40);
    sink.lineEnd();
    
    const result = sink.finalize();
    
    expect(result.length).toBe(1);
    expect(result.positions).toEqual(new Float32Array([10, 20, 30, 40]));
    expect(result.featureIds[0]).toBe(0);
  });

  it('should handle multiple features', () => {
    const sink = createBinarySink();
    
    // Feature 0
    sink.setFeatureId(0);
    sink.lineStart();
    sink.point(0, 0);
    sink.point(1, 1);
    sink.lineEnd();
    
    // Feature 1
    sink.setFeatureId(1);
    sink.lineStart();
    sink.point(2, 2);
    sink.point(3, 3);
    sink.lineEnd();
    
    const result = sink.finalize();
    
    expect(result.length).toBe(2);
    expect(result.featureIds[0]).toBe(0);
    expect(result.featureIds[1]).toBe(1);
  });

  it('should filter degenerate paths (< 2 points)', () => {
    const sink = createBinarySink();
    
    sink.setFeatureId(0);
    sink.lineStart();
    sink.point(10, 20);
    // Only 1 point - should be filtered
    sink.lineEnd();
    
    const result = sink.finalize();
    
    expect(result.length).toBe(0);
  });

  it('should skip invalid coordinates', () => {
    const sink = createBinarySink();
    
    sink.setFeatureId(0);
    sink.lineStart();
    sink.point(10, 20);
    sink.point(NaN, 30); // Invalid
    sink.point(40, Infinity); // Invalid
    sink.point(50, 60);
    sink.lineEnd();
    
    const result = sink.finalize();
    
    expect(result.length).toBe(1);
    // Only valid points should be included
    expect(result.positions).toEqual(new Float32Array([10, 20, 50, 60]));
  });
});

// =============================================================================
// INTEGRATION TESTS: LineString Parsing
// =============================================================================

describe('parseGeometry - LineString', () => {
  let interleavedTable: Table;
  let separatedTable: Table;

  beforeAll(() => {
    interleavedTable = loadArrowTable('linestrings.interleaved.arrow');
    separatedTable = loadArrowTable('linestrings.separated.arrow');
  });

  it('should detect LineString geometry type from Table metadata', () => {
    expect(detectGeometryType(interleavedTable)).toBe('linestring');
    expect(detectGeometryType(separatedTable)).toBe('linestring');
  });

  it('should parse interleaved encoding with identity projection', () => {
    const result = parseGeometry(interleavedTable, {
      projection: geoIdentity()
    });
    
    expect(result.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
    expect(result.startIndices.length).toBe(result.length + 1);
    expect(result.featureIds.length).toBe(result.length);
  });

  it('should parse separated encoding with identity projection', () => {
    const result = parseGeometry(separatedTable, {
      projection: geoIdentity()
    });
    
    expect(result.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
    expect(result.startIndices.length).toBe(result.length + 1);
  });

  it('should parse both encodings successfully', () => {
    const interleavedResult = parseGeometry(interleavedTable, {
      projection: geoIdentity()
    });
    const separatedResult = parseGeometry(separatedTable, {
      projection: geoIdentity()
    });
    
    // Both encodings should parse successfully
    expect(interleavedResult.length).toBeGreaterThan(0);
    expect(separatedResult.length).toBeGreaterThan(0);
    expect(interleavedResult.positions.length).toBeGreaterThan(0);
    expect(separatedResult.positions.length).toBeGreaterThan(0);
  });

  it('should parse with Mercator projection', () => {
    const result = parseGeometry(interleavedTable, {
      projection: geoMercator()
    });
    
    expect(result.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
  });

  it('should parse multi-batch tables without dropping features', () => {
    const multiBatchTable = splitTableIntoTwoBatches(interleavedTable);
    const singleBatchResult = parseGeometry(interleavedTable, {
      projection: geoIdentity()
    });
    const multiBatchResult = parseGeometry(multiBatchTable, {
      projection: geoIdentity()
    });

    expect(multiBatchTable.batches.length).toBeGreaterThan(1);
    expect(multiBatchResult.length).toBe(singleBatchResult.length);
    expect(Array.from(multiBatchResult.featureIds)).toEqual(
      Array.from(singleBatchResult.featureIds)
    );
    expect(Array.from(multiBatchResult.startIndices)).toEqual(
      Array.from(singleBatchResult.startIndices)
    );
    expect(Array.from(multiBatchResult.positions)).toEqual(
      Array.from(singleBatchResult.positions)
    );
  });

  it('should return stats when requested', () => {
    const { data, stats } = parseGeometryWithStats(interleavedTable, {
      projection: geoIdentity()
    });
    
    expect(data.length).toBeGreaterThan(0);
    expect(stats.inputFeatures).toBeGreaterThan(0);
    expect(stats.outputPaths).toBeGreaterThan(0);
    expect(stats.inputCoordinates).toBeGreaterThan(0);
    expect(stats.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// INTEGRATION TESTS: MultiLineString Parsing
// =============================================================================

describe('parseGeometry - MultiLineString', () => {
  let table: Table;

  beforeAll(() => {
    table = loadArrowTable('multilinestrings.interleaved.arrow');
  });

  it('should detect MultiLineString from Table metadata', () => {
    // Uses ARROW:extension:name = "geoarrow.multilinestring"
    expect(detectGeometryType(table)).toBe('multilinestring');
  });

  it('should parse MultiLineString and expand to paths', () => {
    const result = parseGeometry(table, {
      projection: geoIdentity()
    });
    
    // MultiLineStrings should produce more paths than input features
    // (each LineString within a MultiLineString becomes a separate path)
    expect(result.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
    
    // Feature IDs map output paths back to input features
    expect(result.featureIds.length).toBe(result.length);
  });
});

// =============================================================================
// INTEGRATION TESTS: Polygon Parsing
// =============================================================================

describe('parseGeometry - Polygon', () => {
  let simplePolygonTable: Table;
  let polygonWithHolesTable: Table;

  beforeAll(() => {
    simplePolygonTable = loadArrowTable('polygons.interleaved.arrow');
    polygonWithHolesTable = loadArrowTable('polygons-with-holes.interleaved.arrow');
  });

  it('should detect Polygon geometry type', () => {
    expect(detectGeometryType(simplePolygonTable)).toBe('polygon');
    expect(detectGeometryType(polygonWithHolesTable)).toBe('polygon');
  });

  it('should parse simple polygons as paths (rings)', () => {
    const result = parseGeometry(simplePolygonTable, {
      projection: geoIdentity()
    });
    
    expect(result.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
  });

  it('should parse polygons with holes (each ring as separate path)', () => {
    const result = parseGeometry(polygonWithHolesTable, {
      projection: geoIdentity()
    });
    
    // Polygons with holes should produce more paths than features
    // (exterior ring + hole rings become separate paths)
    expect(result.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// INTEGRATION TESTS: MultiPolygon Parsing
// =============================================================================

describe('parseGeometry - MultiPolygon', () => {
  let multiPolygonTable: Table;

  beforeAll(() => {
    multiPolygonTable = loadArrowTable('multipolygons.interleaved.arrow');
  });

  it('should detect MultiPolygon geometry type', () => {
    expect(detectGeometryType(multiPolygonTable)).toBe('multipolygon');
  });

  it('should parse MultiPolygons (all rings as paths)', () => {
    const result = parseGeometry(multiPolygonTable, {
      projection: geoIdentity()
    });
    
    expect(result.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
    expect(result.featureIds.length).toBe(result.length);
  });
});

// =============================================================================
// INTEGRATION TESTS: Deck.gl Integration
// =============================================================================

describe('Deck.gl integration', () => {
  let lineStringTable: Table;
  let polygonTable: Table;
  let polygonWithHolesTable: Table;

  beforeAll(() => {
    lineStringTable = loadArrowTable('linestrings.interleaved.arrow');
    polygonTable = loadArrowTable('polygons.interleaved.arrow');
    polygonWithHolesTable = loadArrowTable('polygons-with-holes.interleaved.arrow');
  });

  it('should create PathLayer props', () => {
    const binaryData = parseGeometry(lineStringTable, {
      projection: geoIdentity()
    });
    
    const props = createPathLayerProps(binaryData);
    
    expect(props.data.length).toBe(binaryData.length);
    expect(props.data.startIndices).toBeDefined();
    expect(props.data.attributes.getPath.value).toBe(binaryData.positions);
    expect(props.data.attributes.getPath.size).toBe(2);
    expect(props._pathType).toBe('open');
  });

  it('should create SolidPolygonLayer props with correct indices', () => {
    const polygonData = parsePolygonsToSolid(polygonTable, {
      projection: geoIdentity()
    });
    
    const props = createSolidPolygonLayerProps(polygonData);
    
    // Basic structure checks
    expect(props.data.length).toBe(3); // 3 polygons
    expect(props._normalize).toBe(false);
    expect(props.data.startIndices).toBeDefined();
    expect(props.data.attributes.getPolygon.size).toBe(2);
    expect(props.data.attributes.indices).toBeDefined();
    expect(props.data.attributes.vertexValid).toBeUndefined(); // Should be gone
    
    const indices = props.data.attributes.indices;
    expect(indices!.length).toBeGreaterThan(0);
    // Indices should be divisible by 3 (triangles)
    expect(indices!.length % 3).toBe(0);
    
    // Check indices range
    const maxIndex = props.data.attributes.getPolygon.value.length / 2;
    for (const idx of indices!) {
        expect(idx).toBeLessThan(maxIndex);
        expect(idx).toBeGreaterThanOrEqual(0);
    }
  });

  it('should create SolidPolygonLayer props with holes (triangulated)', () => {
    const polygonData = parsePolygonsToSolid(polygonWithHolesTable, {
      projection: geoIdentity()
    });
    
    const props = createSolidPolygonLayerProps(polygonData);
    
    // Original data should have 3 polygons.
    // Holes are correctly identified and processed by earcut triangulation,
    // so we get 3 features in the output, not split rings.
    expect(props.data.length).toBe(3);
    
    expect(props.data.attributes.indices).toBeDefined();
    const indices = props.data.attributes.indices;
    
    expect(indices!.length).toBeGreaterThan(0);
    expect(indices!.length % 3).toBe(0);
  });

  it('should build identical solid polygon output for multi-batch tables', () => {
    const multiBatchTable = splitTableIntoTwoBatches(polygonTable);
    const singleBatchData = parsePolygonsToSolid(polygonTable, {
      projection: geoIdentity()
    });
    const multiBatchData = parsePolygonsToSolid(multiBatchTable, {
      projection: geoIdentity()
    });

    expect(multiBatchTable.batches.length).toBeGreaterThan(1);
    expect(multiBatchData.length).toBe(singleBatchData.length);
    expect(Array.from(multiBatchData.featureIds)).toEqual(
      Array.from(singleBatchData.featureIds)
    );
    expect(Array.from(multiBatchData.polygonIndices)).toEqual(
      Array.from(singleBatchData.polygonIndices)
    );
    expect(Array.from(multiBatchData.holeIndices)).toEqual(
      Array.from(singleBatchData.holeIndices)
    );
    expect(Array.from(multiBatchData.positions)).toEqual(
      Array.from(singleBatchData.positions)
    );
  });

  it('should calculate bounds correctly', () => {
    const binaryData = parseGeometry(lineStringTable, {
      projection: geoIdentity()
    });
    
    const bounds = calculateBounds(binaryData);
    
    expect(bounds.minX).toBeDefined();
    expect(bounds.minY).toBeDefined();
    expect(bounds.maxX).toBeDefined();
    expect(bounds.maxY).toBeDefined();
    expect(bounds.maxX).toBeGreaterThanOrEqual(bounds.minX);
    expect(bounds.maxY).toBeGreaterThanOrEqual(bounds.minY);
  });
});

// =============================================================================
// INTEGRATION TESTS: Debug Utilities
// =============================================================================

describe('Debug utilities', () => {
  let lineStringTable: Table;

  beforeAll(() => {
    lineStringTable = loadArrowTable('linestrings.interleaved.arrow');
  });

  it('should convert to GeoJSON for debugging', () => {
    const binaryData = parseGeometry(lineStringTable, {
      projection: geoIdentity()
    });
    
    const geojson = toGeoJSON(binaryData);
    
    expect(geojson.type).toBe('FeatureCollection');
    expect(geojson.features.length).toBe(binaryData.length);
    
    for (const feature of geojson.features) {
      expect(feature.geometry.type).toBe('LineString');
      expect(feature.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
      expect(feature.properties.featureId).toBeDefined();
    }
  });
});

// =============================================================================
// PROJECTION TESTS
// =============================================================================

describe('Projections', () => {
  let lineStringTable: Table;

  beforeAll(() => {
    lineStringTable = loadArrowTable('linestrings.interleaved.arrow');
  });

  it('should handle orthographic projection with clipping', () => {
    const result = parseGeometry(lineStringTable, {
      projection: geoOrthographic().rotate([0, 0])
    });
    
    // Orthographic clips to visible hemisphere
    // Some features may be clipped entirely, some may be split
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle Mercator projection', () => {
    const result = parseGeometry(lineStringTable, {
      projection: geoMercator()
    });
    
    expect(result.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
  });
});
