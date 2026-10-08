#!/usr/bin/env bash
set -Eeuo pipefail

PROFILE="${1:-all}"
[[ "${PROFILE}" == "planner" || "${PROFILE}" == "tts" || "${PROFILE}" == "vision" || "${PROFILE}" == "all" ]] || {
  echo "Usage: $0 [planner|tts|vision|all]" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="${RUNPOD_WORKSPACE_ROOT:-/root/lumina-runtime}"
MODEL_ROOT="${LOCAL_AI_MODEL_ROOT:-/workspace/lumina-local-ai}"
COMFY_PYTHON="${RUNTIME_ROOT}/ComfyUI/.venv/bin/python"
TTS_PYTHON="${RUNTIME_ROOT}/local-tts-venv/bin/python"
TRANSLATION_PYTHON="${RUNTIME_ROOT}/local-translation-venv/bin/python"

start_service() {
  local name="$1"
  local pid_file="$2"
  local log_file="$3"
  local health_url="$4"
  shift 4
  if [[ -s "${pid_file}" ]] && kill -0 "$(cat "${pid_file}")" 2>/dev/null; then
    echo "${name} already running as PID $(cat "${pid_file}")."
  else
    nohup env PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True "$@" >> "${log_file}" 2>&1 &
    echo "$!" > "${pid_file}"
  fi
  for _ in $(seq 1 360); do
    if curl --fail --silent --max-time 3 "${health_url}" >/dev/null; then
      echo "${name} is ready at ${health_url}."
      return 0
    fi
    if ! kill -0 "$(cat "${pid_file}")" 2>/dev/null; then
      tail -n 60 "${log_file}" >&2 || true
      echo "${name} exited before becoming ready." >&2
      return 1
    fi
    sleep 2
  done
  tail -n 60 "${log_file}" >&2 || true
  echo "${name} did not become ready within 12 minutes." >&2
  return 1
}

if [[ "${PROFILE}" == "planner" || "${PROFILE}" == "all" ]]; then
  # Qwen3-8B writes clearly better lessons than 4B (~4 min vs ~1 min planning).
  PLANNER_MODEL="${LOCAL_PLANNER_MODEL:-qwen3-8b}"
  [[ -s "${MODEL_ROOT}/${PLANNER_MODEL}/.lumina-complete" ]] || {
    echo "Local planner model ${PLANNER_MODEL} is not provisioned." >&2
    exit 1
  }
  start_service \
    "Local planner" "/root/lumina-local-planner.pid" "/root/lumina-local-planner.log" \
    "http://127.0.0.1:18080/health" \
    LOCAL_PLANNER_MODEL_PATH="${MODEL_ROOT}/${PLANNER_MODEL}" \
    "${COMFY_PYTHON}" "${SCRIPT_DIR}/local_planner_service.py"
fi

if [[ "${PROFILE}" == "tts" || "${PROFILE}" == "all" ]]; then
  [[ -x "${TRANSLATION_PYTHON}" && -s "${MODEL_ROOT}/indictrans2-en-indic-1b/.lumina-complete" ]] || {
    echo "Local translation runtime/model is not provisioned." >&2
    exit 1
  }
  start_service \
    "Local translation" "/root/lumina-local-translation.pid" "/root/lumina-local-translation.log" \
    "http://127.0.0.1:18082/health" \
    LOCAL_TRANSLATION_MODEL_PATH="${MODEL_ROOT}/indictrans2-en-indic-1b" \
    "${TRANSLATION_PYTHON}" "${SCRIPT_DIR}/local_translation_service.py"

  [[ -x "${TTS_PYTHON}" && -s "${MODEL_ROOT}/indic-parler-tts/.lumina-complete" ]] || {
    echo "Local TTS runtime/model is not provisioned." >&2
    exit 1
  }
  start_service \
    "Local TTS" "/root/lumina-local-tts.pid" "/root/lumina-local-tts.log" \
    "http://127.0.0.1:18081/health" \
    LOCAL_TTS_MODEL_PATH="${MODEL_ROOT}/indic-parler-tts" \
    LOCAL_TTS_DESCRIPTION_TOKENIZER_PATH="${MODEL_ROOT}/flan-t5-large-tokenizer" \
    "${TTS_PYTHON}" "${SCRIPT_DIR}/local_tts_service.py"
fi

if [[ "${PROFILE}" == "vision" || "${PROFILE}" == "all" ]]; then
  # Keyframe checker. Optional: the media worker skips the check when it is down.
  if [[ -s "${MODEL_ROOT}/qwen2.5-vl-3b/.lumina-complete" ]]; then
    start_service       "Local vision" "/root/lumina-local-vision.pid" "/root/lumina-local-vision.log"       "http://127.0.0.1:18083/health"       LOCAL_VISION_MODEL_PATH="${MODEL_ROOT}/qwen2.5-vl-3b"       "${COMFY_PYTHON}" "${SCRIPT_DIR}/local_vision_service.py"
  else
    echo "Local vision model is not provisioned; keyframe vision checks will be skipped." >&2
  fi
fi
