#!/usr/bin/env bash
set -euo pipefail

contracts_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname -- "$contracts_root")"
if [[ "${RAZOR_CONTRACT_BUILD_GUARDED:-}" != "1" ]]; then
  cd "$project_root"
  exec node "$project_root/scripts/next-with-memory-guard.mjs" contracts-check "$@"
fi
if (( $# > 1 )); then printf 'Usage: bash contracts/check.sh [baseline-artifact-directory]\n' >&2; exit 1; fi
artifact_dir="$project_root/.tools/wasm"
if [[ ! -f "$artifact_dir/razor_treasury.wasm" ]]; then printf 'Build the optimized artifacts with contracts/build.sh first.\n' >&2; exit 1; fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$project_root/.tools/cargo-target}"
export RAZOR_TREASURY_WASM="$artifact_dir/razor_treasury.wasm"
for contract in razor-treasury razor-clearing razor-billing; do
  cargo test --locked --jobs 1 --manifest-path "$contracts_root/$contract/Cargo.toml" --lib
done
if (( $# == 0 )); then
  cargo run --locked --jobs 1 --manifest-path "$contracts_root/wasm-checks/Cargo.toml" -- --shared "$artifact_dir"
else
  cargo run --locked --jobs 1 --manifest-path "$contracts_root/wasm-checks/Cargo.toml" -- "$1" "$artifact_dir"
fi
