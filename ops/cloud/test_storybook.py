"""Offline tests for the storybook presentation. Optional --ffmpeg/--ffprobe/--fonts run a real encode.

    python ops/cloud/test_storybook.py
    python ops/cloud/test_storybook.py --ffmpeg ffmpeg --ffprobe ffprobe --fonts ops/cloud/fonts
"""
import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

import compositor  # noqa: E402
import storybook  # noqa: E402


class StorybookTests(unittest.TestCase):
    def test_scene_is_slot_plus_tail_and_film_stays_exact(self):
        self.assertEqual(storybook.SCENE_FRAMES, 192)
        for count in (4, 8):
            # n scenes of 8 s, joined by n-1 half-second dissolves, then trimmed: exactly n x 7.5 s.
            joined = count * storybook.SCENE_SECONDS - (count - 1) * storybook.DISSOLVE_SECONDS
            self.assertAlmostEqual(joined - storybook.TAIL_SECONDS, count * storybook.SLOT_SECONDS)

    def test_shot_spans_cover_the_scene_and_overlap_by_one_dissolve(self):
        for count, animated in ((1, False), (2, False), (2, True), (3, False), (3, True)):
            spans = storybook.shot_spans(count, animated)
            self.assertEqual(len(spans), count)
            self.assertEqual(spans[0][0], 0.0)
            self.assertEqual(spans[-1][1], storybook.SCENE_SECONDS)
            for (_, end), (start, _) in zip(spans, spans[1:]):
                self.assertAlmostEqual(end - start, storybook.DISSOLVE_SECONDS)
        # An animated first shot keeps the screen for most of its 5-second clip.
        self.assertAlmostEqual(storybook.shot_spans(2, True)[0][1], 5.0)
        self.assertAlmostEqual(storybook.shot_spans(2, False)[0][1], 4.0)
        with self.assertRaises(ValueError):
            storybook.shot_spans(4, False)

    def test_camera_boxes_stay_inside_the_picture_at_16_by_9(self):
        size = (2560, 1440)
        for move in sorted(storybook.CAMERA_MOVES) + ["unknown"]:
            for progress in (0, 0.25, 0.5, 0.75, 1):
                x0, y0, x1, y1 = storybook.camera_box(move, progress, size)
                self.assertGreaterEqual(x0, -1e-6)
                self.assertGreaterEqual(y0, -1e-6)
                self.assertLessEqual(x1, size[0] + 1e-6)
                self.assertLessEqual(y1, size[1] + 1e-6)
                self.assertAlmostEqual((x1 - x0) / (y1 - y0), 16 / 9, places=3)
                # Never enlarge the 2K picture past 1080p: the box is always at least 1920 wide.
                self.assertGreaterEqual(x1 - x0, 1920)

    def test_moves_actually_move_in_their_direction(self):
        size = (2560, 1440)
        start, end = storybook.camera_box("push_in", 0, size), storybook.camera_box("push_in", 1, size)
        self.assertLess(end[2] - end[0], start[2] - start[0])
        start, end = storybook.camera_box("pan_right", 0, size), storybook.camera_box("pan_right", 1, size)
        self.assertGreater(end[0], start[0])
        start, end = storybook.camera_box("tilt_up", 0, size), storybook.camera_box("tilt_up", 1, size)
        self.assertLess(end[1], start[1])

    def test_grade_forces_ink_on_paper(self):
        red = storybook.grade(Image.new("RGB", (4, 4), (255, 0, 0))).getpixel((0, 0))
        green = storybook.grade(Image.new("RGB", (4, 4), (0, 255, 0))).getpixel((0, 0))
        for pixel in (red, green):
            self.assertTrue(pixel[0] >= pixel[1] >= pixel[2], f"{pixel} is not a warm sepia tone")
        self.assertEqual(storybook.grade(Image.new("RGB", (2, 2), (255, 255, 255))).getpixel((0, 0)), storybook.PAPER)

    def test_finish_layers_darken_edges_more_than_centre(self):
        layer = storybook.finish_layers(seed=1, count=1)[0]
        self.assertEqual(layer.size, (1920, 1080))
        self.assertLess(layer.getpixel((5, 5))[0], layer.getpixel((960, 540))[0])

    def test_assembly_dissolves_on_every_slot_boundary(self):
        filters = ";".join(storybook.assembly_filters(8, 60, False))
        for i in range(1, 8):
            self.assertIn(f"offset={7.5 * i}", filters)
        self.assertIn("trim=duration=60", filters)
        self.assertNotIn("sidechaincompress", filters)
        with_music = ";".join(storybook.assembly_filters(4, 30, True))
        self.assertIn("sidechaincompress", with_music)
        self.assertIn("pan=stereo|c0=c0|c1=c0", with_music)
        self.assertIn("normalize=0", with_music)

    def test_assembly_rejects_wrong_scene_counts_and_foreign_music(self):
        for seconds, count in [(45, 6), (30, 8), (60, 4)]:
            with self.assertRaises(ValueError):
                storybook.assemble({"durationSeconds": seconds, "clips": ["unused"] * count,
                                    "scenes": [{"scene_index": i + 1} for i in range(count)]})

    def test_banner_and_caption_fit_or_refuse(self):
        with patch("storybook.title_font", side_effect=lambda config, language, size: ImageFont.load_default(size)), \
                patch("compositor.font", side_effect=lambda config, language, size, *a: ImageFont.load_default(size)):
            banner = storybook.banner_layer("The Grand Bazaar", {}, "en-IN")
            box = banner.getbbox()
            self.assertIsNotNone(box)
            self.assertLess(box[3], 260, "the banner stays in the top band")
            self.assertIsNone(storybook.banner_layer("", {}, "en-IN").getbbox())
            with self.assertRaisesRegex(ValueError, "legibly"):
                storybook.banner_layer("very long title " * 40, {}, "en-IN")
            caption = storybook.caption_strip("The escape", {}, "en-IN")
            self.assertGreater(caption.getbbox()[1], 900, "the caption sits at the foot of the page")

    def test_render_refuses_bad_inputs_before_encoding(self):
        scene = {"scene_index": 1, "duration_seconds": 7.5, "motion_mode": "still", "caption": "", "overlay": {"kind": "none"}}
        with self.assertRaisesRegex(ValueError, "one to three"):
            storybook.render_scene({"scene": scene, "shots": []})
        with self.assertRaisesRegex(ValueError, "provider clip"):
            storybook.render_scene({"scene": {**scene, "motion_mode": "animate"}, "shots": [{"image": "x"}]})
        with self.assertRaisesRegex(ValueError, "7.5"):
            storybook.render_scene({"scene": {**scene, "duration_seconds": 8}, "shots": [{"image": "x"}]})
        with tempfile.TemporaryDirectory() as root:
            small = Path(root, "small.png")
            Image.new("RGB", (1280, 720)).save(small)
            with self.assertRaisesRegex(ValueError, "1080p"):
                storybook.render_scene({"scene": scene, "shots": [{"image": str(small)}]})

    def test_other_styles_never_reach_storybook(self):
        source = Path(compositor.__file__).read_text(encoding="utf-8")
        self.assertIn('config.get("visualStyle") == "storybook"', source)


def picture(path: Path, seed: int):
    image = Image.new("RGB", (2560, 1440), (236, 226, 204))
    draw = ImageDraw.Draw(image)
    for i in range(0, 2560, 12):
        draw.line((i, 0, i + 600 * ((seed % 3) - 1), 1440), fill=(60, 50, 40), width=1)
    draw.ellipse((900, 300, 1700, 1100), outline=(30, 25, 20), width=8)
    image.save(path)


def integration(config: dict, output: Path):
    """Synthetic engravings, real ffmpeg: two scenes per minute-half, a provider clip, music, exact 30 s."""
    output.mkdir(parents=True, exist_ok=True)
    config = {**config, "language": "en-IN", "visualStyle": "storybook"}
    shots = []
    for i in range(2):
        path = output / f"shot{i}.png"
        picture(path, i)
        shots.append(str(path))
    clip = output / "provider.mp4"
    compositor.command([config["ffmpeg"], "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24",
                        "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(clip)])
    clips = []
    for n in range(1, 5):
        out = output / f"scene{n}.mp4"
        meta = storybook.render_scene({**config, "output": str(out), "rawClip": str(clip) if n == 1 else None,
            "scene": {"scene_index": n, "duration_seconds": 7.5, "motion_mode": "animate" if n == 1 else "still",
                      "title": f"Chapter {n}", "caption": "The escape" if n % 2 else "",
                      "overlay": {"kind": "timeline", "years": [1666, 1670], "current": 1666} if n == 2 else {"kind": "none"}},
            "shots": [{"image": shots[0], "cameraMove": "pan_right"}, {"image": shots[1], "cameraMove": "push_in"}]})
        assert abs(meta["durationSeconds"] - 8.0) < 0.05 and meta["shotCount"] == 2
        clips.append(str(out))
    narration = output / "narration.wav"
    compositor.command([config["ffmpeg"], "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000",
                        "-t", "30", "-c:a", "pcm_s16le", str(narration)])
    music = output / "music.wav"
    compositor.command([config["ffmpeg"], "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000",
                        "-t", "12", "-c:a", "pcm_s16le", str(music)])
    for name, track in (("lesson.mp4", None), ("lesson-music.mp4", str(music))):
        meta = storybook.assemble({**config, "durationSeconds": 30, "clips": clips, "narration": str(narration),
                                   "music": track, "scenes": [{"scene_index": i} for i in range(1, 5)],
                                   "output": str(output / name)})
        assert abs(meta["durationSeconds"] - 30) < 0.05 and meta["hasAudio"] and meta["music"] == bool(track)
    (output / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    print(f"PASS storybook scenes (8 s with tail), provider clip, dissolves, music bed, exact 30 s: {output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ffmpeg")
    parser.add_argument("--ffprobe")
    parser.add_argument("--fonts")
    parser.add_argument("--output", default="generated/cloud-storybook-media")
    args = parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(StorybookTests))
    if not result.wasSuccessful():
        raise SystemExit(1)
    if args.ffmpeg and args.ffprobe and args.fonts:
        integration({"ffmpeg": args.ffmpeg, "ffprobe": args.ffprobe, "fontsDir": args.fonts}, Path(args.output).resolve())
