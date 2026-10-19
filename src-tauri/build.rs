fn main() {
    #[cfg(feature = "desktop")]
    {
        // Icons are embedded by generate_context!, so changing them must also
        // invalidate Cargo's build cache, including macOS development Dock icons.
        println!("cargo:rerun-if-changed=icons");
        tauri_build::build();
    }
}
