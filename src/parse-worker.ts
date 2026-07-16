/**
 * Default parse worker entry — d3-geo projections only.
 *
 * Use it directly when the standard d3-geo projections (and composite
 * projections built from them) are enough:
 *
 * ```typescript
 * const worker = new Worker(
 *   new URL('@ateliercartographie/geoarrow-deck-stream/parse-worker', import.meta.url),
 *   { type: 'module' }
 * );
 * const client = createParseWorkerClient(worker);
 * ```
 *
 * For d3-geo-projection / d3-geo-polygon / custom projections, write your own
 * worker entry with `setupParseWorker({ projections })` — see worker-handler.ts.
 *
 * @packageDocumentation
 */

import { setupParseWorker } from './worker-handler.js';

setupParseWorker();
