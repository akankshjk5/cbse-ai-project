#!/usr/bin/env bash
set -Eeuo pipefail

PROFILE="${1:-baseline}"
WORKSPACE_ROOT="${RUNPOD_WORKSPACE_ROOT:-/workspace}"
COMFY_DIR="${COMFY_DIR:-${WORKSPACE_ROOT}/ComfyUI}"
MODEL_STORE_ROOT="${RUNPOD_MODEL_STORE_ROOT:-/models}"
LOCAL_MODEL_ROOT="${RUNPOD_LOCAL_MODEL_ROOT:-${WORKSPACE_ROOT}/model-cache}"

case "${PROFILE}" in
  baseline|quality|all) ;;
  *) echo "Usage: $0 baseline|quality|all" >&2; exit 2 ;;
esac

PYTHON_BIN="${COMFY_DIR}/.venv/bin/python"
[[ -x "${PYTHON_BIN}" ]] || { echo "Run bootstrap.sh first; ${PYTHON_BIN} is missing." >&2; exit 1; }

baseline=(
  diffusion_models/z_image_turbo_bf16.safetensors
  text_encoders/qwen_3_4b.safetensors
  vae/ae.safetensors
  diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
  text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
  vae/wan2.2_vae.safetensors
)
quality=(
  diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors
  diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors
  text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
  vae/wan_2.1_vae.safetensors
  loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors
  loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors
)

models=()
if [[ "${PROFILE}" == "baseline" || "${PROFILE}" == "all" ]]; then
  models+=("${baseline[@]}")
fi
if [[ "${PROFILE}" == "quality" || "${PROFILE}" == "all" ]]; then
  models+=("${quality[@]}")
fi

declare -A seen=()
unique_models=()
required_bytes=0
for relative in "${models[@]}"; do
  [[ -n "${seen[${relative}]:-}" ]] && continue
  seen["${relative}"]=1
  source_path="${MODEL_STORE_ROOT}/${relative}"
  [[ -f "${source_path}" ]] || { echo "Persistent model is missing: ${source_path}" >&2; exit 1; }
  unique_models+=("${relative}")
  required_bytes=$((required_bytes + $(stat -c '%s' "${source_path}")))
done

mkdir -p "${LOCAL_MODEL_ROOT}"
available_bytes="$(df -B1 --output=avail "${LOCAL_MODEL_ROOT}" | tail -n 1 | tr -d ' ')"
existing_bytes=0
for relative in "${unique_models[@]}"; do
  target="${LOCAL_MODEL_ROOT}/${relative}"
  if [[ -f "${target}" ]] && [[ "$(stat -c '%s' "${target}")" == "$(stat -c '%s' "${MODEL_STORE_ROOT}/${relative}")" ]]; then
    existing_bytes=$((existing_bytes + $(stat -c '%s' "${target}")))
  fi
done
copy_bytes=$((required_bytes - existing_bytes))
reserve_bytes=$((2 * 1024 * 1024 * 1024))
if (( copy_bytes + reserve_bytes > available_bytes )); then
  echo "Insufficient local disk: need $((copy_bytes / 1024 / 1024 / 1024)) GiB plus 2 GiB reserve; have $((available_bytes / 1024 / 1024 / 1024)) GiB." >&2
  exit 1
fi

validate_file() {
  "${PYTHON_BIN}" - "$1" <<'PY'
import sys
from pathlib import Path
from safetensors import safe_open

path = Path(sys.argv[1])
if not path.is_file() or path.stat().st_size < 1_000_000:
    raise SystemExit(1)
with safe_open(path, framework="pt", device="cpu") as handle:
    if not handle.keys():
        raise SystemExit(1)
PY
}

for relative in "${unique_models[@]}"; do
  source_path="${MODEL_STORE_ROOT}/${relative}"
  local_path="${LOCAL_MODEL_ROOT}/${relative}"
  comfy_path="${COMFY_DIR}/models/${relative}"
  mkdir -p "$(dirname "${local_path}")" "$(dirname "${comfy_path}")"

  if ! validate_file "${local_path}" || [[ "$(stat -c '%s' "${local_path}" 2>/dev/null || echo 0)" != "$(stat -c '%s' "${source_path}")" ]]; then
    partial_path="${local_path}.partial"
    echo "Hydrating ${relative} to local NVMe..."
    cp --dereference -- "${source_path}" "${partial_path}"
    [[ "$(stat -c '%s' "${partial_path}")" == "$(stat -c '%s' "${source_path}")" ]] || {
      echo "Hydrated copy size mismatch: ${partial_path}" >&2
      exit 1
    }
    validate_file "${partial_path}" || { echo "Hydrated model failed validation: ${partial_path}" >&2; exit 1; }
    mv -f -- "${partial_path}" "${local_path}"
  else
    echo "Already hydrated and valid: ${local_path}"
  fi

  if [[ -e "${comfy_path}" && ! -L "${comfy_path}" ]]; then
    echo "Refusing to replace non-symlink ComfyUI model: ${comfy_path}" >&2
    exit 1
  fi
  ln -sfn "${local_path}" "${comfy_path}"
done

echo "Local hydration profile '${PROFILE}' complete at ${LOCAL_MODEL_ROOT}."
