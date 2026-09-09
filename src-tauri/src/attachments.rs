//! Clipboard images pasted into the composer.
//!
//! A paste drops pixels in the browser tab, but a turn is only text plus file
//! paths — that is the whole contract of `StartTurnInput`. So an image pasted
//! into the typing bar is written out under the sovereign root as an ordinary
//! file first, then attached exactly like one the operator picked from disk.
//! Writing it under this application's own root (not `tmp`, which is scratch
//! for transient staging like a recording) means the file survives a reload,
//! the transcript row that names it keeps resolving, and it is inside a folder
//! both the in-panel preview and the agent's file tools already trust.

use std::path::Path;

use base64::Engine as _;

use crate::error::{CoreError, CoreResult};

/// 20 MiB of decoded pixels — comfortably above a large screenshot, well under
/// the 32 MiB the in-panel previewer will read back.
const MAX_PASTED_BYTES: usize = 20 * 1024 * 1024;

/// Image formats accepted when the extension is read off the clipboard's file
/// name. Mirrors the frontend's `IMAGE_EXTENSIONS` so what pastes here is what
/// `localTurnInput` classifies as `localImage`.
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif"];

/// The clipboard's MIME type used to choose an extension when the file name
/// carries none (which most paste payloads do not).
fn extension_for(name: &str, mime_type: &str) -> Option<String> {
    if let Some(raw) = Path::new(name).extension().and_then(|e| e.to_str()) {
        let ext = raw.to_ascii_lowercase();
        if IMAGE_EXTS.contains(&ext.as_str()) {
            return Some(ext);
        }
    }
    let mime = mime_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match mime.as_str() {
        "image/png" => Some("png".into()),
        "image/jpeg" => Some("jpg".into()),
        "image/webp" => Some("webp".into()),
        "image/gif" => Some("gif".into()),
        "image/bmp" => Some("bmp".into()),
        "image/tiff" => Some("tiff".into()),
        _ => None,
    }
}

/// Writes a pasted image under `sovereign_root/attachments` and answers with
/// its absolute path, ready to hand to a turn as an ordinary attachment.
pub fn stage(name: &str, mime_type: &str, data_base64: &str) -> CoreResult<String> {
    // A loose guard so an absurd payload is refused before it is decoded into
    // memory; the real limit is enforced on the decoded bytes below.
    if data_base64.len() > (MAX_PASTED_BYTES * 4 / 3 + 16) * 4 {
        return Err(CoreError::ExecutionFailed(
            "That pasted image is too large to attach.".into(),
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| {
            CoreError::ExecutionFailed("The pasted image could not be decoded.".into())
        })?;
    if bytes.is_empty() {
        return Err(CoreError::ExecutionFailed(
            "The pasted image contained no pixels.".into(),
        ));
    }
    if bytes.len() > MAX_PASTED_BYTES {
        return Err(CoreError::ExecutionFailed(
            "That pasted image is too large to attach (over 20 MB).".into(),
        ));
    }
    let ext = extension_for(name, mime_type).ok_or_else(|| {
        CoreError::ExecutionFailed(
            "Only images can be pasted into the typing bar. Attach other files with the + menu."
                .into(),
        )
    })?;

    let dir = crate::registry::sovereign_root().join("attachments");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.{ext}", crate::state::new_id("att")));
    std::fs::write(&path, bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Takes a durable, chat-scoped snapshot of a file the operator submitted.
///
/// Picked files may live anywhere on the workstation and pasted images first
/// land in the shared staging directory. Keeping only that original path makes
/// a conversation depend on a file being left in place forever. A submitted
/// attachment instead becomes part of the chat under
/// `sessions/<session>/attachments`; the message row stores this path and later
/// turns in this exact chat can read it without opening a project.
pub fn snapshot_for_session(session_id: &str, source: &str) -> CoreResult<String> {
    snapshot_for_session_at(&crate::registry::sovereign_root(), session_id, source)
}

fn snapshot_for_session_at(root: &Path, session_id: &str, source: &str) -> CoreResult<String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(CoreError::ExecutionFailed(
            "The attachment could not be assigned to an invalid chat id.".into(),
        ));
    }

    let source = Path::new(source);
    if !source.is_file() {
        return Err(CoreError::InvalidDocument(format!(
            "The attached file no longer exists or is not a file: {}",
            source.to_string_lossy()
        )));
    }

    let dir = root
        .join("sessions")
        .join(session_id)
        .join("attachments");
    std::fs::create_dir_all(&dir)?;

    // An edited message carries its already-snapshotted paths back through the
    // same boundary. Reuse those bytes rather than making a copy of a copy.
    let canonical_source = source.canonicalize()?;
    let canonical_dir = dir.canonicalize()?;
    if canonical_source.starts_with(&canonical_dir) {
        return Ok(canonical_source.to_string_lossy().into_owned());
    }

    let original = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment");
    // `file_name` has already removed path separators. Strip control characters
    // and Windows-invalid punctuation while retaining the original extension
    // for image/document classification and the original name in the UI.
    let clean: String = original
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    let clean = if clean.trim_matches([' ', '.']).is_empty() {
        "attachment"
    } else {
        clean.trim_matches([' ', '.'])
    };
    let stem = clean.split('.').next().unwrap_or(clean).to_ascii_lowercase();
    let clean = if matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        format!("attachment-{clean}")
    } else {
        clean.to_string()
    };
    // Uniqueness lives in a private directory so the visible basename remains
    // what the operator attached, even when two files share the same name.
    let item_dir = dir.join(crate::state::new_id("att"));
    std::fs::create_dir(&item_dir)?;
    let destination = item_dir.join(clean);
    std::fs::copy(&canonical_source, &destination)?;
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_selects_an_extension_when_the_name_has_none() {
        assert_eq!(extension_for("clipboard", "image/png").as_deref(), Some("png"));
        assert_eq!(extension_for("scan", "image/jpeg").as_deref(), Some("jpg"));
        assert_eq!(extension_for("shot.png", "application/octet-stream").as_deref(), Some("png"));
    }

    #[test]
    fn non_images_are_refused() {
        assert!(extension_for("notes.txt", "text/plain").is_none());
        assert!(extension_for("archive.zip", "application/zip").is_none());
    }

    #[test]
    fn oversized_payloads_are_refused_before_decoding() {
        let huge = "A".repeat((MAX_PASTED_BYTES * 4 / 3 + 16) * 4 + 1);
        assert!(stage("clipboard", "image/png", &huge).is_err());
    }

    #[test]
    fn submitted_files_become_durable_and_chat_scoped() {
        let root = std::env::temp_dir().join(crate::state::new_id("attachment-test"));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("picked diagram.png");
        std::fs::write(&source, b"pixels").unwrap();

        let saved = snapshot_for_session_at(&root, "session-one", &source.to_string_lossy())
            .expect("the selected file is snapshotted");
        let saved_path = Path::new(&saved);
        assert!(saved_path.starts_with(root.join("sessions/session-one/attachments")));
        assert_eq!(std::fs::read(saved_path).unwrap(), b"pixels");
        assert_eq!(saved_path.file_name().unwrap().to_string_lossy(), "picked diagram.png");

        // Editing the message sends its stored attachment through this boundary
        // again; that must reuse the same snapshot, not fork another copy.
        assert_eq!(
            snapshot_for_session_at(&root, "session-one", &saved).unwrap(),
            saved_path.canonicalize().unwrap().to_string_lossy()
        );
        assert!(snapshot_for_session_at(&root, "../another-chat", &source.to_string_lossy()).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }
}
