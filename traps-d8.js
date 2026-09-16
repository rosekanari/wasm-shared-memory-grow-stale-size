// Aggravated form (traps), ported to d8. Usage: d8 [--wasm-enforce-bounds-checks] stress3-d8.js -- <fn> <iters>
const FN = (typeof arguments !== "undefined" && arguments[0]) ? arguments[0] : "othersOnly";
const ITERS = (typeof arguments !== "undefined" && arguments[1]) ? Number(arguments[1]) : 500;
const NW = 4;
const bytes = readbuffer("repro.wasm");
const mem = new WebAssembly.Memory({ initial: 16, maximum: 65536, shared: true });
const mod = new WebAssembly.Module(bytes);
const src = `
onmessage = function (e) {
  const d = (e && e.data) ? e.data : e;
  try {
    const inst = new WebAssembly.Instance(d.mod, { env: { memory: d.mem } });
    const rc = inst.exports[d.fn](d.id, d.iters);
    postMessage({ rc: rc, err: null });
  } catch (ex) {
    postMessage({ rc: -1, err: String(ex && ex.message ? ex.message : ex) });
  }
};
`;
const ws = [];
for (let id = 0; id < NW; id++) {
  const w = new Worker(src, { type: "string" });
  w.postMessage({ mod: mod, mem: mem, id: id, iters: ITERS, fn: FN });
  ws.push(w);
}
let traps = 0, msg = "";
for (let i = 0; i < ws.length; i++) {
  const m = ws[i].getMessage();
  if (m && m.err) { traps++; if (!msg) msg = m.err; }
}
print("  " + FN + " : " + (traps ? traps + " TRAP of " + NW + "  [" + msg + "]" : "OK") +
      "   final pages: " + (mem.buffer.byteLength / 65536));
