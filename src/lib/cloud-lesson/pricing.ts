/**
 * What a Gemini call cost, from the token counts Gemini reports with it.
 *
 * Rates are USD per 1M tokens, standard paid tier, read from
 * https://ai.google.dev/gemini-api/docs/pricing on 2026-10-10. Thinking tokens
 * bill at the output rate. Several 3.x rates are promotional until 2026-12-31
 * and double on 2027-01-01; both are recorded, and the call's own date picks.
 * Re-check when a model changes — these numbers are what the lesson cost
 * records show.
 *
 * A model missing from the table prices as `null`, never 0: "not priced" and
 * "free" are different facts (the same rule as agent_runs.cost_usd).
 */

export interface GeminiRate {
  /** Text and image input, per 1M tokens. */
  input: number;
  /** Text output, including thinking, per 1M tokens. */
  output: number;
  /** Audio output, per 1M tokens (speech models). */
  audioOutput?: number;
  /** Image output, per 1M tokens (image models). */
  imageOutput?: number;
}

/** A rate, optionally replaced by `then` from `changesOn` (UTC date, inclusive). */
export interface GeminiRateCard extends GeminiRate {
  changesOn?: string;
  then?: GeminiRate;
}

export const GEMINI_RATES: Record<string, GeminiRateCard> = {
  // Text.
  'gemini-3.8-flash': { input: 0.75, output: 3.75, changesOn: '2027-01-01', then: { input: 1.5, output: 7.5 } },
  'gemini-3.6-flash': { input: 0.75, output: 3.75, changesOn: '2027-01-01', then: { input: 1.5, output: 7.5 } },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  // Speech: text in, audio out (~25 audio tokens per second).
  'gemini-3.8-flash-tts': {
    input: 0.5, output: 9, audioOutput: 9,
    changesOn: '2027-01-01', then: { input: 1, output: 18, audioOutput: 18 },
  },
  'gemini-3.8-flash-lite-tts': {
    input: 0.5, output: 6, audioOutput: 6,
    changesOn: '2027-01-01', then: { input: 1, output: 12, audioOutput: 12 },
  },
  // Images: a 1K image is ~1120 output tokens, $0.0336.
  'gemini-nano-banana-2.1': { input: 1.5, output: 7.5, imageOutput: 30 },
  'gemini-3.1-flash-lite-image': { input: 0.25, output: 1.5, imageOutput: 30 },
  // Gemini 2.5 — closed to new accounts, kept so an older key still prices.
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash-image': { input: 0.3, output: 2.5, imageOutput: 30 },
  'gemini-2.5-flash-tts': { input: 0.5, output: 10, audioOutput: 10 },
  'gemini-2.5-flash-preview-tts': { input: 0.5, output: 10, audioOutput: 10 },
};

/** The subset of Gemini's usageMetadata the calculation reads. */
export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  candidatesTokensDetails?: { modality?: string; tokenCount?: number }[];
}

export interface PricedUsage {
  promptTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  /** Null when the model has no rate in GEMINI_RATES. */
  costUsd: number | null;
}

/**
 * The rate in force on `at`. Strips a version suffix such as `-001` so
 * `gemini-2.5-flash-001` prices as `gemini-2.5-flash`.
 */
export function rateFor(model: string, at: Date = new Date()): GeminiRate | undefined {
  const card = GEMINI_RATES[model] ?? GEMINI_RATES[model.replace(/-\d{3}$/, '')];
  if (!card) return undefined;
  if (card.changesOn && card.then && at.toISOString().slice(0, 10) >= card.changesOn) return card.then;
  return card;
}

export function priceGeminiUsage(model: string, usage: GeminiUsage | undefined, at: Date = new Date()): PricedUsage {
  const promptTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;
  const thoughtsTokens = usage?.thoughtsTokenCount ?? 0;
  const rate = rateFor(model, at);
  if (!rate) return { promptTokens, outputTokens, thoughtsTokens, costUsd: null };

  // Split output by modality when Gemini reports it, so an image or audio
  // response bills at its own rate rather than the text rate.
  let audio = 0;
  let image = 0;
  for (const detail of usage?.candidatesTokensDetails ?? []) {
    const modality = (detail.modality ?? '').toUpperCase();
    if (modality === 'AUDIO') audio += detail.tokenCount ?? 0;
    if (modality === 'IMAGE') image += detail.tokenCount ?? 0;
  }
  const text = Math.max(0, outputTokens - audio - image);
  const cost = (
    promptTokens * rate.input
    + (text + thoughtsTokens) * rate.output
    + audio * (rate.audioOutput ?? rate.output)
    + image * (rate.imageOutput ?? rate.output)
  ) / 1_000_000;
  return { promptTokens, outputTokens, thoughtsTokens, costUsd: Math.round(cost * 1e6) / 1e6 };
}

export interface CostRecord extends PricedUsage {
  stage: string;
  model: string;
  latencyMs: number;
}

/**
 * Collects every Gemini call one job makes, so the job can report its total
 * to the database in one number and keep the detail in its output metadata.
 */
export class CostMeter {
  readonly records: CostRecord[] = [];

  add(record: CostRecord): void {
    this.records.push(record);
  }

  /** Sum of the calls that could be priced. */
  get totalUsd(): number {
    const total = this.records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
    return Math.round(total * 1e4) / 1e4;
  }

  /** How many calls had no known rate — shown so a partial total is not mistaken for a full one. */
  get unpricedCalls(): number {
    return this.records.filter((record) => record.costUsd === null).length;
  }

  /** A compact summary for a job's output_metadata. */
  summary() {
    const byStage: Record<string, { calls: number; costUsd: number; promptTokens: number; outputTokens: number }> = {};
    for (const record of this.records) {
      const entry = (byStage[record.stage] ??= { calls: 0, costUsd: 0, promptTokens: 0, outputTokens: 0 });
      entry.calls += 1;
      entry.costUsd = Math.round((entry.costUsd + (record.costUsd ?? 0)) * 1e6) / 1e6;
      entry.promptTokens += record.promptTokens;
      entry.outputTokens += record.outputTokens + record.thoughtsTokens;
    }
    return { totalUsd: this.totalUsd, unpricedCalls: this.unpricedCalls, byStage };
  }
}
