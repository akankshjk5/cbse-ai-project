#!/usr/bin/env bash
# Keep the Pod's services alive: every minute, restart any local agent, the
# vision checker, ComfyUI or the owner-scoped media worker whose health check
# fails. Run once per Pod (idempotent restarts, logs to /root/lumina-supervisor.log):
#   nohup bash supervise_services.sh <owner-reference-project-id> >/dev/null 2>&1 &
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OWNER_PROJECT_ID="${1:?Pass an existing lesson project id of the owner the worker serves}"
LOG=/root/lumina-supervisor.log

log() { echo "[supervise $(date -u +%H:%M:%S)] $*" >> "${LOG}"; }
healthy() { curl --fail --silent --max-time 5 -o /dev/null "$1"; }

while true; do
  healthy http://127.0.0.1:8188/system_stats || { log "ComfyUI down; restarting"; bash "${SCRIPT_DIR}/start_comfyui_background.sh" >> "${LOG}" 2>&1; }
  healthy http://127.0.0.1:18080/health || { log "planner down; restarting"; rm -f /root/lumina-local-planner.pid; bash "${SCRIPT_DIR}/start_local_agents.sh" planner >> "${LOG}" 2>&1; }
  if ! healthy http://127.0.0.1:18082/health || ! healthy http://127.0.0.1:18081/health; then
    log "translation or voice down; restarting"
    healthy http://127.0.0.1:18082/health || rm -f /root/lumina-local-translation.pid
    healthy http://127.0.0.1:18081/health || rm -f /root/lumina-local-tts.pid
    bash "${SCRIPT_DIR}/start_local_agents.sh" tts >> "${LOG}" 2>&1
  fi
  healthy http://127.0.0.1:18083/health || { log "vision down; restarting"; rm -f /root/lumina-local-vision.pid; bash "${SCRIPT_DIR}/start_local_agents.sh" vision >> "${LOG}" 2>&1; }
  if ! healthy http://127.0.0.1:8090/health; then
    log "media worker down; restarting"
    (cd "${SCRIPT_DIR}" && nohup bash launch_media_worker.sh --owner-project-id "${OWNER_PROJECT_ID}" \
      >> /root/lumina-media-worker.log 2>&1 < /dev/null &)
  fi
  sleep 60
done
