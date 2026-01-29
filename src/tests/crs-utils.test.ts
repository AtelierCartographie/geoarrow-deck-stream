/**
 * CRS Detection Tests
 * 
 * Tests for extracting and analyzing CRS metadata from GeoArrow and GeoParquet.
 */

import { describe, it, expect } from 'vitest';
import {
  extractCRSFromArrow,
  extractCRSFromGeoParquet,
  isWGS84,
  getCRSInfo,
  getProjectionStrategy,
  parseGeoParquetMetadata,
  formatCRSInfo,
  type PROJJSON,
  type GeoParquetMetadata,
  type CRSInfo,
} from '../index.js';
import { tableFromIPC } from 'apache-arrow';
import { readFileSync } from 'fs';
import { join } from 'path';

// =============================================================================
// Test Data Paths
// =============================================================================

const TEST_DATA_DIR = join(__dirname, '../../examples/test-data');

function loadArrowFile(relativePath: string) {
  const fullPath = join(TEST_DATA_DIR, relativePath);
  const buffer = readFileSync(fullPath);
  return tableFromIPC(buffer);
}

// =============================================================================
// GeoParquet Metadata Fixtures
// =============================================================================

const WGS84_PROJJSON: PROJJSON = {
  "$schema": "https://proj.org/schemas/v0.5/projjson.schema.json",
  "type": "GeographicCRS",
  "name": "WGS 84 longitude-latitude",
  "datum": {
    "type": "GeodeticReferenceFrame",
    "name": "World Geodetic System 1984",
    "ellipsoid": {
      "name": "WGS 84",
      "semi_major_axis": 6378137,
      "inverse_flattening": 298.257223563
    }
  },
  "coordinate_system": {
    "subtype": "ellipsoidal",
    "axis": [
      { "name": "Geodetic longitude", "abbreviation": "Lon", "direction": "east", "unit": "degree" },
      { "name": "Geodetic latitude", "abbreviation": "Lat", "direction": "north", "unit": "degree" }
    ]
  },
  "id": { "authority": "OGC", "code": "CRS84" }
};

const EPSG_4326_PROJJSON: PROJJSON = {
  "type": "GeographicCRS",
  "name": "WGS 84",
  "datum": {
    "name": "World Geodetic System 1984",
    "id": { "authority": "EPSG", "code": 6326 }
  },
  "id": { "authority": "EPSG", "code": 4326 }
};

const UTM_10N_PROJJSON: PROJJSON = {
  "type": "ProjectedCRS",
  "name": "NAD83 / UTM zone 10N",
  "base_crs": {
    "type": "GeographicCRS",
    "name": "NAD83",
    "datum": { "name": "North American Datum 1983" }
  },
  "conversion": {
    "name": "UTM zone 10N",
    "method": { "name": "Transverse Mercator" }
  },
  "id": { "authority": "EPSG", "code": 26910 }
};

const LAMBERT_93_PROJJSON: PROJJSON = {
  "type": "ProjectedCRS",
  "name": "RGF93 v1 / Lambert-93",
  "base_crs": {
    "type": "GeographicCRS",
    "name": "RGF93 v1",
    "datum": { "name": "Reseau Geodesique Francais 1993 v1" }
  },
  "id": { "authority": "EPSG", "code": 2154 }
};

// =============================================================================
// GeoParquet Metadata Tests
// =============================================================================

describe('GeoParquet CRS Detection', () => {
  describe('extractCRSFromGeoParquet', () => {
    it('should return WGS84 when crs key is absent (spec default)', () => {
      const metadata: GeoParquetMetadata = {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Polygon"]
            // Note: no 'crs' key - spec says default is OGC:CRS84
          }
        }
      };

      const result = extractCRSFromGeoParquet(metadata);
      
      expect(result.isWGS84).toBe(true);
      expect(result.isGeographic).toBe(true);
      expect(result.source).toBe('geoparquet');
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('default');
    });

    it('should return unknown when crs is explicitly null', () => {
      const metadata: GeoParquetMetadata = {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Polygon"],
            crs: null  // Explicitly unknown
          }
        }
      };

      const result = extractCRSFromGeoParquet(metadata);
      
      expect(result.isWGS84).toBe(false);
      expect(result.isUnknown).toBe(true);
      expect(result.source).toBe('geoparquet');
    });

    it('should detect WGS84 from OGC:CRS84 id', () => {
      const metadata: GeoParquetMetadata = {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Point"],
            crs: WGS84_PROJJSON
          }
        }
      };

      const result = extractCRSFromGeoParquet(metadata);
      
      expect(result.isWGS84).toBe(true);
      expect(result.id?.authority).toBe('OGC');
      expect(result.id?.code).toBe('CRS84');
      expect(result.confidence).toBe('high');
    });

    it('should detect WGS84 from EPSG:4326 id', () => {
      const metadata: GeoParquetMetadata = {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Point"],
            crs: EPSG_4326_PROJJSON
          }
        }
      };

      const result = extractCRSFromGeoParquet(metadata);
      
      expect(result.isWGS84).toBe(true);
      expect(result.id?.authority).toBe('EPSG');
      expect(result.id?.code).toBe(4326);
      expect(result.isGeographic).toBe(true);
    });

    it('should detect projected CRS as not WGS84', () => {
      const metadata: GeoParquetMetadata = {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Polygon"],
            crs: UTM_10N_PROJJSON
          }
        }
      };

      const result = extractCRSFromGeoParquet(metadata);
      
      expect(result.isWGS84).toBe(false);
      expect(result.isGeographic).toBe(false);
      expect(result.type).toBe('ProjectedCRS');
      expect(result.name).toContain('UTM');
    });

    it('should detect Lambert-93 as not WGS84', () => {
      const metadata: GeoParquetMetadata = {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "point",
            geometry_types: ["Point"],
            crs: LAMBERT_93_PROJJSON
          }
        }
      };

      const result = extractCRSFromGeoParquet(metadata);
      
      expect(result.isWGS84).toBe(false);
      expect(result.type).toBe('ProjectedCRS');
      expect(result.id?.code).toBe(2154);
    });

    it('should handle non-primary column', () => {
      const metadata: GeoParquetMetadata = {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Point"],
            crs: WGS84_PROJJSON
          },
          centroid: {
            encoding: "point",
            geometry_types: ["Point"],
            crs: UTM_10N_PROJJSON
          }
        }
      };

      const primaryResult = extractCRSFromGeoParquet(metadata);
      expect(primaryResult.isWGS84).toBe(true);

      const centroidResult = extractCRSFromGeoParquet(metadata, 'centroid');
      expect(centroidResult.isWGS84).toBe(false);
      expect(centroidResult.type).toBe('ProjectedCRS');
    });
  });

  describe('parseGeoParquetMetadata', () => {
    it('should parse valid GeoParquet metadata JSON', () => {
      const json = JSON.stringify({
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: { encoding: "WKB", geometry_types: ["Point"] }
        }
      });

      const result = parseGeoParquetMetadata(json);
      
      expect(result).not.toBeNull();
      expect(result?.version).toBe("1.1.0");
      expect(result?.primary_column).toBe("geometry");
    });

    it('should return null for invalid JSON', () => {
      const result = parseGeoParquetMetadata('not valid json {');
      expect(result).toBeNull();
    });
  });
});

// =============================================================================
// GeoArrow CRS Detection Tests
// =============================================================================

describe('GeoArrow CRS Detection', () => {
  describe('extractCRSFromArrow with real files', () => {
    it('should extract CRS from interleaved linestrings', () => {
      const table = loadArrowFile('primitives/linestrings.interleaved.arrow');
      const result = extractCRSFromArrow(table);
      
      // Files created without explicit CRS should default to WGS84
      expect(result.crsInfo).not.toBeNull();
      expect(result.crsInfo?.isWGS84).toBe(true);
    });

    it('should work with multipolygon files', () => {
      const table = loadArrowFile('primitives/multipolygons.interleaved.arrow');
      const result = extractCRSFromArrow(table);
      
      expect(result.error).toBeNull();
      expect(result.crsInfo).not.toBeNull();
    });

    it('should handle missing geometry column gracefully', () => {
      const table = loadArrowFile('primitives/points.interleaved.arrow');
      const result = extractCRSFromArrow(table, 'nonexistent_column');
      
      expect(result.found).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('isWGS84 convenience function', () => {
    it('should return true for WGS84 data', () => {
      const table = loadArrowFile('primitives/points.interleaved.arrow');
      expect(isWGS84(table)).toBe(true);
    });

    it('should return true for data without CRS (spec default)', () => {
      const table = loadArrowFile('primitives/polygons.interleaved.arrow');
      // No explicit CRS = WGS84 by spec
      expect(isWGS84(table)).toBe(true);
    });
  });

  describe('getProjectionStrategy', () => {
    it('should recommend reproject for WGS84 data', () => {
      const table = loadArrowFile('primitives/linestrings.interleaved.arrow');
      expect(getProjectionStrategy(table)).toBe('reproject');
    });
  });
});

// =============================================================================
// CRS Analysis Logic Tests
// =============================================================================

describe('CRS Analysis Logic', () => {
  describe('Authority code detection', () => {
    it('should detect EPSG:4326 as WGS84', () => {
      const metadata: GeoParquetMetadata = {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Point"],
            crs: { type: "GeographicCRS", id: { authority: "EPSG", code: 4326 } }
          }
        }
      };

      const result = extractCRSFromGeoParquet(metadata);
      expect(result.isWGS84).toBe(true);
    });

    it('should detect EPSG:3857 as not WGS84 (Web Mercator)', () => {
      const metadata: GeoParquetMetadata = {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Point"],
            crs: { 
              type: "ProjectedCRS", 
              name: "WGS 84 / Pseudo-Mercator",
              id: { authority: "EPSG", code: 3857 } 
            }
          }
        }
      };

      const result = extractCRSFromGeoParquet(metadata);
      expect(result.isWGS84).toBe(false);
      expect(result.type).toBe('ProjectedCRS');
    });
  });

  describe('Datum-based detection', () => {
    it('should detect WGS84 from datum ID EPSG:6326', () => {
      const metadata: GeoParquetMetadata = {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "point",
            geometry_types: ["Point"],
            crs: {
              type: "GeographicCRS",
              name: "Some Custom CRS",
              datum: {
                name: "World Geodetic System 1984",
                id: { authority: "EPSG", code: 6326 }
              }
            }
          }
        }
      };

      const result = extractCRSFromGeoParquet(metadata);
      expect(result.isWGS84).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('should detect WGS84 from datum name', () => {
      const metadata: GeoParquetMetadata = {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "point",
            geometry_types: ["Point"],
            crs: {
              type: "GeographicCRS",
              datum: { name: "World Geodetic System 1984" }
            }
          }
        }
      };

      const result = extractCRSFromGeoParquet(metadata);
      expect(result.isWGS84).toBe(true);
      expect(result.confidence).toBe('medium'); // Lower confidence from name match
    });
  });
});

// =============================================================================
// formatCRSInfo Tests
// =============================================================================

describe('formatCRSInfo', () => {
  it('should format complete CRS info', () => {
    const crsInfo: CRSInfo = {
      isWGS84: true,
      isUnknown: false,
      isGeographic: true,
      type: 'GeographicCRS',
      id: { authority: 'EPSG', code: 4326 },
      name: 'WGS 84',
      raw: null,
      source: 'geoarrow',
      confidence: 'high',
      reason: 'test'
    };

    const formatted = formatCRSInfo(crsInfo);
    
    expect(formatted).toContain('WGS 84');
    expect(formatted).toContain('EPSG:4326');
    expect(formatted).toContain('GeographicCRS');
    expect(formatted).toContain('WGS84');
    expect(formatted).toContain('Geographic');
  });

  it('should handle minimal CRS info', () => {
    const crsInfo: CRSInfo = {
      isWGS84: false,
      isUnknown: true,
      isGeographic: false,
      type: null,
      id: null,
      name: null,
      raw: null,
      source: 'geoarrow',
      confidence: 'low',
      reason: 'unknown'
    };

    const formatted = formatCRSInfo(crsInfo);
    expect(formatted).toContain('Unknown');
  });
});
