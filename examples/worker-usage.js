/**
 * Worker parsing demo / end-to-end verification.
 *
 * Compares main-thread blocking between:
 * 1. direct parsePolygonsToSolid on the main thread
 * 2. the same parse through the default parse worker
 *
 * Main-thread blocking is measured with the Long Tasks API.
 */
import { tableFromIPC, parsePolygonsToSolid } from '../dist/index.js';
import { createParseWorkerClient } from '../dist/worker.js';
import { geoConicConformal } from 'd3-geo';

const log = (line) => {
  document.getElementById('log').textContent += `\n${line}`;
  console.log(line);
};
document.getElementById('log').textContent = '';

// France Lambert-style conic conformal — same params in both forms
const FRANCE_SPEC = {
  projection: 'geoConicConformal',
  rotate: [-3, 0],
  center: [0, 46.5],
  parallels: [44, 49],
  scale: 2800,
  translate: [500, 400],
};
const franceProjection = () =>
  geoConicConformal()
    .rotate([-3, 0])
    .center([0, 46.5])
    .parallels([44, 49])
    .scale(2800)
    .translate([500, 400]);

// Event-loop heartbeat: the max gap between macrotask ticks ≈ longest
// main-thread block. Uses MessageChannel self-ping (not throttled in
// background tabs, unlike setInterval/rAF).
let maxGapMs = 0;
let lastTick = performance.now();
const heartbeat = new MessageChannel();
heartbeat.port1.onmessage = () => {
  const now = performance.now();
  maxGapMs = Math.max(maxGapMs, now - lastTick);
  lastTick = now;
  heartbeat.port2.postMessage(null);
};
heartbeat.port2.postMessage(null);
const resetGap = () => { maxGapMs = 0; lastTick = performance.now(); };

const resp = await fetch('./test-data/real-data/fr-com2025-wgs84.arrow');
const ipc = new Uint8Array(await resp.arrayBuffer());
log(`fetched ${(ipc.byteLength / 1e6).toFixed(1)} MB Arrow IPC`);

// --- 1. Main thread ---------------------------------------------------------
resetGap();
const t0 = performance.now();
const direct = parsePolygonsToSolid(tableFromIPC(ipc), {
  projection: franceProjection(),
});
const directMs = performance.now() - t0;
await new Promise((r) => setTimeout(r, 100));
const directBlocked = maxGapMs;
log(`main thread : ${directMs.toFixed(0)} ms total, ` +
    `longest main-thread block ${directBlocked.toFixed(0)} ms — ` +
    `${direct.length} polygons, ${direct.indices.length / 3} triangles`);

// --- 2. Worker --------------------------------------------------------------
const worker = new Worker(new URL('../dist/parse-worker.js', import.meta.url), {
  type: 'module',
});
const client = createParseWorkerClient(worker);

resetGap();
const t1 = performance.now();
const viaWorker = await client.parsePolygonsToSolid(ipc, FRANCE_SPEC);
const workerMs = performance.now() - t1;
await new Promise((r) => setTimeout(r, 100));
const workerBlocked = maxGapMs;
log(`worker      : ${workerMs.toFixed(0)} ms total, ` +
    `longest main-thread block ${workerBlocked.toFixed(0)} ms — ` +
    `${viaWorker.length} polygons, ${viaWorker.indices.length / 3} triangles`);

// --- 3. Equality check ------------------------------------------------------
const same =
  viaWorker.length === direct.length &&
  viaWorker.positions.length === direct.positions.length &&
  viaWorker.indices.length === direct.indices.length &&
  viaWorker.positions.every((v, i) => v === direct.positions[i]);
log(same ? 'RESULTS IDENTICAL ✔' : 'RESULTS DIFFER ✘');
log('done');
client.terminate();
