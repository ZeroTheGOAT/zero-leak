// Required, not optional. `tauri_build::build()` is what compiles
// `capabilities/*.json` into the binary's access-control list and emits the
// Windows manifest and icon resources. Without this file the ACL is empty at
// runtime and every `listen()` from the frontend is denied.
fn main() {
    tauri_build::build()
}
