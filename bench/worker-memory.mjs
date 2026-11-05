/**
 * Worker memory bench — peak vs retained heap of the parse worker.
 *
 *   npm run build && node --expose-gc bench/worker-memory.mjs [--features 60000] [--segments 40]
 *        [--encoding wkb|native] [--batch-rows 2048] [--snapshot file.heapsnapshot] [--dist dir]
 *        [--methods parseGeometry,parsePolygonsToSolid]
 *
 * Mirrors how Khartis drives the worker: Arrow IPC bytes are *cloned* into a
 * worker thread (no transferInput), parsed through `createParseMessageHandler`
 * with a geoIdentity spec, and the result is posted back with its transfer
 * list. The main thread samples the worker's V8 heap (`used_heap_size`) and
 * off-heap ArrayBuffer memory (`external_memory`) every few ms while the
 * worker is busy, then the worker runs `gc()` and reports what it retains.
 *
 * Synthetic data: N circles (`ST_Buffer(point, 0.02, segments)` equivalent:
 * 4*segments+1 vertices per ring, no holes) in EPSG:4326 over France.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  Binary,
  Field,
  Int32,
  makeData,
  RecordBatch,
  Schema,
  Struct,
  Table,
  tableToIPC,
} from 'apache-arrow';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const FEATURES = Number(args.features ?? 60000);
const SEGMENTS = Number(args.segments ?? 40);
const ENCODING = args.encoding ?? 'wkb';
const METHODS = (args.methods ?? 'parseGeometry,parsePolygonsToSolid').split(',');
// DuckDB(-WASM) emits record batches of 2048 rows; Khartis' tables keep that layout.
const BATCH_ROWS = Number(args['batch-rows'] ?? 2048);
const SAMPLE_MS = 5;
// Build directory to bench (compare branches: build one elsewhere, pass --dist).
const DIST = new URL(`${args.dist ?? '../dist'}/`, args.dist ? `file://${process.cwd()}/` : import.meta.url);
const { decodeWkbColumn } = await import(new URL('wkb-reader.js', DIST).href);

const MB = (n) => (n / 1048576).toFixed(0).padStart(6);

// ─── Synthetic data ──────────────────────────────────────────────────

function buildWkbTable(n, segments, batchRows) {
  const ptsPerRing = segments * 4 + 1;
  const wkbSize = 1 + 4 + 4 + 4 + ptsPerRing * 16;
  const values = new Uint8Array(n * wkbSize);
  const offsets = new Int32Array(n + 1);
  const dv = new DataView(values.buffer);
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const base = i * wkbSize;
    offsets[i] = base;
    const cx = -5 + rand() * 13;
    const cy = 42 + rand() * 9;
    values[base] = 1;
    dv.setUint32(base + 1, 3, true); // Polygon
    dv.setUint32(base + 5, 1, true); // 1 ring
    dv.setUint32(base + 9, ptsPerRing, true);
    let off = base + 13;
    for (let j = 0; j < ptsPerRing; j++) {
      const a = (-2 * Math.PI * (j % (ptsPerRing - 1))) / (ptsPerRing - 1); // CCW→ closed
      dv.setFloat64(off, cx + 0.02 * Math.cos(a), true);
      dv.setFloat64(off + 8, cy + 0.02 * Math.sin(a), true);
      off += 16;
    }
  }
  offsets[n] = n * wkbSize;

  const geomField = new Field(
    'geometry',
    new Binary(),
    true,
    new Map([['ARROW:extension:name', 'geoarrow.wkb']]),
  );
  const idField = new Field('id', new Int32(), true);
  const fields = [idField, geomField];
  const schema = new Schema(fields);
  const batches = [];
  for (let start = 0; start < n; start += batchRows) {
    const end = Math.min(n, start + batchRows);
    const len = end - start;
    const batchOffsets = offsets.slice(start, end + 1).map((o) => o - offsets[start]);
    const geomData = makeData({
      type: new Binary(),
      length: len,
      valueOffsets: batchOffsets,
      data: values.subarray(offsets[start], offsets[end]),
    });
    const ids = new Int32Array(len).map((_, i) => start + i);
    const idData = makeData({ type: new Int32(), length: len, data: ids });
    const struct = makeData({ type: new Struct(fields), length: len, children: [idData, geomData] });
    batches.push(new RecordBatch(schema, struct));
  }
  return { table: new Table(schema, batches), vertices: n * ptsPerRing };
}

// ─── Worker side ─────────────────────────────────────────────────────

const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
const v8 = require('node:v8');
(async () => {
  const { createParseMessageHandler } = await import(${JSON.stringify(
    new URL('worker-handler.js', DIST).href,
  )});
  const handle = createParseMessageHandler();
  const snap = () => {
    const s = v8.getHeapStatistics();
    const m = process.memoryUsage();
    return { heap: s.used_heap_size, external: s.external_memory, arrayBuffers: m.arrayBuffers };
  };
  // ArrayBuffer backing stores are freed by V8's concurrent sweeper after the
  // GC that finds them dead: yield between collections so it can finish.
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      global.gc();
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await settle();
  parentPort.postMessage({ type: 'baseline', ...snap() });
  parentPort.on('message', async (msg) => {
    if (msg.type === 'gc') {
      await settle();
      parentPort.postMessage({ type: 'retained', ...snap() });
      return;
    }
    if (msg.type === 'snapshot') {
      await settle();
      const file = v8.writeHeapSnapshot(msg.path);
      parentPort.postMessage({ type: 'snapshot', file });
      return;
    }
    const t0 = performance.now();
    const { response, transfer } = handle(msg.request);
    const ms = performance.now() - t0;
    parentPort.postMessage({ type: 'result', ms, ok: response.ok, error: response.error, response }, transfer);
  });
})();
`;

function startWorker() {
  return new Worker(WORKER_SRC, { eval: true });
}

function next(worker, type) {
  return new Promise((resolve) => {
    const on = (msg) => {
      if (msg.type === type) {
        worker.off('message', on);
        resolve(msg);
      }
    };
    worker.on('message', on);
  });
}

// ─── Run ─────────────────────────────────────────────────────────────

const { table: wkbTable, vertices } = buildWkbTable(FEATURES, SEGMENTS, BATCH_ROWS);
const table = ENCODING === 'native' ? decodeWkbColumn(wkbTable).table : wkbTable;
const ipc = tableToIPC(table);

console.log(
  `features=${FEATURES} vertices=${vertices} encoding=${ENCODING} batches=${table.batches.length} ipc=${MB(ipc.byteLength).trim()} MB` +
    ` (coords f64=${MB(vertices * 16).trim()} MB)`,
);

const worker = startWorker();
const baseline = await next(worker, 'baseline');
let id = 0;
const rows = [];

for (const method of METHODS) {
  let peakHeap = 0;
  let peakExt = 0;
  let peakTotal = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const s = await worker.getHeapStatistics();
      peakHeap = Math.max(peakHeap, s.used_heap_size);
      peakExt = Math.max(peakExt, s.external_memory);
      peakTotal = Math.max(peakTotal, s.used_heap_size + s.external_memory);
      await new Promise((r) => setTimeout(r, SAMPLE_MS));
    }
  })();

  const request = {
    __geoarrowParse: true,
    id: ++id,
    method,
    ipc, // cloned by postMessage, like Khartis
    spec: { projection: 'geoIdentity' },
    options: { capacityMultiplier: 1.0, rewind: false },
  };
  const resultP = next(worker, 'result');
  worker.postMessage({ type: 'parse', request });
  const result = await resultP;
  sampling = false;
  await sampler;
  if (!result.ok) throw new Error(result.error);

  worker.postMessage({ type: 'gc' });
  const retained = await next(worker, 'retained');

  const out = result.response.result;
  const outBytes = Object.values(out)
    .filter((v) => v && typeof v === 'object' && v.buffer)
    .reduce((s, v) => s + v.buffer.byteLength, 0);

  rows.push({
    method,
    ms: result.ms.toFixed(0),
    peakHeap: MB(peakHeap - baseline.heap),
    peakExt: MB(peakExt - baseline.external),
    peakTotal: MB(peakTotal - baseline.heap - baseline.external),
    retHeap: MB(retained.heap - baseline.heap),
    retExt: MB(retained.external - baseline.external),
    output: MB(outBytes),
  });
}

if (args.snapshot) {
  worker.postMessage({ type: 'snapshot', path: args.snapshot });
  const s = await next(worker, 'snapshot');
  console.log('heap snapshot:', s.file);
}

console.log('\nMB above worker baseline (peak sampled every ~5 ms; retained after gc)');
console.table(rows);
await worker.terminate();
