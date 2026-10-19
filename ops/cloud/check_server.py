"""Is this host ready to generate? Reports every problem at once.

    python ops/cloud/check_server.py [--models-root PATH] [--json]

Exits non-zero when anything would block a run, so it can gate a deployment
step. Stopping at the first failure would mean an operator fixes one thing,
re-runs, and finds the next — so every check runs and everything is reported
together.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8")

import captions
import local_models as lm

FONTS = ["Kalam-Bold.ttf", "NotoSansDevanagari.ttf",
         "NotoSansKannada.ttf", "DejaVuSans-Bold.ttf"]

#: What each service imports beyond the standard library, read from the four
#: sources in ops/runpod/. torch is checked separately because it is installed
#: from the CUDA index and its absence has a different remedy.
SERVICE_DEPS = {
    "local_planner_service.py": ["transformers"],
    "local_vision_service.py": ["transformers", "PIL"],
    "local_tts_service.py": ["transformers", "parler_tts", "scipy", "numpy"],
    "local_translation_service.py": ["transformers", "IndicTransToolkit"],
}

#: Working space on top of the weights: ComfyUI output, a lesson's frames and
#: clips, and the venv. Not the 150 GB a fresh provision needs -- this runs on
#: a host where the weights may already be in place.
DISK_FLOOR_GIB = 40.0


def disk_facts(path: Path) -> dict:
    """Free space where the weights and outputs live."""
    target = path
    while not target.exists() and target != target.parent:
        target = target.parent
    try:
        usage = shutil.disk_usage(target)
    except OSError as error:
        return {"checked": False, "error": str(error), "path": str(target)}
    free_gib = usage.free / 1024 ** 3
    return {
        "checked": True, "path": str(target),
        "free_gib": round(free_gib, 1),
        "total_gib": round(usage.total / 1024 ** 3, 1),
        "floor_gib": DISK_FLOOR_GIB,
        "ok": free_gib >= DISK_FLOOR_GIB,
    }


def torch_facts() -> dict:
    """Whether the SERVICES will see the GPU, which ComfyUI's stats cannot say.

    Imported in this process, which is the same kind of process each service
    runs in. A box where this reports cuda_available false will start every
    service and fail every request.
    """
    out: dict = {"installed": False, "cuda_available": False}
    try:
        import torch  # noqa: PLC0415 — optional; its absence is the finding
    except ImportError as error:
        out["error"] = f"torch is not installed ({error})"
        return out
    out["installed"] = True
    out["version"] = torch.__version__
    out["cuda_build"] = getattr(torch.version, "cuda", None)
    try:
        out["cuda_available"] = bool(torch.cuda.is_available())
        if out["cuda_available"]:
            out["device_name"] = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            out["device_total_mib"] = int(props.total_memory / 1024 ** 2)
    except Exception as error:  # a driver mismatch raises rather than returning False
        out["error"] = f"torch is installed but cannot use CUDA: {error}"
    return out


def dependency_facts() -> dict:
    """Which service dependencies are importable, per service.

    `find_spec` rather than importing: loading transformers costs seconds and
    several hundred MB, and all preflight needs to know is whether it is there.
    """
    seen: dict[str, bool] = {}
    per_service: dict[str, list[str]] = {}
    for service, modules in SERVICE_DEPS.items():
        missing = []
        for module in modules:
            if module not in seen:
                try:
                    seen[module] = importlib.util.find_spec(module) is not None
                except (ImportError, ValueError):
                    seen[module] = False
            if not seen[module]:
                missing.append(module)
        if missing:
            per_service[service] = missing
    return {"modules": seen, "missing_by_service": per_service,
            "ok": not per_service}


def ffmpeg_shaping(ffmpeg: str) -> tuple[bool, str]:
    """libass with HarfBuzz and FriBidi, or Kannada cannot be rendered at all."""
    try:
        out = subprocess.run([ffmpeg, "-hide_banner", "-version"],
                             capture_output=True, text=True, timeout=20).stdout
    except Exception as error:
        return False, f"could not run {ffmpeg}: {error}"
    needed = ["--enable-libass", "--enable-libharfbuzz", "--enable-libfribidi"]
    missing = [flag for flag in needed if flag not in out]
    if missing:
        return False, ("built without " + ", ".join(missing)
                       + " — Kannada captions would render with broken conjuncts")
    return True, "libass + HarfBuzz + FriBidi present"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-root", type=Path, default=None,
                        help="ComfyUI models/ directory, to check weight files")
    parser.add_argument("--fonts-dir", type=Path,
                        default=Path(__file__).resolve().parent / "fonts")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    ffmpeg = os.environ.get("CLOUD_LESSON_FFMPEG", "ffmpeg")
    endpoints = {
        "comfy": os.environ.get("LOCAL_VIDEO_COMFY_URL", lm.DEFAULT_ENDPOINTS["comfy"]),
        "tts": os.environ.get("LOCAL_VIDEO_TTS_URL", lm.DEFAULT_ENDPOINTS["tts"]),
        "translate": os.environ.get("LOCAL_VIDEO_TRANSLATION_URL", lm.DEFAULT_ENDPOINTS["translate"]),
    }

    report = lm.readiness(endpoints, args.models_root)
    shaping_ok, shaping_detail = ffmpeg_shaping(ffmpeg)
    missing_fonts = [f for f in FONTS if not (args.fonts_dir / f).is_file()]
    disk = disk_facts(args.models_root or Path.cwd())
    torch_state = torch_facts()
    deps = dependency_facts()

    glyphs: dict[str, bool] = {}
    if shaping_ok and not missing_fonts:
        glyphs = captions.probe_shaping({"ffmpeg": ffmpeg, "fontsDir": str(args.fonts_dir)})

    blocking = (not report.ok) or (not shaping_ok) or bool(missing_fonts) \
        or (bool(glyphs) and not all(glyphs.values())) \
        or (disk.get("checked") and not disk.get("ok")) \
        or (not torch_state.get("cuda_available")) \
        or (not deps.get("ok"))

    if args.json:
        print(json.dumps({
            "ready": not blocking,
            "services": [vars(s) for s in report.services],
            "freeVramMib": report.free_vram_mib,
            "totalVramMib": report.total_vram_mib,
            "stagesReady": report.stages_ready,
            "missingWeights": report.missing_weights,
            "missingFonts": missing_fonts,
            "captionShaping": glyphs,
            "ffmpeg": shaping_detail,
            "disk": disk,
            "torch": torch_state,
            "serviceDependencies": deps,
        }, indent=2))
        return 1 if blocking else 0

    print("Lumina server readiness\n" + "=" * 23)

    print("\nServices")
    for service in report.services:
        mark = "ok  " if service.reachable else "DOWN"
        latency = f"  {service.latency_ms:.0f}ms" if service.latency_ms else ""
        print(f"  {mark} {service.name:10s} {service.url}{latency}")
        if not service.reachable:
            print(f"       {service.detail}")

    print("\nGPU")
    if report.free_vram_mib is None:
        print("  UNKNOWN  ComfyUI reported no device — started with --cpu, or not reachable")
    else:
        print(f"  {report.free_vram_mib / 1024:.1f} GiB free of "
              f"{(report.total_vram_mib or 0) / 1024:.1f} GiB")
    for stage, ready in report.stages_ready.items():
        floor = lm.VRAM_FLOOR_MIB[stage]
        print(f"  {'ok  ' if ready else 'NO  '} {stage:7s} needs {floor / 1024:.1f} GiB")

    print("\nWeights")
    if args.models_root is None:
        print("  skipped — pass --models-root to check (ComfyUI's models/ directory)")
    elif report.missing_weights:
        for weight in report.missing_weights:
            print(f"  MISSING  {weight}")
    else:
        print("  ok   all six files present")

    print("\nDisk")
    if not disk.get("checked"):
        print(f"  UNKNOWN  {disk.get('error')}")
    else:
        mark = "ok  " if disk["ok"] else "LOW "
        print(f"  {mark} {disk['free_gib']:.1f} GiB free of {disk['total_gib']:.1f} "
              f"at {disk['path']} (need {disk['floor_gib']:.0f} GiB of working space)")
        if not disk["ok"]:
            print("       The weights are ~71 GiB and a part-written safetensors "
                  "file reads as corrupt, not absent.")

    print("\nPyTorch and CUDA (as the services will see it)")
    if not torch_state["installed"]:
        print(f"  NO   {torch_state.get('error')}")
        print("       pip install torch --index-url https://download.pytorch.org/whl/cu124")
    elif not torch_state["cuda_available"]:
        print(f"  NO   torch {torch_state.get('version')} "
              f"(cuda build {torch_state.get('cuda_build')}) cannot use the GPU")
        if torch_state.get("error"):
            print(f"       {torch_state['error']}")
        print("       Usually a driver older than the wheel's CUDA build.")
    else:
        print(f"  ok   torch {torch_state['version']} on {torch_state.get('device_name')} "
              f"({torch_state.get('device_total_mib', 0) / 1024:.0f} GiB), "
              f"cuda {torch_state.get('cuda_build')}")

    print("\nService dependencies")
    if deps["ok"]:
        print(f"  ok   all {len(deps['modules'])} importable")
    else:
        for service, missing in sorted(deps["missing_by_service"].items()):
            print(f"  NO   {service}: {', '.join(missing)}")
        print("       See RUNBOOK-48GB.md step 2; every service dies at import "
              "without these.")

    print("\nCaptions")
    print(f"  {'ok  ' if shaping_ok else 'NO  '} ffmpeg: {shaping_detail}")
    if missing_fonts:
        for font in missing_fonts:
            print(f"  MISSING  fonts/{font}")
    elif glyphs:
        for language, ok in sorted(glyphs.items()):
            print(f"  {'ok  ' if ok else 'NO  '} {language} renders glyphs")
    else:
        print("  skipped — fix ffmpeg or fonts first")

    problems = lm.explain(report)
    # Everything blocking, in one list. An operator who fixed only what the
    # sections above happened to print would re-run and find the rest, which is
    # exactly what this file exists to avoid.
    if not deps["ok"]:
        for service, missing in sorted(deps["missing_by_service"].items()):
            problems.append(
                f"{service} cannot import {', '.join(missing)} — "
                f"pip install them (RUNBOOK-48GB.md step 2)")
    if not torch_state.get("installed"):
        problems.append(
            "torch is not installed — pip install torch "
            "--index-url https://download.pytorch.org/whl/cu124")
    elif not torch_state.get("cuda_available"):
        problems.append(
            f"torch {torch_state.get('version')} is installed but cannot use CUDA"
            + (f" ({torch_state['error']})" if torch_state.get("error") else "")
            + " — usually a driver older than the wheel's CUDA build")
    if disk.get("checked") and not disk.get("ok"):
        problems.append(
            f"only {disk['free_gib']:.1f} GiB free at {disk['path']}; "
            f"{disk['floor_gib']:.0f} GiB of working space is needed "
            f"on top of ~71 GiB of weights")

    if problems or missing_fonts or not shaping_ok:
        print("\nWhat to fix")
        for line in problems:
            print(f"  - {line}")
        if not shaping_ok:
            print(f"  - ffmpeg: {shaping_detail}")
        for font in missing_fonts:
            print(f"  - missing font ops/cloud/fonts/{font} (see DEPLOYMENT.md §5)")

    print("\n" + ("READY" if not blocking else "NOT READY — see DEPLOYMENT.md"))
    return 1 if blocking else 0


if __name__ == "__main__":
    raise SystemExit(main())
