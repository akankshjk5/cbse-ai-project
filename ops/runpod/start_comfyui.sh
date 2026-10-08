#!/usr/bin/env bash
set -Eeuo pipefail

WORKSPACE_ROOT="${RUNPOD_WORKSPACE_ROOT:-/workspace}"
COMFY_DIR="${COMFY_DIR:-${WORKSPACE_ROOT}/ComfyUI}"
PORT="${COMFY_PORT:-8188}"

if [[ -n "${RUNPOD_HYDRATE_PROFILE:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  bash "${SCRIPT_DIR}/hydrate_models.sh" "${RUNPOD_HYDRATE_PROFILE}"
fi

cd "${COMFY_DIR}"
exec "${COMFY_DIR}/.venv/bin/python" main.py \
  --listen 0.0.0.0 \
  --port "${PORT}" \
  --disable-api-nodes \
  --disable-auto-launch \
  --preview-method none
