#!/usr/bin/env python3
"""Queue a lesson prepared by scripts/prepare-lesson-files.ts for rendering.

Mirrors complete_lesson_video_preparation + set_lesson_video_narration (see
supabase/migrations/20260927090000_timeline_overlay.sql) using the worker's
service credential, so the owner-scoped media worker renders it exactly like a
website request. Run on the Pod after sourcing /root/lumina-media-worker.env:

  python3 seed_prepared_lesson.py <dir with lesson.json + narration.wav> \
    --owner-project-id <existing project of the same owner>
"""

from __future__ import annotations

import argparse
import json
import urllib.parse
import uuid
from pathlib import Path

from seed_local_lesson_test import SERVICE_KEY, SUPABASE_URL, request, supabase

HOUSE_STYLE = (
    "Vintage editorial photograph with muted warm tones, soft diffused window light, gentle "
    "film grain, shallow depth of field, the subject centered and fully visible against a plain "
    "seamless warm-grey studio backdrop, generous empty space around it."
)
NEGATIVE_PROMPT = (
    "text, writing, letters, numbers, watermark, logo, distorted anatomy, duplicate subjects, "
    "low quality"
)


def owner_of(project_id: str) -> str:
    query = urllib.parse.urlencode({"id": f"eq.{project_id}", "select": "owner_id", "limit": "1"})
    rows = supabase("GET", f"/rest/v1/lesson_video_projects?{query}")
    if not rows:
        raise SystemExit("Owner reference project was not found")
    return str(rows[0]["owner_id"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("lesson_dir")
    parser.add_argument("--owner-project-id", required=True)
    args = parser.parse_args()
    folder = Path(args.lesson_dir)
    lesson = json.loads((folder / "lesson.json").read_text(encoding="utf-8"))
    audio = (folder / "narration.wav").read_bytes()
    owner = owner_of(args.owner_project_id)
    scenes = lesson["scenes"]
    if len(scenes) != 8:
        raise SystemExit(f"Expected 8 scenes, got {len(scenes)}")

    project_id = str(uuid.uuid4())
    supabase("POST", "/rest/v1/lesson_video_projects", {
        "id": project_id,
        "owner_id": owner,
        "class_level": lesson["classLevel"],
        "subject": lesson["subject"],
        "topic": lesson["topic"],
        "language_code": lesson["languageCode"],
        "language_name": lesson["languageName"],
        "target_duration_seconds": 60,
        "title": lesson["title"][:200],
        "learning_objective": lesson["learningObjective"][:500],
        "narration_text": lesson["narrationText"],
        "narration_duration_seconds": round(float(lesson["narrationDurationSeconds"]), 3),
        "status": "generating_images",
    }, prefer="return=minimal")

    encoded = urllib.parse.quote(f"{project_id}/narration.wav", safe="/")
    request(
        "POST", f"{SUPABASE_URL}/storage/v1/object/lesson-video-assets/{encoded}", data=audio,
        headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
                 "Content-Type": "audio/wav", "x-upsert": "true"},
        expect_json=False,
    )
    narration_url = f"{SUPABASE_URL}/storage/v1/object/public/lesson-video-assets/{encoded}"
    supabase("PATCH", f"/rest/v1/lesson_video_projects?{urllib.parse.urlencode({'id': f'eq.{project_id}'})}",
             {"narration_url": narration_url}, prefer="return=minimal")

    scene_rows, job_rows = [], []
    for position, scene in enumerate(scenes, 1):
        visual = str(scene["visualDescription"]).strip()
        motion = str(scene["motionDescription"]).strip()
        image_prompt = f"{visual} {HOUSE_STYLE}"
        video_prompt = (
            f"{visual} Animate the subject physically: {motion} Smooth, purposeful, physically "
            "plausible motion with stable object identity and a clear final state; the camera "
            "stays nearly still."
        )
        scene_id = str(uuid.uuid4())
        scene_rows.append({
            "id": scene_id, "project_id": project_id, "scene_index": position,
            "duration_seconds": 7.5, "fact": scene["fact"], "narration": scene["narration"],
            "image_prompt": image_prompt, "video_prompt": video_prompt,
            "caption": scene.get("caption", ""), "overlay": scene.get("overlay") or {"kind": "none"},
        })
        job_rows.append({
            "owner_id": owner, "project_id": project_id, "scene_id": scene_id,
            "kind": "image", "profile": "image-fast", "prompt": image_prompt,
            "negative_prompt": NEGATIVE_PROMPT, "max_attempts": 4,
            "parameters": {"width": 1024, "height": 576, "steps": 8,
                           "sceneIndex": position, "seed": 1000 + position},
        })
    supabase("POST", "/rest/v1/lesson_video_scenes", scene_rows, prefer="return=minimal")
    supabase("POST", "/rest/v1/lesson_video_jobs", job_rows, prefer="return=minimal")
    print(json.dumps({"projectId": project_id, "title": lesson["title"], "scenes": len(scenes)},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
