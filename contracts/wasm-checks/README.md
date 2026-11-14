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

Compare two builds of the current shared architecture with:

```sh
RAYON_NUM_THREADS=1 CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR="$PWD/.tools/cargo-target" cargo run --locked --jobs 1 --manifest-path contracts/wasm-checks/Cargo.toml -- --shared-compare /absolute/baseline-directory /absolute/optimized-directory
```

Each directory must contain `razor_treasury.wasm`, `razor_clearing.wasm` and `razor_billing.wasm` from the same contract revision and ABI. A factory is not required. Run this only when no other contract build, application build or development server is active. The existing `--shared DIRECTORY` mode still checks one current build, and `contracts/check.sh BASELINE` keeps its historical four-artifact behavior.

The shared comparator executes the same shared treasury, standing mandate, claim distribution, shared clearing, cash-backed clearing and billing scenarios against both artifacts. Every call must preserve return bytes and return kind, errors, raw event logs, promise actions and exact persisted trie contents. Host imports and exported function signatures must match. Existing scenario assertions still check financial counters, company authority, duplicate/callback replay handling and unresolved-transfer holds. This covers these fixtures, not every possible input or a complete network simulation.

The JSON report identifies each artifact by bytes and SHA-256 and includes each call's burnt gas, used gas and committed storage delta, with candidate-minus-baseline changes and scenario execution totals. Gas values are decimal strings in raw gas units; divide by `1000000000000` for Tgas. Burnt gas comes from the local VM outcome, including contract loading and host execution. Used gas also reserves gas for promise actions, so its sum across calls and supplied callbacks is not a network bill. Failed calls roll back storage and report zero committed storage change. The mock's initial storage is code size plus 100 bytes; only that initial code-size baseline may differ. State storage changes must remain identical. These measurements exclude deployment transactions, live gas prices, actual token execution, solver activity and network scheduling. They are local pinned-runtime comparison evidence, not measured mainnet gas or a deployment-cost quote.

The old two-directory comparator remains available for historical isolated-architecture artifacts. It expects all four legacy files, including a factory, with their old ABI. Do not compare the old isolated contract against shared_v1 using that mode: this change intentionally replaces the public JSON ABI and storage layout.

The runtime uses the mainnet configuration store requested at protocol 88. The pinned SDK runtime package's latest known configuration before 88 is version 84. This is local compatibility evidence, not an execution on a live network or a measured mainnet gas bill. Official mock storage handles the local trie; callback outcomes are supplied explicitly. Cross-contract promise actions are compared rather than sent, and no funds move. Native financial unit checks and real deployment verification remain separate.
