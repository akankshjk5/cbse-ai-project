"""
API server that runs Agent.py and exposes job progress for frontend polling.
"""

from __future__ import annotations

import asyncio
from contextlib import nullcontext
from datetime import datetime
import json
import os
import re
import shutil
import sys
import threading
import uuid
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

try:
    from langfuse import get_client
except Exception:  # pragma: no cover - optional dependency at runtime
    get_client = None  # type: ignore[assignment]

load_dotenv()

# On Windows, Proactor can emit noisy ConnectionResetError logs when
# clients close a streamed response early (common with HTML5 video range requests).
if os.name == "nt" and hasattr(asyncio, "WindowsSelectorEventLoopPolicy"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

# Keep compatibility with different key names.
_dry = os.getenv("DRY_RUN")
if _dry is None:
    _dry = os.getenv("dry_run", os.getenv("dry run", "0"))
DRY_RUN = str(_dry).strip() == "1"

_clean = os.getenv("CLEAN_AFTER_ARCHIVE", "1")
CLEAN_AFTER_ARCHIVE = str(_clean).strip() == "1"

_notif = os.getenv("NOTIFICATION_INTERVAL_SECONDS", "10")
try:
    DEFAULT_NOTIFICATION_INTERVAL_SECONDS = float(_notif)
except ValueError:
    DEFAULT_NOTIFICATION_INTERVAL_SECONDS = 10.0
if DEFAULT_NOTIFICATION_INTERVAL_SECONDS <= 0:
    DEFAULT_NOTIFICATION_INTERVAL_SECONDS = 10.0

_poll = os.getenv("REAL_MEMORY_POLL_SECONDS", "1")
try:
    REAL_MEMORY_POLL_SECONDS = float(_poll)
except ValueError:
    REAL_MEMORY_POLL_SECONDS = 1.0
if REAL_MEMORY_POLL_SECONDS <= 0:
    REAL_MEMORY_POLL_SECONDS = 1.0

UPLOADS_DIR = BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

MEMORY_FILE = BASE_DIR / "memory.json"
GENERATED_VIDEOS_DIR = BASE_DIR / "generated_videos"
GENERATED_FRAMES_DIR = BASE_DIR / "generated_frames"
GENERATED_AUDIO_DIR = BASE_DIR / "generated_audio"
JOB_RUNS_DIR = BASE_DIR / "job_runs"
SAMPLE_DRY_RUN_DIR = BASE_DIR / "samples" / "dry_run"
JOB_RUNS_DIR.mkdir(parents=True, exist_ok=True)

LANGFUSE_TRACING_ENABLED = os.getenv("LANGFUSE_TRACING_ENABLED", "1").strip() != "0"
LANGFUSE_REQUIRED_KEYS = ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")
_langfuse_client = None
_langfuse_client_failed = False
_langfuse_lock = threading.Lock()


def _langfuse_is_configured() -> bool:
    if not LANGFUSE_TRACING_ENABLED or get_client is None:
        return False
    return all(str(os.getenv(k, "")).strip() for k in LANGFUSE_REQUIRED_KEYS)


def _get_langfuse_client():
    global _langfuse_client, _langfuse_client_failed
    if _langfuse_client_failed:
        return None
    if _langfuse_client is not None:
        return _langfuse_client
    if not _langfuse_is_configured():
        return None

    with _langfuse_lock:
        if _langfuse_client is not None:
            return _langfuse_client
        if _langfuse_client_failed:
            return None
        try:
            _langfuse_client = get_client()
        except Exception:
            _langfuse_client_failed = True
            _langfuse_client = None
            return None
    return _langfuse_client


class _NoopObservation:
    def update(self, **_: object) -> None:
        return


def _langfuse_observation(name: str, **kwargs):
    client = _get_langfuse_client()
    if not client:
        return nullcontext(_NoopObservation())
    try:
        return client.start_as_current_observation(name=name, as_type="span", **kwargs)
    except Exception:
        return nullcontext(_NoopObservation())


def _langfuse_update(observation, **kwargs) -> None:
    if observation is None:
        return
    try:
        observation.update(**kwargs)
    except Exception:
        return


def _langfuse_flush() -> None:
    client = _get_langfuse_client()
    if not client:
        return
    try:
        client.flush()
    except Exception:
        return


def _slugify_style_name(value: Optional[str]) -> str:
    text = (value or "custom_style").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    text = text.strip("_")
    return text or "custom_style"


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    completed = "completed"
    failed = "failed"


class Notification(BaseModel):
    seq: int
    text: str


class Job(BaseModel):
    id: str
    status: JobStatus
    message: str
    selected_style_name: Optional[str] = None
    generated_style_name: Optional[str] = None
    image_path: Optional[Path] = None
    result_path: Optional[Path] = None
    archive_dir: Optional[Path] = None
    notification_interval_seconds: float = DEFAULT_NOTIFICATION_INTERVAL_SECONDS
    agent_response: Optional[str] = None
    langfuse_trace_id: Optional[str] = None
    langfuse_trace_url: Optional[str] = None
    notifications: List[Notification] = Field(default_factory=list)
    error: Optional[str] = None


jobs: Dict[str, Job] = {}
lock = threading.Lock()

app = FastAPI(title="ET Agent API", version="0.5.0")

_cors_origins_raw = os.getenv(
    "CORS_ALLOW_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,http://127.0.0.1:8080",
)
CORS_ALLOW_ORIGINS = [o.strip() for o in _cors_origins_raw.split(",") if o.strip()]
_cors_origin_regex = os.getenv(
    "CORS_ALLOW_ORIGIN_REGEX",
    r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$",
).strip()
CORS_ALLOW_ORIGIN_REGEX = _cors_origin_regex or None

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS or ["*"],
    allow_origin_regex=CORS_ALLOW_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _get_job(job_id: str) -> Job:
    with lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def _save_job(job: Job) -> None:
    with lock:
        jobs[job.id] = job


def _push(job_id: str, text: str) -> None:
    words = text.strip().split()
    if len(words) < 2:
        text = f"Status {text.strip()}"
        words = text.split()
    if len(words) > 5:
        text = " ".join(words[:5])

    with lock:
        job = jobs.get(job_id)
        if not job:
            return
        if job.notifications and job.notifications[-1].text == text:
            return
        seq = len(job.notifications) + 1
        job.notifications.append(Notification(seq=seq, text=text))
        jobs[job_id] = job


def _step_notice(description: str, status: str) -> str:
    desc = description.lower()

    if status == "error":
        return "Step failed"

    if "scriptwriter_agent" in desc:
        return "Writing script"
    if "storyboard_artist" in desc:
        return "Creating storyboard"
    if "voiceover_agent" in desc:
        return "Generating narration"
    if "motion_designer_agent" in desc:
        return "Animating scenes"
    if "video_editor_agent" in desc:
        return "Composing final video"

    if "generate_storyboard_image" in desc:
        return "Rendering frame"
    if "generate_video_veo" in desc:
        return "Generating video clip"
    if "generate_voiceover" in desc:
        return "Creating voice track"
    if "compile_videos" in desc:
        return "Compiling clips"
    if "add_audio_to_video" in desc:
        return "Mixing audio"

    if "running tool" in desc:
        return "Running tool"
    if "loading skill" in desc:
        return "Loading specialist"

    if status in ("success", "done"):
        return "Step completed"

    return "Pipeline running"


def _read_memory() -> List[dict]:
    if not MEMORY_FILE.exists():
        return []
    try:
        with MEMORY_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _pump_memory(job_id: str, seen_ids: set[int], seen_status: Dict[int, str]) -> None:
    for step in _read_memory():
        step_id = int(step.get("id", 0))
        if step_id <= 0:
            continue

        status = str(step.get("status", "pending"))
        desc = str(step.get("description", ""))

        if step_id not in seen_ids:
            seen_ids.add(step_id)
            seen_status[step_id] = status
            _push(job_id, _step_notice(desc, status))
        elif seen_status.get(step_id) != status:
            seen_status[step_id] = status
            if status == "error":
                _push(job_id, "Step failed")


def _build_query(
    message: str,
    image_path: Optional[Path],
    selected_style_name: Optional[str] = None,
    generated_style_name: Optional[str] = None,
) -> str:
    sections = [message]

    if selected_style_name:
        sections.append(f"User-selected style: {selected_style_name}")

    if image_path:
        sections.append(
            f"Reference style image path: {image_path}\n"
            "Use this image as the visual style reference for storyboard and motion."
        )

    if generated_style_name:
        sections.append(
            "Generated storyboard style template name: "
            f"{generated_style_name}\n"
            "STYLE CREATION RULE (mandatory when reference image exists): "
            "Before Phase 2 Storyboarding, call `run_skill` with "
            "`skill_name='storyboard_styler'` and a query that explicitly includes "
            "`style_name`, `image_path`, and `description`. "
            "Example: run_skill(skill_name='storyboard_styler', query='Create style_name <name> using image_path <path> and description <desc>').\n"
            "After style creation, pass this exact `style_name` in every "
            "`generate_storyboard_image` call for all 8 shots.\n"
            "Do not default to Vox-style unless the user explicitly requested Vox."
        )

    return "\n\n".join(part for part in sections if part)


def _extract_video_path(text: str) -> Optional[Path]:
    if not text:
        return None

    matches = re.findall(r"([A-Za-z]:\\[^\s\"']+\.mp4|[\w./\\-]+\.mp4)", text)
    for match in matches:
        p = Path(match)
        if not p.is_absolute():
            p = BASE_DIR / p
        p = p.resolve()
        if p.exists() and p.suffix.lower() == ".mp4":
            return p
    return None


def _resolve_final_video() -> Optional[Path]:
    candidates = [
        BASE_DIR / "output.mp4",
        BASE_DIR / "final_output.mp4",
        GENERATED_VIDEOS_DIR / "output.mp4",
        GENERATED_VIDEOS_DIR / "final_output.mp4",
    ]
    for p in candidates:
        if p.exists():
            return p.resolve()

    if GENERATED_VIDEOS_DIR.exists():
        others = [
            p for p in GENERATED_VIDEOS_DIR.glob("*.mp4")
            if p.is_file() and not p.name.startswith("sense_")
        ]
        if others:
            others.sort(key=lambda x: x.stat().st_mtime, reverse=True)
            return others[0].resolve()

    return None


def _run_agent(query: str) -> str:
    from Agent import Agent

    agent = Agent()
    agent.memory.clear()
    return agent.run(query)


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _clear_dir(path: Path) -> None:
    if not path.exists():
        return
    for item in path.iterdir():
        try:
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink()
        except Exception:
            pass


def _write_text(path: Path, content: str) -> None:
    _ensure_dir(path.parent)
    path.write_text(content, encoding="utf-8")


def _write_json(path: Path, data: dict) -> None:
    _ensure_dir(path.parent)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def _copy_file_if_exists(src: Path, dst: Path) -> None:
    if src.exists():
        _ensure_dir(dst.parent)
        shutil.copy2(src, dst)


def _copy_tree_if_exists(src: Path, dst: Path) -> None:
    if src.exists() and src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)


def _load_sample_notifications() -> List[str]:
    notif_file = SAMPLE_DRY_RUN_DIR / "notifications.json"
    if notif_file.exists():
        try:
            with notif_file.open("r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                notes = [str(x).strip() for x in data if str(x).strip()]
                filtered = [n for n in notes if n not in {"Archiving outputs", "Video ready", "Workspace cleaned"}]
                if filtered:
                    return filtered
        except Exception:
            pass
    return [
        "Writing script",
        "Creating storyboard",
        "Generating narration",
        "Animating scenes",
        "Composing final video",
    ]


def _cleanup_workspace_outputs() -> None:
    for d in [GENERATED_FRAMES_DIR, GENERATED_AUDIO_DIR, GENERATED_VIDEOS_DIR, BASE_DIR / "temp_merges"]:
        _clear_dir(d)

    for f in [BASE_DIR / "script.json", BASE_DIR / "output.mp4", BASE_DIR / "final_output.mp4"]:
        if f.exists():
            try:
                f.unlink()
            except Exception:
                pass

    if MEMORY_FILE.exists():
        MEMORY_FILE.write_text("[]\n", encoding="utf-8")


def _materialize_dry_run_sample() -> Path:
    if not SAMPLE_DRY_RUN_DIR.exists():
        raise FileNotFoundError(f"Dry-run sample folder missing: {SAMPLE_DRY_RUN_DIR}")

    _cleanup_workspace_outputs()

    _copy_file_if_exists(SAMPLE_DRY_RUN_DIR / "script.json", BASE_DIR / "script.json")
    _copy_file_if_exists(SAMPLE_DRY_RUN_DIR / "memory.json", MEMORY_FILE)
    _copy_file_if_exists(SAMPLE_DRY_RUN_DIR / "output.mp4", BASE_DIR / "output.mp4")
    _copy_file_if_exists(SAMPLE_DRY_RUN_DIR / "final_output.mp4", BASE_DIR / "final_output.mp4")

    _copy_tree_if_exists(SAMPLE_DRY_RUN_DIR / "generated_frames", GENERATED_FRAMES_DIR)
    _copy_tree_if_exists(SAMPLE_DRY_RUN_DIR / "generated_audio", GENERATED_AUDIO_DIR)
    _copy_tree_if_exists(SAMPLE_DRY_RUN_DIR / "generated_videos", GENERATED_VIDEOS_DIR)

    final_video = _resolve_final_video()
    if not final_video:
        raise FileNotFoundError("Dry-run sample does not contain a usable final mp4")
    return final_video


def _archive_job_outputs(job: Job) -> tuple[Path, Optional[Path]]:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = JOB_RUNS_DIR / f"{timestamp}_{job.id[:8]}"
    input_dir = run_dir / "input"
    artifacts_dir = run_dir / "artifacts"
    result_dir = run_dir / "result"

    _ensure_dir(input_dir)
    _ensure_dir(artifacts_dir)
    _ensure_dir(result_dir)

    _write_text(input_dir / "message.txt", job.message)
    if job.image_path and job.image_path.exists():
        shutil.copy2(job.image_path, input_dir / job.image_path.name)

    files_to_copy = [
        BASE_DIR / "script.json",
        BASE_DIR / "output.mp4",
        BASE_DIR / "final_output.mp4",
        MEMORY_FILE,
    ]
    for src in files_to_copy:
        if src.exists():
            shutil.copy2(src, artifacts_dir / src.name)

    dir_map = {
        GENERATED_FRAMES_DIR: artifacts_dir / "generated_frames",
        GENERATED_AUDIO_DIR: artifacts_dir / "generated_audio",
        GENERATED_VIDEOS_DIR: artifacts_dir / "generated_videos",
    }
    for src, dst in dir_map.items():
        if src.exists():
            shutil.copytree(src, dst, dirs_exist_ok=True)

    result_src = job.result_path if job.result_path and job.result_path.exists() else _resolve_final_video()
    archived_result = None
    if result_src and result_src.exists():
        archived_result = result_dir / result_src.name
        shutil.copy2(result_src, archived_result)

    manifest = {
        "job_id": job.id,
        "created_at": datetime.now().isoformat(),
        "status": job.status.value,
        "dry_run": DRY_RUN,
        "result_file": str(archived_result) if archived_result else None,
        "selected_style_name": job.selected_style_name,
        "generated_style_name": job.generated_style_name,
        "langfuse_trace_id": job.langfuse_trace_id,
        "langfuse_trace_url": job.langfuse_trace_url,
    }
    _write_json(run_dir / "manifest.json", manifest)
    return run_dir.resolve(), archived_result.resolve() if archived_result else None


def _finalize_success(job_id: str, response_text: str, final_video: Path) -> None:
    job = _get_job(job_id)
    job.status = JobStatus.completed
    job.result_path = final_video.resolve()
    job.agent_response = response_text
    _save_job(job)

    _push(job_id, "Archiving outputs")
    archive_dir, archived_result = _archive_job_outputs(job)

    job = _get_job(job_id)
    job.archive_dir = archive_dir
    if archived_result:
        job.result_path = archived_result
    _save_job(job)

    if CLEAN_AFTER_ARCHIVE:
        _cleanup_workspace_outputs()
        _push(job_id, "Workspace cleaned")

    _push(job_id, "Video ready")


async def _simulate_job(job_id: str) -> None:
    job = _get_job(job_id)
    interval = job.notification_interval_seconds

    for phase in _load_sample_notifications():
        _push(job_id, phase)
        await asyncio.sleep(interval)

    final_video = _materialize_dry_run_sample()
    _finalize_success(job_id, "Dry run sample replay complete", final_video)


async def _run_job(job_id: str) -> None:
    job = _get_job(job_id)
    job.status = JobStatus.running
    _save_job(job)
    _push(job_id, "Agent started")

    trace_input = {
        "job_id": job.id,
        "message": job.message,
        "selected_style_name": job.selected_style_name,
        "has_reference_image": bool(job.image_path),
        "dry_run": DRY_RUN,
    }
    trace_metadata = {
        "notification_interval_seconds": str(job.notification_interval_seconds),
        "real_memory_poll_seconds": str(REAL_MEMORY_POLL_SECONDS),
    }

    with _langfuse_observation(
        "et.video_pipeline.job",
        input=trace_input,
        metadata=trace_metadata,
    ) as root_observation:
        langfuse_client = _get_langfuse_client()
        propagation_ctx = nullcontext()
        if langfuse_client:
            try:
                propagation_ctx = langfuse_client.propagate_attributes(
                    session_id=job.id,
                    tags=["et-agent", "video-pipeline"],
                    trace_name="et.video_pipeline.job",
                )
            except Exception:
                propagation_ctx = nullcontext()

        with propagation_ctx:
            if langfuse_client:
                try:
                    trace_id = langfuse_client.get_current_trace_id()
                    trace_url = langfuse_client.get_trace_url(trace_id=trace_id) if trace_id else None
                    current = _get_job(job_id)
                    current.langfuse_trace_id = trace_id
                    current.langfuse_trace_url = trace_url
                    _save_job(current)
                except Exception:
                    pass

            if DRY_RUN:
                try:
                    with _langfuse_observation(
                        "et.video_pipeline.dry_run",
                        input={"sample_dir": str(SAMPLE_DRY_RUN_DIR)},
                    ) as dry_observation:
                        await _simulate_job(job_id)
                        _langfuse_update(dry_observation, output={"status": "completed"})
                    final_job = _get_job(job_id)
                    _langfuse_update(
                        root_observation,
                        output={
                            "status": final_job.status.value,
                            "result_path": str(final_job.result_path) if final_job.result_path else None,
                        },
                    )
                    return
                finally:
                    _langfuse_flush()

            seen_ids: set[int] = set()
            seen_status: Dict[int, str] = {}

            try:
                generated_style_name: Optional[str] = None
                if job.image_path:
                    _push(job_id, "Styler planning")
                    generated_style_name = f"{_slugify_style_name(job.selected_style_name)}_{job.id[:8]}"

                    with _langfuse_observation(
                        "et.video_pipeline.style_profile",
                        input={
                            "selected_style_name": job.selected_style_name,
                            "reference_image": str(job.image_path),
                        },
                    ) as style_observation:
                        _langfuse_update(
                            style_observation,
                            output={
                                "generated_style_name": generated_style_name,
                                "style_creation_mode": "storyboard_styler_skill",
                            },
                        )

                    job = _get_job(job_id)
                    job.generated_style_name = generated_style_name
                    _save_job(job)

                query = _build_query(
                    message=job.message,
                    image_path=job.image_path,
                    selected_style_name=job.selected_style_name,
                    generated_style_name=generated_style_name,
                )

                with _langfuse_observation(
                    "et.video_pipeline.agent_run",
                    input={"query": query[:4000]},
                    metadata={"agent_model": "gemini-3-flash-preview"},
                ) as agent_observation:
                    task = asyncio.create_task(asyncio.to_thread(_run_agent, query))

                    heartbeat_every = job.notification_interval_seconds
                    next_heartbeat = asyncio.get_running_loop().time() + heartbeat_every

                    while not task.done():
                        _pump_memory(job_id, seen_ids, seen_status)
                        now = asyncio.get_running_loop().time()
                        if now >= next_heartbeat:
                            _push(job_id, "Pipeline running")
                            next_heartbeat = now + heartbeat_every
                        await asyncio.sleep(REAL_MEMORY_POLL_SECONDS)

                    response_text = await task
                    _langfuse_update(
                        agent_observation,
                        output={"response_preview": response_text[:1500]},
                    )

                _pump_memory(job_id, seen_ids, seen_status)

                final_video = _extract_video_path(response_text) or _resolve_final_video()
                if not final_video:
                    raise FileNotFoundError("Final mp4 not found after pipeline completion")

                _finalize_success(job_id, response_text, final_video)

                completed = _get_job(job_id)
                _langfuse_update(
                    root_observation,
                    output={
                        "status": completed.status.value,
                        "generated_style_name": completed.generated_style_name,
                        "result_path": str(completed.result_path) if completed.result_path else None,
                        "archive_dir": str(completed.archive_dir) if completed.archive_dir else None,
                    },
                )
            except Exception as exc:
                failed = _get_job(job_id)
                failed.status = JobStatus.failed
                failed.error = str(exc)
                _save_job(failed)
                _push(job_id, "Job failed")
                _langfuse_update(
                    root_observation,
                    output={
                        "status": "failed",
                        "error": str(exc),
                        "generated_style_name": failed.generated_style_name,
                    },
                )
            finally:
                _langfuse_flush()


def _save_upload(job_id: str, image: UploadFile) -> Path:
    suffix = Path(image.filename or "reference.jpg").suffix or ".jpg"
    out = UPLOADS_DIR / f"{job_id}{suffix}"
    with out.open("wb") as f:
        shutil.copyfileobj(image.file, f)
    return out.resolve()


def _guess_image_suffix(image_url: str, content_type: str) -> str:
    ext = Path(urlparse(image_url).path).suffix.lower()
    if ext in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return ".jpg" if ext == ".jpeg" else ext

    content_type = content_type.lower().split(";")[0].strip()
    by_type = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    return by_type.get(content_type, ".jpg")


def _save_upload_from_url(job_id: str, image_url: str) -> Path:
    parsed = urlparse(image_url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=422, detail="image_url must be an http/https URL")

    try:
        req = Request(image_url, headers={"User-Agent": "ET-Agent/1.0"})
        with urlopen(req, timeout=20) as resp:
            content_type = resp.headers.get("Content-Type", "")
            data = resp.read()
    except Exception:
        raise HTTPException(status_code=422, detail="Failed to download image_url")

    if not data:
        raise HTTPException(status_code=422, detail="Downloaded image_url is empty")

    suffix = _guess_image_suffix(image_url, content_type)
    out = UPLOADS_DIR / f"{job_id}{suffix}"
    out.write_bytes(data)
    return out.resolve()


@app.post("/start")
async def start_job(
    background_tasks: BackgroundTasks,
    message: str = Form(..., description="Main instruction including style details"),
    style_name: Optional[str] = Form(None, description="Optional selected style name"),
    image: Optional[UploadFile] = File(None, description="Optional reference image"),
    image_url: Optional[str] = Form(None, description="Optional reference image URL"),
    notification_interval_seconds: Optional[float] = Form(None, description="Notification interval in seconds (default 10)"),
):
    with lock:
        active = any(j.status in (JobStatus.queued, JobStatus.running) for j in jobs.values())
    if active:
        raise HTTPException(status_code=409, detail="Another job is already running")

    if notification_interval_seconds is None:
        effective_interval = DEFAULT_NOTIFICATION_INTERVAL_SECONDS
    else:
        if notification_interval_seconds <= 0:
            raise HTTPException(status_code=422, detail="notification_interval_seconds must be > 0")
        effective_interval = float(notification_interval_seconds)

    job_id = str(uuid.uuid4())
    image_path = None
    if image:
        image_path = _save_upload(job_id, image)
    elif image_url:
        image_path = _save_upload_from_url(job_id, image_url)

    job = Job(
        id=job_id,
        status=JobStatus.queued,
        message=message,
        selected_style_name=style_name,
        image_path=image_path,
        notification_interval_seconds=effective_interval,
    )
    _save_job(job)
    _push(job_id, "Job queued")

    background_tasks.add_task(_run_job, job_id)
    return {"job_id": job_id, "status": job.status}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = _get_job(job_id)
    return {
        "id": job.id,
        "status": job.status,
        "message": job.message,
        "selected_style_name": job.selected_style_name,
        "generated_style_name": job.generated_style_name,
        "image_path": str(job.image_path) if job.image_path else None,
        "has_result": job.result_path is not None,
        "result_path": str(job.result_path) if job.result_path else None,
        "archive_dir": str(job.archive_dir) if job.archive_dir else None,
        "notification_interval_seconds": job.notification_interval_seconds,
        "result_endpoint": f"/result/{job.id}" if job.result_path else None,
        "agent_response": job.agent_response,
        "langfuse_trace_id": job.langfuse_trace_id,
        "langfuse_trace_url": job.langfuse_trace_url,
        "error": job.error,
    }


@app.get("/notifications/{job_id}")
async def get_notifications(job_id: str, after: int = 0):
    job = _get_job(job_id)
    updates = [n for n in job.notifications if n.seq > after]
    return {"job_id": job_id, "notifications": updates}


@app.get("/result/{job_id}")
async def get_result(job_id: str):
    job = _get_job(job_id)
    if job.status != JobStatus.completed or not job.result_path:
        raise HTTPException(status_code=409, detail="Result not ready")
    if not job.result_path.exists():
        raise HTTPException(status_code=500, detail="Result file missing")

    return FileResponse(str(job.result_path), media_type="video/mp4", filename=job.result_path.name)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "dry_run": DRY_RUN,
        "clean_after_archive": CLEAN_AFTER_ARCHIVE,
        "default_notification_interval_seconds": DEFAULT_NOTIFICATION_INTERVAL_SECONDS,
        "real_memory_poll_seconds": REAL_MEMORY_POLL_SECONDS,
        "dry_run_sample_dir": str(SAMPLE_DRY_RUN_DIR),
        "langfuse_tracing_enabled": LANGFUSE_TRACING_ENABLED,
        "langfuse_configured": _langfuse_is_configured(),
        "langfuse_base_url": os.getenv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com"),
    }


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("API_HOST", "0.0.0.0")
    port = int(os.getenv("API_PORT", "8000"))
    reload = os.getenv("API_RELOAD", "0") == "1"

    if reload:
        target = "main:app" if Path.cwd().resolve() == Path(__file__).resolve().parent else "api.main:app"
        uvicorn.run(target, host=host, port=port, reload=True)
    else:
        uvicorn.run(app, host=host, port=port, reload=False)

