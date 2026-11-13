use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let source = env::var_os("RAZOR_TREASURY_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            manifest
                .join("../razor-treasury/target/wasm32-unknown-unknown/release/razor_treasury.wasm")
        });
    println!("cargo:rerun-if-env-changed=RAZOR_TREASURY_WASM");
    println!("cargo:rerun-if-changed={}", source.display());
    let code = fs::read(&source).unwrap_or_else(|error| {
        panic!(
            "Build the treasury first with contracts/build.sh or set RAZOR_TREASURY_WASM: {error}"
        )
    });
    assert!(
        code.starts_with(b"\0asm\x01\0\0\0"),
        "Treasury artifact must be a WebAssembly module"
    );
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("treasury.wasm"),
        code,
    )
    .unwrap();
}
