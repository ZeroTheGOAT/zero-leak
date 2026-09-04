//! §16 — at-rest protection for this application's confidential mirrors.
//!
//! The canonical store, `workbench.db`, holds every turn, memory and tool call,
//! and the application runs entirely off it. On top of that the core writes
//! *mirrors* — Markdown memory files and `transcript.jsonl` — whose whole
//! purpose is to be read by a human outside the database. Nothing in the running
//! application reads them; the database is authoritative. That makes them the
//! one class of file that sits on disk in clear text purely as duplication, and
//! therefore the one class this application can seal on its own.
//!
//! Full-volume encryption — the boundary that protects `workbench.db`, the
//! operator's own documents and everything else on the disk — is the operating
//! system's job (BitLocker), and this module never claims to replace it. What it
//! does is stop the *extra* copies from existing in the clear: while the vault
//! is enabled, the core does not write plaintext mirrors at all, and any that
//! already exist are sealed to AES-256-GCM envelopes whose key comes from an
//! operator passphrase through Argon2id.
//!
//! Design notes, because this is the module where a plausible-but-wrong choice
//! would be a real one:
//!
//! - **No resident key.** The sealed files are never read by the running
//!   application (the database is authoritative), so there is no reason to hold
//!   a decryption key in memory between operations. The key is derived only for
//!   the duration of an enable (to seal) or a disable (to restore) and then
//!   wiped. There is no "unlocked session" to leave open.
//! - **Passphrase is never stored.** The state file keeps the Argon2id
//!   parameters, two salts and a verifier — enough to check a passphrase and
//!   re-derive the key, nothing that reveals it. A wrong passphrase on disable
//!   is recorded to the vault-event ledger, not just refused.
//! - **Seal-then-remove, state-first.** The state file is written before any
//!   sealing, and `.vault` envelopes are written to a sibling path before the
//!   plaintext is deleted, so an interrupted enable leaves readable plaintext
//!   plus a live vault — never sealed files with no way back. Restore on
//!   disable is the mirror image: envelopes are decrypted before the state file
//!   is removed, so an interrupted disable keeps the vault armed rather than
//!   stranding ciphertext.
//! - **Honest scope.** What is sealed is precisely the set of app-written
//!   confidential mirrors: `*.md` memory files under the memory root, and each
//!   session's `transcript.jsonl`. The database and the operator's own source
//!   documents are out of scope and the Sovereignty panel says so.

use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::error::{CoreError, CoreResult};
use crate::state::{now_ms, AppState};
use crate::types::{VaultAction, VaultEvent, VaultStatus};

/// A passphrase shorter than this is refused. Ten characters is a floor, not a
/// policy: the UI says so, because an at-rest vault is only as strong as the
/// passphrase an attacker has to guess.
pub const MIN_PASSPHRASE_LEN: usize = 10;

/// Both the verifier and the encryption key are 32 bytes.
const KEY_LEN: usize = 32;

/// Envelope magic. A sealed file is `<name>.vault` and starts with these bytes,
/// so a file that is not ours is never mistaken for one.
const MAGIC: &[u8; 4] = b"SVLT";
const ENVELOPE_VERSION: u8 = 1;
const NONCE_LEN: usize = 12;

/// The memory cost (KiB), iterations and parallelism for Argon2id. These are
/// OWASP's 2023 minimums for a passphrase hash; a plant workstation is a desktop
/// and this runs once per enable/disable, so there is no reason to go lower.
const KDF_M_COST: u32 = 19_456;
const KDF_T_COST: u32 = 2;
const KDF_P_COST: u32 = 1;

fn kdf_params() -> CoreResult<Params> {
    Params::new(KDF_M_COST, KDF_T_COST, KDF_P_COST, Some(KEY_LEN)).map_err(|e| {
        CoreError::ExecutionFailed(format!("Could not build Argon2id parameters: {e}"))
    })
}

/* ------------------------------------------------------------------ */
/* State file                                                          */
/* ------------------------------------------------------------------ */

/// The state file lives under the sovereign root so the whole at-rest vault is
/// inside the store the §11 lock and the operator's backups already cover.
fn state_path_at(root: &Path) -> PathBuf {
    root.join("vault").join("vault.json")
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct State {
    version: u32,
    kdf: KdfParams,
    /// Base64 16-byte salt for the encryption key.
    key_salt: String,
    /// Base64 16-byte salt for the verifier. Distinct from `key_salt`, so the
    /// verifier's output can never be used as the key it guards.
    verify_salt: String,
    /// Base64 Argon2id hash of the passphrase under `verify_salt`.
    verifier: String,
    enabled_at: i64,
    operator: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct KdfParams {
    name: String,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
}

fn load_state(root: &Path) -> CoreResult<Option<State>> {
    let path = state_path_at(root);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| {
        CoreError::ExecutionFailed(format!("Could not read the vault state file: {e}"))
    })?;
    serde_json::from_str(&raw).map(Some).map_err(|e| {
        CoreError::ExecutionFailed(format!("The vault state file is not valid JSON: {e}"))
    })
}

/// True while the vault is enabled — i.e. while the state file exists. Writers
/// of confidential mirrors consult this before emitting plaintext, so enabling
/// takes effect immediately, without a settings round-trip.
pub fn is_enabled() -> bool {
    state_path_at(&crate::registry::sovereign_root()).exists()
}

/* ------------------------------------------------------------------ */
/* Passphrase handling                                                 */
/* ------------------------------------------------------------------ */

fn check_passphrase(passphrase: &str) -> CoreResult<()> {
    if passphrase.chars().count() < MIN_PASSPHRASE_LEN {
        return Err(CoreError::Denied(format!(
            "The vault passphrase must be at least {MIN_PASSPHRASE_LEN} characters long."
        )));
    }
    if passphrase.chars().all(char::is_whitespace) {
        return Err(CoreError::Denied(
            "A passphrase of only whitespace is not a passphrase.".to_string(),
        ));
    }
    if passphrase.len() > 1024 {
        return Err(CoreError::Denied(
            "The vault passphrase is too long (over 1024 bytes).".to_string(),
        ));
    }
    Ok(())
}

fn derive(state: &State, passphrase: &str, salt_b64: &str) -> CoreResult<[u8; KEY_LEN]> {
    let salt = B64.decode(salt_b64).map_err(|e| {
        CoreError::ExecutionFailed(format!("The vault state file has a bad salt: {e}"))
    })?;
    let params = Params::new(state.kdf.m_cost, state.kdf.t_cost, state.kdf.p_cost, Some(KEY_LEN))
        .map_err(|e| CoreError::ExecutionFailed(format!("Bad Argon2id parameters: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), &salt, &mut out)
        .map_err(|e| CoreError::ExecutionFailed(format!("Argon2id derivation failed: {e}")))?;
    Ok(out)
}

/// Constant-time equality for the verifier: this compare must not short-circuit
/// on the first differing byte, or the timing would leak how much of the
/// passphrase matched.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn verify(state: &State, passphrase: &str) -> CoreResult<bool> {
    let expected = B64.decode(&state.verifier).map_err(|e| {
        CoreError::ExecutionFailed(format!("The vault state file has a bad verifier: {e}"))
    })?;
    let got = derive(state, passphrase, &state.verify_salt)?;
    Ok(ct_eq(&expected, &got))
}

fn wipe(key: &mut [u8; KEY_LEN]) {
    for byte in key.iter_mut() {
        *byte = 0;
    }
}

/* ------------------------------------------------------------------ */
/* Envelope seal / open                                                */
/* ------------------------------------------------------------------ */

/// Seals `plaintext` into an envelope: magic, version, a fresh random nonce,
/// then AES-256-GCM ciphertext with the tag appended (the `aes-gcm` crate's
/// default wire format).
fn seal_bytes(key: &[u8; KEY_LEN], plaintext: &[u8]) -> CoreResult<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|e| {
        CoreError::ExecutionFailed(format!("Could not get randomness for sealing: {e}"))
    })?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|_| CoreError::ExecutionFailed("AES-256-GCM sealing failed.".to_string()))?;
    let mut out = Vec::with_capacity(MAGIC.len() + 1 + nonce.len() + sealed.len());
    out.extend_from_slice(MAGIC);
    out.push(ENVELOPE_VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Opens an envelope produced by `seal_bytes`. A wrong key, a bad nonce, or a
/// file that was never an envelope all surface here as a clear error — there is
/// no silent "decrypted to garbage".
fn open_bytes(key: &[u8; KEY_LEN], blob: &[u8]) -> CoreResult<Vec<u8>> {
    let head = MAGIC.len() + 1 + NONCE_LEN;
    if blob.len() < head + 16 {
        return Err(CoreError::ExecutionFailed(
            "A sealed file is too short to be a vault envelope.".to_string(),
        ));
    }
    if &blob[..MAGIC.len()] != MAGIC {
        return Err(CoreError::ExecutionFailed(
            "A sealed file does not carry the vault envelope marker.".to_string(),
        ));
    }
    if blob[MAGIC.len()] != ENVELOPE_VERSION {
        return Err(CoreError::ExecutionFailed(
            "A sealed file uses an unsupported vault envelope version.".to_string(),
        ));
    }
    let nonce = &blob[MAGIC.len() + 1..head];
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(nonce), &blob[head..])
        .map_err(|_| {
            CoreError::ExecutionFailed(
                "A sealed file failed to decrypt — the key does not match, or the file is \
                 corrupt."
                    .to_string(),
            )
        })
}

/// Writes bytes atomically: to a sibling temp file, then renamed over the
/// destination. A crash mid-write can then never leave a half-written envelope
/// where a whole one belongs.
fn write_atomic(dest: &Path, bytes: &[u8]) -> CoreResult<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = dest.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, dest)?;
    Ok(())
}

/// The sealed path a plaintext mirror maps to: a sibling named `<name>.vault`.
fn envelope_path(path: &Path) -> PathBuf {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    path.with_file_name(format!("{name}.vault"))
}

/// Turn a sealed envelope path back into the plaintext path it came from.
fn envelope_target(path: &Path) -> PathBuf {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let restored = name.strip_suffix(".vault").unwrap_or(name);
    path.with_file_name(restored)
}

/* ------------------------------------------------------------------ */
/* Payload enumeration                                                 */
/* ------------------------------------------------------------------ */

/// The confidential mirrors this vault seals:
///   - every `*.md` memory mirror under the memory root (recursively), and
///   - each session's `transcript.jsonl` under the sovereign root.
///
/// Returns `(plaintext_files, sealed_files)` as sibling paths, so an enable can
/// seal what is clear and a disable can restore what is sealed.
fn payload_files(mem_root: &Path, root: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut plaintext = Vec::new();
    let mut sealed = Vec::new();

    if mem_root.is_dir() {
        for entry in WalkDir::new(mem_root).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name,
                None => continue,
            };
            if let Some(stripped) = name.strip_suffix(".vault") {
                if stripped.ends_with(".md") {
                    sealed.push(path.to_path_buf());
                }
            } else if name.ends_with(".md") {
                plaintext.push(path.to_path_buf());
            }
        }
    }

    let sessions = root.join("sessions");
    if sessions.is_dir() {
        if let Ok(entries) = fs::read_dir(&sessions) {
            for entry in entries.filter_map(|e| e.ok()) {
                let transcript = entry.path().join("transcript.jsonl");
                if transcript.exists() {
                    plaintext.push(transcript);
                }
                let envelope = entry.path().join("transcript.jsonl.vault");
                if envelope.exists() {
                    sealed.push(envelope);
                }
            }
        }
    }

    (plaintext, sealed)
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/// The vault's observable state, read from the state file and the payload
/// folders — never from the passphrase.
fn status_at(mem_root: &Path, root: &Path) -> CoreResult<VaultStatus> {
    let (plaintext, sealed) = payload_files(mem_root, root);
    let state = load_state(root)?;
    Ok(VaultStatus {
        enabled: state.is_some(),
        enabled_at: state.as_ref().map(|s| s.enabled_at),
        operator: state.as_ref().map(|s| s.operator.clone()),
        sealed_files: sealed.len() as u64,
        plaintext_files: plaintext.len() as u64,
    })
}

/// Enables the vault against a concrete root and memory root. `record` receives
/// the lifecycle events a caller wants persisted (the audit-ledger insert in
/// production; a Vec in tests). Factored this way so the whole flow is testable
/// on temp directories without an `AppState`.
fn enable_impl<R: FnMut(VaultAction, String)>(
    passphrase: &str,
    mem_root: &Path,
    root: &Path,
    operator: &str,
    record: &mut R,
) -> CoreResult<VaultStatus> {
    check_passphrase(passphrase)?;
    if load_state(root)?.is_some() {
        return Err(CoreError::Denied(
            "The at-rest vault is already enabled. Disable it first (which restores the \
             sealed mirrors) before setting a new passphrase."
                .to_string(),
        ));
    }

    let mut key_salt = [0u8; 16];
    let mut verify_salt = [0u8; 16];
    getrandom::getrandom(&mut key_salt)
        .and_then(|_| getrandom::getrandom(&mut verify_salt))
        .map_err(|e| {
            CoreError::ExecutionFailed(format!("Could not get randomness for the vault: {e}"))
        })?;

    // Derive a key and a verifier. The verifier is written to the state file;
    // the key exists only for the sealing below and is wiped afterwards.
    let mut key = derive_raw(passphrase, &key_salt)?;
    let mut verifier = derive_raw(passphrase, &verify_salt)?;

    let state = State {
        version: 1,
        kdf: KdfParams {
            name: "argon2id".to_string(),
            m_cost: KDF_M_COST,
            t_cost: KDF_T_COST,
            p_cost: KDF_P_COST,
        },
        key_salt: B64.encode(key_salt),
        verify_salt: B64.encode(verify_salt),
        verifier: B64.encode(verifier),
        enabled_at: now_ms(),
        operator: operator.to_string(),
    };
    write_atomic(&state_path_at(root), &serde_json::to_vec_pretty(&state)?)?;

    // The state file now exists, so `is_enabled()` is true and no writer can
    // race this seal and drop a fresh plaintext mirror behind it.
    let (plaintext, _) = payload_files(mem_root, root);
    let mut sealed_ok = 0usize;
    let mut failed = 0usize;
    for path in plaintext {
        let outcome = (|| -> CoreResult<()> {
            let bytes = fs::read(&path)?;
            let envelope = seal_bytes(&key, &bytes)?;
            let target = envelope_path(&path);
            write_atomic(&target, &envelope)?;
            fs::remove_file(&path)?;
            Ok(())
        })();
        match outcome {
            Ok(()) => sealed_ok += 1,
            Err(_) => failed += 1,
        }
    }
    wipe(&mut key);
    wipe(&mut verifier);

    record(
        VaultAction::Enabled,
        if failed == 0 {
            format!("Sealed {sealed_ok} confidential mirror file(s).")
        } else {
            format!(
                "Sealed {sealed_ok} file(s); {failed} could not be sealed and remain in the \
                 clear — see the at-rest status."
            )
        },
    );
    status_at(mem_root, root)
}

/// Disables the vault. The passphrase must verify; a wrong passphrase is
/// recorded to the ledger and refused. On success every sealed mirror is
/// restored and the state file is removed last, so an interrupted disable keeps
/// the vault armed rather than stranding ciphertext.
fn disable_impl<R: FnMut(VaultAction, String)>(
    passphrase: &str,
    mem_root: &Path,
    root: &Path,
    record: &mut R,
) -> CoreResult<VaultStatus> {
    let state = load_state(root)?.ok_or_else(|| {
        CoreError::Denied("The at-rest vault is not enabled, so there is nothing to disable.".to_string())
    })?;

    if !verify(&state, passphrase)? {
        record(
            VaultAction::Denied,
            "A disable was attempted with a passphrase that did not verify.".to_string(),
        );
        return Err(CoreError::Denied(
            "That passphrase does not unlock this vault. Nothing was changed; the attempt is \
             on the ledger."
                .to_string(),
        ));
    }

    let mut key = derive(&state, passphrase, &state.key_salt)?;
    let (_, sealed) = payload_files(mem_root, root);
    let mut restored = 0usize;
    let mut failed = 0usize;
    for envelope in sealed {
        let outcome = (|| -> CoreResult<()> {
            let bytes = fs::read(&envelope)?;
            let plaintext = open_bytes(&key, &bytes)?;
            let target = envelope_target(&envelope);
            write_atomic(&target, &plaintext)?;
            fs::remove_file(&envelope)?;
            Ok(())
        })();
        match outcome {
            Ok(()) => restored += 1,
            Err(_) => failed += 1,
        }
    }
    wipe(&mut key);

    if failed > 0 {
        record(
            VaultAction::Disabled,
            format!(
                "Restored {restored} file(s); {failed} sealed file(s) could not be restored and \
                 the vault remains enabled so they are not stranded."
            ),
        );
        return Err(CoreError::ExecutionFailed(format!(
            "Restored {restored} of {} sealed file(s); {failed} failed to decrypt. The vault is \
             still enabled so those files are not stranded.",
            restored + failed
        )));
    }

    // Everything restored. Remove the state file last so `is_enabled()` flips
    // only once the payload is back in the clear.
    fs::remove_file(state_path_at(root))?;
    record(
        VaultAction::Disabled,
        format!("Restored {restored} confidential mirror file(s) to plaintext."),
    );
    status_at(mem_root, root)
}

/// Derives a 32-byte value from a passphrase and a fresh 16-byte salt under the
/// fixed Argon2id parameters. Used for both the key and the verifier.
fn derive_raw(passphrase: &str, salt: &[u8]) -> CoreResult<[u8; KEY_LEN]> {
    let params = kdf_params()?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| CoreError::ExecutionFailed(format!("Argon2id derivation failed: {e}")))?;
    Ok(out)
}

fn record_event(st: &AppState, action: VaultAction, detail: String) {
    let event = VaultEvent {
        id: crate::state::new_id("ve"),
        at: now_ms(),
        operator: st.operator.clone(),
        action,
        detail,
    };
    let _ = st.with_db(|conn| crate::db::record_vault_event(conn, &event));
}

fn mem_root(st: &AppState) -> PathBuf {
    PathBuf::from(&st.settings().memory_root)
}

/// The vault's observable state for the live store.
pub fn status(st: &AppState) -> CoreResult<VaultStatus> {
    status_at(&mem_root(st), &crate::registry::sovereign_root())
}

/// Enables the vault on the live store (see `enable_impl`).
pub fn enable(st: &AppState, passphrase: &str) -> CoreResult<VaultStatus> {
    let mut record = |action, detail| record_event(st, action, detail);
    enable_impl(passphrase, &mem_root(st), &crate::registry::sovereign_root(), &st.operator, &mut record)
}

/// Disables the vault on the live store (see `disable_impl`).
pub fn disable(st: &AppState, passphrase: &str) -> CoreResult<VaultStatus> {
    let mut record = |action, detail| record_event(st, action, detail);
    disable_impl(passphrase, &mem_root(st), &crate::registry::sovereign_root(), &mut record)
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    const PASS: &str = "correct horse battery staple";

    /// A throwaway sovereign root and memory root under the OS temp dir. Removed
    /// on drop so parallel test runs never collide or litter.
    struct TempRoot(PathBuf, PathBuf);
    impl TempRoot {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "servergen-vault-test-{}-{}",
                std::process::id(),
                crate::state::new_id("tmp")
            ));
            let root = base.join("sovereign");
            let mem = base.join("memories");
            fs::create_dir_all(&mem).unwrap();
            TempRoot(root, mem)
        }

        /// Writes a memory mirror and a session transcript mirror, mirroring the
        /// real payload layout.
        fn seed(&self) {
            fs::create_dir_all(self.0.join("sessions/sess-1")).unwrap();
            fs::write(self.0.join("sessions/sess-1/transcript.jsonl"), "{\"role\":\"user\"}\n").unwrap();
            fs::write(self.1.join("global.md"), "# Global memories\n\nconfidential\n").unwrap();
            fs::create_dir_all(self.1.join("projects/ws-1/rollout_summaries")).unwrap();
            fs::write(self.1.join("projects/ws-1/MEMORY.md"), "# ws-1\n\nsecret notes\n").unwrap();
            fs::write(self.1.join("projects/ws-1/rollout_summaries/sess-2.md"), "# rollout\n\nclassified\n").unwrap();
        }

        fn payload_snapshot(&self) -> (usize, usize) {
            let (plain, sealed) = payload_files(&self.1, &self.0);
            (plain.len(), sealed.len())
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.0.parent().unwrap());
        }
    }

    #[test]
    fn envelope_round_trips_and_rejects_a_wrong_key() {
        let mut key = [0u8; 32];
        let mut other = [0u8; 32];
        key[0] = 1;
        other[0] = 2;
        let sealed = seal_bytes(&key, b"confidential memory mirror").unwrap();
        assert_eq!(&sealed[..4], MAGIC);
        assert_eq!(open_bytes(&key, &sealed).unwrap(), b"confidential memory mirror");
        assert!(open_bytes(&other, &sealed).is_err());
        // Truncation and non-envelope bytes are both refused, not mis-decoded.
        assert!(open_bytes(&key, &sealed[..sealed.len() - 5]).is_err());
        assert!(open_bytes(&key, b"this is not an envelope at all............").is_err());
    }

    #[test]
    fn ct_eq_is_length_safe_and_value_exact() {
        assert!(ct_eq(&[1, 2, 3], &[1, 2, 3]));
        assert!(!ct_eq(&[1, 2, 3], &[1, 2, 4]));
        assert!(!ct_eq(&[1, 2, 3], &[1, 2]));
    }

    #[test]
    fn weak_passphrases_are_refused_before_anything_is_written() {
        let root = TempRoot::new();
        let mut events = Vec::new();
        assert!(enable_impl("short", &root.1, &root.0, "OP", &mut |a, d| events.push((a, d))).is_err());
        assert!(enable_impl("           ", &root.1, &root.0, "OP", &mut |a, d| events.push((a, d))).is_err());
        assert_eq!(load_state(&root.0).unwrap(), None);
        assert!(events.is_empty());
    }

    #[test]
    fn enable_seals_every_mirror_and_removes_the_plaintext() {
        let root = TempRoot::new();
        root.seed();
        let (before_plain, _) = root.payload_snapshot();
        assert_eq!(before_plain, 4);

        let mut events = Vec::new();
        let status = enable_impl(PASS, &root.1, &root.0, "PLANT\\harih", &mut |a, d| events.push((a, d))).unwrap();

        assert!(status.enabled);
        assert_eq!(status.plaintext_files, 0, "no mirror stays in the clear");
        assert_eq!(status.sealed_files, 4);
        assert_eq!(status.operator.as_deref(), Some("PLANT\\harih"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, VaultAction::Enabled);

        // The plaintext is gone from every location it used to live.
        assert!(!root.1.join("global.md").exists());
        assert!(root.1.join("global.md.vault").exists());
        assert!(!root.0.join("sessions/sess-1/transcript.jsonl").exists());
        assert!(root.0.join("sessions/sess-1/transcript.jsonl.vault").exists());
        // A sealed envelope does not contain the plaintext.
        let blob = fs::read(root.1.join("global.md.vault")).unwrap();
        assert!(!blob.windows(b"confidential".len()).any(|w| w == b"confidential"));
        // And the state file exists (enabled) but holds no passphrase material.
        let state_raw = fs::read_to_string(root.0.join("vault/vault.json")).unwrap();
        assert!(!state_raw.contains(PASS));
        assert!(!state_raw.contains("confidential"));
    }

    #[test]
    fn enable_twice_is_refused() {
        let root = TempRoot::new();
        root.seed();
        let mut events = Vec::new();
        enable_impl(PASS, &root.1, &root.0, "OP", &mut |a, d| events.push((a, d))).unwrap();
        let err = enable_impl(PASS, &root.1, &root.0, "OP", &mut |a, d| events.push((a, d))).unwrap_err();
        assert!(matches!(err, CoreError::Denied(_)));
        assert_eq!(events.len(), 1, "no second enabled event");
    }

    #[test]
    fn disable_restores_the_exact_bytes_and_flips_enabled_off() {
        let root = TempRoot::new();
        root.seed();
        let mut events = Vec::new();
        enable_impl(PASS, &root.1, &root.0, "OP", &mut |a, d| events.push((a, d))).unwrap();

        let status = disable_impl(PASS, &root.1, &root.0, &mut |a, d| events.push((a, d))).unwrap();
        assert!(!status.enabled);
        assert_eq!(status.sealed_files, 0);
        assert_eq!(status.plaintext_files, 4, "mirrors are back in the clear");

        // Restored files carry their original bytes.
        assert_eq!(
            fs::read_to_string(root.1.join("global.md")).unwrap(),
            "# Global memories\n\nconfidential\n"
        );
        assert_eq!(
            fs::read_to_string(root.0.join("sessions/sess-1/transcript.jsonl")).unwrap(),
            "{\"role\":\"user\"}\n"
        );
        assert_eq!(
            fs::read_to_string(root.1.join("projects/ws-1/rollout_summaries/sess-2.md")).unwrap(),
            "# rollout\n\nclassified\n"
        );
        // Envelopes are gone; the state file is gone.
        assert!(!root.1.join("global.md.vault").exists());
        assert!(!root.0.join("vault/vault.json").exists());
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].0, VaultAction::Disabled);
    }

    #[test]
    fn disable_with_the_wrong_passphrase_is_refused_and_denied_is_recorded() {
        let root = TempRoot::new();
        root.seed();
        let mut events = Vec::new();
        enable_impl(PASS, &root.1, &root.0, "OP", &mut |a, d| events.push((a, d))).unwrap();

        let err = disable_impl("wrong passphrase!!", &root.1, &root.0, &mut |a, d| events.push((a, d))).unwrap_err();
        assert!(matches!(err, CoreError::Denied(_)));
        // Nothing changed: still enabled, mirrors still sealed.
        assert!(root.0.join("vault/vault.json").exists());
        let (plain, sealed) = root.payload_snapshot();
        assert_eq!(plain, 0);
        assert_eq!(sealed, 4);
        assert_eq!(events.len(), 2, "enabled + one denied");
        assert_eq!(events[1].0, VaultAction::Denied);
    }

    #[test]
    fn an_unrelated_file_under_the_memory_root_is_left_alone() {
        let root = TempRoot::new();
        root.seed();
        // A non-mirror file the operator put there — not something the app wrote
        // as a mirror, so the vault must not touch it.
        fs::write(root.1.join("operators-notes.txt"), "do not seal this").unwrap();

        let mut events = Vec::new();
        enable_impl(PASS, &root.1, &root.0, "OP", &mut |a, d| events.push((a, d))).unwrap();
        assert!(root.1.join("operators-notes.txt").exists());
        assert_eq!(
            fs::read_to_string(root.1.join("operators-notes.txt")).unwrap(),
            "do not seal this"
        );
    }
}
