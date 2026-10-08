#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RUNPOD_WORKSPACE_ROOT="${RUNPOD_WORKSPACE_ROOT:-/root/lumina-runtime}"
export RUNPOD_MODEL_STORE_ROOT="${RUNPOD_MODEL_STORE_ROOT:-/workspace}"
export RUNPOD_HYDRATE_PROFILE="${RUNPOD_HYDRATE_PROFILE:-baseline}"

bash -n "${SCRIPT_DIR}"/*.sh
bash "${SCRIPT_DIR}/bootstrap.sh"
bash "${SCRIPT_DIR}/download_models.sh" baseline
bash "${SCRIPT_DIR}/fetch_workflows.sh"
bash "${SCRIPT_DIR}/preflight.sh" baseline
exec bash "${SCRIPT_DIR}/start_comfyui.sh"
