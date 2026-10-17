"""One command, one lesson video per language.

    npm run sample:lesson                      # real models; refuses if not ready
    npm run sample:lesson -- --allow-placeholders
    npm run sample:lesson -- --languages en-IN,kn-IN --style storybook

Readiness is checked first and the run is refused if any stage is short,
rather than starting work that will fail partway through and leave half a
lesson behind.

`--allow-placeholders` exists so the composition path can be exercised without
a GPU. It does not pretend: every asset it stands in for is recorded as a
placeholder, the per-language manifest says so, and the closing summary names
each one. A sample produced this way is not an AI-generated video and must not
be presented as one.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8")

from PIL import Image, ImageDraw

import local_models as lm

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
COMPOSITOR = HERE / "compositor.py"
SLOT, FPS, CAP = 7.5, 24, 40

# Class 10 Science, Carbon and its Compounds — a real KTBS chapter, with the
# page each caption is drawn from.
SCENES = [
    {"page": 59, "title": "The atom that always makes four", "draw": "tetra",
     "visual": "a single carbon atom with four bonds radiating outward",
     "motion": "slow push in; the four bonds brighten in turn; labels hold still",
     "caption": {
         "en-IN": "Carbon shares four electrons, so it forms four bonds",
         "hi-IN": "कार्बन चार इलेक्ट्रॉन साझा करता है, इसलिए चार बंध बनाता है",
         "kn-IN": "ಇಂಗಾಲವು ನಾಲ್ಕು ಎಲೆಕ್ಟ್ರಾನ್ ಹಂಚಿ ನಾಲ್ಕು ಬಂಧ ರಚಿಸುತ್ತದೆ"}},
    {"page": 61, "title": "Four hands, four hydrogens", "draw": "methane",
     "visual": "a methane molecule, one carbon joined to four hydrogens",
     "motion": "the hydrogens drift outward and settle back; bonds stay attached",
     "caption": {
         "en-IN": "In methane, each hydrogen shares one electron",
         "hi-IN": "मेथेन में हर हाइड्रोजन एक इलेक्ट्रॉन साझा करता है",
         "kn-IN": "ಮೀಥೇನ್‌ನಲ್ಲಿ ಪ್ರತಿ ಜಲಜನಕವು ಒಂದು ಎಲೆಕ್ಟ್ರಾನ್ ಹಂಚುತ್ತದೆ"}},
    {"page": 63, "title": "One element, three coats", "draw": "allotropes",
     "visual": "three carbon structures side by side: diamond, graphite, fullerene",
     "motion": "a slow pan across the three; each holds its own shape",
     "caption": {
         "en-IN": "Diamond and graphite are both carbon",
         "hi-IN": "हीरा और ग्रेफाइट दोनों कार्बन हैं",
         "kn-IN": "ವಜ್ರ ಮತ್ತು ಗ್ರ್ಯಾಫೈಟ್ ಎರಡೂ ಇಂಗಾಲವೇ ಆಗಿದೆ"}},
    {"page": 79, "title": "The molecule with two minds", "draw": "micelle",
     "visual": "a soap micelle around an oil droplet, heads out and tails in",
     "motion": "the tails sway inward; the droplet stays round and in place",
     "caption": {
         "en-IN": "One end of soap holds water, the other holds oil",
         "hi-IN": "साबुन का एक सिरा पानी, दूसरा तेल पकड़ता है",
         "kn-IN": "ಸಾಬೂನಿನ ಒಂದು ತುದಿ ನೀರು, ಇನ್ನೊಂದು ಎಣ್ಣೆ ಹಿಡಿಯುತ್ತದೆ"}},
]

NEGATIVE = ("text, letters, watermark, changing labels, new atoms, "
            "morphing geometry, flicker, camera shake")


def placeholder_keyframe(spec: dict, style: str, path: Path) -> None:
    """A stand-in still. NOT a generated image — see the module docstring."""
    w, h = 2560, 1440
    img = Image.new("RGB", (w, h), "#cfe6e4" if style == "illustrated" else "#e8e0cd")
    d = ImageDraw.Draw(img)
    cx, cy, u = w / 2, h / 2, min(w, h) / 10
    ink = "#3f5666" if style == "illustrated" else "#6b5c44"
    kind = spec["draw"]
    if kind == "tetra":
        for k in range(4):
            a = -math.pi / 2 + k * math.pi / 2 + 0.38
            x, y = cx + math.cos(a) * u * 2.4, cy + math.sin(a) * u * 2.4
            d.line((cx, cy, x, y), fill=ink, width=14)
            d.ellipse((x - u * .3, y - u * .3, x + u * .3, y + u * .3), fill=ink)
        d.ellipse((cx - u, cy - u, cx + u, cy + u), fill=ink)
    elif kind == "methane":
        for dx, dy in ((-1, -.72), (1, -.72), (-1, .78), (1, .78)):
            x, y = cx + dx * u * 2.2, cy + dy * u * 2.0
            d.line((cx, cy, x, y), fill=ink, width=14)
            d.ellipse((x - u * .6, y - u * .6, x + u * .6, y + u * .6), fill="#e8805a")
        d.ellipse((cx - u, cy - u, cx + u, cy + u), fill=ink)
    elif kind == "allotropes":
        for i, off in enumerate((-u * 3, 0, u * 3)):
            r = u * (1.3 - i * .15)
            d.ellipse((cx + off - r, cy - r, cx + off + r, cy + r), outline=ink, width=12)
    else:
        d.ellipse((cx - u * 1.2, cy - u * 1.2, cx + u * 1.2, cy + u * 1.2), fill="#e8a05a")
        for m in range(14):
            a = m * math.pi * 2 / 14
            d.line((cx + math.cos(a) * u * 1.4, cy + math.sin(a) * u * 1.4,
                    cx + math.cos(a) * u * 2.6, cy + math.sin(a) * u * 2.6),
                   fill=ink, width=10)
    img.save(path)


def composite(manifest: dict, work: Path, tag: str) -> dict:
    path = work / f"manifest-{tag}.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    result = subprocess.run([sys.executable, str(COMPOSITOR), "--manifest", str(path)],
                            capture_output=True, text=True, cwd=str(REPO))
    if result.returncode:
        tail = (result.stderr or "").strip().splitlines()
        raise SystemExit(f"compositor failed ({tag}): {tail[-1] if tail else 'no stderr'}")
    return json.loads(result.stdout)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--languages", default="en-IN,hi-IN,kn-IN")
    parser.add_argument("--style", default="illustrated",
                        choices=["illustrated", "editorial", "storybook"])
    parser.add_argument("--out", type=Path, default=HERE / "out")
    parser.add_argument("--models-root", type=Path, default=None)
    parser.add_argument("--allow-placeholders", action="store_true",
                        help="run without models; every stand-in asset is labelled")
    args = parser.parse_args()

    languages = [l.strip() for l in args.languages.split(",") if l.strip()]
    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    seconds = SLOT * len(SCENES)
    if seconds > CAP:
        raise SystemExit(f"{len(SCENES)} scenes is {seconds}s, over the {CAP}s cap")

    report = lm.readiness(models_root=args.models_root)
    placeholders: list[str] = []

    if report.ok:
        print("server ready — generating with local models")
        raise SystemExit(
            "Real generation is not wired into this entry point yet. The services "
            "are up, so run the media worker instead; this script covers the "
            "composition path and the placeholder sample.")
    if not args.allow_placeholders:
        print("NOT READY — refusing to generate.\n")
        for line in lm.explain(report):
            print(f"  - {line}")
        print("\nFix the above (see ops/cloud/DEPLOYMENT.md), or pass "
              "--allow-placeholders to exercise the composition path without models.")
        return 1

    print("PLACEHOLDER RUN — no model is generating anything.")
    print("  keyframes: procedural stand-ins")
    print("  narration: measured silence")
    print("  motion:    deterministic FFmpeg camera move\n")

    for i, scene in enumerate(SCENES):
        placeholder_keyframe(scene, args.style, out / f"key-{i + 1}.png")
        placeholders.append(f"scene {i + 1} keyframe")
    narration = out / "narration.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
                    "-i", "anullsrc=r=24000:cl=mono", "-t", str(seconds),
                    "-c:a", "pcm_s16le", str(narration)], check=True)
    placeholders.append("narration (silence)")

    produced = []
    for language in languages:
        clips = []
        for i, scene in enumerate(SCENES):
            clip = out / f"scene-{i + 1}-{language}.mp4"
            composite({
                "mode": "scene", "ffmpeg": "ffmpeg", "ffprobe": "ffprobe",
                "fontsDir": str(HERE / "fonts"), "language": language,
                "visualStyle": args.style,
                "image": str((out / f"key-{i + 1}.png").resolve()),
                "output": str(clip.resolve()),
                "scene": {"duration_seconds": SLOT, "caption": scene["caption"][language],
                          "title": scene["title"], "motion_mode": "still",
                          "overlay": {"kind": "none"}},
            }, out, f"{language}-{i + 1}")
            clips.append(str(clip.resolve()))

        final = out / f"lesson-{args.style}-{language}.mp4"
        meta = composite({
            "mode": "assemble", "ffmpeg": "ffmpeg", "ffprobe": "ffprobe",
            "fontsDir": str(HERE / "fonts"), "language": language,
            "visualStyle": args.style, "clips": clips,
            "narration": str(narration.resolve()), "output": str(final.resolve()),
            "durationSeconds": int(seconds),
            "scenes": [{"scene_index": i + 1} for i in range(len(SCENES))],
        }, out, f"{language}-final")
        produced.append((final, meta))
        print(f"  {language}  {final.name}  {meta['width']}x{meta['height']} "
              f"@{meta['fps']}fps  {meta['durationSeconds']:.3f}s")

        (out / f"lesson-{args.style}-{language}.provenance.json").write_text(
            json.dumps({"language": language, "visualStyle": args.style,
                        "durationSeconds": meta["durationSeconds"],
                        "aiGenerated": False, "placeholderAssets": placeholders,
                        "note": "Composition and captions are real. No model produced "
                                "any picture, clip or audio in this run."},
                       indent=2), encoding="utf-8")

    for final, meta in produced:
        if meta["durationSeconds"] > CAP:
            raise SystemExit(f"{final.name} is {meta['durationSeconds']}s, over the {CAP}s cap")

    print(f"\n{len(produced)} file(s) in {out}")
    print("NOT an AI-generated video. Stand-ins used:")
    for item in placeholders:
        print(f"  - {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
