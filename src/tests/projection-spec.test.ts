/**
 * Tests for the serializable projection spec (projection-spec.ts)
 *
 * Strategy: a resolved spec must project points identically to the same
 * projection configured by hand with d3 method chaining.
 */

import { describe, it, expect } from "vitest";
import {
  geoConicConformal,
  geoMercator,
  geoIdentity,
  geoOrthographic,
  type GeoProjection,
} from "d3-geo";

import {
  resolveProjectionSpec,
  createProjectionRegistry,
  defaultProjectionRegistry,
  type SimpleProjectionSpec,
  type CompositeProjectionSpec,
} from "../projection-spec.js";
import { buildCompositeProjection } from "../composite-projection.js";

const SAMPLE_POINTS: [number, number][] = [
  [2.35, 48.85], // Paris
  [-4.5, 48.4], // Brest
  [9.2, 41.9], // Corsica
  [55.5, -21.1], // Réunion
];

function expectSameProjection(
  resolved: ReturnType<typeof resolveProjectionSpec>,
  manual: { (c: [number, number]): [number, number] | null },
  points: [number, number][] = SAMPLE_POINTS,
) {
  for (const pt of points) {
    const a = (resolved as (c: [number, number]) => [number, number] | null)(pt);
    const b = manual(pt);
    if (a === null || b === null) {
      expect(a).toEqual(b);
    } else {
      expect(a[0]).toBeCloseTo(b[0], 6);
      expect(a[1]).toBeCloseTo(b[1], 6);
    }
  }
}

describe("resolveProjectionSpec — simple specs", () => {
  it("resolves a fully parameterized conic projection (France Lambert style)", () => {
    const spec: SimpleProjectionSpec = {
      projection: "geoConicConformal",
      rotate: [-3, 0],
      center: [0, 46.5],
      parallels: [44, 49],
      scale: 2800,
      translate: [500, 400],
    };
    const manual = geoConicConformal()
      .rotate([-3, 0])
      .center([0, 46.5])
      .parallels([44, 49])
      .scale(2800)
      .translate([500, 400]);

    expectSameProjection(resolveProjectionSpec(spec), manual);
  });

  it("applies precision", () => {
    const resolved = resolveProjectionSpec({
      projection: "geoMercator",
      precision: 0,
    }) as GeoProjection;
    expect(resolved.precision()).toBe(0);
  });

  it("supports fitExtent against a bbox", () => {
    const extent: [[number, number], [number, number]] = [
      [10, 20],
      [960, 600],
    ];
    const bbox: [number, number, number, number] = [-5.5, 41, 10, 51.5];
    const resolved = resolveProjectionSpec({
      projection: "geoConicConformal",
      parallels: [44, 49],
      rotate: [-3, 0],
      fitExtent: { extent, bbox },
    });

    const manual = geoConicConformal()
      .parallels([44, 49])
      .rotate([-3, 0])
      .fitExtent(extent, {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-5.5, 41],
              [-5.5, 51.5],
              [10, 51.5],
              [10, 41],
              [-5.5, 41],
            ],
          ],
        },
      });

    expectSameProjection(resolved, manual);
  });

  it("supports fitSize as shorthand", () => {
    const resolved = resolveProjectionSpec({
      projection: "geoMercator",
      fitSize: { size: [800, 500], bbox: [-10, 35, 30, 60] },
    }) as GeoProjection;
    const viaExtent = resolveProjectionSpec({
      projection: "geoMercator",
      fitExtent: { extent: [[0, 0], [800, 500]], bbox: [-10, 35, 30, 60] },
    }) as GeoProjection;
    expect(resolved.scale()).toBeCloseTo(viaExtent.scale(), 6);
    expect(resolved.translate()[0]).toBeCloseTo(viaExtent.translate()[0], 6);
    expect(resolved.translate()[1]).toBeCloseTo(viaExtent.translate()[1], 6);
  });

  it("applies clipExtent AFTER fitExtent so it is not cleared", () => {
    const clip: [[number, number], [number, number]] = [
      [0, 0],
      [400, 300],
    ];
    const resolved = resolveProjectionSpec({
      projection: "geoMercator",
      fitExtent: { extent: [[0, 0], [960, 600]], bbox: [-10, 35, 30, 60] },
      clipExtent: clip,
    }) as GeoProjection;
    expect(resolved.clipExtent()).toEqual(clip);
  });

  it("resolves geoIdentity with reflectY (pass-through projected data)", () => {
    const resolved = resolveProjectionSpec({
      projection: "geoIdentity",
      reflectY: true,
      scale: 2,
      translate: [10, 20],
    });
    const manual = (geoIdentity() as unknown as GeoProjection)
      .reflectY(true)
      .scale(2)
      .translate([10, 20]);
    expectSameProjection(resolved, manual as unknown as (c: [number, number]) => [number, number]);
  });

  it("resolves clipAngle (hemisphere)", () => {
    const resolved = resolveProjectionSpec({
      projection: "geoOrthographic",
      rotate: [-10, -40],
      clipAngle: 90,
    });
    const manual = geoOrthographic().rotate([-10, -40]).clipAngle(90);
    expectSameProjection(resolved, manual, [
      [2, 48],
      [150, -30], // far side → null
    ]);
  });

  it("throws a clear error for an unknown projection name", () => {
    expect(() =>
      resolveProjectionSpec({ projection: "geoDoesNotExist" }),
    ).toThrow(/Unknown projection "geoDoesNotExist"/);
  });

  it("throws when a spec field is unsupported by the projection", () => {
    expect(() =>
      resolveProjectionSpec({ projection: "geoMercator", parallels: [44, 49] }),
    ).toThrow(/does not support \.parallels\(\)/);
  });

  it("throws when the registry entry is not a projection factory", () => {
    const registry = createProjectionRegistry(defaultProjectionRegistry, {
      notAProjection: (() => 42) as never,
    });
    expect(() =>
      resolveProjectionSpec({ projection: "notAProjection" }, registry),
    ).toThrow(/missing \.stream\(\)/);
  });
});

describe("resolveProjectionSpec — registry extension", () => {
  it("accepts custom factories under custom ids", () => {
    const registry = createProjectionRegistry(defaultProjectionRegistry, {
      franceLambert: () =>
        geoConicConformal().rotate([-3, 0]).center([0, 46.5]).parallels([44, 49]),
    });
    const resolved = resolveProjectionSpec(
      { projection: "franceLambert", scale: 2800, translate: [500, 400] },
      registry,
    );
    const manual = geoConicConformal()
      .rotate([-3, 0])
      .center([0, 46.5])
      .parallels([44, 49])
      .scale(2800)
      .translate([500, 400]);
    expectSameProjection(resolved, manual);
  });

  it("merges module namespaces (function exports only)", () => {
    const fakeModule = {
      geoFake: () => geoMercator(),
      SOME_CONSTANT: 42,
    };
    const registry = createProjectionRegistry(fakeModule);
    expect(registry.geoFake).toBeTypeOf("function");
    expect("SOME_CONSTANT" in registry).toBe(false);
  });
});

describe("resolveProjectionSpec — composite specs", () => {
  const spec: CompositeProjectionSpec = {
    type: "composite",
    width: 960,
    height: 600,
    entries: [
      {
        id: "mainland",
        projection: {
          projection: "geoConicConformal",
          parallels: [44, 49],
          rotate: [-3, 0],
        },
        bounds: [-5.5, 41, 10, 51.5],
        layout: { x: 0.2, y: 0, width: 0.8, height: 1 },
      },
      {
        id: "reunion",
        projection: { projection: "geoMercator" },
        bounds: [55.2, -21.5, 55.9, -20.8],
        layout: { x: 0, y: 0, width: 0.18, height: 0.2 },
        scaleMultiplier: 1.5,
      },
    ],
  };

  it("matches buildCompositeProjection with identical config", () => {
    const resolved = resolveProjectionSpec(spec);
    const manual = buildCompositeProjection({
      width: 960,
      height: 600,
      entries: [
        {
          id: "mainland",
          projection: geoConicConformal().parallels([44, 49]).rotate([-3, 0]),
          bounds: [-5.5, 41, 10, 51.5],
          layout: { x: 0.2, y: 0, width: 0.8, height: 1 },
        },
        {
          id: "reunion",
          projection: geoMercator(),
          bounds: [55.2, -21.5, 55.9, -20.8],
          layout: { x: 0, y: 0, width: 0.18, height: 0.2 },
          scaleMultiplier: 1.5,
        },
      ],
    });
    expectSameProjection(resolved, manual);
  });

  it("exposes inset borders through the resolved composite", () => {
    const resolved = resolveProjectionSpec(spec);
    const borders = (
      resolved as ReturnType<typeof buildCompositeProjection>
    ).getInsetBorders();
    expect(borders).toHaveLength(1);
    expect(borders[0].id).toBe("reunion");
  });
});
