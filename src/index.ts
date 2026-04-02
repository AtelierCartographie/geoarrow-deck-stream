/**
 * GeoArrow Deck Stream
 * 
 * High-performance GeoArrow to Deck.gl binary parser using d3-geo streaming.
 * Zero-serialization pipeline for maximum rendering performance.
 * 
 * Uses official @geoarrow/geoarrow-js types for GeoArrow interoperability.
 * 
 * @packageDocumentation
 */

// ============================================================================
// Core Types
// ============================================================================

// Output data structures
export type {
  BinaryPathData,
  BinaryPolygonData,
  BinaryPointData,
  ParserOptions,
  ParseStats,
  SinkDebugInfo,
  AllocationConfig,
  SinkState,
  BinarySink,
  BinaryPolygonSink,
  DeckBinaryAttribute,
  BinaryPathLayerProps,
  BinaryPolygonLayerProps,
  BinaryScatterplotLayerProps,
  BinaryTextLayerProps,
  FeatureAccessor,
  Coordinate,
  BBox,
  ProjectionLike
} from './types.js';

// Re-export GeoArrow types from official library
export type {
  // Data types (single batch)
  PointData,
  LineStringData,
  PolygonData,
  MultiPointData,
  MultiLineStringData,
  MultiPolygonData,
  // Vector types (chunked)
  PointVector,
  LineStringVector,
  PolygonVector,
  MultiPointVector,
  MultiLineStringVector,
  MultiPolygonVector,
  // Geometry type definitions
  Point,
  LineString,
  Polygon,
  MultiPoint,
  MultiLineString,
  MultiPolygon
} from './types.js';

// Re-export type guards from official library
export {
  isPointData,
  isLineStringData,
  isPolygonData,
  isMultiPointData,
  isMultiLineStringData,
  isMultiPolygonData,
  isPointVector,
  isLineStringVector,
  isPolygonVector,
  isMultiPointVector,
  isMultiLineStringVector,
  isMultiPolygonVector,
  // Child accessors
  getPointChild,
  getLineStringChild,
  getPolygonChild,
  getMultiPointChild,
  getMultiLineStringChild,
  getMultiPolygonChild
} from './types.js';

// ============================================================================
// Main Parsing Functions
// ============================================================================

export {
  // Primary API (geometry-agnostic)
  parseGeometry,
  parseGeometryWithStats,
  parseGeometryBatched,
  createIdentityParser,
  // Specialized parsers by output type
  parsePoints,
  parsePolygonsToSolid,
  getLayerType,
  type GeometryTypeString,
  type LayerType,
  // Backward compatibility aliases
  parseLineStrings,
  parseLineStringsWithStats,
  parseLineStringsBatched,
  parsePolygons,
  parsePolygonsWithStats,
  parseMultiLineStrings,
  parseMultiPolygons,
  // Type for input (Table recommended for reliable detection)
  type GeometryInput
} from './driver.js';

// ============================================================================
// Apache Arrow Re-exports (for Table usage)
// ============================================================================

export { tableFromIPC, Table, Vector } from 'apache-arrow';

// ============================================================================
// Binary Sinks (advanced use cases)
// ============================================================================

export {
  createBinarySink,
  createPolygonSink,
  type BinarySinkConfig,
  type BinarySinkInterface
} from './sink.js';

// ============================================================================
// Arrow Buffer Utilities
// ============================================================================

export {
  // Geometry detection
  detectGeometryType,
  GeometryType,
  type GeometryTypeValue,
  // Type unions
  type SupportedGeometryData,
  type SupportedGeometryVector,
  // Coordinate extraction (uses geoarrow-js helpers internally)
  extractPointCoordinates,
  extractMultiPointCoordinates,
  extractLineStringCoordinates,
  extractPolygonCoordinates,
  extractMultiLineStringCoordinates,
  extractMultiPolygonCoordinates,
  type ExtractedCoordinates,
  // Data chunk access
  getDataChunks,
  getFirstDataChunk,
  // Coordinate counting
  countCoordinates,
} from './arrow-reader.js';

// ============================================================================
// Buffer Utilities
// ============================================================================

export {
  GrowableBuffer,
  Buffers,
  estimateBufferSizes
} from './buffers.js';

// ============================================================================
// Deck.gl Integration
// ============================================================================

export {
  createScatterplotLayerProps,
  createPathLayerProps,
  createSolidPolygonLayerProps,
  createTextLayerProps,
  createColorAttribute,
  createPolygonFillColorAttribute,
  createPolygonElevationAttribute,
  createPolygonAttributesFromTable,
  createWidthAttribute,
  createAttributesFromTable,
  calculateBounds,
  createOrthographicViewState,
  toGeoJSON
} from './deck-integration.js';

// ============================================================================
// D3-geo Utilities
// ============================================================================

export { geoIdentity, geoOrthographic, geoMercator } from 'd3-geo';

// ============================================================================
// Logging
// ============================================================================

export { setLogging } from './logger.js';

// ============================================================================
// Composite Projections
// ============================================================================

export {
  // Builder function
  buildCompositeProjection,
  // Deck.gl helpers
  createInsetBorderData,
  createInsetBorderBinaryData,
  // Presets
  PRESET_LAYOUTS,
  TERRITORY_BOUNDS,
  // Multiplex stream (advanced use)
  // Types
  type GeoBounds,
  type ScreenExtent,
  type SubProjectionEntry,
  type CompositeProjectionConfig,
  type ComputedSubProjection,
  type CompositeProjection,
  type InsetBorder,
} from './composite-projection.js';

// ============================================================================
// CRS Detection Utilities
// ============================================================================

export {
  // Primary API
  extractCRSFromArrow,
  extractCRSFromGeoParquet,
  isWGS84,
  getCRSInfo,
  getProjectionStrategy,
  // GeoParquet helpers
  parseGeoParquetMetadata,
  extractCRSFromField,
  // Formatting
  formatCRSInfo,
  // Types
  type CRSInfo,
  type CRSExtractionResult,
  type CRSIdentifier,
  type PROJJSON,
  type GeoArrowExtensionMetadata,
  type GeoParquetMetadata,
  type GeoParquetColumnMetadata,
} from './crs-utils.js';

// ============================================================================
// WKB Reader (DuckDB WASM workaround)
// ============================================================================

export {
  decodeWkbColumn,
  isWkbGeometryColumn,
  type WkbGeomType,
  type DecodeWkbOptions,
  type DecodeWkbResult,
} from './wkb-reader.js';
