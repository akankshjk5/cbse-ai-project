"""
generate_video_veo.py — Video Generation Engine for Veo 3.1 (via OpenRouter)
============================================================================
Generates a video clip (interpolation) between two frames using Veo 3.1
through the OpenRouter video API.

Results are cached by (model, prompt, frame images, settings): asking for the
same clip again reuses the finished video, and a job interrupted mid-generation
is resumed from its OpenRouter job id instead of being submitted again.

Usage:
    python generate_video_veo.py '{"start_frame": "frame_1.jpg", "end_frame": "frame_2.jpg", "prompt": "...", "output_path": "scene_1.mp4"}'
"""

import sys
import json
import time
import base64
import hashlib
import shutil
from typing import Optional
from pathlib import Path
import os
import requests
from dotenv import load_dotenv  # type: ignore[import-not-found]

load_dotenv()

# ── Auth / config ─────────────────────────────────────────────────────────────
API_KEY = os.getenv("OPENROUTER_API_KEY")
MODEL = os.getenv("OPENROUTER_VIDEO_MODEL", "google/veo-3.1-fast")
API_BASE = "https://openrouter.ai/api/v1"

BASE_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = BASE_DIR / "video_cache"
MANIFEST = CACHE_DIR / "manifest.json"

POLL_SECONDS = 15
MAX_WAIT_SECONDS = 20 * 60


def load_image_data_uri(file_path: str) -> tuple[str, bytes]:
    """Reads a local image file and returns (data URI, raw bytes)."""
    path = Path(file_path)
    mime_map = {
        ".png":  "image/png",
        ".jpg":  "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }
    mime_type = mime_map.get(path.suffix.lower(), "image/jpeg")
    if not path.exists():
        raise FileNotFoundError(f"Image not found at {path}")
    data = path.read_bytes()
    return f"data:{mime_type};base64,{base64.b64encode(data).decode()}", data


# ── Cache manifest ────────────────────────────────────────────────────────────
def _read_manifest() -> dict:
    try:
        return json.loads(MANIFEST.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_manifest(manifest: dict) -> None:
    CACHE_DIR.mkdir(exist_ok=True)
    tmp = MANIFEST.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=2))
    tmp.replace(MANIFEST)


def _update_entry(key: str, **fields) -> None:
    manifest = _read_manifest()
    manifest.setdefault(key, {}).update(fields)
    _write_manifest(manifest)


def _headers() -> dict:
    return {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}


def _poll(job_id: str) -> dict:
    """Polls an OpenRouter video job until it completes or fails."""
    deadline = time.time() + MAX_WAIT_SECONDS
    while True:
        r = requests.get(f"{API_BASE}/videos/{job_id}", headers=_headers(), timeout=60)
        r.raise_for_status()
        status = r.json()
        state = status.get("status")
        if state in ("completed", "failed"):
            return status
        if time.time() > deadline:
            raise TimeoutError(f"Video job {job_id} still '{state}' after {MAX_WAIT_SECONDS}s")
        print(f"Video job {job_id} is {state}... checking again in {POLL_SECONDS}s", file=sys.stderr)
        time.sleep(POLL_SECONDS)


def _download(status: dict, job_id: str, dest: Path) -> None:
    urls = status.get("unsigned_urls") or [f"{API_BASE}/videos/{job_id}/content?index=0"]
    r = requests.get(urls[0], headers=_headers(), timeout=300)
    r.raise_for_status()
    dest.write_bytes(r.content)


def generate_video(start_frame: str, end_frame: Optional[str] = None, prompt: str = "", speech: Optional[str] = None, output_path: Optional[str] = None, duration_seconds: int = 8) -> dict:
    try:
        if not API_KEY:
            raise ValueError("OPENROUTER_API_KEY is not set in .env")

        # 1. Adjust duration to supported values (4, 6, 8 seconds for Veo 3.1)
        supported_durations = [4, 6, 8]
        if duration_seconds not in supported_durations:
            new_duration = min(supported_durations, key=lambda x: abs(x - duration_seconds))
            # Progress logs go to stderr so stdout stays valid JSON for the manager
            print(f"Warning: Duration {duration_seconds}s not supported by Veo 3.1. Snapping to {new_duration}s.", file=sys.stderr)
            duration_seconds = new_duration

        # 2. Load frames — require distinct start/end frames
        if not end_frame:
            raise ValueError("'end_frame' is required and must be different from 'start_frame'.")
        if end_frame == start_frame:
            raise ValueError("'start_frame' and 'end_frame' must be different images to avoid static outputs.")
        first_uri, first_bytes = load_image_data_uri(start_frame)
        last_uri, last_bytes = load_image_data_uri(end_frame)

        # 3. Determine output path
        if not output_path:
            videos_dir = BASE_DIR / "generated_videos"
            videos_dir.mkdir(exist_ok=True)
            output_path = str(videos_dir / f"{Path(start_frame).stem}_to_{Path(end_frame).stem}.mp4")
        else:
            os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        abs_out_path = os.path.abspath(output_path)

        full_prompt = f"A cinematic transition between the two scenes. {prompt}"
        # Sound design only; no narration/voices.
        full_prompt += "\n\nAdd rich ambient and foley sound effects that match the motion; absolutely no narration or voices."

        payload = {
            "model": MODEL,
            "prompt": full_prompt,
            "frame_images": [
                {"type": "image_url", "image_url": {"url": first_uri}, "frame_type": "first_frame"},
                {"type": "image_url", "image_url": {"url": last_uri}, "frame_type": "last_frame"},
            ],
            "duration": int(duration_seconds),
            "aspect_ratio": "9:16",
            "resolution": "720p",
            "generate_audio": True,  # enable ambient SFX (no narration)
            "seed": 0,
        }

        # 4. Cache key: same model + prompt + frame images + settings => same clip
        h = hashlib.sha256()
        h.update(json.dumps({k: v for k, v in payload.items() if k != "frame_images"}, sort_keys=True).encode())
        h.update(hashlib.sha256(first_bytes).digest())
        h.update(hashlib.sha256(last_bytes).digest())
        key = h.hexdigest()[:32]
        cached_file = CACHE_DIR / f"{key}.mp4"
        entry = _read_manifest().get(key, {})

        result = {
            "success": True,
            "video_path": abs_out_path,
            "start_frame": start_frame,
            "end_frame": end_frame,
            "duration": duration_seconds,
            "prompt": full_prompt,
        }

        # 4a. Already generated — reuse it
        if entry.get("status") == "completed" and cached_file.exists():
            print(f"Cache hit: reusing previously generated video {cached_file.name}", file=sys.stderr)
            if os.path.abspath(cached_file) != abs_out_path:
                shutil.copy2(cached_file, abs_out_path)
            return {**result, "cached": True}

        # 4b. Submitted before but not finished — resume that job
        job_id = entry.get("job_id") if entry.get("status") in ("pending", "in_progress", "submitted") else None
        if job_id:
            print(f"Resuming existing video job {job_id}", file=sys.stderr)
        else:
            # 5. Submit a new job
            print(f"Submitting OpenRouter video job for {output_path} (Duration: {duration_seconds}s)...", file=sys.stderr)
            r = requests.post(f"{API_BASE}/videos", headers=_headers(), json=payload, timeout=120)
            if r.status_code >= 400:
                return {"success": False, "error": f"OpenRouter submit failed ({r.status_code}): {r.text[:1000]}"}
            job_id = r.json()["id"]
            _update_entry(key, job_id=job_id, status="submitted", model=MODEL,
                          start_frame=start_frame, end_frame=end_frame, prompt=prompt,
                          submitted_at=time.time())

        # 6. Poll for completion
        status = _poll(job_id)
        if status.get("status") == "failed":
            _update_entry(key, status="failed", error=str(status.get("error")))
            return {"success": False, "error": f"Video generation failed: {status.get('error')}"}

        # 7. Download into the cache, then copy to the requested output path
        CACHE_DIR.mkdir(exist_ok=True)
        _download(status, job_id, cached_file)
        _update_entry(key, status="completed", cost=(status.get("usage") or {}).get("cost"))
        shutil.copy2(cached_file, abs_out_path)
        return {**result, "cached": False}

    except Exception as e:
        import traceback
        return {"success": False, "error": f"{str(e)}\n{traceback.format_exc()}"}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No parameters provided."}))
        sys.exit(1)

    try:
        params = json.loads(sys.argv[1])
        start = params.get("start_frame")
        end = params.get("end_frame")
        p = params.get("prompt", "")
        speech = params.get("speech", None)
        out = params.get("output_path")
        dur = params.get("duration_seconds", 8) # Default to 8 if not provided

        if not start:
            print(json.dumps({"success": False, "error": "Missing 'start_frame' or 'end_frame'."}))
            sys.exit(1)

        result = generate_video(start, end, p, speech, out, dur)
        print(json.dumps(result, indent=2))


    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "error": f"Invalid JSON input: {e}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
