import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatSettingLines,
  parseLanguageLines,
  parseVocabularyLines,
  transcriptionModelOptions,
} from "./transcription-settings.js";

describe("transcription settings helpers", () => {
  it("offers exactly the local whisper models", () => {
    assert.deepEqual(
      transcriptionModelOptions.map((option) => option.value),
      ["whisper-tiny", "whisper-base", "whisper-small"],
    );
  });

  it("normalizes and deduplicates language codes", () => {
    assert.deepEqual(parseLanguageLines(" EN \nzh-TW\nen\n"), {
      values: ["en", "zh-tw"],
    });
    assert.deepEqual(formatSettingLines(["en", "fr"]), "en\nfr");
    assert.match(parseLanguageLines("english").error ?? "", /ISO-style/);
  });

  it("preserves vocabulary spelling while deduplicating case-insensitively", () => {
    assert.deepEqual(
      parseVocabularyLines(" ZeroLeak AI \nCodex CLI\nzeroleak ai\n"),
      {
        values: ["ZeroLeak AI", "Codex CLI"],
      },
    );
    assert.match(parseVocabularyLines("bad<term").error ?? "", /cannot/);
  });
});
