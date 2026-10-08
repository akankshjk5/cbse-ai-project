#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RUNPOD_WORKSPACE_ROOT="${RUNPOD_WORKSPACE_ROOT:-/root/lumina-runtime}"
PID_FILE="${COMFY_PID_FILE:-/root/lumina-comfyui.pid}"
LOG_FILE="${COMFY_LOG_FILE:-/root/lumina-comfyui.log}"
URL="http://127.0.0.1:${COMFY_PORT:-8188}/system_stats"

if [[ -s "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  if curl --fail --silent --max-time 3 "${URL}" >/dev/null; then
    echo "ComfyUI already running as PID $(cat "${PID_FILE}")."
    exit 0
  fi
  kill "$(cat "${PID_FILE}")" 2>/dev/null || true
  sleep 2
fi

nohup bash "${SCRIPT_DIR}/start_comfyui.sh" </dev/null >>"${LOG_FILE}" 2>&1 &
echo "$!" >"${PID_FILE}"

for _ in $(seq 1 180); do
  if curl --fail --silent --max-time 3 "${URL}" >/dev/null; then
    echo "ComfyUI is ready as PID $(cat "${PID_FILE}"); log: ${LOG_FILE}."
    exit 0
  fi
  if ! kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    tail -n 100 "${LOG_FILE}" >&2 || true
    echo "ComfyUI exited before becoming ready." >&2
    exit 1
  fi
  sleep 2
done

tail -n 100 "${LOG_FILE}" >&2 || true
echo "ComfyUI did not become ready within 6 minutes." >&2
exit 1
