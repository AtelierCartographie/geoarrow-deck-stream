/**
 * BinarySink - Custom D3 GeoStream Implementation
 * 
 * This is the heart of the zero-serialization pipeline.
 * It implements the d3.geoStream interface but writes directly to TypedArrays
 * instead of generating SVG paths or GeoJSON.
 * 
 * Key responsibilities:
 * - Receive projected coordinates from D3 stream
 * - Write to growable Float32Array buffers
 * - Track path boundaries for Deck.gl startIndices
 * - Map output paths back to input feature IDs (critical for split geometries)
 */

import type { BinarySink as IBinarySink, BinaryPolygonSink, SinkState, BinaryPathData, BinaryPolygonData, SinkDebugInfo } from './types.js';
import { GrowableBuffer } from './buffers.js';
import earcut from 'earcut';

/**
 * Configuration for BinarySink
 */
export interface BinarySinkConfig {
  /** Initial capacity for coordinates (number of points) */
  initialCoordCapacity?: number;
  
  /** Initial capacity for paths */
  initialPathCapacity?: number;
  
  /** Minimum points required to emit a path (filter degenerate geometry) */
  minPointsPerPath?: number;

  /** Capture debug counters and coordinate samples. */
  debug?: boolean;

  /** Limit of coordinate samples stored when debug is enabled. */
  debugSampleLimit?: number;
}

const DEFAULT_CONFIG: Required<BinarySinkConfig> = {
  initialCoordCapacity: 8192,
  initialPathCapacity: 512,
  minPointsPerPath: 2, // LineStrings need at least 2 points
  debug: false,
  debugSampleLimit: 20
};


/**
 * Creates a new BinarySink instance.
 * 
 * This sink collects projected coordinates from D3's stream API and writes
 * them directly to TypedArrays suitable for Deck.gl consumption.
 */
export function createBinarySink(config: BinarySinkConfig = {}): IBinarySink {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  
  let positions = new GrowableBuffer(Float32Array, cfg.initialCoordCapacity * 2) as any;
  let startIndices = new GrowableBuffer(Uint32Array, cfg.initialPathCapacity) as any;
  let featureIds = new GrowableBuffer(Uint32Array, cfg.initialPathCapacity) as any;
  const debugSample: number[] = [];
  let degeneratePaths = 0;
  let invalidPoints = 0;
  let pointsReceived = 0;
  let pointsStored = 0;
  
  // Internal state
  const state: SinkState = {
    positionIndex: 0,
    pathCount: 0,
    currentFeatureId: 0,
    inLine: false,
    lineStartPosition: 0,
    pointsInLine: 0
  };

  /**
   * Called for each projected point.
   * D3 handles the projection math; we just store the result.
   */
  function point(x: number, y: number): void {
    pointsReceived++;
    // Skip invalid coordinates (projection returned null/undefined for out-of-bounds)
    // D3 projections return null for points outside the projection bounds
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
      invalidPoints++;
      return;
    }
    
    // Write coordinates as float32
    positions.push2(x, y);
    state.positionIndex += 2;
    state.pointsInLine++;
    pointsStored++;

    if (cfg.debug && debugSample.length < cfg.debugSampleLimit * 2) {
      debugSample.push(x, y);
    }
  }

  /**
   * Called when starting a new line segment.
   * A single input geometry can produce multiple lineStart/lineEnd pairs
   * due to clipping at projection boundaries (e.g., antimeridian).
   */
  function lineStart(): void {
    state.inLine = true;
    state.lineStartPosition = state.positionIndex;
    state.pointsInLine = 0;
  }

  /**
   * Called when ending a line segment.
   * This is where we record the path if it has enough points.
   */
  function lineEnd(): void {
    state.inLine = false;
    
    // Only emit path if it has minimum required points
    if (state.pointsInLine >= cfg.minPointsPerPath) {
      // Record start index (in terms of coordinate pairs, not float count)
      startIndices.push(state.lineStartPosition / 2);
      
      // Map this output path back to the original Arrow feature
      featureIds.push(state.currentFeatureId);
      
      state.pathCount++;
    } else if (state.pointsInLine > 0) {
      // Degenerate path (single point) - remove from positions buffer
      // This happens when a line crosses projection boundaries and only
      // a tiny fragment is visible
      positions.reset();
      // Rebuild to the lineStartPosition
      const tempLength = state.lineStartPosition;
      positions = rebuildToLength(positions as GrowableBuffer<Float32Array>, tempLength) as any;
      state.positionIndex = state.lineStartPosition;
      degeneratePaths++;
    }
  }

  /**
   * Called when starting a polygon.
   * For now, we treat polygon rings as lines (PathLayer).
   * Full polygon support would need hole tracking for SolidPolygonLayer.
   */
  function polygonStart(): void {
    // Polygons are composed of rings, each ring is a closed line
    // The first ring is the exterior, subsequent rings are holes
    // For PathLayer rendering, we just treat each ring as a separate path
  }

  /**
   * Called when ending a polygon.
   */
  function polygonEnd(): void {
    // No special handling needed for PathLayer rendering
  }

  /**
   * Set the current feature ID.
   * Called by the driver before streaming each Arrow row.
   */
  function setFeatureId(id: number): void {
    state.currentFeatureId = id;
  }

  /**
   * Get current state (for debugging)
   */
  function getState(): Readonly<SinkState> {
    return { ...state };
  }

  /** Get debug counters and sample coordinates. */
  function getDebugInfo(): SinkDebugInfo {
    return {
      pointsReceived,
      pointsStored,
      invalidPoints,
      degeneratePaths,
      linesEmitted: state.pathCount,
      sample: [...debugSample]
    };
  }

  /**
   * Get raw buffers (with unused capacity)
   */
  function getBuffers() {
    return {
      positions: positions.raw as any as Float32Array,
      startIndices: startIndices.raw as any as Uint32Array,
      featureIds: featureIds.raw as any as Uint32Array
    };
  }

  /**
   * Finalize and return trimmed arrays ready for Deck.gl
   */
  function finalize(): BinaryPathData {
    // Add sentinel value for last path end (required by Deck.gl)
    // This allows Deck to compute the length of the last path
    startIndices.push(state.positionIndex / 2);
    
    return {
      length: state.pathCount,
      positions: positions.toArray() as any as Float32Array,
      startIndices: startIndices.toArray() as any as Uint32Array,
      featureIds: (featureIds.toArray() as any as Uint32Array).subarray(0, state.pathCount),
      size: 2
    };
  }

  /**
   * Reset sink for reuse
   */
  function reset(): void {
    positions.reset();
    startIndices.reset();
    featureIds.reset();
    
    state.positionIndex = 0;
    state.pathCount = 0;
    state.currentFeatureId = 0;
    state.inLine = false;
    state.lineStartPosition = 0;
    state.pointsInLine = 0;
  }

  // Return the sink object implementing GeoStream + our extensions
  return {
    point,
    lineStart,
    lineEnd,
    polygonStart,
    polygonEnd,
    setFeatureId,
    getState,
    getDebugInfo,
    getBuffers,
    finalize,
    reset
  };
}

/**
 * Helper to rebuild a buffer to a specific length
 * Used when removing degenerate paths
 */
function rebuildToLength(
  buffer: GrowableBuffer<Float32Array>, 
  targetLength: number
): GrowableBuffer<Float32Array> {
  const newBuffer = new GrowableBuffer(Float32Array, buffer.capacity) as any;
  const source = buffer.raw;
  for (let i = 0; i < targetLength; i++) {
    newBuffer.push(source[i]);
  }
  return newBuffer;
}


// Helper for signed area (Shoelace formula)
function signedArea(data: Float32Array, start: number, end: number): number {
  let area = 0;
  for (let i = start, j = end - 1; i < end; j = i++) {
    area += (data[i * 2] - data[j * 2]) * (data[i * 2 + 1] + data[j * 2 + 1]);
  }
  return area * 0.5;
}

/** A ring range in the positions buffer (point indices) with its signed area. */
type ClassifiedRing = { start: number; end: number; area: number };

/** One output polygon: an exterior ring and the holes it contains. */
type PolygonGroup = { exterior: ClassifiedRing; holes: ClassifiedRing[] };

// Ray-casting point-in-ring test on the projected (planar) coordinates.
function pointInRing(
  data: Float32Array,
  start: number,
  end: number,
  x: number,
  y: number
): boolean {
  let inside = false;
  for (let i = start, j = end - 1; i < end; j = i++) {
    const xi = data[i * 2];
    const yi = data[i * 2 + 1];
    const xj = data[j * 2];
    const yj = data[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Find the polygon group whose exterior contains the hole.
 *
 * Clip cut points lie exactly on exterior boundaries, where ray casting is
 * unreliable, so several sample vertices of the hole are tried until one
 * lands strictly inside an exterior. When exteriors are nested the smallest
 * containing one wins. Returns null for holes no exterior contains
 * (clipped-away artifacts).
 */
function findContainingGroup(
  groups: PolygonGroup[],
  data: Float32Array,
  hole: ClassifiedRing
): PolygonGroup | null {
  const pointCount = hole.end - hole.start;
  const samples = [
    hole.start,
    hole.start + (pointCount >> 1),
    hole.start + (pointCount >> 2)
  ];
  for (const sample of new Set(samples)) {
    const x = data[sample * 2];
    const y = data[sample * 2 + 1];
    let best: PolygonGroup | null = null;
    for (const group of groups) {
      const exterior = group.exterior;
      if (!pointInRing(data, exterior.start, exterior.end, x, y)) continue;
      if (!best || Math.abs(exterior.area) < Math.abs(best.exterior.area)) {
        best = group;
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Extended sink for polygon support (future use)
 * Tracks rings and holes for SolidPolygonLayer compatibility
 */
export interface PolygonSinkState extends SinkState {
  inPolygon: boolean;
  ringIndex: number;
  polygonStartPathIndex: number;
}

/**
 * Creates a polygon-specific sink that tracks polygon and ring boundaries
 * 
 * This sink collects projected coordinates and maintains the structure needed
 * for Deck.gl's SolidPolygonLayer binary format with holes support.
 */
export function createPolygonSink(config: BinarySinkConfig = {}): BinaryPolygonSink {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  cfg.minPointsPerPath = 3; // Polygons need at least 3 points
  
  let positions = new GrowableBuffer(Float32Array, cfg.initialCoordCapacity * 2) as any;
  let polygonIndices = new GrowableBuffer(Uint32Array, cfg.initialPathCapacity) as any;
  let holeIndices = new GrowableBuffer(Uint32Array, cfg.initialPathCapacity * 4) as any; // More rings than polygons
  let featureIds = new GrowableBuffer(Uint32Array, cfg.initialPathCapacity) as any;
  // Buffer for triangle indices (Uint32Array to support large vertex counts)
  let triangleIndices = new GrowableBuffer(Uint32Array, cfg.initialCoordCapacity * 3) as any;
  
  const debugSample: number[] = [];
  let degeneratePaths = 0;
  let invalidPoints = 0;
  let pointsReceived = 0;
  let pointsStored = 0;
  
  // Internal state
  let currentFeatureId = 0;
  let positionIndex = 0;
  let polygonCount = 0;
  let inPolygon = false;
  let inRing = false;
  let ringStartPosition = 0;
  let bundleStartPosition = 0;
  let pointsInRing = 0;
  
  // Track rings for the current polygon being processed
  let currentRings: { start: number; end: number }[] = [];
  
  function point(x: number, y: number): void {
    pointsReceived++;
    
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
      invalidPoints++;
      return;
    }
    
    positions.push2(x, y);
    positionIndex += 2;
    pointsInRing++;
    pointsStored++;
    
    if (cfg.debug && debugSample.length < cfg.debugSampleLimit * 2) {
      debugSample.push(x, y);
    }
  }
  
  function lineStart(): void {
    // In polygon context, lineStart marks the beginning of a ring
    if (!inRing) {
      inRing = true;
      ringStartPosition = positionIndex / 2;
      pointsInRing = 0;
    }
  }
  
  function lineEnd(): void {
    if (!inRing) return;
    
    // Filter degenerate rings (< 3 points)
    if (pointsInRing < cfg.minPointsPerPath) {
      // Rewind positions
      positionIndex = ringStartPosition * 2;
      positions.length = positionIndex;
      degeneratePaths++;
    } else {
        // Valid ring. Add to current list.
        currentRings.push({
          start: ringStartPosition,
          end: positionIndex / 2
        });
    }
    
    inRing = false;
  }
  
  function polygonStart(): void {
    inPolygon = true;
    currentRings = [];
    bundleStartPosition = positionIndex;
  }

  function polygonEnd(): void {
    if (!inPolygon) return;
    inPolygon = false;

    if (currentRings.length === 0) return;

    const positionsArr = positions.raw as Float32Array;

    const rings: ClassifiedRing[] = currentRings.map((ring) => ({
      start: ring.start,
      end: ring.end,
      area: signedArea(positionsArr, ring.start, ring.end)
    }));

    // D3's clip stage emits rejoined (cut) rings after untouched ones, so the
    // first ring of a clipped polygon can be a hole or a degenerate sliver —
    // "first ring = exterior" does NOT hold here. The exterior winding sign is
    // taken from the net signed area of the whole bundle instead: exterior
    // rings always outweigh the holes they contain.
    let netArea = 0;
    for (const ring of rings) netArea += ring.area;
    const refSign = Math.sign(netArea);

    const exteriors: ClassifiedRing[] = [];
    const holes: ClassifiedRing[] = [];
    if (refSign !== 0) {
      for (const ring of rings) {
        if (ring.area === 0) continue; // degenerate clip sliver
        (Math.sign(ring.area) === refSign ? exteriors : holes).push(ring);
      }
    }

    if (exteriors.length === 0) {
      // Nothing fillable — drop the bundle's coordinates entirely.
      positionIndex = bundleStartPosition;
      positions.length = bundleStartPosition;
      return;
    }

    const groups: PolygonGroup[] = exteriors.map((exterior) => ({
      exterior,
      holes: []
    }));
    for (const hole of holes) {
      // A hole no exterior contains is a clip artifact and is dropped.
      findContainingGroup(groups, positionsArr, hole)?.holes.push(hole);
    }

    const ordered: ClassifiedRing[] = [];
    for (const group of groups) {
      ordered.push(group.exterior, ...group.holes);
    }

    // Earcut and the binary layout need each polygon's rings contiguous as
    // [exterior, holes...]. When the emission order differs (or rings were
    // dropped), rewrite the bundle's slice of the positions buffer in
    // canonical order; otherwise keep the zero-copy fast path.
    const isCanonical =
      ordered.length === rings.length &&
      ordered.every((ring, i) => ring.start === rings[i].start);
    if (!isCanonical) {
      const snapshot = positionsArr.slice(bundleStartPosition, positionIndex);
      let write = bundleStartPosition;
      for (const ring of ordered) {
        const floatLength = (ring.end - ring.start) * 2;
        const srcOffset = ring.start * 2 - bundleStartPosition;
        positionsArr.set(
          snapshot.subarray(srcOffset, srcOffset + floatLength),
          write
        );
        ring.start = write / 2;
        ring.end = ring.start + floatLength / 2;
        write += floatLength;
      }
      positionIndex = write;
      positions.length = write;
    }

    for (const group of groups) {
      const polyStart = group.exterior.start;
      const lastRing =
        group.holes.length > 0
          ? group.holes[group.holes.length - 1]
          : group.exterior;

      polygonIndices.push(polyStart);
      featureIds.push(currentFeatureId);
      polygonCount++;

      holeIndices.push(group.exterior.start);
      const holeOffsets: number[] = [];
      for (const hole of group.holes) {
        holeIndices.push(hole.start);
        holeOffsets.push(hole.start - polyStart);
      }

      const polyCoords = positionsArr.subarray(polyStart * 2, lastRing.end * 2);
      const triangles = earcut(polyCoords, holeOffsets, 2);
      for (let i = 0; i < triangles.length; i++) {
        triangleIndices.push(triangles[i] + polyStart);
      }
    }
  }
  
  function setFeatureId(id: number): void {
    currentFeatureId = id;
  }
  
  function getDebugInfo(): SinkDebugInfo {
    return {
      pointsReceived,
      pointsStored,
      invalidPoints,
      degeneratePaths,
      linesEmitted: polygonCount,
      sample: debugSample.slice(0, cfg.debugSampleLimit * 2)
    };
  }
  
  function finalize(): BinaryPolygonData {
    // If no polygons were emitted, return empty but valid structure
    if (polygonCount === 0) {
      return {
        length: 0,
        positions: new Float32Array(),
        polygonIndices: new Uint32Array([0]),  // Sentinel
        holeIndices: new Uint32Array([0]),     // Sentinel
        featureIds: new Uint32Array(),
        indices: new Uint32Array(),
        size: 2
      };
    }
    
    // Ensure holeIndices has at least one entry (the start of the first ring)
    if (holeIndices.length === 0) {
      holeIndices.push(0); // First ring starts at index 0
    }
    
    // Add final index for length calculation
    polygonIndices.push(positionIndex / 2);
    holeIndices.push(positionIndex / 2); // Final hole boundary
    
    return {
      length: polygonCount,
      positions: positions.toArray() as any as Float32Array,
      polygonIndices: polygonIndices.toArray() as any as Uint32Array,
      holeIndices: holeIndices.toArray() as any as Uint32Array,
      featureIds: (featureIds.toArray() as any as Uint32Array).subarray(0, polygonCount),
      indices: triangleIndices.toArray() as any as Uint32Array,
      size: 2
    };
  }
  
  function reset(): void {
    positions.reset();
    polygonIndices.reset();
    holeIndices.reset();
    featureIds.reset();
    triangleIndices.reset();
    
    currentFeatureId = 0;
    positionIndex = 0;
    polygonCount = 0;
    inPolygon = false;
    inRing = false;
    ringStartPosition = 0;
    bundleStartPosition = 0;
    pointsInRing = 0;
    currentRings = [];
  }
  
  return {
    point,
    lineStart,
    lineEnd,
    polygonStart,
    polygonEnd,
    setFeatureId,
    getDebugInfo,
    finalize,
    reset
  };
}

// Export type for external use
export type { IBinarySink as BinarySinkInterface };
