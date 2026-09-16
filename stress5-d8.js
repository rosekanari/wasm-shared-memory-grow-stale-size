// Same experiment as stress5.js, ported to d8: readbuffer, Worker type string,
// blocking getMessage, print. Usage: d8 stress5-d8.js -- <iters>
const ITERS = (typeof arguments !== "undefined" && arguments[0]) ? Number(arguments[0]) : 1000;
const NW = 4;
const bytes = readbuffer("stress5.wasm");
const mem = new WebAssembly.Memory({ initial: 16, maximum: 65536, shared: true });
const mod = new WebAssembly.Module(bytes);
const src = `
onmessage = function (e) {
  const d = (e && e.data) ? e.data : e;
  const inst = new WebAssembly.Instance(d.mod, { env: { memory: d.mem } });
  const rc = inst.exports.sizeReport(d.id, d.iters);
  postMessage(rc);
};
`;
const ws = [];
for (let id = 0; id < NW; id++) {
  const w = new Worker(src, { type: "string" });
  w.postMessage({ mod: mod, mem: mem, id: id, iters: ITERS });
  ws.push(w);
}
for (let i = 0; i < ws.length; i++) ws[i].getMessage();
const i32 = new Int32Array(mem.buffer);
const real = mem.buffer.byteLength / 65536;
let staleCount = 0, worst = 0;
const lines = [];
for (let id = 0; id < NW; id++) {
  const seen = i32[(128 + id * 8) / 4];
  const gap = real - seen;
  if (gap > 0) { staleCount++; if (gap > worst) worst = gap; }
  lines.push("agent " + id + " sees " + seen + (gap > 0 ? " (-" + gap + ")" : " (exact)"));
}
print("  real size: " + real + " pages   |  " + lines.join(", "));
print("  verdict: " + (staleCount
  ? staleCount + " of " + NW + " agents see a STALE size, worst gap " + worst + " pages"
  : "all agents see the exact size"));
