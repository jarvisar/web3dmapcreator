"""Report the interpreter version and which download packages import.

The add-on runs this with the external downloader Python. Arguments are
``module=distribution`` pairs. Each result is flushed as its own line, so a
timeout still shows how far the check got. The syntax runs on any Python, so
an interpreter that is too old still reports its version.
"""

import json
import sys

MARKER = "JARVIZAR_PROBE "


def emit(value):
    sys.stdout.write(MARKER + json.dumps(value) + "\n")
    sys.stdout.flush()


def main(specs):
    emit({
        "python": list(sys.version_info[:3]),
        "executable": sys.executable,
        "prefix": sys.prefix,
        "base_prefix": getattr(sys, "base_prefix", sys.prefix),
        "bits": 64 if sys.maxsize > 2 ** 32 else 32,
    })
    if sys.version_info >= (3, 8):
        from importlib import metadata

        for spec in specs:
            module, _, distribution = spec.partition("=")
            entry = {"module": module, "ok": False}
            try:
                __import__(module)
                entry["ok"] = True
            except Exception as exc:
                entry["error"] = "%s: %s" % (type(exc).__name__, exc)
            try:
                entry["version"] = metadata.version(distribution or module)
            except Exception:
                pass
            emit(entry)
    emit({"done": True})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
