/**
 * Narration audio for the cloud lesson engine, in plain TypeScript.
 *
 * Gemini speaks one sentence per scene as 24 kHz 16-bit mono PCM. This module
 * turns those sentences into one narration track whose every sentence starts on
 * its scene's boundary:
 *
 *   trimSilence → (speedUp, only if a sentence overruns its slot) → padTo → concat → toWav
 *
 * Pure functions on Float32Array samples in [-1, 1], no ffmpeg, no native code,
 * so the same code runs on Vercel, the worker box and in tests.
 */

export interface Pcm {
  samples: Float32Array;
  sampleRate: number;
}

export function fromInt16(pcm: Int16Array, sampleRate: number): Pcm {
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768;
  return { samples, sampleRate };
}

export function durationSeconds(audio: Pcm): number {
  return audio.samples.length / audio.sampleRate;
}

/**
 * Cuts leading and trailing near-silence so every sentence starts promptly on
 * its scene and the gaps between sentences are even. Keeps `padSeconds` of
 * air at each end so a consonant is never clipped.
 */
export function trimSilence(audio: Pcm, threshold = 0.012, padSeconds = 0.09): Pcm {
  const { samples, sampleRate } = audio;
  const frame = Math.max(1, Math.round(sampleRate * 0.01));
  let first = -1;
  let last = -1;
  for (let start = 0; start < samples.length; start += frame) {
    let energy = 0;
    const end = Math.min(samples.length, start + frame);
    for (let i = start; i < end; i += 1) energy += samples[i] * samples[i];
    const rms = Math.sqrt(energy / (end - start));
    if (rms > threshold) {
      if (first < 0) first = start;
      last = end;
    }
  }
  if (first < 0) return { samples: new Float32Array(0), sampleRate };
  const pad = Math.round(sampleRate * padSeconds);
  return { samples: samples.slice(Math.max(0, first - pad), Math.min(samples.length, last + pad)), sampleRate };
}

/**
 * Speeds speech up by `ratio` (> 1) WITHOUT changing its pitch — WSOLA
 * (waveform-similarity overlap-add), the method ffmpeg's `atempo` uses.
 * Each output frame is taken from near its nominal input position, at the
 * offset whose waveform best continues the previous frame, so pitch periods
 * line up and the voice does not warble or chipmunk.
 */
export function speedUp(audio: Pcm, ratio: number): Pcm {
  if (!(ratio > 1)) return audio;
  const { samples: x, sampleRate } = audio;
  const frame = Math.max(256, 2 ** Math.round(Math.log2(sampleRate * 0.04)));   // ~40 ms
  const synthesisHop = frame / 2;
  const analysisHop = synthesisHop * ratio;
  const tolerance = Math.round(frame / 4);
  const outLength = Math.floor(x.length / ratio);
  if (x.length < frame * 2 || outLength < frame) {
    // Too short to overlap-add; plain decimation is inaudible at this length.
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i += 1) out[i] = x[Math.min(x.length - 1, Math.floor(i * ratio))];
    return { samples: out, sampleRate };
  }

  const window = new Float32Array(frame);
  for (let i = 0; i < frame; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
  const y = new Float32Array(outLength + frame);
  const weight = new Float32Array(outLength + frame);
  const maxStart = x.length - frame;

  let previous = 0;
  for (let k = 0; k * synthesisHop < outLength; k += 1) {
    const nominal = Math.min(maxStart, Math.round(k * analysisHop));
    let best = nominal;
    if (k > 0) {
      // The waveform that would naturally follow the previous frame.
      const natural = Math.min(maxStart, previous + synthesisHop);
      let bestScore = -Infinity;
      const lo = Math.max(0, nominal - tolerance);
      const hi = Math.min(maxStart, nominal + tolerance);
      for (let candidate = lo; candidate <= hi; candidate += 1) {
        let score = 0;
        // Correlate on every second sample: half the cost, same choice.
        for (let i = 0; i < frame; i += 2) score += x[candidate + i] * x[natural + i];
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }
    const at = k * synthesisHop;
    for (let i = 0; i < frame; i += 1) {
      y[at + i] += x[best + i] * window[i];
      weight[at + i] += window[i];
    }
    previous = best;
  }

  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) out[i] = weight[i] > 1e-6 ? y[i] / weight[i] : 0;
  return { samples: out, sampleRate };
}

/** Appends silence so the audio is exactly `seconds` long. Throws if it is already longer. */
export function padTo(audio: Pcm, seconds: number): Pcm {
  const target = Math.round(seconds * audio.sampleRate);
  if (audio.samples.length > target) {
    throw new Error(`Audio is ${durationSeconds(audio).toFixed(3)} s, longer than its ${seconds} s slot`);
  }
  const out = new Float32Array(target);
  out.set(audio.samples, 0);
  return { samples: out, sampleRate: audio.sampleRate };
}

export function concat(parts: Pcm[]): Pcm {
  if (parts.length === 0) throw new Error('Nothing to concatenate');
  const sampleRate = parts[0].sampleRate;
  if (parts.some((part) => part.sampleRate !== sampleRate)) throw new Error('Sample rates differ');
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.samples.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part.samples, offset);
    offset += part.samples.length;
  }
  return { samples: out, sampleRate };
}

/** Scales so the loudest sample sits at `peak`, keeping every sentence at one level. */
export function normalizePeak(audio: Pcm, peak = 0.89): Pcm {
  let max = 0;
  for (const value of audio.samples) max = Math.max(max, Math.abs(value));
  if (max < 1e-4) return audio;
  const gain = peak / max;
  const out = new Float32Array(audio.samples.length);
  for (let i = 0; i < out.length; i += 1) out[i] = audio.samples[i] * gain;
  return { samples: out, sampleRate: audio.sampleRate };
}

/** 16-bit PCM mono WAV. */
export function toWav(audio: Pcm): Buffer {
  const { samples, sampleRate } = audio;
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Duration of a 16-bit mono WAV, read from its header. */
export function wavDurationSeconds(wav: Buffer): number {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  const byteRate = wav.readUInt32LE(28);
  const dataBytes = wav.readUInt32LE(40);
  return dataBytes / byteRate;
}
