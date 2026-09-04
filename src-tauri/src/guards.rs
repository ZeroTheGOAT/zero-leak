//! Operator-authored safety guardrails.
//!
//! The workbench already has two unconditional fences: file tools can only
//! reach inside an approved workspace (`fsops::resolve`), and commands run
//! behind the sandbox's allow list and deny list (`sandbox::refuse_reason`).
//! What neither can express is an operator's *own* red lines — "the models
//! folder is never to be written", "nothing may ever run a command with
//! `--force` in it" — because those are per-workstation policy, not per-call
//! risk.
//!
//! This module is the evaluation of those rules, and the design rule it
//! follows is the one the rest of the harness runs on: **refuse, name the
//! rule, and change nothing**. A refused call is a tool result the model
//! reads, so it can stop and say what it was blocked from; it is not a crash,
//! and it is not a silent skip.
//!
//! Ordering matters and is fixed: guardrails run **before** the approval
//! gate. An operator granting "allow for session" on `write_file` cannot
//! thereby unlock a path the guardrails protect, because the rule is checked
//! first and never consults the grant table. Guardrails are the floor under
//! the approval system, not a peer of it.
//!
//! Rules are read from settings on every check, for the same reason
//! `sandbox::policy` re-reads them: the list the Settings page shows has to
//! be the list the very next call is judged by.

use crate::state::AppState;
use crate::types::{GuardRule, GuardRuleEntry};

/// One refusal, ready to be worded for whoever asked. Owns a clone of the
/// matched entry, so the message can be built after the settings snapshot
/// is released.
pub struct Refusal {
    pub entry: GuardRuleEntry,
}

impl Refusal {
    /// The message the model and the operator see. Names the rule and its
    /// note, and says what to do instead — a refusal that does not say why
    /// gets retried, and one that does not say what to do instead gets
    /// workaround attempts.
    pub fn message(&self, action: &str) -> String {
        let mut s = format!(
            "Refused by the safety rule \"{}\": {} {}.",
            self.entry.name,
            action,
            match &self.entry.rule {
                GuardRule::ProtectPath { pattern } => {
                    format!("would have touched the protected folder {pattern}")
                }
                GuardRule::ForbidCommand { pattern } => {
                    format!("matched the forbidden pattern '{pattern}'")
                }
            }
        );
        if !self.entry.note.trim().is_empty() {
            s.push_str(&format!(" {}", self.entry.note.trim()));
        }
        s.push_str(
            " This rule is set by the operator and cannot be worked around in the run; say what \
             you were blocked from and continue without it, or ask the operator to change the \
             rule in Settings.",
        );
        s
    }
}

/// The active rules, in the order the operator listed them. First match
/// refuses; ordering is stable so the refusal always names the same rule for
/// the same call.
fn active(st: &AppState) -> Vec<GuardRuleEntry> {
    st.settings()
        .guard_rules
        .iter()
        .filter(|g| g.enabled)
        .cloned()
        .collect()
}

/// Normalises a Windows path for comparison: forward slashes, no extended
/// prefix, case-folded, and no trailing separator — so `C:\Work`,
/// `c:/work/`, and `\\?\C:\Work` are the same folder.
fn normalise_path(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    if let Some(stripped) = s.strip_prefix("//?/") {
        s = stripped.to_string();
    }
    // Every trailing separator goes, the drive root included: `D:\` has to
    // normalise to `d:`, the same as `D:`, or the boundary test below sees a root
    // of `d:/` and asks whether `d:/work/x.txt` continues with a *second* slash.
    // It does not, so a rule an operator wrote as `D:\` — the spelling a folder
    // picker returns for a drive — listed itself as active and protected nothing
    // on the drive. Only a lone `/` is kept, because turning a root into the
    // empty string would silently mean "protects nothing".
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    // Full case folding, not ASCII: a protected folder named `Ölçüm` or `ЦЕХ`
    // must match whatever case the model writes it in, which is what the
    // "case-folded" promise above is worth.
    s.to_lowercase()
}

/// Whether `target` lies under the protected folder `root`.
///
/// A separator boundary is required: `C:/project` protects
/// `C:/project/src/main.rs` and `C:/project` itself, but not
/// `C:/project2/notes.md`. Without the boundary, protecting `models` would
/// also protect a sibling directory that merely begins with those letters.
pub fn path_protected(target: &str, root: &str) -> bool {
    let t = normalise_path(target);
    let r = normalise_path(root);
    if r.is_empty() {
        return false;
    }
    if t == r {
        return true;
    }
    // A root like "c:" (the drive itself) protects everything on it; the
    // boundary then has to be the character after the colon.
    t.starts_with(&r) && t[r.len()..].starts_with('/')
}

/// Whether command text matches a forbidden pattern, using the sandbox deny
/// list's own conventions: a single word has to match as a word (so `del`
/// does not refuse `delete-me.txt`), a phrase or anything containing a
/// metacharacter is matched as a substring, since the space or dash was put
/// in the pattern on purpose.
///
/// For a single word the split excludes `-` from the separator set for the
/// *command* only after first splitting flags off it: an operator who
/// forbids `force` means `--force` too. The split therefore treats `-` as a
/// separator, which makes `--force` yield `force` as a word while
/// `forcefully` still does not match.
pub fn command_matches(command: &str, pattern: &str) -> bool {
    let p = pattern.trim().to_ascii_lowercase();
    if p.is_empty() {
        return false;
    }
    let lower = command.to_ascii_lowercase();
    if p.contains(' ') || p.contains('-') || p.contains('/') || p.contains('\\') {
        lower.contains(&p)
    } else {
        lower
            .split(|c: char| !c.is_alphanumeric() && c != '.' && c != '_')
            .any(|w| w == p)
    }
}

/// Checks a write target (an absolute path) against the active path rules.
pub fn check_path(st: &AppState, target: &str) -> Option<Refusal> {
    active(st).into_iter().find_map(|g| match &g.rule {
        GuardRule::ProtectPath { pattern } if path_protected(target, pattern) => {
            Some(Refusal { entry: g.clone() })
        }
        _ => None,
    })
}

/// Checks command or script text against the active command rules.
pub fn check_command(st: &AppState, text: &str) -> Option<Refusal> {
    active(st).into_iter().find_map(|g| match &g.rule {
        GuardRule::ForbidCommand { pattern } if command_matches(text, pattern) => {
            Some(Refusal { entry: g.clone() })
        }
        _ => None,
    })
}

#[cfg(test)]
mod rules {
    use super::*;

    #[test]
    fn a_protected_folder_covers_itself_and_its_children() {
        assert!(path_protected("C:/project/src/main.rs", "C:/project"));
        assert!(path_protected("C:/project", "C:/project"));
        assert!(path_protected("c:\\PROJECT\\src", "C:/Project/"));
    }

    #[test]
    fn a_prefix_without_a_separator_boundary_is_not_the_folder() {
        assert!(!path_protected("C:/project2/notes.md", "C:/project"));
        assert!(!path_protected("C:/project-backup/a.md", "C:/project"));
    }

    #[test]
    fn a_drive_root_protects_the_whole_drive() {
        assert!(path_protected("D:/anything/at/all.txt", "D:"));
        assert!(path_protected("D:/", "D:\\"));
        assert!(!path_protected("E:/elsewhere.txt", "D:"));
    }

    /// Every spelling a folder picker or an operator can produce for a drive is
    /// the same rule. The trailing-separator forms are the ones that used to
    /// list themselves as active and protect nothing.
    #[test]
    fn a_drive_root_protects_it_however_the_rule_is_spelled() {
        for root in ["D:", "D:/", "D:\\", "d:\\", "//?/D:\\", "D:\\\\"] {
            assert!(
                path_protected("D:/work/readings.xlsx", root),
                "a rule written {root:?} protected nothing under the drive"
            );
            assert!(path_protected("D:\\work\\readings.xlsx", root), "{root:?}");
            assert!(!path_protected("E:/work/readings.xlsx", root), "{root:?}");
        }
    }

    /// A trailing separator never changes what a rule covers, and never widens
    /// it to a sibling that merely shares the prefix.
    #[test]
    fn a_trailing_separator_is_not_part_of_the_rule() {
        for root in ["C:/models", "C:/models/", "C:\\models\\", "C:\\models"] {
            assert!(path_protected("C:/models/qwen3.5-9b/weights.gguf", root), "{root:?}");
            assert!(path_protected("C:/Models", root), "{root:?}");
            assert!(!path_protected("C:/models-backup/weights.gguf", root), "{root:?}");
        }
    }

    /// The doc promises case folding, so a folder whose name is not ASCII has to
    /// fold too — an operator protecting a Cyrillic or Turkish folder name has
    /// the same guard as one protecting `Work`.
    #[test]
    fn case_folding_is_not_limited_to_ascii() {
        assert!(path_protected("C:/ЦЕХ/plan.md", "C:/цех"));
        assert!(path_protected("C:/Ölçüm/log.csv", "C:/ölçüm"));
    }

    #[test]
    fn an_empty_pattern_protects_nothing() {
        assert!(!path_protected("C:/anything", ""));
        assert!(!command_matches("git push --force", ""));
        assert!(!command_matches("git push --force", "   "));
    }

    #[test]
    fn a_single_word_command_pattern_matches_as_a_word() {
        assert!(command_matches("git push --force origin", "force"));
        assert!(!command_matches("git push --forced-upstream", "force"));
        assert!(!command_matches("rm forcefully.txt", "force"));
        // `format` must match even when written as a flag or a path piece,
        // and must not match merely because letters appear in order.
        assert!(command_matches("format C: /q", "format"));
        assert!(!command_matches("reformat-note.txt cat", "format"));
    }

    #[test]
    fn a_phrase_command_pattern_matches_as_a_substring() {
        assert!(command_matches("git push --force origin main", "push --force"));
        assert!(command_matches("format C: /q", "format c:"));
        assert!(!command_matches("git push origin main", "push --force"));
    }

    #[test]
    fn command_patterns_are_case_insensitive_both_ways() {
        assert!(command_matches("GIT PUSH --FORCE", "push --force"));
        assert!(command_matches("git push --force", "PUSH --FORCE"));
    }
}

#[cfg(test)]
mod refusal_wording {
    use super::*;

    fn entry(rule: GuardRule, note: &str) -> GuardRuleEntry {
        GuardRuleEntry {
            id: "g-1".into(),
            name: "Never format".into(),
            rule,
            note: note.into(),
            enabled: true,
        }
    }

    #[test]
    fn a_refusal_names_the_rule_and_says_what_it_stopped() {
        let e = entry(GuardRule::ForbidCommand { pattern: "format".into() }, "");
        let m = Refusal { entry: e }.message("run a command");
        assert!(m.contains("\"Never format\""), "{m}");
        assert!(m.contains("'format'"), "{m}");
        assert!(m.contains("run a command"), "{m}");
        assert!(m.contains("Settings"), "{m}");
    }

    #[test]
    fn a_path_refusal_names_the_folder() {
        let e = entry(
            GuardRule::ProtectPath { pattern: "C:/sovereign/models".into() },
            "The weights are irreplaceable.",
        );
        let m = Refusal { entry: e }.message("write a file");
        assert!(m.contains("C:/sovereign/models"), "{m}");
        assert!(m.contains("irreplaceable"), "{m}");
    }
}
