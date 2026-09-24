import OpenAI, { toFile } from 'openai';
import type { Config } from './config.js';

/** Server-side speech is off or the provider refused the model. */
export class VoiceUnavailable extends Error {}

export class VoiceError extends Error {}

export interface Transcript {
  text: string;
  /** Billed audio length. */
  seconds: number;
}

const RETRY_AFTER_MS = 10 * 60_000;

/** Words that help the recogniser with school speech. */
const PROMPT =
  'A school staff member speaking to the school assistant, in English, Hindi or Hinglish. ' +
  'Terms: attendance, homework, leave, casual leave, sick leave, class 6B, section A, roll number, ' +
  'fee dues, pending, approve, reject, UKG, LKG, maths, science, SST, Hindi, English.';

/**
 * Speech-to-text and text-to-speech through the model provider. When a model
 * is not configured or the provider refuses it, this reports itself
 * unavailable and the app falls back to the browser's own speech features.
 */
export class Voice {
  private readonly client: OpenAI | null;
  private sttDownUntil = 0;
  private ttsDownUntil = 0;

  constructor(private readonly config: Config) {
    this.client = config.openaiApiKey
      ? new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 1, timeout: 30_000 })
      : null;
  }

  get canTranscribe() {
    return !!this.client && !!this.config.sttModel && Date.now() > this.sttDownUntil;
  }

  get canSpeak() {
    return !!this.client && !!this.config.ttsModel && Date.now() > this.ttsDownUntil;
  }

  async transcribe(
    audio: Buffer,
    mimeType: string,
    clientSeconds: number,
    language?: string,
  ): Promise<Transcript> {
    if (!this.canTranscribe) throw new VoiceUnavailable();
    const ext = mimeType.includes('mp4') || mimeType.includes('m4a')
      ? 'm4a'
      : mimeType.includes('ogg')
        ? 'ogg'
        : mimeType.includes('wav')
          ? 'wav'
          : mimeType.includes('mpeg')
            ? 'mp3'
            : 'webm';
    try {
      const res = await this.client!.audio.transcriptions.create({
        model: this.config.sttModel,
        file: await toFile(audio, `speech.${ext}`, { type: mimeType }),
        prompt: PROMPT,
        ...(language ? { language } : {}),
      });
      const usage = (res as { usage?: { type: string; seconds?: number } }).usage;
      const seconds =
        usage?.type === 'duration' && usage.seconds ? usage.seconds : clientSeconds;
      return { text: res.text.trim(), seconds: Math.max(1, Math.round(seconds)) };
    } catch (err) {
      throw this.failure(err, 'stt');
    }
  }

  /** MP3 audio of the text, spoken in a calm, clear school-office voice. */
  async speak(text: string): Promise<Buffer> {
    if (!this.canSpeak) throw new VoiceUnavailable();
    try {
      const res = await this.client!.audio.speech.create({
        model: this.config.ttsModel,
        voice: this.config.ttsVoice,
        input: text,
        instructions:
          'Speak clearly and warmly at a natural pace, like a helpful school office assistant. Pronounce Indian names naturally.',
        response_format: 'mp3',
      });
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw this.failure(err, 'tts');
    }
  }

  private failure(err: unknown, kind: 'stt' | 'tts'): Error {
    if (err instanceof OpenAI.APIError) {
      console.error(`[sms-agent] ${kind} error ${err.status}: ${err.message}`);
      // Model not enabled for this key: stop trying for a while so every
      // request doesn't pay for a round trip to learn the same thing.
      if (err.status === 403 || err.status === 404 || err.status === 401) {
        if (kind === 'stt') this.sttDownUntil = Date.now() + RETRY_AFTER_MS;
        else this.ttsDownUntil = Date.now() + RETRY_AFTER_MS;
        return new VoiceUnavailable();
      }
    } else {
      console.error(`[sms-agent] ${kind} error`, err);
    }
    return new VoiceError(
      kind === 'stt' ? "Couldn't make out the audio. Try again." : "Couldn't play the reply aloud.",
    );
  }
}
