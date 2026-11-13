# Built Wasm compatibility checks

This optional developer tool executes the actual baseline and optimized contract binaries through the pinned official NEAR VM runner and its Wasmtime backend. It is separate from the application and from native SDK unit tests.

Capture a complete baseline directory before changing the contract build. Build all four optimized artifacts, including the factory with its optimized treasury embedded. Then run from the repository root:

```sh
RAYON_NUM_THREADS=1 CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR="$PWD/.tools/cargo-target" cargo run --locked --jobs 1 --manifest-path contracts/wasm-checks/Cargo.toml -- .tools/wasm-size-baseline .tools/wasm
```

Use the repository's compiler serialization rules and check available memory first. The tool refuses to run without the single-thread Rayon setting. Each directory must contain `razor_treasury.wasm`, `razor_factory.wasm`, `razor_clearing.wasm` and `razor_billing.wasm`.

The checks compare exported function signatures, compatible host imports, parsed JSON returns and events, promise actions and binary stored state. Scenarios cover initializer reentry, treasury owner controls, funded approval, duplicate obligations, spending limits and pause; factory embedded treasury identity and recalculated creation deposits; clearing storage/pause behavior; signed billing collection, excess/duplicate returns, forged signatures and refund callback replay.

Factory code hashes and treasury creation prices are expected to change with the embedded artifact. The tool independently checks each artifact's expected hash and deposit formula while comparing the remaining behavior.

The runtime uses the mainnet configuration store requested at protocol 88. The pinned SDK runtime package's latest known configuration before 88 is version 84. This is local compatibility evidence, not an execution on a live network or a measured mainnet gas bill. Official mock storage handles the local trie; callback outcomes are supplied explicitly. Cross-contract promise actions are compared rather than sent, and no funds move. Native financial unit checks and real deployment verification remain separate.
