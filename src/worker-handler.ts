/**
 * Worker Handler - runs INSIDE a Web Worker
 *
 * Executes the full parse pipeline (Arrow IPC decode → d3 projection stream →
 * binary sink → earcut triangulation) off the main thread, and returns the
 * Deck.gl-ready TypedArrays as transferables (zero-copy).
 *
 * Two ways to use it:
 *
 * 1. Default worker (d3-geo projections only) — nothing to write, point a
 *    Worker at the shipped entry:
 *    `@ateliercartographie/geoarrow-deck-stream/parse-worker`
 *
 * 2. Custom worker (exotic projections, d3-geo-projection, d3-geo-polygon,
 *    custom factories) — a 5-line worker file in the host app:
 *
 * ```typescript
 * // parse.worker.ts
 * import * as d3GeoProjection from 'd3-geo-projection';
 * import { setupParseWorker, createProjectionRegistry } from '@ateliercartographie/geoarrow-deck-stream/worker';
 *
 * setupParseWorker({ projections: createProjectionRegistry(d3GeoProjection) });
 * ```
 *
 * @packageDocumentation
 */

import { tableFromIPC } from 'apache-arrow';

import {
  parseGeometry,
  parsePolygonsToSolid,
  parsePoints,
  parseSphere,
} from './driver.js';
import {
  createInsetBorderBinaryData,
  type CompositeProjection,
} from './composite-projection.js';
import {
  resolveProjectionSpec,
  defaultProjectionRegistry,
  type ProjectionRegistry,
} from './projection-spec.js';
import {
  packResult,
  type ParseRequest,
  type ParseResponse,
} from './worker-protocol.js';
import type { ParserOptions } from './types.js';

/**
 * Options for the worker-side handler.
 */
export interface ParseWorkerOptions {
  /**
   * Extra projection factories merged over the d3-geo defaults.
   * Build with `createProjectionRegistry(d3GeoProjection, { customId: factory })`.
   */
  projections?: ProjectionRegistry;
}

/**
 * Create the pure message handler: request in, `{ response, transfer }` out.
 *
 * Exposed separately from `setupParseWorker` so it can be unit-tested (or
 * bridged to other transports) without a real Worker.
 */
export function createParseMessageHandler(options: ParseWorkerOptions = {}) {
  const registry: ProjectionRegistry = {
    ...defaultProjectionRegistry,
    ...options.projections,
  };

  // Spec resolution can be expensive (composite projections rebuild and fit
  // every sub-projection), and consecutive requests typically share the same
  // spec — memoize the last resolution. Single-entry on purpose: projections
  // are stateful stream factories, so unbounded caching would pin memory
  // without helping the sequential request pattern.
  let lastSpecKey: string | null = null;
  let lastProjection: ReturnType<typeof resolveProjectionSpec> | null = null;

  function resolveSpecCached(spec: ParseRequest['spec']) {
    const specKey = JSON.stringify(spec);
    if (lastProjection === null || specKey !== lastSpecKey) {
      lastProjection = resolveProjectionSpec(spec, registry);
      lastSpecKey = specKey;
    }
    return lastProjection;
  }

  return function handleParseRequest(request: ParseRequest): {
    response: ParseResponse;
    transfer: ArrayBuffer[];
  } {
    try {
      const projection = resolveSpecCached(request.spec);
      const parserOptions: ParserOptions = {
        projection,
        ...request.options,
      };

      let result: Record<string, unknown>;

      switch (request.method) {
        case 'parseSphere': {
          result = parseSphere(projection, {
            output: request.sphereOutput ?? 'path',
          }) as unknown as Record<string, unknown>;
          break;
        }
        case 'insetBorders': {
          if (request.spec.type !== 'composite') {
            throw new Error('insetBorders requires a composite projection spec');
          }
          result = createInsetBorderBinaryData(
            projection as CompositeProjection,
          ) as unknown as Record<string, unknown>;
          break;
        }
        case 'parseGeometry':
        case 'parsePolygonsToSolid':
        case 'parsePoints': {
          if (!request.ipc) {
            throw new Error(`${request.method} requires Arrow IPC bytes`);
          }
          const table = tableFromIPC(request.ipc);
          const parse =
            request.method === 'parseGeometry'
              ? parseGeometry
              : request.method === 'parsePolygonsToSolid'
                ? parsePolygonsToSolid
                : parsePoints;
          result = parse(table, parserOptions) as unknown as Record<string, unknown>;
          break;
        }
        default:
          throw new Error(`Unknown parse method: ${String(request.method)}`);
      }

      const { packed, transfer } = packResult(result);
      return {
        response: { __geoarrowParse: true, id: request.id, ok: true, result: packed },
        transfer,
      };
    } catch (error) {
      return {
        response: {
          __geoarrowParse: true,
          id: request.id,
          ok: false,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        },
        transfer: [],
      };
    }
  };
}

/** Minimal worker global surface (avoids requiring the WebWorker TS lib). */
interface WorkerGlobalLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}

/**
 * Wire the parse handler to the worker's message loop.
 * Call once at the top level of a worker entry file.
 *
 * Messages not produced by the client (`__geoarrowParse` marker absent) are
 * ignored, so the host app can share the worker for other traffic if needed.
 */
export function setupParseWorker(options: ParseWorkerOptions = {}): void {
  const handle = createParseMessageHandler(options);
  const scope = globalThis as unknown as WorkerGlobalLike;

  scope.onmessage = (event: { data: unknown }) => {
    const data = event.data as ParseRequest | undefined;
    if (!data || data.__geoarrowParse !== true) return;
    const { response, transfer } = handle(data);
    scope.postMessage(response, transfer);
  };
}
