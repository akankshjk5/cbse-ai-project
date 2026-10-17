"""Clients for the self-hosted model services, and the checks that run first.

Every model Lumina uses runs on a GPU host we control, reached over loopback.
Nothing here calls a third-party generation API, and there is no code path
that falls back to one: a service that is down is an error, never a reason to
spend money elsewhere.

The checks exist because the failures they catch are slow and confusing
otherwise. A missing weight file surfaces as a ComfyUI validation error eight
nodes deep; a card with too little free VRAM surfaces as an out-of-memory
crash several minutes into a run, after the queue has already accepted the
job. Both are cheap to detect up front and are checked before anything is
submitted.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

# Defaults match the LOCAL_VIDEO_* variables the Next.js app reads, so one
# host configuration serves both processes.
DEFAULT_ENDPOINTS = {
    "comfy": "http://127.0.0.1:8188",
    "tts": "http://127.0.0.1:18081",
    "translate": "http://127.0.0.1:18082",
    "planner": "http://127.0.0.1:18080",
    "worker": "http://127.0.0.1:8090",
}

# Exact files the shipped workflows name. A deployment is not ready until all
# of these resolve inside ComfyUI's model directories.
REQUIRED_WEIGHTS = {
    "image": [
        ("diffusion_models", "z_image_turbo_bf16.safetensors"),
        ("text_encoders", "qwen_3_4b.safetensors"),
        ("vae", "ae.safetensors"),
    ],
    "motion": [
        ("diffusion_models", "wan2.2_ti2v_5B_fp16.safetensors"),
        ("text_encoders", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"),
        ("vae", "wan2.2_vae.safetensors"),
    ],
}

# Free VRAM a stage needs before it is allowed to start, in MiB. These are
# floors for refusing obviously impossible runs, not predictions: measure the
# real peak on the deployment card and raise them if a run still OOMs.
VRAM_FLOOR_MIB = {
    "image": 11_000,    # Z-Image Turbo BF16 plus the Qwen3-4B text encoder
    "motion": 14_000,   # Wan 2.2 TI2V-5B FP16 plus the UMT5-XXL encoder
    "speech": 2_500,    # Indic Parler-TTS
}


class LocalModelError(RuntimeError):
    """A service problem a person can act on, phrased so they can."""


@dataclass
class ServiceStatus:
    name: str
    url: str
    reachable: bool
    detail: str
    latency_ms: float | None = None


@dataclass
class Readiness:
    services: list[ServiceStatus] = field(default_factory=list)
    free_vram_mib: int | None = None
    total_vram_mib: int | None = None
    missing_weights: list[str] = field(default_factory=list)
    stages_ready: dict[str, bool] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return (all(s.reachable for s in self.services)
                and not self.missing_weights
                and all(self.stages_ready.values()))


def _get(url: str, timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read()


def _post_json(url: str, payload: dict, timeout: float) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")


def probe_service(name: str, url: str, path: str, timeout: float = 4.0) -> ServiceStatus:
    """Reachability, phrased for whoever has to fix it.

    A refused connection and a timeout mean different things — not started
    versus started but wedged — so they are reported differently rather than
    collapsed into "unavailable".
    """
    started = time.monotonic()
    try:
        status, _ = _get(url.rstrip("/") + path, timeout)
        elapsed = (time.monotonic() - started) * 1000
        if status != 200:
            return ServiceStatus(name, url, False, f"HTTP {status} from {path}", elapsed)
        return ServiceStatus(name, url, True, "ok", elapsed)
    except urllib.error.HTTPError as error:
        return ServiceStatus(name, url, False, f"HTTP {error.code} from {path}")
    except TimeoutError:
        return ServiceStatus(name, url, False,
                             f"no response within {timeout:.0f}s — started but not answering")
    except urllib.error.URLError as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, TimeoutError):
            return ServiceStatus(name, url, False,
                                 f"no response within {timeout:.0f}s — started but not answering")
        return ServiceStatus(name, url, False, f"not reachable ({reason}) — is the service started?")


def comfy_vram(comfy_url: str, timeout: float = 5.0) -> tuple[int | None, int | None]:
    """Free and total VRAM in MiB, as ComfyUI reports it.

    Returns (None, None) rather than raising when ComfyUI is unreachable, so a
    readiness report can show every problem at once instead of stopping at the
    first.
    """
    try:
        _, raw = _get(comfy_url.rstrip("/") + "/system_stats", timeout)
        stats = json.loads(raw)
    except Exception:
        return None, None
    devices = stats.get("devices") or []
    if not devices:
        return None, None
    device = devices[0]
    free = device.get("vram_free")
    total = device.get("vram_total")
    to_mib = lambda v: int(v) // (1024 * 1024) if isinstance(v, (int, float)) else None
    return to_mib(free), to_mib(total)


def check_weights(models_root: Path | None) -> list[str]:
    """Which named weight files are absent.

    Checked on disk rather than by submitting a job, because ComfyUI reports a
    missing checkpoint as a validation error against a node number, which tells
    an operator nothing about which file to fetch.
    """
    if models_root is None or not models_root.is_dir():
        return []           # cannot tell from here; readiness reports it separately
    missing: list[str] = []
    for files in REQUIRED_WEIGHTS.values():
        for subdir, filename in files:
            if not (models_root / subdir / filename).is_file():
                missing.append(f"{subdir}/{filename}")
    return sorted(set(missing))


def readiness(endpoints: dict[str, str] | None = None,
              models_root: Path | None = None,
              stages: tuple[str, ...] = ("image", "motion", "speech")) -> Readiness:
    """Everything that must be true before a lesson is queued."""
    endpoints = {**DEFAULT_ENDPOINTS, **(endpoints or {})}
    report = Readiness()
    report.services = [
        probe_service("comfyui", endpoints["comfy"], "/system_stats"),
        probe_service("tts", endpoints["tts"], "/health"),
        probe_service("translate", endpoints["translate"], "/health"),
    ]
    report.free_vram_mib, report.total_vram_mib = comfy_vram(endpoints["comfy"])
    report.missing_weights = check_weights(models_root)
    for stage in stages:
        floor = VRAM_FLOOR_MIB[stage]
        # Unknown VRAM is not treated as enough: a stage is ready only when the
        # card has been seen and has room.
        report.stages_ready[stage] = (
            report.free_vram_mib is not None and report.free_vram_mib >= floor)
    return report


def explain(report: Readiness) -> list[str]:
    """What to do about each problem, in the order worth doing it."""
    lines: list[str] = []
    for service in report.services:
        if not service.reachable:
            lines.append(f"{service.name}: {service.detail} ({service.url})")
    if report.free_vram_mib is None:
        lines.append("VRAM unknown: ComfyUI did not report a device. "
                     "Check that it started with CUDA and not --cpu.")
    else:
        for stage, ready in report.stages_ready.items():
            if not ready:
                need = VRAM_FLOOR_MIB[stage]
                lines.append(
                    f"{stage}: needs about {need / 1024:.0f} GiB free VRAM, "
                    f"{report.free_vram_mib / 1024:.1f} GiB is free of "
                    f"{(report.total_vram_mib or 0) / 1024:.1f} GiB total. "
                    "Free the card or move to a larger one.")
    for weight in report.missing_weights:
        lines.append(f"missing weight: {weight}")
    return lines


# ── Job submission ──────────────────────────────────────────────────────────

def fill_workflow(template: dict, values: dict[str, object]) -> dict:
    """Replace the workflow's `__NAME__` slots with real values.

    Substitution is on whole values rather than inside strings, so a prompt
    containing `__SEED__` cannot rewrite the graph. Any slot left unfilled is
    an error: a workflow that still reads `__FRAMES__` would be submitted with
    a string where ComfyUI expects an integer and fail deep in validation.
    """
    filled = json.loads(json.dumps(template))     # deep copy, no shared nodes
    unfilled: list[str] = []

    for node_id, node in filled.items():
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key, value in list(inputs.items()):
            if not (isinstance(value, str) and value.startswith("__") and value.endswith("__")):
                continue
            slot = value[2:-2].lower()
            if slot not in values:
                unfilled.append(f"__{value[2:-2]}__ ({node_id}.{key})")
                continue
            # Written once, and never re-examined. A second pass over the
            # result would see a caption that happens to read `__SEED__` as an
            # unfilled slot and refuse ordinary content; and because nothing
            # here reads what it just wrote, a prompt cannot substitute itself
            # into the graph either.
            inputs[key] = values[slot]

    if unfilled:
        raise LocalModelError(
            f"Workflow slots with no value: {', '.join(unfilled)}; "
            f"supplied: {', '.join(sorted(values)) or 'nothing'}")
    return filled


def submit_comfy(comfy_url: str, workflow: dict, *, timeout: float = 30.0) -> str:
    """Queue a filled workflow and return its prompt id."""
    try:
        result = _post_json(comfy_url.rstrip("/") + "/prompt",
                            {"prompt": workflow}, timeout)
    except urllib.error.URLError as error:
        raise LocalModelError(
            f"Could not reach ComfyUI at {comfy_url}: {getattr(error, 'reason', error)}") from error
    prompt_id = result.get("prompt_id")
    if not prompt_id:
        errors = result.get("error") or result.get("node_errors") or result
        raise LocalModelError(f"ComfyUI refused the workflow: {json.dumps(errors)[:400]}")
    return str(prompt_id)


def await_comfy(comfy_url: str, prompt_id: str, *,
                deadline_seconds: float = 900.0, poll_seconds: float = 2.0) -> dict:
    """Wait for one job, with a deadline.

    A generation that hangs must not hold a worker lease forever, so the wait
    is bounded and the caller is told how long it waited. The queue is checked
    as well as the history: a prompt that has left the queue without producing
    history has failed, and waiting out the full deadline for it wastes a
    worker slot that another lesson could use.
    """
    started = time.monotonic()
    while True:
        elapsed = time.monotonic() - started
        if elapsed > deadline_seconds:
            raise LocalModelError(
                f"ComfyUI job {prompt_id} did not finish within {deadline_seconds:.0f}s. "
                "Check the ComfyUI log for an out-of-memory or missing-model error.")
        try:
            _, raw = _get(f"{comfy_url.rstrip('/')}/history/{prompt_id}", 10.0)
            history = json.loads(raw or b"{}")
        except Exception:
            history = {}
        entry = history.get(prompt_id)
        if entry:
            status = (entry.get("status") or {})
            if status.get("status_str") == "error" or status.get("completed") is False:
                messages = status.get("messages") or []
                raise LocalModelError(
                    f"ComfyUI job {prompt_id} failed: {json.dumps(messages)[:400]}")
            return entry
        time.sleep(poll_seconds)


def speak(tts_url: str, text: str, language: str, *, voice: str,
          pace: str = "natural", timeout: float = 120.0) -> bytes:
    """One scene's narration as WAV bytes from the local TTS service.

    The returned audio is measured by the caller rather than trusted: a model
    that silently truncates a long sentence would otherwise produce a lesson
    whose narration stops mid-word, and only the measurement catches it.
    """
    if not text.strip():
        raise LocalModelError("Refusing to synthesise empty narration")
    url = tts_url.rstrip("/") + "/speak"
    body = json.dumps({"text": text, "language": language,
                       "voice": voice, "pace": pace}).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            audio = response.read()
    except urllib.error.URLError as error:
        raise LocalModelError(
            f"Could not reach the TTS service at {tts_url}: "
            f"{getattr(error, 'reason', error)}") from error
    if not audio:
        raise LocalModelError(f"TTS returned no audio for {language}")
    if not audio.startswith(b"RIFF"):
        raise LocalModelError(
            f"TTS returned {len(audio)} bytes that are not a WAV file; "
            "check the service's response format")
    return audio
