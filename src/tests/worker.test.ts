/**
 * Tests for off-main-thread parsing (worker-protocol / worker-handler / worker-client)
 *
 * No real Web Worker is spawned (vitest runs in node): the client is bound to
 * the pure message handler through a loopback MockWorker, which exercises the
 * full request/response protocol including the transfer lists.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { tableFromIPC, tableToIPC, Table } from "apache-arrow";
import { geoConicConformal } from "d3-geo";

import {
  parseGeometry,
  parsePolygonsToSolid,
  parsePoints,
} from "../driver.js";
import { packResult, unpackResult } from "../worker-protocol.js";
import { createParseMessageHandler } from "../worker-handler.js";
import {
  createParseWorkerClient,
  type WorkerLike,
} from "../worker-client.js";
import type {
  SimpleProjectionSpec,
  CompositeProjectionSpec,
} from "../projection-spec.js";
import type { BinaryPathData, BinaryPolygonData } from "../types.js";

const PRIMITIVES_DIR = resolve(__dirname, "../../examples/test-data/primitives");

function loadArrowBytes(filename: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(PRIMITIVES_DIR, filename)));
}

function loadArrowTable(filename: string): Table {
  return tableFromIPC(loadArrowBytes(filename));
}

const FRANCE_SPEC: SimpleProjectionSpec = {
  projection: "geoConicConformal",
  rotate: [-3, 0],
  center: [0, 46.5],
  parallels: [44, 49],
  scale: 2800,
  translate: [500, 400],
};

function franceProjection() {
  return geoConicConformal()
    .rotate([-3, 0])
    .center([0, 46.5])
    .parallels([44, 49])
    .scale(2800)
    .translate([500, 400]);
}

// =============================================================================
// PROTOCOL: pack / unpack
// =============================================================================

describe("packResult / unpackResult", () => {
  it("round-trips typed arrays, preserving subarray views", () => {
    const backing = new Uint32Array([1, 2, 3, 4, 5]);
    const input = {
      length: 3,
      positions: new Float32Array([1.5, 2.5]),
      featureIds: backing.subarray(0, 3), // view with shared buffer
      size: 2,
    };

    const { packed, transfer } = packResult(input);
    const output = unpackResult<typeof input>(packed);

    expect(output.length).toBe(3);
    expect(output.size).toBe(2);
    expect(Array.from(output.positions)).toEqual([1.5, 2.5]);
    expect(output.featureIds).toBeInstanceOf(Uint32Array);
    expect(Array.from(output.featureIds)).toEqual([1, 2, 3]);
    expect(transfer).toContain(input.positions.buffer);
    expect(transfer).toContain(backing.buffer);
  });

  it("dedupes shared ArrayBuffers in the transfer list", () => {
    const backing = new Float32Array([1, 2, 3, 4]);
    const input = {
      a: backing.subarray(0, 2),
      b: backing.subarray(2, 4),
    };
    const { transfer } = packResult(input);
    expect(transfer).toHaveLength(1);
  });
});

// =============================================================================
// LOOPBACK WORKER (client <-> handler, no real Worker)
// =============================================================================

type Listener = (event: { data: unknown }) => void;

function createLoopbackWorker(
  handler = createParseMessageHandler(),
): WorkerLike & { terminated: boolean } {
  const listeners = new Map<string, Listener[]>();
  const worker = {
    terminated: false,
    postMessage(message: unknown) {
      // queueMicrotask mimics the async boundary of a real worker
      queueMicrotask(() => {
        const { response } = handler(message as never);
        for (const listener of listeners.get("message") ?? []) {
          listener({ data: response });
        }
      });
    },
    addEventListener(type: string, listener: Listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    terminate() {
      this.terminated = true;
    },
  };
  return worker as WorkerLike & { terminated: boolean };
}

describe("parse worker client ↔ handler", () => {
  it("parseGeometry through the worker equals direct parseGeometry", async () => {
    const client = createParseWorkerClient(createLoopbackWorker());
    const bytes = loadArrowBytes("linestrings.interleaved.arrow");

    const viaWorker = await client.parseGeometry(bytes, FRANCE_SPEC);
    const direct = parseGeometry(loadArrowTable("linestrings.interleaved.arrow"), {
      projection: franceProjection(),
    });

    expect(viaWorker.length).toBe(direct.length);
    expect(Array.from(viaWorker.positions)).toEqual(Array.from(direct.positions));
    expect(Array.from(viaWorker.startIndices)).toEqual(Array.from(direct.startIndices));
    expect(Array.from(viaWorker.featureIds)).toEqual(Array.from(direct.featureIds));
  });

  it("parsePolygonsToSolid through the worker equals direct call (earcut included)", async () => {
    const client = createParseWorkerClient(createLoopbackWorker());
    const bytes = loadArrowBytes("polygons-with-holes.interleaved.arrow");

    const viaWorker = await client.parsePolygonsToSolid(bytes, FRANCE_SPEC);
    const direct = parsePolygonsToSolid(
      loadArrowTable("polygons-with-holes.interleaved.arrow"),
      { projection: franceProjection() },
    );

    expect(viaWorker.length).toBe(direct.length);
    expect(Array.from(viaWorker.positions)).toEqual(Array.from(direct.positions));
    expect(Array.from(viaWorker.polygonIndices)).toEqual(Array.from(direct.polygonIndices));
    expect(Array.from(viaWorker.holeIndices)).toEqual(Array.from(direct.holeIndices));
    expect(Array.from(viaWorker.indices)).toEqual(Array.from(direct.indices));
    expect(Array.from(viaWorker.featureIds)).toEqual(Array.from(direct.featureIds));
  });

  it("parsePoints through the worker equals direct call", async () => {
    const client = createParseWorkerClient(createLoopbackWorker());
    const bytes = loadArrowBytes("points.interleaved.arrow");

    const viaWorker = await client.parsePoints(bytes, FRANCE_SPEC);
    const direct = parsePoints(loadArrowTable("points.interleaved.arrow"), {
      projection: franceProjection(),
    });

    expect(viaWorker.length).toBe(direct.length);
    expect(Array.from(viaWorker.positions)).toEqual(Array.from(direct.positions));
  });

  it("accepts a Table as input (serialized to IPC on the client)", async () => {
    const client = createParseWorkerClient(createLoopbackWorker());
    const table = loadArrowTable("polygons.interleaved.arrow");

    const viaWorker = await client.parseGeometry(table, FRANCE_SPEC);
    const direct = parseGeometry(table, { projection: franceProjection() });

    expect(viaWorker.length).toBe(direct.length);
    expect(Array.from(viaWorker.positions)).toEqual(Array.from(direct.positions));
  });

  it("round-trips WKB tables (DuckDB-wasm path)", async () => {
    const client = createParseWorkerClient(createLoopbackWorker());
    const bytes = loadArrowBytes("polygons.wkb.arrow");

    const viaWorker = await client.parseGeometry(bytes, FRANCE_SPEC);
    expect(viaWorker.length).toBeGreaterThan(0);
    expect(viaWorker.positions.length).toBeGreaterThan(0);
  });

  it("parseSphere works without input data", async () => {
    const client = createParseWorkerClient(createLoopbackWorker());
    const sphere = (await client.parseSphere(FRANCE_SPEC)) as BinaryPathData;
    expect(sphere.positions.length).toBeGreaterThan(0);
  });

  it("supports composite projection specs and insetBorders", async () => {
    const client = createParseWorkerClient(createLoopbackWorker());
    const composite: CompositeProjectionSpec = {
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
        },
      ],
    };

    const solid = (await client.parsePolygonsToSolid(
      loadArrowBytes("polygons.interleaved.arrow"),
      composite,
    )) as BinaryPolygonData;
    expect(solid.positions.length).toBeGreaterThan(0);

    const borders = await client.insetBorders(composite);
    expect(borders.length).toBe(1);
    expect(borders.positions.length).toBe(5 * 2); // one rectangle
  });

  it("reuses the memoized projection across same-spec requests and rebuilds on spec change", async () => {
    const client = createParseWorkerClient(createLoopbackWorker());
    const bytes = loadArrowBytes("linestrings.interleaved.arrow");

    const first = await client.parseGeometry(bytes, FRANCE_SPEC);
    const second = await client.parseGeometry(bytes, { ...FRANCE_SPEC });
    expect(Array.from(second.positions)).toEqual(Array.from(first.positions));

    const shifted = await client.parseGeometry(bytes, {
      ...FRANCE_SPEC,
      scale: 1400,
    });
    expect(Array.from(shifted.positions)).not.toEqual(
      Array.from(first.positions),
    );

    const backToFirst = await client.parseGeometry(bytes, FRANCE_SPEC);
    expect(Array.from(backToFirst.positions)).toEqual(
      Array.from(first.positions),
    );
  });

  it("passes parser options through (rewind)", async () => {
    const client = createParseWorkerClient(createLoopbackWorker());
    const bytes = loadArrowBytes("polygons.interleaved.arrow");

    const viaWorker = await client.parsePolygonsToSolid(bytes, FRANCE_SPEC, {
      rewind: false,
    });
    const direct = parsePolygonsToSolid(loadArrowTable("polygons.interleaved.arrow"), {
      projection: franceProjection(),
      rewind: false,
    });
    expect(Array.from(viaWorker.positions)).toEqual(Array.from(direct.positions));
  });

  it("rejects with the worker-side error message", async () => {
    const client = createParseWorkerClient(createLoopbackWorker());
    await expect(
      client.parseGeometry(loadArrowBytes("polygons.interleaved.arrow"), {
        projection: "geoDoesNotExist",
      }),
    ).rejects.toThrow(/Unknown projection/);
  });

  it("handles concurrent requests on one worker (id matching)", async () => {
    const client = createParseWorkerClient(createLoopbackWorker());
    const [lines, polys] = await Promise.all([
      client.parseGeometry(loadArrowBytes("linestrings.interleaved.arrow"), FRANCE_SPEC),
      client.parsePolygonsToSolid(loadArrowBytes("polygons.interleaved.arrow"), FRANCE_SPEC),
    ]);
    expect(lines.startIndices.length).toBeGreaterThan(0);
    expect(polys.indices.length).toBeGreaterThan(0);
  });

  it("terminate() rejects pending and future requests", async () => {
    const worker = createLoopbackWorker();
    const client = createParseWorkerClient(worker);
    const inflight = client.parseGeometry(
      loadArrowBytes("polygons.interleaved.arrow"),
      FRANCE_SPEC,
    );
    client.terminate();
    await expect(inflight).rejects.toThrow(/terminated/);
    await expect(
      client.parseGeometry(loadArrowBytes("polygons.interleaved.arrow"), FRANCE_SPEC),
    ).rejects.toThrow(/terminated/);
    expect(worker.terminated).toBe(true);
  });

  it("ignores unrelated messages on a shared worker", async () => {
    const handler = createParseMessageHandler();
    const listeners: Listener[] = [];
    const worker: WorkerLike = {
      postMessage(message: unknown) {
        queueMicrotask(() => {
          // Simulate foreign traffic before the real response
          for (const l of listeners) l({ data: { foreign: true } });
          const { response } = handler(message as never);
          for (const l of listeners) l({ data: response });
        });
      },
      addEventListener(type: string, listener: never) {
        if (type === "message") listeners.push(listener as Listener);
      },
    };
    const client = createParseWorkerClient(worker);
    const result = await client.parseGeometry(
      loadArrowBytes("polygons.interleaved.arrow"),
      FRANCE_SPEC,
    );
    expect(result.length).toBeGreaterThan(0);
  });

  it("tableToIPC round-trip preserves GeoArrow extension metadata", () => {
    // Guards the client-side Table→IPC path: extension name must survive
    const table = loadArrowTable("polygons.interleaved.arrow");
    const roundTripped = tableFromIPC(tableToIPC(table));
    const field = roundTripped.schema.fields.find((f) => f.name === "geometry");
    expect(field?.metadata.get("ARROW:extension:name")).toContain("geoarrow");
  });
});
