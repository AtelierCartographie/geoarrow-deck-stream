/**
 * GeoArrow Reader - Low-level Arrow buffer access using @geoarrow/geoarrow-js
 * 
 * This module bridges the official geoarrow-js types with our d3-geo streaming pipeline.
 * We use geoarrow-js for type detection and child extraction, then access the raw
 * Arrow Data buffers directly for zero-copy coordinate streaming.
 * 
 * Supports:
 * - Point
 * - MultiPoint
 * - LineString
 * - Polygon  
 * - MultiLineString
 * - MultiPolygon
 */

import type { Vector, Data, Float, Table } from 'apache-arrow';
import { Type } from 'apache-arrow';
import { data, child } from '@geoarrow/geoarrow-js';

// Re-export type guards and helpers from geoarrow-js via our types
import type {
  LineStringData,
  PolygonData,
  MultiLineStringData,
  MultiPolygonData,
  MultiPointData,
  LineStringVector,
  PolygonVector,
  MultiLineStringVector,
  MultiPolygonVector,
  GeoArrowData,
  PointData,
} from './types.js';

/**
 * Geometry type enumeration matching GeoArrow spec
 */
export const GeometryType = {
  POINT: 0,
  LINESTRING: 1,
  POLYGON: 2,
  MULTIPOINT: 3,
  MULTILINESTRING: 4,
  MULTIPOLYGON: 5,
} as const;

export type GeometryTypeValue = typeof GeometryType[keyof typeof GeometryType];

/**
 * Supported geometry input types for the parser
 */
export type SupportedGeometryData = 
  | PointData
  | MultiPointData
  | LineStringData 
  | PolygonData 
  | MultiLineStringData 
  | MultiPolygonData;

export type SupportedGeometryVector = 
  | LineStringVector 
  | PolygonVector 
  | MultiLineStringVector 
  | MultiPolygonVector;

/**
 * Result of coordinate extraction - ready for streaming
 */
export interface ExtractedCoordinates {
  /** Flat coordinate values [x,y,x,y,...] (if interleaved) */
  readonly flatCoords: Float64Array | Float32Array;
  /** Separated coordinate arrays (if separated) */
  readonly separatedCoords?: {
    readonly x: Float64Array | Float32Array;
    readonly y: Float64Array | Float32Array;
  };
  /** Coordinate dimension (2 for XY, 3 for XYZ, 4 for XYZM) */
  readonly dim: number;
  /** Number of coordinate points */
  readonly coordCount: number;
}

/**
 * Detect the geometry type from GeoArrow extension metadata
 * 
 * Reads the ARROW:extension:name metadata from the Table schema.
 * This is the most reliable method per the GeoArrow specification.
 * 
 * @param table - Arrow Table containing GeoArrow geometry column
 * @param geometryColumnName - Column name (default: "geometry")
 * @returns Geometry type or 'unknown' if metadata is missing
 * 
 * @example
 * ```typescript
 * const table = tableFromIPC(buffer);
 * const type = detectGeometryType(table); // "multilinestring"
 * ```
 */
export function detectGeometryType(
  table: Table,
  geometryColumnName = 'geometry'
): 'point' | 'multipoint' | 'linestring' | 'polygon' | 'multilinestring' | 'multipolygon' | 'wkb' | 'unknown' {
  const geomField = table.schema.fields.find(f => f.name === geometryColumnName);
  if (!geomField?.metadata) {
    // Fallback: check if the column is Binary type (e.g., DuckDB WASM ST_AsWKB output)
    const typeId = geomField?.type?.typeId;
    if (typeId === 4 /* Binary */ || typeId === 13 /* LargeBinary */) {
      return 'wkb';
    }
    return 'unknown';
  }

  const extensionName = geomField.metadata.get('ARROW:extension:name');
  if (!extensionName) {
    // Fallback: check if the column is Binary type
    const typeId = geomField.type?.typeId;
    if (typeId === 4 /* Binary */ || typeId === 13 /* LargeBinary */) {
      return 'wkb';
    }
    return 'unknown';
  }

  switch (extensionName) {
    case 'geoarrow.point': return 'point';
    case 'geoarrow.multipoint': return 'multipoint';
    case 'geoarrow.linestring': return 'linestring';
    case 'geoarrow.polygon': return 'polygon';
    case 'geoarrow.multilinestring': return 'multilinestring';
    case 'geoarrow.multipolygon': return 'multipolygon';
    case 'geoarrow.wkb': return 'wkb';
    case 'ogc.wkb': return 'wkb'; // Legacy name before GeoArrow spec standardization
    default: return 'unknown';
  }
}

/**
 * Get the first Data chunk from a Vector (for streaming)
 * 
 * Most GeoArrow sources produce a single chunk. For multi-chunk vectors,
 * callers should iterate over vector.data.
 */
export function getFirstDataChunk<T extends GeoArrowData>(
  input: Vector | Data
): T {
  if ('data' in input) {
    // It's a Vector - get first chunk
    if (input.data.length === 0) {
      throw new Error('Vector has no data chunks');
    }
    return input.data[0] as T;
  }
  // It's already a Data instance
  return input as T;
}

/**
 * Extract flat coordinates from a Point Data (FixedSizeList<Float>)
 * 
 * This is the lowest level - coordinates are stored directly in the values buffer.
 */
export function extractPointCoordinates(pointData: PointData): ExtractedCoordinates {
  // Handle Separated encoding (Struct<x, y>)
  // Cast to Data because TypeScript expects PointData to be FixedSizeList
  if ((pointData as Data).typeId === Type.Struct) {
    const xChild = pointData.children[0];
    const yChild = pointData.children[1];
    
    return {
      flatCoords: new Float64Array(0), // Dummy empty buffer
      separatedCoords: {
        x: xChild.values as Float64Array | Float32Array,
        y: yChild.values as Float64Array | Float32Array
      },
      dim: 2,
      coordCount: pointData.length
    };
  }

  // Handle Interleaved encoding (FixedSizeList<Float>)
  // Get the inner Float array child
  const floatChild = child.getPointChild(pointData) as Data<Float>;
  
  // Access raw values - this is zero-copy!
  const flatCoords = floatChild.values as Float64Array | Float32Array;
  
  // Dimension is the FixedSizeList size (2, 3, or 4)
  // @ts-ignore - listSize exists on FixedSizeList
  const dim = pointData.type.listSize ?? 2;
  
  return {
    flatCoords,
    dim,
    coordCount: pointData.length,
  };
}

/**
 * Extract coordinates and offsets from a MultiPoint Data
 * 
 * MultiPoint = List<Point>
 */
export function extractMultiPointCoordinates(dataInput: MultiPointData): {
  coords: ExtractedCoordinates;
  geomOffsets: Int32Array;
} {
  // MultiPoint = List<Point> (same structure as LineString)
  const geomOffsets = dataInput.valueOffsets;
  
  // Get the nested Point data
  const pointData = child.getMultiPointChild(dataInput);
  const coords = extractPointCoordinates(pointData);
  
  return { coords, geomOffsets };
}

/**
 * Extract coordinates and offsets from a LineString Data
 */
export function extractLineStringCoordinates(dataInput: LineStringData): {
  coords: ExtractedCoordinates;
  geomOffsets: Int32Array;
} {
  // LineString = List<Point>
  // valueOffsets defines where each linestring starts/ends in the points
  const geomOffsets = dataInput.valueOffsets;
  
  // Get the nested Point data
  const pointData = child.getLineStringChild(dataInput);
  const coords = extractPointCoordinates(pointData);
  
  return { coords, geomOffsets };
}

/**
 * Extract coordinates and offsets from a Polygon Data
 */
export function extractPolygonCoordinates(dataInput: PolygonData): {
  coords: ExtractedCoordinates;
  geomOffsets: Int32Array;
  ringOffsets: Int32Array;
} {
  // Polygon = List<List<Point>>
  // First level valueOffsets = polygon boundaries
  const geomOffsets = dataInput.valueOffsets;
  
  // Get the rings (List<Point>)
  const ringsData = child.getPolygonChild(dataInput);
  const ringOffsets = ringsData.valueOffsets;
  
  // Get the coordinates (Point)
  const pointData = child.getLineStringChild(ringsData);
  const coords = extractPointCoordinates(pointData);
  
  return { coords, geomOffsets, ringOffsets };
}

/**
 * Extract coordinates and offsets from a MultiLineString Data
 */
export function extractMultiLineStringCoordinates(dataInput: MultiLineStringData): {
  coords: ExtractedCoordinates;
  geomOffsets: Int32Array;
  partOffsets: Int32Array;
} {
  // MultiLineString = List<List<Point>>
  // First level = multilinestring boundaries
  const geomOffsets = dataInput.valueOffsets;
  
  // Get the linestrings
  const linestringsData = child.getMultiLineStringChild(dataInput);
  const partOffsets = linestringsData.valueOffsets;
  
  // Get the coordinates
  const pointData = child.getLineStringChild(linestringsData);
  const coords = extractPointCoordinates(pointData);
  
  return { coords, geomOffsets, partOffsets };
}

/**
 * Extract coordinates and offsets from a MultiPolygon Data
 */
export function extractMultiPolygonCoordinates(dataInput: MultiPolygonData): {
  coords: ExtractedCoordinates;
  geomOffsets: Int32Array;
  polygonOffsets: Int32Array;
  ringOffsets: Int32Array;
} {
  // MultiPolygon = List<List<List<Point>>>
  // First level = multipolygon boundaries
  const geomOffsets = dataInput.valueOffsets;
  
  // Get the polygons
  const polygonsData = child.getMultiPolygonChild(dataInput);
  const polygonOffsets = polygonsData.valueOffsets;
  
  // Get the rings
  const ringsData = child.getPolygonChild(polygonsData);
  const ringOffsets = ringsData.valueOffsets;
  
  // Get the coordinates
  const pointData = child.getLineStringChild(ringsData);
  const coords = extractPointCoordinates(pointData);
  
  return { coords, geomOffsets, polygonOffsets, ringOffsets };
}

// =============================================================================
// TYPE GUARDS FOR INPUT VALIDATION
// =============================================================================

// =============================================================================
// COORDINATE COUNT UTILITIES
// =============================================================================

/**
 * Count total coordinates in the geometry data
 */
export function countCoordinates(input: SupportedGeometryData): number {
  if (data.isPointData(input)) {
    const coords = extractPointCoordinates(input);
    return coords.coordCount;
  }
  if (data.isMultiPointData(input)) {
    const { coords } = extractMultiPointCoordinates(input);
    return coords.coordCount;
  }
  if (data.isLineStringData(input)) {
    const { coords } = extractLineStringCoordinates(input);
    return coords.coordCount;
  }
  if (data.isPolygonData(input)) {
    const { coords } = extractPolygonCoordinates(input);
    return coords.coordCount;
  }
  if (data.isMultiLineStringData(input)) {
    const { coords } = extractMultiLineStringCoordinates(input);
    return coords.coordCount;
  }
  if (data.isMultiPolygonData(input)) {
    const { coords } = extractMultiPolygonCoordinates(input);
    return coords.coordCount;
  }
  throw new Error('Unsupported geometry type');
}