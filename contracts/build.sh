#!/usr/bin/env bash
set -euo pipefail

contracts_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname -- "$contracts_root")"
build_target="${CARGO_TARGET_DIR:-$project_root/.tools/cargo-target}"
artifact_dir="$project_root/.tools/wasm"
mkdir -p "$artifact_dir" "$build_target"
build_target="$(cd -- "$build_target" && pwd)"

CARGO_TARGET_DIR="$build_target" cargo build --locked --jobs 1 --manifest-path "$contracts_root/float-treasury/Cargo.toml" --target wasm32-unknown-unknown --release
treasury_wasm="$build_target/wasm32-unknown-unknown/release/float_treasury.wasm"
FLOAT_TREASURY_WASM="$treasury_wasm" CARGO_TARGET_DIR="$build_target" cargo build --locked --jobs 1 --manifest-path "$contracts_root/float-factory/Cargo.toml" --target wasm32-unknown-unknown --release
cp "$treasury_wasm" "$artifact_dir/float_treasury.wasm"
cp "$build_target/wasm32-unknown-unknown/release/float_factory.wasm" "$artifact_dir/float_factory.wasm"
printf 'Built treasury and factory artifacts in %s\n' "$artifact_dir"
