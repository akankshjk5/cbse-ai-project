from __future__ import annotations

import argparse
from pathlib import Path

import torch
from safetensors import safe_open


BASELINE = (
    "diffusion_models/z_image_turbo_bf16.safetensors",
    "text_encoders/qwen_3_4b.safetensors",
    "vae/ae.safetensors",
    "diffusion_models/wan2.2_ti2v_5B_fp16.safetensors",
    "text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    "vae/wan2.2_vae.safetensors",
)

QUALITY = (
    "diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
    "diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
    "text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    "vae/wan_2.1_vae.safetensors",
    "loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
    "loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
)


def verify_safetensors(path: Path) -> None:
    if not path.exists():
        raise RuntimeError(f"missing model: {path}")
    if path.stat().st_size < 1_000_000:
        raise RuntimeError(f"model is suspiciously small ({path.stat().st_size} bytes): {path}")
    with safe_open(path, framework="pt", device="cpu") as handle:
        keys = handle.keys()
        if not keys:
            raise RuntimeError(f"safetensors file has no tensors: {path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-dir", type=Path, required=True)
    parser.add_argument("--profile", choices=("baseline", "quality", "all"), default="baseline")
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("ERROR: CUDA is not available to PyTorch.")
    props = torch.cuda.get_device_properties(0)
    gib = props.total_memory / 2**30
    if gib < 44:
        raise SystemExit(f"ERROR: only {gib:.1f} GiB VRAM detected; expected an RTX 6000 Ada class GPU.")

    required: list[str] = []
    if args.profile in ("baseline", "all"):
        required.extend(BASELINE)
    if args.profile in ("quality", "all"):
        required.extend(QUALITY)

    print(f"Verifying {len(set(required))} model files without loading weights into VRAM...")
    for relative in dict.fromkeys(required):
        path = args.comfy_dir / "models" / relative
        verify_safetensors(path)
        print(f"OK {relative}: {path.stat().st_size / 2**30:.2f} GiB")

    print(f"GPU OK: {props.name}; compute capability {props.major}.{props.minor}; {gib:.1f} GiB")


if __name__ == "__main__":
    main()
