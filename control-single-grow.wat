(module
  (import "env" "memory" (memory 16 64 shared))

  (func $noop)

  (func (export "grow") (param i32) (result i32)
    local.get 0
    memory.grow)

  (func (export "size") (result i32)
    memory.size)

  (func (export "write") (param $a i32) (param $v i32)
    local.get $a
    local.get $v
    i32.store)

  (func (export "publish") (param $f i32)
    local.get $f
    i32.const 1
    i32.atomic.store
    local.get $f
    i32.const 1
    memory.atomic.notify
    drop)

  ;; V1: atomic wait then read, straight line
  (func (export "v1") (param $f i32) (param $a i32) (param $out i32) (result i32)
    local.get $f
    i32.const 0
    i64.const -1
    memory.atomic.wait32
    drop
    local.get $a
    i32.load)

  ;; V2: a function call (hence a stack check) before the read
  (func (export "v2") (param $f i32) (param $a i32) (param $out i32) (result i32)
    local.get $f
    i32.const 0
    i64.const -1
    memory.atomic.wait32
    drop
    call $noop
    local.get $a
    i32.load)

  ;; V3: memory.size before the read, result stored at $out
  (func (export "v3") (param $f i32) (param $a i32) (param $out i32) (result i32)
    local.get $f
    i32.const 0
    i64.const -1
    memory.atomic.wait32
    drop
    local.get $out
    memory.size
    i32.store
    local.get $a
    i32.load)
)
