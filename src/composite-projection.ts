/**
 * Composite Projection Builder
 * 
 * Creates composite projections that combine multiple sub-projections,
 * each associated with a geographic region and positioned in a layout.
 * 
 * Use cases:
 * - USA with Alaska and Hawaii insets (like d3.geoAlbersUsa)
 * - France with DOM-TOM territories
 * - Portugal with Azores and Madeira
 * - Any territory with distant regions to display together
 * 
 * HOW IT WORKS (Multiplex Pattern)
 * ================================
 * 1. Each geometry event (point, lineStart, lineEnd, etc.) is broadcast to ALL sub-projections
 * 2. Each sub-projection has a `clipExtent` that filters out points outside its region
 * 3. Only points within a sub-projection's clip region produce output
 * 4. The sink receives the filtered, projected output from all sub-projections
 * 
 * CRITICAL: Sub-projections must have mutually exclusive clipExtent regions
 * to avoid interleaving output from multiple projections.
 * 
 * @packageDocumentation
 */

import type { GeoStream, GeoProjection } from 'd3-geo';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Geographic bounding box [west, south, east, north] in degrees
 */
export type GeoBounds = [number, number, number, number];

/**
 * Screen/pixel bounding box [[x0, y0], [x1, y1]]
 */
export type ScreenExtent = [[number, number], [number, number]];

/**
 * Configuration for a single sub-projection entry in a composite
 */
export interface SubProjectionEntry {
  /**
   * Unique identifier for this region (e.g., 'mainland', 'alaska', 'guadeloupe')
   */
  id: string;
  
  /**
   * The d3 projection to use for this region.
   * Should be pre-configured with center/rotate/parallels but NOT scale/translate/clipExtent.
   * Those will be computed automatically based on layout.
   */
  projection: GeoProjection;
  
  /**
   * Geographic bounds [west, south, east, north] that this projection covers.
   * Used for routing points to the correct sub-projection.
   */
  bounds: GeoBounds;
  
  /**
   * Position of this region in the final layout.
   * Coordinates are relative to [0, 0] - [1, 1] normalized space.
   * @example { x: 0.1, y: 0.7, width: 0.2, height: 0.25 } // Bottom-left inset
   */
  layout: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  
  /**
   * Optional scale multiplier relative to the main projection.
   * Values > 1 enlarge the region (useful for small islands).
   * @default 1.0
   */
  scaleMultiplier?: number;
}

/**
 * Configuration for building a composite projection
 */
export interface CompositeProjectionConfig {
  /**
   * Array of sub-projection entries.
   * The first entry is typically the "main" territory.
   */
  entries: SubProjectionEntry[];
  
  /**
   * Overall width of the output in pixels.
   * @default 960
   */
  width?: number;
  
  /**
   * Overall height of the output in pixels.
   * @default 600
   */
  height?: number;
  
  /**
   * Padding around each inset region in pixels.
   * @default 2
   */
  insetPadding?: number;
}

/**
 * A sub-projection with computed layout information
 */
export interface ComputedSubProjection {
  id: string;
  projection: GeoProjection;
  bounds: GeoBounds;
  screenExtent: ScreenExtent;
}

/**
 * A composite projection that implements the d3 GeoStream interface
 */
export interface CompositeProjection {
  /**
   * The stream method - implements d3's projection.stream() interface.
   * Returns a multiplexed stream that broadcasts to all sub-projections.
   */
  stream(sink: GeoStream): GeoStream;
  
  /**
   * Project a single point. Returns null if outside all regions.
   */
  (coordinates: [number, number]): [number, number] | null;
  
  /**
   * Inverse projection - find geographic coordinates from screen coordinates.
   * Returns null if outside all regions.
   */
  invert?(coordinates: [number, number]): [number, number] | null;
  
  /**
   * Get the computed sub-projections with their screen extents.
   * Useful for rendering inset borders.
   */
  getSubProjections(): ComputedSubProjection[];
  
  /**
   * Get border paths for inset regions (all except the first/main).
   * Returns an array of SVG path strings for the inset frames.
   */
  getInsetBorders(): InsetBorder[];
  
  /**
   * Update the overall scale of the composite projection.
   */
  scale(scale?: number): CompositeProjection | number;
  
  /**
   * Update the overall translation of the composite projection.
   */
  translate(translate?: [number, number]): CompositeProjection | [number, number];
}

/**
 * Border information for an inset region
 */
export interface InsetBorder {
  id: string;
  /** Screen coordinates of the border rectangle [[x0, y0], [x1, y1]] */
  extent: ScreenExtent;
  /** SVG path string for the border (can be used with PathLayer) */
  path: [number, number][];
}

// =============================================================================
// MULTIPLEX STREAM
// =============================================================================

/**
 * Creates a multiplexed stream that broadcasts events to multiple sub-streams.
 * This is the core pattern from d3-geo's geoAlbersUsa implementation.
 * 
 * @param streams - Array of sub-projection streams
 * @returns A GeoStream that broadcasts to all sub-streams
 */
function multiplex(streams: GeoStream[]): GeoStream {
  const n = streams.length;
  
  return {
    point(x: number, y: number): void {
      for (let i = 0; i < n; i++) {
        streams[i].point(x, y);
      }
    },
    sphere(): void {
      for (let i = 0; i < n; i++) {
        streams[i].sphere?.();
      }
    },
    lineStart(): void {
      for (let i = 0; i < n; i++) {
        streams[i].lineStart();
      }
    },
    lineEnd(): void {
      for (let i = 0; i < n; i++) {
        streams[i].lineEnd();
      }
    },
    polygonStart(): void {
      for (let i = 0; i < n; i++) {
        streams[i].polygonStart();
      }
    },
    polygonEnd(): void {
      for (let i = 0; i < n; i++) {
        streams[i].polygonEnd();
      }
    }
  };
}

// =============================================================================
// PROJECTION BUILDER
// =============================================================================

/**
 * Creates a GeoJSON feature from geographic bounds for use with fitExtent
 */
function boundsToFeature(bounds: GeoBounds): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [bounds[0], bounds[1]], // SW
        [bounds[0], bounds[3]], // NW
        [bounds[2], bounds[3]], // NE
        [bounds[2], bounds[1]], // SE
        [bounds[0], bounds[1]]  // Close
      ]]
    }
  };
}

/**
 * Check if a point is within geographic bounds
 */
function isWithinBounds(lon: number, lat: number, bounds: GeoBounds): boolean {
  return lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3];
}

/**
 * Build a composite projection from configuration.
 * 
 * @param config - Configuration with sub-projection entries and layout
 * @returns A CompositeProjection that implements the d3 stream interface
 * 
 * @example
 * ```typescript
 * import { geoConicConformal, geoMercator } from 'd3-geo';
 * import { buildCompositeProjection } from 'geoarrow-deck-stream';
 * 
 * const franceDomTom = buildCompositeProjection({
 *   width: 960,
 *   height: 600,
 *   entries: [
 *     {
 *       id: 'mainland',
 *       projection: geoConicConformal().parallels([44, 49]).rotate([-3, 0]),
 *       bounds: [-5.5, 41, 10, 51.5],
 *       layout: { x: 0.2, y: 0, width: 0.8, height: 1 }
 *     },
 *     {
 *       id: 'guadeloupe',
 *       projection: geoMercator(),
 *       bounds: [-61.9, 15.8, -60.9, 16.6],
 *       layout: { x: 0, y: 0, width: 0.18, height: 0.2 },
 *       scaleMultiplier: 1.5
 *     },
 *     // ... more DOM-TOM
 *   ]
 * });
 * 
 * // Use with parseGeometry
 * const result = parseGeometry(table, { projection: franceDomTom });
 * ```
 */
export function buildCompositeProjection(config: CompositeProjectionConfig): CompositeProjection {
  const { 
    entries, 
    width = 960, 
    height = 600,
    insetPadding = 2
  } = config;
  
  if (entries.length === 0) {
    throw new Error('CompositeProjection requires at least one entry');
  }
  
  // Compute screen extents for each entry based on layout
  const computedEntries: ComputedSubProjection[] = entries.map(entry => {
    const screenExtent: ScreenExtent = [
      [entry.layout.x * width + insetPadding, entry.layout.y * height + insetPadding],
      [(entry.layout.x + entry.layout.width) * width - insetPadding, 
       (entry.layout.y + entry.layout.height) * height - insetPadding]
    ];
    
    // Create bounds feature for fitExtent
    const boundsFeature = boundsToFeature(entry.bounds);
    
    // Use d3's fitExtent directly - this properly computes scale and translate
    // to fit the geographic bounds within the screen extent
    entry.projection.fitExtent(screenExtent, boundsFeature);
    
    // Apply scale multiplier if specified (e.g., to enlarge small islands)
    if (entry.scaleMultiplier && entry.scaleMultiplier !== 1.0) {
      const currentScale = entry.projection.scale();
      const currentTranslate = entry.projection.translate();
      const extentCenterX = (screenExtent[0][0] + screenExtent[1][0]) / 2;
      const extentCenterY = (screenExtent[0][1] + screenExtent[1][1]) / 2;
      
      // Scale around the center of the extent
      const newScale = currentScale * entry.scaleMultiplier;
      const newTranslateX = extentCenterX + (currentTranslate[0] - extentCenterX) * entry.scaleMultiplier;
      const newTranslateY = extentCenterY + (currentTranslate[1] - extentCenterY) * entry.scaleMultiplier;
      
      entry.projection.scale(newScale).translate([newTranslateX, newTranslateY]);
    }
    
    // Apply clipExtent to limit output to this region's screen area
    // This is crucial: it ensures only geometry that projects INTO this
    // screen area is output, cutting off everything else
    entry.projection.clipExtent(screenExtent);
    
    return {
      id: entry.id,
      projection: entry.projection,
      bounds: entry.bounds,
      screenExtent
    };
  });
  
  // Stream cache for performance
  let cache: GeoStream | null = null;
  let cacheStream: GeoStream | null = null;
  
  // The composite projection function
  const composite = function(coordinates: [number, number]): [number, number] | null {
    const [lon, lat] = coordinates;
    
    // Find which sub-projection handles this point
    for (const entry of computedEntries) {
      if (isWithinBounds(lon, lat, entry.bounds)) {
        const result = entry.projection(coordinates);
        // Check if projected point is within the clip extent
        if (result !== null) {
          const [x, y] = result;
          const ext = entry.screenExtent;
          if (x >= ext[0][0] && x <= ext[1][0] && y >= ext[0][1] && y <= ext[1][1]) {
            return result;
          }
        }
      }
    }
    return null;
  } as CompositeProjection;
  
  // Stream method - the key interface for d3-geo compatibility
  composite.stream = function(sink: GeoStream): GeoStream {
    // Use cached stream if same sink
    if (cache && cacheStream === sink) {
      return cache;
    }
    
    // Create multiplexed stream from all sub-projections
    const streams = computedEntries.map(entry => entry.projection.stream(sink));
    cache = multiplex(streams);
    cacheStream = sink;
    
    return cache;
  };
  
  // Inverse projection
  composite.invert = function(coordinates: [number, number]): [number, number] | null {
    const [x, y] = coordinates;
    
    // Find which sub-projection's screen extent contains this point
    for (const entry of computedEntries) {
      const ext = entry.screenExtent;
      if (x >= ext[0][0] && x <= ext[1][0] && y >= ext[0][1] && y <= ext[1][1]) {
        const invert = entry.projection.invert;
        if (invert) {
          return invert(coordinates);
        }
      }
    }
    return null;
  };
  
  // Get sub-projections with computed layout
  composite.getSubProjections = function(): ComputedSubProjection[] {
    return computedEntries;
  };
  
  // Get inset borders (all except first/main)
  composite.getInsetBorders = function(): InsetBorder[] {
    return computedEntries.slice(1).map(entry => {
      const ext = entry.screenExtent;
      return {
        id: entry.id,
        extent: ext,
        path: [
          [ext[0][0], ext[0][1]], // Top-left
          [ext[1][0], ext[0][1]], // Top-right
          [ext[1][0], ext[1][1]], // Bottom-right
          [ext[0][0], ext[1][1]], // Bottom-left
          [ext[0][0], ext[0][1]]  // Close
        ]
      };
    });
  };
  
  // Scale getter/setter
  let currentScale = 1;
  composite.scale = function(scale?: number): CompositeProjection | number {
    if (scale === undefined) return currentScale;
    currentScale = scale;
    // Invalidate cache and recompute would go here for full implementation
    cache = null;
    return composite;
  };
  
  // Translate getter/setter
  let currentTranslate: [number, number] = [0, 0];
  composite.translate = function(translate?: [number, number]): CompositeProjection | [number, number] {
    if (translate === undefined) return currentTranslate;
    currentTranslate = translate;
    // Invalidate cache and recompute would go here for full implementation
    cache = null;
    return composite;
  };
  
  return composite;
}

// =============================================================================
// DECK.GL BORDER LAYER HELPERS
// =============================================================================

/**
 * Creates PathLayer data for rendering inset borders.
 * 
 * @param composite - A composite projection created by buildCompositeProjection
 * @returns Data ready for Deck.gl PathLayer
 * 
 * @example
 * ```typescript
 * import { PathLayer } from '@deck.gl/layers';
 * 
 * const composite = buildCompositeProjection({ ... });
 * const borderData = createInsetBorderData(composite);
 * 
 * new PathLayer({
 *   id: 'inset-borders',
 *   data: borderData,
 *   getPath: d => d.path,
 *   getColor: [100, 100, 100],
 *   getWidth: 1,
 *   widthUnits: 'pixels'
 * });
 * ```
 */
export function createInsetBorderData(composite: CompositeProjection): InsetBorder[] {
  return composite.getInsetBorders();
}

/**
 * Creates binary path data for inset borders (for use with binary PathLayer).
 * 
 * @param composite - A composite projection
 * @returns Binary data compatible with createPathLayerProps
 */
export function createInsetBorderBinaryData(composite: CompositeProjection): {
  positions: Float32Array;
  startIndices: Uint32Array;
  featureIds: Uint32Array;
  length: number;
} {
  const borders = composite.getInsetBorders();
  
  // Calculate total positions needed (5 points per border rectangle × 2 coords)
  const totalCoords = borders.length * 5 * 2;
  const positions = new Float32Array(totalCoords);
  const startIndices = new Uint32Array(borders.length + 1);
  const featureIds = new Uint32Array(borders.length);
  
  let posIdx = 0;
  
  for (let i = 0; i < borders.length; i++) {
    const border = borders[i];
    startIndices[i] = posIdx / 2;
    featureIds[i] = i;
    
    for (const [x, y] of border.path) {
      positions[posIdx++] = x;
      positions[posIdx++] = y;
    }
  }
  
  // Final start index for Deck.gl
  startIndices[borders.length] = posIdx / 2;
  
  return {
    positions,
    startIndices,
    featureIds,
    length: borders.length
  };
}

// =============================================================================
// PRESET CONFIGURATIONS
// =============================================================================

/**
 * Preset layout configurations for common composite projection use cases.
 * Use these as starting points and customize as needed.
 */
export const PRESET_LAYOUTS = {
  /**
   * France with DOM-TOM territories
   * Layout: Mainland on the right, DOM-TOM in a column on the left
   */
  FRANCE_DOM_TOM: {
    mainland: { x: 0.22, y: 0, width: 0.78, height: 1 },
    guadeloupe: { x: 0, y: 0, width: 0.2, height: 0.18 },
    martinique: { x: 0, y: 0.19, width: 0.2, height: 0.18 },
    guyane: { x: 0, y: 0.38, width: 0.2, height: 0.22 },
    reunion: { x: 0, y: 0.61, width: 0.2, height: 0.18 },
    mayotte: { x: 0, y: 0.80, width: 0.2, height: 0.18 },
  },
  
  /**
   * USA with Alaska and Hawaii
   * Layout similar to geoAlbersUsa
   */
  USA_ALASKA_HAWAII: {
    lower48: { x: 0, y: 0, width: 1, height: 0.85 },
    alaska: { x: 0.01, y: 0.70, width: 0.25, height: 0.28 },
    hawaii: { x: 0.26, y: 0.75, width: 0.15, height: 0.20 },
  },
  
  /**
   * Portugal with Azores and Madeira
   */
  PORTUGAL_ISLANDS: {
    mainland: { x: 0.35, y: 0, width: 0.65, height: 1 },
    azores: { x: 0, y: 0, width: 0.33, height: 0.45 },
    madeira: { x: 0, y: 0.50, width: 0.33, height: 0.45 },
  }
} as const;

/**
 * Geographic bounds for common territories.
 * Use these as reference when building custom composite projections.
 */
export const TERRITORY_BOUNDS: Record<string, GeoBounds> = {
  // France
  FRANCE_MAINLAND: [-5.5, 41, 10, 51.5],
  GUADELOUPE: [-61.9, 15.8, -60.9, 16.6],
  MARTINIQUE: [-61.3, 14.35, -60.75, 14.95],
  GUYANE: [-54.6, 2, -51.6, 6],
  REUNION: [55.2, -21.5, 55.9, -20.8],
  MAYOTTE: [44.9, -13.1, 45.35, -12.6],
  
  // USA
  USA_LOWER48: [-125, 24, -66, 50],
  ALASKA: [-180, 51, -130, 72],
  HAWAII: [-161, 18, -154, 23],
  
  // Portugal
  PORTUGAL_MAINLAND: [-9.6, 36.9, -6, 42.2],
  AZORES: [-31.5, 36.8, -24.7, 40],
  MADEIRA: [-17.5, 32.3, -16.2, 33.2],
};
