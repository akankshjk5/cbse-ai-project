#!/usr/bin/env bash
# Rebuild the disposable /root runtime on a fresh RunPod container from the
# persistent /workspace volume, then start ComfyUI and the local agents.
#
# Every new Pod starts with an empty /root; models, fonts and the Hugging Face
# cache survive on /workspace. Run this once per new Pod:
#   bash /root/lumina-deck-pro/ops/runpod/restore_pod_runtime.sh
# Pass an existing lesson project id of the owner to also start the owner-scoped
# media worker and the service supervisor (needs /root/lumina-media-worker.env,
# Supabase service credentials that never go in Git):
#   bash restore_pod_runtime.sh <owner-reference-project-id>
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RUNPOD_WORKSPACE_ROOT="${RUNPOD_WORKSPACE_ROOT:-/root/lumina-runtime}"
export RUNPOD_MODEL_STORE_ROOT="${RUNPOD_MODEL_STORE_ROOT:-/workspace}"

log() { echo "[restore $(date -u +%H:%M:%S)] $*"; }

[[ -d /workspace/lumina-local-ai && -d /workspace/diffusion_models ]] || {
  echo "Persistent /workspace volume with Lumina models is not mounted." >&2
  exit 1
}
[[ -d /workspace/lumina-fonts ]] || echo "WARNING: /workspace/lumina-fonts is missing; Indic captions will fail." >&2

log "bootstrap: ComfyUI, Python environment, ffmpeg and tesseract checks"
bash "${SCRIPT_DIR}/bootstrap.sh"

log "hydrate: copy baseline image/video models from /workspace to local disk"
bash "${SCRIPT_DIR}/hydrate_models.sh" baseline

log "start ComfyUI"
bash "${SCRIPT_DIR}/start_comfyui_background.sh"

log "provision local agents (reuses persisted models; installs Python environments)"
bash "${SCRIPT_DIR}/provision_local_agents.sh" all

log "keyframe vision checker model"
VISION_DIR=/workspace/lumina-local-ai/qwen2.5-vl-3b
if [[ ! -s "${VISION_DIR}/.lumina-complete" ]]; then
  HF_HOME=/workspace/.cache/huggingface "${RUNPOD_WORKSPACE_ROOT}/ComfyUI/.venv/bin/hf" download     Qwen/Qwen2.5-VL-3B-Instruct --local-dir "${VISION_DIR}"     && date -u +%Y-%m-%dT%H:%M:%SZ > "${VISION_DIR}/.lumina-complete"     || echo "WARNING: vision model download failed; keyframe vision checks will be skipped." >&2
fi

log "voice listen-back model"
ASR_DIR=/workspace/lumina-local-ai/whisper-large-v3-turbo
if [[ ! -s "${ASR_DIR}/.lumina-complete" ]]; then
  if HF_HOME=/workspace/.cache/huggingface "${RUNPOD_WORKSPACE_ROOT}/ComfyUI/.venv/bin/hf" download openai/whisper-large-v3-turbo --local-dir "${ASR_DIR}"; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "${ASR_DIR}/.lumina-complete"
  else
    echo "WARNING: listen-back model download failed; each sentence will be recorded once." >&2
  fi
fi

log "start planner, translation, voice and vision"
bash "${SCRIPT_DIR}/start_local_agents.sh" all

log "runtime restored"
for url in http://127.0.0.1:8188/system_stats http://127.0.0.1:18080/health \
  http://127.0.0.1:18081/health http://127.0.0.1:18082/health http://127.0.0.1:18083/health; do
  printf '%s -> ' "${url}"
  curl --fail --silent --max-time 5 -o /dev/null -w '%{http_code}\n' "${url}" || echo "DOWN"
done

if [[ -n "${1:-}" && -r /root/lumina-media-worker.env ]]; then
  log "start owner-scoped media worker and service supervisor"
  (cd "${SCRIPT_DIR}" && nohup bash launch_media_worker.sh --owner-project-id "$1"     >> /root/lumina-media-worker.log 2>&1 < /dev/null &)
  (cd "${SCRIPT_DIR}" && nohup bash supervise_services.sh "$1" > /dev/null 2>&1 < /dev/null &)
fi
