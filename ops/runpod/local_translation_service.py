#!/usr/bin/env python3
"""Loopback-only AI4Bharat IndicTrans2 English-to-Indic service."""

from __future__ import annotations

import json
import os
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import torch
from IndicTransToolkit import IndicProcessor
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer


MODEL_PATH = os.environ.get(
    "LOCAL_TRANSLATION_MODEL_PATH",
    "/workspace/lumina-local-ai/indictrans2-en-indic-1b",
)
PORT = int(os.environ.get("LOCAL_TRANSLATION_PORT", "18082"))
MAX_REQUEST_BYTES = 100_000
LANGUAGE_CODES = {
    "hi-IN": "hin_Deva",
    "bn-IN": "ben_Beng",
    "gu-IN": "guj_Gujr",
    "kn-IN": "kan_Knda",
    "ml-IN": "mal_Mlym",
    "mr-IN": "mar_Deva",
    "ta-IN": "tam_Taml",
    "te-IN": "tel_Telu",
}
MODEL_LOCK = threading.Lock()


print(f"[local-translation] loading {MODEL_PATH} on CPU", flush=True)
TOKENIZER = AutoTokenizer.from_pretrained(MODEL_PATH, trust_remote_code=True, local_files_only=True)
MODEL = AutoModelForSeq2SeqLM.from_pretrained(
    MODEL_PATH,
    trust_remote_code=True,
    local_files_only=True,
    torch_dtype=torch.bfloat16,
)
MODEL.eval()
PROCESSOR = IndicProcessor(inference=True)
print("[local-translation] ready", flush=True)


def translate(payload: dict[str, Any]) -> list[str]:
    texts = payload.get("texts")
    language_code = str(payload.get("languageCode", ""))
    target_language = LANGUAGE_CODES.get(language_code)
    if (
        not target_language
        or not isinstance(texts, list)
        or not 1 <= len(texts) <= 20
        or any(not isinstance(text, str) or not text.strip() or len(text) > 1_000 for text in texts)
    ):
        raise ValueError("one to twenty texts and a supported Indian languageCode are required")

    prepared = PROCESSOR.preprocess_batch(
        [text.strip() for text in texts],
        src_lang="eng_Latn",
        tgt_lang=target_language,
    )
    with MODEL_LOCK:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        try:
            MODEL.to(device)
            encoded = TOKENIZER(
                prepared,
                truncation=True,
                padding="longest",
                return_tensors="pt",
                max_length=256,
            ).to(device)
            with torch.inference_mode():
                generated = MODEL.generate(
                    **encoded,
                    # IndicTrans2's remote decoder expects the legacy cache tuple.
                    # Transformers 4.57 can seed that tuple with None entries, so
                    # disabling KV caching avoids an upstream compatibility crash.
                    use_cache=False,
                    min_length=0,
                    max_length=256,
                    num_beams=5,
                    num_return_sequences=1,
                )
            decoded = TOKENIZER.batch_decode(
                generated.detach().cpu(),
                skip_special_tokens=True,
                clean_up_tokenization_spaces=True,
            )
            return PROCESSOR.postprocess_batch(decoded, lang=target_language)
        finally:
            if device == "cuda":
                MODEL.to("cpu")
                torch.cuda.empty_cache()


class Handler(BaseHTTPRequestHandler):
    server_version = "LuminaLocalTranslation/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[local-translation] {self.address_string()} {fmt % args}", flush=True)

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
        self.send_json(
            200,
            {"status": "ready", "model": "ai4bharat/indictrans2-en-indic-1B", "local": True},
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/translate":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("request body is empty or too large")
            translations = translate(json.loads(self.rfile.read(length)))
            self.send_json(200, {"translations": translations})
        except Exception as exc:
            print(f"[local-translation] request failed: {type(exc).__name__}: {exc}", flush=True)
            traceback.print_exc()
            self.send_json(500, {"error": f"Local translation failed: {type(exc).__name__}"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
