#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REQUIREMENTS_PATH="$PROJECT_ROOT/requirements-downloader.txt"
VENV_PATH="$PROJECT_ROOT/.venv-overture"
VENV_PYTHON="$VENV_PATH/bin/python"

if [ ! -f "$REQUIREMENTS_PATH" ]; then
    printf '%s\n' "Requirements file not found: $REQUIREMENTS_PATH" >&2
    exit 1
fi

if [ "$#" -gt 1 ]; then
    printf '%s\n' "Usage: $0 [python-interpreter]" >&2
    exit 2
fi

if [ "$#" -eq 1 ]; then
    BASE_PYTHON=$1
else
    BASE_PYTHON=""
    for CANDIDATE in python3.11 python3; do
        if command -v "$CANDIDATE" >/dev/null 2>&1 && \
            "$CANDIDATE" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
            BASE_PYTHON=$CANDIDATE
            break
        fi
    done
fi

if [ -z "$BASE_PYTHON" ]; then
    printf '%s\n' "Python 3.10 or newer was not found. Install Python 3.11 or pass an interpreter path." >&2
    exit 1
fi

if ! "$BASE_PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
    printf '%s\n' "The selected interpreter must be Python 3.10 or newer: $BASE_PYTHON" >&2
    exit 1
fi

if [ ! -x "$VENV_PYTHON" ]; then
    printf '%s\n' "Creating downloader environment at $VENV_PATH"
    "$BASE_PYTHON" -m venv "$VENV_PATH"
else
    printf '%s\n' "Reusing downloader environment at $VENV_PATH"
fi

"$VENV_PYTHON" -m pip install --upgrade pip
"$VENV_PYTHON" -m pip install --requirement "$REQUIREMENTS_PATH"
"$VENV_PYTHON" -c "import importlib.metadata as metadata; version = metadata.version('overturemaps'); assert version == '1.0.2', version; print('overturemaps ' + version + ' is ready')"

printf '%s\n' "Set Blender's 'Overture Python' field to:"
printf '%s\n' "$VENV_PYTHON"
