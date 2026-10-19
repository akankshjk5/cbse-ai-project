"""Which model revision actually ran.

    python ops/cloud/model_manifest.py                 # report what is pinned
    python ops/cloud/model_manifest.py --models-root ~/ComfyUI/models
    python ops/cloud/model_manifest.py --pin --models-root ~/ComfyUI/models

`weight_facts` in benchmark.py records each file's size and mtime, which pins
which *build* ran on which day. It does not say which revision of the
repository that build came from, so two runs a month apart cannot be compared
and neither can be reproduced.

This reads `models.json` and, where a model is on disk, resolves the revision
Hugging Face recorded for it. Nothing is guessed: a revision that cannot be
read comes back `null` with the reason, and `--pin` writes back only revisions
that were actually observed.

Hugging Face stores a snapshot as

    <cache>/models--<org>--<name>/snapshots/<commit-sha>/...

so the revision is in the path when a model was fetched with the hub library.
A directory someone assembled by hand has no revision to read, and says so.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "models.json"

#: A 40-hex commit, as a snapshot directory is named.
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def load(path: Path = MANIFEST) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if "models" not in data:
        raise ValueError(f"{path} has no 'models' list")
    return data


def revision_from_path(path: Path) -> tuple[str | None, str]:
    """The commit SHA for a model directory, or why there isn't one.

    Three places it can be, in order of how much they are worth trusting:
      1. the snapshot directory name, which the hub library wrote;
      2. a `refs/main` file in the same repo cache;
      3. a `.lumina-revision` file an operator wrote by hand.
    """
    if not path.exists():
        return None, "not on disk"

    resolved = path.resolve()
    for part in resolved.parts:
        if SHA_RE.match(part):
            return part, "hugging face snapshot directory"

    # `<cache>/models--org--name/refs/main` holds the resolved commit.
    for parent in [resolved, *resolved.parents][:4]:
        ref = parent / "refs" / "main"
        if ref.is_file():
            value = ref.read_text(encoding="utf-8").strip()
            if SHA_RE.match(value):
                return value, "refs/main in the hub cache"

    sidecar = resolved / ".lumina-revision"
    if sidecar.is_file():
        value = sidecar.read_text(encoding="utf-8").strip()
        if value:
            return value, "operator-written .lumina-revision"

    return None, ("on disk but not fetched by the hub library, so no revision "
                  "is recorded; write one to .lumina-revision if you know it")


def locate(model: dict, models_root: Path | None, env: dict) -> Path | None:
    """Where this model should be, from the environment or --models-root."""
    if model["kind"] == "service":
        value = env.get(model["env"])
        return Path(value) if value else None
    if models_root is None:
        return None
    return models_root / model["file"]


def facts(models_root: Path | None = None, env: dict | None = None,
          manifest: dict | None = None) -> dict:
    """What ran, for the benchmark report."""
    import os
    data = manifest or load()
    env = env if env is not None else dict(os.environ)
    out = []
    for model in data["models"]:
        path = locate(model, models_root, env)
        revision, why = (None, "path not configured") if path is None \
            else revision_from_path(path)
        declared = model.get("revision")
        out.append({
            "name": model["name"],
            "repo": model["repo"],
            "file": model.get("file"),
            "path": str(path) if path else None,
            "present": bool(path and path.exists()),
            # What models.json pins, versus what is actually there.
            "pinned_revision": declared,
            "observed_revision": revision,
            "revision_source": why,
            "pinned": declared is not None,
            "matches_pin": (declared is not None and revision is not None
                            and declared == revision),
            "licence": model["licence"],
            "licence_resolved": model["licence_resolved"],
            "gated": model["gated"],
        })
    unresolved = [m["name"] for m in out if not m["licence_resolved"]]
    gated = [m["name"] for m in out if m["gated"]]
    return {
        "manifest_version": data.get("manifest_version"),
        "models": out,
        "all_pinned": all(m["pinned"] for m in out),
        "licences_unresolved": unresolved,
        "gated_models": gated,
        # The one sentence a reader needs. A run with unpinned revisions is not
        # reproducible, whatever else the report says.
        "reproducible": all(m["pinned"] and m["matches_pin"] for m in out),
    }


def pin(models_root: Path | None, env: dict | None = None) -> int:
    """Write observed revisions into models.json. Only ones actually observed."""
    import os
    env = env if env is not None else dict(os.environ)
    data = load()
    written, skipped = [], []
    for model in data["models"]:
        path = locate(model, models_root, env)
        revision, why = (None, "path not configured") if path is None \
            else revision_from_path(path)
        if revision is None:
            skipped.append(f"{model['name']}: {why}")
            continue
        model["revision"] = revision
        written.append(f"{model['name']}: {revision}")
    MANIFEST.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    for line in written:
        print(f"  pinned   {line}")
    for line in skipped:
        print(f"  skipped  {line}")
    print(f"\n{len(written)} pinned, {len(skipped)} left null in {MANIFEST}.")
    if skipped:
        print("A null revision is honest; do not fill one in by hand unless you "
              "know it. Nothing may call a run with nulls reproducible.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--models-root", type=Path, default=None,
                        help="ComfyUI models/ directory, for the six weight files")
    parser.add_argument("--pin", action="store_true",
                        help="write observed revisions back into models.json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.pin:
        return pin(args.models_root)

    report = facts(args.models_root)
    if args.json:
        print(json.dumps(report, indent=2))
        return 0 if report["reproducible"] else 1

    print("Model manifest\n" + "=" * 14)
    for model in report["models"]:
        state = "present" if model["present"] else "absent "
        rev = model["observed_revision"] or model["pinned_revision"] or "unpinned"
        flags = []
        if model["gated"]:
            flags.append("GATED")
        if not model["licence_resolved"]:
            flags.append("LICENCE UNRESOLVED")
        suffix = f"  [{', '.join(flags)}]" if flags else ""
        print(f"  {state}  {model['name']:28s} {rev[:12]:12s} {model['licence']}{suffix}")
        if not model["present"] and model["path"]:
            print(f"            expected at {model['path']}")

    print(f"\nRevisions pinned: {'yes' if report['all_pinned'] else 'NO'}")
    print(f"Reproducible:     {'yes' if report['reproducible'] else 'NO'}")
    if not report["reproducible"]:
        print("  A run with unpinned or mismatched revisions cannot be reproduced.")
        print("  After downloading: python ops/cloud/model_manifest.py --pin "
              "--models-root <dir>")
    if report["gated_models"]:
        print(f"\nGated, accept interactively first: {', '.join(report['gated_models'])}")
    if report["licences_unresolved"]:
        print(f"Licence NOT settled for commercial use: "
              f"{', '.join(report['licences_unresolved'])}")
        print("  See the referenced question in docs/model-licences.md.")
    return 0 if report["reproducible"] else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
