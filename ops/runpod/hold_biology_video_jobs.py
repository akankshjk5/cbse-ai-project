#!/usr/bin/env python3
"""Hold or release queued biology clips while their source frames are reviewed."""

from __future__ import annotations

import argparse
import json
import urllib.parse
from datetime import datetime, timedelta, timezone

from seed_local_lesson_test import supabase


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_id")
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()
    project_id = args.project_id
    query = urllib.parse.urlencode({
        "select": "id,subject", "id": f"eq.{project_id}", "limit": "1",
    })
    project = supabase("GET", f"/rest/v1/lesson_video_projects?{query}")
    if len(project) != 1 or project[0]["subject"] != "Science":
        raise RuntimeError("Expected one Science project")
    available = datetime.now(timezone.utc)
    if not args.release:
        available += timedelta(days=1)
    query = urllib.parse.urlencode({
        "project_id": f"eq.{project_id}", "kind": "eq.video", "status": "eq.queued",
    })
    updated = supabase("PATCH", f"/rest/v1/lesson_video_jobs?{query}", {
        "available_at": available.isoformat(),
    }, prefer="return=representation")
    print(json.dumps({"projectId": project_id,
                      "queuedVideoJobsUpdated": len(updated), "released": args.release}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
