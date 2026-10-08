# CBSE AI Project — NCERT Lesson, Deck and Video Platform

A platform that turns an NCERT topic (for example *Class 10 Science — Light:
Reflection and Refraction*) into a structured lesson, a presentation and a
narrated video, generated from one canonical representation so the slides and
the video cannot drift apart.

This repository is the merge of two codebases. **Lumina Deck Pro is the spine**;
the news-video agent is a parts donor kept for reference during migration.

## Layout

| Path | What it is | Status |
|---|---|---|
| `src/`, `Agents/`, `ops/`, `supabase/`, `scripts/` | **Lumina Deck Pro** — Next.js 16 + Supabase + Clerk, the deck pipeline, the narrated-lesson pipeline and the RunPod GPU worker stack | Active |
| `legacy/video-agent/` | The FastAPI + Gemini news-video prototype (`better-assignment`) | Reference only — do not run |
| `legacy/cbse-scaffold/` | CBSE curriculum index and theme palettes salvaged from this repo's previous contents | To be folded into the canonical schema |
| `docs/LUMINA_README.md` | Lumina's original README | Reference |
| `CLAUDE.md` | Architecture notes and conventions | Active |

Sources merged:

- Lumina Deck Pro, branch `feat/motion-present-and-public-launch`, commit `807f28d`
- `better-assignment.zip` (AI News Video Studio prototype)

## What is already built

The lesson pipeline self-hosts its entire model stack on one 48 GB GPU:

| Role | Model |
|---|---|
| Image | Z-Image Turbo BF16 — 1024×576, 8 steps |
| Video | Wan 2.2 TI2V-5B FP16, image-to-video |
| Narration | Indic Parler-TTS, nine Indian languages, with a Whisper listen-back check |
| Lesson planning | Qwen3-4B |
| Visual QC | Qwen2.5-VL-3B |
| Translation | IndicTrans2 en-indic 1B |

Jobs run through a Postgres `SKIP LOCKED` queue with heartbeat recovery, bounded
retries and cancellation. See `ops/runpod/README.md` and `ops/runpod/BENCHMARK.md`
for the measured numbers.

## What the merge still needs

The two pipelines in `src/` — decks and lesson videos — share a database but no
content model, and nothing currently joins a deck to a lesson video. The work is:

1. A canonical lesson/scene schema with per-stage content fingerprints.
2. `slides.scene_key` binding each slide to its scene, so editing slide 4
   regenerates scene 4 and nothing else.
3. Moving deck builds out of the Next.js `after()` callback onto the queue that
   already exists (`CLAUDE.md` describes why).
4. Per-scene narration, so a text edit re-synthesises one sentence.
5. Folding `legacy/cbse-scaffold/curriculum-index.json` into the schema's
   curriculum block.

## Not carried over from the prototype

`legacy/video-agent/` is kept for reading, not running. It is a 60-second
vertical **news** short generator, not an educational one: its script format has
no scene objects, narration is one undivided blob, output is hard-coded to 9:16
at 720p, and the API refuses concurrent jobs by design. Its image, video, TTS and
assembly tools are all superseded by the self-hosted stack above.

Three ideas from it are worth porting: the named visual style derived from a
reference image (`tools/create_style_json.py`), the offline fixture replay mode
(`DRY_RUN=1`) for load testing without GPU spend, and per-stage tracing.

Two things were deliberately **excluded** when it was copied in:

- `.env` — it contained live Vertex AI and OpenRouter credentials. **Those keys
  should be treated as disclosed and rotated.**
- `samples/dry_run/` media (~54 MB of mp4, jpg and wav) — the JSON fixtures are
  kept; the binaries are not, to keep them out of git history.

## Previous contents of this repository

This repo previously held an Express scaffold for a CBSE PPT generator. Its two
core services (`aiService.js`, `pptxBuilder.js`) were empty files, and Lumina's
`Agents/pptx/builder.ts` supersedes them. The curriculum index and theme palettes
were kept under `legacy/cbse-scaffold/`; everything else remains in git history
at commit `7b0f435` and can be restored with:

```bash
git checkout 7b0f435 -- backend/
```

## Which files are production, and which are reference

Nothing under `legacy/` is imported, built, linted or type-checked. It is
excluded in `tsconfig.json` and `eslint.config.mjs`, and a grep for `legacy/`
across `src/`, `Agents/`, `ops/`, `scripts/` and `supabase/` returns only those
two exclusion lines.

| Area | Production path | Superseded (reference only) |
|---|---|---|
| Lesson/content planning | `src/lib/videos/planner.ts` (Qwen3-4B, per-scene, Zod-validated) | `legacy/video-agent/skills/scriptwriter_agent.md` |
| Deck planning and design | `Agents/manager.ts` + `Agents/Skills/*.md` | — |
| PPTX build | `Agents/pptx/builder.ts` (pptxgenjs) | `legacy/video-agent/` has none |
| Slide render / preview | `Agents/pptx/rasterize.ts`, `src/components/slides/slide-canvas.tsx` | — |
| Images | ComfyUI `ops/runpod/workflows/api/image-fast.json` (Z-Image Turbo) | `legacy/video-agent/tools/generate_storyboard_image.py` |
| Deck illustration | `Agents/tools/illustrate-slides.ts` (OpenRouter) | — |
| Narration / TTS | `ops/runpod/local_tts_service.py` (Indic Parler-TTS) | `legacy/video-agent/tools/generate_voiceover.py` |
| Video clips | ComfyUI `ops/runpod/workflows/api/video-fast.json` (Wan 2.2 TI2V-5B) | `legacy/video-agent/tools/generate_video_veo.py` |
| Deterministic motion | `animate_lesson_image()` in `ops/runpod/media_worker.py` | — |
| Scene composition | `ops/runpod/lesson_compositor.py` | — |
| Final assembly | `assemble_lesson_video()` in `ops/runpod/media_worker.py` | `legacy/video-agent/tools/compile_videos.py`, `add_audio_to_video.py` |
| Storage upload | `QueueClient.upload()` in `ops/runpod/media_worker.py` | `legacy/video-agent/api/main.py` archive bundles |
| Job queue | Postgres `claim_*` / `heartbeat_*` / `complete_*` / `fail_*` RPCs | `legacy/video-agent/api/main.py` in-memory dict |
| Worker loop | `ops/runpod/media_worker.py` `main()` | `legacy/video-agent/Agent.py` |

## Getting started

Verified on a clean checkout with Node 24 and Python 3.12:

```bash
npm ci
npx next typegen          # generates .next/types — typecheck fails without it
cp .env.example .env      # fill in Supabase, Clerk and OpenRouter values
npm run db:start          # needs Docker running
npm run dev
```

`npx next typegen` is not optional on a fresh clone. `tsconfig.json` includes
`.next/types/**/*.ts`, so `PageProps` and `LayoutProps` do not exist until Next
has generated them, and `npm run typecheck` reports five errors without it.

### Checks that run with no credentials

```bash
npm run typecheck                         # clean
npm run lint                              # 0 errors, 2 pre-existing warnings
npm run smoke                             # builds and validates a real .pptx
npm run smoke:render                      # .pptx + browser preview, compared
cd ops/runpod && python -m unittest test_media_worker test_lesson_compositor
```

`npm run smoke:research` and `npm run smoke:deck` call OpenRouter and need a
funded `OPENROUTER_API_KEY`.

### GPU workers

Provisioned separately — see `ops/runpod/README.md` and `ops/runpod/.env.example`.
`scripts/connect-runpod.ps1` opens the five SSH forwards the app expects
(18080, 18081, 18082, 8188, 8090). The app refuses non-loopback URLs for these
services, so they are never exposed publicly.

## Known gaps

These are tracked rather than hidden; the first is the main one.

1. **The deck pipeline and the lesson-video pipeline are not connected.** They
   share a database, auth and a UI shell, and nothing else. No foreign key
   joins `decks`/`slides` to `lesson_video_projects`/`lesson_video_scenes`, no
   module imports both, and the two plan their content separately. Editing a
   slide cannot regenerate a video scene today. Closing this is the canonical
   lesson/scene schema described above.
2. **The lesson-video worker is pinned to one owner.** `claim_lesson_video_job_for_owner`
   and the `scope.ownerId` check in `src/lib/videos/local-ai.ts` mean a running
   worker serves exactly one Clerk user. Multi-tenant generation needs the
   unscoped claim plus priority and fair-share ordering.
3. **Lesson preparation runs in the request.** `src/app/api/lesson-videos/route.ts`
   does planning, translation and TTS inside `after()` with `maxDuration = 900`.
   Only image and video work is queued.
4. **Deck builds also run in the request**, via `after()`. `CLAUDE.md` explains
   why that is not a queue and what the fix is.
5. **The RAG path is schema-only.** `documents` and `document_chunks` exist with
   pgvector indexes; no code queries them, and the `GENAI_*` / `GOOGLE_CLOUD_*`
   settings in `src/lib/env.ts` are declared but never read.
6. **`legacy/cbse-scaffold/curriculum-index.json` is not wired to anything.**
   The deck form validates a board against `src/lib/boards.ts`; the lesson-video
   form has class and subject but no board field.
