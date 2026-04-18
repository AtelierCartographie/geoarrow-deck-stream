/**
 * Deck.gl Integration - Binary Attribute Helpers
 *
 * Utilities for creating Deck.gl layer props from parsed binary data.
 *
 * This module supports two layer types:
 *
 * 1. PATH LAYER (LineStrings, MultiLineStrings)
 *    - Uses PathLayer with open paths
 *    - Binary format: flat positions + startIndices
 *    - Color/width per path via attribute replication
 *
 * 2. POLYGON LAYER (Polygons, MultiPolygons)
 *    - Uses SolidPolygonLayer with binary vertex data
 *    - Requires vertexValid mask for ring closures (hole support)
 *    - Color/elevation per polygon via vertex attribute replication
 *
 * KEY CONCEPT: Feature ID Mapping
 * ================================
 * Both layer types track which vertex/path belongs to which original feature
 * via featureIds array. This enables:
 * - Dynamic coloring based on feature properties
 * - Proper attribute lookup when geometries are split by clipping
 * - Consistent styling across all output primitives from one input feature
 *
 * PERFORMANCE NOTES
 * =================
 * - Attributes are pre-computed and stored as binary buffers
 * - No runtime lookups during rendering
 * - Vertex-level attributes (polygons) are replicated across all vertices of a feature
 * - Use accessor functions only for dynamic updates to data
 */

import type {
  BinaryPathData,
  BinaryPathLayerProps,
  BinaryPolygonData,
  BinaryPolygonLayerProps,
  BinaryPointData,
  BinaryScatterplotLayerProps,
  BinaryTextLayerProps,
  DeckBinaryAttribute,
} from "./types.js";

/**
 * Creates properties for a TextLayer using hybrid mode:
 * - Positions are binary (fast)
 * - Text is dynamic (via accessor function)
 *
 * Note: 'data' must be handled by the caller. To make this work, passing a
 * dummy array of the correct length as `data` to the layer is required:
 * `data: { length: props.numInstances }` won't work with getters.
 * Use: `data: new Array(props.numInstances).fill(null)` (sparse array, cheap)
 *
 * @param data - Binary point data (parsed from points or centroids)
 * @returns Props ready to spread into TextLayer
 */
export function createTextLayerProps(
  data: BinaryPointData,
): BinaryTextLayerProps {
  // @ts-ignore
  const binaryProp = { value: data.positions, size: 2 };

  return {
    // Deck.gl allows passing attribute definitions directly as props
    // @ts-ignore
    getPosition: binaryProp,

    numInstances: data.featureIds.length,
    featureIds: data.featureIds,
  };
}

/**
 * Create ScatterplotLayer-compatible props from binary point data
 *
 * @param data - Parsed binary point data
 * @returns Props ready to spread into ScatterplotLayer
 *
 * @example
 * ```typescript
 * const pointData = parsePoints(table, { projection });
 * const props = createScatterplotLayerProps(pointData);
 *
 * new ScatterplotLayer({
 *   id: 'points',
 *   ...props,
 *   getRadius: 5,
 *   getFillColor: [255, 0, 0]
 * });
 * ```
 */
export function createScatterplotLayerProps(
  data: BinaryPointData,
): BinaryScatterplotLayerProps {
  return {
    data: {
      length: data.length,
      attributes: {
        getPosition: {
          value: data.positions,
          size: data.size,
        },
      },
    },
  };
}

/**
 * Create PathLayer-compatible props from binary data
 *
 * @param data - Parsed binary path data
 * @returns Props ready to spread into PathLayer
 *
 * @example
 * ```typescript
 * const pathData = parseLineStrings(column, { projection });
 * const props = createPathLayerProps(pathData);
 *
 * new PathLayer({
 *   id: 'paths',
 *   ...props,
 *   getColor: [255, 0, 0],
 *   getWidth: 2
 * });
 * ```
 */
export function createPathLayerProps(
  data: BinaryPathData,
): BinaryPathLayerProps {
  return {
    data: {
      length: data.length,
      startIndices: data.startIndices,
      attributes: {
        getPath: {
          value: data.positions,
          size: data.size,
        },
      },
    },
    _pathType: "open",
  };
}

/**
 * Create SolidPolygonLayer-compatible props from binary polygon data
 *
 * Follows Deck.gl's binary attribute requirements for SolidPolygonLayer:
 * - startIndices (top-level): where each polygon starts in the vertex buffer
 * - getPolygon: flat array of coordinates {value: Float32Array, size: 2}
 * - vertexValid: mask for polygon rings (1 for valid vertices, 0 for ring closures)
 *
 * **Zero-Copy Philosophy**: This function returns TypedArrays directly from the
 * parser without creating intermediate objects, maintaining maximum performance
 * for large datasets. The only mask created is vertexValid (required by Deck.gl
 * to handle polygon rings with holes), which is minimal overhead.
 *
 * **Reference**: https://deck.gl/docs/api-reference/layers/solid-polygon-layer#use-binary-attributes
 *
 * @param data - Parsed binary polygon data
 * @returns Props ready to spread into SolidPolygonLayer with _normalize: false
 *
 * @example
 * ```typescript
 * const polygonData = parsePolygonsToSolid(table, { projection });
 * const props = createSolidPolygonLayerProps(polygonData);
 *
 * new SolidPolygonLayer({
 *   id: 'polygons',
 *   ...props,
 *   getFillColor: [200, 50, 50, 160],
 *   _normalize: false
 * });
 * ```
 */
export function createSolidPolygonLayerProps(
  data: BinaryPolygonData,
): BinaryPolygonLayerProps {
  // Validate polygon data
  const polygonCount = Math.max(0, data.polygonIndices.length - 1);

  if (polygonCount === 0 || data.positions.length === 0) {
    // Return empty but valid structure for zero geometries
    return {
      data: {
        length: 0,
        startIndices: new Uint32Array([0]),
        attributes: {
          getPolygon: {
            value: new Float32Array(),
            size: data.size,
          },
          indices: new Uint32Array(),
        },
      },
      _normalize: false,
    };
  }

  const vertexValid = createVertexValidAttribute(data);

  return {
    data: {
      length: polygonCount,
      startIndices: data.polygonIndices,
      attributes: {
        getPolygon: {
          value: data.positions,
          size: data.size,
        },
        indices: data.indices,
        ...(vertexValid && { vertexValid }),
      },
    },
    _normalize: false,
  };
}

function createVertexValidAttribute(
  data: BinaryPolygonData,
): DeckBinaryAttribute | undefined {
  if (data.holeIndices.length <= data.polygonIndices.length) {
    return undefined;
  }

  const vertexCount = data.positions.length / 2;
  const vertexValid = new Uint8Array(vertexCount);
  vertexValid.fill(1);

  for (
    let ringIndex = 0;
    ringIndex < data.holeIndices.length - 1;
    ringIndex++
  ) {
    const ringEnd = data.holeIndices[ringIndex + 1];
    if (ringEnd > 0 && ringEnd <= vertexCount) {
      vertexValid[ringEnd - 1] = 0;
    }
  }

  return {
    value: vertexValid,
    size: 1,
  };
}

/**
 * Create a fill color attribute that uses featureIds for lookup
 *
 * This helper creates a vertex-level attribute by expanding polygon-level
 * colors to all vertices in each polygon. This is necessary because SolidPolygonLayer
 * works with binary vertex data.
 *
 * @param data - Parsed binary polygon data containing featureIds
 * @param colorLookup - Function to get color for a feature ID
 * @returns Binary attribute for getFillColor with colors per vertex
 */
export function createPolygonFillColorAttribute(
  data: BinaryPolygonData,
  colorLookup: (featureId: number) => [number, number, number, number],
): DeckBinaryAttribute {
  const vertexCount = data.positions.length / 2;
  const colors = new Uint8Array(vertexCount * 4);

  // For each polygon, assign its color to all its vertices
  for (let i = 0; i < data.polygonIndices.length - 1; i++) {
    const featureId = data.featureIds[i];
    const color = colorLookup(featureId);

    const vertexStart = data.polygonIndices[i];
    const vertexEnd = data.polygonIndices[i + 1];

    for (let v = vertexStart; v < vertexEnd; v++) {
      const offset = v * 4;
      colors[offset] = color[0];
      colors[offset + 1] = color[1];
      colors[offset + 2] = color[2];
      colors[offset + 3] = color[3];
    }
  }

  return {
    value: colors,
    size: 4,
    normalized: true,
  };
}

/**
 * Create an elevation attribute that uses featureIds for lookup
 *
 * Useful for 3D extrusion in SolidPolygonLayer.
 *
 * @param data - Parsed binary polygon data
 * @param elevationLookup - Function to get elevation for a feature ID
 * @returns Binary attribute for getElevation with elevations per vertex
 */
export function createPolygonElevationAttribute(
  data: BinaryPolygonData,
  elevationLookup: (featureId: number) => number,
): DeckBinaryAttribute {
  const vertexCount = data.positions.length / 2;
  const elevations = new Float32Array(vertexCount);

  // For each polygon, assign its elevation to all its vertices
  for (let i = 0; i < data.polygonIndices.length - 1; i++) {
    const featureId = data.featureIds[i];
    const elevation = elevationLookup(featureId);

    const vertexStart = data.polygonIndices[i];
    const vertexEnd = data.polygonIndices[i + 1];

    for (let v = vertexStart; v < vertexEnd; v++) {
      elevations[v] = elevation;
    }
  }

  return {
    value: elevations,
    size: 1,
  };
}

/**
 * Create a color attribute that uses featureIds for lookup (for PathLayer)
 *
 * This is essential when features are split by projection clipping -
 * all resulting paths should have the same color as the original feature.
 *
 * @param data - Parsed binary data containing featureIds
 * @param colorLookup - Function to get color for a feature ID
 * @returns Binary attribute or accessor for getColor
 */
export function createColorAttribute(
  data: BinaryPathData,
  colorLookup: (featureId: number) => [number, number, number, number],
): DeckBinaryAttribute {
  // Pre-compute colors for all output paths
  const colors = new Uint8Array(data.length * 4);

  for (let i = 0; i < data.length; i++) {
    const featureId = data.featureIds[i];
    const color = colorLookup(featureId);
    const offset = i * 4;
    colors[offset] = color[0];
    colors[offset + 1] = color[1];
    colors[offset + 2] = color[2];
    colors[offset + 3] = color[3];
  }

  return {
    value: colors,
    size: 4,
    normalized: true,
  };
}

/**
 * Create a width accessor that uses featureIds for lookup
 */
export function createWidthAttribute(
  data: BinaryPathData,
  widthLookup: (featureId: number) => number,
): DeckBinaryAttribute {
  const widths = new Float32Array(data.length);

  for (let i = 0; i < data.length; i++) {
    widths[i] = widthLookup(data.featureIds[i]);
  }

  return {
    value: widths,
    size: 1,
  };
}

/**
 * Create all binary attributes from Arrow table columns for PathLayer
 *
 * Maps attributes from the original Arrow table to output paths using featureIds
 *
 * @param data - Parsed binary path data
 * @param attributeTable - Object mapping attribute names to typed arrays
 * @returns Object with binary attributes for Deck.gl
 */
export function createAttributesFromTable(
  data: BinaryPathData,
  attributeTable: Record<
    string,
    Float32Array | Float64Array | Int32Array | Uint32Array
  >,
): Record<string, DeckBinaryAttribute> {
  const attributes: Record<string, DeckBinaryAttribute> = {};

  for (const [name, sourceArray] of Object.entries(attributeTable)) {
    // Determine element size by checking if values are multi-component
    const size = 1; // Assume scalar, adjust if needed

    const targetArray = new Float32Array(data.length);

    for (let i = 0; i < data.length; i++) {
      const featureId = data.featureIds[i];
      targetArray[i] = sourceArray[featureId];
    }

    attributes[name] = {
      value: targetArray,
      size,
    };
  }

  return attributes;
}

/**
 * Create vertex-level attributes from Arrow table columns for SolidPolygonLayer
 *
 * Replicates polygon-level attributes to all vertices of each polygon.
 * Essential for binary rendering with per-polygon properties.
 *
 * @param data - Parsed binary polygon data
 * @param attributeTable - Object mapping attribute names to typed arrays (one value per polygon)
 * @returns Object with vertex-level binary attributes for Deck.gl
 *
 * @example
 * ```typescript
 * const attrs = createPolygonAttributesFromTable(polygonData, {
 *   population: populationArray,  // One value per polygon
 *   density: densityArray
 * });
 *
 * // attrs.population now has one entry per vertex, replicated for each polygon
 * ```
 */
export function createPolygonAttributesFromTable(
  data: BinaryPolygonData,
  attributeTable: Record<
    string,
    Float32Array | Float64Array | Int32Array | Uint32Array
  >,
): Record<string, DeckBinaryAttribute> {
  const attributes: Record<string, DeckBinaryAttribute> = {};
  const vertexCount = data.positions.length / 2;

  for (const [name, sourceArray] of Object.entries(attributeTable)) {
    const targetArray = new Float32Array(vertexCount);

    // For each polygon, replicate its attribute to all its vertices
    for (let i = 0; i < data.polygonIndices.length - 1; i++) {
      const featureId = data.featureIds[i];
      const value = sourceArray[featureId];

      const vertexStart = data.polygonIndices[i];
      const vertexEnd = data.polygonIndices[i + 1];

      for (let v = vertexStart; v < vertexEnd; v++) {
        targetArray[v] = typeof value === "number" ? value : 0;
      }
    }

    attributes[name] = {
      value: targetArray,
      size: 1,
    };
  }

  return attributes;
}

/**
 * Calculate bounding box of binary path data
 * Useful for setting initial view state
 */
export function calculateBounds(data: BinaryPathData): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
} {
  const { positions } = data;

  if (positions.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, centerX: 0, centerY: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i];
    const y = positions[i + 1];

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

/**
 * Create initial view state for OrthographicView from bounds
 */
export function createOrthographicViewState(
  data: BinaryPathData,
  padding: number = 50,
): {
  target: [number, number, number];
  zoom: number;
} {
  const bounds = calculateBounds(data);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;

  // Estimate zoom based on bounds (heuristic)
  // Assumes roughly 800x600 viewport
  const viewportSize = 800;
  const maxDim = Math.max(width, height) + padding * 2;
  const zoom = Math.log2(viewportSize / maxDim);

  return {
    target: [bounds.centerX, bounds.centerY, 0],
    zoom: Math.max(-10, Math.min(20, zoom)),
  };
}

/**
 * Debug helper - convert binary data back to GeoJSON for verification
 * WARNING: Only use for debugging small datasets!
 */
export function toGeoJSON(data: BinaryPathData): {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { pathIndex: number; featureId: number };
    geometry: { type: "LineString"; coordinates: number[][] };
  }>;
} {
  const features = [];

  for (let i = 0; i < data.length; i++) {
    const startIdx = data.startIndices[i] * 2;
    const endIdx = data.startIndices[i + 1] * 2;

    const coordinates: number[][] = [];
    for (let j = startIdx; j < endIdx; j += 2) {
      coordinates.push([data.positions[j], data.positions[j + 1]]);
    }

    features.push({
      type: "Feature" as const,
      properties: {
        pathIndex: i,
        featureId: data.featureIds[i],
      },
      geometry: {
        type: "LineString" as const,
        coordinates,
      },
    });
  }

  return {
    type: "FeatureCollection",
    features,
  };
}
