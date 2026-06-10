/**
 * Regression tests for ring classification in createPolygonSink.
 *
 * D3's clip stage (antimeridian / clip circle) emits rejoined rings AFTER
 * untouched ones and can emit degenerate slivers, so a clipped polygon's
 * first ring is not necessarily its exterior. The sink used to assume
 * "first ring = exterior" and take the reference winding sign from it,
 * which made entire countries (Russia, India, France…) disappear whenever
 * the projection edge cut through a polygon that has holes or produces
 * slivers. See the d3-integration tests at the bottom for the real-world
 * shape of the bug.
 */

import { describe, it, expect } from "vitest";
import { geoEqualEarth, type GeoStream } from "d3-geo";
import { createPolygonSink } from "../sink.js";
import { createRewindStream } from "../rewind.js";
import type { BinaryPolygonData, BinaryPolygonSink } from "../types.js";

type Ring = [number, number][];

function streamBundle(stream: GeoStream, rings: Ring[]): void {
  stream.polygonStart();
  for (const ring of rings) {
    stream.lineStart();
    for (const [x, y] of ring) stream.point(x, y);
    stream.lineEnd();
  }
  stream.polygonEnd();
}

function totalTriangleArea(data: BinaryPolygonData): number {
  const { positions, indices } = data;
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const ax = positions[a * 2];
    const ay = positions[a * 2 + 1];
    area +=
      Math.abs(
        (positions[b * 2] - ax) * (positions[c * 2 + 1] - ay) -
          (positions[c * 2] - ax) * (positions[b * 2 + 1] - ay),
      ) / 2;
  }
  return area;
}

/** |Σ signed ring areas| over every ring — the fill area the data describes. */
function netRingArea(data: BinaryPolygonData): number {
  const { positions, holeIndices } = data;
  let net = 0;
  for (let r = 0; r < holeIndices.length - 1; r++) {
    const start = holeIndices[r];
    const end = holeIndices[r + 1];
    let ringArea = 0;
    for (let i = start, j = end - 1; i < end; j = i++) {
      ringArea +=
        (positions[i * 2] - positions[j * 2]) *
        (positions[i * 2 + 1] + positions[j * 2 + 1]);
    }
    net += ringArea / 2;
  }
  return Math.abs(net);
}

// CCW (in y-up coordinates) gives a negative sign with the sink's shoelace
// convention — matching what d3 emits for exteriors in projected space.
function ccwSquare(cx: number, cy: number, r: number): Ring {
  return [
    [cx - r, cy - r],
    [cx + r, cy - r],
    [cx + r, cy + r],
    [cx - r, cy + r],
  ];
}

function cwSquare(cx: number, cy: number, r: number): Ring {
  return [...ccwSquare(cx, cy, r)].reverse();
}

describe("createPolygonSink - ring classification after clipping", () => {
  it("keeps the classic [exterior, holes...] emission order on the zero-copy path", () => {
    const sink: BinaryPolygonSink = createPolygonSink();
    sink.setFeatureId(7);
    streamBundle(sink as unknown as GeoStream, [
      ccwSquare(0, 0, 10),
      cwSquare(0, 0, 2),
    ]);
    const data = sink.finalize();

    expect(data.length).toBe(1);
    expect(Array.from(data.featureIds)).toEqual([7]);
    expect(Array.from(data.polygonIndices)).toEqual([0, 8]);
    expect(Array.from(data.holeIndices)).toEqual([0, 4, 8]);
    expect(totalTriangleArea(data)).toBeCloseTo(400 - 16, 3);
    // zero-copy: the buffer layout is exactly the emission order
    expect(data.positions[0]).toBe(-10);
    expect(data.positions[1]).toBe(-10);
  });

  it("classifies the exterior correctly when a hole is emitted first", () => {
    const sink = createPolygonSink();
    sink.setFeatureId(0);
    streamBundle(sink as unknown as GeoStream, [
      cwSquare(0, 0, 2), // hole arrives first (d3 emits untouched rings first)
      ccwSquare(0, 0, 10),
    ]);
    const data = sink.finalize();

    expect(data.length).toBe(1);
    expect(Array.from(data.polygonIndices)).toEqual([0, 8]);
    expect(Array.from(data.holeIndices)).toEqual([0, 4, 8]);
    expect(totalTriangleArea(data)).toBeCloseTo(400 - 16, 3);
    // the buffer was rewritten so the exterior comes first
    expect(data.positions[0]).toBe(-10);
    expect(data.positions[1]).toBe(-10);
  });

  it("attaches each hole to the exterior that contains it when the exterior was split", () => {
    const sink = createPolygonSink();
    sink.setFeatureId(4);
    streamBundle(sink as unknown as GeoStream, [
      cwSquare(-20, 0, 2), // hole of piece 1, emitted before any exterior
      ccwSquare(-20, 0, 10), // exterior piece 1
      ccwSquare(20, 0, 10), // exterior piece 2
    ]);
    const data = sink.finalize();

    expect(data.length).toBe(2);
    expect(Array.from(data.featureIds)).toEqual([4, 4]);
    // piece 1 [0..4) + its hole [4..8), piece 2 [8..12)
    expect(Array.from(data.polygonIndices)).toEqual([0, 8, 12]);
    expect(Array.from(data.holeIndices)).toEqual([0, 4, 8, 12]);
    expect(totalTriangleArea(data)).toBeCloseTo(400 - 16 + 400, 3);
  });

  it("survives a zero-area sliver emitted first (refSign used to become 0)", () => {
    const sink = createPolygonSink();
    sink.setFeatureId(0);
    streamBundle(sink as unknown as GeoStream, [
      [
        [0, 0],
        [5, 0],
        [10, 0],
        [5, 0],
      ], // collinear → exactly zero area
      ccwSquare(0, 0, 10),
    ]);
    const data = sink.finalize();

    expect(data.length).toBe(1);
    expect(totalTriangleArea(data)).toBeCloseTo(400, 3);
    // the sliver's coordinates were compacted away
    expect(data.positions.length).toBe(8);
    expect(Array.from(data.polygonIndices)).toEqual([0, 4]);
  });

  it("drops a hole no exterior contains (clip artifact)", () => {
    const sink = createPolygonSink();
    sink.setFeatureId(0);
    streamBundle(sink as unknown as GeoStream, [
      ccwSquare(0, 0, 10),
      cwSquare(50, 50, 2), // outside the exterior
    ]);
    const data = sink.finalize();

    expect(data.length).toBe(1);
    expect(totalTriangleArea(data)).toBeCloseTo(400, 3);
    expect(data.positions.length).toBe(8);
    expect(Array.from(data.holeIndices)).toEqual([0, 4]);
  });

  it("drops a fully degenerate bundle", () => {
    const sink = createPolygonSink();
    sink.setFeatureId(0);
    streamBundle(sink as unknown as GeoStream, [
      [
        [0, 0],
        [5, 0],
        [10, 0],
        [5, 0],
      ],
    ]);
    const data = sink.finalize();

    expect(data.length).toBe(0);
    expect(data.positions.length).toBe(0);
  });

  it("is winding-convention agnostic (CW exteriors, CCW holes)", () => {
    const sink = createPolygonSink();
    sink.setFeatureId(0);
    streamBundle(sink as unknown as GeoStream, [
      ccwSquare(0, 0, 2), // hole first, opposite global convention
      cwSquare(0, 0, 10),
    ]);
    const data = sink.finalize();

    expect(data.length).toBe(1);
    expect(totalTriangleArea(data)).toBeCloseTo(400 - 16, 3);
  });

  it("keeps bundles independent across successive polygons", () => {
    const sink = createPolygonSink();
    sink.setFeatureId(1);
    streamBundle(sink as unknown as GeoStream, [ccwSquare(-40, 0, 10)]);
    sink.setFeatureId(2);
    streamBundle(sink as unknown as GeoStream, [
      cwSquare(40, 0, 2),
      ccwSquare(40, 0, 10),
    ]);
    const data = sink.finalize();

    expect(data.length).toBe(2);
    expect(Array.from(data.featureIds)).toEqual([1, 2]);
    expect(Array.from(data.polygonIndices)).toEqual([0, 4, 12]);
    expect(totalTriangleArea(data)).toBeCloseTo(400 + 400 - 16, 3);
  });
});

describe("createPolygonSink through d3 projection clipping", () => {
  function parseThroughProjection(
    rings: Ring[],
    projection = geoEqualEarth(),
    featureId = 3,
  ): BinaryPolygonData {
    const sink = createPolygonSink();
    sink.setFeatureId(featureId);
    const projected = projection.stream(sink as unknown as GeoStream);
    const stream = createRewindStream(true).stream(projected);
    streamBundle(stream, rings);
    return sink.finalize();
  }

  it("renders a polygon with a hole split by the antimeridian (vanished-country regression)", () => {
    // Exterior crosses the antimeridian; the hole does not, so d3 emits the
    // hole before the rejoined exterior pieces.
    const exterior: Ring = [
      [150, -20],
      [-150, -20],
      [-150, 20],
      [150, 20],
    ];
    const hole: Ring = [
      [160, -5],
      [170, -5],
      [170, 5],
      [160, 5],
    ];
    const data = parseThroughProjection([exterior, hole]);

    expect(data.length).toBeGreaterThanOrEqual(2); // split by the cut
    expect(Array.from(new Set(data.featureIds))).toEqual([3]);
    const net = netRingArea(data);
    expect(net).toBeGreaterThan(1000); // world-scale polygon, not collapsed
    const filled = totalTriangleArea(data);
    expect(filled).toBeGreaterThan(0.9 * net);
    expect(filled).toBeLessThan(1.1 * net);
  });

  it("renders an untouched polygon with a hole identically (sanity)", () => {
    const exterior: Ring = [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
    ];
    const hole: Ring = [
      [13, 13],
      [17, 13],
      [17, 17],
      [13, 17],
    ];
    const data = parseThroughProjection([exterior, hole]);

    expect(data.length).toBe(1);
    const net = netRingArea(data);
    expect(net).toBeGreaterThan(10);
    const filled = totalTriangleArea(data);
    expect(filled).toBeGreaterThan(0.9 * net);
    expect(filled).toBeLessThan(1.1 * net);
  });
});
