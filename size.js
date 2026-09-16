const { Worker, isMainThread, workerData } = require("node:worker_threads");
const fs = require("node:fs"), path = require("node:path");
const bytes = fs.readFileSync(path.join(__dirname, "repro.wasm"));
const ITERS = Number(process.env.ITERS || 1000);
const NW = 4;
if (isMainThread) {
  const mem = new WebAssembly.Memory({ initial: 16, maximum: 65536, shared: true });
  const mod = new WebAssembly.Module(bytes);
  const i32 = new Int32Array(mem.buffer);
  let done = 0;
  const allDone = () => {
    if (++done < NW) return;
    const real = mem.buffer.byteLength / 65536;
    let staleCount = 0, worst = 0, ruleBroken = 0;
    const lines = [];
    for (let id = 0; id < NW; id++) {
      const seen = i32[(128 + id * 8) / 4];
      const ownLast = i32[(132 + id * 8) / 4];
      if (seen !== ownLast) ruleBroken++;
      const gap = real - seen;
      if (gap > 0) { staleCount++; if (gap > worst) worst = gap; }
      lines.push("agent " + id + " sees " + seen + (gap > 0 ? " (-" + gap + ")" : " (exact)"));
    }
    console.log("  real size: " + real + " pages   |  " + lines.join(", "));
    console.log("  verdict: " + (staleCount
      ? staleCount + " of " + NW + " agents see a STALE size, worst gap " + worst + " pages (" + (worst * 64) + " KB)"
      : "all agents see the exact size"));
    console.log("  per-agent rule (memory.size == size at its own last grow): " +
      (ruleBroken ? ruleBroken + " agent(s) BREAK it" : "holds for all " + NW));
    process.exit(staleCount ? 1 : 0);
  };
  for (let id = 0; id < NW; id++) {
    const w = new Worker(__filename, { workerData: { mod, mem, id, iters: ITERS } });
    w.on("message", allDone);
    w.on("error", (e) => { console.log("    agent " + id + " TRAP : " + e.message); allDone(); });
  }
} else {
  const { mod, mem, id, iters } = workerData;
  const inst = new WebAssembly.Instance(mod, { env: { memory: mem } });
  const rc = inst.exports.sizeReport(id, iters);
  require("node:worker_threads").parentPort.postMessage({ rc });
}
