const { Worker, isMainThread, workerData } = require("node:worker_threads");
const fs = require("node:fs"), path = require("node:path");
const bytes = fs.readFileSync(path.join(__dirname, "instrumented.wasm"));
const ITERS = Number(process.env.ITERS || 300);
const FN = process.env.FN || "othersOnly";
const NW = 4;
if (isMainThread) {
  const mem = new WebAssembly.Memory({ initial: 16, maximum: 65536, shared: true });
  const mod = new WebAssembly.Module(bytes);
  const i32 = new Int32Array(mem.buffer);
  let done = 0, traps = 0, bad = 0;
  const allDone = () => { if (++done === NW) {
    console.log("  result: " + (traps ? traps + " TRAP" : bad ? bad + " inconsistencies" : "OK") +
                "   final pages: " + (mem.buffer.byteLength / 65536));
    process.exit(traps + bad ? 1 : 0); } };
  for (let id = 0; id < NW; id++) {
    const w = new Worker(__filename, { workerData: { mod, mem, id, iters: ITERS, fn: FN } });
    w.on("message", (m) => { if (m.rc !== 0) bad++; allDone(); });
    w.on("error", (e) => {
      traps++;
      const sz = i32[(128 + id * 8) / 4], base = i32[(132 + id * 8) / 4];
      let diag = "";
      if (sz) {
        diag = "  memory.size just before = " + sz + " pages (" + sz * 65536 + " o)" +
               ", target base = " + base +
               ", access " + (base < sz * 65536 ? "INSIDE the observed size -> the agent contradicts itself" : "beyond the observed size");
      }
      console.log("    agent " + id + " TRAP : " + e.message + diag);
      allDone();
    });
  }
} else {
  const { mod, mem, id, iters, fn } = workerData;
  const inst = new WebAssembly.Instance(mod, { env: { memory: mem, jsnoop: () => {} } });
  const fname = fn;
  if (typeof inst.exports[fname] !== "function")
    throw new Error("no such export: " + fname + " (have: " + Object.keys(inst.exports).join(",") + ")");
  const rc = inst.exports[fn](id, iters);
  require("node:worker_threads").parentPort.postMessage({ rc });
}
