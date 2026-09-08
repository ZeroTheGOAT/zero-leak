import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AudioTranscriptionResponse } from "@nervekit/contracts/transcription";
import type { TranscriptionSettings } from "@nervekit/contracts/settings";
import { AUDIO_TRANSCRIPTION_MAX_DURATION_MS } from "@nervekit/contracts/transcription";
import { ApplicationError } from "../../core/application-error.js";

/**
 * Local speech-to-text. Voice input is transcribed by the whisper.cpp CLI on
 * this machine — the captured audio never leaves the host, which is the
 * product's air-gapped posture. There is no hosted transcription path.
 *
 * The runtime binary and model files are resolved from, in order:
 *
 * 1. `ZEROLEAK_WHISPER_BIN` / `ZEROLEAK_STT_MODELS_DIR` environment variables
 *    (blank values are ignored), for deployments with a different layout.
 * 2. The sovereign deployment layout (`C:/sovereign/runtime/whisper.cpp` for
 *    the binary; `models/stt` beside the repository checkout).
 *
 * Models are the multilingual ggml variants of whisper.cpp: tiny (fastest),
 * base (balanced default), small (most accurate).
 */

const WHISPER_BIN_ENV = "ZEROLEAK_WHISPER_BIN";
const STT_MODELS_DIR_ENV = "ZEROLEAK_STT_MODELS_DIR";

const DEFAULT_WHISPER_BIN = "C:/sovereign/runtime/whisper.cpp/whisper-cli.exe";

const WHISPER_MODEL_FILES: Record<TranscriptionSettings["model"], string> = {
  "whisper-tiny": "ggml-tiny.bin",
  "whisper-base": "ggml-base.bin",
  "whisper-small": "ggml-small.bin",
};

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * whisper.cpp is CPU-bound; the small model can transcribe slower than
 * realtime. The recording itself is capped at 8 minutes, so a 15-minute
 * execution ceiling leaves ample headroom without waiting forever on a
 * wedged process.
 */
const WHISPER_TIMEOUT_MS = 15 * 60 * 1000;

export type AudioTranscriptionInput = {
  data: Uint8Array;
  mimeType: string;
  durationMs?: number;
};

function environmentOverride(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function repoSibling(...segments: string[]): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // src/domains/transcription → workbench-server package → packages → repo root.
  const repoRoot = resolve(moduleDir, "..", "..", "..", "..");
  return join(repoRoot, "..", ...segments);
}

export function resolveWhisperBinary(): string {
  return (
    environmentOverride(WHISPER_BIN_ENV) ??
    DEFAULT_WHISPER_BIN
  );
}

export function resolveSttModelsDir(): string {
  const override = environmentOverride(STT_MODELS_DIR_ENV);
  if (override) return override;
  const candidates = [
    repoSibling("models", "stt"),
    "C:/sovereign/models/stt",
  ];
  const existing = candidates.find((dir) => existsSync(dir));
  return existing ?? candidates[0];
}

/**
 * The whisper.cpp command-line arguments derived from the transcription
 * settings. One language hint is used per run (whisper.cpp decodes a single
 * language; the first configured language wins, `auto` detects); vocabulary
 * terms become the initial prompt, which whisper.cpp biases spellings toward.
 */
export function whisperTranscriptionArgs(
  settings: TranscriptionSettings,
): string[] {
  const args = ["-np", "-otxt"];
  const language = settings.languages[0]?.trim();
  args.push("-l", language ? language : "auto");
  if (settings.vocabulary.length > 0) {
    args.push("--prompt", settings.vocabulary.join(", "));
  }
  return args;
}

function isWavMimeType(mimeType: string): boolean {
  const normalized = (mimeType ?? "").split(";")[0]?.trim().toLowerCase();
  return (
    normalized === "audio/wav" ||
    normalized === "audio/wave" ||
    normalized === "audio/x-wav"
  );
}

function estimateDurationMs(sizeBytes: number): number {
  return Math.max(1, Math.round((sizeBytes * 1000) / 32_000));
}

function runWhisperCli(
  binary: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
    }, WHISPER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        rejectRun(
          new Error(
            `whisper.cpp was terminated (${signal}) after ${Math.round(WHISPER_TIMEOUT_MS / 1000)}s.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        rejectRun(
          new Error(
            `whisper.cpp exited with code ${code}: ${stderr.trim().slice(0, 500) || stdout.trim().slice(0, 500)}`,
          ),
        );
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

/**
 * Transcribe captured audio locally with whisper.cpp. The audio bytes are
 * written to a private temporary directory, decoded by the local runtime, and
 * removed afterwards; nothing is sent over the network.
 */
export async function transcribeAudioLocally(
  input: AudioTranscriptionInput,
  settings: TranscriptionSettings,
): Promise<AudioTranscriptionResponse> {
  if (input.data.byteLength === 0) {
    throw new ApplicationError(400, "EMPTY_AUDIO", "Audio upload is empty.");
  }
  if (input.data.byteLength > MAX_AUDIO_BYTES) {
    throw new ApplicationError(
      413,
      "AUDIO_TOO_LARGE",
      "Audio upload is larger than the 25 MB transcription limit.",
    );
  }
  // whisper.cpp decodes RIFF/WAVE input; the workbench recorder already
  // captures 16 kHz mono PCM WAV, which needs no conversion.
  if (!isWavMimeType(input.mimeType)) {
    throw new ApplicationError(
      400,
      "UNSUPPORTED_AUDIO_TYPE",
      `Local transcription requires WAV audio; received ${input.mimeType || "unknown"}.`,
    );
  }

  const durationMs =
    input.durationMs ?? estimateDurationMs(input.data.byteLength);
  if (durationMs > AUDIO_TRANSCRIPTION_MAX_DURATION_MS) {
    throw new ApplicationError(
      413,
      "AUDIO_DURATION_TOO_LONG",
      "Audio recordings are limited to 8 minutes.",
    );
  }

  const binary = resolveWhisperBinary();
  if (!existsSync(binary)) {
    throw new ApplicationError(
      500,
      "WHISPER_RUNTIME_UNAVAILABLE",
      `Local speech-to-text runtime not found at ${binary}. Install whisper.cpp there or point ${WHISPER_BIN_ENV} at whisper-cli.`,
    );
  }

  const modelsDir = resolveSttModelsDir();
  const modelFile = WHISPER_MODEL_FILES[settings.model];
  const modelPath = join(modelsDir, modelFile);
  if (!existsSync(modelPath)) {
    throw new ApplicationError(
      500,
      "STT_MODEL_UNAVAILABLE",
      `Transcription model ${modelFile} was not found under ${modelsDir}. Set ${STT_MODELS_DIR_ENV} to the directory holding the ggml whisper models.`,
    );
  }

  const workDir = await mkdtemp(join(tmpdir(), "zeroleak-stt-"));
  try {
    const audioPath = join(workDir, "input.wav");
    const outputPrefix = join(workDir, "transcript");
    await writeFile(audioPath, input.data);
    try {
      await runWhisperCli(binary, [
        "-m",
        modelPath,
        "-f",
        audioPath,
        "-of",
        outputPrefix,
        ...whisperTranscriptionArgs(settings),
      ]);
    } catch (cause) {
      throw new ApplicationError(
        502,
        "TRANSCRIPTION_FAILED",
        `Local transcription failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    const text = (await readFile(`${outputPrefix}.txt`, "utf8")).trim();
    if (!text) {
      throw new ApplicationError(
        502,
        "EMPTY_TRANSCRIPTION",
        "whisper.cpp produced an empty transcription.",
      );
    }
    return { text };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
