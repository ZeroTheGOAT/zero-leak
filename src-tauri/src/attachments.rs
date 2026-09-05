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
}
