#!/usr/bin/env bash
set -Eeuo pipefail

WORKSPACE_ROOT="${RUNPOD_WORKSPACE_ROOT:-/workspace}"
COMFY_DIR="${COMFY_DIR:-${WORKSPACE_ROOT}/ComfyUI}"
MODEL_STORE_ROOT="${RUNPOD_MODEL_STORE_ROOT:-/models}"
COMFY_TAG="${COMFY_TAG:-v0.36.0}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v nvidia-smi >/dev/null 2>&1 || fail "nvidia-smi is unavailable; use a GPU-enabled RunPod template."
command -v git >/dev/null 2>&1 || fail "git is required."
command -v python3 >/dev/null 2>&1 || fail "python3 is required."
[[ -d "${MODEL_STORE_ROOT}" ]] || fail "Model volume is not mounted at ${MODEL_STORE_ROOT}."
[[ -w "${MODEL_STORE_ROOT}" ]] || fail "Model volume is not writable at ${MODEL_STORE_ROOT}."

gpu_name="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1 | tr -d '\r')"
gpu_memory="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n 1 | tr -d '\r ' )"
echo "GPU: ${gpu_name} (${gpu_memory} MiB)"

if [[ ! "${gpu_memory}" =~ ^[0-9]+$ ]] || (( gpu_memory < 45000 )); then
  fail "This benchmark requires at least 45,000 MiB VRAM; selected GPU reports ${gpu_memory:-unknown}."
fi

mkdir -p "${WORKSPACE_ROOT}"

if [[ -d "${COMFY_DIR}/.git" ]]; then
  current_tag="$(git -C "${COMFY_DIR}" describe --tags --exact-match 2>/dev/null || true)"
  if [[ "${current_tag}" != "${COMFY_TAG}" ]]; then
    fail "${COMFY_DIR} already exists at '${current_tag:-an untagged commit}'. Set COMFY_DIR to a new path or use the expected ${COMFY_TAG}."
  fi
else
  git clone --branch "${COMFY_TAG}" --depth 1 https://github.com/Comfy-Org/ComfyUI.git "${COMFY_DIR}"
fi

if [[ ! -d "${COMFY_DIR}/.venv" ]]; then
  python3 -m venv --system-site-packages "${COMFY_DIR}/.venv"
fi

"${COMFY_DIR}/.venv/bin/python" -m pip install --upgrade pip
"${COMFY_DIR}/.venv/bin/python" -m pip install -r "${COMFY_DIR}/requirements.txt"
"${COMFY_DIR}/.venv/bin/python" -m pip install "huggingface_hub[cli]" safetensors

"${COMFY_DIR}/.venv/bin/python" - <<'PY'
import sys
import torch

print(f"Python: {sys.version.split()[0]}")
print(f"PyTorch: {torch.__version__}")
print(f"CUDA runtime: {torch.version.cuda}")
if not torch.cuda.is_available():
    raise SystemExit("ERROR: PyTorch cannot see CUDA. Fix the RunPod template before downloading models.")
props = torch.cuda.get_device_properties(0)
print(f"CUDA device: {props.name}; capability {props.major}.{props.minor}; VRAM {props.total_memory / 2**30:.1f} GiB")
if (props.major, props.minor) != (8, 9):
    print("WARNING: expected RTX 6000 Ada compute capability 8.9.")
PY

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  fail "ffmpeg and ffprobe are required. Choose a RunPod image that includes them or install them before continuing."
fi

if ! command -v tesseract >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tesseract-ocr
    rm -rf /var/lib/apt/lists/*
  else
    fail "tesseract is required for storyboard OCR validation. Install tesseract-ocr before continuing."
  fi
fi

mkdir -p \
  "${MODEL_STORE_ROOT}/diffusion_models" \
  "${MODEL_STORE_ROOT}/text_encoders" \
  "${MODEL_STORE_ROOT}/vae" \
  "${MODEL_STORE_ROOT}/loras" \
  "${COMFY_DIR}/models/diffusion_models" \
  "${COMFY_DIR}/models/text_encoders" \
  "${COMFY_DIR}/models/vae" \
  "${COMFY_DIR}/models/loras" \
  "${COMFY_DIR}/user/default/workflows/lumina" \
  "${WORKSPACE_ROOT}/lumina-benchmarks"

echo "Bootstrap complete at ${COMFY_DIR}; persistent model store: ${MODEL_STORE_ROOT}."
