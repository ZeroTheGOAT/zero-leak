
#[cfg(test)]
mod resolution {
    use crate::registry::default_sandbox_policy;

    /// Names the command interpreter implements itself. None of them is a file
    /// anywhere on disk, so none can be spawned, so none can be honestly
    /// advertised by a sandbox that has no interpreter to reach them through.
    /// `type` and `dir` were both on the default list; this is what would have
    /// caught them.
    const BUILTINS: &[&str] = &[
        "assoc", "call", "cd", "chdir", "cls", "color", "copy", "date", "del", "dir", "echo",
        "endlocal", "erase", "exit", "for", "ftype", "goto", "if", "md", "mkdir", "move", "path",
        "pause", "popd", "prompt", "pushd", "rd", "rem", "ren", "rename", "rmdir", "set",
        "setlocal", "shift", "start", "time", "title", "type", "ver", "verify", "vol",
    ];

    #[test]
    fn no_default_allow_list_entry_is_an_interpreter_builtin() {
        let p = default_sandbox_policy();
        let bad: Vec<&String> = p
            .allowed_commands
            .iter()
            .filter(|c| BUILTINS.contains(&c.to_ascii_lowercase().as_str()))
            .collect();
        assert!(
            bad.is_empty(),
            "these cannot be started as processes and must not be advertised: {bad:?}"
        );
    }

    /// The deny list is checked before the allow list, so an entry on both is an
    /// entry that is advertised and then always refused. Cheaper to catch here
    /// than in a support call.
    #[test]
    fn nothing_is_both_allowed_and_denied() {
        let p = default_sandbox_policy();
        for a in &p.allowed_commands {
            assert!(
                super::refuse_reason(a, &p).is_none(),
                "'{a}' is on the allow list but its own policy refuses it: {:?}",
                super::refuse_reason(a, &p)
            );
        }
    }

    /// `tree` is the one that matters: it exists only as `tree.com`, so a lookup
    /// that appends `.exe` and stops — which is what Windows process creation
    /// does on its own — cannot find it. If this passes, the `PATHEXT` sweep is
    /// working; `findstr` and `where` would pass without it.
    #[test]
    fn windows_own_programs_resolve() {
        for name in ["findstr", "where", "tree"] {
            let hit = super::resolve_program(name);
            assert!(hit.is_some(), "{name} did not resolve on a Windows machine");
            assert!(hit.unwrap().is_file());
        }
    }

    #[test]
    fn a_name_that_already_has_its_extension_is_not_given_a_second_one() {
        let hit = super::resolve_program("findstr.exe").expect("findstr.exe resolves");
        let s = hit.to_string_lossy().to_ascii_lowercase();
        assert!(s.ends_with("findstr.exe"), "{s}");
    }

    #[test]
    fn a_program_that_is_not_installed_does_not_resolve() {
        assert!(super::resolve_program("sovereign-no-such-program-9f3a").is_none());
        assert!(super::resolve_program("").is_none());
    }

    /// The gap this closes: the chaining check used to look for an ampersand
    /// with spaces around it, and an ampersand without them chains just as well
    /// once a batch-file entry puts an interpreter in the path.
    #[test]
    fn an_ampersand_without_spaces_is_refused() {
        let p = default_sandbox_policy();
        let reason = super::refuse_reason("npm run build&whoami", &p)
            .expect("an unspaced ampersand must be refused");
        assert!(reason.contains('&'), "{reason}");
        // And the ordinary form still runs.
        assert!(super::refuse_reason("npm run build", &p).is_none());
    }
}
