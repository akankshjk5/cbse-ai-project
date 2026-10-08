# Dry Run Samples

This folder powers `DRY_RUN=1` mode.

Required files/folders used by the API:
- `script.json`
- `memory.json`
- `notifications.json`
- `generated_frames/`
- `generated_audio/`
- `generated_videos/`
- `output.mp4` (or `final_output.mp4`)

In dry run mode, API copies these assets into workspace output folders, then serves the archived result through `/result/{job_id}`.
