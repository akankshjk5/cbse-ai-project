# ComfyUI API workflow templates

API-format graphs are added here only after matching the official native
ComfyUI workflow and validating the graph on the target GPU. Expected files:

- `image-fast.json`
- `video-fast.json`
- `video-quality.json`

`image-fast.json` is the verified API representation of the official
Z-Image-Turbo workflow. `video-fast.json` passed on the target GPU at 30
steps; its tokenized 20-step target follows the official ComfyUI template and
must pass the fixed-seed A/B before an SLA is quoted. `video-quality.json`
remains intentionally unavailable.

Replace the graph's literal inputs with these tokens where applicable:

```text
__PROMPT__
__NEGATIVE_PROMPT__
__SOURCE_IMAGE__
__SEED__
__WIDTH__
__HEIGHT__
__FPS__
__FRAMES__
__STEPS__
__DURATION_SECONDS__
```

The worker recursively replaces both exact token values and tokens embedded in
strings. Never commit credentials, signed URLs, or user media in workflow JSON.
