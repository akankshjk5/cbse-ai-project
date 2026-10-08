#!/usr/bin/env bash
set -Eeuo pipefail

PROFILE="${1:-all}"
[[ "${PROFILE}" == "planner" || "${PROFILE}" == "tts" || "${PROFILE}" == "all" ]] || {
  echo "Usage: $0 [planner|tts|all]" >&2
  exit 2
}

RUNTIME_ROOT="${RUNPOD_WORKSPACE_ROOT:-/root/lumina-runtime}"
MODEL_ROOT="${LOCAL_AI_MODEL_ROOT:-/workspace/lumina-local-ai}"
COMFY_PYTHON="${RUNTIME_ROOT}/ComfyUI/.venv/bin/python"
TTS_VENV="${RUNTIME_ROOT}/local-tts-venv"
TRANSLATION_VENV="${RUNTIME_ROOT}/local-translation-venv"
STAGE_ROOT="${RUNTIME_ROOT}/local-ai-stage"
PARLER_COMMIT="d108732cd57788ec86bc857d99a6cabd66663d68"
HF_TOKEN_FILE="${HF_TOKEN_FILE:-${HF_HOME:-/root/.cache/huggingface}/token}"
if [[ ! -s "${HF_TOKEN_FILE}" && -s /workspace/.cache/huggingface/token ]]; then
  HF_TOKEN_FILE=/workspace/.cache/huggingface/token
fi

[[ -x "${COMFY_PYTHON}" ]] || {
  echo "ComfyUI Python is missing: ${COMFY_PYTHON}" >&2
  exit 1
}
mkdir -p "${MODEL_ROOT}" "${STAGE_ROOT}"

download_snapshot() {
  local python_bin="$1"
  local repo_id="$2"
  local stage_dir="$3"
  local patterns_json="${4:-null}"
  mkdir -p "${stage_dir}"
  HF_HUB_DISABLE_XET=1 HF_HOME="${STAGE_ROOT}/hf-home" "${python_bin}" - \
    "${repo_id}" "${stage_dir}" "${patterns_json}" "${HF_TOKEN_FILE}" <<'PY'
import json
import pathlib
import sys
from huggingface_hub import snapshot_download

repo_id, local_dir, patterns_raw, token_file = sys.argv[1:]
patterns = json.loads(patterns_raw)
token_path = pathlib.Path(token_file)
token = token_path.read_text(encoding="utf-8").strip() if token_path.is_file() else None
snapshot_download(
    repo_id=repo_id,
    local_dir=local_dir,
    allow_patterns=patterns,
    token=token,
)
PY
  rm -rf -- "${STAGE_ROOT}/hf-home"
}

publish_snapshot() {
  local stage_dir="$1"
  local destination="$2"
  local copy_status=0
  rm -rf -- "${stage_dir}/.cache"
  mkdir -p "${destination}"
  # RunPod Global volumes are object-backed and reject POSIX metadata updates.
  # GNU cp can still return non-zero after copying all bytes because its final
  # chmod calls are unsupported. Accept that condition only after checking that
  # every staged file exists at the destination with the exact same byte size.
  cp -R --no-preserve=all "${stage_dir}/." "${destination}/" || copy_status=$?
  while IFS= read -r -d '' source_file; do
    relative_path="${source_file#${stage_dir}/}"
    destination_file="${destination}/${relative_path}"
    [[ -f "${destination_file}" ]] || {
      echo "Published model file is missing: ${relative_path}" >&2
      exit 1
    }
    [[ "$(stat -c '%s' "${source_file}")" == "$(stat -c '%s' "${destination_file}")" ]] || {
      echo "Published model file has the wrong size: ${relative_path}" >&2
      exit 1
    }
  done < <(find "${stage_dir}" -type f -print0)
  if (( copy_status != 0 )); then
    echo "Copy reported unsupported metadata operations; all model bytes were verified." >&2
  fi
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${destination}/.lumina-complete"
  rm -rf -- "${stage_dir}"
}

if [[ "${PROFILE}" == "planner" || "${PROFILE}" == "all" ]]; then
  planner_dest="${MODEL_ROOT}/qwen3-4b"
  if [[ ! -s "${planner_dest}/.lumina-complete" ]]; then
    planner_stage="${STAGE_ROOT}/qwen3-4b"
    staged_planner_bytes="$(find "${planner_stage}" -type f -name '*.safetensors' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')"
    if [[ ! -s "${planner_stage}/config.json" ]] || (( staged_planner_bytes < 7500000000 )); then
      available_kb="$(df -Pk "${RUNTIME_ROOT}" | awk 'NR==2 {print $4}')"
      (( available_kb >= 9437184 )) || {
        echo "At least 9 GiB free container storage is required to stage Qwen3-4B." >&2
        exit 1
      }
      download_snapshot "${COMFY_PYTHON}" "Qwen/Qwen3-4B" "${planner_stage}"
    fi
    [[ -s "${STAGE_ROOT}/qwen3-4b/config.json" ]] || { echo "Qwen config missing" >&2; exit 1; }
    planner_bytes="$(find "${STAGE_ROOT}/qwen3-4b" -type f -name '*.safetensors' -printf '%s\n' | awk '{s+=$1} END {print s+0}')"
    (( planner_bytes >= 7500000000 )) || { echo "Qwen weights are incomplete" >&2; exit 1; }
    publish_snapshot "${STAGE_ROOT}/qwen3-4b" "${planner_dest}"
  fi
fi

if [[ "${PROFILE}" == "tts" || "${PROFILE}" == "all" ]]; then
  if [[ ! -x "${TRANSLATION_VENV}/bin/python" ]]; then
    python3 -m venv --system-site-packages "${TRANSLATION_VENV}"
  fi
  "${TRANSLATION_VENV}/bin/pip" install --no-cache-dir \
    "transformers>=4.51,<5" "indictranstoolkit==1.1.1" sentencepiece

  translation_dest="${MODEL_ROOT}/indictrans2-en-indic-1b"
  if [[ ! -s "${translation_dest}/.lumina-complete" \
    && -s "${translation_dest}/config.json" \
    && -s "${translation_dest}/model.safetensors" \
    && "$(stat -c '%s' "${translation_dest}/model.safetensors")" -ge 4400000000 ]]; then
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${translation_dest}/.lumina-complete"
    echo "Recovered the complete persisted IndicTrans2 snapshot."
  fi
  if [[ ! -s "${translation_dest}/.lumina-complete" ]]; then
    available_kb="$(df -Pk "${RUNTIME_ROOT}" | awk 'NR==2 {print $4}')"
    (( available_kb >= 4194304 )) || {
      echo "At least 4 GiB free container storage is required to stage IndicTrans2." >&2
      exit 1
    }
    download_snapshot "${TRANSLATION_VENV}/bin/python" \
      "ai4bharat/indictrans2-en-indic-1B" "${STAGE_ROOT}/indictrans2-en-indic-1b" \
      '["config.json","generation_config.json","configuration_indictrans.py","modeling_indictrans.py","tokenization_indictrans.py","dict.*.json","model.SRC","model.TGT","tokenizer_config.json","special_tokens_map.json","model.safetensors","LICENSE","README.md"]'
    [[ -s "${STAGE_ROOT}/indictrans2-en-indic-1b/config.json" ]] || {
      echo "IndicTrans2 config missing" >&2
      exit 1
    }
    translation_bytes="$(find "${STAGE_ROOT}/indictrans2-en-indic-1b" -type f \
      \( -name '*.safetensors' -o -name 'pytorch_model*.bin' \) -printf '%s\n' \
      | awk '{s+=$1} END {print s+0}')"
    (( translation_bytes >= 4400000000 )) || { echo "IndicTrans2 weights are incomplete" >&2; exit 1; }
    publish_snapshot "${STAGE_ROOT}/indictrans2-en-indic-1b" "${translation_dest}"
  fi

  if [[ ! -x "${TTS_VENV}/bin/python" ]]; then
    python3 -m venv --system-site-packages "${TTS_VENV}"
  fi
  "${TTS_VENV}/bin/pip" install --no-cache-dir \
    "git+https://github.com/huggingface/parler-tts.git@${PARLER_COMMIT}"

  tts_dest="${MODEL_ROOT}/indic-parler-tts"
  if [[ ! -s "${tts_dest}/.lumina-complete" \
    && -s "${tts_dest}/config.json" \
    && -s "${tts_dest}/model.safetensors" \
    && "$(stat -c '%s' "${tts_dest}/model.safetensors")" -ge 3500000000 ]]; then
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${tts_dest}/.lumina-complete"
    echo "Recovered the complete persisted Indic Parler-TTS snapshot."
  fi
  if [[ ! -s "${tts_dest}/.lumina-complete" ]]; then
    available_kb="$(df -Pk "${RUNTIME_ROOT}" | awk 'NR==2 {print $4}')"
    (( available_kb >= 5242880 )) || {
      echo "At least 5 GiB free container storage is required to stage Indic Parler-TTS." >&2
      exit 1
    }
    download_snapshot "${TTS_VENV}/bin/python" "ai4bharat/indic-parler-tts" "${STAGE_ROOT}/indic-parler-tts"
    [[ -s "${STAGE_ROOT}/indic-parler-tts/model.safetensors" ]] || { echo "Indic TTS weights missing" >&2; exit 1; }
    tts_bytes="$(stat -c '%s' "${STAGE_ROOT}/indic-parler-tts/model.safetensors")"
    (( tts_bytes >= 3500000000 )) || { echo "Indic TTS weights are incomplete" >&2; exit 1; }
    publish_snapshot "${STAGE_ROOT}/indic-parler-tts" "${tts_dest}"
  fi

  tokenizer_dest="${MODEL_ROOT}/flan-t5-large-tokenizer"
  if [[ ! -s "${tokenizer_dest}/.lumina-complete" ]]; then
    download_snapshot "${TTS_VENV}/bin/python" "google/flan-t5-large" "${STAGE_ROOT}/flan-tokenizer" \
      '["config.json","tokenizer.json","tokenizer_config.json","special_tokens_map.json","spiece.model","generation_config.json"]'
    [[ -s "${STAGE_ROOT}/flan-tokenizer/spiece.model" ]] || { echo "Description tokenizer missing" >&2; exit 1; }
    publish_snapshot "${STAGE_ROOT}/flan-tokenizer" "${tokenizer_dest}"
  fi
fi

echo "Local agent profile '${PROFILE}' is provisioned under ${MODEL_ROOT}."
