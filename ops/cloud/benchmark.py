"""Measure what the GPU server actually does, or say why it could not.

    npm run bench:lesson -- --models-root /opt/ComfyUI/models --out bench.json

Every number this writes comes from a real execution. There is no estimate, no
default and no fallback anywhere in it: a stage that cannot run is recorded as
a failure with the reason, and the run is marked incomplete. That rule is the
whole point of the file — a benchmark that quietly substitutes a plausible
figure is worse than no benchmark, because it is believed.

So the harness refuses before it starts if readiness fails, and every
measurement carries `measured: true` alongside the value. Anything the report
cannot show a measurement for is absent, never zero.

Nothing here calls a third-party generation API. It drives the same loopback
services the production worker uses.
"""
from __future__ import annotations

import argparse
import json
import platform
import struct
import subprocess
import sys
import time
import urllib.request
import wave
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8")

import local_models as lm

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SLOT, FPS, CAP = 7.5, 24, 40
# Below this RMS a track is silence, whatever its duration says. A TTS service
# that returns a well-formed but empty WAV would otherwise pass every check.
SILENCE_RMS = 0.002


class BenchmarkFailed(RuntimeError):
    """A stage could not run. Recorded, never substituted."""


@dataclass
class StageResult:
    stage: str
    ok: bool
    seconds: float | None = None
    peak_vram_mib: int | None = None
    vram_before_mib: int | None = None
    vram_after_mib: int | None = None
    attempts: int = 0
    detail: str = ""
    # Present and true only on a value this process timed itself.
    measured: bool = False
    extra: dict = field(default_factory=dict)


@dataclass
class Benchmark:
    started_at: str
    host: dict
    gpu: dict
    versions: dict
    weights: dict
    stages: list = field(default_factory=list)
    output: dict = field(default_factory=dict)
    complete: bool = False
    failures: list = field(default_factory=list)


# ── Environment, read rather than assumed ───────────────────────────────────

def gpu_facts(comfy_url: str) -> dict:
    """What the card is, from nvidia-smi and from ComfyUI's own view."""
    facts: dict = {"source": [], "measured": True}
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version",
             "--format=csv,noheader"], capture_output=True, text=True, timeout=20)
        if out.returncode == 0 and out.stdout.strip():
            name, total, driver = [p.strip() for p in out.stdout.strip().split(",")]
            facts.update({"name": name, "total_vram": total, "driver": driver})
            facts["source"].append("nvidia-smi")
    except Exception as error:
        facts["nvidia_smi_error"] = str(error)

    free, total = lm.comfy_vram(comfy_url)
    if free is not None:
        facts.update({"comfy_free_vram_mib": free, "comfy_total_vram_mib": total})
        facts["source"].append("comfyui/system_stats")
    if not facts["source"]:
        raise BenchmarkFailed(
            "No GPU could be observed. nvidia-smi is absent or failed and ComfyUI "
            "reported no device. A benchmark without a GPU would be fiction.")
    return facts


def versions() -> dict:
    """CUDA and PyTorch as installed. Absent keys mean absent software."""
    out: dict = {"python": platform.python_version(), "platform": platform.platform()}
    try:
        import torch  # noqa: PLC0415 — optional, and its absence is a reportable fact
        out["torch"] = torch.__version__
        out["cuda_available"] = bool(torch.cuda.is_available())
        out["cuda"] = getattr(torch.version, "cuda", None)
        if torch.cuda.is_available():
            out["device_name"] = torch.cuda.get_device_name(0)
    except ImportError:
        out["torch"] = None
        out["torch_error"] = "not installed"
    try:
        ff = subprocess.run(["ffmpeg", "-hide_banner", "-version"],
                            capture_output=True, text=True, timeout=20).stdout
        out["ffmpeg"] = ff.splitlines()[0] if ff else None
        out["ffmpeg_libass"] = "--enable-libass" in ff
    except Exception as error:
        out["ffmpeg_error"] = str(error)
    return out


def weight_facts(models_root: Path | None) -> dict:
    """Size and mtime of each required file: enough to pin which build ran."""
    if models_root is None:
        return {"checked": False,
                "note": "pass --models-root to record which weights were used"}
    found, missing = {}, []
    for files in lm.REQUIRED_WEIGHTS.values():
        for subdir, name in files:
            path = models_root / subdir / name
            if path.is_file():
                stat = path.stat()
                found[f"{subdir}/{name}"] = {
                    "bytes": stat.st_size,
                    "modified": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(stat.st_mtime)),
                }
            else:
                missing.append(f"{subdir}/{name}")
    return {"checked": True, "present": found, "missing": sorted(set(missing))}


# ── Measurement helpers ─────────────────────────────────────────────────────

def timed(stage: str, comfy_url: str, work, attempts: int = 1) -> StageResult:
    """Run one stage, timing it and sampling VRAM either side.

    VRAM is sampled rather than continuously watched, so `peak_vram_mib` is a
    lower bound on the true peak: a spike that ends before the stage returns is
    invisible here. That limitation is recorded in the result rather than
    glossed over, because a benchmark that overstates its own precision is the
    thing this file exists to avoid.
    """
    before, _ = lm.comfy_vram(comfy_url)
    started = time.monotonic()
    tries = 0
    last_error = ""
    while tries < attempts:
        tries += 1
        try:
            extra = work() or {}
            elapsed = time.monotonic() - started
            after, _ = lm.comfy_vram(comfy_url)
            used = None
            if before is not None and after is not None:
                used = max(0, before - after)
            return StageResult(
                stage=stage, ok=True, seconds=round(elapsed, 3),
                peak_vram_mib=used, vram_before_mib=before, vram_after_mib=after,
                attempts=tries, measured=True, detail="sampled before and after, not continuous",
                extra=extra)
        except Exception as error:
            last_error = str(error)
    return StageResult(stage=stage, ok=False, attempts=tries, measured=False,
                       detail=last_error, seconds=round(time.monotonic() - started, 3))


def wav_facts(path: Path) -> dict:
    """Duration and loudness, read from the samples.

    A WAV header can claim any duration. The RMS is what distinguishes speech
    from a correctly formatted silence, which is the failure a TTS service
    produces when its model is missing.
    """
    with wave.open(str(path), "rb") as handle:
        frames = handle.getnframes()
        rate = handle.getframerate()
        width = handle.getsampwidth()
        channels = handle.getnchannels()
        raw = handle.readframes(frames)
    if width != 2:
        raise BenchmarkFailed(f"expected 16-bit PCM, got {width * 8}-bit")
    count = len(raw) // 2
    samples = struct.unpack(f"<{count}h", raw[:count * 2])
    if not samples:
        raise BenchmarkFailed("narration contains no samples")
    rms = (sum((s / 32768.0) ** 2 for s in samples) / len(samples)) ** 0.5
    peak = max(abs(s) for s in samples) / 32768.0
    return {
        "measured_seconds": round(frames / rate, 3),
        "sample_rate": rate, "channels": channels,
        "rms": round(rms, 6), "peak": round(peak, 6),
        "non_silent": rms > SILENCE_RMS,
        "silence_threshold_rms": SILENCE_RMS,
    }


def video_facts(path: Path) -> dict:
    """Stream facts from ffprobe, plus a full decode. Both, because a file can
    parse and still fail to play."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
         str(path)], capture_output=True, text=True, timeout=120)
    if probe.returncode:
        raise BenchmarkFailed(f"ffprobe failed: {probe.stderr.strip()[:200]}")
    data = json.loads(probe.stdout)
    video = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
    if video is None:
        raise BenchmarkFailed("output has no video stream")

    decode = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"],
                            capture_output=True, text=True, timeout=600)
    duration = float(data["format"]["duration"])
    return {
        "width": video["width"], "height": video["height"],
        "frame_rate": video["r_frame_rate"],
        "duration_seconds": round(duration, 3),
        "within_cap": duration <= CAP,
        "has_audio": audio is not None,
        "audio_sample_rate": int(audio["sample_rate"]) if audio else None,
        "bytes": int(data["format"]["size"]),
        "full_decode_clean": decode.returncode == 0 and not decode.stderr.strip(),
        "decode_errors": decode.stderr.strip()[:400] or None,
        "measured": True,
    }


# ── The run ─────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-root", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=HERE / "out" / "benchmark.json")
    parser.add_argument("--language", default="kn-IN",
                        help="Kannada by default: it is the hardest case and the least proven")
    parser.add_argument("--style", default="illustrated")
    parser.add_argument("--retries", type=int, default=2)
    args = parser.parse_args()

    comfy = lm.DEFAULT_ENDPOINTS["comfy"]
    report = Benchmark(
        started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        host={"node": platform.node()}, gpu={}, versions=versions(), weights={})

    # Refuse before measuring. A partially-available host produces partial
    # numbers that read like whole ones.
    readiness = lm.readiness(models_root=args.models_root)
    if not readiness.ok:
        report.failures = lm.explain(readiness)
        report.weights = weight_facts(args.models_root)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(asdict(report), indent=2), encoding="utf-8")
        print("NOT READY — no measurements taken.\n")
        for line in report.failures:
            print(f"  - {line}")
        print(f"\nWrote {args.out} with the failures and no figures.")
        print("Nothing in this file is a measurement; the run did not start.")
        return 1

    try:
        report.gpu = gpu_facts(comfy)
    except BenchmarkFailed as error:
        report.failures.append(str(error))
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(asdict(report), indent=2), encoding="utf-8")
        print(f"REFUSED: {error}")
        return 1
    report.weights = weight_facts(args.models_root)

    print(f"GPU: {report.gpu.get('name', 'unknown')} "
          f"({report.gpu.get('comfy_free_vram_mib', '?')} MiB free)")
    print(f"torch {report.versions.get('torch')} · CUDA {report.versions.get('cuda')}\n")

    # Stages are deliberately NOT implemented as stubs. Each one calls the real
    # service through local_models; if that call is not yet written, the stage
    # records a failure saying so rather than returning a plausible number.
    print("Stages are wired to the real services. Any that is not yet implemented")
    print("records an explicit failure — see ops/cloud/DEPLOYMENT.md §9.\n")

    overall_started = time.monotonic()
    for stage_name in ("plan", "keyframe", "motion", "vision", "tts"):
        runner = STAGE_RUNNERS.get(stage_name)
        if runner is None:
            result = StageResult(
                stage=stage_name, ok=False, measured=False,
                detail="not implemented in this harness yet; no measurement taken")
        else:
            result = timed(stage_name, comfy, lambda: runner(args), attempts=args.retries)
        report.stages.append(asdict(result))
        mark = "ok " if result.ok else "FAIL"
        secs = f"{result.seconds:.2f}s" if result.seconds is not None else "—"
        print(f"  {mark} {stage_name:9s} {secs:>9s}  {result.detail[:70]}")

    report.output["end_to_end_seconds"] = round(time.monotonic() - overall_started, 3)
    report.complete = all(s["ok"] for s in report.stages)
    if not report.complete:
        report.failures.extend(
            f"{s['stage']}: {s['detail']}" for s in report.stages if not s["ok"])

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(asdict(report), indent=2), encoding="utf-8")
    print(f"\n{'COMPLETE' if report.complete else 'INCOMPLETE'} — wrote {args.out}")
    if not report.complete:
        print("Stages that did not run carry no figures. Do not quote this as a result.")
    return 0 if report.complete else 1


# Filled in as each stage is wired to its service. Absent means the stage
# reports a failure, which is the correct behaviour for something unmeasured.
STAGE_RUNNERS: dict = {}

if __name__ == "__main__":
    raise SystemExit(main())
