# Bringing up a rented 48 GB GPU server

A runbook for one benchmark run on a fresh box. `DEPLOYMENT.md` explains the
requirements and why they exist; this is the order to do them in.

**Nothing here has been executed.** No step has run on a GPU server, so treat
every instruction as untested and expect to correct some of it. Record what you
had to change.

Target: one A6000, L40S or A40 (48 GB). **24 GB is the floor for the services
as written, and nothing in this repository keeps models resident.**

Each service parks on the CPU at import and borrows the GPU per request, then
hands it back: `MODEL.to(device)` on the way in, `.to("cpu")` and
`torch.cuda.empty_cache()` on the way out. That is unconditional -- there is no
flag to hold a model on the card. So the GPU holds roughly one resident set at a
time, and the floor is the largest single set rather than the sum:

| Resident set | Weights |
|---|---|
| ComfyUI: Wan 2.2 TI2V-5B fp16 + UMT5-XXL fp8 | ~19.6 GiB |
| ComfyUI: Z-Image 6B bf16 + Qwen3-4B text encoder | ~18.6 GiB |
| Vision: Qwen2.5-VL-7B bf16 | ~14.2 GiB |
| Planner: Qwen3-4B bf16 | ~7.5 GiB |
| Speech: Indic Parler-TTS fp16 | ~1.6 GiB |

Those are **parameter-count arithmetic, not measurements** -- bytes per parameter
times parameters. Activations, KV cache and allocator fragmentation sit on top,
which is why 24 GB is a floor and not a recommendation. `benchmark.json` replaces
this table with measured numbers the first time it runs.

What 48 GB actually buys is headroom -- Wan at higher resolution, and ComfyUI
coexisting with a service without the driver evicting either.

> **Superseded.** An earlier version of this runbook said 48 GB "keeps them
> resident, which removes a model-swap from every scene." That was wrong in both
> halves: no code path keeps them resident, and those sets total ~61 GiB, which
> would not fit in 48 GB either. Kept here because someone who read the old
> version and sized a rental on it deserves to find the correction rather than
> silence.

---

## 1. Check the box before installing anything

```bash
nvidia-smi
df -h /
python3 --version
```

Needs: a 48 GB card, **≥120 GB free** (80 GB of weights plus working space
plus ComfyUI's output), and Python 3.11 or 3.12.

If `nvidia-smi` is absent the driver is missing and nothing below will work.

## 2. Driver, CUDA, PyTorch

The driver must be new enough for the CUDA build of PyTorch, not the other way
round — a driver too old for the wheel fails at `torch.cuda.is_available()`
with no useful message.

```bash
nvidia-smi --query-gpu=driver_version --format=csv,noheader   # expect >= 525
python3 -m venv ~/lumina && source ~/lumina/bin/activate
pip install --upgrade pip
pip install torch --index-url https://download.pytorch.org/whl/cu124
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.version.cuda)"
```

That last line must print `True`. If it prints `False`, stop: everything after
this depends on it, and the benchmark will refuse rather than pretend.

Then the Python packages. **The four services import more than the harness
does; install only the harness's list and all four fail at import.**

```bash
pip install pillow fonttools pynvml
```

```bash
pip install transformers
```

```bash
pip install parler-tts scipy numpy
```

```bash
pip install IndicTransToolkit
```

`parler-tts`, `scipy` and `numpy` are for `local_tts_service.py`;
`IndicTransToolkit` is for `local_translation_service.py`; `transformers` is
needed by all four. Read from the imports in `ops/runpod/local_*_service.py`
rather than assumed:

| Service | Third-party imports |
|---|---|
| `local_planner_service.py` | `torch`, `transformers` |
| `local_vision_service.py` | `torch`, `transformers`, `PIL` |
| `local_tts_service.py` | `torch`, `transformers`, `parler_tts`, `scipy`, `numpy` |
| `local_translation_service.py` | `torch`, `transformers`, `IndicTransToolkit` |

**The `transformers` version matters and is not yet pinned.** The sources mix two
spellings of one argument: `local_vision_service.py:36` passes
`dtype=torch.bfloat16`, while `local_planner_service.py:69` and
`local_translation_service.py:43` pass `torch_dtype=`. `dtype=` is the newer
name, `torch_dtype=` the older one, so the installed version must accept
**both**.

That working range has not been established on a real install, so this runbook
does not invent one. Establish it at step 6 and record the result here:

- `TypeError: ... unexpected keyword argument 'dtype'` from the vision service
  means transformers is too old for it.
- A deprecation warning about `torch_dtype` from the planner or the translation
  service means they still work, but a later upgrade will break them.
- All four up: pin that exact version here and in a requirements file, from
  `pip freeze`.

`pynvml` is optional but worth having: without it the device sampler falls back
to spawning `nvidia-smi`, which cannot sample faster than about twice a second.
The benchmark records which method it used and at what interval.

## 3. FFmpeg with the right build flags

```bash
ffmpeg -hide_banner -version | tr ' ' '\n' | grep -E 'libass|harfbuzz|fribidi'
```

Three lines must come back. A build without them renders Kannada with detached
vowel signs and broken conjuncts — the exact failure `ops/cloud/captions.py`
exists to avoid. Most distribution packages are built without libass; if yours
is, install a full build before going further.

## 4. ComfyUI

```bash
git clone https://github.com/comfyanonymous/ComfyUI ~/ComfyUI
cd ~/ComfyUI && pip install -r requirements.txt
```

No custom nodes are required. Every node the shipped workflows use is core:
`Wan22ImageToVideoLatent` and `SaveWEBM` are the newest, so an old checkout is
the likely failure. `DEPLOYMENT.md §3` lists all fourteen.

## 5. Weights

Six files. Exact paths, because the workflows load them by name:

```
~/ComfyUI/models/diffusion_models/z_image_turbo_bf16.safetensors
~/ComfyUI/models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
~/ComfyUI/models/text_encoders/qwen_3_4b.safetensors
~/ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
~/ComfyUI/models/vae/ae.safetensors
~/ComfyUI/models/vae/wan2.2_vae.safetensors
```

From [`Comfy-Org/z_image_turbo`](https://huggingface.co/Comfy-Org/z_image_turbo)
and
[`Comfy-Org/Wan_2.2_ComfyUI_Repackaged`](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged).

### The service models: six more directories

Separate from ComfyUI's six files, and **every one of these services passes
`local_files_only=True`** -- nothing self-fetches, so a missing directory is a
startup crash rather than a slow first request. Defaults read from the sources:

| Variable | Default path | Used by |
|---|---|---|
| `LOCAL_PLANNER_MODEL_PATH` | `/workspace/lumina-local-ai/qwen3-4b` | planner |
| `LOCAL_VISION_MODEL_PATH` | `/workspace/lumina-local-ai/qwen2.5-vl-7b` | vision |
| `LOCAL_TTS_MODEL_PATH` | `/workspace/lumina-local-ai/indic-parler-tts` | TTS |
| `LOCAL_TTS_DESCRIPTION_TOKENIZER_PATH` | `/workspace/lumina-local-ai/flan-t5-large-tokenizer` | TTS |
| `LOCAL_ASR_MODEL_PATH` | `/workspace/lumina-local-ai/whisper-large-v3-turbo` | TTS listen-back |
| `LOCAL_TRANSLATION_MODEL_PATH` | `/workspace/lumina-local-ai/indictrans2-en-indic-1b` | translation |

`ops/runpod/.env.example` names only three of these
(`LOCAL_PLANNER_MODEL_PATH`, `LOCAL_TTS_MODEL_PATH`, `LOCAL_ASR_MODEL_PATH`); the
other three exist only as defaults in the service sources. Set all six
explicitly rather than relying on that file being complete.

**The TTS listen-back check fails open.** `local_tts_service.py:106` enables it
only when a sentinel file is present inside the ASR directory. Without the file
Whisper is never loaded and narration ships unverified -- the service still
answers `200`. Check it:

```bash
test -f "$LOCAL_ASR_MODEL_PATH/.lumina-complete" && echo on || echo "listen-back DISABLED"
```

Create the sentinel only once the download is genuinely complete, which is the
whole point of it:

```bash
touch /workspace/lumina-local-ai/whisper-large-v3-turbo/.lumina-complete
```

### Ports and the rest of the service settings

Translation loads on the CPU and moves to the GPU per request, so it needs host
RAM as well as VRAM.

| Variable | Default | Meaning |
|---|---|---|
| `LOCAL_PLANNER_PORT` | `18080` | planner, `/structured` |
| `LOCAL_TTS_PORT` | `18081` | speech, `/synthesize` |
| `LOCAL_TRANSLATION_PORT` | `18082` | translation, `/translate` |
| `LOCAL_VISION_PORT` | `18083` | vision, `/check` |
| `LOCAL_TTS_SEED` | `1234` | fixes the voice, so every scene of a lesson sounds like one narrator |
| `LOCAL_TTS_ATTEMPTS` | `3` | retakes allowed when listen-back disagrees with the script |
| `LOCAL_TTS_MAX_ERROR` | `0.3` | word-error ceiling for accepting a take |

The last three only do anything when listen-back is enabled -- without
`.lumina-complete` the service takes one shot and ships it unchecked, whatever
`LOCAL_TTS_ATTEMPTS` says. `LOCAL_TTS_MAX_ERROR` is a single global ceiling, and
Whisper's accuracy is not uniform across these languages (the source notes it is
weak at Malayalam), so a threshold strict enough for English will reject good
Malayalam takes and one loose enough for Malayalam will accept poor English ones.
Tune it per language only with measured word-error rates in hand.

### Licence gates, before you script the download

- **IndicTrans2 is gated.** Its files need a contact-sharing agreement accepted
  once, interactively, under the account that fetches them. **An unattended
  download will fail.** Accept it by hand first and record who accepted it.
- **`ae.safetensors` is not independently cleared.** Comfy-Org declares
  Apache-2.0; community documentation calls it the FLUX.1 autoencoder, and the
  two FLUX.1 lines differ — schnell is Apache-2.0, dev is not. See
  `docs/model-licences.md` Q1. Fine for a benchmark, unresolved for commercial
  use.
- Do not redistribute any of these weights.

## 6. Start the services, in this order

Dependencies first, so a service never starts against a half-ready peer.

```bash
cd ~/ComfyUI && python main.py --listen 127.0.0.1 --port 8188 &
# wait for it to answer before starting anything else
until curl -sf http://127.0.0.1:8188/system_stats >/dev/null; do sleep 2; done

cd ~/lumina-repo/ops/runpod
python local_planner_service.py &       # :18080
python local_tts_service.py &           # :18081
python local_translation_service.py &   # :18082
python local_vision_service.py &        # :18083
```

Do **not** pass `--cpu` to ComfyUI. The benchmark treats unknown VRAM as not
enough and refuses, which is correct — a CPU run would take hours and the
numbers would mean nothing.

`ops/runpod/start_local_agents.sh` and `supervise_services.sh` already exist and
may be preferable to starting these by hand.

## 7. Health check

```bash
export LOCAL_VIDEO_COMFY_URL=http://127.0.0.1:8188
export COMFYUI_INPUT_DIR=~/ComfyUI/input
npm run server:check -- --models-root ~/ComfyUI/models
```

Reports every problem at once: which services are unreachable and whether they
were refused or silent, free versus total VRAM, which stages have room, which
weight files are missing by name, and whether captions shape in all three
languages. Exit 0 means ready.

Fix everything it names before step 8. The benchmark will refuse otherwise, by
design.

## 8. Run the benchmark

```bash
npm run bench:lesson -- \
  --models-root ~/ComfyUI/models \
  --languages en-IN,hi-IN,kn-IN \
  --interval 0.25 \
  --out ops/cloud/out/benchmark.json
```

Runs plan → translate → keyframe → vision → motion → TTS, then assembles a
lesson and validates it. Expect 10–30 minutes on a first run, most of it Wan.

Artifacts land in `ops/cloud/out/artifacts/`: `keyframe.png`, `clip.webm`,
`narration-*.wav`, and `lesson-en-IN.mp4`.

### Reading the result

`complete: true` means every stage ran **and** the MP4 decoded cleanly. Anything
else is a failure with a reason, and no stage that did not run carries a figure.

Two memory numbers appear, and they are not the same thing:

- `process_memory.peak_allocated_mib` — exact, from the CUDA allocator, and
  covers only work inside the harness process.
- `device_memory.max_observed_used_mib` — sampled across the whole device, so it
  includes ComfyUI, and it is a **lower bound**: a spike shorter than the
  sampling interval is invisible. The interval is recorded beside it.

Neither is a before/after difference. Do not add them together.

## 9. When something fails

| Symptom | Cause | Fix |
|---|---|---|
| `server:check` says VRAM unknown | ComfyUI on CPU or not up | restart without `--cpu` |
| ComfyUI refuses the workflow | a weight is missing or misnamed | `server:check --models-root` names the file |
| Motion stage times out | Wan on an undersized card, or steps too high | `--wan-steps 20`; watch `nvidia-smi` |
| `COMFYUI_INPUT_DIR is not set` | motion cannot hand the keyframe to LoadImage | export it, step 7 |
| Kannada narration silent | TTS answered but produced no speech | the harness fails the stage; check the model path |
| Captions render as boxes | fonts missing | `DEPLOYMENT.md §5` |
| Translation not native script | wrong language or a stub reply | the harness fails below 55% native script |
| A service exits at startup, `ModuleNotFoundError` | service deps not installed | step 2 -- `transformers` is needed by all four |
| Vision service: `unexpected keyword argument 'dtype'` | transformers too old for `local_vision_service.py:36` | upgrade; step 2 |
| Narration passes but sounds wrong | listen-back silently off | `.lumina-complete` missing; step 5 |
| A service crashes naming a model directory | nothing self-fetches (`local_files_only=True`) | pre-place all six; step 5 |

A stage that fails is retried `--retries` times (default 2) and then recorded
as failed. The run continues so one broken stage does not hide the others.

## 10. Afterwards

Keep `benchmark.json` — it is the first real evidence of what this costs. Until
it exists, every timing and capacity claim about Lumina is unmeasured, the
300-concurrent-user question included.
