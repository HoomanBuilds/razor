#!/usr/bin/env bash
set -euo pipefail

contracts_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname -- "$contracts_root")"
build_target="${CARGO_TARGET_DIR:-$project_root/.tools/cargo-target}"
artifact_dir="$project_root/.tools/wasm"
mkdir -p "$artifact_dir" "$build_target"
build_target="$(cd -- "$build_target" && pwd)"

CARGO_TARGET_DIR="$build_target" cargo build --locked --jobs 1 --manifest-path "$contracts_root/razor-treasury/Cargo.toml" --target wasm32-unknown-unknown --release
treasury_wasm="$build_target/wasm32-unknown-unknown/release/razor_treasury.wasm"
RAZOR_TREASURY_WASM="$treasury_wasm" CARGO_TARGET_DIR="$build_target" cargo build --locked --jobs 1 --manifest-path "$contracts_root/razor-factory/Cargo.toml" --target wasm32-unknown-unknown --release
cp "$treasury_wasm" "$artifact_dir/razor_treasury.wasm"
cp "$build_target/wasm32-unknown-unknown/release/razor_factory.wasm" "$artifact_dir/razor_factory.wasm"
CARGO_TARGET_DIR="$build_target" cargo build --locked --jobs 1 --manifest-path "$contracts_root/razor-clearing/Cargo.toml" --target wasm32-unknown-unknown --release
cp "$build_target/wasm32-unknown-unknown/release/razor_clearing.wasm" "$artifact_dir/razor_clearing.wasm"
node "$project_root/scripts/contract-manifest.mjs"
printf 'Built treasury, factory and clearing artifacts in %s\n' "$artifact_dir"
