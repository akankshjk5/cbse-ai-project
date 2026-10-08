"""
cleanup.py - Remove generated artifacts created by the Agent.

Deletes (allow-list):
- generated_frames/
- generated_audio/
- generated_videos/
- temp_merges/
- extra/
- job_runs/
- script.json
- concatenated_video.mp4
- output.mp4
- final_output.mp4

Keeps memory.json but truncates it to an empty list.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path


ALLOW_DIRS = [
    "generated_frames",
    "generated_audio",
    "generated_videos",
    "temp_merges",
    "job_runs",
]

ALLOW_FILES = [
    "script.json",
    "concatenated_video.mp4",
    "output.mp4",
    "final_output.mp4",
]


def delete_dir(path: Path) -> int:
    """Delete an entire folder tree if it exists."""
    if not path.exists():
        return 0
    try:
        shutil.rmtree(path)
        return 1
    except Exception as exc:  # pragma: no cover
        print(f"[WARN] Could not remove {path}: {exc}")
        return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Clean generated artifacts produced by the Agent."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be deleted without removing files.",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent
    total_removed = 0

    for rel in ALLOW_DIRS:
        target = repo_root / rel
        if not target.exists():
            continue
        if args.dry_run:
            print(f"[DRY] {target} -> would delete folder")
            continue
        removed = delete_dir(target)
        if removed:
            print(f"[OK] Deleted folder {target}")
        total_removed += removed

    for rel in ALLOW_FILES:
        target = repo_root / rel
        if not target.exists():
            continue
        if args.dry_run:
            print(f"[DRY] {target} -> would delete file")
            continue
        try:
            target.unlink()
            total_removed += 1
            print(f"[OK] Deleted file {target}")
        except Exception as exc:  # pragma: no cover
            print(f"[WARN] Could not delete {target}: {exc}")

    # Truncate memory.json instead of deleting it.
    mem_file = repo_root / "memory.json"
    if mem_file.exists():
        if args.dry_run:
            print(f"[DRY] {mem_file} -> would truncate to []")
        else:
            try:
                mem_file.write_text("[]\n", encoding="utf-8")
                print(f"[OK] Truncated {mem_file}")
            except Exception as exc:  # pragma: no cover
                print(f"[WARN] Could not truncate {mem_file}: {exc}")

    if args.dry_run:
        print("Dry run complete. No files were deleted.")
    else:
        print(f"Done. Removed {total_removed} item(s).")


if __name__ == "__main__":
    main()
