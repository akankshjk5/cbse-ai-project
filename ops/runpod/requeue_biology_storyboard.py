#!/usr/bin/env python3
"""Replace one rejected biology storyboard before animation; preserve a backup."""

from __future__ import annotations

import argparse
import json
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from seed_local_lesson_test import supabase


SCENES = [
    {
        "fact": "Human sexual reproduction includes fertilisation, when a sperm and egg fuse to form a zygote.",
        "narration": "In human sexual reproduction, a sperm and egg fuse, forming a single cell called a zygote.",
        "visual": "A scientifically plausible magnified three-dimensional view inside a human fallopian tube: one large round ovum cell with a distinct translucent membrane, and one much smaller sperm cell with a head and tail separated from it by a short gap. Anatomical cells, not toys or laboratory props.",
        "motion": "Start: the sperm and ovum are separate. Then: the sperm swims toward the ovum and its head reaches the outer membrane. End: the cells make contact while retaining their recognizable forms.",
    },
    {
        "fact": "Male gametes are called sperm, and they are produced in the testes.",
        "narration": "Male gametes are called sperm, and they are produced in the testes.",
        "visual": "A scientifically plausible three-dimensional cutaway of a human testis showing one seminiferous tubule, with several tiny developing sperm cells along its inner surface and mature sperm cells within its central channel. Anatomical tissue, not toys or laboratory props.",
        "motion": "Start: developing sperm cells line the tubule. Then: mature sperm cells move gently into the tubule's central channel. End: the cells remain inside the same anatomical tubule.",
    },
    {
        "fact": "Female gametes are called eggs, and they develop in the ovaries.",
        "narration": "Female gametes are called eggs, and they develop inside follicles within the ovaries.",
        "visual": "A scientifically plausible three-dimensional cutaway of a human ovary with one prominent round follicle containing a single ovum, beside the open end of a fallopian tube. Anatomical tissue, not toys or laboratory props.",
        "motion": "Start: the ovum rests inside the follicle. Then: the follicle opens gently toward the fallopian tube. End: the ovum leaves the follicle while the surrounding anatomy stays stable.",
    },
    {
        "fact": "Fertilisation usually takes place in a fallopian tube when a sperm fuses with an egg.",
        "narration": "Fertilisation usually happens in a fallopian tube, where a sperm fuses with an egg.",
        "visual": "A scientifically plausible magnified three-dimensional view inside a human fallopian tube: a round ovum cell fills the center and a single small sperm head touches its outer membrane, with the sperm tail trailing behind. Anatomical cells, not toys or laboratory props.",
        "motion": "Start: the sperm head touches the ovum membrane. Then: the contact point merges into the ovum's surface. End: one intact fertilised cell remains, without unrelated cells appearing.",
    },
    {
        "fact": "After fertilisation, the zygote divides repeatedly to form an early multicellular embryo.",
        "narration": "After fertilisation, the single zygote divides repeatedly, forming an early multicellular embryo.",
        "visual": "A scientifically plausible magnified three-dimensional view of one round fertilised human zygote within its transparent outer coat, with a shallow cleavage furrow just beginning across its cell membrane. Biological cell structure, not toys or laboratory props.",
        "motion": "Start: the zygote is one cell. Then: the membrane furrow deepens as it divides into two attached daughter cells. End: the two-cell embryo remains inside its outer coat.",
    },
    {
        "fact": "The early embryo becomes a blastocyst, which implants in the uterine lining.",
        "narration": "The early embryo becomes a blastocyst and attaches to the lining of the uterus.",
        "visual": "A scientifically plausible three-dimensional uterine cutaway showing a tiny blastocyst with an outer cell layer and inner cell cluster just above the soft uterine lining. The scale clearly distinguishes the microscopic blastocyst from the organ wall; no laboratory props.",
        "motion": "Start: the blastocyst is next to the uterine lining. Then: it settles against the lining and attaches. End: it stays embedded at the same location in the uterine wall.",
    },
    {
        "fact": "After implantation, the placenta develops and exchanges oxygen and nutrients with the growing embryo.",
        "narration": "After implantation, the placenta develops and supplies the growing embryo with oxygen and nutrients.",
        "visual": "A scientifically plausible three-dimensional cutaway of a human uterus with an implanted early embryo connected by an umbilical cord to a placenta attached to the uterine wall. Show recognizable anatomical tissue and a clear connection; no laboratory props.",
        "motion": "Start: the embryo, cord, and attached placenta are all visible. Then: a gentle flow travels through the cord toward the embryo. End: the same anatomical connection remains intact.",
    },
    {
        "fact": "During pregnancy the embryo develops into a foetus; birth usually occurs about nine months after fertilisation.",
        "narration": "During pregnancy, the embryo becomes a foetus, and birth usually occurs about nine months after fertilisation.",
        "visual": "A scientifically plausible three-dimensional cutaway of a human uterus containing a developing foetus curled inside an amniotic sac, connected by an umbilical cord to the placenta on the uterine wall. Recognizable anatomy at a single later-pregnancy stage; no laboratory props.",
        "motion": "Start: the foetus is curled inside the amniotic sac. Then: it makes a small natural movement while the cord and placenta stay attached. End: the foetus rests in the same protected anatomical position.",
    },
]


def rows(table: str, project_id: str, select: str, order: str = "") -> list[dict]:
    query = {"select": select, "id" if table == "lesson_video_projects" else "project_id":
             f"eq.{project_id}"}
    if order:
        query["order"] = order
    return supabase("GET", f"/rest/v1/{table}?{urllib.parse.urlencode(query)}")


def patch(table: str, row_id: str, payload: dict) -> None:
    query = urllib.parse.urlencode({"id": f"eq.{row_id}"})
    supabase("PATCH", f"/rest/v1/{table}?{query}", payload, prefer="return=minimal")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_id")
    args = parser.parse_args()
    project_id = args.project_id
    project = rows("lesson_video_projects", project_id, "id,status,subject,topic")
    scenes = rows("lesson_video_scenes", project_id,
                  "id,scene_index,status,fact,narration,caption,image_url,image_prompt,video_prompt",
                  "scene_index.asc")
    jobs = rows("lesson_video_jobs", project_id,
                "id,scene_id,kind,status,parameters,prompt,output_url", "created_at.asc")
    if len(project) != 1 or project[0]["subject"] != "Science" or len(scenes) != 8:
        raise RuntimeError("Expected exactly one eight-scene Science lesson")
    if project[0]["status"] != "generating_videos":
        raise RuntimeError("Lesson is not awaiting video animation")
    if any(job["status"] == "processing" for job in jobs):
        raise RuntimeError("Stop the scoped media worker before replacing the storyboard")
    if any(job["kind"] == "video" and job["status"] == "succeeded" for job in jobs):
        raise RuntimeError("A video clip has already succeeded; refusing to replace its source image")
    image_jobs = {job["scene_id"]: job for job in jobs if job["kind"] == "image"}
    video_jobs = [job for job in jobs if job["kind"] == "video"]
    if len(image_jobs) != 8 or len(video_jobs) != 8:
        raise RuntimeError("Expected eight image and eight unrendered video jobs")

    backup = Path(f"/root/lumina-biology-storyboard-before-{project_id}.json")
    if not backup.exists():
        backup.write_text(json.dumps({"project": project, "scenes": scenes, "jobs": jobs},
                                     ensure_ascii=False, indent=2), encoding="utf-8")

    now = datetime.now(timezone.utc).isoformat()
    for job in video_jobs:
        patch("lesson_video_jobs", job["id"], {
            "status": "cancelled", "cancel_requested_at": now, "completed_at": now,
        })
    for scene, direction in zip(scenes, SCENES):
        visual = direction["visual"]
        for negative_clause in (
            " Anatomical cells, not toys or laboratory props.",
            " Anatomical tissue, not toys or laboratory props.",
            " Biological cell structure, not toys or laboratory props.",
            "; no laboratory props.",
            " no laboratory props.",
        ):
            visual = visual.replace(negative_clause, "." if negative_clause.startswith(";") else "")
        image_prompt = (visual + " High-end educational anatomical rendering "
                        "with coherent tissue, clean lighting, and one central biological subject.")
        video_prompt = (visual + " Animate this precise biological process: "
                        + direction["motion"] + " Smooth continuous subject motion, stable "
                        "anatomy, and a nearly still camera.")
        patch("lesson_video_scenes", scene["id"], {
            "status": "queued_image", "fact": direction["fact"],
            "narration": direction["narration"],
            "caption": "Pregnancy and Birth" if scene["scene_index"] == 8 else scene["caption"],
            "image_prompt": image_prompt, "video_prompt": video_prompt,
            "image_url": None, "video_url": None, "error_message": None,
        })
        image_job = image_jobs[scene["id"]]
        patch("lesson_video_jobs", image_job["id"], {
            "status": "queued", "progress": 0, "attempts": 0,
            "available_at": now, "worker_id": None, "locked_at": None,
            "heartbeat_at": None, "started_at": None, "completed_at": None,
            "error_code": None, "error_message": None,
            "cancel_requested_at": None, "output_url": None, "output_metadata": {},
            "prompt": image_prompt,
            "parameters": {**image_job["parameters"], "visualMode": "anatomical"},
        })
    project_query = urllib.parse.urlencode({"id": f"eq.{project_id}"})
    supabase("PATCH", f"/rest/v1/lesson_video_projects?{project_query}", {
        "status": "generating_images", "narration_text": " ".join(
            direction["narration"] for direction in SCENES
        ), "error_message": None,
    }, prefer="return=minimal")
    print(json.dumps({"projectId": project_id, "requeuedImages": 8,
                      "cancelledOldVideoJobs": 8, "backup": str(backup)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
