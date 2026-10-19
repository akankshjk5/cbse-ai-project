# Which server, from whom, and what runs on it

Written 2026-10-20. **No GPU has been rented and no model has ever run.** Every
number below is either arithmetic from the weights the code loads, or a price
quoted from a dated source. Nothing here is measured, and `ops/cloud/benchmark.py`
exists to replace the arithmetic with measurements on the first run.

## The decision, in one line

**Rent one 48 GB card — an RTX A6000 or A40 — on RunPod Community Cloud for the
first run, at roughly $0.33/hour.** Setup plus a benchmark is about **$1**.
Then measure, and decide from the measurements whether 24 GB is enough for
steady use.

Nothing in Lumina is built for RunPod. The runbook (`ops/cloud/RUNBOOK-48GB.md`)
assumes Ubuntu, a CUDA driver and Python 3.11/3.12, and nothing else. RunPod is
where the cheapest such box currently is, not an architectural dependency — the
same steps run on Vast.ai, Hyperstack, a university machine or a box under a
desk. That separation is deliberate and was a requirement from the start.

**Renting a GPU is not a third-party AI API.** We rent bare hardware and run our
own weights on it. No lesson content is sent to Gemini, Higgsfield, OpenRouter
or anyone else; `npm run test:enforcement` fails the build if a module can reach
a paid endpoint without passing the two-switch guard.

---

## 1. What the hardware actually has to do

Derived by reading what each service loads, not from a vendor's recommendation.

### VRAM

Every service parks its model on the **CPU** at import and borrows the GPU per
request — `MODEL.to("cuda")`, generate, `.to("cpu")`, `empty_cache()`. That is
unconditional; there is no flag to keep a model resident. So the GPU holds
roughly **one** resident set at a time, and the requirement is the largest
single set, not the sum.

| Resident set | Weights |
|---|---|
| ComfyUI: Wan 2.2 TI2V-5B fp16 + UMT5-XXL fp8 | ~19.6 GiB |
| ComfyUI: Z-Image Turbo 6B bf16 + Qwen3-4B text encoder | ~18.6 GiB |
| Vision: Qwen2.5-VL-7B bf16 | ~14.2 GiB |
| Planner: Qwen3-4B bf16 | ~7.5 GiB |
| Speech: Indic Parler-TTS fp16 | ~1.6 GiB |
| **Peak (largest single set)** | **~19.6 GiB** |
| Sum, if anything held them resident — nothing does | ~61 GiB |

Weights only. Activations, KV cache and allocator fragmentation sit on top.

- **24 GB is the floor.** Wan's ~19.6 GiB leaves ~4 GiB of headroom, which is
  tight but plausible.
- **48 GB removes VRAM as a variable for the first run.** That matters more than
  the price difference when nothing has ever been measured: a failure on a 24 GB
  card is ambiguous between "out of memory" and "actually broken".
- The old claim that 48 GB "keeps them resident" was wrong twice — no code path
  keeps them resident, and 61 GiB would not fit in 48 GB anyway.

### Disk

| | |
|---|---|
| Model weights (12 files/directories) | ~71 GB |
| ComfyUI output and working space | ~30 GB |
| OS, venv, CUDA wheels | ~25 GB |
| **Provision** | **150 GB** |

The torch CUDA wheel alone is several GB. A 50 GB volume fills before the
weights finish downloading.

### Not needed

- **Multiple GPUs.** Nothing shards a model, and the queue runs one job per
  worker. Two cards would mean two workers, which is a throughput decision to
  make after measuring one.
- **H100 or A100.** They are 3–10× the price for models that fit in 20 GB. An
  H100's advantage is memory bandwidth on large-batch inference; Lumina
  generates one lesson at a time.
- **A 48 GB card for the deck path alone.** A deck needs the planner (~7.5 GiB)
  and optionally Z-Image. `npm run worker:cloud-deck` can run on a 12–16 GB card
  with no ComfyUI at all.

---

## 2. Who to rent from

Prices per GPU-hour for 48 GB cards, from sources dated September–October 2026.
**Prices move; re-check before booking.** The sources disagree on some figures,
which is itself worth knowing — they are listed separately rather than averaged.

| Provider | A6000 48GB | A40 48GB | L40S 48GB | Notes |
|---|---|---|---|---|
| **RunPod Community** | **$0.33** | $0.35 | $0.79 | Cheapest reliable; community hosts, so a pod can be reclaimed |
| RunPod Secure | $0.59 | $0.44–0.59 (sources conflict) | $1.09 | Datacentre SLA, persistent volumes |
| **Vast.ai (spot)** | **$0.28** | — | $0.47 | Marketplace: cheapest, varies hour to hour by host |
| Hostinger | — | — | $0.92 | |
| **Lambda** | $1.09 | not listed | not listed | ~3× RunPod for these cards; its catalogue is H100/A100-focused. Billed per minute |

### Recommendation and why

**First run: RunPod Community, A6000 or A40, ~$0.33/hr.**

- At this price the entire question costs about **$1** — 30 minutes of benchmark
  plus a couple of hours of setup. Arguing about providers costs more in time
  than the difference.
- Persistent volumes mean the ~71 GB of weights survive stopping the pod, so the
  second run does not re-download them. This is the single biggest practical
  saving: the download dominates the first session.
- Community-host reclamation is an acceptable risk for a benchmark. It is not
  acceptable for a teacher-facing deployment — move to Secure Cloud or a
  reserved instance before any pilot.

**Vast.ai if cost is the only concern.** $0.28/hr and often lower. The tradeoff
is host variability: disk speed, network and reliability differ per host, which
is poor ground for a *first* measurement. Good for repeat runs once the
benchmark is known to work.

**Not Lambda for this workload.** Three times the price for a card we need for
its memory, not its throughput. Lambda is the right choice for H100-class
training, which Lumina does not do.

### Cost of the first session

| | A6000 @ $0.33 | Vast.ai @ $0.28 | Lambda @ $1.09 |
|---|---|---|---|
| Benchmark run (30 min) | $0.17 | $0.14 | $0.55 |
| Setup + weights + benchmark (3 h) | **$0.99** | $0.84 | $3.27 |

Storage for a persistent volume is extra and is billed while the pod is stopped
— typically a few dollars a month for 150 GB. Check the current rate; it is the
only charge that continues when nothing is running.

### What to do before booking

1. Accept the **IndicTrans2** access agreement by hand, under the account that
   will download it. It is gated and an unattended download fails
   (`ops/cloud/RUNBOOK-48GB.md` §5).
2. Decide about **`ae.safetensors`**, whose provenance is unresolved — Comfy-Org
   declares Apache-2.0, community documentation calls it the FLUX.1 autoencoder,
   and FLUX.1 schnell is Apache-2.0 while dev is not. Fine for a benchmark,
   unresolved for commercial use (`docs/model-licences.md` Q1).
3. Have `npm run server:check` ready. It reports every missing prerequisite at
   once instead of one per restart, which on a metered box is the difference
   between one session and three.

---

## 3. The algorithm

What runs when a teacher submits a request. Every step below exists in the
repository; the ones that need a GPU are marked `[GPU]`.

```
ADMIT(request)
 1  parse request against CreateCloudLessonSchema
      class, subject, topic, language, duration, visual style, outputs
 2  admitGeneration(policy, generator, requestedOutputs)
      ├─ LESSON_GENERATOR valid?                       else 503
      ├─ every requested output in PRODUCIBLE_OUTPUTS?  else 501
      └─ resolve plan/image/speech/motion -> provider per stage
         (local unless ALLOW_EXTERNAL_PROVIDERS=true AND stage named)
 3  reserve_cloud_lesson(...)            -- pg_advisory_xact_lock
      serialises identical simultaneous requests: one project, one prepare job
 4  key  <- compatibilityKey(class, subject, topic, language, duration,
                             style, model versions, spec version)
 5  plan <- planOutputs(key, candidate source)
      per output kind -> reuse | rebuild | generate
        reuse    : identical key, assets ready, rights allow      -> cost 0
        rebuild  : language differs only -> keep visuals,
                   pay for speech + assemble
        generate : no compatible source
 6  if plan wants a deck and disposition != reuse
      enqueue_cloud_lesson_deck(project)   -- idempotent: one deck per lesson
 7  respond 202 with per-output disposition, stages, providers, paid stages
```

```
PREPARE JOB                                             [GPU: planner]
 1  claim_cloud_lesson_job(worker, ['prepare'])   -- FOR UPDATE SKIP LOCKED
 2  plan_structured() on Qwen3-4B -> title, objective, narration, scenes[]
      schema-constrained; a malformed answer fails here, before any pixels
 3  if language != en-IN: translate() on IndicTrans2
 4  synthesize() on Indic Parler-TTS, seeded so every scene is one narrator
 5  listen-back: Whisper transcribes each take; word-error > ceiling -> retake
      (requires .lumina-complete in the ASR dir, or this silently does nothing)
 6  measured narration duration decides slot timing -- never the reverse
 7  complete_cloud_lesson_preparation(scenes, narration) -> queues image jobs
```

```
PER SCENE                                      [GPU: Z-Image, Qwen2.5-VL, Wan]
 1  image job   -> Z-Image Turbo, 1920x1080, caption-dialect prompt
 2  vision check-> Qwen2.5-VL: shows_subject, deformed, has_writing, unsafe
                   a failed check retries the image; it never ships
 3  motion job  -> animate: Wan 2.2 TI2V-5B, frames = ((round(d*fps)+3)//4)*4+1
                   still:   FFmpeg zoompan over the approved frame
                   animated scenes are capped per style, not per lesson
```

```
ASSEMBLE JOB
 1  captions: libass + HarfBuzz + FriBidi, rendered white-on-black and used
      as an alpha mask (the ass filter returns nothing on a transparent frame)
 2  xfade dissolves between slots; 1920x1080 @ 24fps; AAC mono 24kHz
 3  hard cap 40s; duration comes from measured narration, never truncation
 4  validate: ffprobe must decode the whole file
 5  upload -> download back -> checksum the returned bytes -> finalize asset
 6  publish_cloud_lesson(project, scope)
      lesson_rights_verdict fails closed: unresolved source -> refused
```

```
DECK JOB                                                [GPU: planner, image]
 1  claim_cloud_lesson_job(worker, ['deck'])
      claimable until the lesson fails or is cancelled -- including after the
      video has succeeded, or the deck would sit queued forever
 2  read lesson -> LessonDeckRequest (slides from duration, documented proxy)
 3  planLessonDeck() on Qwen3-4B -> narrow schema: heading, explanation,
      example, diagram; prose is refused
 4  composeSlideSpecs() -- deterministic: same plan, same slides
 5  illustrateSlides() via selectImageProvider -> local Z-Image by default
      'optional' means a text-only deck is acceptable and is recorded as such
 6  buildPptx() -> real OOXML, editable text, no rasterised slides
 7  validate: non-empty, zip signature, >= 1 slide -- before upload
 8  upload .pptx, record provenance: planner model, content mode, images
```

### The three invariants worth stating

1. **No silent paid fallback.** Every paid client is built in one guarded
   factory. A local failure raises; it never becomes a bill. Enforced by a
   source scan in `npm run test:enforcement`.
2. **No output claimed without a producer.** `PRODUCIBLE_OUTPUTS` is checked at
   the route, and a test refuses to let a kind be declared producible unless a
   module builds it.
3. **Nothing ships unvalidated.** Images pass a vision check, narration passes
   listen-back, decks pass a zip check, videos must decode, and uploads are
   re-downloaded and checksummed before an asset is marked ready.

---

## 4. The flowchart

```
                         ┌──────────────────────────┐
                         │  Teacher: class, subject │
                         │  topic, language, style, │
                         │  duration, outputs       │
                         └────────────┬─────────────┘
                                      ▼
                         ┌──────────────────────────┐
                         │ POST /api/cloud-lessons  │
                         │   schema validation      │
                         └────────────┬─────────────┘
                                      ▼
                    ┌─────────────────────────────────┐
                    │ admitGeneration                 │
                    │  generator? outputs producible?  │
                    │  provider per stage (local def.) │
                    └───────┬──────────────────┬──────┘
                       refuse│                 │admit
                    501 / 503│                 ▼
                             │   ┌──────────────────────────┐
                             │   │ reserve_cloud_lesson     │
                             │   │  advisory lock:          │
                             │   │  N requests -> 1 lesson  │
                             │   └────────────┬─────────────┘
                             │                ▼
                             │   ┌──────────────────────────┐
                             │   │ compatibility key        │
                             │   │ planOutputs -> per kind  │
                             │   └────┬────────┬────────┬───┘
                             │   reuse│  rebuild│ generate│
                             │        ▼        ▼         ▼
                             │   ┌─────────┐ ┌────────────────────┐
                             │   │ serve   │ │   QUEUE (Postgres  │
                             │   │ cached  │ │   SKIP LOCKED)     │
                             │   │ cost 0  │ └──┬──────────────┬──┘
                             │   └─────────┘    │              │
                             │            video │              │ deck
                             │                  ▼              ▼
                             │     ┌────────────────────┐  ┌──────────────────┐
                             │     │ PREPARE      [GPU] │  │ DECK       [GPU] │
                             │     │ planner → scenes   │  │ planner → plan   │
                             │     │ translate (if ≠en) │  │ compose slides   │
                             │     │ TTS + listen-back  │  │ images (optional)│
                             │     └─────────┬──────────┘  │ build .pptx      │
                             │               ▼             │ zip + slide check│
                             │     ┌────────────────────┐  └────────┬─────────┘
                             │     │ PER SCENE    [GPU] │           │
                             │     │ Z-Image keyframe   │           │
                             │     │ Qwen2.5-VL check ──┼─fail─┐    │
                             │     │ Wan clip / zoompan │      │    │
                             │     └─────────┬──────────┘      │    │
                             │               │  ◄──────retry───┘    │
                             │               ▼                      │
                             │     ┌────────────────────┐           │
                             │     │ ASSEMBLE           │           │
                             │     │ libass captions    │           │
                             │     │ xfade + AAC        │           │
                             │     │ ≤40s, 1080p24      │           │
                             │     │ ffprobe must decode│           │
                             │     └─────────┬──────────┘           │
                             │               └──────────┬───────────┘
                             │                          ▼
                             │            ┌──────────────────────────┐
                             │            │ upload → download back → │
                             │            │ checksum → finalize      │
                             │            └────────────┬─────────────┘
                             │                         ▼
                             │            ┌──────────────────────────┐
                             │            │ lesson_rights_verdict    │
                             │            │  fails closed:           │
                             │            │  unresolved → refused    │
                             │            └────────────┬─────────────┘
                             │                         ▼
                             │            ┌──────────────────────────┐
                             └───────────▶│ Teacher: MP4 + captions, │
                                          │ editable .pptx           │
                                          └──────────────────────────┘

   Services, all on 127.0.0.1 of the rented box — nothing leaves it:
     planner  :18080/structured     Qwen3-4B
     speech   :18081/synthesize     Indic Parler-TTS (+ Whisper listen-back)
     translate:18082/translate      IndicTrans2   (CPU, moves to GPU per call)
     vision   :18083/check          Qwen2.5-VL-7B
     ComfyUI  :8188/prompt          Z-Image Turbo, Wan 2.2 TI2V-5B
     worker   :8090                 health
```

---

## 5. Bring-up order, once the box exists

```bash
npm run server:check -- --models-root ~/ComfyUI/models   # every gap at once
npm run bench:lesson -- --models-root ~/ComfyUI/models \
  --languages en-IN,hi-IN,kn-IN --interval 0.25 \
  --out ops/cloud/out/benchmark.json
npm run worker:cloud-deck -- --preflight                 # planner reachable?
```

`benchmark.json` is the first real evidence of what any of this costs. Until it
exists, every timing, throughput and capacity claim about Lumina — the
300-concurrent-user question included — is unmeasured, and the VRAM table in
section 1 is arithmetic rather than fact.

## Sources

Prices above are quoted from these, dated September–October 2026:

- [RunPod GPU Cloud Pricing](https://www.runpod.io/pricing)
- [Cloud GPU pricing: rates compared across 8 providers — Hostinger](https://www.hostinger.com/tutorials/cloud-gpu-pricing/)
- [GPU Rental Prices: RunPod vs Vast.ai, updated daily](https://www.madebyagents.com/hardware/gpu-rental-prices)
- [RunPod vs Vast.ai vs Lambda Labs: GPU Pricing 2026](https://www.promptquorum.com/local-llms/cloud-gpu-rental-comparison-2026)
- [RunPod vs Lambda vs Vast.ai: GPU Pricing 2026](https://tech-insider.org/runpod-vs-lambda-vs-vast-ai-2026/)
