//! Offline microphone transcription through a locally installed whisper.cpp.
//!
//! The browser records PCM and sends it through the same authenticated local
//! command surface as every other operation. The bytes are written only to the
//! sovereign temp directory, processed by a contained local executable, and
//! deleted before the command returns.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;

use crate::error::{CoreError, CoreResult};
use crate::state::AppState;
use crate::winproc::{self, JobLimits};

/// Local transcription's ceiling, in seconds of audio.
///
/// It was a byte count — 16 MiB — described in every message as "the
/// five-minute local transcription limit". At the 16 kHz mono 16-bit PCM the
/// browser side produces, 16 MiB is 8 minutes 44 seconds: a six-minute dictation
/// was accepted, told it was inside a five-minute limit, and then killed by
/// `TRANSCRIPTION_TIMEOUT` — after the operator had waited the whole five
/// minutes for nothing. One number now, in the unit the operator recorded in,
/// with the byte cap derived from it so the two cannot drift apart again.
const MAX_AUDIO_SECONDS: usize = 5 * 60;
/// 16 kHz, mono, 16-bit little-endian: what `recordingToWav` writes and what
/// whisper.cpp requires. Anything else is rejected before it reaches here.
const WAV_BYTES_PER_SECOND: usize = 16_000 * 2;
/// The 44-byte canonical RIFF header, plus the samples.
const MAX_WAV_BYTES: usize = 44 + MAX_AUDIO_SECONDS * WAV_BYTES_PER_SECOND;
const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionStatus {
    pub ready: bool,
    pub model_id: String,
    pub model_path: Option<String>,
    pub runtime_path: Option<String>,
    pub detail: String,
}

struct TempAudio {
    wav: PathBuf,
    text: PathBuf,
}

impl Drop for TempAudio {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.wav);
        let _ = std::fs::remove_file(&self.text);
    }
}

fn normalise(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn model_filename(model_id: &str) -> CoreResult<&'static str> {
    match model_id {
        "whisper.cpp-tiny" => Ok("ggml-tiny.bin"),
        "whisper.cpp-base" => Ok("ggml-base.bin"),
        "whisper.cpp-small" => Ok("ggml-small.bin"),
        "moonshine-tiny" => Err(CoreError::ExecutionFailed(
            "Moonshine Tiny is listed as an optional model but has no local runtime configured. Choose a Whisper model.".into(),
        )),
        _ => Err(CoreError::ExecutionFailed(format!(
            "The selected transcription model '{model_id}' is not supported by the local runtime."
        ))),
    }
}

fn find_model(models_root: &Path, model_id: &str) -> CoreResult<Option<PathBuf>> {
    let file = model_filename(model_id)?;
    let short = model_id.trim_start_matches("whisper.cpp-");
    Ok([
        models_root.join("stt").join(file),
        models_root.join("stt").join(model_id).join(file),
        models_root.join("stt").join(short).join(file),
        models_root.join(file),
    ]
    .into_iter()
    .find(|path| path.is_file()))
}

fn path_executable(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn find_runtime(models_root: &Path) -> Option<PathBuf> {
    let names = ["whisper-cli.exe", "main.exe"];
    let sovereign = crate::registry::sovereign_root();
    let executable_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let mut directories = vec![
        sovereign.join("runtime/whisper.cpp"),
        models_root.join("stt/runtime"),
        models_root.join("stt/whisper.cpp"),
    ];
    if let Some(directory) = executable_dir {
        directories.push(directory.join("whisper.cpp"));
        directories.push(directory.join("runtime/whisper.cpp"));
    }
    for directory in directories {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    path_executable(&names)
}

pub fn status(st: &AppState, model_id: &str) -> CoreResult<TranscriptionStatus> {
    let models_root = PathBuf::from(st.settings().models_directory);
    let model = find_model(&models_root, model_id)?;
    let runtime = find_runtime(&models_root);
    let detail = match (&model, &runtime) {
        (Some(_), Some(_)) => "Ready for fully local transcription.".to_string(),
        (None, _) => format!(
            "The selected local model is not installed. Put {} in {}/stt, then try the mic again.",
            model_filename(model_id)?,
            normalise(&models_root)
        ),
        (_, None) => format!(
            "The local whisper.cpp runtime is missing. Install whisper-cli.exe in {}/runtime/whisper.cpp.",
            normalise(&crate::registry::sovereign_root())
        ),
    };
    Ok(TranscriptionStatus {
        ready: model.is_some() && runtime.is_some(),
        model_id: model_id.to_string(),
        model_path: model.as_deref().map(normalise),
        runtime_path: runtime.as_deref().map(normalise),
        detail,
    })
}

/// How long the recording actually is, from its byte count.
fn wav_seconds(bytes: usize) -> usize {
    bytes.saturating_sub(44) / WAV_BYTES_PER_SECOND
}

/// One phrasing for the limit, so the two places that enforce it cannot describe
/// it differently.
fn too_long(bytes: Option<usize>) -> CoreError {
    let minutes = MAX_AUDIO_SECONDS / 60;
    let measured = match bytes.map(wav_seconds) {
        Some(s) => format!(" This one is about {}m {:02}s.", s / 60, s % 60),
        None => String::new(),
    };
    CoreError::ExecutionFailed(format!(
        "Local transcription takes up to {minutes} minutes of audio at a time.{measured} Record it in shorter passes and the transcripts will append."
    ))
}

/// Turns the operator's language selection into whisper.cpp's `--language`.
///
/// The browser sends the whisper code from its own list, so there is no table
/// here to fall out of step with the menu they picked from — anything this does
/// not recognise becomes auto-detect, including the display names ("English",
/// "Multilingual") that older builds stored in local preferences.
///
/// Auto-detect must be passed explicitly. `whisper-cli --help` on the installed
/// runtime reads `-l LANG [en] spoken language ('auto' for auto-detect)`, so
/// omitting the flag does not mean "detect it" — it means English. That is what
/// both "Auto detect" and "Multilingual" did: Hindi dictation came back as
/// English-sounding nonsense, on a workbench whose whole claim is multilingual
/// input. Every one of the three installed models is a multilingual ggml build,
/// so `auto` is always a valid ask.
fn language_code(language: &str) -> String {
    let v = language.trim().to_ascii_lowercase();
    if v.len() == 2 && v.chars().all(|c| c.is_ascii_alphabetic()) {
        return v;
    }
    match v.as_str() {
        "english" => "en".into(),
        "hindi" => "hi".into(),
        _ => "auto".into(),
    }
}

fn validate_wav(bytes: &[u8]) -> CoreResult<()> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(CoreError::ExecutionFailed(
            "The microphone recording was not a valid WAV file, so it was not processed.".into(),
        ));
    }
    if bytes.len() > MAX_WAV_BYTES {
        return Err(too_long(Some(bytes.len())));
    }
    Ok(())
}

pub async fn transcribe(
    st: &AppState,
    wav_base64: String,
    model_id: String,
    language: String,
    vocabulary: String,
) -> CoreResult<String> {
    let ready = status(st, &model_id)?;
    if !ready.ready {
        return Err(CoreError::ExecutionFailed(ready.detail));
    }
    // A loose guard so an absurd payload is refused before it is decoded into
    // memory. The limit itself is enforced on the decoded bytes, where the
    // length can be stated in the unit the operator recorded in.
    if wav_base64.len() > (MAX_WAV_BYTES * 4 / 3 + 8) * 4 {
        return Err(too_long(None));
    }
    let wav = base64::engine::general_purpose::STANDARD
        .decode(wav_base64)
        .map_err(|_| CoreError::ExecutionFailed("The local microphone recording could not be decoded.".into()))?;
    validate_wav(&wav)?;

    let temp_root = crate::registry::sovereign_root().join("tmp");
    std::fs::create_dir_all(&temp_root)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let temp = TempAudio {
        wav: temp_root.join(format!("voice-{id}.wav")),
        text: temp_root.join(format!("voice-{id}.txt")),
    };
    std::fs::write(&temp.wav, wav)?;

    let runtime = PathBuf::from(ready.runtime_path.expect("ready status has a runtime"));
    let model = PathBuf::from(ready.model_path.expect("ready status has a model"));
    let output_without_extension = temp.text.with_extension("");
    let vocabulary = vocabulary.trim().chars().take(1_000).collect::<String>();
    let language = language_code(&language);
    let wav_path = temp.wav.clone();
    let text_path = temp.text.clone();

    tokio::task::spawn_blocking(move || {
        let mut command = Command::new(runtime);
        command
            .arg("--model").arg(model)
            .arg("--file").arg(&wav_path)
            .arg("--output-txt")
            .arg("--output-file").arg(output_without_extension)
            .arg("--no-timestamps")
            .arg("--no-prints")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.arg("--language").arg(&language);
        if !vocabulary.is_empty() {
            command.arg("--prompt").arg(vocabulary);
        }

        let mut child = winproc::spawn_contained(command, JobLimits::router())?;
        let started = Instant::now();
        let exit = loop {
            if let Some(exit) = child.child.try_wait()? {
                break exit;
            }
            if started.elapsed() >= TRANSCRIPTION_TIMEOUT {
                (child.killer())();
                return Err(CoreError::Timeout(
                    format!(
                        "Local transcription ran for {} minutes without finishing and was stopped. A shorter recording, or the Tiny model, will complete.",
                        TRANSCRIPTION_TIMEOUT.as_secs() / 60
                    ),
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        if !exit.success() {
            return Err(CoreError::ExecutionFailed(format!(
                "The local whisper.cpp process stopped with {exit} before producing a transcription."
            )));
        }
        let transcript = std::fs::read_to_string(&text_path).map_err(|_| {
            CoreError::ExecutionFailed(
                "The local whisper.cpp process finished without producing transcription text.".into(),
            )
        })?;
        let transcript = transcript.trim().to_string();
        if transcript.is_empty() {
            return Err(CoreError::ExecutionFailed(
                "No speech was detected in the local microphone recording.".into(),
            ));
        }
        Ok(transcript)
    })
    .await
    .map_err(|error| CoreError::ExecutionFailed(format!("The local transcription worker stopped: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_models_map_to_whisper_weights() {
        assert_eq!(model_filename("whisper.cpp-tiny").unwrap(), "ggml-tiny.bin");
        assert_eq!(model_filename("whisper.cpp-base").unwrap(), "ggml-base.bin");
        assert_eq!(model_filename("whisper.cpp-small").unwrap(), "ggml-small.bin");
        assert!(model_filename("moonshine-tiny").is_err());
    }

    #[test]
    fn wav_validation_rejects_non_audio_and_oversize_input() {
        assert!(validate_wav(b"not audio").is_err());
        let mut wav = vec![0_u8; 44];
        wav[0..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        assert!(validate_wav(&wav).is_ok());
        wav.resize(MAX_WAV_BYTES + 1, 0);
        assert!(validate_wav(&wav).is_err());
    }

    /// The cap is stated in minutes and enforced in bytes; if those two ever
    /// disagree again, the message operators read will be wrong once more.
    #[test]
    fn the_byte_cap_is_exactly_the_stated_number_of_minutes() {
        assert_eq!(MAX_AUDIO_SECONDS, 300);
        assert_eq!(MAX_WAV_BYTES, 44 + 300 * 32_000);
        assert_eq!(wav_seconds(MAX_WAV_BYTES), MAX_AUDIO_SECONDS);
        // The old 16 MiB cap: over the limit, and the message now says so instead
        // of calling 8m44s "inside the five-minute limit".
        assert_eq!(wav_seconds(16 * 1024 * 1024), 524);
        assert!(16 * 1024 * 1024 > MAX_WAV_BYTES);
    }

    #[test]
    fn the_refusal_names_the_limit_and_the_recording_it_measured() {
        let m = too_long(Some(44 + 400 * 32_000)).message();
        assert!(m.contains("up to 5 minutes"), "{m}");
        assert!(m.contains("6m 40s"), "{m}");
        // Without decoded bytes there is no duration to claim, so none is claimed.
        assert!(!too_long(None).message().contains("about"));
    }

    /// Omitting `--language` means English, not auto-detect, so every selection
    /// has to resolve to something passable — including the display strings older
    /// builds persisted.
    #[test]
    fn every_language_selection_resolves_to_a_flag_value() {
        assert_eq!(language_code("hi"), "hi");
        assert_eq!(language_code(" HI "), "hi");
        assert_eq!(language_code("Hindi"), "hi");
        assert_eq!(language_code("English"), "en");
        assert_eq!(language_code("auto"), "auto");
        assert_eq!(language_code("Multilingual"), "auto");
        assert_eq!(language_code(""), "auto");
        assert_eq!(language_code("klingon"), "auto");
    }
}
