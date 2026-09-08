<script lang="ts">
import type { Settings, TranscriptionModel } from "$lib/api";
import {
  SettingsInlineMessage,
  SettingsRow,
  SettingsSection,
} from "$lib/presentation/settings";
import SelectField from "@nervekit/ui-kit/components/composites/select-field";
import { Textarea } from "@nervekit/ui-kit/components/ui/textarea";
import type { SettingsChange } from "../settings-change";
import {
  formatSettingLines,
  parseLanguageLines,
  parseVocabularyLines,
  transcriptionModelOptions,
} from "./transcription-settings";

type Props = {
  settingsDraft: Settings;
  onSettingsChange?: SettingsChange;
};

let { settingsDraft, onSettingsChange }: Props = $props();

function initialLanguageText(): string {
  return formatSettingLines(settingsDraft.transcription.languages);
}

function initialVocabularyText(): string {
  return formatSettingLines(settingsDraft.transcription.vocabulary);
}

let languageText = $state(initialLanguageText());
let vocabularyText = $state(initialVocabularyText());
let languageError = $state<string>();
let vocabularyError = $state<string>();

const languagePlaceholder = "en\nfr\nzh-tw";
const vocabularyPlaceholder = "ZeroLeak AI\nCodex CLI\nSvelte";

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function setModel(value: string): void {
  const model = value as TranscriptionModel;
  settingsDraft.transcription.model = model;
  onSettingsChange?.({ transcription: { model } }, { immediate: true });
}

function saveLanguages(): void {
  const parsed = parseLanguageLines(languageText);
  if (!("values" in parsed)) {
    languageError = parsed.error;
    return;
  }
  languageError = undefined;
  languageText = formatSettingLines(parsed.values);
  if (sameValues(settingsDraft.transcription.languages, parsed.values)) return;
  settingsDraft.transcription.languages = parsed.values;
  onSettingsChange?.({ transcription: { languages: parsed.values } });
}

function saveVocabulary(): void {
  const parsed = parseVocabularyLines(vocabularyText);
  if (!("values" in parsed)) {
    vocabularyError = parsed.error;
    return;
  }
  vocabularyError = undefined;
  vocabularyText = formatSettingLines(parsed.values);
  if (sameValues(settingsDraft.transcription.vocabulary, parsed.values)) return;
  settingsDraft.transcription.vocabulary = parsed.values;
  onSettingsChange?.({ transcription: { vocabulary: parsed.values } });
}
</script>

<SettingsSection
  id="model"
  title="Model"
  description="Choose the local speech-to-text model used for voice input."
>
  <SettingsInlineMessage tone="info" class="border-primary/40 bg-primary/10">
    Transcription runs locally through whisper.cpp on this machine. The
    recorded audio never leaves the host, and no account connection is
    required.
  </SettingsInlineMessage>
  <SettingsRow
    label="Transcription model"
    description="Whisper Base balances speed and accuracy; Small trades speed for accuracy on CPU-bound machines."
    layout="responsive"
  >
    {#snippet control()}
      <SelectField
        items={transcriptionModelOptions}
        value={settingsDraft.transcription.model}
        ariaLabel="Transcription model"
        class="w-full max-w-full sm:w-64"
        onValueChange={setModel}
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection
  id="context"
  title="Context"
  description="Language and vocabulary hints passed to whisper.cpp before decoding."
>
  <SettingsRow
    label="Expected languages"
    description="Enter one ISO language code per line. The first code is used as the decoding language; leave empty for auto-detection."
    htmlFor="transcription-languages"
    layout="stacked"
  >
    <Textarea
      id="transcription-languages"
      aria-label="Expected transcription languages"
      aria-invalid={languageError ? "true" : undefined}
      placeholder={languagePlaceholder}
      class="min-h-24"
      bind:value={languageText}
      oninput={() => (languageError = undefined)}
      onblur={saveLanguages}
    />
    {#if languageError}
      <SettingsInlineMessage tone="error" text={languageError} />
    {/if}
  </SettingsRow>

  <SettingsRow
    label="Custom vocabulary"
    description="Enter one name, acronym, or preferred spelling per line. These terms become whisper.cpp's initial prompt, biasing spellings in their favor."
    htmlFor="transcription-vocabulary"
    layout="stacked"
  >
    <Textarea
      id="transcription-vocabulary"
      aria-label="Custom transcription vocabulary"
      aria-invalid={vocabularyError ? "true" : undefined}
      placeholder={vocabularyPlaceholder}
      class="min-h-28"
      bind:value={vocabularyText}
      oninput={() => (vocabularyError = undefined)}
      onblur={saveVocabulary}
    />
    {#if vocabularyError}
      <SettingsInlineMessage tone="error" text={vocabularyError} />
    {/if}
    <p class="text-xs text-muted-foreground">
      Include only terms relevant to your dictation. Strong hints can bias the
      transcript toward words that were not spoken.
    </p>
  </SettingsRow>
</SettingsSection>
