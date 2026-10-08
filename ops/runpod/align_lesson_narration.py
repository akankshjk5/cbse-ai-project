#!/usr/bin/env python3
"""Replace a queued lesson's continuous voice track with scene-aligned speech.

Uses the existing local TTS model; no new lesson, image, or video job is created.
The original narration remains in Storage for recovery.
"""

from __future__ import annotations

import argparse
import json
import urllib.parse
import wave
from io import BytesIO

from seed_local_lesson_test import SERVICE_KEY, SUPABASE_URL, TTS_URL, local_post, request, supabase


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_id")
    args = parser.parse_args()
    project_id = args.project_id
    query = urllib.parse.urlencode({"select": "id,status,language_code,target_duration_seconds",
                                    "id": f"eq.{project_id}", "limit": "1"})
    projects = supabase("GET", f"/rest/v1/lesson_video_projects?{query}")
    if len(projects) != 1:
        raise RuntimeError("Lesson project was not found")
    project = projects[0]
    if project["status"] not in ("generating_images", "generating_videos"):
        raise RuntimeError(f"Lesson status {project['status']} is not safe to update")
    target_seconds = int(project["target_duration_seconds"])
    query = urllib.parse.urlencode({
        "select": "scene_index,narration", "project_id": f"eq.{project_id}",
        "order": "scene_index.asc",
    })
    scenes = supabase("GET", f"/rest/v1/lesson_video_scenes?{query}")
    expected = 8 if target_seconds == 60 else 12
    if len(scenes) != expected or any(
        scene["scene_index"] != index for index, scene in enumerate(scenes, 1)
    ):
        raise RuntimeError("Lesson scene count or order is invalid")

    audio = local_post(TTS_URL, "/synthesize", {
        "sceneTranscripts": [scene["narration"] for scene in scenes],
        "sceneDurationSeconds": target_seconds / expected,
        "languageCode": project["language_code"],
        "pace": "natural",
    }, raw=True)
    with wave.open(BytesIO(audio), "rb") as wav:
        duration = wav.getnframes() / wav.getframerate()
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise RuntimeError("Local TTS returned an unexpected audio format")
    if abs(duration - target_seconds) > 0.1:
        raise RuntimeError(f"Scene-aligned audio duration was {duration:.2f}, expected {target_seconds}")

    storage_path = f"{project_id}/narration-scene-aligned.wav"
    encoded_path = urllib.parse.quote(storage_path, safe="/")
    request(
        "POST",
        f"{SUPABASE_URL}/storage/v1/object/lesson-video-assets/{encoded_path}",
        data=audio,
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
            "Content-Type": "audio/wav",
            "x-upsert": "true",
        },
        expect_json=False,
    )
    narration_url = f"{SUPABASE_URL}/storage/v1/object/public/lesson-video-assets/{encoded_path}"
    query = urllib.parse.urlencode({"id": f"eq.{project_id}"})
    supabase("PATCH", f"/rest/v1/lesson_video_projects?{query}", {
        "narration_url": narration_url,
        "narration_duration_seconds": round(duration, 3),
    }, prefer="return=minimal")
    print(json.dumps({"projectId": project_id, "sceneAligned": True,
                      "durationSeconds": round(duration, 3), "scenes": expected}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
