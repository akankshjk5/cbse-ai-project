#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${MEDIA_WORKER_ENV_FILE:-/root/lumina-media-worker.env}"

[[ -r "${ENV_FILE}" ]] || {
  echo "Worker environment file is not readable: ${ENV_FILE}" >&2
  exit 1
}

# Files uploaded from Windows may use CRLF. Source a protected, normalized
# temporary copy so carriage returns never become part of environment values.
NORMALIZED_ENV="$(mktemp /tmp/lumina-worker-env.XXXXXX)"
trap 'rm -f -- "${NORMALIZED_ENV}"' EXIT
chmod 600 "${NORMALIZED_ENV}"
tr -d '\r' < "${ENV_FILE}" > "${NORMALIZED_ENV}"

set -a
# shellcheck disable=SC1090
source "${NORMALIZED_ENV}"
set +a

rm -f -- "${NORMALIZED_ENV}"
trap - EXIT
exec bash "${SCRIPT_DIR}/start_media_worker.sh" "$@"
