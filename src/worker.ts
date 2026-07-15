/**
 * Worker entry point — off-main-thread parsing
 *
 * Import from `@ateliercartographie/geoarrow-deck-stream/worker`:
 * - Main thread: `createParseWorkerClient`
 * - Worker file: `setupParseWorker`, `createProjectionRegistry`
 * - Both/anywhere: `resolveProjectionSpec` and the ProjectionSpec types
 *
 * @packageDocumentation
 */

// Projection spec (serializable projection descriptions)
export {
  resolveProjectionSpec,
  createProjectionRegistry,
  defaultProjectionRegistry,
  type ProjectionSpec,
  type SimpleProjectionSpec,
  type CompositeProjectionSpec,
  type SubProjectionEntrySpec,
  type ProjectionRegistry,
  type ProjectionFactory,
} from './projection-spec.js';

// Worker side
export {
  setupParseWorker,
  createParseMessageHandler,
  type ParseWorkerOptions,
} from './worker-handler.js';

// Main-thread side
export {
  createParseWorkerClient,
  type ParseWorkerClient,
  type WorkerGeometryInput,
  type WorkerParseOptions,
  type WorkerLike,
  type InsetBorderBinaryData,
} from './worker-client.js';

// Protocol (advanced: custom transports, testing)
export {
  packResult,
  unpackResult,
  type ParseRequest,
  type ParseResponse,
  type ParseMethod,
  type SerializableParserOptions,
} from './worker-protocol.js';
