/**
 * Worker Client - runs on the MAIN thread
 *
 * Promise-based facade over a parse worker. Sends Arrow IPC bytes and a
 * serializable projection spec, receives Deck.gl-ready binary data whose
 * buffers were *transferred* (zero-copy) from the worker.
 *
 * ```typescript
 * import { createParseWorkerClient } from '@ateliercartographie/geoarrow-deck-stream/worker';
 *
 * const client = createParseWorkerClient(
 *   new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' })
 * );
 *
 * const solid = await client.parsePolygonsToSolid(ipcBytes, {
 *   projection: 'geoConicConformal',
 *   rotate: [-3, 0],
 *   center: [0, 46.5],
 *   parallels: [44, 49],
 *   fitExtent: { extent: [[0, 0], [960, 600]], bbox: [-5.5, 41, 10, 51.5] }
 * });
 * // → main thread never blocked; feed straight to SolidPolygonLayer
 * ```
 *
 * @packageDocumentation
 */

import { tableToIPC, Table } from 'apache-arrow';

import type {
  BinaryPathData,
  BinaryPolygonData,
  BinaryPointData,
} from './types.js';
import type { ProjectionSpec, CompositeProjectionSpec } from './projection-spec.js';
import {
  unpackResult,
  type ParseMethod,
  type ParseRequest,
  type ParseResponse,
  type SerializableParserOptions,
} from './worker-protocol.js';

/** Accepted geometry input on the client side. */
export type WorkerGeometryInput = Table | Uint8Array | ArrayBuffer;

/** Per-call options. */
export interface WorkerParseOptions extends SerializableParserOptions {
  /**
   * Transfer the input IPC buffer to the worker instead of copying it.
   * Zero-copy, but DETACHES the caller's buffer (it becomes unusable).
   * Only applies when the input is Uint8Array/ArrayBuffer.
   * @default false
   */
  transferInput?: boolean;
}

/** Inset borders binary data (see createInsetBorderBinaryData). */
export interface InsetBorderBinaryData {
  positions: Float32Array;
  startIndices: Uint32Array;
  featureIds: Uint32Array;
  length: number;
}

/**
 * Promise-based parse client bound to a Worker.
 */
export interface ParseWorkerClient {
  /** PathLayer output (LineString/MultiLineString, or polygon outlines). */
  parseGeometry(
    input: WorkerGeometryInput,
    spec: ProjectionSpec,
    options?: WorkerParseOptions,
  ): Promise<BinaryPathData>;

  /** SolidPolygonLayer output (projection + rings + earcut, all off-main-thread). */
  parsePolygonsToSolid(
    input: WorkerGeometryInput,
    spec: ProjectionSpec,
    options?: WorkerParseOptions,
  ): Promise<BinaryPolygonData>;

  /** ScatterplotLayer output (Point/MultiPoint). */
  parsePoints(
    input: WorkerGeometryInput,
    spec: ProjectionSpec,
    options?: WorkerParseOptions,
  ): Promise<BinaryPointData>;

  /** Projection sphere boundary (globe outline / background). */
  parseSphere(
    spec: ProjectionSpec,
    options?: { output?: 'path' | 'polygon' },
  ): Promise<BinaryPathData | BinaryPolygonData>;

  /** Inset frame rectangles of a composite projection, as PathLayer data. */
  insetBorders(spec: CompositeProjectionSpec): Promise<InsetBorderBinaryData>;

  /** Terminate the underlying worker and reject pending requests. */
  terminate(): void;
}

/** Minimal Worker surface (keeps this file usable without the DOM lib). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  addEventListener(type: string, listener: (event: never) => void): void;
  terminate?(): void;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
}

function toIPCBytes(input: WorkerGeometryInput): Uint8Array {
  if (input instanceof Table) return tableToIPC(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return input;
}

/**
 * Wrap a Worker (whose entry called `setupParseWorker`) in a Promise API.
 *
 * The worker instance is owned by the caller: create it with your bundler's
 * worker syntax and pass it in. Requests are matched to responses by id, so
 * concurrent calls on one worker are safe (they queue in the worker).
 */
export function createParseWorkerClient(worker: WorkerLike): ParseWorkerClient {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let terminated = false;

  worker.addEventListener('message', ((event: { data: unknown }) => {
    const data = event.data as ParseResponse | undefined;
    if (!data || data.__geoarrowParse !== true) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) {
      entry.resolve(unpackResult(data.result) as never);
    } else {
      entry.reject(new Error(data.error));
    }
  }) as (event: never) => void);

  worker.addEventListener('error', ((event: { message?: string }) => {
    const error = new Error(event.message ?? 'Parse worker crashed');
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }) as (event: never) => void);

  function call<T>(
    method: ParseMethod,
    spec: ProjectionSpec,
    input?: WorkerGeometryInput,
    options?: WorkerParseOptions,
    sphereOutput?: 'path' | 'polygon',
  ): Promise<T> {
    if (terminated) {
      return Promise.reject(new Error('Parse worker client is terminated'));
    }
    const id = nextId++;
    const { transferInput, ...parserOptions } = options ?? {};

    const request: ParseRequest = {
      __geoarrowParse: true,
      id,
      method,
      spec,
      options: parserOptions,
      sphereOutput,
    };

    const transfer: ArrayBuffer[] = [];
    if (input !== undefined) {
      const ipc = toIPCBytes(input);
      request.ipc = ipc;
      if (transferInput && ipc.buffer instanceof ArrayBuffer) {
        transfer.push(ipc.buffer);
      }
    }

    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: never) => void, reject });
      worker.postMessage(request, transfer);
    });
  }

  return {
    parseGeometry: (input, spec, options) =>
      call<BinaryPathData>('parseGeometry', spec, input, options),
    parsePolygonsToSolid: (input, spec, options) =>
      call<BinaryPolygonData>('parsePolygonsToSolid', spec, input, options),
    parsePoints: (input, spec, options) =>
      call<BinaryPointData>('parsePoints', spec, input, options),
    parseSphere: (spec, options) =>
      call<BinaryPathData | BinaryPolygonData>(
        'parseSphere',
        spec,
        undefined,
        undefined,
        options?.output,
      ),
    insetBorders: (spec) => call<InsetBorderBinaryData>('insetBorders', spec),
    terminate: () => {
      terminated = true;
      const error = new Error('Parse worker client is terminated');
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      worker.terminate?.();
    },
  };
}
