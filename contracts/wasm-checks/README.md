# Built Wasm compatibility checks

This developer tool executes the actual built contract binaries through the pinned official NEAR VM runner and its Wasmtime backend. It is separate from the application and native SDK unit tests.

Build the three shared-architecture artifacts, then run the guarded checks:

```sh
bash contracts/build.sh
bash contracts/check.sh
```

The check script runs native financial checks and then the actual-WASM shared scenarios under the same memory guard. For an explicitly serialized standalone run:

```sh
RAYON_NUM_THREADS=1 CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR="$PWD/.tools/cargo-target" cargo run --locked --jobs 1 --manifest-path contracts/wasm-checks/Cargo.toml -- --shared .tools/wasm
```

The shared treasury scenarios execute owner-bound company registration, duplicate rejection, authenticated funding, company-specific deposit proofs, cross-company authorization failure and failed-withdrawal callback replay. Shared clearing initialization and owner controls are checked, along with the existing signed billing collection/refund scenarios. External token callback outcomes are supplied explicitly, rather than running a full token or solver network.

The old two-directory comparator remains available for historical isolated-architecture artifacts. It expects all four legacy files, including a factory, with their old ABI. Do not compare the old isolated contract against shared_v1 using that mode: this change intentionally replaces the public JSON ABI and storage layout.

The runtime uses the mainnet configuration store requested at protocol 88. The pinned SDK runtime package's latest known configuration before 88 is version 84. This is local compatibility evidence, not an execution on a live network or a measured mainnet gas bill. Official mock storage handles the local trie; callback outcomes are supplied explicitly. Cross-contract promise actions are compared rather than sent, and no funds move. Native financial unit checks and real deployment verification remain separate.
