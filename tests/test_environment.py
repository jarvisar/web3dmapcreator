"""Finding and checking the downloader's Python, without Blender."""

import json
import os
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jarvizar_city_model.data import environment
from jarvizar_city_model.data.environment import Candidate
from jarvizar_city_model.data.overture import OvertureDownloadError, resolve_python

WINDOWS = os.name == "nt"
MARKER = environment.PROBE_MARKER


def probe_output(version=(3, 11, 5), prefix="/env", modules=(), done=True):
    """Probe lines: the interpreter record, then (module, ok, version, error)."""
    lines = ["unrelated output",
             MARKER + json.dumps({"python": list(version), "executable": "/env/bin/python",
                                  "prefix": prefix, "base_prefix": prefix, "bits": 64})]
    for module, ok, module_version, error in modules:
        record = {"module": module, "ok": ok}
        if module_version:
            record["version"] = module_version
        if error:
            record["error"] = error
        lines.append(MARKER + json.dumps(record))
    if done:
        lines.append(MARKER + json.dumps({"done": True}))
    return "\n".join(lines) + "\n"


WORKING = [("overturemaps.core", True, "1.0.2", "")]
LIDAR = [("laspy", True, "2.7.0", ""), ("lazrs", True, "0.8.2", ""), ("pyproj", True, "3.7.2", ""),
         ("shapely", True, "2.1.2", ""), ("shapefile", True, "2.3.1", "")]


class FakeRunner:
    def __init__(self, code=0, stdout="", stderr="", timed_out=False):
        self.result = (code, stdout, stderr, timed_out)
        self.commands = []

    def __call__(self, command, timeout):
        self.commands.append(command)
        return self.result


class TemporaryFiles(unittest.TestCase):
    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)
        environment.forget()

    def tearDown(self):
        environment.forget()
        self._directory.cleanup()

    def touch(self, *parts, text=""):
        path = self.root.joinpath(*parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def validate(self, path, runner, **options):
        options.setdefault("expected_version", "1.0.2")
        return environment.validate_interpreter(path, runner=runner, **options)


class LocationTests(unittest.TestCase):
    def test_default_environment_is_per_user_and_outside_the_add_on(self):
        home = Path("home")
        self.assertEqual(
            environment.default_venv_dir("win32", {"LOCALAPPDATA": "L"}, home),
            Path("L", "JarvizarCityModel", "downloader-venv"))
        self.assertEqual(
            environment.default_venv_dir("win32", {}, home),
            home / "AppData" / "Local" / "JarvizarCityModel" / "downloader-venv")
        self.assertEqual(
            environment.default_venv_dir("darwin", {}, home),
            home / "Library" / "Application Support" / "JarvizarCityModel" / "downloader-venv")
        self.assertEqual(
            environment.default_venv_dir("linux", {"XDG_DATA_HOME": "data"}, home),
            Path("data", "jarvizar-city-model", "downloader-venv"))
        self.assertEqual(
            environment.default_venv_dir("linux", {"XDG_DATA_HOME": ""}, home),
            home / ".local" / "share" / "jarvizar-city-model" / "downloader-venv")

    def test_interpreter_layout_follows_the_platform(self):
        self.assertEqual(environment.venv_python("v", "win32"), Path("v", "Scripts", "python.exe"))
        self.assertEqual(environment.venv_python("v", "linux"), Path("v", "bin", "python"))
        self.assertEqual(environment.developer_venv_python(Path("repo", "pkg"), "linux"),
                         Path("repo", ".venv-overture", "bin", "python"))


class CandidateTests(TemporaryFiles):
    def found(self, scene="", preference="", variable="", **options):
        options.setdefault("home", self.root / "home")
        options.setdefault("package_dir", self.root / "repo" / "jarvizar_city_model")
        return environment.candidates(scene, preference, {"JARVIZAR_OVERTURE_PYTHON": variable},
                                      "linux", **options)

    def test_candidates_keep_priority_and_drop_blanks_and_duplicates(self):
        found = self.found(" ", "/p/python", "/p/python")
        self.assertEqual([item.source for item in found],
                         [environment.PREFERENCE, environment.DEFAULT, environment.DEVELOPER])
        found = self.found("/s/python", "/p/python", "/e/python")
        self.assertEqual([item.path for item in found[:3]], ["/s/python", "/p/python", "/e/python"])

    def test_effective_interpreter_matches_resolve_python(self):
        default = environment.default_venv_python("linux", {}, self.root / "home")
        self.assertIsNone(environment.effective_candidate(self.found()))
        self.touch("repo", ".venv-overture", "bin", "python")
        self.assertIsNone(environment.effective_candidate(self.found()),
                          "the repository venv is only offered by Detect")
        self.touch(*default.relative_to(self.root).parts)
        self.assertEqual(environment.effective_candidate(self.found()).source, environment.DEFAULT)
        self.assertEqual(environment.effective_candidate(self.found(variable="/e")).source,
                         environment.ENVIRONMENT)
        self.assertEqual(environment.effective_candidate(self.found("", "/p", "/e")).path, "/p")
        self.assertEqual(environment.effective_candidate(self.found("/s", "/p", "/e")).path, "/s")

        with mock.patch.object(environment, "default_venv_python", return_value=default), \
                mock.patch.dict(os.environ, {"JARVIZAR_OVERTURE_PYTHON": ""}):
            self.assertEqual(resolve_python("", ""), default)


class SetupFileTests(TemporaryFiles):
    def test_pins_follow_includes(self):
        self.touch("base.txt", text="# comment\nOverture_Maps==1.0.2  # tested\nclick>=8\n")
        extra = self.touch("extra.txt", text="-r base.txt\nlaspy[lazrs]==2.7.0\n--requirement=more.txt\n")
        self.touch("more.txt", text="pyshp==2.3.1 ; python_version >= '3.10'\n-r extra.txt\n")
        self.assertEqual(environment.pinned_versions(extra),
                         {"overture-maps": "1.0.2", "laspy": "2.7.0", "pyshp": "2.3.1"})

    def test_packaged_requirements_pin_the_downloader_and_lidar(self):
        downloader = environment.pinned_versions()
        self.assertIn("overturemaps", downloader)
        lidar = environment.pinned_versions(environment.SETUP_DIR / "requirements-lidar.txt")
        self.assertEqual(lidar["overturemaps"], downloader["overturemaps"])
        self.assertTrue({"laspy", "pyproj", "shapely", "pyshp"} <= set(lidar))

    def test_windows_command_bypasses_the_execution_policy(self):
        folder = self.root / "Blender Foundation" / "setup"
        command = environment.setup_command(platform="win32", setup_dir=folder)
        self.assertEqual(command, "powershell -NoProfile -ExecutionPolicy Bypass -File "
                                  f"\"{folder / 'setup_downloader.ps1'}\"")
        self.assertTrue(environment.setup_command(True, "win32", folder).endswith('.ps1" -WithLidar'))

    def test_posix_command_quotes_the_path(self):
        folder = Path("/Users/o'neil/Library/Application Support/Blender/setup")
        command = environment.setup_command(platform="darwin", setup_dir=folder)
        self.assertTrue(command.startswith("sh '"), command)
        self.assertIn("'\"'\"'", command)
        self.assertTrue(environment.setup_command(True, "linux", folder).endswith(" --with-lidar"))

    def test_packaged_scripts_exist_for_both_systems(self):
        for platform in ("win32", "darwin", "linux"):
            self.assertTrue(environment.setup_script(platform).is_file(), platform)
        self.assertTrue(environment.PROBE_SCRIPT.is_file())


class RejectionTests(TemporaryFiles):
    def test_blender_bundled_python_is_rejected_without_running(self):
        python = self.touch("Blender 3.6", "3.6", "python", "bin", "python.exe")
        (self.root / "Blender 3.6" / "3.6" / "scripts").mkdir()
        runner = FakeRunner()
        result = self.validate(python, runner)
        self.assertTrue(result.blender_python)
        self.assertFalse(result.ok)
        self.assertEqual(runner.commands, [])
        self.assertIn("Blender's own Python", result.error)

    def test_blender_itself_and_known_blender_paths_are_never_run(self):
        runner = FakeRunner()
        for name in ("blender.exe", "blender"):
            result = self.validate(self.touch(name), runner)
            self.assertTrue(result.blender_python, name)
        other = self.touch("elsewhere", "python.exe")
        self.assertTrue(self.validate(other, runner, blender_paths=(str(other),)).blender_python)
        self.assertEqual(runner.commands, [])

    def test_other_programs_are_not_run(self):
        runner = FakeRunner()
        result = self.validate(self.touch("python-3.12.0-amd64.exe"), runner)
        self.assertIn("Not a Python executable", result.error)
        self.assertIn("use python.exe", self.validate(self.touch("pythonw.exe"), runner).error)
        self.assertEqual(runner.commands, [])

    def test_missing_interpreter(self):
        result = self.validate(self.root / "nowhere" / "python", FakeRunner())
        self.assertFalse(result.exists)
        self.assertEqual(result.checklist()[0][1], environment.FAIL)
        self.assertIn("not found", result.error)
        self.assertEqual(self.validate("", FakeRunner()).error, "No interpreter set")

    def test_store_placeholder_is_recognised(self):
        stub = self.touch("Microsoft", "WindowsApps", "python.exe")
        result = self.validate(stub, FakeRunner(9009, "", "Python was not found; run without arguments"))
        self.assertTrue(result.store_stub)
        self.assertIn("Microsoft Store", result.error)
        self.assertFalse(result.ok)

    def test_bundled_python_found_through_its_prefix(self):
        home = self.root / "Blender" / "4.2" / "python"
        (home.parent / "scripts").mkdir(parents=True)
        runner = FakeRunner(0, probe_output(prefix=str(home), modules=WORKING))
        self.assertTrue(self.validate(self.touch("link", "python3"), runner).blender_python)


class ProbeOutputTests(TemporaryFiles):
    def setUp(self):
        super().setUp()
        self.python = self.touch("env", "bin", "python3.11")

    def test_working_environment(self):
        runner = FakeRunner(0, probe_output(modules=WORKING + LIDAR))
        result = self.validate(self.python, runner)
        self.assertTrue(result.ok and result.lidar_ok)
        self.assertEqual(result.summary(), "Working: overturemaps 1.0.2; LiDAR packages installed")
        self.assertTrue(all(state == environment.OK for _, state in result.checklist()))
        command = runner.commands[0]
        self.assertEqual(command[:2], [str(self.python), str(environment.PROBE_SCRIPT)])
        self.assertIn("overturemaps.core=overturemaps", command)
        self.assertIn("shapefile=pyshp", command)

    def test_old_python_is_rejected(self):
        result = self.validate(self.python, FakeRunner(0, probe_output((3, 9, 6), modules=WORKING)))
        self.assertFalse(result.ok)
        self.assertIn("3.10 or newer", result.error)
        self.assertEqual(result.checklist()[-1], ("Python 3.9.6: 3.10 or newer is needed", environment.FAIL))

    def test_missing_downloader_package(self):
        modules = [("overturemaps.core", False, "", "ModuleNotFoundError: No module named 'overturemaps'")]
        result = self.validate(self.python, FakeRunner(0, probe_output(modules=modules)))
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "overturemaps is not installed in this environment")
        broken = [("overturemaps.core", False, "1.0.2", "ImportError: DLL load failed")]
        result = self.validate(self.python, FakeRunner(0, probe_output(modules=broken)))
        self.assertIn("does not import: ImportError: DLL load failed", result.error)

    def test_missing_lidar_packages_are_optional(self):
        lidar = LIDAR[:2] + [("pyproj", False, "", "ModuleNotFoundError: pyproj")] + LIDAR[3:]
        result = self.validate(self.python, FakeRunner(0, probe_output(modules=WORKING + lidar)))
        self.assertTrue(result.ok)
        self.assertFalse(result.lidar_ok)
        self.assertEqual(result.checklist()[-1],
                         ("Optional LiDAR packages missing: pyproj", environment.INFO))

    def test_other_downloader_version_is_a_note(self):
        modules = [("overturemaps.core", True, "1.0.1", "")] + LIDAR
        result = self.validate(self.python, FakeRunner(0, probe_output(modules=modules)))
        self.assertTrue(result.ok)
        self.assertIn(("overturemaps 1.0.1; setup installs 1.0.2", environment.INFO), result.checklist())

    def test_no_output_reports_the_exit_code_and_error(self):
        result = self.validate(self.python, FakeRunner(1, "", "Fatal Python error: init_fs_encoding"))
        self.assertFalse(result.ran)
        self.assertIn("exit code 1", result.error)
        self.assertIn("init_fs_encoding", result.error)

    def test_timeout_before_any_output(self):
        result = self.validate(self.python, FakeRunner(None, "", "", True), timeout=5)
        self.assertTrue(result.timed_out)
        self.assertEqual(result.error, "No response within 5 s")

    def test_timeout_during_lidar_imports_keeps_the_downloader_result(self):
        output = probe_output(modules=WORKING + LIDAR[:2], done=False)
        result = self.validate(self.python, FakeRunner(None, output, "", True), timeout=5)
        self.assertTrue(result.ok)
        self.assertIn("while importing pyproj", result.note)
        self.assertEqual(result.checklist()[-1][1], environment.INFO)

    def test_crash_while_importing_the_downloader(self):
        result = self.validate(self.python, FakeRunner(-1073741819, probe_output(done=False)))
        self.assertFalse(result.ok)
        self.assertIn("stopped while importing overturemaps", result.error)


class RealInterpreterTests(TemporaryFiles):
    def test_this_interpreter_with_standard_modules(self):
        result = environment.validate_interpreter(
            sys.executable, required=("json", "json"), optional=(("csv", "csv"),), expected_version="")
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.python_version[:2], tuple(sys.version_info[:2]))
        self.assertEqual([item.name for item in result.lidar], ["csv"])

    def test_this_interpreter_without_the_required_package(self):
        result = environment.validate_interpreter(
            sys.executable, required=("jarvizar_missing_module", "jarvizar-missing"), optional=())
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "jarvizar-missing is not installed in this environment")

    def slow_interpreter(self):
        if WINDOWS:
            return self.touch("slow", "python.cmd", text="@ping -n 60 127.0.0.1 >nul\r\n")
        path = self.touch("slow", "python", text="#!/bin/sh\nsleep 60\n")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def test_timeout_stops_the_whole_process_tree(self):
        started = time.monotonic()
        result = environment.validate_interpreter(self.slow_interpreter(), timeout=1)
        self.assertTrue(result.timed_out)
        self.assertLess(time.monotonic() - started, 20)
        self.assertIn("No response within 1 s", result.error)

    @unittest.skipUnless(WINDOWS, "Windows Store aliases")
    def test_store_placeholder_exit_code(self):
        stub = self.touch("Microsoft", "WindowsApps", "python.cmd", text="@exit /b 9009\r\n")
        result = environment.validate_interpreter(stub)
        self.assertTrue(result.store_stub, result.error)


class CacheAndDetectTests(TemporaryFiles):
    def test_results_are_remembered_by_path(self):
        path = self.touch("env", "python")
        result = environment.remember(environment.ValidationResult(path=str(path), exists=True))
        variant = str(path).upper() if WINDOWS else str(path)
        self.assertIs(environment.cached_result(variant), result)
        self.assertIsNone(environment.cached_result(""))
        environment.forget(path)
        self.assertIsNone(environment.cached_result(path))

    @staticmethod
    def validator(working):
        def validate(path):
            return environment.ValidationResult(
                path=path, exists=True, ran=path in working, python_version=(3, 11, 5),
                downloader=environment.ModuleStatus("overturemaps", path in working, "1.0.2"),
                error="" if path in working else "broken")
        return validate

    def test_a_working_preference_is_kept_and_the_override_still_checked(self):
        found = [Candidate("s", environment.SCENE), Candidate("p", environment.PREFERENCE),
                 Candidate("d", environment.DEFAULT)]
        chosen, checked = environment.detect(found, self.validator({"p", "d"}))
        self.assertEqual(chosen.path, "p")
        self.assertEqual([(item.path, result.ok) for item, result in checked], [("s", False), ("p", True)])

    def test_first_working_candidate_replaces_a_broken_preference(self):
        found = [Candidate("p", environment.PREFERENCE), Candidate("e", environment.ENVIRONMENT),
                 Candidate("d", environment.DEFAULT), Candidate("r", environment.DEVELOPER)]
        chosen, _ = environment.detect(found, self.validator({"d", "r"}))
        self.assertEqual(chosen.path, "d")
        chosen, checked = environment.detect(found, self.validator(set()))
        self.assertIsNone(chosen)
        self.assertEqual(len(checked), 4)


class SystemPythonTests(unittest.TestCase):
    def test_windows_uses_the_registry_and_skips_store_aliases(self):
        # The same key is seen through both registry views.
        registry = [("C:/P311/python.exe", (3, 11)), ("C:/P311/python.exe", (3, 11)),
                    ("C:/P39/python.exe", (3, 9))]
        which = {"python": "C:/Users/a/AppData/Local/Microsoft/WindowsApps/python.exe",
                 "python3": "C:/Other/python3.exe"}.get
        runner = FakeRunner(0, "3.12\n")
        found = environment.find_system_pythons("win32", lambda name, path=None: which(name),
                                                lambda: registry, runner)
        self.assertEqual(found, [("C:/P311/python.exe", (3, 11)), ("C:/P39/python.exe", (3, 9)),
                                 ("C:/Other/python3.exe", (3, 12))])
        self.assertTrue(environment.has_usable_python(found))
        self.assertFalse(environment.has_usable_python([("C:/P39/python.exe", (3, 9)), ("x", None)]))

    def test_posix_versions_come_from_file_names(self):
        paths = {"python3.12": "/usr/local/bin/python3.12", "python3": "/usr/bin/python3"}
        runner = FakeRunner(0, "3.8\n")
        found = environment.find_system_pythons("linux", lambda name, path=None: paths.get(name),
                                                runner=runner, environ={"PATH": "/usr/bin"})
        self.assertEqual(found, [("/usr/local/bin/python3.12", (3, 12))])
        self.assertEqual(runner.commands, [])
        del paths["python3.12"]
        found = environment.find_system_pythons("linux", lambda name, path=None: paths.get(name),
                                                runner=runner, environ={})
        self.assertEqual(found, [("/usr/bin/python3", (3, 8))])
        self.assertEqual(environment.find_system_pythons(
            "darwin", lambda name, path=None: paths.get(name), runner=runner, environ={}), [])


class ResolvePythonFallbackTests(TemporaryFiles):
    def test_the_default_environment_is_the_last_resort(self):
        default = self.touch("venv", "Scripts", "python.exe")
        with mock.patch.object(environment, "default_venv_python", return_value=default), \
                mock.patch.dict(os.environ, {"JARVIZAR_OVERTURE_PYTHON": "  "}):
            self.assertEqual(resolve_python("", " "), default)
            self.assertEqual(resolve_python(sys.executable, ""), Path(sys.executable))
        with mock.patch.object(environment, "default_venv_python", return_value=self.root / "none"), \
                mock.patch.dict(os.environ, {"JARVIZAR_OVERTURE_PYTHON": ""}):
            with self.assertRaises(OvertureDownloadError) as caught:
                resolve_python("", "")
        self.assertIn("Set Up Downloader", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
