#!/usr/bin/env bash
set -Eeuo pipefail

PROFILE="${1:-baseline}"
WORKSPACE_ROOT="${RUNPOD_WORKSPACE_ROOT:-/workspace}"
COMFY_DIR="${COMFY_DIR:-${WORKSPACE_ROOT}/ComfyUI}"
MODEL_STORE_ROOT="${RUNPOD_MODEL_STORE_ROOT:-/models}"

case "${PROFILE}" in
  baseline|quality|all) ;;
  *) echo "Usage: $0 baseline|quality|all" >&2; exit 2 ;;
esac

"${COMFY_DIR}/.venv/bin/python" "$(dirname "$0")/verify_install.py" \
  --comfy-dir "${COMFY_DIR}" \
  --profile "${PROFILE}"

echo "Disk usage:"
du -sh "${COMFY_DIR}/models" "${MODEL_STORE_ROOT}" "${WORKSPACE_ROOT}/.model-downloads" 2>/dev/null || true
df -h "${WORKSPACE_ROOT}" "${MODEL_STORE_ROOT}"
