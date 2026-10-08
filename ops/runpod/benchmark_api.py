#!/usr/bin/env python3
"""Submit one tokenized API workflow and report measured ComfyUI results."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from media_worker import ComfyClient, replace_tokens, validate_output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("workflow", type=Path)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--negative-prompt", default="")
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=576)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--source-image", default="")
    parser.add_argument("--fps", type=int, default=16)
    parser.add_argument("--frames", type=int, default=49)
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--kind", choices=("image", "video"), default="image")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--output-dir", type=Path, default=Path("/workspace/lumina-benchmarks"))
    parser.add_argument("--comfy-url", default="http://127.0.0.1:8188")
    args = parser.parse_args()

    workflow = json.loads(args.workflow.read_text(encoding="utf-8"))
    workflow = replace_tokens(
        workflow,
        {
            "__PROMPT__": args.prompt,
            "__NEGATIVE_PROMPT__": args.negative_prompt,
            "__SEED__": args.seed,
            "__WIDTH__": args.width,
            "__HEIGHT__": args.height,
            "__SOURCE_IMAGE__": args.source_image,
            "__FPS__": args.fps,
            "__FRAMES__": args.frames,
            "__STEPS__": args.steps,
        },
    )

    client = ComfyClient(args.comfy_url)
    started = time.monotonic()
    prompt_id = client.submit(workflow)
    history = client.wait(prompt_id, args.timeout, lambda: None)
    elapsed = time.monotonic() - started
    args.output_dir.mkdir(parents=True, exist_ok=True)
    output = client.download_output(history, args.output_dir / prompt_id)
    metadata = validate_output(output, args.kind)
    print(
        json.dumps(
            {
                "prompt_id": prompt_id,
                "elapsed_seconds": round(elapsed, 3),
                "output": str(output),
                "metadata": metadata,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
