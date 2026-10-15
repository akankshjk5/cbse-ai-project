import 'server-only';

/**
 * Whether a route may open generation work at all.
 *
 * The workers are where money is spent, and the factories in
 * `src/lib/cloud-lesson/` refuse to build a paid client that was not opted
 * into — that is the control, and it holds whatever a route does. This is the
 * courtesy in front of it: a lesson whose stages cannot run should be refused
 * at the request, not queued and failed minutes later in a worker a teacher
 * cannot see.
 *
 * The distinction matters because the two answer different questions. The
 * factory asks "may this process spend here"; admission asks "will this lesson
 * be able to finish". A route that skipped this check still cannot spend; it
 * would only produce a worse experience.
 */

import {
  GENERATION_STAGES,
  type GenerationStage,
  type PolicyEnv,
  policyEnv,
  resolveStage,
} from '@/lib/generation/providers/policy';
import { generatorIdFromEnv, type GeneratorId } from '@/lib/generation/providers/registry';

export interface AdmissionResult {
  admitted: boolean;
  generator: GeneratorId;
  /** The provider chosen for each stage, for the job record and the response. */
  providers: Record<GenerationStage, { id: string; kind: string; model: string }>;
  /** Stages configured to use a paid API. Empty on a default deployment. */
  paidStages: GenerationStage[];
  reason: string | null;
}

/**
 * The generator and per-stage providers this deployment will actually use.
 *
 * Reads configuration only — no network, no database — so a route can call it
 * before touching anything and a test can pass an explicit environment.
 */
export function admitGeneration(
  env: PolicyEnv = policyEnv(),
  generatorRaw: string | undefined = process.env.LESSON_GENERATOR,
): AdmissionResult {
  let generator: GeneratorId;
  try {
    generator = generatorIdFromEnv(generatorRaw);
  } catch (error) {
    // A misconfigured generator is refused rather than defaulted: silently
    // running on a different cost base is worse than refusing the request.
    return {
      admitted: false, generator: 'local',
      providers: blankProviders(), paidStages: [],
      reason: error instanceof Error ? error.message : 'LESSON_GENERATOR is invalid.',
    };
  }

  const providers = {} as AdmissionResult['providers'];
  const paidStages: GenerationStage[] = [];
  for (const stage of GENERATION_STAGES) {
    const provider = resolveStage(stage, env);
    providers[stage] = { id: provider.id, kind: provider.kind, model: provider.model };
    if (provider.kind === 'external') paidStages.push(stage);
  }

  // The cloud generator is only meaningful when its stages were opted into.
  // Selecting it with the paid switches off would queue work whose every stage
  // the factories will refuse, so it is refused here with a readable reason.
  if (generator === 'cloud' && paidStages.length === 0) {
    return {
      admitted: false, generator, providers, paidStages,
      reason: 'LESSON_GENERATOR=cloud needs ALLOW_EXTERNAL_PROVIDERS=true and stages named in EXTERNAL_PROVIDERS.',
    };
  }

  return { admitted: true, generator, providers, paidStages, reason: null };
}

function blankProviders(): AdmissionResult['providers'] {
  const out = {} as AdmissionResult['providers'];
  for (const stage of GENERATION_STAGES) {
    out[stage] = { id: 'unknown', kind: 'unknown', model: 'unknown' };
  }
  return out;
}

/**
 * The provenance a job should record about who generated it.
 *
 * Written onto the lesson so a cost report can say which provider produced
 * each stage without inferring it from the bill afterwards.
 */
export function generationProvenance(result: AdmissionResult): Record<string, string> {
  const out: Record<string, string> = { generator: result.generator };
  for (const stage of GENERATION_STAGES) out[stage] = result.providers[stage].model;
  return out;
}
