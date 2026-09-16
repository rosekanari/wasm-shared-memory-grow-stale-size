// Four agents concurrently grow a shared memory and write into the regions
// published by the others: an allocator's pattern.
const { Worker, isMainThread, workerData } = require("node:worker_threads");
const fs = require("node:fs"), path = require("node:path");
const bytes = fs.readFileSync(path.join(__dirname, "stress3.wasm"));
const ITERS = Number(process.env.ITERS || 200);
const NW = 4;

if (isMainThread) {
  const mem = new WebAssembly.Memory({ initial: 16, maximum: 65536, shared: true });
  const mod = new WebAssembly.Module(bytes);
  const t0 = Date.now();
  let done = 0, bad = 0, traps = 0;
  const allDone = () => {
    if (++done === NW) {
      const pages = mem.buffer.byteLength / 65536;
      console.log("  result: " + (bad + traps === 0 ? "OK" : (traps ? traps + " TRAP" : "") + (bad ? " " + bad + " inconsistencies" : "")) +
        "   final pages: " + pages + "   took " + (Date.now() - t0) + " ms");
      process.exit(bad + traps ? 1 : 0);
    }
  };
  for (let id = 0; id < NW; id++) {
    const w = new Worker(__filename, { workerData: { mod, mem, id, iters: ITERS } });
    w.on("message", (m) => { if (m.rc !== 0) bad++; allDone(); });
    w.on("error", (e) => { traps++; console.log("    agent " + id + " TRAP : " + e.message); allDone(); });
  }
} else {
  const { mod, mem, id, iters } = workerData;
  const inst = new WebAssembly.Instance(mod, { env: { memory: mem } });
  const rc = inst.exports[process.env.FN || "othersOnly"](id, iters);
  require("node:worker_threads").parentPort.postMessage({ rc });
}
