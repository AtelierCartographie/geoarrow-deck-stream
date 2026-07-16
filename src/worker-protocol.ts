/**
 * Worker Protocol - message shapes and binary (un)packing
 *
 * Shared between the worker handler and the main-thread client.
 * Keeps the zero-copy philosophy across the thread boundary: every
 * TypedArray in a parse result is described by (buffer, byteOffset, length)
 * and its underlying ArrayBuffer is *transferred*, not cloned.
 *
 * @packageDocumentation
 */

import type { ProjectionSpec } from './projection-spec.js';

// =============================================================================
// MESSAGES
// =============================================================================

/** Parse methods exposed by the worker. */
export type ParseMethod =
  | 'parseGeometry'
  | 'parsePolygonsToSolid'
  | 'parsePoints'
  | 'parseSphere'
  | 'insetBorders';

/** Serializable subset of ParserOptions (no projection, no debug closures). */
export interface SerializableParserOptions {
  capacityMultiplier?: number;
  rewind?: boolean;
  debug?: boolean;
  debugSampleLimit?: number;
}

/** Request sent from the client to the worker. */
export interface ParseRequest {
  __geoarrowParse: true;
  id: number;
  method: ParseMethod;
  /** Arrow IPC bytes. Absent for spec-only methods (parseSphere, insetBorders). */
  ipc?: Uint8Array;
  spec: ProjectionSpec;
  options?: SerializableParserOptions;
  /** parseSphere output flavor. */
  sphereOutput?: 'path' | 'polygon';
}

/** Successful response. `result` is a packed record (see packResult). */
export interface ParseSuccessResponse {
  __geoarrowParse: true;
  id: number;
  ok: true;
  result: PackedRecord;
}

/** Failed response. */
export interface ParseErrorResponse {
  __geoarrowParse: true;
  id: number;
  ok: false;
  error: string;
}

export type ParseResponse = ParseSuccessResponse | ParseErrorResponse;

// =============================================================================
// BINARY PACKING
// =============================================================================

const TYPED_ARRAY_TAG = '__typedArray' as const;

type TypedArrayName = 'Float32Array' | 'Float64Array' | 'Uint32Array' | 'Uint16Array' | 'Uint8Array' | 'Int32Array';

interface PackedTypedArray {
  [TYPED_ARRAY_TAG]: TypedArrayName;
  buffer: ArrayBuffer;
  byteOffset: number;
  length: number;
}

const TYPED_ARRAY_CONSTRUCTORS: Record<TypedArrayName, new (b: ArrayBuffer, o: number, l: number) => unknown> = {
  Float32Array,
  Float64Array,
  Uint32Array,
  Uint16Array,
  Uint8Array,
  Int32Array,
};

/** A parse result with its TypedArrays replaced by transferable descriptors. */
export type PackedRecord = Record<string, unknown>;

function isTypedArray(value: unknown): value is ArrayBufferView & { length: number } {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/**
 * Replace every TypedArray field of a (possibly nested) parse result with a
 * transferable descriptor, collecting the underlying ArrayBuffers (deduped —
 * several views may share one buffer, e.g. `featureIds` after `subarray`).
 *
 * @returns the packed record and the transfer list for postMessage
 */
export function packResult(result: Record<string, unknown>): {
  packed: PackedRecord;
  transfer: ArrayBuffer[];
} {
  const buffers = new Set<ArrayBuffer>();

  function packValue(value: unknown): unknown {
    if (isTypedArray(value)) {
      const name = value.constructor.name as TypedArrayName;
      if (!(name in TYPED_ARRAY_CONSTRUCTORS)) return value;
      // SharedArrayBuffer-backed views are not transferable; clone defensively.
      const buffer =
        value.buffer instanceof ArrayBuffer
          ? value.buffer
          : (value as unknown as { slice(): { buffer: ArrayBuffer } }).slice().buffer;
      buffers.add(buffer);
      const descriptor: PackedTypedArray = {
        [TYPED_ARRAY_TAG]: name,
        buffer,
        byteOffset: value.byteOffset,
        length: value.length,
      };
      return descriptor;
    }
    if (Array.isArray(value)) return value.map(packValue);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = packValue(v);
      return out;
    }
    return value;
  }

  return {
    packed: packValue(result) as PackedRecord,
    transfer: [...buffers],
  };
}

/**
 * Rebuild TypedArray views from a packed record (inverse of packResult).
 */
export function unpackResult<T = Record<string, unknown>>(packed: PackedRecord): T {
  function unpackValue(value: unknown): unknown {
    if (value !== null && typeof value === 'object') {
      const tag = (value as PackedTypedArray)[TYPED_ARRAY_TAG];
      if (tag && tag in TYPED_ARRAY_CONSTRUCTORS) {
        const { buffer, byteOffset, length } = value as PackedTypedArray;
        return new TYPED_ARRAY_CONSTRUCTORS[tag](buffer, byteOffset, length);
      }
      if (Array.isArray(value)) return value.map(unpackValue);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = unpackValue(v);
      return out;
    }
    return value;
  }
  return unpackValue(packed) as T;
}
