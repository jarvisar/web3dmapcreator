#!/bin/sh
# Create or update the separate Python environment that the Jarvizar City
# Model add-on uses to download map data. Blender's own Python is not changed.
#
#   sh setup_downloader.sh [options]
#
#   --with-lidar    Also install the optional LiDAR building packages.
#   --python PATH   Create the environment with this Python 3.10 or newer.
#   --venv DIR      Environment folder. Default: on macOS
#                   ~/Library/Application Support/JarvizarCityModel/downloader-venv,
#                   elsewhere ${XDG_DATA_HOME:-~/.local/share}/jarvizar-city-model/downloader-venv
#   --skip-install  Create the environment but do not run pip (for testing).
#
# Running it again updates the packages; an environment that no longer runs
# is recreated. The last line printed is the interpreter path.
set -eu

SETUP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DOWNLOADER_REQUIREMENTS="$SETUP_DIR/requirements-downloader.txt"
LIDAR_REQUIREMENTS="$SETUP_DIR/requirements-lidar.txt"
PYTHON=""
VENV=""
WITH_LIDAR=0
SKIP_INSTALL=0
SYSTEM=$(uname -s 2>/dev/null || echo unknown)

fail() {
    printf '\nSetup failed: %s\n' "$1" >&2
    exit 1
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --with-lidar) WITH_LIDAR=1 ;;
        --skip-install) SKIP_INSTALL=1 ;;
        --python) [ "$#" -ge 2 ] || fail "--python needs a path"; PYTHON=$2; shift ;;
        --python=*) PYTHON=${1#--python=} ;;
        --venv) [ "$#" -ge 2 ] || fail "--venv needs a folder"; VENV=$2; shift ;;
        --venv=*) VENV=${1#--venv=} ;;
        -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
        *) fail "Unknown option: $1 (see --help)" ;;
    esac
    shift
done

for FILE in "$DOWNLOADER_REQUIREMENTS" "$LIDAR_REQUIREMENTS"; do
    [ -f "$FILE" ] || fail "Missing $FILE. Reinstall the add-on."
done

if [ -z "$VENV" ]; then
    case "$SYSTEM" in
        Darwin) VENV="$HOME/Library/Application Support/JarvizarCityModel/downloader-venv" ;;
        *) VENV="${XDG_DATA_HOME:-$HOME/.local/share}/jarvizar-city-model/downloader-venv" ;;
    esac
fi
case "$VENV" in
    /*|?:*) ;;
    *) VENV="$(pwd)/$VENV" ;;
esac
case "$SYSTEM" in
    MINGW*|MSYS*|CYGWIN*) VENV_PYTHON="$VENV/Scripts/python.exe" ;;
    *) VENV_PYTHON="$VENV/bin/python" ;;
esac

# Succeeds for Python 3.10 or newer.
python_ok() {
    "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

find_python() {
    for NAME in python3.11 python3.12 python3.13 python3.10 python3.14 python3 python \
        /opt/homebrew/bin/python3 /usr/local/bin/python3 \
        /Library/Frameworks/Python.framework/Versions/Current/bin/python3; do
        CANDIDATE=$(command -v "$NAME" 2>/dev/null) || continue
        # Without the Xcode command line tools, Apple's python3 only opens
        # an install dialog.
        if [ "$SYSTEM" = Darwin ] && [ "$CANDIDATE" = /usr/bin/python3 ] \
            && ! xcode-select -p >/dev/null 2>&1; then
            continue
        fi
        if python_ok "$CANDIDATE"; then
            printf '%s\n' "$CANDIDATE"
            return 0
        fi
    done
    return 1
}

python_missing() {
    printf '\n%s\n' "Python 3.10 or newer was not found." >&2
    case "$SYSTEM" in
        Darwin) printf '%s\n' \
            "Install Python 3.11, 3.12 or 3.13 from https://www.python.org/downloads/macos/" \
            "(or with Homebrew: brew install python@3.12), then open a new Terminal" \
            "window and run the setup command again." >&2 ;;
        *) printf '%s\n' \
            "Install it with your package manager, for example on Debian or Ubuntu:" \
            "  sudo apt install python3 python3-venv" \
            "then run the setup command again." >&2 ;;
    esac
    exit 1
}

printf '%s\n' "Jarvizar City Model downloader setup" "Environment: $VENV"

REUSE=0
if [ -f "$VENV_PYTHON" ]; then
    if "$VENV_PYTHON" -c 'import sys' >/dev/null 2>&1; then
        REUSE=1
        printf '%s\n' "Using the existing environment."
    else
        printf '%s\n' "The existing environment does not run; recreating it."
    fi
fi

if [ "$REUSE" -eq 0 ]; then
    if [ -n "$PYTHON" ]; then
        BASE=$PYTHON
        python_ok "$BASE" || fail "$BASE is not Python 3.10 or newer."
    else
        BASE=$(find_python) || python_missing
    fi
    "$BASE" -c 'import sys; print("Using Python %d.%d.%d: %s" % (sys.version_info[:3] + (sys.executable,)))'
    CLEAR=""
    if [ -d "$VENV" ]; then
        if [ -f "$VENV/pyvenv.cfg" ]; then
            CLEAR="--clear"
        elif [ -n "$(ls -A "$VENV" 2>/dev/null)" ]; then
            fail "$VENV exists and is not a Python environment. Choose an empty folder."
        fi
    fi
    mkdir -p "$(dirname -- "$VENV")"
    # shellcheck disable=SC2086 # CLEAR is empty or one option
    "$BASE" -m venv $CLEAR "$VENV" || fail "Could not create the environment at $VENV. On Debian or Ubuntu, install python3-venv (sudo apt install python3-venv) and run setup again."
    [ -f "$VENV_PYTHON" ] || fail "The environment was not created at $VENV."
fi

if [ "$SKIP_INSTALL" -eq 1 ]; then
    printf '%s\n' "Skipping package installation (--skip-install)."
else
    if ! "$VENV_PYTHON" -m pip --version >/dev/null 2>&1; then
        "$VENV_PYTHON" -m ensurepip --upgrade >/dev/null 2>&1 || fail "pip is missing. On Debian or Ubuntu, install python3-venv (sudo apt install python3-venv), then run setup again."
    fi
    printf '\n%s\n' "Updating pip..."
    "$VENV_PYTHON" -m pip install --upgrade pip || printf '%s\n' "Could not update pip; continuing with the installed version."
    REQUIREMENTS=$DOWNLOADER_REQUIREMENTS
    if [ "$WITH_LIDAR" -eq 1 ]; then
        REQUIREMENTS=$LIDAR_REQUIREMENTS
    fi
    printf '\n%s\n' "Installing $REQUIREMENTS..."
    "$VENV_PYTHON" -m pip install --requirement "$REQUIREMENTS" || fail "Package installation failed. Check the internet connection and run setup again."

    VERIFY="import importlib.metadata as m, overturemaps.core; v = m.version('overturemaps'); print('overturemaps ' + v)"
    EXPECTED=$(sed -n 's/^[[:space:]]*overturemaps[[:space:]]*==[[:space:]]*\([^[:space:]#;]*\).*/\1/p' "$DOWNLOADER_REQUIREMENTS" | head -n 1)
    if [ -n "$EXPECTED" ]; then
        VERIFY="$VERIFY; assert v == '$EXPECTED', 'expected $EXPECTED, found ' + v"
    fi
    "$VENV_PYTHON" -c "$VERIFY" || fail "overturemaps does not import in $VENV."
    if [ "$WITH_LIDAR" -eq 1 ]; then
        "$VENV_PYTHON" -c "import laspy, lazrs, pyproj, shapely, shapefile; print('LiDAR packages ready')" || fail "The LiDAR packages do not import in $VENV."
    fi
fi

printf '\n%s\n%s\n%s\n' \
    "Setup complete. In Blender, click Detect in Downloader Setup," \
    "or set the add-on preference Overture Python to this path:" \
    "$VENV_PYTHON"
