/**
 * GeoArrow Deck Stream - Type Definitions
 *
 * Zero-serialization binary types for high-performance geospatial rendering.
 * Uses official @geoarrow/geoarrow-js types for GeoArrow geometry structures.
 */

import type { GeoStream, GeoProjection } from "d3-geo";
import { data, vector, type, child } from "@geoarrow/geoarrow-js";

// Re-export GeoArrow types from the official library namespaces
// Data types (single chunk access)
export type PointData = data.PointData;
export type LineStringData = data.LineStringData;
export type PolygonData = data.PolygonData;
export type MultiPointData = data.MultiPointData;
export type MultiLineStringData = data.MultiLineStringData;
export type MultiPolygonData = data.MultiPolygonData;
export type GeoArrowData = data.GeoArrowData;

// Vector types (multi-chunk collections)
export type PointVector = vector.PointVector;
export type LineStringVector = vector.LineStringVector;
export type PolygonVector = vector.PolygonVector;
export type MultiPointVector = vector.MultiPointVector;
export type MultiLineStringVector = vector.MultiLineStringVector;
export type MultiPolygonVector = vector.MultiPolygonVector;
export type GeoArrowVector = vector.GeoArrowVector;

// Geometry types (Arrow DataType definitions)
export type Point = type.Point;
export type LineString = type.LineString;
export type Polygon = type.Polygon;
export type MultiPoint = type.MultiPoint;
export type MultiLineString = type.MultiLineString;
export type MultiPolygon = type.MultiPolygon;
export type GeoArrowType = type.GeoArrowType;

// Re-export type guards for Data
export const isPointData = data.isPointData;
export const isLineStringData = data.isLineStringData;
export const isPolygonData = data.isPolygonData;
export const isMultiPointData = data.isMultiPointData;
export const isMultiLineStringData = data.isMultiLineStringData;
export const isMultiPolygonData = data.isMultiPolygonData;

// Re-export type guards for Vector
export const isPointVector = vector.isPointVector;
export const isLineStringVector = vector.isLineStringVector;
export const isPolygonVector = vector.isPolygonVector;
export const isMultiPointVector = vector.isMultiPointVector;
export const isMultiLineStringVector = vector.isMultiLineStringVector;
export const isMultiPolygonVector = vector.isMultiPolygonVector;

// Re-export type guards for DataType
export const isPoint = type.isPoint;
export const isLineString = type.isLineString;
export const isPolygon = type.isPolygon;
export const isMultiPoint = type.isMultiPoint;
export const isMultiLineString = type.isMultiLineString;
export const isMultiPolygon = type.isMultiPolygon;

// Re-export child accessors
export const getPointChild = child.getPointChild;
export const getLineStringChild = child.getLineStringChild;
export const getPolygonChild = child.getPolygonChild;
export const getMultiPointChild = child.getMultiPointChild;
export const getMultiLineStringChild = child.getMultiLineStringChild;
export const getMultiPolygonChild = child.getMultiPolygonChild;

// =============================================================================
// CORE OUTPUT TYPES
// =============================================================================

/**
 * Binary output format consumable directly by Deck.gl layers.
 * This is the unified output regardless of projection type.
 */
export interface BinaryPathData {
  /** Total number of paths (may exceed input feature count due to clipping) */
  readonly length: number;

  /** Flat array of projected X,Y coordinates [x0,y0,x1,y1,...] */
  readonly positions: Float32Array;

  /** Start index of each path in the positions array (divided by 2) */
  readonly startIndices: Uint32Array;

  /**
   * Maps each output path back to the original Arrow row index.
   * Critical for attribute lookups when features are split by projection.
   */
  readonly featureIds: Uint32Array;

  /** Number of coordinates per vertex (always 2 for X,Y) */
  readonly size: 2;
}

/**
 * Extended output with polygon-specific data for SolidPolygonLayer
 */
export interface BinaryPolygonData {
  /** Total number of polygons */
  readonly length: number;

  /** Flat array of projected X,Y coordinates [x0,y0,x1,y1,...] */
  readonly positions: Float32Array;

  /** Start index of each polygon in the positions array (divided by 2) */
  readonly polygonIndices: Uint32Array;

  /** Start index of each ring (for handling holes) within all polygons */
  readonly holeIndices: Uint32Array;

  /** Triangular indices for rendering without tessellation */
  readonly indices?: Uint32Array;

  /** Maps each output polygon back to the original Arrow row index */
  readonly featureIds: Uint32Array;

  /** Number of coordinates per vertex (always 2 for X,Y) */
  readonly size: 2;
}

/**
 * Output for Point/MultiPoint → ScatterplotLayer
 */
export interface BinaryPointData {
  /** Total number of points */
  readonly length: number;

  /** Flat array of projected X,Y coordinates [x0,y0,x1,y1,...] */
  readonly positions: Float32Array;

  /** Maps each output point back to the original Arrow row index */
  readonly featureIds: Uint32Array;

  /** Number of coordinates per point (always 2 for X,Y) */
  readonly size: 2;
}

// =============================================================================
// CONFIGURATION TYPES
// =============================================================================

/**
 * Duck-typed projection interface.
 *
 * Any object that implements `.stream()` can be used as a projection.
 * This allows using composite projections (like geoAlbersUsa or custom composites)
 * which are not GeoProjection instances but implement the same streaming interface.
 *
 * @example
 * ```typescript
 * // Standard d3 projection
 * const proj1: ProjectionLike = geoOrthographic();
 *
 * // Composite projection (implements stream() but not full GeoProjection)
 * const proj2: ProjectionLike = buildCompositeProjection({ ... });
 *
 * // d3's AlbersUSA
 * const proj3: ProjectionLike = geoAlbersUsa();
 * ```
 */
export interface ProjectionLike {
  /** Stream method for d3-geo streaming API */
  stream(sink: GeoStream): GeoStream;
  /** Optional callable interface for projecting single points */
  (coordinates: [number, number]): [number, number] | null;
}

/**
 * Parser configuration options
 */
export interface ParserOptions {
  /**
   * D3 projection to use. Pass null or geoIdentity() for pass-through mode.
   * The projection should be fully configured (center, rotate, scale, etc.)
   *
   * Accepts:
   * - Standard d3 projections (geoOrthographic, geoMercator, etc.)
   * - Composite projections (geoAlbersUsa, buildCompositeProjection, etc.)
   * - Any object with a `.stream()` method
   */
  projection: GeoProjection | ProjectionLike;

  /**
   * Initial buffer capacity multiplier.
   * For reprojections with clipping, use 2.0+. For identity, use 1.0.
   * @default 1.5
   */
  capacityMultiplier?: number;

  /**
   * Correct spherical ring winding (Right-Hand Rule) before projection.
   * Necessary for polygons covering large areas or crossing antimeridian.
   * @default true
   */
  rewind?: boolean;

  /** Enable sink debug capture (counts, samples). */
  debug?: boolean;

  /** Limit of sampled coordinates stored in debug info. */
  debugSampleLimit?: number;

  /**
   * Enable console logging for debugging.
   * Disable for maximum performance in production.
   * @default false
   */
  enableLogging?: boolean;
}

/** Debug information captured by the streaming sink. */
export interface SinkDebugInfo {
  pointsReceived: number;
  pointsStored: number;
  invalidPoints: number;
  degeneratePaths: number;
  linesEmitted: number;
  sample: number[];
}

/**
 * Memory allocation strategy configuration
 */
export interface AllocationConfig {
  /** Initial capacity for positions array (number of floats) */
  initialPositionCapacity: number;

  /** Initial capacity for paths/features */
  initialPathCapacity: number;

  /** Growth factor when buffers need expansion */
  growthFactor: number;
}

// =============================================================================
// CUSTOM SINK INTERFACE
// =============================================================================

/**
 * Internal state for the streaming sink.
 * Tracks buffer positions and current feature context.
 */
export interface SinkState {
  /** Current write position in positions array */
  positionIndex: number;

  /** Current path count */
  pathCount: number;

  /** Current feature ID being processed */
  currentFeatureId: number;

  /** Whether we're inside a line/ring */
  inLine: boolean;

  /** Start position of current line (for tracking) */
  lineStartPosition: number;

  /** Point count in current line */
  pointsInLine: number;
}

/**
 * Mutable buffer container for the sink
 */
export interface SinkBuffers {
  positions: Float32Array;
  startIndices: Uint32Array;
  featureIds: Uint32Array;
}

/**
 * Custom D3 GeoStream sink that writes to TypedArrays
 */
export interface BinarySink extends GeoStream {
  /** Get the current state (for debugging/testing) */
  getState(): Readonly<SinkState>;

  /** Get the raw buffers (may have unused capacity) */
  getBuffers(): SinkBuffers;

  /** Finalize and return trimmed output */
  finalize(): BinaryPathData;

  /** Reset sink for reuse with new data */
  reset(): void;

  /** Set the current feature ID (called by driver between features) */
  setFeatureId(id: number): void;

  /** Debug snapshot. */
  getDebugInfo(): SinkDebugInfo;
}

/**
 * Polygon-specific sink for BinaryPolygonData output
 */
export interface BinaryPolygonSink extends GeoStream {
  /** Finalize and return polygon data */
  finalize(): BinaryPolygonData;

  /** Reset sink for reuse with new data */
  reset(): void;

  /** Set the current feature ID (called by driver between features) */
  setFeatureId(id: number): void;

  /** Debug snapshot. */
  getDebugInfo(): SinkDebugInfo;
}

// =============================================================================
// DECK.GL INTEGRATION TYPES
// =============================================================================

/**
 * Deck.gl binary attribute format
 */
export interface DeckBinaryAttribute {
  value: Float32Array | Uint32Array | Uint8Array;
  size: number;
  stride?: number;
  offset?: number;
  normalized?: boolean;
}

/**
 * Props structure for Deck.gl PathLayer with binary data
 */
export interface BinaryPathLayerProps {
  data: {
    length: number;
    startIndices: Uint32Array;
    attributes: {
      getPath: DeckBinaryAttribute;
    };
  };
  _pathType: "open";
}

/**
 * Props structure for Deck.gl SolidPolygonLayer with binary data
 */
export interface BinaryPolygonLayerProps {
  data: {
    length: number;
    startIndices: Uint32Array;
    attributes: {
      getPolygon: DeckBinaryAttribute;
      indices?: Uint32Array;
      vertexValid?: DeckBinaryAttribute;
    };
  };
  _normalize: false;
}

/**
 * Props for Deck.gl TextLayer (Hybrid Mode)
 * Allows binary positions while keeping text accessor dynamic
 */
export interface BinaryTextLayerProps {
  // Use binary attribute for position
  getPosition: { value: Float32Array; size: 2 };

  // Helpers for the hybrid pattern
  numInstances: number;
  featureIds: Uint32Array;
}

/**
 * Props structure for Deck.gl ScatterplotLayer with binary data
 */
export interface BinaryScatterplotLayerProps {
  data: {
    length: number;
    attributes: {
      getPosition: DeckBinaryAttribute;
    };
  };
}

/**
 * Attribute accessor using featureIds for lookup
 */
export type FeatureAccessor<T> = (featureId: number, pathIndex: number) => T;

// =============================================================================
// UTILITY TYPES
// =============================================================================

/**
 * Coordinate pair (for internal use only - avoid in hot paths)
 */
export type Coordinate = [number, number];

/**
 * Bounding box [minX, minY, maxX, maxY]
 */
export type BBox = [number, number, number, number];

/**
 * Statistics from parsing operation
 */
export interface ParseStats {
  /** Number of input features processed */
  inputFeatures: number;

  /** Number of output paths generated */
  outputPaths: number;

  /** Total input coordinate count */
  inputCoordinates: number;

  /** Total output coordinate count */
  outputCoordinates: number;

  /** Processing time in milliseconds */
  processingTimeMs: number;

  /** Peak memory usage estimate in bytes */
  peakMemoryBytes: number;
}
