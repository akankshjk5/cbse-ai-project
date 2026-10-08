#!/usr/bin/env python3
"""Loopback-only AI4Bharat Indic Parler-TTS service."""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import threading
import unicodedata
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import numpy as np
import torch
from parler_tts import ParlerTTSForConditionalGeneration
from transformers import AutoTokenizer


MODEL_PATH = os.environ.get("LOCAL_TTS_MODEL_PATH", "/workspace/lumina-local-ai/indic-parler-tts")
DESCRIPTION_TOKENIZER_PATH = os.environ.get(
    "LOCAL_TTS_DESCRIPTION_TOKENIZER_PATH",
    "/workspace/lumina-local-ai/flan-t5-large-tokenizer",
)
PORT = int(os.environ.get("LOCAL_TTS_PORT", "18081"))
MAX_REQUEST_BYTES = 100_000
LANGUAGES = {
    "en-IN": "Indian English",
    "hi-IN": "Hindi",
    "bn-IN": "Bengali",
    "gu-IN": "Gujarati",
    "kn-IN": "Kannada",
    "ml-IN": "Malayalam",
    "mr-IN": "Marathi",
    "ta-IN": "Tamil",
    "te-IN": "Telugu",
}
# Recommended Indic Parler-TTS speakers. Naming one keeps the same voice across
# every sentence of a lesson instead of letting each chunk drift.
SPEAKERS = {
    "en-IN": "Mary",
    "hi-IN": "Divya",
    "bn-IN": "Aditi",
    "gu-IN": "Neha",
    "kn-IN": "Suresh",
    "ml-IN": "Anjali",
    "mr-IN": "Sunita",
    "ta-IN": "Jaya",
    "te-IN": "Lalitha",
}
VOICE_SEED = int(os.environ.get("LOCAL_TTS_SEED", "1234"))
# Light touch only: rumble removal, gentle levelling and broadcast loudness
# (-16 LUFS). Denoising and heavy compression made the voice sound processed.
CLEANUP_FILTER = (
    "highpass=f=60,"
    "acompressor=threshold=-18dB:ratio=1.6:attack=20:release=250,"
    "loudnorm=I=-16:TP=-1.5:LRA=11"
)
MODEL_LOCK = threading.Lock()

# Listen-back check: a local Whisper model transcribes each spoken sentence and
# the transcript is compared with the intended text. Parler-TTS occasionally
# skips, repeats or slurs words; such a sentence is re-recorded with another
# seed and the closest take is kept. Optional: without the model, one take.
ASR_MODEL_PATH = os.environ.get(
    "LOCAL_ASR_MODEL_PATH", "/workspace/lumina-local-ai/whisper-large-v3-turbo",
)
VOICE_ATTEMPTS = int(os.environ.get("LOCAL_TTS_ATTEMPTS", "3"))
WHISPER_LANGUAGES = {
    "en-IN": "english", "hi-IN": "hindi", "bn-IN": "bengali", "gu-IN": "gujarati",
    "kn-IN": "kannada", "ml-IN": "malayalam", "mr-IN": "marathi", "ta-IN": "tamil",
    "te-IN": "telugu",
}
# Character error rate a take may have and still be accepted, set just above
# the recogniser's own noise measured on correct narration (calibrate_voices.py,
# 2026-09-27, first takes after script mapping): en 0-0.02, hi 0.09-0.17,
# mr 0.09-0.22, kn 0.06-0.21, ta 0.08-0.25, te 0.04-0.23, gu 0.06-0.22,
# bn 0.11-0.28, ml 0.26-0.56 (Whisper is weak at Malayalam, so only gross
# failures are caught there). A skipped or garbled word adds roughly 0.15-0.3.
MAX_SPEECH_ERROR = {
    "en-IN": 0.15, "hi-IN": 0.3, "mr-IN": 0.35, "kn-IN": 0.35, "ta-IN": 0.4,
    "te-IN": 0.35, "gu-IN": 0.35, "bn-IN": 0.4, "ml-IN": 0.7,
}
DEFAULT_MAX_SPEECH_ERROR = float(os.environ.get("LOCAL_TTS_MAX_ERROR", "0.3"))


print(f"[local-tts] loading {MODEL_PATH}", flush=True)
MODEL = ParlerTTSForConditionalGeneration.from_pretrained(
    MODEL_PATH,
    local_files_only=True,
)
MODEL.eval()
PROMPT_TOKENIZER = AutoTokenizer.from_pretrained(MODEL_PATH, local_files_only=True)
DESCRIPTION_TOKENIZER = AutoTokenizer.from_pretrained(
    DESCRIPTION_TOKENIZER_PATH,
    local_files_only=True,
)
SAMPLE_RATE = int(MODEL.config.sampling_rate)
ASR_MODEL = None
ASR_PROCESSOR = None
# Only a fully downloaded model (marked complete) is loaded, never a partial one.
if os.path.isfile(os.path.join(ASR_MODEL_PATH, ".lumina-complete")):
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    ASR_PROCESSOR = WhisperProcessor.from_pretrained(ASR_MODEL_PATH, local_files_only=True)
    ASR_MODEL = WhisperForConditionalGeneration.from_pretrained(ASR_MODEL_PATH, local_files_only=True)
    ASR_MODEL.eval()
    print(f"[local-tts] listen-back check enabled with {ASR_MODEL_PATH}", flush=True)
else:
    print("[local-tts] listen-back model not found; each sentence is recorded once", flush=True)
print(f"[local-tts] ready on CPU at {SAMPLE_RATE} Hz; GPU is acquired only for a request", flush=True)


def chunks(text: str, limit: int = 200) -> list[str]:
    pieces = [part.strip() for part in re.split(r"(?<=[.!?।])\s+", text.strip()) if part.strip()]
    output: list[str] = []
    current = ""
    for piece in pieces or [text.strip()]:
        if current and len(current) + 1 + len(piece) > limit:
            output.append(current)
            current = piece
        else:
            current = f"{current} {piece}".strip()
    if current:
        output.append(current)
    return output


def trim_silence(audio: np.ndarray, threshold: float = 0.012) -> np.ndarray:
    """Cut leading/trailing near-silence so sentence gaps are even and natural."""
    if audio.size == 0:
        return audio
    level = np.abs(audio) / max(1e-6, float(np.max(np.abs(audio))))
    voiced = np.flatnonzero(level > threshold)
    if voiced.size == 0:
        return audio
    pad = int(SAMPLE_RATE * 0.09)
    return audio[max(0, voiced[0] - pad): min(audio.size, voiced[-1] + pad)]


def comparable(text: str) -> str:
    """Letters and digits only, lower case, so punctuation and spacing never count."""
    normalized = unicodedata.normalize("NFC", text).lower()
    return "".join(
        character for character in normalized
        if unicodedata.category(character)[0] in ("L", "M", "N")
    )


_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
         "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def _below_thousand(value: int) -> str:
    if value < 20:
        return _ONES[value]
    if value < 100:
        return _TENS[value // 10] + (f"-{_ONES[value % 10]}" if value % 10 else "")
    rest = value % 100
    return f"{_ONES[value // 100]} hundred" + (f" {_below_thousand(rest)}" if rest else "")


def english_number_words(value: int) -> str:
    """Mirror of spokenNarration's number rules (years spoken in pairs)."""
    if 1100 <= value <= 1999:
        high, low = divmod(value, 100)
        if low == 0:
            return f"{_below_thousand(high)} hundred"
        return f"{_below_thousand(high)} " + (f"oh {_ONES[low]}" if low < 10 else _below_thousand(low))
    if value < 1000:
        return _below_thousand(value)
    parts = []
    for size, name in ((1_000_000, "million"), (1_000, "thousand")):
        if value >= size:
            parts.append(f"{_below_thousand(value // size)} {name}")
            value %= size
    if value:
        parts.append(_below_thousand(value))
    return " ".join(parts)


def spell_english_digits(text: str) -> str:
    """Whisper writes "3" where the narration says "three"; compare like with like."""
    return re.sub(r"\d+", lambda match: english_number_words(int(match.group(0))), text.replace(",", ""))


# Brahmic scripts share a parallel Unicode layout (ISCII-derived), so a letter
# maps across blocks by offset. Whisper often writes the right words in the
# wrong Indian script (Telugu speech in Kannada letters); map before comparing.
SCRIPT_BLOCKS = {
    "hi-IN": 0x0900, "mr-IN": 0x0900, "bn-IN": 0x0980, "gu-IN": 0x0A80,
    "ta-IN": 0x0B80, "te-IN": 0x0C00, "kn-IN": 0x0C80, "ml-IN": 0x0D00,
}
BRAHMIC_START, BRAHMIC_END = 0x0900, 0x0D7F


def into_script(text: str, language_code: str) -> str:
    base = SCRIPT_BLOCKS.get(language_code)
    if base is None:
        return text
    output = []
    for character in text:
        code = ord(character)
        if BRAHMIC_START <= code <= BRAHMIC_END:
            mapped = base + (code - BRAHMIC_START) % 0x80
            output.append(chr(mapped) if unicodedata.name(chr(mapped), "") else character)
        else:
            output.append(character)
    return "".join(output)


def verifiable(heard: str, language_code: str) -> bool:
    """False when the recogniser answered mostly in Latin letters for an Indian language."""
    if language_code not in SCRIPT_BLOCKS:
        return True
    letters = [character for character in heard if character.isalpha()]
    if not letters:
        return False
    native = sum(1 for character in letters if BRAHMIC_START <= ord(character) <= BRAHMIC_END)
    return native >= 0.6 * len(letters)


def character_error_rate(expected: str, heard: str) -> float:
    reference, hypothesis = comparable(expected), comparable(heard)
    if not reference:
        return 0.0
    previous = list(range(len(hypothesis) + 1))
    for row, reference_char in enumerate(reference, 1):
        current = [row] + [0] * len(hypothesis)
        for column, hypothesis_char in enumerate(hypothesis, 1):
            current[column] = min(
                previous[column] + 1,
                current[column - 1] + 1,
                previous[column - 1] + (reference_char != hypothesis_char),
            )
        previous = current
    return previous[-1] / len(reference)


def transcribe(audio: np.ndarray, language_code: str, device: str) -> str:
    from scipy.signal import resample_poly

    speech = resample_poly(audio.astype(np.float32), 16_000, SAMPLE_RATE)
    features = ASR_PROCESSOR(speech, sampling_rate=16_000, return_tensors="pt").input_features
    features = features.to(device, dtype=next(ASR_MODEL.parameters()).dtype)
    with torch.inference_mode():
        tokens = ASR_MODEL.generate(
            features, language=WHISPER_LANGUAGES.get(language_code, "english"), task="transcribe",
        )
    return ASR_PROCESSOR.batch_decode(tokens, skip_special_tokens=True)[0]


def time_stretch(audio: np.ndarray, ratio: float) -> np.ndarray:
    """Speed speech up by `ratio` without changing its pitch (ffmpeg atempo)."""
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
         "-af", f"atempo={ratio:.5f}", "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "pipe:1"],
        input=audio.astype(np.float32).tobytes(), capture_output=True, timeout=60, check=True,
    )
    return np.frombuffer(result.stdout, dtype=np.float32).copy()


def clean_audio(wav_bytes: bytes) -> bytes:
    """Studio cleanup with ffmpeg; returns the input unchanged if ffmpeg is absent.

    ffmpeg cannot finalize a WAV header on a pipe (the size fields stay at
    0xFFFFFFFF), so it emits raw PCM and the header is written here.
    """
    if not shutil.which("ffmpeg"):
        return wav_bytes
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "wav", "-i", "pipe:0", "-af", CLEANUP_FILTER,
         "-ar", str(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1"],
        input=wav_bytes, capture_output=True, timeout=120, check=False,
    )
    if result.returncode != 0 or len(result.stdout) < SAMPLE_RATE // 10:
        return wav_bytes
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(result.stdout)
    return output.getvalue()


def synthesize(payload: dict[str, Any]) -> tuple[bytes, str]:
    scene_texts = payload.get("sceneTranscripts")
    if scene_texts is not None:
        if not isinstance(scene_texts, list) or len(scene_texts) not in (8, 12) or any(
            not isinstance(item, str) or not item.strip() for item in scene_texts
        ):
            raise ValueError("sceneTranscripts must contain eight or twelve nonempty sentences")
        transcript = " ".join(item.strip() for item in scene_texts)
        scene_seconds = float(payload.get("sceneDurationSeconds", 7.5))
        if not 3 <= scene_seconds <= 10:
            raise ValueError("sceneDurationSeconds is out of range")
        parts = [item.strip() for item in scene_texts]
    else:
        transcript = str(payload.get("transcript", "")).strip()
        scene_seconds = 0.0
        parts = chunks(transcript)
    language_code = str(payload.get("languageCode", ""))
    pace = str(payload.get("pace", "natural"))
    language = LANGUAGES.get(language_code)
    if not language or not transcript or len(transcript) > 8_000:
        raise ValueError("valid transcript and supported languageCode are required")

    requested = str(payload.get("speaker", "")).strip()
    speaker = requested if re.fullmatch(r"[A-Z][a-z]{1,19}", requested) else SPEAKERS.get(language_code, "Divya")
    description = (
        f"{speaker} speaks in a warm, friendly and slightly expressive tone, like a kind teacher "
        f"explaining something to a student, at a {'slightly fast' if pace == 'brisk' else 'moderate'} "
        "pace with natural rises and falls in pitch. The recording is very clear and "
        "close-sounding, with no background noise."
    )
    silence = np.zeros(int(SAMPLE_RATE * 0.34), dtype=np.float32)
    segments: list[np.ndarray] = []

    with MODEL_LOCK:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        try:
            MODEL.to(device)
            if ASR_MODEL is not None:
                ASR_MODEL.to(device)
            description_inputs = DESCRIPTION_TOKENIZER(description, return_tensors="pt").to(device)
            with torch.inference_mode():
                max_error = MAX_SPEECH_ERROR.get(language_code, DEFAULT_MAX_SPEECH_ERROR)
                for position, text_chunk in enumerate(parts):
                    prompt_inputs = PROMPT_TOKENIZER(text_chunk, return_tensors="pt").to(device)
                    best: tuple[float, np.ndarray] | None = None
                    takes = VOICE_ATTEMPTS if ASR_MODEL is not None else 1
                    for take in range(takes):
                        # Fixed seeds per sentence and take: repeatable voice,
                        # and a retry of one lesson reproduces the same audio.
                        torch.manual_seed(VOICE_SEED + position + 1000 * take)
                        generated = MODEL.generate(
                            input_ids=description_inputs.input_ids,
                            attention_mask=description_inputs.attention_mask,
                            prompt_input_ids=prompt_inputs.input_ids,
                            prompt_attention_mask=prompt_inputs.attention_mask,
                        )
                        candidate = trim_silence(generated.detach().float().cpu().numpy().squeeze())
                        if ASR_MODEL is None:
                            best = (0.0, candidate)
                            break
                        heard = transcribe(candidate, language_code, device)
                        if language_code == "en-IN":
                            heard = spell_english_digits(heard)
                        elif not verifiable(heard, language_code):
                            # The recogniser could not write this language; a
                            # retake would not be judged any better. Keep it.
                            print(f"[local-tts] take {language_code} s{position + 1}.{take + 1} unverifiable heard={heard[:80]!r}", flush=True)
                            best = (0.0, candidate) if best is None else best
                            break
                        heard = into_script(heard, language_code)
                        error = character_error_rate(text_chunk, heard)
                        print(f"[local-tts] take {language_code} s{position + 1}.{take + 1} error={error:.3f} heard={heard[:120]!r}", flush=True)
                        if best is None or error < best[0]:
                            best = (error, candidate)
                        if error <= max_error:
                            break
                    assert best is not None
                    if ASR_MODEL is not None:
                        status = "ok" if best[0] <= max_error else "best of takes"
                        print(f"[local-tts] sentence {position + 1}: speech error {best[0]:.2f} ({status}, {take + 1} take(s))", flush=True)
                    audio = best[1]
                    if scene_texts is not None:
                        slot_frames = round(scene_seconds * SAMPLE_RATE)
                        speech_frames = slot_frames - round(0.15 * SAMPLE_RATE)
                        if audio.size > speech_frames:
                            # A long sentence is sped up just enough to fit its
                            # scene instead of failing the whole lesson.
                            ratio = audio.size / speech_frames
                            if ratio > 2.0:
                                raise ValueError(
                                    f"scene {position + 1} speech is far too long for its "
                                    f"{scene_seconds:g}-second slot"
                                )
                            audio = time_stretch(audio, ratio)[:speech_frames]
                            print(f"[local-tts] scene {position + 1} sped up x{ratio:.2f} to fit", flush=True)
                        segments.append(np.pad(
                            audio.astype(np.float32), (0, slot_frames - audio.size),
                        ))
                    else:
                        segments.extend([audio.astype(np.float32), silence])
        finally:
            if device == "cuda":
                MODEL.to("cpu")
                if ASR_MODEL is not None:
                    ASR_MODEL.to("cpu")
                torch.cuda.empty_cache()

    waveform = np.concatenate(
        segments if scene_texts is not None else segments[:-1]
    ) if len(segments) > 1 else segments[0]
    peak = float(np.max(np.abs(waveform))) if waveform.size else 0.0
    if peak <= 0:
        raise RuntimeError("model returned silent audio")
    pcm = np.clip(waveform / max(1.0, peak), -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm16)
    output = io.BytesIO(clean_audio(output.getvalue()))
    return output.getvalue(), f"local-{language.lower().replace(' ', '-')}-educator"


def warm_up() -> None:
    """The first GPU generation pays ~90 s of CUDA initialisation; pay it at startup
    so the first lesson a user creates is not slow."""
    try:
        synthesize({"transcript": "Hello.", "languageCode": "en-IN", "pace": "natural"})
        print("[local-tts] warm-up complete", flush=True)
    except Exception as error:  # noqa: BLE001 - warm-up must never block startup
        print(f"[local-tts] warm-up skipped: {error}", flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "LuminaLocalTTS/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[local-tts] {self.address_string()} {fmt % args}", flush=True)

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_json(404, {"error": "not found"})
            return
        self.send_json(200, {"status": "ready", "model": "ai4bharat/indic-parler-tts", "local": True})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/synthesize":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("request body is empty or too large")
            audio, voice = synthesize(json.loads(self.rfile.read(length)))
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("X-Lumina-Model", "ai4bharat/indic-parler-tts")
            self.send_header("X-Lumina-Voice", voice)
            self.end_headers()
            self.wfile.write(audio)
        except Exception as exc:
            print(f"[local-tts] request failed: {type(exc).__name__}: {exc}", flush=True)
            self.send_json(500, {"error": f"Local narration failed: {type(exc).__name__}"})


if __name__ == "__main__":
    warm_up()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
