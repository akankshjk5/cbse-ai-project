#!/usr/bin/env bash
set -Eeuo pipefail

WORKSPACE_ROOT="${RUNPOD_WORKSPACE_ROOT:-/workspace}"
COMFY_DIR="${COMFY_DIR:-${WORKSPACE_ROOT}/ComfyUI}"
DEST="${COMFY_DIR}/user/default/workflows/lumina"
mkdir -p "${DEST}"

fetch() {
  local url="$1"
  local name="$2"
  local temp="${DEST}/${name}.part"
  echo "Fetching ${name}"
  curl --location --fail --silent --show-error --retry 4 --output "${temp}" "${url}"
  python3 -m json.tool "${temp}" >/dev/null
  mv "${temp}" "${DEST}/${name}"
}

fetch \
  "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_z_image_turbo.json" \
  "image_z_image_turbo.json"
fetch \
  "https://comfyanonymous.github.io/ComfyUI_examples/wan22/image_to_video_wan22_5B.json" \
  "image_to_video_wan22_5B.json"
fetch \
  "https://comfyanonymous.github.io/ComfyUI_examples/wan22/image_to_video_wan22_14B.json" \
  "image_to_video_wan22_14B.json"

echo "Official workflows saved to ${DEST}."
