"""Is this host ready to generate? Reports every problem at once.

    python ops/cloud/check_server.py [--models-root PATH] [--json]

Exits non-zero when anything would block a run, so it can gate a deployment
step. Stopping at the first failure would mean an operator fixes one thing,
re-runs, and finds the next — so every check runs and everything is reported
together.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8")

import captions
import local_models as lm

FONTS = ["Kalam-Bold.ttf", "NotoSansDevanagari.ttf",
         "NotoSansKannada.ttf", "DejaVuSans-Bold.ttf"]


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

    glyphs: dict[str, bool] = {}
    if shaping_ok and not missing_fonts:
        glyphs = captions.probe_shaping({"ffmpeg": ffmpeg, "fontsDir": str(args.fonts_dir)})

    blocking = (not report.ok) or (not shaping_ok) or bool(missing_fonts) \
        or (bool(glyphs) and not all(glyphs.values()))

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
