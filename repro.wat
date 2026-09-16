(module
  ;; One module for the whole report. Shared memory, four agents, no imports.
  ;;   sizeReport  : finding 1 — memory.size returns a stale size (no flag needed)
  ;;   ownOnly     : control — each agent writes only into its own grown region
  ;;   othersOnly  : finding 2 — writing into a region another agent grew
  ;;   othersNoop  : othersOnly + 1000 internal wasm calls before the access
  ;;   othersSize  : othersOnly + memory.size before the access
  ;;   othersGrow0 : othersOnly + memory.grow 0 before the access
  ;; Control area in page 0: slots[id] at 64+4*id (published region base),
  ;; barrier counter at 200, sizeReport results at 128+8*id and 132+8*id.
  (import "env" "memory" (memory 16 65536 shared))
  (func $noop)

  ;; Phase 1: grow $iters times. Barrier: atomic counter at 200, waited on with
  ;; atomic loads only (no futex wait, no JS boundary). Phase 2: store what
  ;; memory.size returns, and the size this agent saw at its own last grow.
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
    (i32.store (i32.add (i32.const 128) (i32.mul (local.get $id) (i32.const 8)))
               (memory.size))
    (i32.store (i32.add (i32.const 132) (i32.mul (local.get $id) (i32.const 8)))
               (i32.add (local.get $old) (i32.const 1)))
    (i32.const 0))

  (func (export "ownOnly") (param $id i32) (param $iters i32) (result i32)
    (local $i i32) (local $old i32) (local $v i32)
    (loop $L
      (local.set $old (memory.grow (i32.const 1)))
      (if (i32.eq (local.get $old) (i32.const -1)) (then (return (i32.const 2))))
      (i32.store (i32.mul (local.get $old) (i32.const 65536)) (i32.const 48879))
      (local.set $v (i32.load (i32.mul (local.get $old) (i32.const 65536))))
      (if (i32.ne (local.get $v) (i32.const 48879)) (then (return (i32.const 3))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $L (i32.lt_u (local.get $i) (local.get $iters))))
    (i32.const 0))

  (func (export "othersOnly") (param $id i32) (param $iters i32) (result i32)
    (local $i i32) (local $old i32) (local $j i32) (local $base i32) (local $v i32)
    (loop $L
      (local.set $old (memory.grow (i32.const 1)))
      (if (i32.eq (local.get $old) (i32.const -1)) (then (return (i32.const 2))))
      (i32.atomic.store (i32.add (i32.const 64) (i32.mul (local.get $id) (i32.const 4)))
                        (i32.mul (local.get $old) (i32.const 65536)))
      (local.set $j (i32.const 0))
      (loop $M
        (if (i32.ne (local.get $j) (local.get $id))
          (then
            (local.set $base
              (i32.atomic.load (i32.add (i32.const 64) (i32.mul (local.get $j) (i32.const 4)))))
            (if (local.get $base)
              (then
                (i32.store (local.get $base) (i32.const 48879))
                (local.set $v (i32.load (local.get $base)))
                (if (i32.ne (local.get $v) (i32.const 48879)) (then (return (i32.const 3))))))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br_if $M (i32.lt_u (local.get $j) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $L (i32.lt_u (local.get $i) (local.get $iters))))
    (i32.const 0))

  (func (export "othersNoop") (param $id i32) (param $iters i32) (result i32)
    (local $i i32) (local $old i32) (local $j i32) (local $base i32) (local $v i32) (local $k i32)
    (loop $L
      (local.set $old (memory.grow (i32.const 1)))
      (if (i32.eq (local.get $old) (i32.const -1)) (then (return (i32.const 2))))
      (i32.atomic.store (i32.add (i32.const 64) (i32.mul (local.get $id) (i32.const 4)))
                        (i32.mul (local.get $old) (i32.const 65536)))
      (local.set $j (i32.const 0))
      (loop $M
        (if (i32.ne (local.get $j) (local.get $id))
          (then
            (local.set $base
              (i32.atomic.load (i32.add (i32.const 64) (i32.mul (local.get $j) (i32.const 4)))))
            (if (local.get $base)
              (then
                (local.set $k (i32.const 0))
                (loop $N
                  (call $noop)
                  (local.set $k (i32.add (local.get $k) (i32.const 1)))
                  (br_if $N (i32.lt_u (local.get $k) (i32.const 1000))))
                (i32.store (local.get $base) (i32.const 48879))
                (local.set $v (i32.load (local.get $base)))
                (if (i32.ne (local.get $v) (i32.const 48879)) (then (return (i32.const 3))))))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br_if $M (i32.lt_u (local.get $j) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $L (i32.lt_u (local.get $i) (local.get $iters))))
    (i32.const 0))

  (func (export "othersSize") (param $id i32) (param $iters i32) (result i32)
    (local $i i32) (local $old i32) (local $j i32) (local $base i32) (local $v i32)
    (loop $L
      (local.set $old (memory.grow (i32.const 1)))
      (if (i32.eq (local.get $old) (i32.const -1)) (then (return (i32.const 2))))
      (i32.atomic.store (i32.add (i32.const 64) (i32.mul (local.get $id) (i32.const 4)))
                        (i32.mul (local.get $old) (i32.const 65536)))
      (local.set $j (i32.const 0))
      (loop $M
        (if (i32.ne (local.get $j) (local.get $id))
          (then
            (local.set $base
              (i32.atomic.load (i32.add (i32.const 64) (i32.mul (local.get $j) (i32.const 4)))))
            (if (local.get $base)
              (then
                (drop (memory.size))
                (i32.store (local.get $base) (i32.const 48879))
                (local.set $v (i32.load (local.get $base)))
                (if (i32.ne (local.get $v) (i32.const 48879)) (then (return (i32.const 3))))))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br_if $M (i32.lt_u (local.get $j) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $L (i32.lt_u (local.get $i) (local.get $iters))))
    (i32.const 0))

  (func (export "othersGrow0") (param $id i32) (param $iters i32) (result i32)
    (local $i i32) (local $old i32) (local $j i32) (local $base i32) (local $v i32)
    (loop $L
      (local.set $old (memory.grow (i32.const 1)))
      (if (i32.eq (local.get $old) (i32.const -1)) (then (return (i32.const 2))))
      (i32.atomic.store (i32.add (i32.const 64) (i32.mul (local.get $id) (i32.const 4)))
                        (i32.mul (local.get $old) (i32.const 65536)))
      (local.set $j (i32.const 0))
      (loop $M
        (if (i32.ne (local.get $j) (local.get $id))
          (then
            (local.set $base
              (i32.atomic.load (i32.add (i32.const 64) (i32.mul (local.get $j) (i32.const 4)))))
            (if (local.get $base)
              (then
                (drop (memory.grow (i32.const 0)))
                (i32.store (local.get $base) (i32.const 48879))
                (local.set $v (i32.load (local.get $base)))
                (if (i32.ne (local.get $v) (i32.const 48879)) (then (return (i32.const 3))))))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br_if $M (i32.lt_u (local.get $j) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $L (i32.lt_u (local.get $i) (local.get $iters))))
    (i32.const 0)))
