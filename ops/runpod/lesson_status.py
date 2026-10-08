#!/usr/bin/env python3
"""Print a compact, secret-free status summary for one lesson project."""

from __future__ import annotations

import argparse
import json
import urllib.parse

from seed_local_lesson_test import supabase


def rows(table: str, project_id: str, select: str, order: str = "") -> list[dict]:
    query = {"select": select}
    query["id" if table == "lesson_video_projects" else "project_id"] = f"eq.{project_id}"
    if order:
        query["order"] = order
    return supabase("GET", f"/rest/v1/{table}?{urllib.parse.urlencode(query)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_id")
    parser.add_argument("--content", action="store_true", help="Include reviewable facts and narration")
    parser.add_argument("--prompts", action="store_true", help="Include stored image/video prompts")
    parser.add_argument("--urls", action="store_true", help="Include saved scene media URLs")
    args = parser.parse_args()
    projects = rows(
        "lesson_video_projects",
        args.project_id,
        "id,status,title,narration_duration_seconds,final_video_url,error_message,created_at,completed_at",
    )
    if not projects:
        raise SystemExit("Project not found")
    scenes = rows(
        "lesson_video_scenes",
        args.project_id,
        ("scene_index,status,image_url,video_url,error_message"
         + (",fact,narration,caption,overlay" if args.content else "")
         + (",image_prompt,video_prompt" if args.prompts else "")),
        "scene_index.asc",
    )
    jobs = rows(
        "lesson_video_jobs",
        args.project_id,
        "kind,status,progress,attempts,error_code,error_message,output_metadata",
        "created_at.asc",
    )
    summary = {
        "project": projects[0],
        "scenes": [
            {
                "index": scene["scene_index"],
                "status": scene["status"],
                "imageReady": bool(scene.get("image_url")),
                "videoReady": bool(scene.get("video_url")),
                **({"imageUrl": scene.get("image_url"), "videoUrl": scene.get("video_url")}
                   if args.urls else {}),
                "error": scene.get("error_message"),
                **({
                    "fact": scene.get("fact"),
                    "narration": scene.get("narration"),
                    "caption": scene.get("caption"),
                    "overlay": scene.get("overlay"),
                } if args.content else {}),
                **({
                    "imagePrompt": scene.get("image_prompt"),
                    "videoPrompt": scene.get("video_prompt"),
                } if args.prompts else {}),
            }
            for scene in scenes
        ],
        "jobs": [
            {
                "kind": job["kind"],
                "status": job["status"],
                "progress": job["progress"],
                "attempts": job["attempts"],
                "error": job.get("error_code") or job.get("error_message"),
                "latency": (job.get("output_metadata") or {}).get("latency_seconds"),
                "motionMode": (job.get("output_metadata") or {}).get("motion_mode"),
            }
            for job in jobs
        ],
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
