"""The extension build carries the downloader setup and works as bl_ext.*.

Blender 4.2+ only. Builds the extension zip, installs it into a temporary
local repository, then checks the packaged setup files, Detect and the
support report under the extension's package name, and removes it again::

    blender --background --factory-startup --python-exit-code 1 --python tests/blender_setup_extension.py -- .venv-overture/Scripts/python.exe

Nothing is downloaded. Prints JARVIZAR_SETUP_EXTENSION_OK.
"""

import importlib.util
import os
from pathlib import Path
import sys
import tempfile

import bpy

ROOT = Path(__file__).resolve().parents[1]
arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
DOWNLOADER = os.path.abspath(arguments[0] if arguments else os.environ.get("JARVIZAR_TEST_DOWNLOADER_PYTHON", ""))
assert Path(DOWNLOADER).is_file(), f"Pass a working downloader python after --, not {DOWNLOADER!r}"
assert bpy.app.version >= (4, 2, 0), "Extensions need Blender 4.2 or newer"
os.environ.pop("JARVIZAR_OVERTURE_PYTHON", None)

spec = importlib.util.spec_from_file_location("build_addon", ROOT / "scripts" / "build_addon.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

with tempfile.TemporaryDirectory() as folder:
    folder = Path(folder)
    archive = folder / "jarvizar_city_model-extension.zip"
    builder.write_archive(archive, extension_layout=True)
    repositories = bpy.context.preferences.extensions.repos
    assert bpy.ops.preferences.extension_repo_add(
        name="jarvizar_setup_test", type="LOCAL", use_custom_directory=True,
        custom_directory=str(folder / "repository")) == {"FINISHED"}
    repository = next(item for item in repositories if item.name == "jarvizar_setup_test")
    try:
        assert bpy.ops.extensions.package_install_files(
            filepath=str(archive), repo=repository.module, enable_on_install=True) == {"FINISHED"}
        name = f"bl_ext.{repository.module}.jarvizar_city_model"
        assert name in bpy.context.preferences.addons, name
        environment = sys.modules[name + ".data.environment"]
        installed = Path(sys.modules[name].__file__).parent
        assert environment.SETUP_DIR == installed / "setup"
        assert not (environment.SETUP_DIR / "setup_downloader.sh").read_bytes().count(b"\r")
        assert (environment.SETUP_DIR / "setup_downloader.cmd").read_bytes().count(b"\r\n") > 3
        assert str(environment.setup_script()) in environment.setup_command()

        preferences = bpy.context.preferences.addons[name].preferences
        os.environ["JARVIZAR_OVERTURE_PYTHON"] = DOWNLOADER
        assert bpy.ops.jarvizar.detect_downloader() == {"FINISHED"}
        del os.environ["JARVIZAR_OVERTURE_PYTHON"]
        assert os.path.samefile(preferences.overture_python_path, DOWNLOADER)
        settings = bpy.context.scene.jarvizar_city_model
        settings.cache_directory = str(folder / "cache")
        assert bpy.ops.jarvizar.copy_support_info() == {"FINISHED"}
        report = next((folder / "cache" / "support").glob("*.txt")).read_text(encoding="utf-8")
        assert f"Package: {name} (extension)" in report, report[:600]
        assert "[ok] overturemaps" in report
        assert bpy.ops.preferences.addon_disable(module=name) == {"FINISHED"}
        assert bpy.ops.extensions.package_uninstall(
            repo_index=list(repositories).index(repository), pkg_id="jarvizar_city_model") == {"FINISHED"}
    finally:
        bpy.ops.preferences.extension_repo_remove(index=list(repositories).index(repository))

print("JARVIZAR_SETUP_EXTENSION_OK")
