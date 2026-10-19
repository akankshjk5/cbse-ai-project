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
import os
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

import bench_stages
import gpu_probe
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
    attempts: int = 0
    detail: str = ""
    # Present and true only on a value this process timed itself.
    measured: bool = False
    # In-process allocator figures: a true peak, or unavailable. Never mixed
    # with the device figures below.
    process_memory: dict = field(default_factory=dict)
    # Device-wide sampled figures, with their interval and what they can miss.
    device_memory: dict = field(default_factory=dict)
    extra: dict = field(default_factory=dict)


class BudgetExhausted(RuntimeError):
    """The run hit its time or money limit. Recorded, never hidden."""


class Budget:
    """A wall-clock and money ceiling, checked between stages.

    Checked BETWEEN stages rather than inside them: killing Wan mid-sample
    leaves ComfyUI holding VRAM and a part-written file, and the next stage
    then fails for a reason that has nothing to do with the budget. A stage
    that overruns on its own is bounded by its own timeout.

    The cost here is `estimated`, never `measured`: it is elapsed time times a
    rate the operator supplied, not a figure read from a bill. The codebase
    uses that distinction everywhere and this is no exception.
    """

    def __init__(self, max_minutes: float | None, usd_per_hour: float | None,
                 max_usd: float | None) -> None:
        self.max_minutes = max_minutes
        self.usd_per_hour = usd_per_hour
        self.max_usd = max_usd
        self.started = time.monotonic()
        self.stopped_because: str | None = None

    @property
    def elapsed_seconds(self) -> float:
        return time.monotonic() - self.started

    @property
    def estimated_usd(self) -> float | None:
        if self.usd_per_hour is None:
            return None
        return round(self.elapsed_seconds / 3600.0 * self.usd_per_hour, 4)

    def check(self) -> None:
        """Raise if the next stage must not start."""
        if self.max_minutes is not None and self.elapsed_seconds > self.max_minutes * 60:
            self.stopped_because = (
                f"wall-clock budget of {self.max_minutes:g} min exhausted "
                f"after {self.elapsed_seconds / 60:.1f} min")
            raise BudgetExhausted(self.stopped_because)
        spent = self.estimated_usd
        if self.max_usd is not None and spent is not None and spent > self.max_usd:
            self.stopped_because = (
                f"estimated spend ${spent:.2f} exceeded the ${self.max_usd:.2f} ceiling "
                f"at ${self.usd_per_hour:.2f}/hour")
            raise BudgetExhausted(self.stopped_because)

    def facts(self) -> dict:
        return {
            "elapsed_seconds": round(self.elapsed_seconds, 2),
            "max_minutes": self.max_minutes,
            "usd_per_hour": self.usd_per_hour,
            "max_usd": self.max_usd,
            "estimated_cost_usd": self.estimated_usd,
            # Not from a bill. Time times a rate the operator typed.
            "cost_basis": "estimated" if self.usd_per_hour is not None else "unknown",
            "aborted": self.stopped_because is not None,
            "abort_reason": self.stopped_because,
        }


@dataclass
class Benchmark:
    started_at: str
    host: dict
    gpu: dict
    versions: dict
    weights: dict
    stages: list = field(default_factory=list)
    output: dict = field(default_factory=dict)
    budget: dict = field(default_factory=dict)
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

def timed(stage: str, work, attempts: int = 1,
          interval: float = 0.25) -> StageResult:
    """Run one stage, timing it and watching the GPU while it runs.

    Memory is reported two ways and never combined. The allocator's own peak
    covers work in this process exactly; the sampled device series covers
    everything, including ComfyUI's separate process, but can miss a spike
    shorter than its interval. Neither is a before/after difference, because
    that number would be wrong in a way nobody could see.
    """
    gpu_probe.reset_cuda_peak()
    watcher = gpu_probe.DeviceWatcher(interval)
    started = time.monotonic()
    tries, last_error = 0, ""

    with watcher:
        while tries < attempts:
            tries += 1
            try:
                extra = work() or {}
                elapsed = time.monotonic() - started
                break
            except Exception as error:
                last_error = f"{type(error).__name__}: {error}"
                extra = None
        else:
            elapsed = time.monotonic() - started

    device = watcher.result().summary()
    process = asdict(gpu_probe.read_cuda_memory())
    if extra is None:
        return StageResult(stage=stage, ok=False, attempts=tries, measured=False,
                           seconds=round(elapsed, 3), detail=last_error,
                           process_memory=process, device_memory=device)
    return StageResult(stage=stage, ok=True, seconds=round(elapsed, 3), attempts=tries,
                       measured=True, detail="", process_memory=process,
                       device_memory=device, extra=extra)


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


def assemble_and_validate(ctx: dict, language: str) -> dict:
    """Compose the generated clip and narration into a lesson, then check it.

    Runs the production compositor, so the thing validated is the thing the
    product makes. Every figure returned is read back off the finished file.
    """
    out = ctx["out_dir"] / f"lesson-{language}.mp4"
    manifest = ctx["out_dir"] / "assemble.json"
    scene_clips = []
    for index in range(4):
        scene = ctx["out_dir"] / f"scene-{index + 1}.mp4"
        manifest.write_text(json.dumps({
            "mode": "scene", "ffmpeg": "ffmpeg", "ffprobe": "ffprobe",
            "fontsDir": str(HERE / "fonts"), "language": language,
            "visualStyle": "illustrated",
            "image": str(ctx["keyframe_path"].resolve()),
            "rawClip": str(ctx["clip_path"].resolve()) if index == 0 else None,
            "output": str(scene.resolve()),
            "scene": {"duration_seconds": SLOT,
                      "caption": f"Scene {index + 1}",
                      "title": None,
                      "motion_mode": "animate" if index == 0 else "still",
                      "overlay": {"kind": "none"}},
        }), encoding="utf-8")
        result = subprocess.run([sys.executable, str(HERE / "compositor.py"),
                                 "--manifest", str(manifest)],
                                capture_output=True, text=True, cwd=str(REPO))
        if result.returncode:
            tail = (result.stderr or "").strip().splitlines()
            raise BenchmarkFailed(f"scene {index + 1}: {tail[-1] if tail else 'failed'}")
        scene_clips.append(str(scene.resolve()))

    narration = ctx["out_dir"] / f"narration-{language}.wav"
    manifest.write_text(json.dumps({
        "mode": "assemble", "ffmpeg": "ffmpeg", "ffprobe": "ffprobe",
        "fontsDir": str(HERE / "fonts"), "language": language,
        "visualStyle": "illustrated", "clips": scene_clips,
        "narration": str(narration.resolve()), "output": str(out.resolve()),
        "durationSeconds": 30,
        "scenes": [{"scene_index": i + 1} for i in range(4)],
    }), encoding="utf-8")
    result = subprocess.run([sys.executable, str(HERE / "compositor.py"),
                             "--manifest", str(manifest)],
                            capture_output=True, text=True, cwd=str(REPO))
    if result.returncode:
        tail = (result.stderr or "").strip().splitlines()
        raise BenchmarkFailed(f"assembly: {tail[-1] if tail else 'failed'}")

    facts = video_facts(out)
    facts["path"] = str(out)
    facts["resolution_ok"] = facts["width"] == 1920 and facts["height"] == 1080
    facts["frame_rate_ok"] = facts["frame_rate"] == "24/1"
    return facts


# ── The run ─────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-root", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=HERE / "out" / "benchmark.json")
    parser.add_argument("--language", default="kn-IN",
                        help="Kannada by default: it is the hardest case and the least proven")
    parser.add_argument("--style", default="illustrated")
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--languages", default="en-IN,hi-IN,kn-IN")
    parser.add_argument("--seed", type=int, default=20261019)
    parser.add_argument("--wan-steps", type=int, default=20)
    parser.add_argument("--interval", type=float, default=0.25,
                        help="GPU sampling interval in seconds; recorded in the report")
    parser.add_argument("--max-minutes", type=float, default=45.0,
                        help="abort between stages once this much wall clock has passed "
                             "(default 45; pass 0 for no limit)")
    parser.add_argument("--usd-per-hour", type=float, default=None,
                        help="your instance's hourly rate, to record an ESTIMATED cost. "
                             "Not read from a bill, so the report marks it estimated")
    parser.add_argument("--max-usd", type=float, default=None,
                        help="abort between stages once the estimated spend passes this. "
                             "Needs --usd-per-hour to do anything")
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
    print(f"torch {report.versions.get('torch')} · CUDA {report.versions.get('cuda')}")
    print(f"device sampling: {gpu_probe.DeviceWatcher().method} every {args.interval}s")
    print()

    languages = [l.strip() for l in args.languages.split(",") if l.strip()]
    out_dir = args.out.parent / "artifacts"
    out_dir.mkdir(parents=True, exist_ok=True)
    ctx = {
        "endpoints": {**lm.DEFAULT_ENDPOINTS},
        "workflows": REPO / "ops" / "runpod" / "workflows" / "api",
        "out_dir": out_dir, "languages": languages, "seed": args.seed,
        "wan_steps": args.wan_steps,
        "comfy_input_dir": os.environ.get("COMFYUI_INPUT_DIR"),
        "timeouts": {"plan": 600.0, "keyframe": 900.0, "vision": 180.0,
                     "motion": 1800.0, "tts": 300.0, "translate": 300.0},
    }

    overall_started = time.monotonic()
    # Order matters: the plan feeds the keyframe, the keyframe feeds vision and
    # motion, and the translation feeds the non-English narration.
    budget = Budget(
        max_minutes=args.max_minutes if args.max_minutes and args.max_minutes > 0 else None,
        usd_per_hour=args.usd_per_hour, max_usd=args.max_usd)
    if args.max_usd is not None and args.usd_per_hour is None:
        print("  note: --max-usd needs --usd-per-hour to mean anything; "
              "no money ceiling is in force.\n")

    stage_names = ("plan", "translate", "keyframe", "vision", "motion", "tts")
    for index, stage_name in enumerate(stage_names):
        try:
            budget.check()
        except BudgetExhausted as error:
            # The stages that did not start are recorded as NOT_EXECUTED with
            # the reason, so the report cannot be read as "these stages failed".
            for skipped in stage_names[index:]:
                report.stages.append(asdict(StageResult(
                    stage=skipped, ok=False, measured=False,
                    detail=f"NOT_EXECUTED: {error}")))
            report.failures.append(f"aborted: {error}")
            print(f"\n  ABORTED  {error}")
            print(f"  {len(stage_names) - index} stage(s) did not start and carry no figures.")
            break

        runner = bench_stages.STAGES.get(stage_name)
        if runner is None:
            result = StageResult(stage=stage_name, ok=False, measured=False,
                                 detail="no runner registered")
        else:
            result = timed(stage_name, lambda r=runner: r(ctx),
                           attempts=args.retries, interval=args.interval)
        report.stages.append(asdict(result))
        mark = "ok  " if result.ok else "FAIL"
        secs = f"{result.seconds:.2f}s" if result.seconds is not None else "—"
        seen = result.device_memory.get("max_observed_used_mib")
        vram = f"{seen} MiB seen" if seen is not None else "vram n/a"
        print(f"  {mark} {stage_name:10s} {secs:>9s}  {vram:>16s}  {result.detail[:46]}")

    report.budget = budget.facts()
    report.output["end_to_end_seconds"] = round(time.monotonic() - overall_started, 3)
    report.output["artifacts"] = str(out_dir)
    report.output["languages"] = languages

    # A lesson video is assembled only when every input really exists. A
    # partial run is NOT_EXECUTED, never a result with gaps.
    if ctx.get("clip_path") and ctx.get("narration"):
        try:
            report.output["video"] = assemble_and_validate(ctx, languages[0])
        except Exception as error:
            report.failures.append(f"assembly: {type(error).__name__}: {error}")
            report.output["video"] = {"status": "FAILED", "reason": str(error)[:300]}
    else:
        report.output["video"] = {
            "status": "NOT_EXECUTED",
            "reason": "motion or narration did not run, so no lesson video was assembled",
        }

    report.complete = (all(s["ok"] for s in report.stages)
                       and report.output["video"].get("full_decode_clean") is True)
    if not report.complete:
        report.failures.extend(
            f"{s['stage']}: {s['detail']}" for s in report.stages if not s["ok"])


    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(asdict(report), indent=2), encoding="utf-8")
    print(f"\n{'COMPLETE' if report.complete else 'INCOMPLETE'} — wrote {args.out}")
    if not report.complete:
        print("Stages that did not run carry no figures. Do not quote this as a result.")
    return 0 if report.complete else 1






if __name__ == "__main__":
    raise SystemExit(main())
