#!/bin/sh
# The .wasm files are committed so that a clone runs with one command.
# Regenerate them from the .wat sources with wasm-tools (any recent version):
set -eu
for f in grow stress3 stress4 stress5; do
  wasm-tools parse "$f.wat" -o "$f.wasm"
  wasm-tools validate "$f.wasm"
  echo "$f.wasm  $(wc -c < "$f.wasm") bytes"
done
