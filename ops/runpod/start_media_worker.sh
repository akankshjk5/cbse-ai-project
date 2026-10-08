#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASE_URL:?Set SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Set SUPABASE_SERVICE_ROLE_KEY}"

export COMFYUI_URL="${COMFYUI_URL:-http://127.0.0.1:8188}"
export MEDIA_JOB_TIMEOUT_SECONDS="${MEDIA_JOB_TIMEOUT_SECONDS:-1800}"
export WAN_FAST_STEPS="${WAN_FAST_STEPS:-20}"
# Narrated lessons use real generated animation by default. These deterministic
# modes remain available only as explicit recovery switches for a broken GPU
# runtime; they must never silently replace the requested video product.
export LESSON_VIDEO_MOTION_MODE="${LESSON_VIDEO_MOTION_MODE:-wan}"
export LESSON_IMAGE_MODE="${LESSON_IMAGE_MODE:-generated}"

if [[ "${LESSON_IMAGE_MODE}" == "generated" ]] && ! command -v tesseract >/dev/null 2>&1; then
  echo "tesseract is required for the generated-storyboard quality gate." >&2
  echo "Install it with: apt-get update && apt-get install -y --no-install-recommends tesseract-ocr" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="${RUNPOD_WORKSPACE_ROOT:-/root/lumina-runtime}"
export WORKSPACE="${WORKSPACE:-${RUNTIME_ROOT}}"
export MEDIA_WORKFLOW_DIR="${MEDIA_WORKFLOW_DIR:-${SCRIPT_DIR}/workflows/api}"
export COMFYUI_INPUT_DIR="${COMFYUI_INPUT_DIR:-${RUNTIME_ROOT}/ComfyUI/input}"
export COMFYUI_OUTPUT_DIR="${COMFYUI_OUTPUT_DIR:-${RUNTIME_ROOT}/ComfyUI/output}"
export MEDIA_OUTPUT_DIR="${MEDIA_OUTPUT_DIR:-${RUNTIME_ROOT}/media-output}"

curl --fail --silent --show-error --max-time 10 "${COMFYUI_URL}/system_stats" >/dev/null || {
  echo "ComfyUI is not ready at ${COMFYUI_URL}; refusing to claim jobs." >&2
  exit 1
}

exec python3 "${SCRIPT_DIR}/media_worker.py" "$@"
