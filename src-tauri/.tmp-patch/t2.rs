
    /// npm is the case that made this necessary: `npm.cmd` and an extensionless
    /// `npm` shell script sit side by side, and picking the bare file gets "%1 is
    /// not a valid Win32 application" from Windows. The suffix list has to be
    /// consulted before the bare name, not after.
    #[test]
    fn a_sibling_with_an_extension_beats_the_bare_file() {
        let dir = std::env::temp_dir().join(format!("sovereign-resolve-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("probe"), b"#!/bin/sh\n").expect("bare");
        std::fs::write(dir.join("probe.cmd"), b"@echo off\n").expect("cmd");

        let hit = super::with_extension(&dir.join("probe")).expect("probe resolves");
        assert!(
            hit.to_string_lossy().to_ascii_lowercase().ends_with("probe.cmd"),
            "resolved to {hit:?}, which Windows cannot start"
        );

        // With no suffixed sibling, the bare file is still better than nothing —
        // process creation can run an extensionless executable even though the
        // interpreter would not have looked for one.
        std::fs::remove_file(dir.join("probe.cmd")).expect("cleanup");
        let bare = super::with_extension(&dir.join("probe")).expect("bare probe resolves");
        assert!(bare.to_string_lossy().ends_with("probe"), "{bare:?}");
    }

    #[test]
    fn the_extension_list_is_never_empty() {
        let exts = super::path_extensions();
        assert!(!exts.is_empty());
        assert!(exts.iter().all(|e| e.starts_with('.')), "{exts:?}");
    }
