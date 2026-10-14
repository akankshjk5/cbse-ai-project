import 'server-only';

import {
  concat,
  durationSeconds,
  fromInt16,
  normalizePeak,
  padTo,
  type Pcm,
  speedUp,
  toWav,
  trimSilence,
} from './audio';
import { type CallOptions, geminiTransport, generateSpeech, type GeminiTransport, type SpeechPace, type VoiceStyle } from './gemini';
import type { CostMeter } from './pricing';

/**
 * Scene-aligned narration for the cloud lesson engine.
 *
 * Every scene's sentence is voiced on its own and fitted into its slot, so
 * sentence N always starts exactly at scene N's first frame — the video can
 * never drift away from what is being said. A sentence that will not fit even
 * after a brisker take and a modest, pitch-preserving speed-up is reported as an
 * overrun rather than squeezed: the prep worker then asks the narration editor
 * to shorten just that sentence and voices it again.
 */

/** Silence kept at the end of every slot so sentences never run into each other. */
export const SLOT_GUARD_SECONDS = 0.15;
/** The most a sentence is sped up. Past this it sounds hurried; shorten the text instead. */
export const MAX_SPEEDUP = 1.25;

export type LessonLanguage = 'en-IN' | 'hi-IN' | 'kn-IN';

export interface SceneVoice {
  index: number;
  /** Fitted speech, not yet padded to the slot. Null when the sentence overran. */
  speech: Pcm | null;
  /** Spoken length of the natural take, after trimming. */
  naturalSeconds: number;
  /** Spoken length as it will play. */
  finalSeconds: number;
  pace: SpeechPace;
  /** 1 = untouched. */
  speedUp: number;
  overran: boolean;
}

export interface VoiceSceneOptions extends Omit<CallOptions, 'stage'> {
  index: number;
  sentence: string;
  languageCode: LessonLanguage;
  slotSeconds: number;
  meter?: CostMeter;
  /** Default `teacher`; the storybook style uses `storyteller`. */
  voiceStyle?: VoiceStyle;
}

async function take(options: VoiceSceneOptions, pace: SpeechPace): Promise<Pcm> {
  const speech = await generateSpeech({ ...options, text: options.sentence, pace });
  const trimmed = trimSilence(fromInt16(speech.pcm, speech.sampleRate));
  if (trimmed.samples.length < trimmed.sampleRate * 0.4) {
    throw new Error(`Scene ${options.index} narration came back silent or truncated`);
  }
  return normalizePeak(trimmed);
}

export async function voiceScene(options: VoiceSceneOptions): Promise<SceneVoice> {
  const limit = options.slotSeconds - SLOT_GUARD_SECONDS;
  const natural = await take(options, 'natural');
  const naturalSeconds = durationSeconds(natural);
  const result = (speech: Pcm | null, pace: SpeechPace, ratio: number): SceneVoice => ({
    index: options.index,
    speech,
    naturalSeconds: round(naturalSeconds),
    finalSeconds: speech ? round(durationSeconds(speech)) : round(naturalSeconds),
    pace,
    speedUp: round(ratio),
    overran: speech === null,
  });

  if (naturalSeconds <= limit) return result(natural, 'natural', 1);

  // A brisker reading first: a voice that is simply asked to go faster sounds
  // more natural than any stretch applied afterwards.
  const brisk = await take(options, 'brisk');
  const [best, pace] = durationSeconds(brisk) < naturalSeconds ? [brisk, 'brisk' as const] : [natural, 'natural' as const];
  const bestSeconds = durationSeconds(best);
  if (bestSeconds <= limit) return result(best, pace, 1);

  const ratio = (bestSeconds / limit) * 1.01;
  if (ratio > MAX_SPEEDUP) return result(null, pace, ratio);
  const fitted = speedUp(best, ratio);
  const capped = fitted.samples.length > Math.round(limit * fitted.sampleRate)
    ? { samples: fitted.samples.slice(0, Math.round(limit * fitted.sampleRate)), sampleRate: fitted.sampleRate }
    : fitted;
  return result(capped, pace, ratio);
}

export interface VoiceLessonOptions extends Omit<CallOptions, 'stage'> {
  sentences: string[];
  languageCode: LessonLanguage;
  slotSeconds: number;
  meter?: CostMeter;
  /** Scenes voiced at once. Each takes one Gemini slot. Default 4. */
  concurrency?: number;
  /** Re-use earlier voices for these indexes (1-based) instead of calling Gemini again. */
  reuse?: Map<number, SceneVoice>;
  /** Default `teacher`; the storybook style uses `storyteller`. */
  voiceStyle?: VoiceStyle;
}

/** Voices every scene, in parallel, reusing any voices already fitted. */
export async function voiceLesson(options: VoiceLessonOptions): Promise<SceneVoice[]> {
  const voices: SceneVoice[] = new Array(options.sentences.length);
  const queue = options.sentences.map((sentence, position) => ({ sentence, index: position + 1 }));
  let failed = false;
  let firstError: unknown;
  const transport: GeminiTransport = {
    generateContent: (request) => {
      if (failed) return Promise.reject(new Error('Another scene narration failed; remaining calls were stopped.'));
      return (options.transport ?? geminiTransport()).generateContent(request);
    },
  };
  const workers = Array.from({ length: Math.max(1, Math.min(8, options.concurrency ?? 4)) }, async () => {
    try {
      for (let next = queue.shift(); next && !failed; next = queue.shift()) {
        const kept = options.reuse?.get(next.index);
        voices[next.index - 1] = kept && !kept.overran
          ? kept
          : await voiceScene({ ...options, transport, index: next.index, sentence: next.sentence });
      }
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
      throw error;
    }
  });
  // Do not record a job's final cost while sibling paid calls are still in
  // flight. A failed take stops new scenes; already-started calls are drained.
  await Promise.allSettled(workers);
  if (failed) throw firstError;
  return voices;
}

export interface AssembledNarration {
  wav: Buffer;
  durationSeconds: number;
  /** Per-scene timing, for the prepare job's metadata. */
  scenes: Omit<SceneVoice, 'speech'>[];
}

/** Pads every fitted sentence to its slot and joins them into one WAV. */
export function assembleNarration(voices: SceneVoice[], slotSeconds: number): AssembledNarration {
  const overran = voices.filter((voice) => voice.overran).map((voice) => voice.index);
  if (overran.length) throw new Error(`Scenes ${overran.join(', ')} narration does not fit; shorten before assembling`);
  const track = concat(voices.map((voice) => padTo(voice.speech!, slotSeconds)));
  return {
    wav: toWav(track),
    durationSeconds: round(durationSeconds(track)),
    scenes: voices.map((voice) => ({
      index: voice.index,
      naturalSeconds: voice.naturalSeconds,
      finalSeconds: voice.finalSeconds,
      pace: voice.pace,
      speedUp: voice.speedUp,
      overran: voice.overran,
    })),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
