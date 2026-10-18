"""The client and the services must agree, checked without running either.

This exists because of a real mistake. `local_models.speak()` posted to
`/speak` with `{text, language, voice, pace}`. The service is
`ops/runpod/local_tts_service.py`, it serves `/synthesize`, and it reads
`transcript` and `languageCode`. Nothing caught it, because nothing could: the
only place the two meet is a running GPU host, and that is the worst place to
discover an invented schema.

So the service sources are parsed and compared against what the client sends.
These are static checks — they prove the names agree, not that a service
behaves. A real request still needs a real host, which is what the benchmark
is for.

    python -m pytest ops/cloud/test_contracts.py -q
"""
from __future__ import annotations

import ast
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNPOD = HERE.parent / "runpod"
sys.path.insert(0, str(HERE))

import local_models as lm  # noqa: E402


def payload_keys(source: Path) -> set[str]:
    """Every `payload.get("x")` / `payload["x"]` key a service reads."""
    text = source.read_text(encoding="utf-8")
    keys = set(re.findall(r'payload\.get\(\s*"([A-Za-z0-9_]+)"', text))
    keys |= set(re.findall(r'payload\[\s*"([A-Za-z0-9_]+)"\s*\]', text))
    return keys


def served_paths(source: Path) -> set[str]:
    """Every path the handler compares `self.path` against."""
    text = source.read_text(encoding="utf-8")
    return set(re.findall(r'self\.path\s*[!=]=\s*"(/[A-Za-z0-9_/-]*)"', text))


def client_sends(function_name: str) -> set[str]:
    """The JSON keys a client function puts in its payload.

    Read from the AST rather than by calling it, so no service is needed and a
    renamed key cannot slip past by never being exercised.
    """
    tree = ast.parse((HERE / "local_models.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == function_name:
            keys: set[str] = set()
            for inner in ast.walk(node):
                if isinstance(inner, ast.Dict):
                    for key in inner.keys:
                        if isinstance(key, ast.Constant) and isinstance(key.value, str):
                            keys.add(key.value)
                # payload["x"] = ...
                if isinstance(inner, ast.Subscript) and isinstance(inner.slice, ast.Constant):
                    if isinstance(inner.slice.value, str):
                        keys.add(inner.slice.value)
            return keys
    raise AssertionError(f"{function_name} is not defined in local_models.py")


class ServicePaths(unittest.TestCase):
    """Each client posts to a path its service actually serves."""

    CASES = [
        ("tts", "local_tts_service.py", "/synthesize"),
        ("translate", "local_translation_service.py", "/translate"),
        ("planner", "local_planner_service.py", "/structured"),
    ]

    def test_paths_are_served(self):
        for name, filename, expected in self.CASES:
            with self.subTest(service=name):
                source = RUNPOD / filename
                self.assertTrue(source.is_file(), f"{filename} is missing")
                self.assertEqual(
                    lm.SERVICE_PATHS[name], expected,
                    f"the client posts to {lm.SERVICE_PATHS[name]} for {name}")
                paths = served_paths(source)
                # A service that only guards /health still routes everything
                # else to its one handler, so an exact match is not required —
                # but a path it explicitly rejects would be a bug.
                if paths and expected not in paths:
                    self.assertNotIn(
                        expected, {p for p in paths if p != "/health"},
                        f"{filename} appears to reject {expected}")

    def test_vision_path_matches_the_worker(self):
        worker = (RUNPOD / "media_worker.py").read_text(encoding="utf-8")
        self.assertIn('"/check"', worker.replace("+ \"/check\"", '"/check"'),
                      "the worker no longer posts to /check")
        self.assertEqual(lm.SERVICE_PATHS["vision"], "/check")

    def test_health_is_served_everywhere(self):
        for filename in ("local_tts_service.py", "local_translation_service.py",
                         "local_planner_service.py"):
            with self.subTest(service=filename):
                self.assertIn("/health", served_paths(RUNPOD / filename),
                              f"{filename} serves no /health, so readiness cannot probe it")


class PayloadShapes(unittest.TestCase):
    """Every key the client sends is a key the service reads."""

    def test_tts(self):
        service = payload_keys(RUNPOD / "local_tts_service.py")
        sent = client_sends("synthesize")
        for key in ("transcript", "languageCode", "pace"):
            self.assertIn(key, sent, f"the client no longer sends {key}")
            self.assertIn(key, service, f"local_tts_service.py no longer reads {key}")
        # The old invented names must not come back.
        for wrong in ("text", "language", "voice"):
            self.assertNotIn(wrong, sent, f"the client sends the invented key {wrong}")

    def test_translate(self):
        service = payload_keys(RUNPOD / "local_translation_service.py")
        sent = client_sends("translate")
        for key in ("texts", "languageCode"):
            self.assertIn(key, sent)
            self.assertIn(key, service)

    def test_planner(self):
        service = payload_keys(RUNPOD / "local_planner_service.py")
        sent = client_sends("plan_structured")
        for key in ("systemPrompt", "userPrompt", "jsonSchema", "maxNewTokens"):
            self.assertIn(key, sent)
            self.assertIn(key, service)

    def test_vision(self):
        worker = (RUNPOD / "media_worker.py").read_text(encoding="utf-8")
        sent = client_sends("vision_check")
        for key in ("description", "mode", "imageBase64"):
            self.assertIn(key, sent)
            self.assertIn(f'"{key}"', worker,
                          f"the worker no longer sends {key} to the vision service")


class VerdictKeys(unittest.TestCase):
    """The vision verdict keys the benchmark reads are the ones the worker reads."""

    def test_verdict_keys_match_the_worker(self):
        worker = (RUNPOD / "media_worker.py").read_text(encoding="utf-8")
        for key in ("passed", "shows_subject", "deformed", "has_writing", "unsafe"):
            self.assertIn(f'verdict.get("{key}"', worker,
                          f"the worker no longer reads {key}")


class WorkflowSlots(unittest.TestCase):
    """The benchmark fills exactly the slots the shipped workflows declare."""

    def test_every_slot_is_supplied(self):
        import json
        workflows = RUNPOD / "workflows" / "api"
        supplied = {
            "image-fast.json": {"prompt", "width", "height", "seed"},
            "video-fast.json": {"prompt", "negative_prompt", "width", "height",
                                "frames", "seed", "steps", "fps", "source_image"},
        }
        for name, provided in supplied.items():
            with self.subTest(workflow=name):
                graph = json.loads((workflows / name).read_text(encoding="utf-8"))
                declared = {
                    value[2:-2].lower()
                    for node in graph.values()
                    for value in (node.get("inputs") or {}).values()
                    if isinstance(value, str) and value.startswith("__") and value.endswith("__")
                }
                self.assertEqual(
                    declared, provided,
                    f"{name} declares {sorted(declared)}, benchmark supplies {sorted(provided)}")


if __name__ == "__main__":
    unittest.main()
