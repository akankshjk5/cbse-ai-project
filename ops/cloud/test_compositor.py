"""Offline compositor tests. Optional --ffmpeg/--ffprobe/--fonts run real encoding."""
import argparse
import json
import math
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageFont
from compositor import (WIDTH, HEIGHT, FPS, FRAMES, caption_layer, draw_overlay,
                        font, sanitize_overlay, render_scene, assemble, command, video_info)


class OverlayTests(unittest.TestCase):
    def test_valid_graphics(self):
        cases = [{"kind": "none"}, {"kind": "arrow", "direction": "up-right"},
                 {"kind": "equation", "steps": ["2x + 3 = 11", "x = 4"]},
                 {"kind": "groups", "groups": [{"count": 3, "token": "x"}], "showTotal": True},
                 {"kind": "bars", "values": [4.8, 1.5], "unit": "%"},
                 {"kind": "timeline", "years": [1971, 1974, 1977], "current": 1974}]
        for case in cases:
            with self.subTest(case=case):
                self.assertEqual(sanitize_overlay(case), (case, None))

    def test_invalid_graphics_drop(self):
        cases = [{"kind": "arrow", "direction": "elsewhere"}, {"kind": "equation", "steps": ["<script>"]},
                 {"kind": "groups", "groups": [{"count": 31}]}, {"kind": "bars", "values": [1, math.nan]},
                 {"kind": "timeline", "years": [4, 3], "current": 4}, {"kind": "unknown"},
                 {"kind": "bars", "values": [0, 0]}, {"kind": "equation", "steps": []}]
        for case in cases:
            self.assertEqual(sanitize_overlay(case)[0], {"kind": "none"})

    def test_different_group_tokens_prevent_misleading_total(self):
        raw = {"kind": "groups", "groups": [{"count": 2, "token": "x"}, {"count": 2, "token": "y"}], "showTotal": True}
        self.assertFalse(sanitize_overlay(raw)[0]["showTotal"])

    def test_overlays_draw_at_native_1080p(self):
        canvas = Image.new("RGB", (WIDTH, HEIGHT), "#eee6d5")
        draw_overlay(canvas, {"kind": "bars", "values": [4, 2], "unit": "%"}, 4, ImageFont.load_default(44))
        self.assertEqual(canvas.size, (1920, 1080))
        self.assertNotEqual(canvas.getpixel((1370, 550)), (238, 230, 213))

    def test_scene_boundaries_exact(self):
        self.assertEqual(FRAMES / FPS, 7.5)
        self.assertEqual(FRAMES * 8 / FPS, 60)
        self.assertEqual(FRAMES * 4 / FPS, 30)

    def test_assembly_rejects_duration_and_scene_mismatch(self):
        for seconds, count in [(45, 6), (30, 8), (60, 4)]:
            with self.assertRaises(ValueError):
                assemble({"durationSeconds": seconds, "clips": ["unused"] * count,
                          "scenes": [{"scene_index": i + 1} for i in range(count)]})

    def test_missing_fonts_fail_clearly(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, "Missing"):
                font({"fontsDir": root}, "en-IN", 40)

    def test_indic_does_not_silently_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "NotoSansKannada.ttf").touch()
            with patch("compositor.features.check", return_value=False):
                with self.assertRaisesRegex(ValueError, "libraqm"):
                    font({"fontsDir": root}, "kn-IN", 40)

    def test_caption_legibility_guard(self):
        with patch("compositor.font", side_effect=lambda config, language, size: ImageFont.load_default(size)):
            self.assertEqual(caption_layer("Water evaporates", {}, "en-IN").size, (1920, 1080))
            with self.assertRaisesRegex(ValueError, "legibly"):
                caption_layer("very long " * 100, {}, "en-IN")


def integration(config: dict, output_root: Path):
    """Synthetic inputs, actual ffmpeg encode/probe/mux. No AI calls."""
    output_root.mkdir(parents=True, exist_ok=True)
    config = {**config, "language": "en-IN"}
    image = output_root / "image.png"
    canvas = Image.new("RGB", (2560, 1440), "#6699aa")
    from PIL import ImageDraw
    draw = ImageDraw.Draw(canvas)
    draw.ellipse((800, 300, 1700, 1200), fill="#d5cc99")
    canvas.save(image)
    scene = {"scene_index": 1, "duration_seconds": 7.5, "motion_mode": "still",
             "caption": "Water evaporates", "overlay": {"kind": "arrow", "direction": "up"}}
    still = output_root / "still.mp4"
    result = render_scene({**config, "visualStyle": "illustrated", "scene": scene, "image": str(image), "output": str(still)})
    assert result["width"] == 1920 and abs(result["durationSeconds"] - 7.5) < .01
    raw = output_root / "raw.mp4"
    command([config["ffmpeg"], "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24",
             "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(raw)])
    motion = output_root / "motion.mp4"
    animated = {**scene, "motion_mode": "animate", "overlay": {"kind": "equation", "steps": ["2 + 2 = 4"]}}
    render_scene({**config, "scene": animated, "image": str(image), "rawClip": str(raw), "output": str(motion)})
    narration = output_root / "narration.wav"
    command([config["ffmpeg"], "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000",
             "-t", "60", "-c:a", "pcm_s16le", str(narration)])
    final = output_root / "lesson.mp4"
    metadata = assemble({**config, "clips": [str(still), str(motion)] * 4,
                         "scenes": [{**scene, "scene_index": i + 1} for i in range(8)],
                         "narration": str(narration), "output": str(final)})
    assert metadata["hasAudio"] and abs(metadata["durationSeconds"] - 60) < .01
    short_audio = output_root / "narration-30.wav"
    command([config["ffmpeg"], "-y", "-v", "error", "-i", str(narration), "-t", "30", str(short_audio)])
    short = output_root / "lesson-30.mp4"
    short_metadata = assemble({**config, "durationSeconds": 30, "clips": [str(still)] * 4,
                              "scenes": [{**scene, "scene_index": i + 1} for i in range(4)],
                              "narration": str(short_audio), "output": str(short)})
    assert short_metadata["hasAudio"] and abs(short_metadata["durationSeconds"] - 30) < .01
    assert short_metadata["sceneCount"] == 4
    command([config["ffmpeg"], "-y", "-v", "error", "-ss", "3", "-i", str(final),
             "-frames:v", "1", str(output_root / "preview.png")])
    (output_root / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    print(f"PASS illustrated scene encode, animation hold, 30s and 60s assembly with audio: {short}, {final}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ffmpeg")
    parser.add_argument("--ffprobe")
    parser.add_argument("--fonts")
    parser.add_argument("--output", default="generated/cloud-media-smoke")
    args = parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(OverlayTests))
    if not result.wasSuccessful():
        raise SystemExit(1)
    if args.ffmpeg and args.ffprobe and args.fonts:
        integration({"ffmpeg": args.ffmpeg, "ffprobe": args.ffprobe, "fontsDir": args.fonts}, Path(args.output).resolve())
