#!/usr/bin/env python3
"""Replace selected misleading anatomy keyframes without touching other projects."""

from __future__ import annotations

import argparse
import json
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path

from seed_local_lesson_test import supabase


REVISIONS = {
    2: (
        "Close magnified three-dimensional cutaway of human seminiferous tubule tissue "
        "filling the frame. Small sperm cells with distinct oval heads and long thin tails "
        "develop along the inner wall and collect within the tubule channel. Scientifically "
        "plausible biological tissue with one central tubular structure.",
        "Start: developing sperm cells line the inner tubule wall. Then: mature sperm cells "
        "move from the wall toward the central channel. End: sperm remain inside the tubule.",
    ),
    3: (
        "Close magnified three-dimensional cutaway of one human ovary filling the frame. "
        "One large fluid-filled ovarian follicle lies inside the ovary tissue, and one round "
        "ovum is visibly enclosed within that follicle. Scientifically plausible follicle "
        "and ovary structures at a single consistent scale.",
        "Start: the ovum is enclosed in its follicle. Then: the follicle wall opens at the "
        "ovary surface. End: the ovum moves just beyond the opening.",
    ),
    6: (
        "Close magnified three-dimensional cutaway of the inner uterine wall filling the "
        "frame. One tiny spherical blastocyst, with an outer cell layer and inner cell "
        "cluster, rests next to the soft endometrium. Scientifically plausible tissue and "
        "microscopic scale.",
        "Start: the blastocyst is beside the endometrium. Then: it attaches gently to the "
        "uterine lining. End: it remains embedded at the same site.",
    ),
    7: (
        "Close three-dimensional anatomical cutaway of the inner uterine cavity only. "
        "A broad disc-shaped placenta is attached flush to the uterine wall. A short curved "
        "umbilical cord connects that placenta to a small curled embryo resting fully inside "
        "the uterine cavity. The placenta, cord, and embryo form one continuous connection.",
        "Start: the embryo rests inside the uterine cavity, connected to the wall-mounted "
        "placenta by a cord. Then: gentle flow moves through the cord toward the embryo. "
        "End: the same connection stays intact.",
    ),
    8: (
        "Close three-dimensional anatomical cutaway of the inner uterine cavity only. "
        "A developing foetus curls fully inside a translucent amniotic sac. One umbilical "
        "cord connects the foetus to a disc-shaped placenta attached to the uterine wall. "
        "All three structures remain clearly inside the same anatomical space.",
        "Start: the foetus rests curled within the amniotic sac. Then: it makes one small "
        "natural movement. End: the foetus remains supported by the cord and placenta.",
    ),
}


def rows(table: str, project_id: str, select: str) -> list[dict]:
    query = {"select": select, "id" if table == "lesson_video_projects" else "project_id":
             f"eq.{project_id}"}
    return supabase("GET", f"/rest/v1/{table}?{urllib.parse.urlencode(query)}")


def patch(table: str, row_id: str, payload: dict) -> None:
    query = urllib.parse.urlencode({"id": f"eq.{row_id}"})
    supabase("PATCH", f"/rest/v1/{table}?{query}", payload, prefer="return=minimal")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_id")
    args = parser.parse_args()
    project_id = args.project_id
    projects = rows("lesson_video_projects", project_id, "id,owner_id,subject,status")
    scenes = rows("lesson_video_scenes", project_id,
                  "id,scene_index,status,image_prompt,video_prompt,image_url")
    jobs = rows("lesson_video_jobs", project_id, "id,scene_id,kind,status,output_url")
    if len(projects) != 1 or projects[0]["subject"] != "Science":
        raise RuntimeError("Expected one Science project")
    if projects[0]["status"] not in ("generating_images", "generating_videos"):
        raise RuntimeError("Project is not waiting for media")
    target_scenes = {scene["scene_index"]: scene for scene in scenes
                     if scene["scene_index"] in REVISIONS}
    if len(target_scenes) != len(REVISIONS):
        raise RuntimeError("Not all target scenes exist")
    target_ids = {scene["id"] for scene in target_scenes.values()}
    target_jobs = [job for job in jobs if job["scene_id"] in target_ids]
    if any(job["status"] == "processing" for job in target_jobs):
        raise RuntimeError("A target scene is being processed; stop its worker first")
    if any(job["kind"] == "video" and job["status"] == "succeeded"
           for job in target_jobs):
        raise RuntimeError("A target scene already has a rendered clip")

    backup = Path(f"/root/lumina-biology-before-targeted-revision-{project_id}.json")
    if not backup.exists():
        backup.write_text(json.dumps({"scenes": scenes, "jobs": target_jobs},
                                     ensure_ascii=False, indent=2), encoding="utf-8")
    now = datetime.now(timezone.utc).isoformat()
    for job in target_jobs:
        if job["status"] in ("queued", "succeeded", "failed"):
            patch("lesson_video_jobs", job["id"], {
                "status": "cancelled", "cancel_requested_at": now, "completed_at": now,
            })

    new_jobs = []
    for index, (visual, motion) in REVISIONS.items():
        scene = target_scenes[index]
        image_prompt = visual + " High-end coherent biological visualization with clean lighting."
        video_prompt = (visual + " Animate the biological process: " + motion
                        + " Smooth purposeful motion with stable anatomical structures "
                        "and a nearly still camera.")
        patch("lesson_video_scenes", scene["id"], {
            "status": "queued_image", "image_prompt": image_prompt,
            "video_prompt": video_prompt, "image_url": None, "video_url": None,
            "error_message": None,
        })
        new_jobs.append({
            "id": str(uuid.uuid4()), "owner_id": projects[0]["owner_id"],
            "project_id": project_id, "scene_id": scene["id"], "kind": "image",
            "profile": "image-fast", "prompt": image_prompt,
            "negative_prompt": "text, writing, labels, watermark, logo",
            "max_attempts": 3,
            "parameters": {"width": 1024, "height": 576, "steps": 8,
                           "sceneIndex": index, "seed": 4000 + index,
                           "visualMode": "anatomical"},
        })
    supabase("POST", "/rest/v1/lesson_video_jobs", new_jobs, prefer="return=minimal")
    patch("lesson_video_projects", project_id, {"status": "generating_images"})
    print(json.dumps({"projectId": project_id, "revisedScenes": sorted(REVISIONS),
                      "freshImages": len(new_jobs), "backup": str(backup)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
