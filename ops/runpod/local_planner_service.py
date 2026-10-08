#!/usr/bin/env python3
"""Loopback-only Qwen service for the narrated-video agent roles."""

from __future__ import annotations

import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer


MODEL_PATH = os.environ.get("LOCAL_PLANNER_MODEL_PATH", "/workspace/lumina-local-ai/qwen3-4b")
PORT = int(os.environ.get("LOCAL_PLANNER_PORT", "18080"))
MAX_REQUEST_BYTES = 1_500_000
MODEL_LOCK = threading.Lock()


def extract_json(raw: str) -> Any:
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE)
    candidate = fenced.group(1).strip() if fenced else raw.strip()
    start, end = candidate.find("{"), candidate.rfind("}")
    if start >= 0 and end > start:
        candidate = candidate[start : end + 1]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return json.loads(escape_inner_quotes(candidate))


def escape_inner_quotes(candidate: str) -> str:
    """Escape double quotes the model left unescaped inside string values.

    Inside a string, a quote only closes it when the next non-space character
    is one of , } ] or : -- any other quote is part of the text.
    """
    output: list[str] = []
    in_string = False
    escaped = False
    for position, character in enumerate(candidate):
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                rest = candidate[position + 1 :].lstrip()
                if rest[:1] in (",", "}", "]", ":", ""):
                    in_string = False
                else:
                    output.append("\\")
            elif character == "\n":
                output.append("\\n")
                continue
        elif character == '"':
            in_string = True
        output.append(character)
    return "".join(output)


print(f"[local-planner] loading {MODEL_PATH}", flush=True)
TOKENIZER = AutoTokenizer.from_pretrained(MODEL_PATH, local_files_only=True)
MODEL = AutoModelForCausalLM.from_pretrained(
    MODEL_PATH,
    torch_dtype=torch.bfloat16,
    local_files_only=True,
    low_cpu_mem_usage=True,
)
MODEL.eval()
print("[local-planner] ready on CPU; GPU is acquired only for a request", flush=True)


def generate(payload: dict[str, Any]) -> dict[str, Any]:
    system_prompt = str(payload.get("systemPrompt", "")).strip()
    user_prompt = str(payload.get("userPrompt", "")).strip()
    schema = payload.get("jsonSchema")
    max_new_tokens = max(512, min(5_000, int(payload.get("maxNewTokens", 3_200))))
    if not system_prompt or not user_prompt or not isinstance(schema, dict):
        raise ValueError("systemPrompt, userPrompt and jsonSchema are required")

    messages = [
        {
            "role": "system",
            "content": system_prompt
            + "\nYou are running locally. Return one JSON object only, with no markdown or commentary.",
        },
        {
            "role": "user",
            "content": user_prompt
            + "\n\nThe JSON response must satisfy this schema exactly:\n"
            + json.dumps(schema, ensure_ascii=False, separators=(",", ":")),
        },
    ]
    rendered = TOKENIZER.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    with MODEL_LOCK:
        try:
            MODEL.to("cuda")
            inputs = TOKENIZER(rendered, return_tensors="pt").to("cuda")
            with torch.inference_mode():
                output = MODEL.generate(
                    **inputs,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                    repetition_penalty=1.03,
                    eos_token_id=TOKENIZER.eos_token_id,
                    pad_token_id=TOKENIZER.eos_token_id,
                )
            raw = TOKENIZER.decode(output[0, inputs["input_ids"].shape[1] :], skip_special_tokens=True)
        finally:
            MODEL.to("cpu")
            torch.cuda.empty_cache()
    return {"output": extract_json(raw), "model": os.path.basename(MODEL_PATH.rstrip("/")), "raw": raw}


class Handler(BaseHTTPRequestHandler):
    server_version = "LuminaLocalPlanner/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[local-planner] {self.address_string()} {fmt % args}", flush=True)

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
        if self.path != "/structured":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("request body is empty or too large")
            payload = json.loads(self.rfile.read(length))
            self.send_json(200, generate(payload))
        except Exception as exc:  # Keep model/runtime details on the server.
            print(f"[local-planner] request failed: {type(exc).__name__}: {exc}", flush=True)
            self.send_json(500, {"error": f"Local planner failed: {type(exc).__name__}"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
