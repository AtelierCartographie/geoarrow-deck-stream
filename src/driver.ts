/**
 * Driver - The Pipeline Orchestrator
 * 
 * This is the main entry point that connects:
 * 1. GeoArrow input (using @geoarrow/geoarrow-js types)
 * 2. D3 projection stream
 * 3. Binary sink output
 * 
 * CRITICAL: Always use projection.stream(sink) - never bypass D3.
 * Even for identity transforms, D3 handles edge cases and provides
 * a consistent code path.
 */

import { geoIdentity } from 'd3-geo';
import type { GeoStream } from 'd3-geo';
import type { Vector, Table } from 'apache-arrow';

import { decodeWkbColumn } from './wkb-reader.js';

import type {
  LineStringData,
  PolygonData,
  MultiLineStringData,
  MultiPolygonData,
  PointData,
  MultiPointData,
} from './types.js';

import type { 
  BinaryPathData,
  BinaryPolygonData,
  BinaryPointData,
  ParserOptions,
  ParseStats,
  SinkDebugInfo,
} from './types.js';
import { createBinarySink, createPolygonSink } from './sink.js';
import { 
  detectGeometryType,
  getDataChunks,
  extractPointCoordinates,
  extractMultiPointCoordinates,
  extractLineStringCoordinates,
  extractPolygonCoordinates,
  extractMultiLineStringCoordinates,
  extractMultiPolygonCoordinates,
  countCoordinates,
  type SupportedGeometryData,
} from './arrow-reader.js';
import { estimateBufferSizes } from './buffers.js';

/**
 * Supported input type for the parser
 * 
 * **Must be an Arrow Table** with GeoArrow extension metadata (ARROW:extension:name)
 * for reliable geometry type detection.
 */
export type GeometryInput = Table;

/**
 * Main parsing function - transforms GeoArrow geometries to Deck.gl binary format
 * 
 * This function handles both reprojection (WGS84 → target CRS) and pass-through
 * (already projected data → Deck.gl format) using the same code path.
 * 
 * Supports: LineString, MultiLineString, Polygon, MultiPolygon
 * 
 * @param table - Arrow Table with GeoArrow geometry column and extension metadata
 * @param options - Parser configuration including D3 projection
 * @returns Binary data ready for Deck.gl PathLayer
 * 
 * @example
 * ```typescript
 * const table = tableFromIPC(buffer);
 * const result = parseGeometry(table, {
 *   projection: d3.geoOrthographic().rotate([-10, -40])
 * });
 * ```
 */
export function parseGeometry(
  input: GeometryInput,
  options: ParserOptions
): BinaryPathData {
  return runParse(input, options, false).data;
}

// Aliases for backward compatibility
export const parseLineStrings = parseGeometry;
export const parsePolygons = parseGeometry;
export const parseMultiLineStrings = parseGeometry;
export const parseMultiPolygons = parseGeometry;

/**
 * Parse with statistics collection (useful for debugging/profiling)
 */
export function parseGeometryWithStats(
  input: GeometryInput,
  options: ParserOptions
): { data: BinaryPathData; stats: ParseStats; debug?: SinkDebugInfo } {
  const startTime = performance.now();
  
  // Ensure native GeoArrow before extracting stats
  const { table: resolvedTable } = ensureNativeGeoArrow(input);
  const { chunks, totalLength } = getDataChunksFromInput(resolvedTable);
  const inputCoords = chunks.reduce(
    (sum, chunk) => sum + countCoordinates(chunk),
    0
  );
  
  const { data: outputData, debug } = runParse(resolvedTable, options, !!options.debug);

  const endTime = performance.now();
  
  const stats: ParseStats = {
    inputFeatures: totalLength,
    outputPaths: outputData.length,
    inputCoordinates: inputCoords,
    outputCoordinates: outputData.positions.length / 2,
    processingTimeMs: endTime - startTime,
    peakMemoryBytes: estimateMemoryUsage(outputData)
  };
  
  return { data: outputData, stats, debug };
}

// Aliases for backward compatibility
export const parseLineStringsWithStats = parseGeometryWithStats;
export const parsePolygonsWithStats = parseGeometryWithStats;

function getDataChunksFromInput(
  table: Table,
  geometryColumnName = 'geometry'
): { chunks: SupportedGeometryData[]; rowOffsets: number[]; totalLength: number } {
  const geomVector = table.getChild(geometryColumnName) ?? table.getChild('wkb_geometry');
  if (!geomVector) {
    throw new Error(`No geometry column found. Available: ${table.schema.fields.map(f => f.name).join(', ')}`);
  }

  const chunks = getDataChunks(geomVector as Vector) as SupportedGeometryData[];
  const rowOffsets: number[] = [];
  let totalLength = 0;

  for (const chunk of chunks) {
    rowOffsets.push(totalLength);
    totalLength += chunk.length;
  }

  return { chunks, rowOffsets, totalLength };
}

/**
 * If the table has a WKB geometry column, decode it to native GeoArrow.
 * Returns the (possibly converted) table and the resolved geometry type.
 */
function ensureNativeGeoArrow(table: Table): { table: Table; geomType: ReturnType<typeof detectGeometryType> } {
  let geomType = detectGeometryType(table);
  if (geomType === 'wkb') {
    const { table: convertedTable, geometryType } = decodeWkbColumn(table);
    return { table: convertedTable, geomType: geometryType as typeof geomType };
  }
  return { table, geomType };
}

function runParse(
  inputTable: Table,
  options: ParserOptions,
  collectDebug: boolean
): { data: BinaryPathData; debug?: SinkDebugInfo } {
  const { projection, capacityMultiplier = 1.5, debugSampleLimit } = options;

  // Ensure native GeoArrow (convert WKB if needed)
  const { table, geomType } = ensureNativeGeoArrow(inputTable);

  if (geomType === 'unknown' || geomType === 'wkb') {
    throw new Error('Unsupported geometry type or missing ARROW:extension:name metadata');
  }
  
  const { chunks, rowOffsets, totalLength } = getDataChunksFromInput(table);
  const coordCount = chunks.reduce(
    (sum, chunk) => sum + countCoordinates(chunk),
    0
  );
  
  const sizes = estimateBufferSizes(
    coordCount,
    totalLength,
    false 
  );
  
  // Create sink with estimated capacity
  const sink = createBinarySink({
    initialCoordCapacity: Math.ceil(sizes.positionCapacity * capacityMultiplier / 2),
    initialPathCapacity: Math.ceil(sizes.pathCapacity * capacityMultiplier),
    debug: collectDebug,
    debugSampleLimit
  });
  
  // Connect projection to sink via D3's stream API
  const stream = projection.stream(sink);
  
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const inputData = chunks[chunkIndex];
    const featureIdOffset = rowOffsets[chunkIndex];

    if (geomType === 'linestring') {
      streamLineStrings(
        inputData as LineStringData,
        stream,
        sink,
        featureIdOffset
      );
    } else if (geomType === 'polygon') {
      streamPolygons(
        inputData as PolygonData,
        stream,
        sink,
        featureIdOffset
      );
    } else if (geomType === 'multilinestring') {
      streamMultiLineStrings(
        inputData as MultiLineStringData,
        stream,
        sink,
        featureIdOffset
      );
    } else if (geomType === 'multipolygon') {
      streamMultiPolygons(
        inputData as MultiPolygonData,
        stream,
        sink,
        featureIdOffset
      );
    }
  }

  const outputData = sink.finalize();

  return { data: outputData, debug: collectDebug ? sink.getDebugInfo() : undefined };
}

/**
 * Stream LineString geometries through D3 projection
 * 
 * Critical loop - optimized for minimal overhead:
 * - Direct buffer access (no object creation)
 * - Manual stream method calls (no GeoJSON construction)
 */
function streamLineStrings(
  data: LineStringData,
  stream: GeoStream,
  sink: { setFeatureId: (id: number) => void },
  featureIdOffset = 0
): void {
  const { coords, geomOffsets } = extractLineStringCoordinates(data);
  const { flatCoords, dim, separatedCoords } = coords;
  const length = data.length;

  if (separatedCoords) {
    const { x: xCoords, y: yCoords } = separatedCoords;
    for (let featureIdx = 0; featureIdx < length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      const startOffset = geomOffsets[featureIdx];
      const endOffset = geomOffsets[featureIdx + 1];
      
      if (endOffset - startOffset < 2) continue;
      
      stream.lineStart();
      for (let i = startOffset; i < endOffset; i++) {
        stream.point(xCoords[i], yCoords[i]);
      }
      stream.lineEnd();
    }
  } else {
    for (let featureIdx = 0; featureIdx < length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      
      const startOffset = geomOffsets[featureIdx];
      const endOffset = geomOffsets[featureIdx + 1];
      const coordCount = endOffset - startOffset;
      
      if (coordCount < 2) continue;
      
      stream.lineStart();
      for (let i = startOffset; i < endOffset; i++) {
        const baseIdx = i * dim;
        const x = flatCoords[baseIdx];
        const y = flatCoords[baseIdx + 1];
        stream.point(x, y);
      }
      stream.lineEnd();
    }
  }
}

/**
 * Stream Polygon geometries through D3 projection
 * 
 * Polygon = List<List<Point>> where each ring becomes a separate path.
 * First ring is exterior, subsequent rings are holes.
 */
function streamPolygons(
  data: PolygonData,
  stream: GeoStream,
  sink: { setFeatureId: (id: number) => void },
  featureIdOffset = 0
): void {
  const { coords, geomOffsets, ringOffsets } = extractPolygonCoordinates(data);
  const { flatCoords, dim, separatedCoords } = coords;
  const length = data.length;
  
  if (separatedCoords) {
    const { x: xCoords, y: yCoords } = separatedCoords;
    for (let featureIdx = 0; featureIdx < length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      const ringStart = geomOffsets[featureIdx];
      const ringEnd = geomOffsets[featureIdx + 1];
      
      for (let ringIdx = ringStart; ringIdx < ringEnd; ringIdx++) {
        const coordStart = ringOffsets[ringIdx];
        const coordEnd = ringOffsets[ringIdx + 1];
        if (coordEnd - coordStart < 2) continue;
        
        stream.lineStart();
        for (let i = coordStart; i < coordEnd; i++) {
          stream.point(xCoords[i], yCoords[i]);
        }
        stream.lineEnd();
      }
    }
  } else {
    for (let featureIdx = 0; featureIdx < length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      
      const ringStart = geomOffsets[featureIdx];
      const ringEnd = geomOffsets[featureIdx + 1];
      
      for (let ringIdx = ringStart; ringIdx < ringEnd; ringIdx++) {
        const coordStart = ringOffsets[ringIdx];
        const coordEnd = ringOffsets[ringIdx + 1];
        const coordCount = coordEnd - coordStart;
        
        if (coordCount < 2) continue;
        
        stream.lineStart();
        
        for (let i = coordStart; i < coordEnd; i++) {
          const baseIdx = i * dim;
          stream.point(flatCoords[baseIdx], flatCoords[baseIdx + 1]);
        }
        
        stream.lineEnd();
      }
    }
  }
}

/**
 * Stream MultiLineString geometries through D3 projection
 * 
 * MultiLineString = List<List<Point>> where each linestring becomes a separate path.
 */
function streamMultiLineStrings(
  data: MultiLineStringData,
  stream: GeoStream,
  sink: { setFeatureId: (id: number) => void },
  featureIdOffset = 0
): void {
  const { coords, geomOffsets, partOffsets } = extractMultiLineStringCoordinates(data);
  const { flatCoords, dim, separatedCoords } = coords;
  const length = data.length;
  
  if (separatedCoords) {
    const { x: xCoords, y: yCoords } = separatedCoords;
    for (let featureIdx = 0; featureIdx < length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      const partStart = geomOffsets[featureIdx];
      const partEnd = geomOffsets[featureIdx + 1];
      
      for (let partIdx = partStart; partIdx < partEnd; partIdx++) {
        const coordStart = partOffsets[partIdx];
        const coordEnd = partOffsets[partIdx + 1];
        if (coordEnd - coordStart < 2) continue;
        
        stream.lineStart();
        for (let i = coordStart; i < coordEnd; i++) {
          stream.point(xCoords[i], yCoords[i]);
        }
        stream.lineEnd();
      }
    }
  } else {
    for (let featureIdx = 0; featureIdx < length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      
      const partStart = geomOffsets[featureIdx];
      const partEnd = geomOffsets[featureIdx + 1];
      
      // Each linestring in the MultiLineString becomes a separate line
      for (let partIdx = partStart; partIdx < partEnd; partIdx++) {
        const coordStart = partOffsets[partIdx];
        const coordEnd = partOffsets[partIdx + 1];
        const coordCount = coordEnd - coordStart;
        
        if (coordCount < 2) continue;
        
        stream.lineStart();
        
        for (let i = coordStart; i < coordEnd; i++) {
          const baseIdx = i * dim;
          stream.point(flatCoords[baseIdx], flatCoords[baseIdx + 1]);
        }
        
        stream.lineEnd();
      }
    }
  }
}

/**
 * Stream MultiPolygon geometries through D3 projection
 * 
 * MultiPolygon = List<List<List<Point>>>
 * Structure: geomOffsets (MultiPolygon) → polygonOffsets (Polygon) → ringOffsets (Ring)
 * Each ring becomes a separate line in the output.
 */
function streamMultiPolygons(
  data: MultiPolygonData,
  stream: GeoStream,
  sink: { setFeatureId: (id: number) => void },
  featureIdOffset = 0
): void {
  const { coords, geomOffsets, polygonOffsets, ringOffsets } = extractMultiPolygonCoordinates(data);
  const { flatCoords, dim, separatedCoords } = coords;
  const length = data.length;
  
  if (separatedCoords) {
    const { x: xCoords, y: yCoords } = separatedCoords;
    for (let featureIdx = 0; featureIdx < length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      const polygonStart = geomOffsets[featureIdx];
      const polygonEnd = geomOffsets[featureIdx + 1];
      
      for (let polygonIdx = polygonStart; polygonIdx < polygonEnd; polygonIdx++) {
        const ringStart = polygonOffsets[polygonIdx];
        const ringEnd = polygonOffsets[polygonIdx + 1];
        
        for (let ringIdx = ringStart; ringIdx < ringEnd; ringIdx++) {
          const coordStart = ringOffsets[ringIdx];
          const coordEnd = ringOffsets[ringIdx + 1];
          if (coordEnd - coordStart < 2) continue;
          
          stream.lineStart();
          for (let i = coordStart; i < coordEnd; i++) {
            stream.point(xCoords[i], yCoords[i]);
          }
          stream.lineEnd();
        }
      }
    }
  } else {
    for (let featureIdx = 0; featureIdx < length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      
      const polygonStart = geomOffsets[featureIdx];
      const polygonEnd = geomOffsets[featureIdx + 1];
      
      // Each Polygon in the MultiPolygon
      for (let polygonIdx = polygonStart; polygonIdx < polygonEnd; polygonIdx++) {
        const ringStart = polygonOffsets[polygonIdx];
        const ringEnd = polygonOffsets[polygonIdx + 1];
        
        // Each Ring in the Polygon (exterior + holes)
        for (let ringIdx = ringStart; ringIdx < ringEnd; ringIdx++) {
          const coordStart = ringOffsets[ringIdx];
          const coordEnd = ringOffsets[ringIdx + 1];
          const coordCount = coordEnd - coordStart;
          
          if (coordCount < 2) continue;
          
          stream.lineStart();
          
          for (let i = coordStart; i < coordEnd; i++) {
            const baseIdx = i * dim;
            stream.point(flatCoords[baseIdx], flatCoords[baseIdx + 1]);
          }
          
          stream.lineEnd();
        }
      }
    }
  }
}



/**
 * Estimate memory usage in bytes
 */
function estimateMemoryUsage(data: BinaryPathData): number {
  return (
    data.positions.byteLength +
    data.startIndices.byteLength +
    data.featureIds.byteLength
  );
}

/**
 * Create a pass-through parser for already-projected data
 * 
 * Convenience function that creates a geoIdentity projection configured
 * for common use cases (e.g., Y-axis reflection for screen coordinates)
 */
export function createIdentityParser(options: {
  reflectY?: boolean;
  scale?: number;
  translate?: [number, number];
} = {}) {
  const { reflectY = false, scale = 1, translate = [0, 0] } = options;
  
  let projection = geoIdentity() as any;
  
  if (reflectY) {
    projection = projection.reflectY(true);
  }
  
  if (scale !== 1) {
    projection = projection.scale(scale);
  }
  
  if (translate[0] !== 0 || translate[1] !== 0) {
    projection = projection.translate(translate);
  }
  
  return (input: GeometryInput) => 
    parseGeometry(input, { projection });
}

/**
 * Batch processing for large datasets
 * 
 * Processes data in chunks to avoid blocking the main thread
 * and provide progress feedback
 */
export async function parseGeometryBatched(
  input: GeometryInput,
  options: ParserOptions & {
    batchSize?: number;
    onProgress?: (progress: number) => void;
  }
): Promise<BinaryPathData> {
  const { batchSize = 10000, onProgress, ...parserOptions } = options;
  
  // Ensure native GeoArrow before checking data length
  const { table: resolvedInput } = ensureNativeGeoArrow(input);
  const { totalLength } = getDataChunksFromInput(resolvedInput);
  
  // For small datasets, use synchronous parsing
  if (totalLength <= batchSize) {
    return parseGeometry(resolvedInput, parserOptions);
  }
  
  // TODO: Implement true batch processing with chunk merging
  // For now, fall back to synchronous (still efficient due to TypedArrays)
  const result = parseGeometry(resolvedInput, parserOptions);
  onProgress?.(1);
  return result;
}

// Alias for backward compatibility
export const parseLineStringsBatched = parseGeometryBatched;

// =============================================================================
// SPECIALIZED PARSERS BY OUTPUT TYPE
// =============================================================================

/**
 * Parse Points/MultiPoints to ScatterplotLayer binary format
 * 
 * @param table - Arrow Table with Point or MultiPoint geometry
 * @param options - Parser configuration
 * @returns Binary data ready for ScatterplotLayer
 */
export function parsePoints(
  inputTable: Table,
  options: ParserOptions
): BinaryPointData {
  const { projection, capacityMultiplier = 1.5 } = options;
  const { table, geomType } = ensureNativeGeoArrow(inputTable);
  
  if (geomType !== 'point' && geomType !== 'multipoint') {
    throw new Error(`parsePoints requires Point or MultiPoint geometry, got: ${geomType}`);
  }
  
  const { chunks, rowOffsets } = getDataChunksFromInput(table);
  const coordCount = chunks.reduce(
    (sum, chunk) => sum + countCoordinates(chunk),
    0
  );
  
  // Pre-allocate output buffers
  const positions = new Float32Array(Math.ceil(coordCount * 2 * capacityMultiplier));
  const featureIds = new Uint32Array(Math.ceil(coordCount * capacityMultiplier));
  
  let posIdx = 0;
  let pointCount = 0;
  
  if (geomType === 'point') {
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const inputData = chunks[chunkIndex] as PointData;
      const featureIdOffset = rowOffsets[chunkIndex];
      const coords = extractPointCoordinates(inputData);
      const { flatCoords, dim, separatedCoords } = coords;

      if (separatedCoords) {
        const { x: xCoords, y: yCoords } = separatedCoords;
        for (let i = 0; i < inputData.length; i++) {
          const x = xCoords[i];
          const y = yCoords[i];

          const projected = projection([x, y]);
          if (projected && Number.isFinite(projected[0]) && Number.isFinite(projected[1])) {
            positions[posIdx++] = projected[0];
            positions[posIdx++] = projected[1];
            featureIds[pointCount++] = featureIdOffset + i;
          }
        }
      } else {
        for (let i = 0; i < inputData.length; i++) {
          const baseIdx = i * dim;
          const x = flatCoords[baseIdx];
          const y = flatCoords[baseIdx + 1];

          const projected = projection([x, y]);
          if (projected && Number.isFinite(projected[0]) && Number.isFinite(projected[1])) {
            positions[posIdx++] = projected[0];
            positions[posIdx++] = projected[1];
            featureIds[pointCount++] = featureIdOffset + i;
          }
        }
      }
    }
  } else {
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const inputData = chunks[chunkIndex] as MultiPointData;
      const featureIdOffset = rowOffsets[chunkIndex];
      const { coords, geomOffsets } = extractMultiPointCoordinates(inputData);
      const { flatCoords, dim, separatedCoords } = coords;

      if (separatedCoords) {
        const { x: xCoords, y: yCoords } = separatedCoords;
        for (let featureIdx = 0; featureIdx < inputData.length; featureIdx++) {
          const start = geomOffsets[featureIdx];
          const end = geomOffsets[featureIdx + 1];

          for (let i = start; i < end; i++) {
            const x = xCoords[i];
            const y = yCoords[i];

            const projected = projection([x, y]);
            if (projected && Number.isFinite(projected[0]) && Number.isFinite(projected[1])) {
              positions[posIdx++] = projected[0];
              positions[posIdx++] = projected[1];
              featureIds[pointCount++] = featureIdOffset + featureIdx;
            }
          }
        }
      } else {
        for (let featureIdx = 0; featureIdx < inputData.length; featureIdx++) {
          const start = geomOffsets[featureIdx];
          const end = geomOffsets[featureIdx + 1];

          for (let i = start; i < end; i++) {
            const baseIdx = i * dim;
            const x = flatCoords[baseIdx];
            const y = flatCoords[baseIdx + 1];

            const projected = projection([x, y]);
            if (projected && Number.isFinite(projected[0]) && Number.isFinite(projected[1])) {
              positions[posIdx++] = projected[0];
              positions[posIdx++] = projected[1];
              featureIds[pointCount++] = featureIdOffset + featureIdx;
            }
          }
        }
      }
    }
  }
  
  return {
    length: pointCount,
    positions: positions.subarray(0, posIdx),
    featureIds: featureIds.subarray(0, pointCount),
    size: 2
  };
}

/**
 * Parse Polygons/MultiPolygons to SolidPolygonLayer binary format
 * 
 * Uses D3 stream for projection and handles polygon rings (exterior + holes).
 * 
 * @param table - Arrow Table with Polygon or MultiPolygon geometry
 * @param options - Parser configuration
 * @returns Binary data ready for SolidPolygonLayer
 */
import { createRewindStream } from './rewind.js';

export function parsePolygonsToSolid(
  inputTable: Table,
  options: ParserOptions
): BinaryPolygonData {
  const { projection, capacityMultiplier = 1.5, debug, debugSampleLimit, rewind } = options;
  const { table, geomType } = ensureNativeGeoArrow(inputTable);

  // Default rewind logic: 
  // - use explicit option if provided
  // - otherwise default to true
  const shouldRewind = rewind !== undefined ? rewind : true;
  
  if (geomType !== 'polygon' && geomType !== 'multipolygon') {
    throw new Error(`parsePolygonsToSolid requires Polygon or MultiPolygon geometry, got: ${geomType}`);
  }
  
  const { chunks, rowOffsets, totalLength } = getDataChunksFromInput(table);
  const coordCount = chunks.reduce(
    (sum, chunk) => sum + countCoordinates(chunk),
    0
  );
  
  // Create polygon sink
  const sink = createPolygonSink({
    initialCoordCapacity: Math.ceil(coordCount * capacityMultiplier),
    initialPathCapacity: Math.ceil(totalLength * 2 * capacityMultiplier), // More rings than features
    debug,
    debugSampleLimit
  });
  
  // Connect projection to sink via D3's stream API
  // We insert a rewind stream to correct winding order before projection
  if (!projection) {
    throw new Error("parsePolygonsToSolid require a projection");
  }

  const projectedStream = projection.stream(sink);
  let stream = projectedStream;

  if (shouldRewind) {
    const rewind = createRewindStream(true);
    stream = rewind.stream(projectedStream);
  }

  // Stream geometries through D3
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const inputData = chunks[chunkIndex];
    const featureIdOffset = rowOffsets[chunkIndex];

    if (geomType === 'polygon') {
      streamPolygonsWithPolygonSink(
        inputData as PolygonData,
        stream,
        sink,
        featureIdOffset
      );
    } else {
      streamMultiPolygonsWithPolygonSink(
        inputData as MultiPolygonData,
        stream,
        sink,
        featureIdOffset
      );
    }
  }
  
  return sink.finalize();
}

/**
 * Stream Polygon geometries using polygonStart/polygonEnd for proper ring tracking
 */
function streamPolygonsWithPolygonSink(
  data: PolygonData,
  stream: GeoStream,
  sink: { setFeatureId: (id: number) => void },
  featureIdOffset = 0
): void {
  const { coords, geomOffsets, ringOffsets } = extractPolygonCoordinates(data);
  const { flatCoords, dim, separatedCoords } = coords;
  
  if (separatedCoords) {
    const { x: xCoords, y: yCoords } = separatedCoords;
    for (let featureIdx = 0; featureIdx < data.length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      
      const ringStart = geomOffsets[featureIdx];
      const ringEnd = geomOffsets[featureIdx + 1];
      
      stream.polygonStart();
      
      for (let ringIdx = ringStart; ringIdx < ringEnd; ringIdx++) {
        const coordStart = ringOffsets[ringIdx];
        const coordEnd = ringOffsets[ringIdx + 1];
        
        if (coordEnd - coordStart < 3) continue;
        
        stream.lineStart();
        for (let i = coordStart; i < coordEnd; i++) {
          stream.point(xCoords[i], yCoords[i]);
        }
        stream.lineEnd();
      }
      stream.polygonEnd();
    }
  } else {
    for (let featureIdx = 0; featureIdx < data.length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      
      const ringStart = geomOffsets[featureIdx];
      const ringEnd = geomOffsets[featureIdx + 1];
      
      stream.polygonStart();
      
      for (let ringIdx = ringStart; ringIdx < ringEnd; ringIdx++) {
        const coordStart = ringOffsets[ringIdx];
        const coordEnd = ringOffsets[ringIdx + 1];
        
        if (coordEnd - coordStart < 3) continue;
        
        stream.lineStart();
        
        for (let i = coordStart; i < coordEnd; i++) {
          const baseIdx = i * dim;
          stream.point(flatCoords[baseIdx], flatCoords[baseIdx + 1]);
        }
        
        stream.lineEnd();
      }
      
      stream.polygonEnd();
    }
  }
}

/**
 * Stream MultiPolygon geometries using polygonStart/polygonEnd
 */
function streamMultiPolygonsWithPolygonSink(
  data: MultiPolygonData,
  stream: GeoStream,
  sink: { setFeatureId: (id: number) => void },
  featureIdOffset = 0
): void {
  const { coords, geomOffsets, polygonOffsets, ringOffsets } = extractMultiPolygonCoordinates(data);
  const { flatCoords, dim, separatedCoords } = coords;
  
  if (separatedCoords) {
    const { x: xCoords, y: yCoords } = separatedCoords;
    for (let featureIdx = 0; featureIdx < data.length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      
      const polygonStart = geomOffsets[featureIdx];
      const polygonEnd = geomOffsets[featureIdx + 1];
      
      for (let polygonIdx = polygonStart; polygonIdx < polygonEnd; polygonIdx++) {
        stream.polygonStart();
        
        const ringStart = polygonOffsets[polygonIdx];
        const ringEnd = polygonOffsets[polygonIdx + 1];
        
        for (let ringIdx = ringStart; ringIdx < ringEnd; ringIdx++) {
          const coordStart = ringOffsets[ringIdx];
          const coordEnd = ringOffsets[ringIdx + 1];
          if (coordEnd - coordStart < 3) continue;
          
          stream.lineStart();
          for (let i = coordStart; i < coordEnd; i++) {
            stream.point(xCoords[i], yCoords[i]);
          }
          stream.lineEnd();
        }
        stream.polygonEnd();
      }
    }
  } else {
    for (let featureIdx = 0; featureIdx < data.length; featureIdx++) {
      sink.setFeatureId(featureIdOffset + featureIdx);
      
      const polygonStart = geomOffsets[featureIdx];
      const polygonEnd = geomOffsets[featureIdx + 1];
      
      // Each Polygon in the MultiPolygon
      for (let polygonIdx = polygonStart; polygonIdx < polygonEnd; polygonIdx++) {
        stream.polygonStart();
        
        const ringStart = polygonOffsets[polygonIdx];
        const ringEnd = polygonOffsets[polygonIdx + 1];
        
        for (let ringIdx = ringStart; ringIdx < ringEnd; ringIdx++) {
          const coordStart = ringOffsets[ringIdx];
          const coordEnd = ringOffsets[ringIdx + 1];
          
          if (coordEnd - coordStart < 3) continue;
          
          stream.lineStart();
          
          for (let i = coordStart; i < coordEnd; i++) {
            const baseIdx = i * dim;
            stream.point(flatCoords[baseIdx], flatCoords[baseIdx + 1]);
          }
          
          stream.lineEnd();
        }
        
        stream.polygonEnd();
      }
    }
  }
}

/**
 * Geometry type returned by detectGeometryType
 */
export type GeometryTypeString = 'point' | 'multipoint' | 'linestring' | 'polygon' | 'multilinestring' | 'multipolygon' | 'wkb' | 'unknown';

/**
 * Recommended layer type for each geometry
 */
export type LayerType = 'scatterplot' | 'path' | 'solid-polygon';

/**
 * Get the recommended Deck.gl layer type for a geometry
 */
export function getLayerType(geomType: GeometryTypeString): LayerType {
  switch (geomType) {
    case 'point':
    case 'multipoint':
      return 'scatterplot';
    case 'linestring':
    case 'multilinestring':
      return 'path';
    case 'polygon':
    case 'multipolygon':
      return 'solid-polygon';
    default:
      return 'path'; // Default fallback
  }
}
