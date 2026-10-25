// DELCC_LAYOUT ("baseplate" | "wip") is read via option_env! in main.rs.
// option_env! is NOT tracked by cargo — without this, changing the env var
// between builds yields a stale cached binary ("Finished" without recompiling).
fn main() {
    println!("cargo:rerun-if-env-changed=DELCC_LAYOUT");
    tauri_build::build()
}
