import shutil
import tempfile
import unittest
from pathlib import Path

from lesson_compositor import (
    HEIGHT,
    WIDTH,
    SceneRenderer,
    default_fonts,
    display_math,
    layout_for,
    render_editorial_scene,
    sanitize_overlay,
)


def solid_frames(overlay, count=12):
    return [bytes([90 + index * 10, 120, 150]) * (WIDTH * HEIGHT) for index in range(count)]


class OverlaySanitizerTests(unittest.TestCase):
    def test_valid_overlays_pass_through(self) -> None:
        cases = [
            {"kind": "arrow", "direction": "down-right"},
            {"kind": "equation", "steps": ["2x + 3 = 11", "2x = 8", "x = 4"]},
            {"kind": "groups", "groups": [{"count": 3, "token": "x"}], "showTotal": True},
            {"kind": "bars", "values": [4.8, 1.5], "unit": "%"},
            {"kind": "timeline", "years": [1971, 1974, 1977], "current": 1974},
        ]
        for overlay in cases:
            safe, warning = sanitize_overlay(overlay)
            self.assertIsNone(warning, overlay)
            self.assertEqual(safe["kind"], overlay["kind"])

    def test_invalid_overlays_are_dropped_not_approximated(self) -> None:
        cases = [
            {"kind": "equation", "steps": ["import os"]},
            {"kind": "groups", "groups": [{"count": 40}]},
            {"kind": "bars", "values": [1]},
            {"kind": "arrow", "direction": "sideways"},
            {"kind": "timeline", "years": [1974, 1971], "current": 1971},
            {"kind": "timeline", "years": [1971, 1974], "current": 1990},
            {"kind": "video"},
        ]
        for overlay in cases:
            safe, warning = sanitize_overlay(overlay)
            self.assertEqual(safe, {"kind": "none"}, overlay)
            self.assertIsNotNone(warning)

    def test_total_is_hidden_for_mixed_tokens(self) -> None:
        safe, _ = sanitize_overlay({
            "kind": "groups",
            "groups": [{"count": 2, "token": "x"}, {"count": 3, "token": "y"}],
            "showTotal": True,
        })
        self.assertFalse(safe["showTotal"])

    def test_math_is_typeset_for_display(self) -> None:
        self.assertEqual(display_math("3*x - 2 = x^2"), "3×x − 2 = x²")


class SceneRendererTests(unittest.TestCase):
    def test_every_layout_renders_full_frames_through_the_scene(self) -> None:
        overlays = [
            {"kind": "none"},
            {"kind": "arrow", "direction": "up"},
            {"kind": "equation", "steps": ["2x + 3 = 11", "x = 4"]},
            {"kind": "groups", "groups": [{"count": 4, "token": ""}, {"count": 4, "token": ""}], "showTotal": True},
            {"kind": "bars", "values": [3, 5, 2], "unit": ""},
            {"kind": "timeline", "years": [1630, 1646, 1674, 1680], "current": 1674},
        ]
        for overlay in overlays:
            safe, _ = sanitize_overlay(overlay)
            renderer = SceneRenderer(
                frames=solid_frames(safe), caption="Balance both sides", overlay=safe,
                fonts=default_fonts(), scene_index=2, scene_count=8, duration=7.5,
            )
            for t in (0.0, 1.0, 4.0, 7.8):
                frame = renderer.frame(t)
                self.assertEqual(frame.size, (WIDTH, HEIGHT))

    def test_caption_and_overlay_change_pixels_over_time(self) -> None:
        safe, _ = sanitize_overlay({"kind": "equation", "steps": ["2x = 8", "x = 4"]})
        renderer = SceneRenderer(
            frames=solid_frames(safe), caption="Solve for x", overlay=safe,
            fonts=default_fonts(), scene_index=1, scene_count=8, duration=7.5,
        )
        self.assertNotEqual(renderer.frame(0.2).tobytes(), renderer.frame(6.0).tobytes())

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg required")
    def test_render_writes_a_scene_with_transition_tail(self) -> None:
        import subprocess

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clip = root / "raw.mp4"
            subprocess.run([
                "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                "testsrc=s=832x480:r=16:d=2", "-pix_fmt", "yuv420p", str(clip),
            ], check=True, timeout=60)
            output = root / "scene.mp4"
            metadata = render_editorial_scene(
                clip, output, caption="Like terms", language_code="en-IN",
                overlay={"kind": "arrow", "direction": "right"}, scene_index=1,
                scene_count=8, duration=1.5, fonts_dir=root, fonts=default_fonts(),
            )
            self.assertAlmostEqual(metadata["composite_seconds"], 1.9, delta=1 / 24)
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                "stream=width,height", "-of", "csv=p=0", str(output),
            ], check=True, capture_output=True, text=True, timeout=30)
            self.assertEqual(probe.stdout.strip(), "1280,720")


if __name__ == "__main__":
    unittest.main()
