#!/usr/bin/env bash
set -euo pipefail

contracts_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname -- "$contracts_root")"
if [[ "${RAZOR_CONTRACT_BUILD_GUARDED:-}" != "1" ]]; then
  cd "$project_root"
  exec node "$project_root/scripts/next-with-memory-guard.mjs" contracts "$@"
fi

optimizer="${WASM_OPT:-wasm-opt}"
optimizer_version="$("$optimizer" --version)"
if [[ ! "$optimizer_version" =~ ^wasm-opt\ version\ 130([[:space:]]|$) ]]; then
  printf 'Install Binaryen wasm-opt version 130, or set WASM_OPT to that executable. Found: %s\n' "$optimizer_version" >&2
  exit 1
fi

build_target="${CARGO_TARGET_DIR:-$project_root/.tools/cargo-target}"
artifact_dir="$project_root/.tools/wasm"
mkdir -p "$artifact_dir" "$build_target"
build_target="$(cd -- "$build_target" && pwd)"
staging_dir="$(mktemp -d "$artifact_dir/.build.XXXXXX")"
trap 'rm -rf -- "$staging_dir"' EXIT

optimize() {
  local extra=()
  # Deployment checks need the embedded treasury bytes to stay contiguous.
  if [[ "$1" == "razor_factory.wasm" ]]; then extra+=(--skip-pass=memory-packing); fi
  BINARYEN_CORES=1 "$optimizer" "$build_target/wasm32-unknown-unknown/release/$1" -Oz --strip-debug --strip-producers "${extra[@]}" -o "$staging_dir/$1"
}

CARGO_TARGET_DIR="$build_target" cargo build --locked --jobs 1 --manifest-path "$contracts_root/razor-treasury/Cargo.toml" --target wasm32-unknown-unknown --release
optimize razor_treasury.wasm
treasury_wasm="$staging_dir/razor_treasury.wasm"
RAZOR_TREASURY_WASM="$treasury_wasm" CARGO_TARGET_DIR="$build_target" cargo build --locked --jobs 1 --manifest-path "$contracts_root/razor-factory/Cargo.toml" --target wasm32-unknown-unknown --release
optimize razor_factory.wasm
CARGO_TARGET_DIR="$build_target" cargo build --locked --jobs 1 --manifest-path "$contracts_root/razor-clearing/Cargo.toml" --target wasm32-unknown-unknown --release
optimize razor_clearing.wasm
CARGO_TARGET_DIR="$build_target" cargo build --locked --jobs 1 --manifest-path "$contracts_root/razor-billing/Cargo.toml" --target wasm32-unknown-unknown --release
optimize razor_billing.wasm
WASM_OPT_BUILD_VERSION="$optimizer_version" node "$project_root/scripts/contract-manifest.mjs" "$staging_dir"
for file in razor_treasury.wasm razor_factory.wasm razor_clearing.wasm razor_billing.wasm manifest.json; do
  mv -- "$staging_dir/$file" "$artifact_dir/$file"
done
printf 'Built and optimized treasury, factory, clearing and billing artifacts in %s\n' "$artifact_dir"
