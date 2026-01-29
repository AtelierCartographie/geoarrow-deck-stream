/**
 * CRS (Coordinate Reference System) Detection Utilities
 * 
 * Provides functions to extract and analyze CRS metadata from GeoArrow columns
 * and GeoParquet files, following official specifications:
 * 
 * - GeoArrow: https://geoarrow.org/extension-types
 * - GeoParquet: https://github.com/opengeospatial/geoparquet/blob/main/format-specs/geoparquet.md
 * 
 * Primary use case: Determine if data is in WGS84 (requires reprojection)
 * or already projected (pass-through mode).
 * 
 * Key insight from specs:
 * - If CRS metadata is ABSENT → default is OGC:CRS84 (WGS84)
 * - If CRS is explicitly null → unknown/undefined CRS
 */

import type { Table, Field } from 'apache-arrow';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * PROJJSON CRS structure (simplified)
 * Based on https://proj.org/specifications/projjson.html
 */
export interface PROJJSON {
  /** Schema URL, e.g. "https://proj.org/schemas/v0.5/projjson.schema.json" */
  $schema?: string;
  
  /** CRS type: "GeographicCRS", "ProjectedCRS", "CompoundCRS", etc. */
  type: string;
  
  /** CRS name, e.g. "WGS 84", "EPSG:4326", "NAD83 / UTM zone 10N" */
  name?: string;
  
  /** Datum information */
  datum?: {
    type?: string;
    name?: string;
    ellipsoid?: {
      name?: string;
      semi_major_axis?: number;
      inverse_flattening?: number;
    };
    id?: CRSIdentifier;
  };
  
  /** Coordinate system (axis order, units) */
  coordinate_system?: {
    subtype?: string;
    axis?: Array<{
      name?: string;
      abbreviation?: string;
      direction?: string;
      unit?: string | { type: string; name: string; conversion_factor: number };
    }>;
  };
  
  /** CRS identifier (authority + code) */
  id?: CRSIdentifier;
  
  /** For ProjectedCRS: the base geographic CRS */
  base_crs?: PROJJSON;
  
  /** For ProjectedCRS: the conversion/projection method */
  conversion?: {
    name?: string;
    method?: { name?: string; id?: CRSIdentifier };
    parameters?: Array<{ name?: string; value?: number; unit?: string }>;
  };
}

/**
 * CRS identifier (authority + code)
 */
export interface CRSIdentifier {
  authority: string;
  code: string | number;
}

/**
 * GeoArrow extension metadata structure
 * Stored in ARROW:extension:metadata as JSON
 */
export interface GeoArrowExtensionMetadata {
  /** CRS as PROJJSON object, string (WKT2, authority:code), or undefined */
  crs?: PROJJSON | string | null;
  
  /** Type hint for crs field: "projjson", "wkt2:2019", "authority_code", "srid" */
  crs_type?: 'projjson' | 'wkt2:2019' | 'authority_code' | 'srid';
  
  /** Edge interpretation: omit for planar, or "spherical", "vincenty", etc. */
  edges?: string;
}

/**
 * GeoParquet file-level metadata structure
 * Stored in Parquet file metadata under "geo" key
 */
export interface GeoParquetMetadata {
  /** GeoParquet spec version, e.g. "1.1.0" */
  version: string;
  
  /** Name of the primary geometry column */
  primary_column: string;
  
  /** Per-column metadata */
  columns: Record<string, GeoParquetColumnMetadata>;
}

/**
 * GeoParquet column metadata
 */
export interface GeoParquetColumnMetadata {
  /** Encoding: "WKB", "point", "linestring", etc. */
  encoding: string;
  
  /** Geometry types present, e.g. ["Polygon", "MultiPolygon"] */
  geometry_types: string[];
  
  /** CRS as PROJJSON object, or null for unknown, or undefined for WGS84 default */
  crs?: PROJJSON | null;
  
  /** Winding order: "counterclockwise" or undefined */
  orientation?: string;
  
  /** Edge type: "planar" or "spherical" */
  edges?: string;
  
  /** Bounding box [xmin, ymin, xmax, ymax] */
  bbox?: number[];
  
  /** Coordinate epoch for dynamic CRS */
  epoch?: number;
}

/**
 * Normalized CRS information extracted from metadata
 */
export interface CRSInfo {
  /** Whether CRS could be identified as WGS84/OGC:CRS84 */
  isWGS84: boolean;
  
  /** Whether CRS is explicitly undefined (crs: null) */
  isUnknown: boolean;
  
  /** Whether CRS is geographic (not projected) */
  isGeographic: boolean;
  
  /** CRS type from PROJJSON, e.g. "GeographicCRS", "ProjectedCRS" */
  type: string | null;
  
  /** CRS identifier if available */
  id: CRSIdentifier | null;
  
  /** CRS name if available */
  name: string | null;
  
  /** Original CRS data (for advanced usage) */
  raw: PROJJSON | string | null;
  
  /** Source of CRS info */
  source: 'geoarrow' | 'geoparquet' | 'default';
  
  /** Confidence level of WGS84 detection */
  confidence: 'high' | 'medium' | 'low';
  
  /** Human-readable reason for the classification */
  reason: string;
}

/**
 * Result of CRS extraction from Arrow
 */
export interface CRSExtractionResult {
  /** Whether CRS metadata was found */
  found: boolean;
  
  /** Parsed CRS info, or null if not found */
  crsInfo: CRSInfo | null;
  
  /** Raw metadata string (for debugging) */
  rawMetadata: string | null;
  
  /** Error message if parsing failed */
  error: string | null;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Known WGS84-equivalent identifiers
 */
const WGS84_IDENTIFIERS: Array<{ authority: string; code: string | number }> = [
  { authority: 'OGC', code: 'CRS84' },
  { authority: 'EPSG', code: 4326 },
  { authority: 'EPSG', code: '4326' },
];

/**
 * Known WGS84-related datum names (case-insensitive matching)
 */
const WGS84_DATUM_PATTERNS = [
  'world geodetic system 1984',
  'wgs 84',
  'wgs84',
  'wgs_84',
];

/**
 * Default CRS info when no metadata is present (GeoParquet/GeoArrow spec default)
 */
const DEFAULT_WGS84_CRS_INFO: CRSInfo = {
  isWGS84: true,
  isUnknown: false,
  isGeographic: true,
  type: 'GeographicCRS',
  id: { authority: 'OGC', code: 'CRS84' },
  name: 'OGC:CRS84 (default)',
  raw: null,
  source: 'default',
  confidence: 'high',
  reason: 'No CRS metadata - spec default is OGC:CRS84 (WGS84)',
};

/**
 * CRS info when explicitly set to null (unknown)
 */
const UNKNOWN_CRS_INFO: CRSInfo = {
  isWGS84: false,
  isUnknown: true,
  isGeographic: false,
  type: null,
  id: null,
  name: null,
  raw: null,
  source: 'geoarrow',
  confidence: 'high',
  reason: 'CRS explicitly set to null (unknown/undefined)',
};

// =============================================================================
// CORE DETECTION FUNCTIONS
// =============================================================================

/**
 * Extract CRS information from a GeoArrow column in an Arrow Table
 * 
 * Reads the ARROW:extension:metadata field and parses the JSON to extract
 * CRS information following the GeoArrow specification.
 * 
 * @param table - Arrow Table containing GeoArrow geometry
 * @param geometryColumnName - Name of the geometry column (default: "geometry")
 * @returns CRS extraction result with parsed info or error
 * 
 * @example
 * ```typescript
 * const table = tableFromIPC(buffer);
 * const result = extractCRSFromArrow(table);
 * 
 * if (result.crsInfo?.isWGS84) {
 *   // Use d3 projection for reprojection
 * } else {
 *   // Use geoIdentity() for pass-through
 * }
 * ```
 */
export function extractCRSFromArrow(
  table: Table,
  geometryColumnName = 'geometry'
): CRSExtractionResult {
  // Find the geometry column field
  const geomField = table.schema.fields.find(f => f.name === geometryColumnName);
  
  if (!geomField) {
    // Try common alternative names
    const alternativeNames = ['geom', 'wkb_geometry', 'the_geom', 'shape'];
    const altField = table.schema.fields.find(f => 
      alternativeNames.includes(f.name.toLowerCase())
    );
    
    if (altField) {
      return extractCRSFromField(altField, 'geoarrow');
    }
    
    return {
      found: false,
      crsInfo: null,
      rawMetadata: null,
      error: `Geometry column "${geometryColumnName}" not found in schema`,
    };
  }
  
  return extractCRSFromField(geomField, 'geoarrow');
}

/**
 * Extract CRS from a single Arrow Field
 */
export function extractCRSFromField(
  field: Field,
  source: 'geoarrow' | 'geoparquet' = 'geoarrow'
): CRSExtractionResult {
  if (!field.metadata) {
    // No metadata at all - use spec default (WGS84)
    return {
      found: false,
      crsInfo: { ...DEFAULT_WGS84_CRS_INFO, source },
      rawMetadata: null,
      error: null,
    };
  }
  
  const extensionMetadata = field.metadata.get('ARROW:extension:metadata');
  
  if (!extensionMetadata) {
    // Extension name exists but no metadata - use spec default (WGS84)
    return {
      found: false,
      crsInfo: { ...DEFAULT_WGS84_CRS_INFO, source },
      rawMetadata: null,
      error: null,
    };
  }
  
  try {
    const parsed = JSON.parse(extensionMetadata) as GeoArrowExtensionMetadata;
    const crsInfo = analyzeCRS(parsed.crs, parsed.crs_type, source);
    
    return {
      found: true,
      crsInfo,
      rawMetadata: extensionMetadata,
      error: null,
    };
  } catch (e) {
    return {
      found: false,
      crsInfo: null,
      rawMetadata: extensionMetadata,
      error: `Failed to parse extension metadata: ${e instanceof Error ? e.message : 'Unknown error'}`,
    };
  }
}

/**
 * Extract CRS information from GeoParquet file metadata
 * 
 * GeoParquet stores metadata in a JSON blob under the "geo" key in
 * the Parquet file's key-value metadata.
 * 
 * @param geoMetadata - Parsed GeoParquet metadata (from "geo" key)
 * @param columnName - Geometry column to check (default: primary_column)
 * @returns Normalized CRS information
 * 
 * @example
 * ```typescript
 * // When using parquet-wasm or arrow-js to read Parquet
 * const metadata = parquetFile.metadata.keyValueMetadata.get('geo');
 * const geoMeta = JSON.parse(metadata);
 * const crsInfo = extractCRSFromGeoParquet(geoMeta);
 * ```
 */
export function extractCRSFromGeoParquet(
  geoMetadata: GeoParquetMetadata,
  columnName?: string
): CRSInfo {
  const targetColumn = columnName ?? geoMetadata.primary_column;
  const columnMeta = geoMetadata.columns[targetColumn];
  
  if (!columnMeta) {
    // Column not found - return default
    return { ...DEFAULT_WGS84_CRS_INFO, source: 'geoparquet' };
  }
  
  // Check if crs key exists
  if (!('crs' in columnMeta)) {
    // crs key absent - default is OGC:CRS84 per spec
    return { ...DEFAULT_WGS84_CRS_INFO, source: 'geoparquet' };
  }
  
  if (columnMeta.crs === null) {
    // Explicitly null - unknown CRS
    return { ...UNKNOWN_CRS_INFO, source: 'geoparquet' };
  }
  
  return analyzeCRS(columnMeta.crs, undefined, 'geoparquet');
}

/**
 * Parse raw GeoParquet metadata JSON string
 * 
 * Convenience function for when you have the raw "geo" metadata string.
 */
export function parseGeoParquetMetadata(
  geoJsonString: string
): GeoParquetMetadata | null {
  try {
    return JSON.parse(geoJsonString) as GeoParquetMetadata;
  } catch {
    return null;
  }
}

// =============================================================================
// CRS ANALYSIS
// =============================================================================

/**
 * Analyze CRS data and determine if it represents WGS84
 * 
 * This is the core analysis function that implements the WGS84 detection logic.
 */
function analyzeCRS(
  crs: PROJJSON | string | null | undefined,
  crsType: GeoArrowExtensionMetadata['crs_type'],
  source: 'geoarrow' | 'geoparquet' | 'default'
): CRSInfo {
  // Case 1: CRS is undefined (not present in metadata)
  if (crs === undefined) {
    return { ...DEFAULT_WGS84_CRS_INFO, source };
  }
  
  // Case 2: CRS is explicitly null
  if (crs === null) {
    return { ...UNKNOWN_CRS_INFO, source };
  }
  
  // Case 3: CRS is a string (WKT2, authority:code, or SRID)
  if (typeof crs === 'string') {
    return analyzeStringCRS(crs, crsType, source);
  }
  
  // Case 4: CRS is a PROJJSON object
  return analyzePROJJSON(crs, source);
}

/**
 * Analyze a string CRS representation
 */
function analyzeStringCRS(
  crs: string,
  crsType: GeoArrowExtensionMetadata['crs_type'],
  source: 'geoarrow' | 'geoparquet' | 'default'
): CRSInfo {
  const trimmed = crs.trim().toUpperCase();
  
  // Check for authority:code format
  if (crsType === 'authority_code' || /^[A-Z]+:\d+$/.test(trimmed)) {
    const [authority, code] = crs.split(':');
    const id = { authority: authority.toUpperCase(), code };
    
    const isWGS84 = WGS84_IDENTIFIERS.some(
      w => w.authority === id.authority && String(w.code) === String(id.code)
    );
    
    return {
      isWGS84,
      isUnknown: false,
      isGeographic: isWGS84, // Assume geographic if WGS84
      type: null,
      id,
      name: crs,
      raw: crs,
      source,
      confidence: isWGS84 ? 'high' : 'medium',
      reason: isWGS84 
        ? `Authority code ${crs} matches WGS84` 
        : `Authority code ${crs} - not recognized as WGS84`,
    };
  }
  
  // Check for SRID (numeric only)
  if (crsType === 'srid' || /^\d+$/.test(trimmed)) {
    const srid = parseInt(trimmed, 10);
    const isWGS84 = srid === 4326;
    
    return {
      isWGS84,
      isUnknown: false,
      isGeographic: isWGS84,
      type: null,
      id: isWGS84 ? { authority: 'EPSG', code: 4326 } : null,
      name: `SRID:${srid}`,
      raw: crs,
      source,
      confidence: isWGS84 ? 'high' : 'low',
      reason: isWGS84
        ? 'SRID 4326 = EPSG:4326 (WGS84)'
        : `SRID ${srid} - cannot determine projection without database lookup`,
    };
  }
  
  // Check for WKT2 (starts with common WKT keywords)
  if (crsType === 'wkt2:2019' || /^(GEOGCRS|PROJCRS|GEODCRS|ENGCRS)/.test(trimmed)) {
    // Basic WKT2 parsing - look for WGS84 indicators
    const isWGS84 = WGS84_DATUM_PATTERNS.some(pattern => 
      crs.toLowerCase().includes(pattern)
    );
    
    return {
      isWGS84,
      isUnknown: false,
      isGeographic: trimmed.startsWith('GEOGCRS') || trimmed.startsWith('GEODCRS'),
      type: trimmed.startsWith('PROJCRS') ? 'ProjectedCRS' : 
            trimmed.startsWith('GEOGCRS') ? 'GeographicCRS' : null,
      id: null,
      name: extractWKTName(crs),
      raw: crs,
      source,
      confidence: isWGS84 ? 'medium' : 'low',
      reason: isWGS84
        ? 'WKT2 contains WGS84 datum reference'
        : 'WKT2 CRS - detailed parsing required for full identification',
    };
  }
  
  // Unknown string format
  return {
    isWGS84: false,
    isUnknown: true,
    isGeographic: false,
    type: null,
    id: null,
    name: crs.substring(0, 50),
    raw: crs,
    source,
    confidence: 'low',
    reason: 'Unrecognized CRS string format',
  };
}

/**
 * Analyze a PROJJSON CRS object
 * 
 * This implements the WGS84 detection logic per GeoParquet spec recommendations.
 */
function analyzePROJJSON(
  crs: PROJJSON,
  source: 'geoarrow' | 'geoparquet' | 'default'
): CRSInfo {
  // Check 1: Direct ID match (highest confidence)
  if (crs.id) {
    const idMatch = WGS84_IDENTIFIERS.some(
      w => w.authority === crs.id!.authority && 
           String(w.code) === String(crs.id!.code)
    );
    
    if (idMatch) {
      return {
        isWGS84: true,
        isUnknown: false,
        isGeographic: true,
        type: crs.type,
        id: crs.id,
        name: crs.name ?? `${crs.id.authority}:${crs.id.code}`,
        raw: crs,
        source,
        confidence: 'high',
        reason: `CRS ID ${crs.id.authority}:${crs.id.code} matches WGS84`,
      };
    }
  }
  
  // Check 2: Datum ID or name
  if (crs.datum) {
    // Check datum ID
    if (crs.datum.id) {
      const datumIsWGS84 = 
        (crs.datum.id.authority === 'EPSG' && 
         (crs.datum.id.code === 6326 || crs.datum.id.code === '6326'));
      
      if (datumIsWGS84 && crs.type === 'GeographicCRS') {
        return {
          isWGS84: true,
          isUnknown: false,
          isGeographic: true,
          type: crs.type,
          id: crs.id ?? null,
          name: crs.name ?? 'WGS 84 (from datum)',
          raw: crs,
          source,
          confidence: 'high',
          reason: 'Datum EPSG:6326 (WGS 84) with GeographicCRS type',
        };
      }
    }
    
    // Check datum name
    if (crs.datum.name) {
      const datumNameLower = crs.datum.name.toLowerCase();
      const datumIsWGS84 = WGS84_DATUM_PATTERNS.some(p => 
        datumNameLower.includes(p)
      );
      
      if (datumIsWGS84 && crs.type === 'GeographicCRS') {
        return {
          isWGS84: true,
          isUnknown: false,
          isGeographic: true,
          type: crs.type,
          id: crs.id ?? null,
          name: crs.name ?? crs.datum.name,
          raw: crs,
          source,
          confidence: 'medium',
          reason: `Datum name "${crs.datum.name}" indicates WGS84`,
        };
      }
    }
  }
  
  // Check 3: CRS name contains WGS84
  if (crs.name) {
    const nameLower = crs.name.toLowerCase();
    const nameIsWGS84 = WGS84_DATUM_PATTERNS.some(p => nameLower.includes(p));
    
    if (nameIsWGS84 && crs.type === 'GeographicCRS') {
      return {
        isWGS84: true,
        isUnknown: false,
        isGeographic: true,
        type: crs.type,
        id: crs.id ?? null,
        name: crs.name,
        raw: crs,
        source,
        confidence: 'medium',
        reason: `CRS name "${crs.name}" indicates WGS84`,
      };
    }
  }
  
  // Not WGS84 - determine what we know
  const isGeographic = crs.type === 'GeographicCRS';
  const isProjected = crs.type === 'ProjectedCRS';
  
  return {
    isWGS84: false,
    isUnknown: false,
    isGeographic,
    type: crs.type,
    id: crs.id ?? null,
    name: crs.name ?? null,
    raw: crs,
    source,
    confidence: crs.id ? 'high' : 'medium',
    reason: isProjected
      ? `ProjectedCRS "${crs.name ?? 'unknown'}" - not WGS84`
      : isGeographic
        ? `GeographicCRS "${crs.name ?? 'unknown'}" - not recognized as WGS84`
        : `CRS type "${crs.type}" - not WGS84`,
  };
}

/**
 * Extract name from WKT string
 */
function extractWKTName(wkt: string): string | null {
  const match = wkt.match(/^[A-Z]+\s*\[\s*"([^"]+)"/);
  return match ? match[1] : null;
}

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * Quick check if an Arrow Table contains WGS84 geometry
 * 
 * This is the primary function for deciding projection strategy.
 * 
 * @param table - Arrow Table with GeoArrow geometry
 * @param geometryColumnName - Column name (default: "geometry")
 * @returns true if WGS84 (needs reprojection), false otherwise (pass-through)
 * 
 * @example
 * ```typescript
 * const projection = isWGS84(table)
 *   ? geoMercator().fitSize([width, height], bounds)
 *   : geoIdentity();  // Pass-through for pre-projected data
 * ```
 */
export function isWGS84(
  table: Table,
  geometryColumnName = 'geometry'
): boolean {
  const result = extractCRSFromArrow(table, geometryColumnName);
  return result.crsInfo?.isWGS84 ?? true; // Default to WGS84 if unknown
}

/**
 * Get detailed CRS information from an Arrow Table
 */
export function getCRSInfo(
  table: Table,
  geometryColumnName = 'geometry'
): CRSInfo {
  const result = extractCRSFromArrow(table, geometryColumnName);
  return result.crsInfo ?? { ...DEFAULT_WGS84_CRS_INFO };
}

/**
 * Determine the recommended projection strategy
 * 
 * Returns a recommendation for how to handle the geometry:
 * - "reproject": Data is in WGS84, use a d3 projection
 * - "passthrough": Data is already projected, use geoIdentity()
 * - "unknown": CRS is unknown, user should decide
 */
export function getProjectionStrategy(
  table: Table,
  geometryColumnName = 'geometry'
): 'reproject' | 'passthrough' | 'unknown' {
  const result = extractCRSFromArrow(table, geometryColumnName);
  const crs = result.crsInfo;
  
  if (!crs) {
    return 'unknown';
  }
  
  if (crs.isUnknown) {
    return 'unknown';
  }
  
  if (crs.isWGS84) {
    return 'reproject';
  }
  
  // Not WGS84 and not unknown - likely already projected
  return 'passthrough';
}

/**
 * Format CRS info as a human-readable string
 */
export function formatCRSInfo(crsInfo: CRSInfo): string {
  const parts: string[] = [];
  
  if (crsInfo.name) {
    parts.push(crsInfo.name);
  }
  
  if (crsInfo.id) {
    parts.push(`(${crsInfo.id.authority}:${crsInfo.id.code})`);
  }
  
  if (crsInfo.type) {
    parts.push(`[${crsInfo.type}]`);
  }
  
  const statusFlags: string[] = [];
  if (crsInfo.isWGS84) statusFlags.push('WGS84');
  if (crsInfo.isGeographic) statusFlags.push('Geographic');
  if (crsInfo.isUnknown) statusFlags.push('Unknown');
  
  if (statusFlags.length > 0) {
    parts.push(`{${statusFlags.join(', ')}}`);
  }
  
  return parts.join(' ') || 'No CRS information';
}
