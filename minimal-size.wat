(module
  (import "env" "memory" (memory 16 65536 shared))
  ;; Phase 1: each agent grows the memory $iters times.
  ;; Barrier: atomic counter at address 200, waited on with atomic loads
  ;;          only (no futex wait, no JS boundary).
  ;; Phase 2: each stores what memory.size returns, at 128+8*id.
  (func (export "sizeReport") (param $id i32) (param $iters i32) (result i32)
    (local $i i32) (local $old i32)
    (loop $L
      (local.set $old (memory.grow (i32.const 1)))
      (if (i32.eq (local.get $old) (i32.const -1)) (then (return (i32.const 2))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $L (i32.lt_u (local.get $i) (local.get $iters))))
    (drop (i32.atomic.rmw.add (i32.const 200) (i32.const 1)))
    (loop $B
      (br_if $B (i32.lt_u (i32.atomic.load (i32.const 200)) (i32.const 4))))
    (i32.store (i32.add (i32.const 128) (i32.mul (local.get $id) (i32.const 8))) (memory.size))
    (i32.const 0)))
