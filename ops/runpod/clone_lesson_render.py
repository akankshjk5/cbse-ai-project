#!/usr/bin/env python3
"""Clone an audited lesson's plan/audio and enqueue a fresh media render."""

from __future__ import annotations

import argparse
import json
import urllib.parse
import uuid

from seed_local_lesson_test import supabase


def get(table: str, filters: dict[str, str], select: str, order: str = "") -> list[dict]:
    query = {"select": select, **filters}
    if order:
        query["order"] = order
    return supabase("GET", f"/rest/v1/{table}?{urllib.parse.urlencode(query)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_project_id")
    args = parser.parse_args()
    projects = get("lesson_video_projects", {"id": f"eq.{args.source_project_id}"}, "*")
    scenes = get(
        "lesson_video_scenes",
        {"project_id": f"eq.{args.source_project_id}"},
        "scene_index,duration_seconds,fact,narration,image_prompt,video_prompt",
        "scene_index.asc",
    )
    if not projects or len(scenes) != 8:
        raise SystemExit("Source project must contain eight audited scenes")
    source = projects[0]
    project_id = str(uuid.uuid4())
    project = {
        key: source[key]
        for key in (
            "owner_id", "class_level", "subject", "topic", "language_code", "language_name",
            "target_duration_seconds", "title", "learning_objective", "narration_text",
            "narration_url", "narration_duration_seconds",
        )
    }
    project.update({"id": project_id, "status": "generating_images"})
    supabase("POST", "/rest/v1/lesson_video_projects", project, prefer="return=minimal")

    scene_rows = []
    job_rows = []
    for source_scene in scenes:
        scene_id = str(uuid.uuid4())
        scene_rows.append({"id": scene_id, "project_id": project_id, **source_scene})
        job_rows.append({
            "owner_id": source["owner_id"],
            "project_id": project_id,
            "scene_id": scene_id,
            "kind": "image",
            "profile": "image-fast",
            "prompt": source_scene["image_prompt"],
            "negative_prompt": "text, writing, letters, numbers, equations, captions, labels, watermark",
            "parameters": {"sceneIndex": source_scene["scene_index"]},
        })
    supabase("POST", "/rest/v1/lesson_video_scenes", scene_rows, prefer="return=minimal")
    supabase("POST", "/rest/v1/lesson_video_jobs", job_rows, prefer="return=minimal")
    print(json.dumps({"projectId": project_id, "sourceProjectId": args.source_project_id}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
