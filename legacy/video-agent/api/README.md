# ET Agent API

This document is the runtime guide for the API in `api/main.py`.

## Purpose

The API runs the video pipeline through `Agent.py` and exposes:
- Job start endpoint (`message` + optional style reference image)
- Pollable short progress notifications
- Final video download endpoint
- Dry-run simulation mode that does not consume model/API credits
- Optional Langfuse tracing and trace URLs per job

## Run

From `D:\Coding\ET_agent\api`:

```powershell
uv run main.py
```

## Environment Variables

Set in `D:\Coding\ET_agent\.env`.

Core runtime:
- `DRY_RUN=0|1`
- `CLEAN_AFTER_ARCHIVE=0|1`
- `NOTIFICATION_INTERVAL_SECONDS=<float>`
- `REAL_MEMORY_POLL_SECONDS=<float>`
- `API_HOST`
- `API_PORT`
- `API_RELOAD=0|1`
- `CORS_ALLOW_ORIGINS`
- `CORS_ALLOW_ORIGIN_REGEX`

Langfuse (optional):
- `LANGFUSE_TRACING_ENABLED=0|1`
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`
- `LANGFUSE_TRACING_ENVIRONMENT`

## Input Contract (`POST /start`)

Primary inputs:
- `message` (required)
- `style_name` (optional)
- `image` (optional)
- `image_url` (optional)

Optional testing input:
- `notification_interval_seconds` (optional, `> 0`)

Rules:
- Only one active job at a time.
- If an image (`image` or `image_url`) is provided, API injects a mandatory style creation instruction so the manager must use `storyboard_styler` to create the style before storyboard generation, then enforce that `style_name` for all storyboard frames.

## Endpoints

### `POST /start`
Starts a job.

Response:
```json
{
  "job_id": "<uuid>",
  "status": "queued"
}
```

### `GET /jobs/{job_id}`
Returns job state and output metadata.

Response fields:
- `id`, `status`, `message`
- `selected_style_name`
- `generated_style_name`
- `image_path`
- `has_result`
- `result_path`
- `archive_dir`
- `notification_interval_seconds`
- `result_endpoint`
- `agent_response`
- `langfuse_trace_id`
- `langfuse_trace_url`
- `error`

### `GET /notifications/{job_id}?after=<seq>`
Returns short 2–5 word status updates after the given sequence ID.

### `GET /result/{job_id}`
Returns the final video as `video/mp4` when job is completed.

### `GET /health`
Returns service and config state:
- `dry_run`
- `clean_after_archive`
- `default_notification_interval_seconds`
- `real_memory_poll_seconds`
- `dry_run_sample_dir`
- `langfuse_tracing_enabled`
- `langfuse_configured`
- `langfuse_base_url`

## Real Mode (`DRY_RUN=0`)

Flow:
1. API starts job and runs `Agent.py` in a background thread.
2. If reference style image is present, API generates a deterministic `style_name` and injects mandatory instructions to create it via `storyboard_styler`.
3. Manager uses `storyboard_styler` to create the style JSON and then Storyboard Artist uses that exact `style_name`.
4. API tails `memory.json` and maps steps to short frontend notifications.
5. API resolves final video path.
6. API archives artifacts into `job_runs/<timestamp>_<jobid>/...`.
7. If `CLEAN_AFTER_ARCHIVE=1`, runtime outputs are cleaned.
8. If Langfuse is configured, trace metadata (`langfuse_trace_id`, `langfuse_trace_url`) is stored on the job.

## Dry Mode (`DRY_RUN=1`)

Flow:
1. Emits notifications from `samples/dry_run/notifications.json` at configured interval.
2. Copies sample artifacts from `samples/dry_run` into runtime output locations.
3. Finalizes job exactly like real mode (archive + optional cleanup).

## Output and Archive Layout

Runtime generation folders:
- `generated_frames/`
- `generated_audio/`
- `generated_videos/`
- root-level `script.json`, `output.mp4`, `final_output.mp4`

Per completed job archive:
- `job_runs/<timestamp>_<jobid>/input/`
- `job_runs/<timestamp>_<jobid>/artifacts/`
- `job_runs/<timestamp>_<jobid>/result/`
- `job_runs/<timestamp>_<jobid>/manifest.json`

## Frontend Polling Pattern

1. Call `POST /start`.
2. Poll `GET /notifications/{job_id}?after=<last_seq>`.
3. Poll `GET /jobs/{job_id}` until `status` is `completed` or `failed`.
4. When completed, use `GET /result/{job_id}`.

## Recovery Rule

If runtime context/memory is reset:
1. Read this file (`api/README.md`).
2. Check `api/main.py` endpoint signatures.
3. Check `.env` values.
4. Verify sample assets under `samples/dry_run` for dry-run mode.

