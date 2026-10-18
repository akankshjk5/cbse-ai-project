# Bringing up a rented 48 GB GPU server

A runbook for one benchmark run on a fresh box. `DEPLOYMENT.md` explains the
requirements and why they exist; this is the order to do them in.

**Nothing here has been executed.** No step has run on a GPU server, so treat
every instruction as untested and expect to correct some of it. Record what you
had to change.

Target: one A6000, L40S or A40 (48 GB). 24 GB works if models are loaded and
released per stage; 48 GB keeps them resident, which removes a model-swap from
every scene.

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

Then the pieces the harness itself needs:

```bash
pip install pillow fonttools pynvml
```

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

Plus the three service models: Qwen3-4B, Qwen2.5-VL-7B, Indic Parler-TTS and
IndicTrans2, at the paths `ops/runpod/.env.example` names
(`LOCAL_PLANNER_MODEL_PATH`, `LOCAL_TTS_MODEL_PATH`, `LOCAL_VISION_MODEL_PATH`).

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

A stage that fails is retried `--retries` times (default 2) and then recorded
as failed. The run continues so one broken stage does not hide the others.

## 10. Afterwards

Keep `benchmark.json` — it is the first real evidence of what this costs. Until
it exists, every timing and capacity claim about Lumina is unmeasured, the
300-concurrent-user question included.
