# `memory.size` returns a stale size on shared memory for agents that did not grow it

Four agents grow a shared WebAssembly memory 1000 times each, pass an atomic
barrier — so all 4000 grows are provably complete — and then read
`memory.size`. Most of them report an old size.

```sh
ITERS=1000 node size.js
#   real size: 4016 pages   |  agent 0 sees 3016 (-1000), agent 1 sees 4016 (exact),
#                              agent 2 sees 3016 (-1000), agent 3 sees 3970 (-46)
#   verdict: 3 of 4 agents see a STALE size, worst gap 1000 pages
```

**Expected:** every agent's `memory.size` returns 4016.
**Actual:** 3 of 4 return less — by up to 1318 pages (84 MB).

No flags, no Rust, no toolchain: one 1157-byte hand-written module and a 30-line
host. The `.wasm` files are committed so that a clone runs immediately; the
`.wat` sources and `regenerate.sh` are there for reading and rebuilding.

`memory.grow` and `memory.size` are [specified sequentially
consistent](https://github.com/WebAssembly/threads/blob/main/proposals/threads/Overview.md);
the barrier orders all grows before the size query; the returned value is
therefore required to be the final size.

## Tracked upstream

Both findings are open V8 issues, filed in mid-2026 by V8 and emscripten
engineers — this repository is the reduced reproduction, not the report:

- [**533026477**](https://issues.chromium.org/issues/533026477) —
  *`memory.size` should be an atomic operation maintaining sequential
  consistency*: for memory 0, V8 reads a copy of the size field out of
  `WasmTrustedInstanceData`, which is only refreshed from other threads at
  interrupts.
- [**529880019**](https://issues.chromium.org/issues/529880019) —
  *Cross-worker memory growth not observable with
  `--wasm-enforce-bounds-checks`*: the aggravated form below. Root cause
  diagnosed there as Turboshaft's load elimination caching the memory base and
  size across the loop stack check, which was annotated as non-writing.

That second diagnosis explains three things measured here: why the optimising
tier fails more than the baseline one, why a call into a JS import refreshes the
bound where a thousand internal wasm calls do not, and why `memory.grow 0` — a
writing operation — refreshes it.

Both were **still reproducing in September 2026 on an official canary `d8`
(V8 15.6.3)**, after a fix had landed for each; the measurements below are
attached as comments on both issues.

## Measured

| Platform | Engine | agents reporting a stale size | worst gap |
|---|---|---|---|
| macOS arm64 | Node 26.8.2 — V8 14.6.202.34 | 3 of 4 | 138 pages (8.8 MB) |
| Alpine 3.18 musl x64 | Node 24.21.0 — V8 13.6.233.17 | 2–3 of 4 | **1318 pages (84 MB)** |
| Alpine 3.18 musl x64 | Node 26.8.2 — V8 14.6.202.34 | 3 of 4 | 1000 pages (64 MB) |
| OmniOS r151058 x64 (illumos, 8 vCPU) | Node 24.21.0 — V8 13.6.233.17 | 3 of 4 | 1 page |
| OmniOS r151058 x64 (illumos, **bare metal**, Xeon E-2224, 4 cores) | Node 24.21.0 — V8 13.6.233.17 | 3 of 4 | — |
| macOS arm64 | **`d8` V8 15.6.3 canary** | **3 of 4** | 124 pages |

The barrier spins on `i32.atomic.load` only — no futex wait, no crossing into
JS — so this is not a race with an in-flight grow. Each agent also records the
size it saw at its *own* last grow; those two values differ for 1 to 3 agents
per run, so the stale value is a snapshot from some earlier point, not "the size
at my last grow".

## Aggravated form: spurious out-of-bounds traps

Where bounds are checked explicitly instead of by guard pages plus a trap
handler, the same stale state makes ordinary accesses trap. An agent writes at a
base another agent published through `i32.atomic.store` and that it read back
through `i32.atomic.load`:

```sh
FN=othersOnly ITERS=4000 node --disable-wasm-trap-handler traps.js   # traps
FN=othersOnly ITERS=4000 node traps.js                              # passes
FN=ownOnly    ITERS=4000 node --disable-wasm-trap-handler traps.js  # passes
```

| Configuration | `othersOnly` | `ownOnly` |
|---|---|---|
| Alpine x64, Node 24.21.0, default | 3 OK / 3 | 3 OK / 3 |
| Alpine x64, Node 24.21.0, `--disable-wasm-trap-handler` | **5 fail / 5** | 3 OK / 3 |
| Alpine x64, Node 26.8.2, `--disable-wasm-trap-handler` | **3 fail / 5** | 3 OK / 3 |
| OmniOS r151058 x64, default (no trap handler on this platform) | **5 fail / 5** | **5 OK / 5** |
| OmniOS r151058 x64 (**bare metal**, 4 cores), default | **5 fail / 5** | **5 OK / 5** |
| macOS arm64, Node 26.8.2, `--disable-wasm-trap-handler` | **3 fail / 5** | **5 OK / 5** |
| `d8` V8 15.6.3 arm64, `--wasm-enforce-bounds-checks` (`ITERS=2000`) | **3 fail / 3** | **3 OK / 3** |

`ownOnly` never fails: the agent that performs the grow does observe the new
size. Only the other agents keep the stale bound.

That path is not exotic:
[`--disable-wasm-trap-handler`](https://nodejs.org/api/cli.html#--disable-wasm-trap-handler)
is documented since Node v20.15.0 / v22.2.0, and **Node 26 takes it by itself**
when there is not enough virtual address space at startup to allocate one cage
(~8 GB per wasm memory instance) — the documented behaviour under `ulimit -v`
and in constrained containers.

With the trap handler, accesses into the grown region succeed because the pages
are committed; only `memory.size` reveals the stale state.

## `memory.grow 0` refreshes the bound

`othersGrow0` is `othersOnly` with a single `memory.grow 0` inserted between the
atomic load of the base and the access.

| | `othersOnly` | `othersGrow0` |
|---|---|---|
| OmniOS x64, default | **5 fail / 5** | **5 OK / 5** |
| Alpine x64, `--wasm-enforce-bounds-checks` | **5 fail / 5** | **5 OK / 5** |
| macOS arm64, `--disable-wasm-trap-handler` | 3 fail / 5 | **5 OK / 5** |

A zero-page grow refreshes the cached bound exactly as a real grow does. It is
the only in-wasm mechanism found that does — `memory.size` does not.

## Where the stale value lives

`instrumented.wat` / `instrumented.js` add instrumented variants.

| Variant | Inserted between the atomic load of the base and the access | Result |
|---|---|---|
| `othersSizeLog` | records `memory.size` and the target base | base is exactly `memory.size × 65536` — bounds check and `memory.size` agree, both stale |
| `othersNoop` | 1000 calls to an empty **wasm** function | still fails |
| `othersImport` | one call to an imported **JS** function | **passes**, 5 runs of 5 on two engines |
| `othersGrow0` | `memory.grow 0` | **passes**, 5 runs of 5 on three platforms |

So the cached size is refreshed when the agent itself grows — even by zero
pages — and when execution re-enters from JS; by nothing else reachable from
wasm.

Both compiler tiers are affected: `--liftoff-only` fails 2 of 3 runs on illumos
and 1 of 3 on Linux, `--no-liftoff` 3 of 3 on both. TurboFan fails more often
than Liftoff, but Liftoff fails too.

## Negative control

`control.js` / `control-single-grow.wat` is the simple case: one grow, one
`memory.atomic.wait32`, one read, in three variants (straight-line read, with a
`call` inserted, with `memory.size` inserted).

```sh
node control.js v1   # and v2, v3
```

It **passes everywhere**, with and without flags, on every platform above. That
is what shows the defect needs concurrent growth by several agents, not growth
alone.

## Files

| | |
|---|---|
| `repro.wat` / `repro.wasm` | the one module: `sizeReport`, `ownOnly`, `othersOnly`, `othersNoop`, `othersSize`, `othersGrow0` |
| `size.js` / `size-d8.js` | finding 1 — stale `memory.size`, no flag |
| `traps.js` / `traps-d8.js` | finding 2 — `FN=<export> ITERS=<n>` |
| `instrumented.wat` / `instrumented.js` | instrumented variants (needs a JS import, hence a separate module) |
| `control-single-grow.wat` / `control.js` | negative control: a single grow |
| `minimal-size.wat` | finding 1 alone, reduced to **182 bytes** |
| `regenerate.sh` | rebuild every `.wasm` from its `.wat` with `wasm-tools` |

The `-d8.js` hosts are the same experiments ported to `d8`: `readbuffer`,
`new Worker(src, {type: 'string'})`, blocking `getMessage`.

## Authors

Measurements and reduction by **rosekanari**, with **Claude Code** (Anthropic)
co-authoring the harnesses, the reduction from a real build failure down to this
module, and this write-up. Both are named as co-authors on the commits.

## Caveats

- The declared `maximum` matters, and it is not an architecture difference: at
  `maximum: 4096` pages the trap form did not reproduce on any machine tried,
  arm64 included; at `maximum: 65536` it reproduces on all of them. The modules
  here use 65536, as the napi-rs loader does.
- The trap form is a race: deterministic on illumos with V8 13.6, probabilistic
  elsewhere until the iteration count is raised. The stale `memory.size` of
  finding 1 shows up on every run everywhere.
- Licensed 0BSD so that any of this can be lifted verbatim into an engine's own
  test suite.
