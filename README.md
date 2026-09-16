# `memory.size` returns a stale size on shared memory for agents that did not grow it

Four agents grow a shared WebAssembly memory 1000 times each, pass an atomic
barrier — so all 4000 grows are provably complete — and then read
`memory.size`. Most of them report an old size.

```sh
ITERS=1000 node stress5.js
#   real size : 4016 pages   |  agent 0 sees 3016 (-1000), agent 1 sees 4016 (exact),
#                               agent 2 sees 3016 (-1000), agent 3 sees 3970 (-46)
#   verdict : 3 of 4 agents see a STALE size, worst gap 1000 pages
```

No flags, no Rust, no toolchain: a 182-byte hand-written module and a 30-line
host. The `.wasm` files are committed so that a clone runs immediately; the
`.wat` sources and `regenerate.sh` are there for reading and rebuilding.

## Measured

| Platform | Engine | agents reporting a stale size | worst gap |
|---|---|---|---|
| macOS arm64 | Node 26.8.2 — V8 14.6.202.34 | 3 of 4 | 114 pages (7.3 MB) |
| Alpine 3.18 musl x64 | Node 24.21.0 — V8 13.6.233.17 | 2 of 4 | **1318 pages (84 MB)** |
| Alpine 3.18 musl x64 | Node 26.8.2 — V8 14.6.202.34 | 3 of 4 | 1000 pages (64 MB) |
| OmniOS r151058 x64 (illumos) | Node 24.21.0 — V8 13.6.233.17 | 3 of 4 | 1 page |
| macOS arm64 | **`d8` V8 15.6.3 canary** | **3 of 4** | 28 to 68 pages |

A stale view is typically short by exactly one agent's whole contribution
(3016 instead of 4016 = one agent's 1000 pages missing). The barrier spins on
`i32.atomic.load` only — no futex wait, no crossing into JS — so this is not a
race with an in-flight grow.

`memory.grow` and `memory.size` are specified sequentially consistent; the
barrier orders all grows before the size query; the returned value is therefore
required to be the final size.

## Aggravated form: spurious out-of-bounds traps

Where the engine uses explicit bounds checks rather than guard pages plus a
trap handler, the same stale state makes ordinary accesses trap. An agent writes
at a base another agent published through `i32.atomic.store` and that it read
back through `i32.atomic.load`:

```sh
FN=othersOnly ITERS=4000 node --wasm-enforce-bounds-checks stress3.js   # traps
FN=othersOnly ITERS=4000 node stress3.js                               # passes
FN=ownOnly    ITERS=4000 node --wasm-enforce-bounds-checks stress3.js   # passes
# the canary d8 used here:
# https://storage.googleapis.com/chromium-v8/official/canary/v8-mac-arm64-rel-15.6.3.zip
# ./d8 --wasm-enforce-bounds-checks stress3-d8.js -- othersOnly 2000
```

One module (`stress3.wasm`, `maximum: 65536`), `ITERS=4000`, four agents per run.
`ownOnly` is the same loop with each agent writing only into the region its own
`memory.grow` returned.

| Configuration | `othersOnly` | `ownOnly` |
|---|---|---|
| Alpine 3.18 musl x64, Node 24.21.0, default (trap handler) | 3 OK / 3 | 3 OK / 3 |
| Alpine 3.18 musl x64, Node 24.21.0, `--wasm-enforce-bounds-checks` | **5 fail / 5** | **5 OK / 5** |
| OmniOS r151058 x64, Node 24.21.0, default (explicit checks by construction) | **5 fail / 5** | **5 OK / 5** |
| macOS arm64, Node 26.8.2, default | 3 OK / 3 | 3 OK / 3 |
| macOS arm64, Node 26.8.2, `--wasm-enforce-bounds-checks` | **3 fail / 5** | **5 OK / 5** |
| macOS arm64, `d8` V8 15.6.3, default (`ITERS=2000`) | 3 OK / 3 | 3 OK / 3 |
| macOS arm64, `d8` V8 15.6.3, `--wasm-enforce-bounds-checks` (`ITERS=2000`) | **3 fail / 3** | **3 OK / 3** |

`ownOnly` never fails, on any platform, with or without the flag: the agent that
performs the grow does observe the new size. Only the other agents keep the
stale bound.

## Where the stale value lives

`stress4.js` adds instrumented variants of the same loop.

| Variant | What it inserts between the atomic load of the base and the access | Result |
|---|---|---|
| `othersSizeLog` | records `memory.size` and the target base | base is exactly `memory.size × 65536` — the bounds check and `memory.size` agree, both stale |
| `othersNoop` | 1000 calls to an empty **wasm** function | still fails |
| `othersImport` | one call to an imported **JS** function | **passes**, 5 runs out of 5 on two engines |

So the cached size is refreshed when the agent itself grows, and when execution
re-enters from JS — by nothing else reachable from wasm, `memory.size` included.

Both compiler tiers are affected: with `--liftoff-only` (baseline only) and
with `--no-liftoff` (optimizing only), `othersOnly` still fails. TurboFan fails
more often than Liftoff, but Liftoff fails too — so this is not only an
optimizing-compiler artifact such as hoisting the size into a register.

## Negative control

`host.js` / `grow.wat` is the simple case: one grow, one
`memory.atomic.wait32`, one read, in three variants (straight-line read, with a
`call` inserted, with `memory.size` inserted).

```sh
node host.js v1   # and v2, v3
```

It **passes everywhere**, with and without the flag, on all platforms above.
That is what shows the defect needs concurrent growth by several agents, not
growth alone.

## Who takes the explicit-bounds path in production

Every platform where the engine has no trap handler — illumos and Solaris among
them — and any process where the handler cannot be installed, including recent
Node when it disables the trap handler for lack of virtual address space
(`ulimit -v`, constrained containers).

The case this came from: `@rolldown/binding-wasm32-wasi` 1.1.3 (the bundler
behind vite 8) running under napi-rs/emnapi with shared memory,
`wasi.thread-spawn`, `dlmalloc` and `maximum: 65536`. Building a real frontend
fails 100 % of the time on illumos, and reproduces on Linux with the flag. Any
napi-rs WASI fallback binding is built the same way.

In that workload the failure sometimes surfaces as a trap and sometimes as a
livelock: two threads spin on the WASI `sched_yield` import — 20 million calls
in 10 s, `TIME = 2 × ELAPSED` — no thread exits, and the process ignores SIGINT
and SIGTERM because its main thread sits inside a synchronous wasm call.

## Files

| | |
|---|---|
| `stress5.wat` / `stress5.js` / `stress5-d8.js` | stale `memory.size`, no flag |
| `stress3.wat` / `stress3.js` / `stress3-d8.js` | traps; variants `othersOnly`, `othersNoop`, `othersSize` |
| `stress4.wat` / `stress4.js` | instrumented variants, incl. `othersSizeLog` and `othersImport` |
| `grow.wat` / `host.js` | negative control: single grow |
| `regenerate.sh` | rebuild the `.wasm` from the `.wat` with `wasm-tools` |

The `-d8.js` hosts are the same experiments ported to `d8`: `readbuffer`,
`new Worker(src, {type: 'string'})`, blocking `getMessage`.

## Caveats

- The declared `maximum` matters, and it is not an architecture difference: at
  `maximum: 4096` pages the trap form did not reproduce on any machine tried,
  arm64 included; at `maximum: 65536` it reproduces on all of them, arm64
  included. The modules here use 65536, as the napi-rs loader does.
- The trap form is a race: deterministic on illumos and on `d8` canary,
  probabilistic elsewhere until the iteration count is raised.
- Licensed 0BSD so that any of this can be lifted verbatim into an engine's own
  test suite.
