"""The five stages, driven through the services the production worker uses.

Every request shape here was read out of `ops/runpod/local_*_service.py` and
`ops/runpod/media_worker.py` rather than chosen. That matters more than it
sounds: an invented path like `/speak` instead of `/synthesize` fails only on
a host where everything else is correctly installed, which is the worst
possible moment to discover it. `contract_tests.py` pins the shapes so a
service change breaks a test rather than a benchmark run.

Nothing here falls back. A stage that cannot run raises, and the harness
records the failure.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import local_models as lm

# One real lesson, fixed so two runs are comparable. Class 10 Science is a
# genuine KTBS subject and the chapter is a real one.
LESSON = {
    "classLevel": 10,
    "subject": "Science",
    "chapter": "Carbon and its Compounds",
    "topic": "Why carbon forms four bonds",
}

PLAN_SCHEMA = {
    "type": "object",
    "required": ["title", "learningObjective", "visualBible", "scenes"],
    "properties": {
        "title": {"type": "string"},
        "learningObjective": {"type": "string"},
        "visualBible": {"type": "string"},
        "scenes": {
            "type": "array", "minItems": 4, "maxItems": 4,
            "items": {
                "type": "object",
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

SYSTEM_PROMPT = (
    "You write four-scene lesson plans for Karnataka State syllabus classrooms. "
    "Each scene is 7.5 seconds. Narration is one sentence a teacher would say aloud. "
    "The visual description never contains text, letters or labels."
)

# A fixed fallback narration, used only when the planner stage did not run, so
# the TTS stage can still be measured independently. It is real Kannada, and
# the harness records that the plan did not produce it.
SAMPLE_NARRATION = {
    "en-IN": "A carbon atom has four electrons to share, so it forms four bonds.",
    "hi-IN": "कार्बन परमाणु चार इलेक्ट्रॉन साझा करता है, इसलिए वह चार बंध बनाता है।",
    "kn-IN": "ಇಂಗಾಲದ ಪರಮಾಣು ನಾಲ್ಕು ಎಲೆಕ್ಟ್ರಾನ್ ಹಂಚಿಕೊಂಡು ನಾಲ್ಕು ಬಂಧ ರಚಿಸುತ್ತದೆ.",
}

# Unicode blocks, for checking a translation came back in the right script.
SCRIPT_RANGES = {
    "kn-IN": [(0x0C80, 0x0CFF)],
    "hi-IN": [(0x0900, 0x097F)],
    "en-IN": [(0x0041, 0x005A), (0x0061, 0x007A)],
}


def native_script_ratio(text: str, language_code: str) -> float:
    """How much of this text is in the script the language uses.

    The smoke suite applies the same check to translations. It is a property of
    the TEXT, and says nothing about what a TTS model pronounced — audio
    language identification would need a classifier this stack does not have.
    """
    ranges = SCRIPT_RANGES.get(language_code, [])
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    native = sum(any(lo <= ord(c) <= hi for lo, hi in ranges) for c in letters)
    return native / len(letters)


# ── ComfyUI helpers ─────────────────────────────────────────────────────────

def comfy_outputs(history_entry: dict) -> list[dict]:
    """Every file a finished prompt produced, as ComfyUI reports them."""
    out: list[dict] = []
    for node in (history_entry.get("outputs") or {}).values():
        for key in ("images", "gifs", "videos"):
            for item in node.get(key) or []:
                if isinstance(item, dict) and item.get("filename"):
                    out.append(item)
    return out


def comfy_fetch(comfy_url: str, item: dict, timeout: float = 300.0) -> bytes:
    """Download one output through /view, the path the worker uses."""
    query = urllib.parse.urlencode({
        "filename": item["filename"],
        "subfolder": item.get("subfolder", ""),
        "type": item.get("type", "output"),
    })
    url = f"{comfy_url.rstrip('/')}/view?{query}"
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read()


def run_comfy_workflow(
    comfy_url: str, workflow_path: Path, values: dict, *, deadline: float,
) -> tuple[bytes, dict]:
    """Fill a shipped workflow, queue it, wait, and fetch the first output."""
    template = json.loads(workflow_path.read_text(encoding="utf-8"))
    filled = lm.fill_workflow(template, values)
    prompt_id = lm.submit_comfy(comfy_url, filled)
    entry = lm.await_comfy(comfy_url, prompt_id, deadline_seconds=deadline)
    outputs = comfy_outputs(entry)
    if not outputs:
        raise lm.LocalModelError(
            f"ComfyUI finished prompt {prompt_id} but produced no output file; "
            "check that the workflow's save node ran")
    return comfy_fetch(comfy_url, outputs[0]), {
        "prompt_id": prompt_id,
        "output_filename": outputs[0]["filename"],
        "output_count": len(outputs),
    }


# ── The stages ──────────────────────────────────────────────────────────────

def stage_plan(ctx: dict) -> dict:
    """Qwen3-4B, through the planner's /structured endpoint."""
    envelope = lm.plan_structured(
        ctx["endpoints"]["planner"], SYSTEM_PROMPT,
        f"Class {LESSON['classLevel']} {LESSON['subject']}, chapter "
        f"\"{LESSON['chapter']}\". Topic: {LESSON['topic']}.",
        PLAN_SCHEMA, max_new_tokens=3200, timeout=ctx["timeouts"]["plan"])
    output = envelope.get("output")
    if not isinstance(output, dict) or not output.get("scenes"):
        raise lm.LocalModelError("planner returned no scenes")
    scenes = output["scenes"]
    if len(scenes) != 4:
        raise lm.LocalModelError(f"planner returned {len(scenes)} scenes, expected 4")
    ctx["plan"] = output
    return {
        "model": envelope.get("model"),
        "scene_count": len(scenes),
        "title": str(output.get("title", ""))[:120],
        "has_visual_bible": bool(str(output.get("visualBible", "")).strip()),
        "first_narration_chars": len(str(scenes[0].get("narration", ""))),
    }


def stage_keyframe(ctx: dict) -> dict:
    """Z-Image Turbo, through the shipped image-fast workflow."""
    plan = ctx.get("plan")
    visual = (plan["scenes"][0]["visual"] if plan
              else "a single carbon atom with four bonds radiating outward, flat vector")
    style = (plan.get("visualBible", "") if plan else "")
    prompt = f"{style} {visual}".strip() + "; no text, no letters, no labels"

    png, meta = run_comfy_workflow(
        ctx["endpoints"]["comfy"], ctx["workflows"] / "image-fast.json",
        {"prompt": prompt, "width": 1920, "height": 1088, "seed": ctx["seed"]},
        deadline=ctx["timeouts"]["keyframe"])

    if not png.startswith(b"\x89PNG"):
        raise lm.LocalModelError(f"keyframe is not a PNG ({len(png)} bytes)")
    ctx["keyframe_bytes"] = png
    path = ctx["out_dir"] / "keyframe.png"
    path.write_bytes(png)
    ctx["keyframe_path"] = path
    return {**meta, "bytes": len(png), "prompt_chars": len(prompt),
            "from_plan": plan is not None, "saved": str(path)}


def stage_vision(ctx: dict) -> dict:
    """Qwen2.5-VL-7B on the keyframe, through the worker's /check contract."""
    png = ctx.get("keyframe_bytes")
    if png is None:
        raise lm.LocalModelError("no keyframe to check; the keyframe stage did not run")
    plan = ctx.get("plan")
    description = (plan["scenes"][0]["visual"] if plan
                   else "a single carbon atom with four bonds radiating outward")
    verdict = lm.vision_check(ctx["endpoints"]["vision"], png, description,
                              mode="image", timeout=ctx["timeouts"]["vision"])
    # A verdict is a result, not a failure: a rejected frame is the check
    # working. The stage fails only if the service could not answer.
    return {
        "passed": bool(verdict.get("passed", False)),
        "shows_subject": verdict.get("shows_subject"),
        "deformed": verdict.get("deformed"),
        "has_writing": verdict.get("has_writing"),
        "unsafe": verdict.get("unsafe"),
        "reason": str(verdict.get("reason", ""))[:200],
    }


def stage_motion(ctx: dict) -> dict:
    """Wan 2.2 TI2V-5B, animating the approved keyframe."""
    keyframe = ctx.get("keyframe_path")
    if keyframe is None:
        raise lm.LocalModelError("no keyframe to animate; the keyframe stage did not run")

    # ComfyUI's LoadImage reads from its own input directory, which is how the
    # production worker supplies a source image too.
    comfy_input = ctx.get("comfy_input_dir")
    if comfy_input is None:
        raise lm.LocalModelError(
            "COMFYUI_INPUT_DIR is not set, so the keyframe cannot be handed to LoadImage")
    name = f"lumina-bench-{ctx['seed']}.png"
    (Path(comfy_input) / name).write_bytes(keyframe.read_bytes())

    plan = ctx.get("plan")
    motion = (plan["scenes"][0]["motion"] if plan
              else "slow push in; the bonds brighten in turn; labels hold still")
    frames = ((round(7.5 * 24) + 3) // 4) * 4 + 1          # Wan needs 4n+1

    clip, meta = run_comfy_workflow(
        ctx["endpoints"]["comfy"], ctx["workflows"] / "video-fast.json",
        {"prompt": motion,
         "negative_prompt": "text, letters, watermark, changing labels, morphing geometry",
         "width": 1280, "height": 704, "frames": frames, "seed": ctx["seed"],
         "steps": int(ctx.get("wan_steps", 20)), "fps": 24, "source_image": name},
        deadline=ctx["timeouts"]["motion"])

    path = ctx["out_dir"] / "clip.webm"
    path.write_bytes(clip)
    ctx["clip_path"] = path
    return {**meta, "bytes": len(clip), "frames_requested": frames,
            "seconds_requested": round(frames / 24, 3), "saved": str(path)}


def stage_tts(ctx: dict) -> dict:
    """Indic Parler-TTS, once per requested language, measured from the samples."""
    from benchmark import wav_facts            # local import: same package

    plan = ctx.get("plan")
    results: dict = {}
    for language in ctx["languages"]:
        if plan and language == "en-IN":
            text = str(plan["scenes"][0]["narration"])
            source = "plan"
        elif plan and ctx.get("translations", {}).get(language):
            text = ctx["translations"][language]
            source = "translation"
        else:
            text = SAMPLE_NARRATION[language]
            source = "fixed sample"

        started = time.monotonic()
        audio = lm.synthesize(ctx["endpoints"]["tts"], text, language,
                              pace="natural", scene_seconds=7.5,
                              timeout=ctx["timeouts"]["tts"])
        elapsed = time.monotonic() - started

        path = ctx["out_dir"] / f"narration-{language}.wav"
        path.write_bytes(audio)
        facts = wav_facts(path)
        results[language] = {
            **facts,
            "synthesis_seconds": round(elapsed, 3),
            # Over 1.0 means synthesis took longer than the audio lasts.
            "realtime_factor": round(elapsed / facts["measured_seconds"], 3)
            if facts["measured_seconds"] else None,
            "text_source": source,
            "text_native_script_ratio": round(native_script_ratio(text, language), 3),
            "fits_slot": facts["measured_seconds"] <= 7.5,
            "saved": str(path),
        }
        if not facts["non_silent"]:
            raise lm.LocalModelError(
                f"{language} narration is silent (rms {facts['rms']}); "
                "the TTS service answered but produced no speech")
    ctx["narration"] = results
    return results


def stage_translate(ctx: dict) -> dict:
    """IndicTrans2 on CPU. Measured because it sits on the lesson's path."""
    plan = ctx.get("plan")
    english = (str(plan["scenes"][0]["narration"]) if plan else SAMPLE_NARRATION["en-IN"])
    targets = [lang for lang in ctx["languages"] if lang != "en-IN"]
    if not targets:
        return {"skipped": "no non-English language requested"}

    out: dict = {}
    ctx.setdefault("translations", {})
    for language in targets:
        started = time.monotonic()
        translated = lm.translate(ctx["endpoints"]["translate"], [english], language,
                                  timeout=ctx["timeouts"]["translate"])
        elapsed = time.monotonic() - started
        text = translated[0]
        ratio = native_script_ratio(text, language)
        ctx["translations"][language] = text
        out[language] = {
            "seconds": round(elapsed, 3),
            "native_script_ratio": round(ratio, 3),
            "chars": len(text),
            "sample": text[:80],
        }
        if ratio < 0.55:
            raise lm.LocalModelError(
                f"{language} translation is only {ratio:.0%} native script; "
                "the service returned the wrong language")
    return out


STAGES = {
    "plan": stage_plan,
    "translate": stage_translate,
    "keyframe": stage_keyframe,
    "vision": stage_vision,
    "motion": stage_motion,
    "tts": stage_tts,
}

# Which stages touch the GPU, so the harness knows when to watch the device.
GPU_STAGES = {"plan", "keyframe", "vision", "motion", "tts"}
