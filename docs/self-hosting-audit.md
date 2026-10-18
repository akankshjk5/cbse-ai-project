# Can Lumina run without a third-party AI API?

**Audited 19 October 2026** at commit `fa0994a`, by tracing both workflows from
the teacher's request to the finished file.

**Short answer: the lesson-video path yes, the deck path no — until this
commit, and even now only for planning.** Deck *images* still require
OpenRouter, and that is unresolved.

## Method

Every outbound AI host in `src/`, `Agents/`, `ops/` and `scripts/`, then the
call sites, then whether each is reachable on a default deployment.

```
https://openrouter.ai/api/v1/chat/completions   Agents/Agent.ts, Agents/images.ts
https://openrouter.ai/api/v1/key                scripts/doctor.mts (auth probe only)
https://generativelanguage.googleapis.com       scripts/doctor.mts (auth probe only)
https://api.higgsfield.ai                       src/lib/cloud-lesson/higgsfield.ts
https://fal.run/                                Agents/image-providers/fal.ts
```

## The dependencies

| Dependency | Where | Class | Reachable by default? |
|---|---|---|---|
| OpenRouter — deck planning | `Agents/Agent.ts` | **was required** | **Was yes. Fixed in this commit** |
| OpenRouter — deck images | `Agents/images.ts:41` | **required** | **Yes — unresolved** |
| Higgsfield / Kling | `src/lib/cloud-lesson/higgsfield.ts` | optional | No — two switches, guarded at the factory |
| Gemini | `src/lib/cloud-lesson/gemini.ts` | optional | No — same guard |
| fal.ai | `Agents/image-providers/fal.ts` | **dead code** | No — nothing imports it |
| OpenRouter / Gemini auth probes | `scripts/doctor.mts` | development-only | No — `--auth` opt-in, metadata endpoints only |

### Dead code worth knowing about

`Agents/image-providers/` defines an `ImageProvider` interface with two
implementations, `fal.ts` and `openrouter.ts`. **Nothing imports any of it.**
`Agents/images.ts` hardcodes the OpenRouter URL at line 41 instead. The
abstraction that would make a local image provider easy exists and is not
plugged in — which is the opposite of what reading the directory suggests.

## What was wrong with the deck planner

```ts
const openrouter = new OpenRouter({ apiKey: serverEnv.openRouterApiKey });
```

At module scope. `serverEnv.openRouterApiKey` is a getter that calls
`required()`, so **importing anything that transitively reached `Agent.ts`
threw** when the key was absent. The paid dependency announced itself as an
import error rather than as a policy decision, and no local alternative could
be taken because the module never finished loading.

It also bypassed the provider policy entirely. Every other stage asks
`resolveStage()` which provider to use; this one did not ask.

### The fix in this commit

Two changes, both small:

1. **The client is built on first use**, not at import. Importing no longer
   requires a key.
2. **`generateStructured` asks the policy.** When `plan` resolves to local —
   the default, since `ALLOW_EXTERNAL_PROVIDERS` is unset — it calls
   `ops/runpod/local_planner_service.py` on `/structured`, the same Qwen3-4B
   service the lesson planner already uses. The Zod schema is converted with
   `z.toJSONSchema` rather than described twice, and the response is parsed
   against the same schema rather than trusted.

Features the local service has no equivalent for — image inputs, web search —
raise an `AgentError` naming the stage and telling the operator how to opt into
a paid provider deliberately. A caller is never quietly served something
weaker.

## What is still required, and why I did not fix it

**`Agents/images.ts` requires OpenRouter for deck images.** It posts to a
hardcoded URL with `serverEnv.openRouterApiKey`.

I did not change it. A local image provider would need the ComfyUI path
`images.ts` has no notion of, a different prompt dialect (`promptStyle` in the
unwired interface exists for exactly this), and the palette harmonisation in
`./palette` applied to a different model's output. That is a feature, not a
fix, and doing it blind — with no GPU here to see whether Z-Image produces
usable slide art at `2560×1440` — would be guessing.

**So the honest status is:** a deployment with no third-party key can generate
lesson videos end to end and can plan a deck, but cannot put generated images
on its slides. `OPENROUTER_IMAGE_TIER=off` disables deck images entirely,
which is a working deck without illustrations — the only fully self-hosted
deck configuration available today.

## Recommended order

1. **Wire `Agents/images.ts` to the existing `ImageProvider` interface.**
   Mechanical, no behaviour change, and it creates the seam.
2. **Add a local provider implementing that interface** against ComfyUI, once
   a GPU exists to judge the output.
3. **Delete `fal.ts`** or wire it. Dead code that reads like a feature is worse
   than no code.

## Verified

- `npx tsc --noEmit` clean after the change.
- The policy guard is the same one 10 suites already cover; `test:enforcement`
  and `test:providers` still pass.

## Not verified

- **The local planner path has never executed.** No planner service runs here,
  so `generateStructuredLocally` has not produced a deck. The code is written
  and typechecked; it is not proven.
- Whether Qwen3-4B's structured output is good enough for deck planning. That
  is a quality question needing a GPU and a human reading the result.

---

# Rights enforcement: documented, not implemented

Traced the same day, and the finding is worse than expected.

`src/lib/textbooks/ktbs.ts` defines `ReuseRights = 'unresolved' | 'link_only' |
'granted' | 'refused'` above the comment *"Nothing publishes at
`unresolved`."* `scripts/ingest-ktbs-catalogue.mts` writes
`reuseRights: 'unresolved'` into the catalogue JSON.

**No database column records rights status anywhere.** Checked every table:

- `reserve_cloud_lesson` mentions rights, licence or permission **zero times**
- `lesson_assets` and `cloud_lesson_projects` have **zero** rights, licence or
  visibility columns

So the sentence "Nothing publishes at `unresolved`" describes an intention with
no mechanism behind it. A lesson derived from a textbook whose rights are
unresolved can be published, marked reusable, and served across a school with
nothing checking — and the buckets holding it are `public = true`, so the
object is world-readable too.

The `lesson_sources` table named in the original reuse brief was never built.
That is where this belongs: textbook edition, source page, provenance, and the
applicable reuse right, with `publish_cloud_lesson` refusing anything whose
sources are unresolved.

**This is a product risk, not a code-style one.** The entire content strategy
rests on textbook material, the rights are genuinely unresolved, and nothing in
the system would stop a lesson built from it being shared.
