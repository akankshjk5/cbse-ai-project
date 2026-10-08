#!/usr/bin/env bash
set -Eeuo pipefail

PROFILE="${1:-baseline}"
WORKSPACE_ROOT="${RUNPOD_WORKSPACE_ROOT:-/workspace}"
COMFY_DIR="${COMFY_DIR:-${WORKSPACE_ROOT}/ComfyUI}"
MODEL_STORE_ROOT="${RUNPOD_MODEL_STORE_ROOT:-/models}"
COMFY_TAG="${COMFY_TAG:-v0.36.0}"

case "${PROFILE}" in
  baseline|quality|all) ;;
  *) echo "Usage: $0 baseline|quality|all" >&2; exit 2 ;;
esac

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
[[ -d "${MODEL_STORE_ROOT}" && -w "${MODEL_STORE_ROOT}" ]] || {
  echo "Model volume must be mounted and writable at ${MODEL_STORE_ROOT}" >&2
  exit 1
}

mkdir -p "${WORKSPACE_ROOT}"
if [[ -d "${COMFY_DIR}/.git" ]]; then
  current_tag="$(git -C "${COMFY_DIR}" describe --tags --exact-match 2>/dev/null || true)"
  [[ "${current_tag}" == "${COMFY_TAG}" ]] || {
    echo "${COMFY_DIR} exists at '${current_tag:-an untagged commit}', expected ${COMFY_TAG}" >&2
    exit 1
  }
else
  git clone --branch "${COMFY_TAG}" --depth 1 https://github.com/Comfy-Org/ComfyUI.git "${COMFY_DIR}"
fi

if [[ ! -d "${COMFY_DIR}/.venv" ]]; then
  python3 -m venv --system-site-packages "${COMFY_DIR}/.venv"
fi
"${COMFY_DIR}/.venv/bin/python" -m pip install --upgrade pip
"${COMFY_DIR}/.venv/bin/python" -m pip install "huggingface_hub[cli]" safetensors

COMFY_DIR="${COMFY_DIR}" RUNPOD_WORKSPACE_ROOT="${WORKSPACE_ROOT}" RUNPOD_MODEL_STORE_ROOT="${MODEL_STORE_ROOT}" \
  bash "$(dirname "$0")/download_models.sh" "${PROFILE}"

echo "CPU preload complete. Terminate the CPU Pod; keep the Global model volume."
