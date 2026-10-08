#!/usr/bin/env bash
set -Eeuo pipefail

WORKSPACE_ROOT="${RUNPOD_WORKSPACE_ROOT:-/workspace}"
RESULT_DIR="${BENCHMARK_RESULT_DIR:-${WORKSPACE_ROOT}/lumina-benchmarks}"
mkdir -p "${RESULT_DIR}"

output="${RESULT_DIR}/gpu-metrics.csv"
echo "Writing one-second GPU samples to ${output}; press Ctrl+C to stop."
nvidia-smi \
  --query-gpu=timestamp,name,memory.used,memory.total,utilization.gpu,power.draw,temperature.gpu \
  --format=csv \
  --loop=1 > "${output}"
