#!/usr/bin/env python3
"""Loopback-only Qwen2.5-VL service that checks generated lesson keyframes.

The text check (tesseract) catches visible lettering, but not a picture that
simply shows the wrong thing. The media worker sends each generated keyframe
with its intended scene description; this service answers whether the subject
is clearly shown in one clean photograph without writing.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import torch
from PIL import Image
from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

MODEL_PATH = os.environ.get("LOCAL_VISION_MODEL_PATH", "/workspace/lumina-local-ai/qwen2.5-vl-3b")
PORT = int(os.environ.get("LOCAL_VISION_PORT", "18083"))
MAX_REQUEST_BYTES = 25_000_000
MODEL_LOCK = threading.Lock()

print(f"[local-vision] loading {MODEL_PATH}", flush=True)
MODEL = Qwen2_5_VLForConditionalGeneration.from_pretrained(
    MODEL_PATH, dtype=torch.bfloat16, local_files_only=True, low_cpu_mem_usage=True,
)
MODEL.eval()
# ~600k pixels is plenty to judge a 1024x576 keyframe and keeps the check fast.
PROCESSOR = AutoProcessor.from_pretrained(
    MODEL_PATH, local_files_only=True, min_pixels=256 * 28 * 28, max_pixels=768 * 28 * 28,
)
print("[local-vision] ready on CPU; GPU is acquired only for a request", flush=True)

QUESTION = """This photograph was generated for one scene of an educational video.
Intended scene: "{description}"

Look carefully and answer with JSON only:
{{"shows_subject": true or false, "single_photo": true or false, "has_writing": true or false, "unsafe": true or false, "reason": "one short sentence"}}
- shows_subject: the main objects named in the intended scene are clearly visible and recognisable.
- single_photo: it is one continuous photograph, not a collage, grid, poster, infographic, diagram or split screen.
- has_writing: letters, words, numbers or written symbols are visible anywhere in the image.
- unsafe: any nudity, genitals, sexual content, gore or disturbing medical imagery, which is never acceptable for school students."""

CLIP_QUESTION = """This is a frame from an animated clip for one scene of an educational video.
Intended scene: "{description}"

Look carefully and answer with JSON only:
{{"shows_subject": true or false, "deformed": true or false, "has_writing": true or false, "unsafe": true or false, "reason": "one short sentence"}}
- shows_subject: the main objects named in the intended scene are still clearly visible and recognisable.
- deformed: objects look melted, warped, smeared, duplicated or cut apart, or unrelated new objects have appeared.
- has_writing: letters, words, numbers or written symbols are visible anywhere in the frame.
- unsafe: any nudity, genitals, sexual content, gore or disturbing medical imagery."""


def parse_verdict(raw: str) -> dict[str, Any]:
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        raise ValueError("vision model returned no JSON")
    data = json.loads(match.group(0))

    def flag(key: str, default: bool) -> bool:
        value = data.get(key, default)
        if isinstance(value, str):
            return value.strip().lower() in ("true", "yes")
        return bool(value)

    shows_subject = flag("shows_subject", True)
    single_photo = flag("single_photo", True)
    has_writing = flag("has_writing", False)
    deformed = flag("deformed", False)
    unsafe = flag("unsafe", False)
    return {
        "shows_subject": shows_subject,
        "single_photo": single_photo,
        "has_writing": has_writing,
        "deformed": deformed,
        "unsafe": unsafe,
        "passed": shows_subject and single_photo and not has_writing and not deformed and not unsafe,
        "reason": str(data.get("reason", ""))[:300],
    }


def check(payload: dict[str, Any]) -> dict[str, Any]:
    description = str(payload.get("description", "")).strip()[:1200]
    image_b64 = str(payload.get("imageBase64", ""))
    if not description or not image_b64:
        raise ValueError("description and imageBase64 are required")
    image = Image.open(io.BytesIO(base64.b64decode(image_b64))).convert("RGB")
    messages = [{
        "role": "user",
        "content": [
            {"type": "image", "image": image},
            {"type": "text", "text": (CLIP_QUESTION if payload.get("mode") == "clip" else QUESTION)
             .format(description=description.replace('"', "'"))},
        ],
    }]
    prompt = PROCESSOR.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    with MODEL_LOCK:
        try:
            MODEL.to("cuda")
            inputs = PROCESSOR(text=[prompt], images=[image], return_tensors="pt").to("cuda")
            with torch.inference_mode():
                output = MODEL.generate(**inputs, max_new_tokens=120, do_sample=False)
            raw = PROCESSOR.batch_decode(
                output[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True,
            )[0]
        finally:
            MODEL.to("cpu")
            torch.cuda.empty_cache()
    verdict = parse_verdict(raw)
    verdict["model"] = os.path.basename(MODEL_PATH.rstrip("/"))
    return verdict


class Handler(BaseHTTPRequestHandler):
    server_version = "LuminaLocalVision/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[local-vision] {self.address_string()} {fmt % args}", flush=True)

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_json(404, {"error": "not found"})
            return
        self.send_json(200, {"status": "ready", "model": os.path.basename(MODEL_PATH.rstrip("/")), "local": True})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/check":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("request body is empty or too large")
            self.send_json(200, check(json.loads(self.rfile.read(length))))
        except Exception as exc:  # Keep model/runtime details on the server.
            print(f"[local-vision] request failed: {type(exc).__name__}: {exc}", flush=True)
            self.send_json(500, {"error": f"Local vision check failed: {type(exc).__name__}"})


def warm_up() -> None:
    """The first GPU generation pays about a minute of CUDA initialisation; pay it
    at startup so the first keyframe check of a lesson is not slow."""
    try:
        buffer = io.BytesIO()
        Image.new("RGB", (320, 180), (200, 190, 170)).save(buffer, format="PNG")
        check({"description": "a plain beige surface", "imageBase64": base64.b64encode(buffer.getvalue()).decode()})
        print("[local-vision] warm-up complete", flush=True)
    except Exception as error:  # noqa: BLE001 - warm-up must never block startup
        print(f"[local-vision] warm-up skipped: {error}", flush=True)


if __name__ == "__main__":
    warm_up()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
