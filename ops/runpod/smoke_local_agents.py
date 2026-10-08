#!/usr/bin/env python3
"""Small dependency-free smoke tests for the loopback local AI services."""

from __future__ import annotations

import argparse
import json
import wave
from io import BytesIO
from urllib.request import Request, urlopen


KANNADA_RANGES = ((0x0C80, 0x0CFF),)


def post_json(url: str, payload: dict, timeout: int = 300) -> bytes:
    request = Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def smoke_planner() -> None:
    scene_schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["title", "learningObjective", "visualBible", "scenes"],
        "properties": {
            "title": {"type": "string"},
            "learningObjective": {"type": "string"},
            "visualBible": {"type": "string"},
            "scenes": {
                "type": "array",
                "minItems": 8,
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["fact", "narration", "visual", "motion"],
                    "properties": {
                        "fact": {"type": "string"},
                        "narration": {"type": "string"},
                        "visual": {"type": "string"},
                        "motion": {"type": "string"},
                    },
                },
            },
        },
    }
    payload = {
        "systemPrompt": (
            "You are a curriculum-grounded lesson planner and scriptwriter. "
            "Do not invent facts. Write the title, objective, facts, narration, visual and motion "
            "descriptions only in clear English. Translation happens after fact review."
        ),
        "userPrompt": (
            "Create exactly eight connected scenes for a Class 8 Mathematics lesson "
            "about algebra. Teach variables, expressions, like terms, substitution, "
            "and a simple one-step equation. Target about 60 seconds total."
        ),
        "jsonSchema": scene_schema,
    }
    result = json.loads(post_json("http://127.0.0.1:18080/structured", payload))
    output = result["output"]
    scenes = output["scenes"]
    assert len(scenes) == 8, f"expected 8 scenes, got {len(scenes)}"
    narration = " ".join(str(scene["narration"]) for scene in scenes)
    native = sum(any(start <= ord(char) <= end for start, end in KANNADA_RANGES) for char in narration)
    letters = sum(char.isalpha() for char in narration)
    assert letters and native == 0, "source narration must remain in English"
    topic_text = " ".join(
        [output["title"], output["learningObjective"]]
        + [f"{scene['fact']} {scene['visual']}" for scene in scenes]
    ).lower()
    if not any(term in topic_text for term in ("algebra", "variable", "equation")):
        print(
            json.dumps(
                {
                    "ok": False,
                    "service": "planner",
                    "title": output["title"],
                    "learningObjective": output["learningObjective"],
                    "firstFact": scenes[0]["fact"],
                },
                ensure_ascii=False,
            )
        )
    assert any(term in topic_text for term in ("algebra", "variable", "equation")), (
        "lesson is not about algebra"
    )
    print(
        json.dumps(
            {
                "ok": True,
                "service": "planner",
                "model": result.get("model"),
                "sceneCount": len(scenes),
                "title": output["title"],
                "englishSource": native == 0,
                "firstFact": scenes[0]["fact"],
            },
            ensure_ascii=False,
        )
    )


def smoke_tts() -> None:
    payload = {
        "transcript": "ಬೀಜಗಣಿತದಲ್ಲಿ ಅಕ್ಷರವು ತಿಳಿಯದ ಸಂಖ್ಯೆಯನ್ನು ಸೂಚಿಸುತ್ತದೆ.",
        "languageCode": "kn-IN",
        "pace": "brisk",
    }
    audio = post_json("http://127.0.0.1:18081/synthesize", payload)
    with wave.open(BytesIO(audio), "rb") as wav:
        duration = wav.getnframes() / wav.getframerate()
        assert wav.getnchannels() in (1, 2)
        assert 0.5 <= duration <= 20
    print(json.dumps({"ok": True, "service": "tts", "durationSeconds": round(duration, 3)}))


def smoke_translation() -> None:
    payload = {
        "texts": [
            "Algebra uses letters to represent unknown numbers.",
            "We combine like terms because they have the same variable part.",
        ],
        "languageCode": "kn-IN",
    }
    result = json.loads(post_json("http://127.0.0.1:18082/translate", payload))
    translations = result["translations"]
    assert len(translations) == len(payload["texts"])
    translated = " ".join(translations)
    native = sum(any(start <= ord(char) <= end for start, end in KANNADA_RANGES) for char in translated)
    letters = sum(char.isalpha() for char in translated)
    assert letters and native / letters >= 0.55, "translation is not predominantly Kannada script"
    print(
        json.dumps(
            {
                "ok": True,
                "service": "translation",
                "nativeScriptRatio": round(native / letters, 3),
                "sample": translations[0],
            },
            ensure_ascii=False,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "profile",
        choices=("planner", "translation", "tts", "all"),
        nargs="?",
        default="all",
    )
    args = parser.parse_args()
    if args.profile in ("planner", "all"):
        smoke_planner()
    if args.profile in ("translation", "all"):
        smoke_translation()
    if args.profile in ("tts", "all"):
        smoke_tts()


if __name__ == "__main__":
    main()
