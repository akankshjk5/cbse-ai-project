#!/usr/bin/env python3
"""Measure the listen-back speech error of the local narrator in every language.

Translates eight lesson-style English sentences into each supported language,
records them scene-aligned through the local TTS service, and reads the per-take
character error rates the service logs. Audio is kept under /root/voice-cal for
listening. Run on the Pod after the TTS service is up:

  python3 calibrate_voices.py [language ...]
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from pathlib import Path

TRANSLATE = "http://127.0.0.1:18082/translate"
SYNTHESIZE = "http://127.0.0.1:18081/synthesize"
TTS_LOG = Path("/root/lumina-local-tts.log")
OUT = Path("/root/voice-cal")
LANGUAGES = ["en-IN", "hi-IN", "kn-IN", "ta-IN", "te-IN", "ml-IN", "mr-IN", "bn-IN", "gu-IN"]
SENTENCES = [
    "Plants make their own food using sunlight, water and carbon dioxide.",
    "This process is called photosynthesis and it happens inside the leaves.",
    "Tiny green structures called chloroplasts capture the energy of sunlight.",
    "Roots absorb water from the soil and carry it up to the leaves.",
    "Leaves take in carbon dioxide from the air through small pores.",
    "The plant turns these into glucose, a simple sugar it uses for energy.",
    "Oxygen is released into the air as a by-product of this process.",
    "Without photosynthesis, animals and people would have no food or oxygen to breathe.",
]


def post(url: str, payload: dict, raw: bool = False):
    request = urllib.request.Request(
        url, json.dumps(payload).encode("utf-8"), {"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=900) as response:
        body = response.read()
    return body if raw else json.loads(body)


def main() -> int:
    OUT.mkdir(exist_ok=True)
    report: dict[str, dict] = {}
    for language in sys.argv[1:] or LANGUAGES:
        texts = SENTENCES if language == "en-IN" else post(
            TRANSLATE, {"texts": SENTENCES, "languageCode": language},
        )["translations"]
        log_start = TTS_LOG.stat().st_size
        started = time.time()
        audio = post(SYNTHESIZE, {
            "transcript": " ".join(texts), "sceneTranscripts": texts,
            "sceneDurationSeconds": 7.5, "languageCode": language, "pace": "natural",
        }, raw=True)
        (OUT / f"{language}.wav").write_bytes(audio)
        with TTS_LOG.open(encoding="utf-8", errors="replace") as handle:
            handle.seek(log_start)
            log = handle.read()
        takes = [
            (int(sentence), int(take), float(error))
            for sentence, take, error in re.findall(
                rf"take {re.escape(language)} s(\d+)\.(\d+) error=([0-9.]+)", log,
            )
        ]
        firsts = [error for _, take, error in takes if take == 1]
        finals = re.findall(r"sentence (\d+): speech error ([0-9.]+)", log)
        report[language] = {
            "seconds": round(time.time() - started),
            "first_take_errors": firsts,
            "final_errors": [float(error) for _, error in finals],
            "retakes": sum(1 for _, take, _ in takes if take > 1),
        }
        print(language, json.dumps(report[language]), flush=True)
    (OUT / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
