import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveSttModelsDir,
  resolveWhisperBinary,
  transcribeAudioLocally,
  whisperTranscriptionArgs,
} from "../../../src/domains/transcription/transcription.service.js";

describe("whisper transcription arguments", () => {
  it("defaults to auto language detection without context", () => {
    assert.deepEqual(
      whisperTranscriptionArgs({
        model: "whisper-base",
        languages: [],
        vocabulary: [],
      }),
      ["-np", "-otxt", "-l", "auto"],
    );
  });

  it("uses the first language as the decoding hint", () => {
    assert.deepEqual(
      whisperTranscriptionArgs({
        model: "whisper-small",
        languages: ["hi", "en"],
        vocabulary: [],
      }),
      ["-np", "-otxt", "-l", "hi"],
    );
  });

  it("passes vocabulary terms as the initial prompt", () => {
    assert.deepEqual(
      whisperTranscriptionArgs({
        model: "whisper-tiny",
        languages: ["en"],
        vocabulary: ["ZeroLeak AI", "CDU-4"],
      }),
      [
        "-np",
        "-otxt",
        "-l",
        "en",
        "--prompt",
        "ZeroLeak AI, CDU-4",
      ],
    );
  });
});

describe("runtime resolution", () => {
  it("prefers the environment override for the binary", () => {
    assert.equal(
      resolveWhisperBinaryWith({ ZEROLEAK_WHISPER_BIN: "D:/stt/whisper.exe" }),
      "D:/stt/whisper.exe",
    );
  });

  it("ignores blank environment overrides", () => {
    assert.equal(
      resolveWhisperBinaryWith({ ZEROLEAK_WHISPER_BIN: "   " }),
      "C:/sovereign/runtime/whisper.cpp/whisper-cli.exe",
    );
  });

  it("prefers the environment override for the models directory", () => {
    assert.equal(
      resolveSttModelsWithDir({ ZEROLEAK_STT_MODELS_DIR: "D:/stt/models" }),
      "D:/stt/models",
    );
  });
});

function resolveWhisperBinaryWith(env: Record<string, string>): string {
  return withEnvironment(env, () => resolveWhisperBinary());
}

function resolveSttModelsWithDir(env: Record<string, string>): string {
  return withEnvironment(env, () => resolveSttModelsDir());
}

function withEnvironment<T>(env: Record<string, string>, run: () => T): T {
  const saved = new Map(
    Object.entries(env).map(([key]) => [key, process.env[key]]),
  );
  const foreign = Object.keys(process.env).filter(
    (key) => key.startsWith("ZEROLEAK_") && !(key in env),
  );
  for (const key of foreign) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("local transcription validation", () => {
  it("rejects non-WAV audio before spawning the runtime", async () => {
    await assert.rejects(
      transcribeAudioLocally(
        {
          data: new Uint8Array([1, 2, 3, 4]),
          mimeType: "audio/webm",
          durationMs: 1000,
        },
        { model: "whisper-base", languages: [], vocabulary: [] },
      ),
      /requires WAV audio/,
    );
  });

  it("rejects recordings beyond the duration limit", async () => {
    await assert.rejects(
      transcribeAudioLocally(
        {
          data: new Uint8Array([1, 2, 3, 4]),
          mimeType: "audio/wav",
          durationMs: 9 * 60 * 1000,
        },
        { model: "whisper-base", languages: [], vocabulary: [] },
      ),
      /8 minutes/,
    );
  });
});
