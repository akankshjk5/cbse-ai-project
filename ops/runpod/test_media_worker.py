import json
import shutil
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch

from media_worker import (
    QueueClient,
    WorkerError,
    cleanup_job_files,
    history_output_paths,
    lesson_filter_graph,
    load_workflow,
    parse_tesseract_tsv,
    replace_tokens,
    resolve_job_parameters,
    uses_editorial_composite,
    uses_lesson_fact_card,
    uses_stable_lesson_motion,
    validate_lesson_storyboard,
    validate_output,
    vision_check_keyframe,
    vision_check_clip,
    clip_description_from_prompt,
    scene_description_from_prompt,
    wan_frame_count,
)


class WorkerContractTests(unittest.TestCase):
    def test_lesson_image_prompt_is_positive_only_and_changes_retry_seed(self) -> None:
        workflow_json = (
            '{"1":{"inputs":{"prompt":"__PROMPT__","negative":"__NEGATIVE_PROMPT__",'
            '"seed":"__SEED__"}}}'
        )
        with patch.object(Path, "is_file", return_value=True), patch.object(
            Path, "read_text", return_value=workflow_json,
        ):
            workflow = load_workflow({
                "id": "job",
                "kind": "image",
                "_queue": "lesson",
                "profile": "image-fast",
                "prompt": "Opening frame",
                "negative_prompt": "text",
                "parameters": {"seed": 1001},
                "attempts": 2,
            }, Path("workflows"), Path("input"))

        inputs = workflow["1"]["inputs"]
        self.assertIn("One single photograph of one physical subject", inputs["prompt"])
        self.assertIn("even simpler", inputs["prompt"])
        # Z-Image runs without CFG: naming unwanted things in the positive
        # prompt makes the model draw them.
        for forbidden in ("infographic", "storyboard", "text", "panel", "poster", "equation"):
            self.assertNotIn(forbidden, inputs["prompt"].lower())
        self.assertEqual(inputs["seed"], 8920)

    def test_anatomical_lesson_does_not_force_a_photograph(self) -> None:
        workflow_json = '{"1":{"inputs":{"prompt":"__PROMPT__"}}}'
        with patch.object(Path, "is_file", return_value=True), patch.object(
            Path, "read_text", return_value=workflow_json,
        ):
            workflow = load_workflow({
                "id": "biology-job", "kind": "image", "_queue": "lesson",
                "profile": "image-fast", "prompt": "An ovum and sperm approach.",
                "parameters": {"visualMode": "anatomical"}, "attempts": 1,
            }, Path("workflows"), Path("input"))
        prompt = workflow["1"]["inputs"]["prompt"]
        self.assertIn("three-dimensional anatomical visualization", prompt)
        self.assertNotIn("One single photograph", prompt)

    def test_tesseract_parser_keeps_confident_words_but_ignores_noise(self) -> None:
        tsv = (
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
            "5\t1\t1\t1\t1\t1\t0\t0\t20\t10\t92.5\tVariables\n"
            "5\t1\t1\t1\t1\t2\t0\t0\t20\t10\t12.0\tshadow\n"
            "5\t1\t1\t1\t1\t3\t0\t0\t20\t10\t99.0\tx\n"
        )
        self.assertEqual(parse_tesseract_tsv(tsv), ["Variables"])

    @patch("media_worker.shutil.which", return_value="tesseract")
    @patch("media_worker.subprocess.run")
    @patch("media_worker._strong_edge_bands", return_value=(0, 0))
    def test_storyboard_gate_rejects_visible_generated_text(
        self, _bands: Mock, run: Mock, _which: Mock,
    ) -> None:
        run.return_value = Mock(stdout=(
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
            "5\t1\t1\t1\t1\t1\t0\t0\t20\t10\t96\tAlgebra\n"
        ))
        with self.assertRaisesRegex(WorkerError, "visible text detected") as raised:
            validate_lesson_storyboard(Path("frame.png"))
        self.assertEqual(raised.exception.code, "storyboard_quality_rejected")

    @patch("media_worker.shutil.which", return_value="tesseract")
    @patch("media_worker.subprocess.run")
    @patch("media_worker._strong_edge_bands", return_value=(0, 0))
    def test_final_attempt_blurs_text_instead_of_failing_the_lesson(
        self, _bands: Mock, run: Mock, _which: Mock,
    ) -> None:
        from PIL import Image, ImageDraw

        run.return_value = Mock(stdout=(
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
            "5\t1\t1\t1\t1\t1\t40\t30\t120\t30\t96\tAlgebra\n"
        ))
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            frame = Path(directory) / "frame.png"
            image = Image.new("RGB", (320, 180), "white")
            ImageDraw.Draw(image).rectangle((40, 30, 160, 60), fill="black")
            image.save(frame)
            with self.assertRaises(WorkerError):
                validate_lesson_storyboard(frame, final_attempt=False)
            result = validate_lesson_storyboard(frame, final_attempt=True)
            self.assertEqual(result["text_regions_blurred"], 1)
            with Image.open(frame) as blurred:
                self.assertGreater(blurred.convert("L").getpixel((100, 45)), 0)

    @patch("media_worker.shutil.which", return_value="tesseract")
    @patch("media_worker.subprocess.run")
    @patch("media_worker._strong_edge_bands", return_value=(0, 3))
    def test_storyboard_gate_rejects_multi_panel_sheet(
        self, _bands: Mock, run: Mock, _which: Mock,
    ) -> None:
        run.return_value = Mock(stdout=(
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
        ))
        with self.assertRaisesRegex(WorkerError, "multi-panel layout") as raised:
            validate_lesson_storyboard(Path("panels.png"))
        self.assertEqual(raised.exception.code, "storyboard_quality_rejected")

    @patch("media_worker.shutil.which", return_value="tesseract")
    @patch("media_worker.subprocess.run")
    @patch("media_worker._strong_edge_bands", return_value=(1, 0))
    def test_storyboard_gate_tolerates_one_short_texture_token(
        self, _bands: Mock, run: Mock, _which: Mock,
    ) -> None:
        run.return_value = Mock(stdout=(
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
            "5\t1\t1\t1\t1\t1\t0\t0\t20\t10\t71\toe\n"
        ))
        result = validate_lesson_storyboard(Path("beans.png"))
        self.assertTrue(result["passed"])
        self.assertEqual(result["detected_text_tokens"], 1)

    def test_queue_fail_passes_retry_delay(self) -> None:
        queue = QueueClient("https://example.supabase.co", "test-key")
        queue.rpc = Mock(return_value=True)
        queue.fail({"id": "job", "_queue": "lesson"}, "worker", "storyboard_quality_rejected", "text", 2)
        name, payload = queue.rpc.call_args.args
        self.assertEqual(name, "fail_lesson_video_job")
        self.assertEqual(payload["p_retry_delay_seconds"], 2)

    def test_scoped_claim_never_falls_back_to_unrelated_queues(self) -> None:
        queue = QueueClient("https://example.supabase.co", "test-key")
        queue.rpc = Mock(return_value=[])
        self.assertIsNone(queue.claim("worker", ["approved-project"]))
        queue.rpc.assert_called_once_with("claim_lesson_video_job_for_projects", {
            "p_worker_id": "worker", "p_project_ids": ["approved-project"],
        })

    def test_owner_scoped_claim_never_falls_back_to_unrelated_queues(self) -> None:
        queue = QueueClient("https://example.supabase.co", "test-key")
        queue.rpc = Mock(return_value=[])
        self.assertIsNone(queue.claim("worker", owner_id="user_123"))
        queue.rpc.assert_called_once_with("claim_lesson_video_job_for_owner", {
            "p_worker_id": "worker", "p_owner_id": "user_123",
        })
        with self.assertRaises(ValueError):
            queue.claim("worker", ["approved-project"], "user_123")

    def test_owner_can_be_resolved_from_reference_lesson(self) -> None:
        queue = QueueClient("https://example.supabase.co", "test-key")
        queue.client.request = Mock(return_value=[{"owner_id": "user_123"}])
        self.assertEqual(queue.owner_for_project("reference-project"), "user_123")
        self.assertIn("id=eq.reference-project", queue.client.request.call_args.args[1])

    def test_editorial_composite_is_default_for_lesson_video_only(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertTrue(uses_editorial_composite({"kind": "video", "_queue": "lesson"}))
            self.assertFalse(uses_editorial_composite({"kind": "image", "_queue": "lesson"}))
            self.assertFalse(uses_editorial_composite({"kind": "video", "_queue": "deck"}))
        with patch.dict("os.environ", {"LESSON_COMPOSITE_MODE": "off"}):
            self.assertFalse(uses_editorial_composite({"kind": "video", "_queue": "lesson"}))

    def test_scene_description_drops_the_house_style(self) -> None:
        prompt = "A brass balance scale holding a cube. Vintage editorial photograph with muted tones."
        self.assertEqual(scene_description_from_prompt(prompt), "A brass balance scale holding a cube.")

    def _vision_response(self, verdict: dict) -> Mock:
        response = Mock()
        response.read.return_value = json.dumps(verdict).encode("utf-8")
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        return response

    def test_vision_mismatch_regenerates_then_accepts_on_final_attempt(self) -> None:
        verdict = {"passed": False, "shows_subject": False, "single_photo": True,
                   "has_writing": False, "reason": "shows a kitchen"}
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            frame = Path(directory) / "frame.png"
            frame.write_bytes(b"png")
            with patch("media_worker.urllib.request.urlopen", return_value=self._vision_response(verdict)):
                with self.assertRaisesRegex(WorkerError, "subject not shown") as raised:
                    vision_check_keyframe(frame, "a seedling", final_attempt=False)
                self.assertEqual(raised.exception.code, "storyboard_quality_rejected")
                result = vision_check_keyframe(frame, "a seedling", final_attempt=True)
        self.assertEqual(result["vision"], "accepted_on_final_attempt")

    def test_clip_description_drops_motion_directions(self) -> None:
        prompt = "A brass scale with two pans. Animate the subject physically: Start: level."
        self.assertEqual(clip_description_from_prompt(prompt), "A brass scale with two pans.")

    def test_deformed_clip_is_reanimated_then_accepted_on_final_attempt(self) -> None:
        verdict = {"passed": False, "shows_subject": True, "deformed": True,
                   "has_writing": False, "reason": "the scale melts"}
        with patch("media_worker.extract_frame", return_value=b"png"), patch(
            "media_worker._vision_request", return_value=verdict,
        ):
            with self.assertRaisesRegex(WorkerError, "deformed") as raised:
                vision_check_clip(Path("clip.mp4"), "a scale", final_attempt=False)
            self.assertEqual(raised.exception.code, "clip_quality_rejected")
            result = vision_check_clip(Path("clip.mp4"), "a scale", final_attempt=True)
        self.assertEqual(result["clip_vision"], "accepted_on_final_attempt")

    def test_vision_service_outage_does_not_block_rendering(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            frame = Path(directory) / "frame.png"
            frame.write_bytes(b"png")
            with patch("media_worker.urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
                self.assertEqual(vision_check_keyframe(frame, "x", False), {"vision": "unavailable"})

    def test_wan_animation_is_the_default_for_narrated_lesson_clips(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertFalse(uses_stable_lesson_motion({"kind": "video", "_queue": "lesson"}))

    def test_stable_motion_requires_an_explicit_recovery_override(self) -> None:
        with patch.dict("os.environ", {"LESSON_VIDEO_MOTION_MODE": "stable"}):
            self.assertTrue(uses_stable_lesson_motion({"kind": "video", "_queue": "lesson"}))
            self.assertFalse(uses_stable_lesson_motion({"kind": "video", "_queue": "deck"}))
            self.assertFalse(uses_stable_lesson_motion({"kind": "image", "_queue": "lesson"}))

    def test_generated_storyboards_are_the_default_for_narrated_lessons(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertFalse(uses_lesson_fact_card({"kind": "image", "_queue": "lesson"}))

    def test_fact_cards_require_an_explicit_recovery_override(self) -> None:
        with patch.dict("os.environ", {"LESSON_IMAGE_MODE": "fact-card"}):
            self.assertTrue(uses_lesson_fact_card({"kind": "image", "_queue": "lesson"}))
            self.assertFalse(uses_lesson_fact_card({"kind": "image", "_queue": "deck"}))
            self.assertFalse(uses_lesson_fact_card({"kind": "video", "_queue": "lesson"}))

    def test_upload_uses_deck_scoped_pro_bucket(self) -> None:
        calls = []

        class Client:
            def request(self, method, path, **kwargs):
                calls.append((method, path, kwargs))

        queue = QueueClient("https://example.supabase.co", "test-key")
        queue.client = Client()
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "result.mp4"
            path.write_bytes(b"video")
            url = queue.upload(
                "deck-assets",
                "11111111-1111-1111-1111-111111111111",
                "22222222-2222-2222-2222-222222222222",
                path,
            )

        expected = (
            "/storage/v1/object/deck-assets/"
            "11111111-1111-1111-1111-111111111111/media/"
            "22222222-2222-2222-2222-222222222222.mp4"
        )
        self.assertEqual(calls[0][0:2], ("POST", expected))
        self.assertIn("/storage/v1/object/public/deck-assets/", url)
        # Retried jobs re-upload the same object name and must not hit "Duplicate".
        self.assertEqual(calls[0][2]["headers"]["x-upsert"], "true")

    def test_upload_supports_standalone_video_bucket(self) -> None:
        calls = []

        class Client:
            def request(self, method, path, **kwargs):
                calls.append((method, path, kwargs))

        queue = QueueClient("https://example.supabase.co", "test-key")
        queue.client = Client()
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "result.png"
            path.write_bytes(b"image")
            url = queue.upload(
                "video-assets",
                "33333333-3333-3333-3333-333333333333",
                "44444444-4444-4444-4444-444444444444",
                path,
            )

        self.assertIn("/storage/v1/object/video-assets/", calls[0][1])
        self.assertIn("/storage/v1/object/public/video-assets/", url)

    def test_queue_routes_lesson_jobs_to_isolated_rpcs(self) -> None:
        lesson_job = {"id": "job", "_queue": "lesson"}
        deck_job = {"id": "job", "_queue": "deck"}
        self.assertEqual(
            QueueClient._rpc_name(lesson_job, "complete"),
            "complete_lesson_video_job",
        )
        self.assertEqual(
            QueueClient._rpc_name(deck_job, "complete"),
            "complete_deck_media_job",
        )

    def test_lesson_filter_graph_slides_between_scenes_without_losing_time(self) -> None:
        scenes = [{"duration_seconds": 7.5} for _ in range(8)]
        # Editorial clips are 7.9 s: 7.5 s scene plus a 0.4 s transition tail.
        graph = lesson_filter_graph(scenes, [7.9] * 8, 60)
        self.assertIn("[0:v]setpts=1.00000000*PTS,fps=24,scale=1280:720", graph)
        self.assertIn("[v0][v1]xfade=transition=slideleft:duration=0.400:offset=7.500[x1]", graph)
        self.assertIn("xfade=transition=slideleft:duration=0.400:offset=52.500[video]", graph)
        self.assertIn("settb=AVTB", graph)
        self.assertIn("[8:a]aresample=48000,apad,atrim=duration=60", graph)

    def test_lesson_filter_graph_fits_long_narration_without_truncating_speech(self) -> None:
        scenes = [{"duration_seconds": 7.5} for _ in range(8)]
        graph = lesson_filter_graph(scenes, [5.0] * 8, 60, 72.0)
        self.assertIn("[8:a]aresample=48000,atempo=1.22033898,apad", graph)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg required")
    def test_ffmpeg_accepts_lesson_assembly_graph(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clip = root / "clip.mp4"
            narration = root / "narration.wav"
            output = root / "lesson.mp4"
            subprocess.run([
                "ffmpeg", "-y", "-v", "error", "-f", "lavfi",
                "-i", "color=c=blue:s=1280x720:r=24:d=0.9",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip),
            ], check=True, timeout=30)
            subprocess.run([
                "ffmpeg", "-y", "-v", "error", "-f", "lavfi",
                "-i", "sine=frequency=440:sample_rate=48000:duration=4",
                "-c:a", "pcm_s16le", str(narration),
            ], check=True, timeout=30)
            scenes = [{"duration_seconds": 0.5} for _ in range(8)]
            graph = lesson_filter_graph(scenes, [0.9] * 8, 4)
            command = ["ffmpeg", "-y", "-v", "error"]
            for _ in scenes:
                command.extend(["-i", str(clip)])
            command.extend([
                "-i", str(narration), "-filter_complex", graph,
                "-map", "[video]", "-map", "[audio]", "-t", "4",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24",
                "-c:a", "aac", str(output),
            ])
            subprocess.run(command, check=True, timeout=60)
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(output),
            ], check=True, capture_output=True, text=True, timeout=30)
            self.assertGreaterEqual(float(probe.stdout.strip()), 3.9)

    def test_recursive_token_replacement_preserves_numeric_types(self) -> None:
        workflow = {"1": {"inputs": {"text": "__PROMPT__", "seed": "__SEED__"}}}
        result = replace_tokens(workflow, {"__PROMPT__": "hello", "__SEED__": 42})
        self.assertEqual(result["1"]["inputs"], {"text": "hello", "seed": 42})

    def test_png_signature_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "output.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 2048)
            self.assertEqual(validate_output(path, "image")["extension"], ".png")

    def test_tiny_output_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "bad.png"
            path.write_bytes(b"bad")
            with self.assertRaises(WorkerError):
                validate_output(path, "image")

    def test_wan_frame_count_is_compatible_and_not_short(self) -> None:
        self.assertEqual(wan_frame_count(3, 16), 49)
        self.assertEqual(wan_frame_count(5, 16), 81)
        self.assertEqual(wan_frame_count(5, 24), 121)

    def test_fast_profile_allows_only_supported_duration_and_seed(self) -> None:
        parameters = resolve_job_parameters({
            "profile": "video-fast",
            "parameters": {
                "width": 1920,
                "height": 1088,
                "durationSeconds": 10,
                "fps": 30,
                "seed": 123,
            },
        })
        self.assertEqual(parameters, {
            "width": 832,
            "height": 480,
            "durationSeconds": 3,
            "fps": 16,
            "steps": 30,
            "seed": 123,
        })

        five_seconds = resolve_job_parameters({
            "profile": "video-fast",
            "parameters": {"durationSeconds": 5},
        })
        self.assertEqual(five_seconds["durationSeconds"], 5)

    def test_cleanup_removes_only_the_current_jobs_files(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory)
            comfy_input = root / "input"
            output_dir = root / "worker-output"
            comfy_output = root / "comfy-output"
            for path in (comfy_input, output_dir, comfy_output / "lumina"):
                path.mkdir(parents=True)
            job_id = "11111111-1111-1111-1111-111111111111"
            source = comfy_input / f"media-job-{job_id}.png"
            worker_copy = output_dir / f"{job_id}.normalized.mp4"
            comfy_copy = comfy_output / "lumina" / "video-fast_00001_.webm"
            unrelated = output_dir / "another-job.mp4"
            for path in (source, worker_copy, comfy_copy, unrelated):
                path.write_bytes(b"test")

            history = {
                "outputs": {
                    "11": {
                        "videos": [{
                            "filename": comfy_copy.name,
                            "subfolder": "lumina",
                            "type": "output",
                        }],
                    },
                },
            }
            paths = history_output_paths(history, comfy_output)
            cleanup_job_files(job_id, comfy_input, output_dir, paths)

            self.assertFalse(source.exists())
            self.assertFalse(worker_copy.exists())
            self.assertFalse(comfy_copy.exists())
            self.assertTrue(unrelated.exists())

    def test_history_output_paths_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory)
            history = {
                "outputs": {
                    "10": {
                        "images": [{
                            "filename": "outside.png",
                            "subfolder": "../",
                            "type": "output",
                        }],
                    },
                },
            }
            self.assertEqual(history_output_paths(history, root / "output"), [])


if __name__ == "__main__":
    unittest.main()
