# Acceptance benchmark

Record wall time from queue submission to saved output, peak VRAM from `nvidia-smi`, output dimensions/duration from `ffprobe`, and a simple pass/fail visual judgment. Keep every seed fixed so model profiles are comparable.

Copy `results-template.csv` into `/workspace/lumina-benchmarks/results.csv` and fill it during the run. In a second terminal, run `monitor_gpu.sh` before the first generation and leave it active through the final generation.

## Stop conditions

Stop a profile instead of repeatedly burning GPU time when any of these occurs:

- Two OOM failures at the same settings.
- One generation exceeds 12 minutes at the 480p smoke-test setting.
- NaN/black output twice.
- ComfyUI process exits or the pod loses CUDA access.

## A. Environment capture

```bash
mkdir -p /workspace/lumina-benchmarks
nvidia-smi > /workspace/lumina-benchmarks/nvidia-smi.txt
/root/lumina-runtime/ComfyUI/.venv/bin/python -c 'import torch; print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0))' > /workspace/lumina-benchmarks/torch.txt
git -C /root/lumina-runtime/ComfyUI rev-parse HEAD > /workspace/lumina-benchmarks/comfyui-commit.txt
```

## B. Z-Image Turbo

Workflow: `image_z_image_turbo.json`

- Size: 1024×576
- Steps: 8
- Seed: 42
- Generate one warm-up image and do not count it.
- Generate the three prompts below and record each wall time.

Prompts:

1. `A clean cinematic educational illustration of a DNA double helix inside a living cell, blue and teal palette, dramatic depth, uncluttered 16:9 composition, no text, no watermark`
2. `A realistic cutaway illustration of a modern data center with servers and cooling airflow, precise lighting, clean educational composition, 16:9, no labels, no text`
3. `A wide historical scene of an ancient maritime trade port at sunrise, period-accurate ships and architecture, documentary realism, 16:9, no text`

Pass gate:

- All three outputs decode correctly at the requested dimensions.
- No obvious malformed central subject in at least two of three.
- Warm generation target: median under 10 seconds. This is a target, not an SLA.

## C. Wan 2.2 TI2V-5B baseline

Workflow: `image_to_video_wan22_5B.json`

Use the first accepted Z-Image result as `start_image`.

Smoke test:

- Size: 832×480
- Length: 49 frames
- FPS: 16
- Steps: 20 (official ComfyUI native-template fast target)
- CFG: 5
- Fixed seed: 42
- Prompt: `Slow cinematic push-in. The DNA helix rotates gently while soft particles drift through the cell. Preserve the original composition and colors. Smooth motion, stable subject, no cuts.`

Production-shaped test, only after smoke passes:

- Size: 1280×704
- Length: 81 frames
- FPS: 16
- Same prompt and seed

Before promoting the 20-step graph, compare at least three fixed-seed outputs
against the already accepted 30-step result. If subject stability regresses, keep
30 steps as the production fallback. Do not infer the latency improvement from
step count; record it on the target GPU.

Pass gate:

- No OOM or process restart.
- Valid video with the requested frame count and dimensions.
- No scene cut, severe identity drift, or frozen output.
- Record measured time; do not extrapolate an SLA yet.

## D. Wan 2.2 I2V-A14B FP8 quality control

Workflow: `image_to_video_wan22_14B.json`

Run the same 832×480, 49-frame, seed-42 smoke case using the native official workflow before applying acceleration LoRAs. This isolates model/VRAM compatibility from LoRA configuration.

If native succeeds, duplicate the workflow and add the matching LightX2V LoRA to each expert:

- high-noise model → `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors`
- low-noise model → `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors`

Use the LoRA author's recommended four-step schedule exposed by the workflow. Do not apply one LoRA to both experts and do not mix high/low-noise files.

Pass gate:

- No OOM.
- Valid video and stable start-frame composition.
- Four-step result is visually acceptable and materially faster than native A14B.
- Promote A14B to the production high-quality tier only if the visual improvement over 5B is clear in blind comparison.

## E. Validate every output

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,avg_frame_rate,nb_frames,duration \
  -of json /path/to/output.webm
```

For client delivery, normalize accepted output to H.264 MP4:

```bash
ffmpeg -y -i /path/to/input.webm \
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -movflags +faststart \
  -an /path/to/output.mp4
```

## Production selection rule

- Image default: Z-Image Turbo if section B passes.
- Video fast default: 5B if it meets the product latency target and passes stability checks.
- Video high quality: A14B FP8 + LightX2V only if it passes without OOM and visibly beats 5B.
- If neither video profile passes, ship generated still images and keep video disabled; do not expose an unreliable client action.
