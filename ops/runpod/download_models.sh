#!/usr/bin/env bash
set -Eeuo pipefail

PROFILE="${1:-baseline}"
WORKSPACE_ROOT="${RUNPOD_WORKSPACE_ROOT:-/workspace}"
COMFY_DIR="${COMFY_DIR:-${WORKSPACE_ROOT}/ComfyUI}"
MODEL_STORE_ROOT="${RUNPOD_MODEL_STORE_ROOT:-/models}"
DOWNLOAD_STAGING_ROOT="${RUNPOD_DOWNLOAD_STAGING_ROOT:-${WORKSPACE_ROOT}/.model-downloads}"
HF_HOME="${HF_HOME:-${WORKSPACE_ROOT}/.cache/huggingface}"
export HF_HOME

case "${PROFILE}" in
  baseline|quality|all) ;;
  *) echo "Usage: $0 baseline|quality|all" >&2; exit 2 ;;
esac

HF_BIN="${COMFY_DIR}/.venv/bin/hf"
[[ -x "${HF_BIN}" ]] || { echo "Run bootstrap.sh first; ${HF_BIN} is missing." >&2; exit 1; }

mkdir -p \
  "${MODEL_STORE_ROOT}/diffusion_models" \
  "${MODEL_STORE_ROOT}/text_encoders" \
  "${MODEL_STORE_ROOT}/vae" \
  "${MODEL_STORE_ROOT}/loras" \
  "${DOWNLOAD_STAGING_ROOT}" \
  "${COMFY_DIR}/models/diffusion_models" \
  "${COMFY_DIR}/models/text_encoders" \
  "${COMFY_DIR}/models/vae" \
  "${COMFY_DIR}/models/loras"

valid_safetensors() {
  local path="$1"
  "${COMFY_DIR}/.venv/bin/python" - "${path}" <<'PY'
import sys
from pathlib import Path
from safetensors import safe_open

path = Path(sys.argv[1])
if not path.is_file() or path.stat().st_size < 1_000_000:
    raise SystemExit(1)
try:
    with safe_open(path, framework="pt", device="cpu") as handle:
        if not handle.keys():
            raise SystemExit(1)
except Exception:
    raise SystemExit(1)
PY
}

link_model() {
  local stored_path="$1"
  local local_path="$2"

  if [[ -L "${local_path}" ]]; then
    [[ "$(readlink "${local_path}")" == "${stored_path}" ]] || {
      echo "Unexpected model symlink: ${local_path} -> $(readlink "${local_path}")" >&2
      exit 1
    }
    return
  fi
  [[ ! -e "${local_path}" ]] || {
    echo "Refusing to replace non-symlink model path: ${local_path}" >&2
    exit 1
  }
  ln -s "${stored_path}" "${local_path}"
}

download_one() {
  local repo="$1"
  local remote_path="$2"
  local model_group="$3"
  local output_name="$4"
  local stored_target="${MODEL_STORE_ROOT}/${model_group}/${output_name}"
  local local_target="${COMFY_DIR}/models/${model_group}/${output_name}"
  local staging_dir="${DOWNLOAD_STAGING_ROOT}/${output_name}"

  if valid_safetensors "${stored_target}"; then
    link_model "${stored_target}" "${local_target}"
    echo "Already present and valid: ${stored_target}"
    return
  fi

  if [[ -e "${stored_target}" ]]; then
    echo "Removing incomplete model file: ${stored_target}"
    rm -f -- "${stored_target}"
  fi

  echo "Downloading ${repo}/${remote_path}"
  mkdir -p "${staging_dir}"
  local staged_path="${staging_dir}/${remote_path}"
  # huggingface_hub 1.x emits styled status text on stdout instead of a bare
  # path. The --local-dir layout is deterministic, so derive the path rather
  # than parsing CLI output.
  "${HF_BIN}" download "${repo}" "${remote_path}" --local-dir "${staging_dir}"
  [[ -f "${staged_path}" ]] || { echo "Download did not produce a file: ${staged_path}" >&2; exit 1; }
  valid_safetensors "${staged_path}" || { echo "Downloaded model failed validation: ${staged_path}" >&2; exit 1; }

  # Global volumes are object-backed and do not provide atomic rename. Download
  # on local POSIX storage first, then perform one sequential write to the final
  # persistent path. A later run removes and replaces an interrupted copy.
  cp --dereference -- "${staged_path}" "${stored_target}"
  [[ "$(stat -c '%s' "${staged_path}")" == "$(stat -c '%s' "${stored_target}")" ]] || {
    echo "Persistent copy size mismatch: ${stored_target}" >&2
    exit 1
  }
  valid_safetensors "${stored_target}" || { echo "Persistent model failed validation: ${stored_target}" >&2; exit 1; }
  link_model "${stored_target}" "${local_target}"
  rm -rf -- "${staging_dir}"
}

download_shared_wan() {
  download_one "Comfy-Org/Wan_2.2_ComfyUI_Repackaged" \
    "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" \
    "text_encoders" "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
}

download_baseline() {
  download_one "Comfy-Org/z_image_turbo" \
    "split_files/diffusion_models/z_image_turbo_bf16.safetensors" \
    "diffusion_models" "z_image_turbo_bf16.safetensors"
  download_one "Comfy-Org/z_image_turbo" \
    "split_files/text_encoders/qwen_3_4b.safetensors" \
    "text_encoders" "qwen_3_4b.safetensors"
  download_one "Comfy-Org/z_image_turbo" \
    "split_files/vae/ae.safetensors" \
    "vae" "ae.safetensors"

  download_shared_wan
  download_one "Comfy-Org/Wan_2.2_ComfyUI_Repackaged" \
    "split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors" \
    "diffusion_models" "wan2.2_ti2v_5B_fp16.safetensors"
  download_one "Comfy-Org/Wan_2.2_ComfyUI_Repackaged" \
    "split_files/vae/wan2.2_vae.safetensors" \
    "vae" "wan2.2_vae.safetensors"
}

download_quality() {
  download_shared_wan
  download_one "Comfy-Org/Wan_2.2_ComfyUI_Repackaged" \
    "split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors" \
    "diffusion_models" "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
  download_one "Comfy-Org/Wan_2.2_ComfyUI_Repackaged" \
    "split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors" \
    "diffusion_models" "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
  download_one "Comfy-Org/Wan_2.2_ComfyUI_Repackaged" \
    "split_files/vae/wan_2.1_vae.safetensors" \
    "vae" "wan_2.1_vae.safetensors"
  download_one "Comfy-Org/Wan_2.2_ComfyUI_Repackaged" \
    "split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors" \
    "loras" "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"
  download_one "Comfy-Org/Wan_2.2_ComfyUI_Repackaged" \
    "split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors" \
    "loras" "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"
}

if [[ "${PROFILE}" == "baseline" || "${PROFILE}" == "all" ]]; then
  download_baseline
fi
if [[ "${PROFILE}" == "quality" || "${PROFILE}" == "all" ]]; then
  download_quality
fi

echo "Model download profile '${PROFILE}' complete."
