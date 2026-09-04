import { call } from './transport';

const PREFERENCES_KEY = 'servergen.workbench-preferences.v1';

export interface TranscriptionPreferences {
  modelId: string;
  language: string;
  vocabulary: string;
}

export interface TranscriptionStatus {
  ready: boolean;
  modelId: string;
  modelPath?: string;
  runtimePath?: string;
  detail: string;
}

/**
 * The dictation languages offered, and the exact `--language` value each one
 * sends to whisper.cpp.
 *
 * The menu and the wire value are one list on purpose. The Settings menu used to
 * offer "Auto detect", "English", "Hindi" and "Multilingual" as display strings
 * that the core then had to recognise by name; it mapped two of them and let the
 * other two fall through to omitting the flag — which whisper.cpp reads as
 * English, not as detect-it (`-l LANG [en] spoken language ('auto' for
 * auto-detect)`). Hindi dictation came back as English-sounding nonsense.
 *
 * "Multilingual" is gone rather than fixed: whisper.cpp decodes one language per
 * run, so there was never a behaviour distinct from auto-detect for it to name.
 * Codes and names were read out of the installed `whisper.dll` language table,
 * which carries all 98 of them; these are the ones this deployment dictates in.
 */
export const TRANSCRIPTION_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'auto', label: 'Auto detect' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'kn', label: 'Kannada' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'mr', label: 'Marathi' },
  { code: 'bn', label: 'Bengali' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'ur', label: 'Urdu' },
  { code: 'as', label: 'Assamese' },
  { code: 'ne', label: 'Nepali' },
  { code: 'sa', label: 'Sanskrit' },
];

/**
 * Resolve any stored selection to a code in the list above, so a preference
 * written by an older build ("Auto detect", "Multilingual") still selects
 * something the menu can show and the core can pass through.
 */
export function languageCode(value: string): string {
  const wanted = value.trim().toLowerCase();
  const match = TRANSCRIPTION_LANGUAGES.find((entry) => entry.code === wanted || entry.label.toLowerCase() === wanted);
  return match?.code ?? 'auto';
}

const DEFAULTS: TranscriptionPreferences = {
  modelId: 'whisper.cpp-base',
  language: 'auto',
  vocabulary: '',
};

/** Read the same local-only preferences edited by Settings. */
export function transcriptionPreferences(): TranscriptionPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Record<string, unknown>;
    return {
      modelId: typeof stored.transcriptionModel === 'string' ? stored.transcriptionModel : DEFAULTS.modelId,
      language: languageCode(typeof stored.transcriptionLanguage === 'string' ? stored.transcriptionLanguage : DEFAULTS.language),
      vocabulary: typeof stored.transcriptionVocabulary === 'string' ? stored.transcriptionVocabulary : DEFAULTS.vocabulary,
    };
  } catch {
    return DEFAULTS;
  }
}

export const transcription = {
  status: (modelId: string) => call<TranscriptionStatus>('transcription_status', { modelId }),
  run: (wavBase64: string, preferences: TranscriptionPreferences) =>
    call<string>('transcription_run', {
      wavBase64,
      modelId: preferences.modelId,
      language: preferences.language,
      vocabulary: preferences.vocabulary,
    }),
};

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

/**
 * Decode the browser's own recording and produce the exact PCM format expected
 * by whisper.cpp. Conversion happens in the page; the audio never leaves the
 * workstation and the native core receives no codec-dependent container.
 */
export async function recordingToWav(recording: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const targetRate = 16_000;
    const targetLength = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, targetLength, targetRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  } finally {
    await context.close();
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the local recording.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Could not encode the local recording.'));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}
