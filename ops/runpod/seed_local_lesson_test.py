#!/usr/bin/env python3
"""Seed one fully local narrated-lesson test into the production queue.

Run on the GPU worker after sourcing /root/lumina-media-worker.env. It uses the
loopback planner, translator and TTS services, then inserts the audited project
into Supabase for the normal media worker to render and assemble.
"""

from __future__ import annotations

import argparse
import json
import re
import os
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
import uuid
import wave
from io import BytesIO
from pathlib import Path
from typing import Any


SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
PLANNER_URL = os.environ.get("LOCAL_VIDEO_AGENT_URL", "http://127.0.0.1:18080")
TRANSLATION_URL = os.environ.get("LOCAL_VIDEO_TRANSLATION_URL", "http://127.0.0.1:18082")
TTS_URL = os.environ.get("LOCAL_VIDEO_TTS_URL", "http://127.0.0.1:18081")


def request(
    method: str,
    url: str,
    payload: Any | None = None,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 300,
    expect_json: bool = True,
) -> Any:
    body = data
    request_headers = dict(headers or {})
    request_headers.setdefault("User-Agent", "LuminaLessonAcceptance/1.0")
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            result = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"HTTP {error.code} from {urllib.parse.urlparse(url).path}: {detail}") from error
    return json.loads(result or b"null") if expect_json else result


def local_post(port_url: str, path: str, payload: dict[str, Any], *, raw: bool = False) -> Any:
    return request("POST", f"{port_url.rstrip('/')}{path}", payload, expect_json=not raw)


def supabase(method: str, path: str, payload: Any | None = None, *, prefer: str = "") -> Any:
    headers = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
    if prefer:
        headers["Prefer"] = prefer
    return request(method, f"{SUPABASE_URL}{path}", payload, headers=headers)


def owner_id(project_id: str | None = None) -> str:
    if project_id:
        query = urllib.parse.urlencode({
            "select": "owner_id", "id": f"eq.{project_id}", "limit": "1",
        })
        rows = supabase("GET", f"/rest/v1/lesson_video_projects?{query}")
        if len(rows) == 1 and rows[0].get("owner_id"):
            return str(rows[0]["owner_id"])
        raise RuntimeError("The reference lesson project has no owner")
    for table in ("lesson_video_projects", "video_projects", "decks"):
        query = urllib.parse.urlencode(
            {"select": "owner_id", "order": "created_at.desc", "limit": "1"}
        )
        rows = supabase("GET", f"/rest/v1/{table}?{query}")
        if rows and rows[0].get("owner_id"):
            return str(rows[0]["owner_id"])
    raise RuntimeError("No existing project owner was found for the end-to-end test")


HOUSE_STYLE = (
    "Vintage editorial photograph with muted warm tones, soft diffused window light, gentle "
    "film grain, shallow depth of field, the subject centered and fully visible against a plain "
    "seamless warm-grey studio backdrop, generous empty space around it."
)
PRINTED_MATTER = re.compile(  # mirror of PRINTED_MATTER in src/lib/videos/planner.ts
    r"\b(text|labels?|captions?|letters|lettering|numerals?|digits?|equations?|formulas?|"
    r"signboards?|charts?|graphs?|diagrams?|infographics?|posters?|"
    r"(?:black|white|chalk|bulletin|notice)boards?|screens?|monitors?|pages?|books?|notebooks?|"
    r"newspapers?|documents?|storyboards?|maps?|scrolls?|manuscripts?|parchments?|written|"
    r"writing|inscriptions?|inscribed)\b",
    re.IGNORECASE,
)
OVERLAY_SCHEMA = {
    "type": "object",
    "required": ["kind"],
    "properties": {
        "kind": {"type": "string", "enum": ["none", "arrow", "equation", "groups", "bars", "timeline"]},
        "years": {"type": "array", "items": {"type": "integer"}, "maxItems": 6},
        "current": {"type": "integer"},
        "direction": {"type": "string", "enum": [
            "up", "down", "left", "right", "up-right", "down-right", "down-left", "up-left",
        ]},
        "steps": {"type": "array", "items": {"type": "string", "maxLength": 32}, "maxItems": 4},
        "groups": {"type": "array", "maxItems": 5, "items": {
            "type": "object", "required": ["count"],
            "properties": {"count": {"type": "integer"}, "token": {"type": "string"}},
        }},
        "showTotal": {"type": "boolean"},
        "values": {"type": "array", "items": {"type": "number"}, "maxItems": 6},
        "unit": {"type": "string", "maxLength": 6},
    },
}
def _math_function(expression: str):
    source = expression.replace(" ", "").replace("^", "**")
    if not re.fullmatch(r"[0-9a-z+\-*/().]+", source.replace("**", "*")):
        raise ValueError("unsupported math")
    source = re.sub(r"(?<=[0-9a-z)])(?=[a-z(])", "*", source)
    code = compile(source, "<overlay>", "eval")
    names = set(code.co_names)
    if any(len(name) != 1 for name in names):
        raise ValueError("variables must be single letters")
    return (lambda values: eval(code, {"__builtins__": {}}, values)), names  # noqa: S307


def audit_overlay(overlay: Any, fact: str) -> tuple[dict[str, Any], str | None]:
    """Mirror of src/lib/videos/overlays.ts auditOverlay for acceptance seeding."""
    if not isinstance(overlay, dict) or overlay.get("kind") in (None, "none"):
        return {"kind": "none"}, None
    kind = overlay["kind"]
    if kind == "arrow":
        return {"kind": "arrow", "direction": overlay.get("direction", "right")}, None
    fact_numbers = {str(float(n)) for n in re.findall(r"\d+(?:\.\d+)?", fact)}
    if kind == "equation":
        steps = [str(step).strip().lower() for step in overlay.get("steps") or []]
        shown = " ".join(steps)
    elif kind == "groups":
        groups = overlay.get("groups") or []
        shown = " ".join(str(g.get("count")) for g in groups)
        if overlay.get("showTotal"):
            shown += f" {sum(int(g.get('count') or 0) for g in groups)}"
    elif kind == "bars":
        shown = " ".join(str(v) for v in overlay.get("values") or [])
    else:
        return {"kind": "none"}, f"unsupported kind {kind}"
    missing = {str(float(n)) for n in re.findall(r"\d+(?:\.\d+)?", shown)} - fact_numbers
    if missing:
        return {"kind": "none"}, f"numbers {sorted(missing)} are not in the fact"
    if kind == "equation":
        try:
            roots = []
            for step in steps:
                sides = step.split("=")
                if len(sides) != 2:
                    raise ValueError("each step must be one equation")
                left, left_names = _math_function(sides[0])
                right, right_names = _math_function(sides[1])
                names = left_names | right_names
                if len(names) != 1:
                    raise ValueError("one variable per equation")
                (name,) = names
                f = lambda v: left({name: v}) - right({name: v})  # noqa: E731
                slope = f(1) - f(0)
                if abs(slope) < 1e-9 or any(abs(f(p) - (f(0) + slope * p)) > 1e-6 for p in (-2, 3.5)):
                    raise ValueError("equations must be linear")
                roots.append(-f(0) / slope)
            if any(abs(root - roots[0]) > 1e-6 for root in roots):
                raise ValueError("steps do not share one solution")
        except (ValueError, SyntaxError, ZeroDivisionError, TypeError) as error:
            return {"kind": "none"}, f"equation dropped: {error}"
        return {"kind": "equation", "steps": steps}, None
    return dict(overlay), None


def load_prompts() -> dict[str, str]:
    here = Path(__file__).resolve().parent
    candidates = [
        Path(os.environ.get("LESSON_PROMPTS_PATH", "")),
        here / "lesson-prompts.json",
        here.parent.parent / "src/lib/videos/lesson-prompts.json",
    ]
    for candidate in candidates:
        if candidate.name and candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise RuntimeError("lesson-prompts.json was not found next to the seeder or in src/lib/videos")


def fill(template: str, values: dict[str, Any]) -> str:
    return re.sub(r"\{\{(\w+)\}\}", lambda match: str(values.get(match.group(1), "")), template)


def structured(stage: str, system: str, user: str, schema: dict[str, Any],
               check: Any, attempts: int = 3) -> dict[str, Any]:
    """Call the local planner with validation feedback, like generateLocalStructured."""
    correction = ""
    errors: list[str] = []
    for _attempt in range(attempts):
        result = local_post(PLANNER_URL, "/structured", {
            "stage": stage, "maxNewTokens": 4000, "jsonSchema": schema,
            "systemPrompt": system, "userPrompt": user + correction,
        })
        output = result["output"]
        errors = check(output)
        if not errors:
            return output
        correction = (
            "\n\nYour previous JSON failed validation. Correct every listed problem and return "
            "the complete JSON again.\nValidation problems:\n- " + "\n- ".join(errors[:12])
            + ("\nRewrite the visual plan from scratch using physical props only."
               if stage == "video-lesson-director"
               else "\nPrevious JSON:\n" + json.dumps(output, ensure_ascii=False))
        )
    raise RuntimeError(f"{stage} failed validation: " + "; ".join(errors))


def clean_caption(caption: Any) -> str:
    """Mirror of cleanCaption in planner.ts: drop math tokens, keep five words."""
    words = [
        word.strip(",.;:!?\"'()")
        for word in str(caption or "").split()
        if not re.search(r"[0-9=+*/^<>]", word)
    ]
    return " ".join(word for word in words if word)[:40].strip() if words else ""


def sequential(scenes: list[dict[str, Any]], count: int) -> list[str]:
    if len(scenes) != count or any(s.get("index") != i for i, s in enumerate(scenes, 1)):
        return [f"Return exactly {count} scenes numbered 1 to {count}."]
    return []


def plan_lesson(args: argparse.Namespace) -> dict[str, Any]:
    prompts = load_prompts()
    count = 8
    values = {
        "duration": 60, "classLevel": args.class_level, "subject": args.subject,
        "topic": args.topic, "sceneCount": count, "languageLabel": args.language_name,
    }
    writer_schema = {
        "type": "object",
        "required": ["title", "learningObjective", "scenes"],
        "properties": {
            "title": {"type": "string"},
            "learningObjective": {"type": "string"},
            "scenes": {"type": "array", "minItems": count, "maxItems": count, "items": {
                "type": "object",
                "required": ["index", "fact", "narration", "caption", "overlay"],
                "properties": {
                    "index": {"type": "integer"}, "fact": {"type": "string"},
                    "narration": {"type": "string"}, "caption": {"type": "string"},
                    "overlay": OVERLAY_SCHEMA,
                },
            }},
        },
    }

    def check_writer(output: dict[str, Any]) -> list[str]:
        scenes = output.get("scenes") or []
        errors = sequential(scenes, count)
        for scene in scenes:
            if re.search(r"[0-9=+*/^<>]", str(scene.get("narration", ""))):
                errors.append(
                    f"Scene {scene.get('index')} narration is spoken aloud: write numbers and "
                    "operations as words, no digits or symbols."
                )
            words = len(str(scene.get("narration", "")).split())
            if not 7 <= words <= 18:
                errors.append(f"Scene {scene.get('index')} narration has {words} words; use 10-14.")
            scene["caption"] = " ".join(clean_caption(scene.get("caption")).split()[:5])
            if len(scene["caption"]) < 3:
                errors.append(f"Scene {scene.get('index')} caption must be a 1-5 word headline without digits.")
        return errors

    written = structured(
        "video-lesson-writer", fill(prompts["writerSystem"], values),
        fill(prompts["writerUser"], values), writer_schema, check_writer,
    )
    scenes = written["scenes"]

    problems = []
    for scene in scenes:
        _overlay, issue = audit_overlay(scene.get("overlay"), str(scene["fact"]))
        if issue:
            problems.append({"index": scene["index"], "fact": scene["fact"],
                             "overlay": scene.get("overlay"), "problem": issue})
    if problems:
        print(f"repairing overlays: {json.dumps(problems, ensure_ascii=False)}", file=sys.stderr)
        repair_schema = {"type": "object", "required": ["scenes"], "properties": {"scenes": {
            "type": "array", "items": {"type": "object", "required": ["index", "fact", "overlay"],
                                       "properties": {"index": {"type": "integer"},
                                                      "fact": {"type": "string"},
                                                      "overlay": OVERLAY_SCHEMA}}}}}
        try:
            repaired = structured(
                "video-lesson-math-repair", prompts["repairSystem"],
                fill(prompts["repairUser"], {
                    "topic": args.topic,
                    "lesson": json.dumps([{"index": s["index"], "fact": s["fact"]} for s in scenes]),
                    "problems": json.dumps(problems, ensure_ascii=False),
                }),
                repair_schema, lambda _output: [], attempts=1,
            )["scenes"]
        except RuntimeError as error:
            print(f"overlay repair failed: {error}", file=sys.stderr)
            repaired = []
        for fix in repaired:
            for scene in scenes:
                if scene["index"] == fix.get("index"):
                    scene["fact"], scene["overlay"] = fix["fact"], fix["overlay"]
    for scene in scenes:
        scene["overlay"], issue = audit_overlay(scene.get("overlay"), str(scene["fact"]))
        if issue:
            print(f"scene {scene['index']} overlay dropped: {issue}", file=sys.stderr)

    director_schema = {
        "type": "object",
        "required": ["visualBible", "scenes"],
        "properties": {
            "visualBible": {"type": "string"},
            "scenes": {"type": "array", "minItems": count, "maxItems": count, "items": {
                "type": "object",
                "required": ["index", "visualDescription", "motionDescription"],
                "properties": {"index": {"type": "integer"},
                               "visualDescription": {"type": "string"},
                               "motionDescription": {"type": "string"}},
            }},
        },
    }

    def check_director(output: dict[str, Any]) -> list[str]:
        directed = output.get("scenes") or []
        errors = sequential(directed, count)
        seen_visuals: set[str] = set()
        if len(str(output.get("visualBible") or "")) < 40:
            errors.append("visualBible must list the recurring props (40-500 characters).")
        for scene in directed:
            visual = str(scene.get("visualDescription", ""))
            match = PRINTED_MATTER.search(visual)
            if match:
                errors.append(
                    f"Scene {scene.get('index')} visualDescription mentions '{match.group(0)}'; "
                    "describe only physical objects."
                )
            visual_key = re.sub(r"[^a-z0-9]+", " ", visual.lower()).strip()
            if visual_key in seen_visuals:
                errors.append(
                    f"Scene {scene.get('index')} duplicates another physical starting arrangement."
                )
            seen_visuals.add(visual_key)
            motion = str(scene.get("motionDescription", ""))
            if not all(marker in motion for marker in ("Start:", "Then:", "End:")):
                errors.append(f"Scene {scene.get('index')} motion must contain Start:, Then:, End:.")
        return errors

    director_system = prompts["directorSystem"]
    if re.search(r"computer science|python|programming|coding|algorithm|(?:for|while) loops?",
                 f"{args.subject} {args.topic}", re.IGNORECASE):
        director_system += (
            "\n\nFor programming lessons, NEVER depict a computer, monitor, terminal, "
            "code, or anything printed. Use one recurring tangible analogy: a small wooden "
            "conveyor track with colored wooden tokens, one brass action lever, and a movable "
            "stop gate. Tokens passing the lever illustrate repeated execution; the stop gate "
            "illustrates termination. Give every scene a visibly different starting state: "
            "vary which tokens are at the entrance, under the lever, beyond the lever or "
            "against the gate; whether the lever is raised or lowered; and whether the gate "
            "is open or closed. The arrangement and physical action must mirror that scene's "
            "audited fact. Do not repeat any visualDescription. Exact Python syntax belongs "
            "in narration or verified software-drawn overlays, never in the photograph."
        )
    directed = structured(
        "video-lesson-director", director_system,
        fill(prompts["directorUser"], {**values, "scenes": json.dumps(
            [{"index": s["index"], "fact": s["fact"], "caption": s["caption"]} for s in scenes],
            ensure_ascii=False,
        )}),
        director_schema, check_director,
    )
    for scene, direction in zip(scenes, directed["scenes"]):
        scene["visualDescription"] = direction["visualDescription"]
        scene["motionDescription"] = direction["motionDescription"]
    return {
        "title": args.topic,
        "learningObjective": written["learningObjective"],
        "visualBible": directed["visualBible"],
        "scenes": scenes,
    }


def translate_plan(plan: dict[str, Any], language_code: str) -> dict[str, Any]:
    plan = json.loads(json.dumps(plan))
    if language_code == "en-IN":
        return plan
    scenes = plan["scenes"]
    texts = [
        plan["title"],
        *[scene["narration"] for scene in scenes],
        *[scene["caption"] for scene in scenes],
    ]
    translated = local_post(
        TRANSLATION_URL, "/translate", {"texts": texts, "languageCode": language_code}
    )["translations"]
    if len(translated) != len(texts):
        raise RuntimeError("Translation response did not preserve the scene count")
    plan["title"] = translated[0]
    for index, scene in enumerate(scenes):
        scene["narration"] = translated[index + 1]
        scene["caption"] = translated[len(scenes) + index + 1].strip().rstrip("।.").strip()
    return plan


def synthesize(plan: dict[str, Any], language_code: str) -> tuple[bytes, float]:
    transcript = " ".join(scene["narration"].strip() for scene in plan["scenes"])
    audio = local_post(
        TTS_URL,
        "/synthesize",
        {"transcript": transcript, "languageCode": language_code, "pace": "natural"},
        raw=True,
    )
    with wave.open(BytesIO(audio), "rb") as wav:
        duration = wav.getnframes() / wav.getframerate()
    if not 20 <= duration <= 90:
        raise RuntimeError(f"Unexpected narration duration: {duration:.2f} seconds")
    return audio, duration


def seed(
    plan: dict[str, Any], audio: bytes, audio_duration: float, args: argparse.Namespace,
) -> str:
    project_id = str(uuid.uuid4())
    owner = owner_id(args.owner_project_id)
    narration = " ".join(scene["narration"].strip() for scene in plan["scenes"])
    project = {
        "id": project_id,
        "owner_id": owner,
        "class_level": args.class_level,
        "subject": args.subject,
        "topic": args.topic,
        "language_code": args.language,
        "language_name": args.language_name,
        "target_duration_seconds": 60,
        "title": plan["title"],
        "learning_objective": plan["learningObjective"],
        "narration_text": narration,
        "narration_duration_seconds": round(audio_duration, 3),
        "status": "generating_images",
    }
    supabase("POST", "/rest/v1/lesson_video_projects", project, prefer="return=minimal")

    storage_path = f"{project_id}/narration.wav"
    encoded_path = urllib.parse.quote(storage_path, safe="/")
    request(
        "POST",
        f"{SUPABASE_URL}/storage/v1/object/lesson-video-assets/{encoded_path}",
        data=audio,
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
            "Content-Type": "audio/wav",
            "x-upsert": "false",
        },
        expect_json=False,
    )
    narration_url = f"{SUPABASE_URL}/storage/v1/object/public/lesson-video-assets/{encoded_path}"
    query = urllib.parse.urlencode({"id": f"eq.{project_id}"})
    supabase(
        "PATCH",
        f"/rest/v1/lesson_video_projects?{query}",
        {"narration_url": narration_url},
        prefer="return=minimal",
    )

    scene_rows: list[dict[str, Any]] = []
    job_rows: list[dict[str, Any]] = []
    for scene in plan["scenes"]:
        scene_id = str(uuid.uuid4())
        visual = str(scene["visualDescription"]).strip()
        # Keep in sync with create_lesson_video_project in
        # supabase/migrations/20260925150000_editorial_lesson_compositor.sql.
        image_prompt = f"{visual} {HOUSE_STYLE}"
        video_prompt = (
            f"{visual} Animate the subject physically: {scene['motionDescription']} Smooth, "
            "purposeful, physically plausible motion with stable object identity and a clear "
            "final state; the camera stays nearly still."
        )
        scene_rows.append(
            {
                "id": scene_id,
                "project_id": project_id,
                "scene_index": scene["index"],
                "duration_seconds": 7.5,
                "fact": scene["fact"],
                "narration": scene["narration"],
                "caption": scene["caption"],
                "overlay": scene["overlay"],
                "image_prompt": image_prompt,
                "video_prompt": video_prompt,
            }
        )
        if scene["index"] > args.scenes:
            continue
        job_rows.append(
            {
                "owner_id": owner,
                "project_id": project_id,
                "scene_id": scene_id,
                "kind": "image",
                "profile": "image-fast",
                "prompt": image_prompt,
                "negative_prompt": "text, writing, letters, numbers, watermark, logo",
                "max_attempts": 4,
                "parameters": {
                    "width": 1024,
                    "height": 576,
                    "steps": 8,
                    "sceneIndex": scene["index"],
                    "seed": 1000 + int(scene["index"]),
                },
            }
        )
    supabase("POST", "/rest/v1/lesson_video_scenes", scene_rows, prefer="return=minimal")
    supabase("POST", "/rest/v1/lesson_video_jobs", job_rows, prefer="return=minimal")
    return project_id


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--auth-check", action="store_true")
    parser.add_argument("--owner-project-id", help="Use the owner of this existing lesson project")
    parser.add_argument("--class-level", type=int, default=8)
    parser.add_argument("--subject", default="Mathematics")
    parser.add_argument("--topic", default="Algebra: solving simple linear equations")
    parser.add_argument("--language", default="kn-IN")
    parser.add_argument("--language-name", default="Kannada")
    parser.add_argument(
        "--scenes", type=int, default=8,
        help="Queue media only for the first N scenes (cheap visual acceptance)",
    )
    parser.add_argument("--plan-only", action="store_true", help="Print the audited plan and exit")
    args = parser.parse_args()
    if not SUPABASE_URL or not SERVICE_KEY:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    if args.auth_check:
        print(json.dumps({"authenticated": bool(owner_id(args.owner_project_id))}))
        return 0
    started = time.monotonic()
    plan = plan_lesson(args)
    planned = time.monotonic()
    if args.plan_only:
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return 0
    plan = translate_plan(plan, args.language)
    translated = time.monotonic()
    audio, duration = synthesize(plan, args.language)
    voiced = time.monotonic()
    project_id = seed(plan, audio, duration, args)
    print(
        json.dumps(
            {
                "projectId": project_id,
                "title": plan["title"],
                "captions": [scene["caption"] for scene in plan["scenes"]],
                "overlays": [scene["overlay"]["kind"] for scene in plan["scenes"]],
                "narrationDurationSeconds": round(duration, 3),
                "queuedScenes": min(8, args.scenes),
                "timings": {
                    "planning": round(planned - started, 2),
                    "translation": round(translated - planned, 2),
                    "voice": round(voiced - translated, 2),
                    "totalBeforeQueue": round(time.monotonic() - started, 2),
                },
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
