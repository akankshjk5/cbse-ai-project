#!/usr/bin/env python3
"""Single-concurrency queue -> ComfyUI -> validation -> storage worker.

This intentionally uses only the Python standard library so the RunPod image
does not need a second dependency environment for the worker itself.
"""

from __future__ import annotations

import argparse
import base64
import csv
import contextlib
import io
import json
import mimetypes
import os
import re
import signal
import shutil
import subprocess
import sys
import textwrap
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


STOP = threading.Event()
STATE: dict[str, Any] = {"status": "starting", "job_id": None, "last_error": None}
PROFILE_PARAMETERS: dict[str, dict[str, int | float]] = {
    "image-fast": {"width": 1024, "height": 576, "steps": 8},
    "video-fast": {
        "width": 832, "height": 480, "durationSeconds": 3, "fps": 16, "steps": 30,
    },
    "video-quality": {
        "width": 1280, "height": 720, "durationSeconds": 5, "fps": 16, "steps": 30,
    },
}


class WorkerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class JsonClient:
    def __init__(self, base_url: str, headers: dict[str, str] | None = None):
        self.base_url = base_url.rstrip("/")
        self.headers = headers or {}

    def request(
        self,
        method: str,
        path: str,
        payload: Any | None = None,
        *,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 30,
        expect_json: bool = True,
    ) -> Any:
        body = data
        request_headers = {**self.headers, **(headers or {})}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.base_url}{path}", data=body, method=method, headers=request_headers
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:1000]
            raise WorkerError("http_error", f"{method} {path}: HTTP {error.code}: {detail}") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise WorkerError("network_error", f"{method} {path}: {error}") from error
        if not expect_json:
            return result
        return json.loads(result or b"null")


class QueueClient:
    def __init__(self, supabase_url: str, service_key: str):
        self.client = JsonClient(
            supabase_url,
            {"apikey": service_key, "Authorization": f"Bearer {service_key}"},
        )
        self.supabase_url = supabase_url.rstrip("/")

    def owner_for_project(self, project_id: str) -> str:
        query = urllib.parse.urlencode({
            "select": "owner_id", "id": f"eq.{project_id}", "limit": "1",
        })
        rows = self.client.request("GET", f"/rest/v1/lesson_video_projects?{query}")
        if not isinstance(rows, list) or len(rows) != 1 or not rows[0].get("owner_id"):
            raise WorkerError("owner_not_found", "The reference lesson project has no owner")
        return str(rows[0]["owner_id"])

    def rpc(self, name: str, payload: dict[str, Any]) -> Any:
        return self.client.request("POST", f"/rest/v1/rpc/{name}", payload)

    def claim(
        self, worker_id: str, project_ids: list[str] | None = None,
        owner_id: str | None = None,
    ) -> dict[str, Any] | None:
        if project_ids and owner_id:
            raise ValueError("Choose project IDs or an owner ID, not both")
        if owner_id:
            result = self.rpc("claim_lesson_video_job_for_owner", {
                "p_worker_id": worker_id, "p_owner_id": owner_id,
            })
        elif project_ids:
            result = self.rpc("claim_lesson_video_job_for_projects", {
                "p_worker_id": worker_id, "p_project_ids": project_ids,
            })
        else:
            result = self.rpc("claim_lesson_video_job", {"p_worker_id": worker_id})
        if isinstance(result, list) and result:
            result[0]["_queue"] = "lesson"
            return result[0]
        if project_ids or owner_id:
            return None
        result = self.rpc("claim_deck_media_job", {"p_worker_id": worker_id})
        if isinstance(result, list) and result:
            result[0]["_queue"] = "deck"
            return result[0]
        return None

    @staticmethod
    def _rpc_name(job: dict[str, Any], action: str) -> str:
        if job.get("_queue") == "lesson":
            return f"{action}_lesson_video_job"
        return f"{action}_deck_media_job"

    def heartbeat(self, job: dict[str, Any], worker_id: str, progress: int) -> None:
        self.rpc(
            self._rpc_name(job, "heartbeat"),
            {"p_job_id": str(job["id"]), "p_worker_id": worker_id, "p_progress": progress},
        )

    def cancelled(self, job: dict[str, Any]) -> bool:
        table = "lesson_video_jobs" if job.get("_queue") == "lesson" else "deck_media_jobs"
        query = urllib.parse.urlencode(
            {"id": f"eq.{job['id']}", "select": "cancel_requested_at", "limit": "1"}
        )
        rows = self.client.request("GET", f"/rest/v1/{table}?{query}")
        return bool(rows and rows[0].get("cancel_requested_at"))

    def complete(
        self, job: dict[str, Any], worker_id: str, output_url: str, metadata: dict[str, Any]
    ) -> None:
        ok = self.rpc(
            self._rpc_name(job, "complete"),
            {
                "p_job_id": str(job["id"]),
                "p_worker_id": worker_id,
                "p_output_url": output_url,
                "p_output_metadata": metadata,
            },
        )
        if not ok:
            raise WorkerError("stale_job", "Job ownership changed before completion")

    def fail(
        self, job: dict[str, Any], worker_id: str, code: str, message: str,
        retry_delay_seconds: int = 30,
    ) -> None:
        self.rpc(
            self._rpc_name(job, "fail"),
            {
                "p_job_id": str(job["id"]),
                "p_worker_id": worker_id,
                "p_error_code": code,
                "p_error_message": message[:2000],
                "p_retry_delay_seconds": retry_delay_seconds,
            },
        )

    def upload(self, bucket: str, parent_id: str, job_id: str, path: Path) -> str:
        object_name = f"{parent_id}/media/{job_id}{path.suffix.lower()}"
        encoded_name = urllib.parse.quote(object_name, safe="/")
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.client.request(
            "POST",
            f"/storage/v1/object/{bucket}/{encoded_name}",
            data=path.read_bytes(),
            # A retried job re-uploads under the same object name; overwrite it
            # instead of failing with "Duplicate".
            headers={"Content-Type": content_type, "x-upsert": "true"},
            timeout=300,
        )
        return f"{self.supabase_url}/storage/v1/object/public/{bucket}/{encoded_name}"

    def lesson_bundle(self, project_id: str) -> dict[str, Any]:
        project_query = urllib.parse.urlencode({
            "id": f"eq.{project_id}",
            "select": "id,narration_url,narration_duration_seconds,target_duration_seconds",
            "limit": "1",
        })
        projects = self.client.request("GET", f"/rest/v1/lesson_video_projects?{project_query}")
        if not projects or not projects[0].get("narration_url"):
            raise WorkerError("missing_narration", "Lesson narration is not ready")
        scene_query = urllib.parse.urlencode({
            "project_id": f"eq.{project_id}",
            "select": "scene_index,duration_seconds,video_url",
            "order": "scene_index.asc",
        })
        scenes = self.client.request("GET", f"/rest/v1/lesson_video_scenes?{scene_query}")
        if not scenes or any(not scene.get("video_url") for scene in scenes):
            raise WorkerError("missing_scene", "One or more lesson clips are not ready")
        return {"project": projects[0], "scenes": scenes}

    def lesson_scene_context(self, scene_id: str) -> dict[str, Any]:
        scene_query = urllib.parse.urlencode({
            "id": f"eq.{scene_id}",
            "select": "scene_index,fact,project_id",
            "limit": "1",
        })
        scenes = self.client.request("GET", f"/rest/v1/lesson_video_scenes?{scene_query}")
        if not scenes:
            raise WorkerError("missing_scene", "Lesson scene was not found")
        project_query = urllib.parse.urlencode({
            "id": f"eq.{scenes[0]['project_id']}",
            "select": "class_level,subject,topic",
            "limit": "1",
        })
        projects = self.client.request("GET", f"/rest/v1/lesson_video_projects?{project_query}")
        if not projects:
            raise WorkerError("missing_project", "Lesson project was not found")
        return {**projects[0], **scenes[0]}

    def lesson_render_context(self, scene_id: str) -> dict[str, Any]:
        scene_query = urllib.parse.urlencode({
            "id": f"eq.{scene_id}",
            "select": "scene_index,duration_seconds,caption,overlay,project_id",
            "limit": "1",
        })
        scenes = self.client.request("GET", f"/rest/v1/lesson_video_scenes?{scene_query}")
        if not scenes:
            raise WorkerError("missing_scene", "Lesson scene was not found")
        project_query = urllib.parse.urlencode({
            "id": f"eq.{scenes[0]['project_id']}",
            "select": "language_code,target_duration_seconds",
            "limit": "1",
        })
        projects = self.client.request("GET", f"/rest/v1/lesson_video_projects?{project_query}")
        if not projects:
            raise WorkerError("missing_project", "Lesson project was not found")
        return {**projects[0], **scenes[0]}


class ComfyClient:
    def __init__(self, base_url: str):
        self.client = JsonClient(base_url)

    def submit(self, workflow: dict[str, Any]) -> str:
        response = self.client.request(
            "POST", "/prompt", {"prompt": workflow, "client_id": str(uuid.uuid4())}
        )
        prompt_id = response.get("prompt_id") if isinstance(response, dict) else None
        if not prompt_id:
            raise WorkerError("comfy_submit_failed", f"Unexpected ComfyUI response: {response}")
        return str(prompt_id)

    def interrupt(self) -> None:
        try:
            self.client.request("POST", "/interrupt", {})
        except WorkerError:
            pass

    def wait(self, prompt_id: str, timeout_seconds: int, on_tick: Any) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if STOP.is_set():
                self.interrupt()
                raise WorkerError("worker_stopping", "Worker is stopping")
            on_tick()
            history = self.client.request("GET", f"/history/{urllib.parse.quote(prompt_id)}")
            if isinstance(history, dict) and prompt_id in history:
                item = history[prompt_id]
                status = item.get("status", {})
                if status.get("status_str") == "error":
                    raise WorkerError("comfy_execution_failed", json.dumps(status)[:1500])
                if item.get("outputs"):
                    return item
            time.sleep(2)
        self.interrupt()
        raise WorkerError("generation_timeout", f"ComfyUI exceeded {timeout_seconds}s")

    def download_output(self, history_item: dict[str, Any], destination: Path) -> Path:
        candidates: list[dict[str, Any]] = []
        for output in history_item.get("outputs", {}).values():
            if not isinstance(output, dict):
                continue
            for key in ("videos", "gifs", "images"):
                value = output.get(key)
                if isinstance(value, list):
                    candidates.extend(item for item in value if isinstance(item, dict))
        if not candidates:
            raise WorkerError("missing_output", "ComfyUI history contained no media file")
        selected = candidates[-1]
        filename = str(selected.get("filename", ""))
        if not filename:
            raise WorkerError("missing_output", "ComfyUI output did not include a filename")
        query = urllib.parse.urlencode(
            {
                "filename": filename,
                "subfolder": str(selected.get("subfolder", "")),
                "type": str(selected.get("type", "output")),
            }
        )
        data = self.client.request("GET", f"/view?{query}", timeout=300, expect_json=False)
        output_path = destination.with_suffix(Path(filename).suffix.lower() or ".bin")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(data)
        return output_path


def replace_tokens(value: Any, tokens: dict[str, Any]) -> Any:
    if isinstance(value, dict):
        return {key: replace_tokens(item, tokens) for key, item in value.items()}
    if isinstance(value, list):
        return [replace_tokens(item, tokens) for item in value]
    if isinstance(value, str):
        if value in tokens:
            return tokens[value]
        result = value
        for token, replacement in tokens.items():
            result = result.replace(token, str(replacement))
        return result
    return value


def allowed_source_hosts() -> set[str]:
    hosts = {
        host.strip().lower()
        for host in os.environ.get("MEDIA_SOURCE_HOSTS", "").split(",")
        if host.strip()
    }
    supabase_host = urllib.parse.urlparse(os.environ["SUPABASE_URL"]).hostname
    if supabase_host:
        hosts.add(supabase_host.lower())
    return hosts


def wan_frame_count(duration_seconds: float, fps: int) -> int:
    """Return a Wan-compatible (4n+1) frame count meeting the duration."""
    return ((round(duration_seconds * fps) + 3) // 4) * 4 + 1


def resolve_job_parameters(job: dict[str, Any]) -> dict[str, int | float]:
    """Apply fixed serving limits and allow only explicitly supported options."""
    profile = str(job.get("profile", ""))
    defaults = PROFILE_PARAMETERS.get(profile)
    if defaults is None:
        raise WorkerError("unsupported_profile", f"Unsupported media profile: {profile}")
    result = dict(defaults)
    if profile == "video-fast":
        configured_steps = int(os.environ.get("WAN_FAST_STEPS", str(result["steps"])))
        if configured_steps not in (20, 30):
            raise WorkerError("invalid_worker_config", "WAN_FAST_STEPS must be 20 or 30")
        result["steps"] = configured_steps
    requested = job.get("parameters") or {}
    if profile == "video-fast" and "durationSeconds" in requested:
        try:
            requested_duration = int(requested["durationSeconds"])
        except (TypeError, ValueError):
            requested_duration = 0
        if requested_duration in (3, 5):
            result["durationSeconds"] = requested_duration
    if "seed" in requested:
        result["seed"] = int(requested["seed"])
    return result


def download_source_image(job: dict[str, Any], comfy_input: Path) -> str:
    source = str(job.get("source_image_url") or "")
    parsed = urllib.parse.urlparse(source)
    if parsed.scheme != "https" or not parsed.hostname:
        raise WorkerError("invalid_source", "Source image must use HTTPS")
    if parsed.hostname.lower() not in allowed_source_hosts():
        raise WorkerError("invalid_source_host", "Source image host is not allowlisted")
    request = urllib.request.Request(source, headers={"User-Agent": "LuminaMediaWorker/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            content_type = response.headers.get_content_type()
            if not content_type.startswith("image/"):
                raise WorkerError("invalid_source_type", f"Expected image, got {content_type}")
            data = response.read(25 * 1024 * 1024 + 1)
    except urllib.error.URLError as error:
        raise WorkerError("source_download_failed", str(error)) from error
    if len(data) > 25 * 1024 * 1024:
        raise WorkerError("source_too_large", "Source image exceeds 25 MB")
    suffix = mimetypes.guess_extension(content_type) or ".png"
    name = f"media-job-{job['id']}{suffix}"
    comfy_input.mkdir(parents=True, exist_ok=True)
    (comfy_input / name).write_bytes(data)
    return name


def load_workflow(job: dict[str, Any], workflow_dir: Path, comfy_input: Path) -> dict[str, Any]:
    path = workflow_dir / f"{job['profile']}.json"
    if not path.is_file():
        raise WorkerError("workflow_missing", f"Missing API workflow: {path}")
    try:
        workflow = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise WorkerError("workflow_invalid", f"Cannot read {path}: {error}") from error
    source_name = download_source_image(job, comfy_input) if job["kind"] == "video" else ""
    parameters = resolve_job_parameters(job)
    fps = int(parameters.get("fps", 16))
    duration_seconds = float(parameters.get("durationSeconds", 3))
    # Wan video latent lengths must be 1 modulo 4. Round up to the next valid
    # length so the delivered clip is never shorter than requested.
    frames = wan_frame_count(duration_seconds, fps)
    prompt = str(job["prompt"])
    negative_prompt = str(job.get("negative_prompt", ""))
    if job.get("kind") == "image" and job.get("_queue") == "lesson":
        # Z-Image Turbo runs without CFG (the negative prompt is zeroed), so it
        # draws whatever the positive prompt names. Describe only what should be
        # visible; never list unwanted things such as "infographic" or "text".
        attempt = max(1, int(job.get("attempts") or 1))
        if (job.get("parameters") or {}).get("visualMode") == "anatomical":
            prompt += (
                " One coherent scientifically plausible three-dimensional anatomical "
                "visualization, with clear cellular or organ structures, visible depth, "
                "and one central biological action."
            )
        else:
            prompt += (
                " One single photograph of one physical subject, centered and fully visible, "
                "with smooth plain surfaces and an uncluttered seamless backdrop."
            )
        if attempt > 1:
            prompt += (
                " Make the composition even simpler: fewer objects, larger in frame, bare "
                "matte surfaces, soft even light."
            )
    if job.get("kind") == "video" and job.get("_queue") == "lesson":
        prompt += (
            " This must be a genuinely animated explanatory shot: the subject and concept "
            "objects visibly move or change state according to every action beat. Camera motion "
            "is secondary and cannot be the only animation. Maintain object identity and finish "
            "on the specified conceptually correct state."
        )
        negative_prompt += (
            ", frozen subject, static image, slideshow, moving photograph, camera-only motion, "
            "unmotivated motion, invented objects"
        )
    tokens = {
        "__PROMPT__": prompt,
        "__NEGATIVE_PROMPT__": negative_prompt,
        "__SOURCE_IMAGE__": source_name,
        "__SEED__": int(parameters.get("seed", 42))
        + (max(0, int(job.get("attempts") or 1) - 1) * 7919),
        "__WIDTH__": int(parameters.get("width", 1024 if job["kind"] == "image" else 832)),
        "__HEIGHT__": int(parameters.get("height", 576 if job["kind"] == "image" else 480)),
        "__FPS__": fps,
        "__FRAMES__": frames,
        "__STEPS__": int(parameters.get("steps", 30)),
        "__DURATION_SECONDS__": duration_seconds,
    }
    return replace_tokens(workflow, tokens)


def validate_output(path: Path, kind: str) -> dict[str, Any]:
    size = path.stat().st_size
    if size < 1024:
        raise WorkerError("invalid_output", "Generated output is unexpectedly small")
    metadata: dict[str, Any] = {"bytes": size, "extension": path.suffix.lower()}
    if kind == "image":
        with path.open("rb") as handle:
            magic = handle.read(12)
        valid = (
            magic.startswith(b"\x89PNG\r\n\x1a\n")
            or magic.startswith(b"\xff\xd8\xff")
            or magic[:4] in (b"RIFF", b"GIF8")
        )
        if not valid:
            raise WorkerError("invalid_image", "Output has an unsupported image signature")
        return metadata
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height,codec_name:format=duration",
                "-of", "json", str(path),
            ],
            check=True, capture_output=True, text=True, timeout=30,
        )
        probe = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise WorkerError("invalid_video", f"ffprobe failed: {error}") from error
    streams = probe.get("streams") or []
    duration = float((probe.get("format") or {}).get("duration") or 0)
    if not streams or duration <= 0:
        raise WorkerError("invalid_video", "Video has no playable stream or duration")
    metadata.update({"duration": duration, **streams[0]})
    return metadata


def parse_tesseract_tsv(tsv: str, minimum_confidence: float = 55.0) -> list[str]:
    """Return confident text-like tokens while ignoring isolated OCR noise."""
    tokens: list[str] = []
    for row in csv.DictReader(io.StringIO(tsv), delimiter="\t"):
        text = (row.get("text") or "").strip()
        try:
            confidence = float(row.get("conf") or -1)
        except ValueError:
            continue
        compact = re.sub(r"[^\w]", "", text, flags=re.UNICODE)
        if confidence < minimum_confidence or len(compact) < 2:
            continue
        if any(character.isalpha() for character in compact) or any(
            character.isdigit() for character in compact
        ):
            tokens.append(text[:80])
    return tokens


def tesseract_text_boxes(tsv: str, minimum_confidence: float = 55.0) -> list[tuple[int, int, int, int]]:
    """Bounding boxes (left, top, width, height) of the tokens parse_tesseract_tsv keeps."""
    boxes: list[tuple[int, int, int, int]] = []
    for row in csv.DictReader(io.StringIO(tsv), delimiter="\t"):
        text = (row.get("text") or "").strip()
        try:
            confidence = float(row.get("conf") or -1)
            box = tuple(int(row[key]) for key in ("left", "top", "width", "height"))
        except (KeyError, TypeError, ValueError):
            continue
        compact = re.sub(r"[^\w]", "", text, flags=re.UNICODE)
        if confidence >= minimum_confidence and len(compact) >= 2:
            boxes.append(box)  # type: ignore[arg-type]
    return boxes


def blur_text_regions(path: Path, boxes: list[tuple[int, int, int, int]]) -> int:
    """Soften stray generated lettering in place so the scene can continue."""
    from PIL import Image, ImageFilter

    with Image.open(path) as source:
        image = source.convert("RGB")
    for left, top, width, height in boxes:
        pad_x, pad_y = int(width * 0.3) + 6, int(height * 0.5) + 6
        region = (
            max(0, left - pad_x), max(0, top - pad_y),
            min(image.width, left + width + pad_x), min(image.height, top + height + pad_y),
        )
        patch = image.crop(region).filter(ImageFilter.GaussianBlur(max(8, height // 2)))
        image.paste(patch, region[:2])
    image.save(path, format="PNG")
    return len(boxes)


def _strong_edge_bands(path: Path) -> tuple[int, int]:
    """Detect repeated full-width/height separators typical of generated panel sheets."""
    from PIL import Image

    with Image.open(path) as source:
        image = source.convert("L").resize((256, 144))
    pixels = image.load()
    width, height = image.size

    vertical = [
        x
        for x in range(max(1, int(width * 0.05)), int(width * 0.95))
        if sum(abs(pixels[x, y] - pixels[x - 1, y]) >= 30 for y in range(height)) / height
        >= 0.45
    ]
    horizontal = [
        y
        for y in range(max(1, int(height * 0.05)), int(height * 0.95))
        if sum(abs(pixels[x, y] - pixels[x, y - 1]) >= 30 for x in range(width)) / width
        >= 0.45
    ]

    def clusters(values: list[int]) -> int:
        groups = 0
        previous: int | None = None
        for value in values:
            if previous is None or value - previous > 3:
                groups += 1
            previous = value
        return groups

    return clusters(vertical), clusters(horizontal)


def validate_lesson_storyboard(path: Path, final_attempt: bool = False) -> dict[str, Any]:
    """Reject a keyframe that resembles a slide or contains text so it is regenerated.

    On the job's final attempt the scene must not fail the whole lesson: stray
    lettering is blurred in place and a panel-like frame is accepted with a
    warning, both recorded in the output metadata.
    """
    tesseract = shutil.which("tesseract")
    if not tesseract:
        raise WorkerError(
            "storyboard_qa_unavailable",
            "tesseract is required for generated lesson storyboard validation",
        )
    try:
        result = subprocess.run(
            [tesseract, str(path), "stdout", "-l", "eng", "--psm", "11", "tsv"],
            check=True,
            capture_output=True,
            text=True,
            timeout=45,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise WorkerError("storyboard_qa_failed", f"OCR validation failed: {error}") from error

    text_tokens = parse_tesseract_tsv(result.stdout)
    vertical_bands, horizontal_bands = _strong_edge_bands(path)
    panel_like = vertical_bands >= 3 or horizontal_bands >= 3 or (
        vertical_bands + horizontal_bands >= 5
    )
    failures: list[str] = []
    # Organic texture (beans, gravel, foliage) occasionally yields one short
    # confident token. Real headings or fake writing yield a word of three or
    # more characters, or several tokens.
    word_like = [
        token for token in text_tokens
        if len(re.sub(r"[^\w]", "", token, flags=re.UNICODE)) >= 3
    ]
    if word_like or len(text_tokens) >= 2:
        failures.append(f"visible text detected: {', '.join(text_tokens[:8])}")
    if panel_like:
        failures.append(
            f"multi-panel layout detected: {vertical_bands} vertical/{horizontal_bands} horizontal bands"
        )
    if failures and not final_attempt:
        raise WorkerError("storyboard_quality_rejected", "; ".join(failures))
    fallback: dict[str, Any] = {}
    if failures:
        fallback["final_attempt_fallback"] = "; ".join(failures)
        if word_like or len(text_tokens) >= 2:
            fallback["text_regions_blurred"] = blur_text_regions(
                path, tesseract_text_boxes(result.stdout)
            )
    return {
        **fallback,
        "passed": True,
        "ocr": "tesseract-eng",
        "detected_text_tokens": len(text_tokens),
        "vertical_edge_bands": vertical_bands,
        "horizontal_edge_bands": horizontal_bands,
    }


HOUSE_STYLE_MARKER = " Vintage editorial photograph"


def scene_description_from_prompt(prompt: str) -> str:
    """The keyframe prompt is the planner's visual description plus a fixed style."""
    return prompt.split(HOUSE_STYLE_MARKER, 1)[0].strip()[:1200]


def _vision_request(image_bytes: bytes, description: str, mode: str) -> dict[str, Any] | None:
    """POST one image to the local vision service; None when it is unavailable."""
    url = os.environ.get("LESSON_VISION_URL", "http://127.0.0.1:18083").rstrip("/") + "/check"
    body = json.dumps({
        "description": description,
        "mode": mode,
        "imageBase64": base64.b64encode(image_bytes).decode("ascii"),
    }).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "LuminaMediaWorker/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read())
    except (urllib.error.URLError, OSError, ValueError) as error:
        print(f"vision check unavailable: {error}", file=sys.stderr, flush=True)
        return None


def clip_description_from_prompt(prompt: str) -> str:
    """The clip prompt is the keyframe description, then the motion directions."""
    return prompt.split(" Animate the subject physically:", 1)[0].strip()[:1200]


def extract_frame(path: Path, fraction: float) -> bytes:
    duration = probe_video_duration(path)
    try:
        result = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", f"{duration * fraction:.3f}", "-i", str(path),
             "-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1"],
            check=True, capture_output=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise WorkerError("frame_extract_failed", f"Could not read a clip frame: {error}") from error
    return result.stdout


def vision_check_clip(path: Path, description: str, final_attempt: bool) -> dict[str, Any]:
    """Catch animation that melts, duplicates or replaces the subject, or grows text.

    Frames from the middle and the end of the Wan clip are checked. A failing
    clip is re-animated with a new seed; the final attempt is accepted with a
    warning so one clip never fails a lesson.
    """
    if os.environ.get("LESSON_VISION_MODE", "check").lower() == "off":
        return {"clip_vision": "disabled"}
    problems: list[str] = []
    for fraction in (0.5, 0.95):
        verdict = _vision_request(extract_frame(path, fraction), description, "clip")
        if verdict is None:
            return {"clip_vision": "unavailable"}
        if not verdict.get("passed", True):
            reasons = [
                name for name, bad in (
                    ("subject lost", not verdict.get("shows_subject", True)),
                    ("deformed", verdict.get("deformed", False)),
                    ("writing appeared", verdict.get("has_writing", False)),
                    ("unsafe content", verdict.get("unsafe", False)),
                ) if bad
            ]
            if verdict.get("unsafe", False):
                raise WorkerError("clip_quality_rejected", f"clip check: unsafe content ({verdict.get('reason', '')})")
            problems.append(f"{int(fraction * 100)}%: {', '.join(reasons) or 'rejected'} ({verdict.get('reason', '')})")
    if problems:
        message = "clip check: " + "; ".join(problems)
        if not final_attempt:
            raise WorkerError("clip_quality_rejected", message)
        return {"clip_vision": "accepted_on_final_attempt", "clip_warning": message}
    return {"clip_vision": "passed"}


def vision_check_keyframe(path: Path, description: str, final_attempt: bool) -> dict[str, Any]:
    """Ask the local vision model whether the keyframe shows its scene cleanly.

    A mismatch regenerates the image; the final attempt is accepted with a
    warning so one picture never fails a lesson. When the vision service is
    unavailable the check is skipped: the text gate above still applies.
    """
    if os.environ.get("LESSON_VISION_MODE", "check").lower() == "off":
        return {"vision": "disabled"}
    url = os.environ.get("LESSON_VISION_URL", "http://127.0.0.1:18083").rstrip("/") + "/check"
    body = json.dumps({
        "description": description,
        "imageBase64": base64.b64encode(path.read_bytes()).decode("ascii"),
    }).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "LuminaMediaWorker/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            verdict = json.loads(response.read())
    except (urllib.error.URLError, OSError, ValueError) as error:
        print(f"vision check unavailable: {error}", file=sys.stderr, flush=True)
        return {"vision": "unavailable"}
    if not verdict.get("passed", True):
        problems = [
            name for name, bad in (
                ("subject not shown", not verdict.get("shows_subject", True)),
                ("not a single photo", not verdict.get("single_photo", True)),
                ("writing visible", verdict.get("has_writing", False)),
                ("unsafe content", verdict.get("unsafe", False)),
            ) if bad
        ]
        message = f"vision check: {', '.join(problems) or 'rejected'} ({verdict.get('reason', '')})"
        # Unsafe imagery is never accepted, not even on the final attempt.
        if not final_attempt or verdict.get("unsafe", False):
            raise WorkerError("storyboard_quality_rejected", message)
        return {"vision": "accepted_on_final_attempt", "vision_warning": message}
    return {"vision": "passed", "vision_reason": str(verdict.get("reason", ""))[:200]}


def normalize_video(path: Path) -> Path:
    normalized = path.with_name(f"{path.stem}.normalized.mp4")
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error", "-i", str(path),
                "-map", "0:v:0", "-map", "0:a?",
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                "-c:a", "aac", "-b:a", "128k", str(normalized),
            ],
            check=True, capture_output=True, text=True, timeout=300,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise WorkerError("video_normalization_failed", f"ffmpeg failed: {error}") from error
    return normalized


def animate_lesson_image(
    job: dict[str, Any], comfy_input: Path, output_dir: Path,
) -> Path:
    """Create a stable lesson clip from one generated scene image.

    A restrained Ken Burns move is intentional here: generative image-to-video
    can change counts, symbols, anatomy, or object identity after the audited
    key visual is approved. Deterministic motion keeps that teaching visual
    intact, renders in seconds, and leaves Wan available for explicit creative
    video jobs.
    """
    source_name = download_source_image(job, comfy_input)
    source_path = comfy_input / source_name
    parameters = resolve_job_parameters(job)
    width = int(parameters.get("width", 832))
    height = int(parameters.get("height", 480))
    fps = int(parameters.get("fps", 16))
    duration = float(parameters.get("durationSeconds", 5))
    frame_count = max(2, round(duration * fps))
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{job['id']}-stable-motion.mp4"
    # Alternate the very small motion direction so adjacent scenes do not feel
    # duplicated. The image contents themselves never get synthesized again.
    scene_index = int((job.get("parameters") or {}).get("sceneIndex") or 1)
    zoom_delta = "0.00045" if scene_index % 2 else "0.00035"
    x_expr = "iw/2-(iw/zoom/2)" if scene_index % 2 else "min(iw-iw/zoom,on*0.35)"
    filter_graph = (
        f"scale={width * 2}:{height * 2}:force_original_aspect_ratio=increase,"
        f"crop={width * 2}:{height * 2},"
        f"zoompan=z='min(zoom+{zoom_delta},1.035)':x='{x_expr}':"
        f"y='ih/2-(ih/zoom/2)':d={frame_count}:s={width}x{height}:fps={fps},"
        "format=yuv420p"
    )
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error", "-loop", "1", "-i", str(source_path),
                "-vf", filter_graph, "-frames:v", str(frame_count), "-an",
                "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path),
            ],
            check=True, capture_output=True, text=True, timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise WorkerError("stable_motion_failed", f"ffmpeg failed: {error}") from error
    return output_path


def render_lesson_fact_card(
    job: dict[str, Any], queue: QueueClient, output_dir: Path,
) -> Path:
    """Render the audited database fact without asking an image model to spell."""
    from PIL import Image, ImageDraw, ImageFont

    context = queue.lesson_scene_context(str(job["scene_id"]))
    width, height = 1024, 576
    image = Image.new("RGB", (width, height), "#090d1a")
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / max(1, height - 1)
        draw.line((0, y, width, y), fill=(9 + int(17 * ratio), 13 + int(8 * ratio), 26 + int(24 * ratio)))
    draw.ellipse((-150, -220, 410, 340), fill="#4025a8")
    draw.ellipse((770, 310, 1180, 720), fill="#087f83")
    draw.rounded_rectangle((54, 44, 970, 532), radius=34, fill="#10172b", outline="#6d5dfc", width=3)

    font_path = os.environ.get("LESSON_CARD_FONT", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    bold_path = os.environ.get(
        "LESSON_CARD_BOLD_FONT", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    )
    small = ImageFont.truetype(bold_path, 22)
    title_font = ImageFont.truetype(bold_path, 42)
    fact_font = ImageFont.truetype(bold_path, 46)
    footer_font = ImageFont.truetype(font_path, 20)

    subject = str(context["subject"]).upper()
    topic = str(context["topic"]).upper()
    scene_index = int(context["scene_index"])
    draw.rounded_rectangle((88, 76, 520, 118), radius=21, fill="#201b47")
    draw.text((108, 83), f"CLASS {context['class_level']}  •  {subject}", font=small, fill="#c9c3ff")
    draw.text((88, 152), topic, font=title_font, fill="#62e4df")

    fact = str(context["fact"]).strip()
    lines = textwrap.wrap(fact, width=34, break_long_words=False, break_on_hyphens=False)
    while len(lines) > 4 and fact_font.size > 32:
        fact_font = ImageFont.truetype(bold_path, fact_font.size - 2)
        lines = textwrap.wrap(fact, width=40, break_long_words=False, break_on_hyphens=False)
    y = 224
    spacing = fact_font.size + 12
    for line in lines[:4]:
        draw.text((88, y), line, font=fact_font, fill="#ffffff")
        y += spacing

    draw.ellipse((830, 76, 936, 182), fill="#5b47f5")
    number = str(scene_index)
    box = draw.textbbox((0, 0), number, font=title_font)
    draw.text(
        (883 - (box[2] - box[0]) / 2, 129 - (box[3] - box[1]) / 2 - box[1]),
        number,
        font=title_font,
        fill="#ffffff",
    )
    draw.text((88, 480), "Fact-checked lesson • Kannada voice-over", font=footer_font, fill="#9ea9c7")

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{job['id']}-fact-card.png"
    image.save(output_path, format="PNG", optimize=True)
    return output_path


def uses_stable_lesson_motion(job: dict[str, Any]) -> bool:
    return (
        job.get("kind") == "video"
        and job.get("_queue") == "lesson"
        and os.environ.get("LESSON_VIDEO_MOTION_MODE", "wan").lower() == "stable"
    )


def uses_lesson_fact_card(job: dict[str, Any]) -> bool:
    return (
        job.get("kind") == "image"
        and job.get("_queue") == "lesson"
        and os.environ.get("LESSON_IMAGE_MODE", "generated").lower() == "fact-card"
    )


def uses_editorial_composite(job: dict[str, Any]) -> bool:
    return (
        job.get("kind") == "video"
        and job.get("_queue") == "lesson"
        and os.environ.get("LESSON_COMPOSITE_MODE", "editorial").lower() == "editorial"
    )


def composite_lesson_clip(
    job: dict[str, Any], queue: QueueClient, raw_clip: Path, output_dir: Path,
) -> tuple[Path, dict[str, Any]]:
    """Wrap the genuinely animated Wan clip in the deterministic editorial scene."""
    from lesson_compositor import CompositorError, render_editorial_scene

    context = queue.lesson_render_context(str(job["scene_id"]))
    target = int(context.get("target_duration_seconds") or 60)
    output_path = output_dir / f"{job['id']}-editorial.mp4"
    try:
        metadata = render_editorial_scene(
            raw_clip,
            output_path,
            caption=str(context.get("caption") or ""),
            language_code=str(context.get("language_code") or "en-IN"),
            overlay=context.get("overlay"),
            scene_index=int(context["scene_index"]),
            scene_count=8 if target == 60 else 12,
            duration=float(context["duration_seconds"]),
            fonts_dir=Path(os.environ.get("LESSON_FONTS_DIR", "/workspace/lumina-fonts")),
            should_stop=lambda: STOP.is_set() or queue.cancelled(job),
        )
    except CompositorError as error:
        raise WorkerError(error.code, str(error)) from error
    return output_path, metadata


def download_lesson_asset(url: str, destination: Path, max_bytes: int = 250 * 1024 * 1024) -> Path:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise WorkerError("invalid_asset", "Lesson asset must use HTTPS")
    if parsed.hostname.lower() not in allowed_source_hosts():
        raise WorkerError("invalid_asset_host", "Lesson asset host is not allowlisted")
    request = urllib.request.Request(url, headers={"User-Agent": "LuminaMediaWorker/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            data = response.read(max_bytes + 1)
    except urllib.error.URLError as error:
        raise WorkerError("asset_download_failed", str(error)) from error
    if len(data) > max_bytes:
        raise WorkerError("asset_too_large", "Lesson asset exceeds the download limit")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return destination


def probe_video_duration(path: Path) -> float:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(path),
            ],
            check=True, capture_output=True, text=True, timeout=30,
        )
        duration = float(result.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise WorkerError("invalid_scene_video", f"Could not read scene duration: {error}") from error
    if duration <= 0:
        raise WorkerError("invalid_scene_video", "Scene video has no positive duration")
    return duration


LESSON_WIDTH, LESSON_HEIGHT, LESSON_FPS = 1280, 720, 24
LESSON_TRANSITION_SECONDS = 0.4


def lesson_filter_graph(
    scenes: list[dict[str, Any]], clip_durations: list[float], target_duration: int,
    narration_duration: float | None = None,
) -> str:
    """Join scene clips with overlapping page-slide transitions.

    Each editorial clip already carries a held tail of LESSON_TRANSITION_SECONDS,
    so scene N+1 slides in over that tail and every scene still starts exactly at
    the sum of the preceding scene durations. The finished lesson is never shorter
    than requested.
    """
    if not scenes or len(scenes) != len(clip_durations):
        raise WorkerError("invalid_scene_count", "Scene metadata and clip counts do not match")
    filters: list[str] = []
    overlap = LESSON_TRANSITION_SECONDS if len(scenes) > 1 else 0.0
    for position, (scene, source_duration) in enumerate(zip(scenes, clip_durations)):
        scene_duration = float(scene["duration_seconds"])
        if source_duration <= 0 or scene_duration <= 0:
            raise WorkerError("invalid_scene_duration", "Scene durations must be positive")
        clip_length = scene_duration + overlap
        speed_ratio = clip_length / source_duration
        filters.append(
            f"[{position}:v]setpts={speed_ratio:.8f}*PTS,fps={LESSON_FPS},"
            f"scale={LESSON_WIDTH}:{LESSON_HEIGHT}:force_original_aspect_ratio=decrease,"
            f"pad={LESSON_WIDTH}:{LESSON_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0xEEE6D5,"
            f"format=yuv420p,setsar=1,trim=duration={clip_length:.3f},"
            f"setpts=PTS-STARTPTS,settb=AVTB[v{position}]"
        )
    previous = "v0"
    offset = 0.0
    for position in range(1, len(scenes)):
        offset += float(scenes[position - 1]["duration_seconds"])
        label = "video" if position == len(scenes) - 1 else f"x{position}"
        filters.append(
            f"[{previous}][v{position}]xfade=transition=slideleft:"
            f"duration={overlap:.3f}:offset={offset:.3f}[{label}]"
        )
        previous = label
    if len(scenes) == 1:
        filters.append("[v0]null[video]")
    audio_filters = f"[{len(scenes)}:a]aresample=48000,"
    if narration_duration and narration_duration > target_duration - 1:
        audio_filters += f"atempo={narration_duration / (target_duration - 1):.8f},"
    filters.append(
        f"{audio_filters}apad,atrim=duration={target_duration},"
        "asetpts=PTS-STARTPTS[audio]"
    )
    return ";".join(filters)


def assemble_lesson_video(
    job: dict[str, Any], queue: QueueClient, worker_id: str, output_dir: Path,
) -> tuple[Path, dict[str, Any]]:
    project_id = str(job["project_id"])
    bundle = queue.lesson_bundle(project_id)
    project = bundle["project"]
    scenes = bundle["scenes"]
    target_duration = int(project["target_duration_seconds"])
    expected_count = 8 if target_duration == 60 else 12
    if len(scenes) != expected_count:
        raise WorkerError("invalid_scene_count", f"Expected {expected_count} scenes, got {len(scenes)}")

    clip_paths: list[Path] = []
    clip_durations: list[float] = []
    for scene in scenes:
        index = int(scene["scene_index"])
        clip_path = output_dir / f"{job['id']}-scene-{index:02d}.mp4"
        download_lesson_asset(str(scene["video_url"]), clip_path)
        clip_paths.append(clip_path)
        clip_durations.append(probe_video_duration(clip_path))
    narration_path = output_dir / f"{job['id']}-narration.wav"
    download_lesson_asset(str(project["narration_url"]), narration_path, 100 * 1024 * 1024)

    narration_duration = float(project.get("narration_duration_seconds") or 0)
    filter_graph = lesson_filter_graph(
        scenes, clip_durations, target_duration, narration_duration
    )

    output_path = output_dir / f"{job['id']}-lesson.mp4"
    command = ["ffmpeg", "-y", "-v", "error"]
    for clip_path in clip_paths:
        command.extend(["-i", str(clip_path)])
    command.extend([
        "-i", str(narration_path), "-filter_complex", filter_graph,
        "-map", "[video]", "-map", "[audio]", "-t", str(target_duration),
        "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-pix_fmt", "yuv420p", "-r", str(LESSON_FPS), "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "128k", str(output_path),
    ])
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    last_heartbeat = 0.0
    while process.poll() is None:
        if STOP.is_set() or queue.cancelled(job):
            process.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=10)
            raise WorkerError("cancelled", "Cancellation requested during lesson assembly")
        now = time.monotonic()
        if now - last_heartbeat >= 10:
            queue.heartbeat(job, worker_id, 75)
            last_heartbeat = now
        time.sleep(1)
    stderr = process.stderr.read() if process.stderr else ""
    if process.returncode != 0:
        raise WorkerError("lesson_assembly_failed", f"ffmpeg failed: {stderr[-1500:]}")

    metadata = validate_output(output_path, "video")
    if float(metadata.get("duration", 0)) < target_duration - 0.25:
        raise WorkerError("lesson_too_short", "Assembled lesson is shorter than requested")
    metadata.update({
        "scene_count": len(scenes),
        "target_duration_seconds": target_duration,
        "narration_duration_seconds": round(narration_duration, 3),
        "narration_speed_factor": round(
            max(1.0, narration_duration / (target_duration - 1)), 4
        ),
        "source_clip_durations": [round(value, 3) for value in clip_durations],
    })
    return output_path, metadata


def history_output_paths(history_item: dict[str, Any], output_root: Path) -> list[Path]:
    """Resolve ComfyUI output files without allowing paths outside output_root."""
    root = output_root.resolve()
    paths: list[Path] = []
    for output in history_item.get("outputs", {}).values():
        if not isinstance(output, dict):
            continue
        for key in ("videos", "gifs", "images"):
            value = output.get(key)
            if not isinstance(value, list):
                continue
            for item in value:
                if not isinstance(item, dict) or item.get("type", "output") != "output":
                    continue
                filename = str(item.get("filename", ""))
                if not filename:
                    continue
                candidate = (root / str(item.get("subfolder", "")) / filename).resolve()
                try:
                    candidate.relative_to(root)
                except ValueError:
                    continue
                paths.append(candidate)
    return paths


def cleanup_job_files(
    job_id: str,
    comfy_input: Path,
    output_dir: Path,
    comfy_output_paths: list[Path] | None = None,
) -> None:
    """Best-effort cleanup of files created for one completed or failed attempt."""
    candidates = list(comfy_input.glob(f"media-job-{job_id}.*"))
    candidates.extend(output_dir.glob(f"{job_id}*"))
    candidates.extend(comfy_output_paths or [])
    for path in candidates:
        if path.is_file() or path.is_symlink():
            with contextlib.suppress(OSError):
                path.unlink()


def health_server(port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/health":
                self.send_response(404)
                self.end_headers()
                return
            payload = json.dumps(STATE).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def process_job(
    job: dict[str, Any], queue: QueueClient, comfy: ComfyClient, worker_id: str,
    workflow_dir: Path, comfy_input: Path, comfy_output: Path, output_dir: Path,
) -> None:
    job_id = str(job["id"])
    STATE.update(status="processing", job_id=job_id, last_error=None)
    history: dict[str, Any] | None = None
    job_started = time.monotonic()
    try:
        if job["kind"] == "assemble":
            queue.heartbeat(job, worker_id, 5)
            postprocess_started = time.monotonic()
            path, metadata = assemble_lesson_video(job, queue, worker_id, output_dir)
            postprocess_seconds = time.monotonic() - postprocess_started
            queue.heartbeat(job, worker_id, 95)
            upload_started = time.monotonic()
            output_url = queue.upload(
                "lesson-video-assets", str(job["project_id"]), job_id, path
            )
            metadata["latency_seconds"] = {
                "generation": 0,
                "postprocess": round(postprocess_seconds, 3),
                "upload": round(time.monotonic() - upload_started, 3),
                "total": round(time.monotonic() - job_started, 3),
            }
            queue.complete(job, worker_id, output_url, metadata)
            return

        queue.heartbeat(job, worker_id, 5)
        generation_started = time.monotonic()
        stable_lesson_motion = uses_stable_lesson_motion(job)
        lesson_fact_card = uses_lesson_fact_card(job)
        if lesson_fact_card:
            path = render_lesson_fact_card(job, queue, output_dir)
        elif stable_lesson_motion:
            if queue.cancelled(job):
                raise WorkerError("cancelled", "Cancellation requested")
            path = animate_lesson_image(job, comfy_input, output_dir)
        else:
            workflow = load_workflow(job, workflow_dir, comfy_input)
            prompt_id = comfy.submit(workflow)
            last_heartbeat = 0.0

            def tick() -> None:
                nonlocal last_heartbeat
                if queue.cancelled(job):
                    comfy.interrupt()
                    raise WorkerError("cancelled", "Cancellation requested")
                now = time.monotonic()
                if now - last_heartbeat >= 10:
                    queue.heartbeat(job, worker_id, 25)
                    last_heartbeat = now

            history = comfy.wait(
                prompt_id,
                int(os.environ.get("MEDIA_JOB_TIMEOUT_SECONDS", "1800")),
                tick,
            )
            path = comfy.download_output(history, output_dir / job_id)
        generation_seconds = time.monotonic() - generation_started
        queue.heartbeat(job, worker_id, 85)
        postprocess_started = time.monotonic()
        if job["kind"] == "video" and not stable_lesson_motion:
            path = normalize_video(path)
        clip_quality: dict[str, Any] | None = None
        if job["kind"] == "video" and job.get("_queue") == "lesson" and not stable_lesson_motion:
            queue.heartbeat(job, worker_id, 86)
            clip_quality = vision_check_clip(
                path,
                clip_description_from_prompt(str(job.get("prompt", ""))),
                int(job.get("attempts") or 1) >= int(job.get("max_attempts") or 1),
            )
        composite_metadata: dict[str, Any] | None = None
        if uses_editorial_composite(job) and not stable_lesson_motion:
            queue.heartbeat(job, worker_id, 88)
            path, composite_metadata = composite_lesson_clip(job, queue, path, output_dir)
        metadata = validate_output(path, str(job["kind"]))
        if composite_metadata:
            metadata["composite"] = composite_metadata
        if clip_quality:
            metadata["clip_quality"] = clip_quality
        if (
            job["kind"] == "image"
            and job.get("_queue") == "lesson"
            and not lesson_fact_card
        ):
            final_attempt = int(job.get("attempts") or 1) >= int(job.get("max_attempts") or 1)
            metadata["storyboard_quality"] = validate_lesson_storyboard(path, final_attempt)
            metadata["storyboard_quality"].update(vision_check_keyframe(
                path, scene_description_from_prompt(str(job.get("prompt", ""))), final_attempt,
            ))
        if stable_lesson_motion:
            metadata["motion_mode"] = "stable-ken-burns"
        if lesson_fact_card:
            metadata["visual_mode"] = "deterministic-fact-card"
        postprocess_seconds = time.monotonic() - postprocess_started
        queue.heartbeat(job, worker_id, 95)
        upload_started = time.monotonic()
        if job.get("deck_id"):
            bucket, parent_id = "deck-assets", str(job["deck_id"])
        elif job.get("video_project_id"):
            bucket, parent_id = "video-assets", str(job["video_project_id"])
        elif job.get("project_id") and job.get("_queue") == "lesson":
            bucket, parent_id = "lesson-video-assets", str(job["project_id"])
        else:
            raise WorkerError("invalid_job", "Media job has no deck or video project parent")
        output_url = queue.upload(bucket, parent_id, job_id, path)
        upload_seconds = time.monotonic() - upload_started
        metadata["latency_seconds"] = {
            "generation": round(generation_seconds, 3),
            "postprocess": round(postprocess_seconds, 3),
            "upload": round(upload_seconds, 3),
            "total": round(time.monotonic() - job_started, 3),
        }
        metadata["serving_parameters"] = resolve_job_parameters(job)
        queue.complete(job, worker_id, output_url, metadata)
    finally:
        comfy_paths = history_output_paths(history, comfy_output) if history else []
        cleanup_job_files(job_id, comfy_input, output_dir, comfy_paths)


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Required environment variable is missing: {name}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="Claim at most one job, then exit")
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    parser.add_argument("--health-port", type=int, default=8090)
    parser.add_argument("--project-id", action="append", default=[],
                        help="Only claim jobs for this lesson project; repeat for multiple projects")
    parser.add_argument("--owner-id",
                        help="Only claim active lesson jobs owned by this Clerk user")
    parser.add_argument("--owner-project-id",
                        help="Resolve the allowed owner from an existing lesson project")
    args = parser.parse_args()
    if sum(bool(value) for value in (args.project_id, args.owner_id, args.owner_project_id)) > 1:
        parser.error("Choose only one of --project-id, --owner-id or --owner-project-id")

    supabase_url = require_env("SUPABASE_URL")
    service_key = require_env("SUPABASE_SERVICE_ROLE_KEY")
    comfy_url = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
    workspace = Path(os.environ.get("WORKSPACE", "/workspace"))
    workflow_dir = Path(
        os.environ.get("MEDIA_WORKFLOW_DIR", workspace / "lumina-deck-pro/ops/runpod/workflows/api")
    )
    comfy_input = Path(os.environ.get("COMFYUI_INPUT_DIR", workspace / "ComfyUI/input"))
    comfy_output = Path(os.environ.get("COMFYUI_OUTPUT_DIR", workspace / "ComfyUI/output"))
    output_dir = Path(os.environ.get("MEDIA_OUTPUT_DIR", workspace / "lumina-media-output"))
    worker_id = os.environ.get("MEDIA_WORKER_ID", f"runpod-{uuid.uuid4().hex[:12]}")

    queue = QueueClient(supabase_url, service_key)
    allowed_owner = (
        queue.owner_for_project(args.owner_project_id)
        if args.owner_project_id else args.owner_id
    )
    comfy = ComfyClient(comfy_url)
    server = health_server(args.health_port)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_args: STOP.set())

    STATE["status"] = "idle"
    STATE["scope"] = (
        {"kind": "owner", "ownerId": allowed_owner} if allowed_owner
        else {"kind": "projects", "projectIds": args.project_id} if args.project_id
        else {"kind": "unscoped"}
    )
    try:
        while not STOP.is_set():
            job = queue.claim(worker_id, args.project_id or None, allowed_owner)
            if not job:
                if args.once:
                    return 0
                STOP.wait(args.poll_seconds)
                continue
            try:
                process_job(
                    job, queue, comfy, worker_id, workflow_dir, comfy_input, comfy_output, output_dir
                )
                STATE.update(status="idle", job_id=None, last_error=None)
            except WorkerError as error:
                STATE.update(status="error", last_error=error.code)
                # A rejected storyboard is regenerated immediately with a new seed;
                # the attempt limit on the job bounds how often that can happen.
                retry_delay = 2 if error.code in ("storyboard_quality_rejected", "clip_quality_rejected") else 30
                queue.fail(job, worker_id, error.code, str(error), retry_delay)
                print(f"job {job['id']} failed [{error.code}]: {error}", file=sys.stderr, flush=True)
                STATE.update(status="idle", job_id=None)
            except Exception as error:  # final containment boundary for a long-running worker
                STATE.update(status="error", last_error="worker_exception")
                queue.fail(job, worker_id, "worker_exception", str(error))
                print(f"job {job['id']} failed [worker_exception]: {error}", file=sys.stderr, flush=True)
                STATE.update(status="idle", job_id=None)
            if args.once:
                return 0
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
