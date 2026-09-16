// Minimal host: shared memory 16..64 pages, two agents (main + worker):
// the worker grows the memory and publishes through an atomic store; the main
// agent waits on memory.atomic.wait32 then reads the new page.
const { Worker, isMainThread, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");

const PAGE = 65536;
const FLAG = 0;          // atomic flag, 4-aligned
const OUT  = 8;          // V3 stores memory.size here
const ADDR = 16 * PAGE;  // first byte of the new page (beyond the initial 16)
const VALUE = 0xcafe;

const bytes = fs.readFileSync(path.join(__dirname, "control-single-grow.wasm"));

if (isMainThread) {
  const variant = process.argv[2] || "v1";
  const mem = new WebAssembly.Memory({ initial: 16, maximum: 64, shared: true });
  const mod = new WebAssembly.Module(bytes);
  const inst = new WebAssembly.Instance(mod, { env: { memory: mem } });
  const w = new Worker(__filename, { workerData: { mod, mem } });
  const i32 = new Int32Array(mem.buffer);
  let res = null, trap = null;
  try {
    res = inst.exports[variant](FLAG, ADDR, OUT);
  } catch (e) {
    trap = (e && e.constructor ? e.constructor.name : "?") + ": " + (e && e.message);
  }
  const sizeSeen = i32[OUT / 4];
  const pagesNow = mem.buffer.byteLength / PAGE;
  const verdict = trap ? "TRAP" : (res === VALUE ? "READ-OK" : "READ-WRONG(" + res + ")");
  console.log(
    "  " + variant.padEnd(3) +
    "  " + verdict.padEnd(14) +
    "  memory.size seen by the function: " + (sizeSeen || "-") +
    "  pages after: " + pagesNow +
    (trap ? "   [" + trap + "]" : "")
  );
  w.terminate();
} else {
  const { mod, mem } = workerData;
  const inst = new WebAssembly.Instance(mod, { env: { memory: mem } });
  const t0 = Date.now();
  while (Date.now() - t0 < 400) { /* let the main agent park in the wait */ }
  const old = inst.exports.grow(1);          // returns the previous size, in pages
  inst.exports.write(old * PAGE, VALUE);     // write into the new page
  inst.exports.publish(FLAG);                // publish: atomic store + notify
}
