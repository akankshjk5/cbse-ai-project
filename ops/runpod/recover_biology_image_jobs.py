#!/usr/bin/env python3
"""Give revised biology images fresh job IDs and Storage paths after a dry run."""

from __future__ import annotations

import argparse
import json
import urllib.parse
import uuid
from datetime import datetime, timezone

from seed_local_lesson_test import supabase


def rows(table: str, project_id: str, select: str, order: str = "") -> list[dict]:
    query = {"select": select, "id" if table == "lesson_video_projects" else "project_id":
             f"eq.{project_id}"}
    if order:
        query["order"] = order
    return supabase("GET", f"/rest/v1/{table}?{urllib.parse.urlencode(query)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_id")
    args = parser.parse_args()
    project_id = args.project_id
    projects = rows("lesson_video_projects", project_id, "id,owner_id,subject,status")
    scenes = rows("lesson_video_scenes", project_id, "id,scene_index,image_prompt", "scene_index.asc")
    jobs = rows("lesson_video_jobs", project_id,
                "id,scene_id,kind,status,attempts,parameters", "created_at.asc")
    if len(projects) != 1 or projects[0]["subject"] != "Science" or len(scenes) != 8:
        raise RuntimeError("Expected the eight-scene Science project")
    if projects[0]["status"] != "generating_images":
        raise RuntimeError("Project is not waiting for revised images")
    if any(job["status"] == "processing" for job in jobs):
        raise RuntimeError("Stop workers before recovering image jobs")
    image_jobs = [job for job in jobs if job["kind"] == "image"]
    if len(image_jobs) != 8 or any(job["status"] != "queued" for job in image_jobs):
        raise RuntimeError("Expected exactly eight queued image retries")

    now = datetime.now(timezone.utc).isoformat()
    for job in image_jobs:
        query = urllib.parse.urlencode({"id": f"eq.{job['id']}"})
        supabase("PATCH", f"/rest/v1/lesson_video_jobs?{query}", {
            "status": "cancelled", "cancel_requested_at": now, "completed_at": now,
        }, prefer="return=minimal")

    new_jobs = []
    for scene in scenes:
        new_jobs.append({
            "id": str(uuid.uuid4()),
            "owner_id": projects[0]["owner_id"],
            "project_id": project_id,
            "scene_id": scene["id"],
            "kind": "image",
            "profile": "image-fast",
            "prompt": scene["image_prompt"],
            "negative_prompt": "text, writing, letters, numbers, watermark, logo",
            "max_attempts": 3,
            "parameters": {"width": 1024, "height": 576, "steps": 8,
                           "sceneIndex": scene["scene_index"],
                           "seed": 3000 + scene["scene_index"],
                           "visualMode": "anatomical"},
        })
    supabase("POST", "/rest/v1/lesson_video_jobs", new_jobs, prefer="return=minimal")
    print(json.dumps({"projectId": project_id, "cancelledOldImageRetries": 8,
                      "queuedFreshImageJobs": 8}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
