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

const MAX_WAV_BYTES: usize = 16 * 1024 * 1024;
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

fn language_code(language: &str) -> Option<&'static str> {
    match language.trim().to_ascii_lowercase().as_str() {
        "english" => Some("en"),
        "hindi" => Some("hi"),
        _ => None,
    }
}

fn validate_wav(bytes: &[u8]) -> CoreResult<()> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(CoreError::ExecutionFailed(
            "The microphone recording was not a valid WAV file, so it was not processed.".into(),
        ));
    }
    if bytes.len() > MAX_WAV_BYTES {
        return Err(CoreError::ExecutionFailed(
            "The microphone recording is longer than the five-minute local transcription limit.".into(),
        ));
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
    if wav_base64.len() > (MAX_WAV_BYTES * 4 / 3) + 8 {
        return Err(CoreError::ExecutionFailed(
            "The microphone recording is longer than the five-minute local transcription limit."
                .into(),
        ));
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
        if let Some(code) = language_code(&language) {
            command.arg("--language").arg(code);
        }
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
                    "Local voice transcription exceeded five minutes and was stopped.".into(),
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
}
