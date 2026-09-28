#!/usr/bin/env sh
# Create or reuse this repository's .venv-overture with the downloader
# requirements, using the setup script that ships with the add-on.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ "$#" -gt 1 ]; then
    printf '%s\n' "Usage: $0 [python-interpreter]" >&2
    exit 2
fi

exec sh "$PROJECT_ROOT/jarvizar_city_model/setup/setup_downloader.sh" \
    --venv "$PROJECT_ROOT/.venv-overture" ${1:+--python "$1"}
