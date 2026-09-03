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

const DEFAULTS: TranscriptionPreferences = {
  modelId: 'whisper.cpp-base',
  language: 'Auto detect',
  vocabulary: '',
};

/** Read the same local-only preferences edited by Settings. */
export function transcriptionPreferences(): TranscriptionPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Record<string, unknown>;
    return {
      modelId: typeof stored.transcriptionModel === 'string' ? stored.transcriptionModel : DEFAULTS.modelId,
      language: typeof stored.transcriptionLanguage === 'string' ? stored.transcriptionLanguage : DEFAULTS.language,
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
