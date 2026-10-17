# Running Lumina's models on your own GPU host

Every model Lumina generates with runs here. No third-party generation API is
called, and there is no fallback that would reach one: a service that is down
is an error, never a reason to spend money elsewhere.

Figures below are marked **[exact]** where they are read out of this
repository — a workflow file names a weight, so that name is not negotiable —
and **[verify]** where they are arithmetic or judgement that has to be
confirmed against your actual card. Nothing here has been measured on a GPU
yet; see *Not yet proven* at the end.

---

## 1. Hardware

| | Requirement | Why |
|---|---|---|
| GPU | **24 GB VRAM minimum** [verify] | Motion needs Wan 2.2 TI2V-5B FP16 (~10 GB) plus the UMT5-XXL fp8 encoder (~11 GB). 24 GB holds one stage with headroom. |
| | 48 GB comfortable | Both stages stay resident, so no model swap between scenes. |
| Disk | **80 GB free** for weights [verify] | Six files, two of them over 10 GB. |
| RAM | 32 GB | ComfyUI stages weights through host memory while loading. |
| CPU | 8 cores | FFmpeg composition is CPU-bound and runs per scene. |

A 6 GB or 8 GB card will not work. Wan's weights alone exceed it before any
activation memory, and the failure arrives as an out-of-memory crash minutes
into a run rather than at startup.

---

## 2. Software

```
NVIDIA driver   >= 525          (for CUDA 12.x)        [verify against your card]
CUDA runtime    12.1 or 12.4                           [verify]
Python          3.11 or 3.12    — 3.12 is what the compositor is tested on
PyTorch         2.x built for your CUDA                [verify]
FFmpeg          >= 7.0, built --enable-libass
                --enable-libharfbuzz --enable-libfribidi   [exact: required]
Pillow          >=11.1,<13                             [exact: requirements.txt]
fontTools       any recent                             [exact: captions.py reads name tables]
```

The FFmpeg build flags are not optional. Captions are shaped by libass through
HarfBuzz; a build without them renders Kannada with detached vowel signs and
broken conjuncts. Check with:

```bash
ffmpeg -hide_banner -version | tr ' ' '\n' | grep -E 'libass|harfbuzz|fribidi'
```

Three lines must come back. If they do not, replace FFmpeg before going
further — nothing downstream can compensate.

---

## 3. ComfyUI

Install ComfyUI and confirm it provides these node classes. All are core
nodes in a current build; `Wan22ImageToVideoLatent` and `SaveWEBM` are the
newest and the likeliest to be missing from an old checkout. **[exact: read
from the shipped workflows]**

```
CLIPLoader              CLIPTextEncode          ConditioningZeroOut
EmptySD3LatentImage     KSampler                LoadImage
ModelSamplingAuraFlow   ModelSamplingSD3        SaveImage
SaveWEBM                UNETLoader              VAEDecode
VAELoader               Wan22ImageToVideoLatent
```

Start it bound to loopback:

```bash
python main.py --listen 127.0.0.1 --port 8188
```

Do not pass `--cpu`. The readiness check reports VRAM as unknown in that case
and refuses every stage, which is correct: a CPU run would take hours.

---

## 4. Model weights

**Six files, at these exact paths under ComfyUI's `models/` directory.**
[exact: the workflows load them by name]

```
models/diffusion_models/z_image_turbo_bf16.safetensors
models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
models/text_encoders/qwen_3_4b.safetensors
models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
models/vae/ae.safetensors
models/vae/wan2.2_vae.safetensors
```

All are Apache-2.0, which is what makes them usable for a government tender
without a per-use fee appearing later. **These have deliberately not been
downloaded** — they are tens of gigabytes and fetching them is your call.

`check_weights()` in `local_models.py` reports any that are missing by name
and directory, so a wrong path is a one-line message rather than a ComfyUI
validation error against a node number.

Note on naming: `qwen_3_4b.safetensors` is the **text encoder for Z-Image**,
not a separate planner. One model, one job.

---

## 5. Fonts

`ops/cloud/fonts/` is gitignored and intentionally empty in a fresh clone.
Four files are needed:

```
Kalam-Bold.ttf              captions, en-IN
NotoSansDevanagari.ttf      captions, hi-IN
NotoSansKannada.ttf         captions, kn-IN
DejaVuSans-Bold.ttf         equation overlays
```

libass matches on the family name **inside** the file, not the filename, and
`captions.py` reads it from the name table — so a licensed substitute under a
different family name works without a code change.

The files currently in a developer checkout here are Segoe UI and Nirmala UI,
extracted from a Windows install for local testing. **They are not
redistributable.** Production needs Kalam and Noto Sans Kannada/Devanagari from
Google Fonts, all SIL Open Font License.

---

## 6. Services

| Service | Port | Env var |
|---|---|---|
| ComfyUI | 8188 | `LOCAL_VIDEO_COMFY_URL` |
| Indic Parler-TTS | 18081 | `LOCAL_VIDEO_TTS_URL` |
| IndicTrans2 | 18082 | `LOCAL_VIDEO_TRANSLATION_URL` |
| Planner | 18080 | `LOCAL_VIDEO_AGENT_URL` |
| Media worker | 8090 | `LOCAL_VIDEO_WORKER_URL` |

All bind to loopback. The web app never talks to a model directly — it writes
a job row, and the worker on this host claims it with `SKIP LOCKED`.

The TTS service must accept `POST /speak` with
`{text, language, voice, pace}` and return WAV bytes. `speak()` rejects a
non-RIFF response rather than passing it downstream, because a service
returning JSON on error would otherwise become a corrupt audio asset.

---

## 7. Readiness

```bash
npm run server:check
```

Reports every problem at once rather than stopping at the first: which
services are unreachable and whether they were refused or merely silent, free
versus total VRAM, which stages have room, and which weight files are missing
by name.

VRAM floors it enforces before a stage may start [verify — raise these if a
real run still OOMs]:

| Stage | Floor | Covers |
|---|---|---|
| image | 11 GB | Z-Image Turbo BF16 + Qwen3-4B encoder |
| motion | 14 GB | Wan 2.2 TI2V-5B FP16 + UMT5-XXL fp8 |
| speech | 2.5 GB | Indic Parler-TTS |

Unknown VRAM counts as *not enough*. A stage is ready only when the card has
been seen and has room.

---

## 8. Generating a sample

```bash
npm run sample:lesson
```

One command. It checks readiness first and **refuses to run** if any stage is
short, rather than starting work that will fail partway.

Output lands in `ops/cloud/out/` as one MP4 per language, each 1920×1080 at
24 fps and exactly 30.000 s.

Every asset the run produces is tagged with what made it — `model`,
`deterministic`, or `placeholder`. A sample built with stand-in stills reports
them, and `placeholderAssets()` in `src/lib/lesson-spec/schema.ts` is what a
report calls rather than guessing from filenames. **A sample containing any
placeholder is not an AI-generated video and must not be described as one.**

---

## 9. Not yet proven

Honest status, so nobody plans around a claim that has not been tested:

- **No image has been generated.** The keyframe stage is wired and its
  workflow fills correctly, but no model has run.
- **No motion clip has been generated.** `wan_frame_count(7.5, 24) = 181` is
  verified arithmetic, and 181 is a valid 4n+1 latent length; nothing has
  rendered.
- **No narration has been synthesised.** The TTS client is written and its
  failure paths tested; Indic Parler-TTS has never been called, so Kannada
  pronunciation quality is unknown.
- **Every VRAM figure is arithmetic from parameter counts**, not a
  measurement.
- **The 300-user capacity question cannot be answered** until the above run on
  real hardware.

What *has* been verified on a machine with no GPU: caption shaping in all
three languages inside an encoded MP4, the whole composition and chrome, the
7.5 s slot and 40 s cap arithmetic, scene assembly, and every failure path in
the readiness checks.
