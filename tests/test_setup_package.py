"""The downloader setup ships inside the add-on archives with one set of pins."""

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jarvizar_city_model.data import environment

SETUP = ROOT / "jarvizar_city_model" / "setup"
SETUP_FILES = ("requirements-downloader.txt", "requirements-lidar.txt",
               "setup_downloader.ps1", "setup_downloader.sh", "setup_downloader.cmd")


def load_builder():
    spec = importlib.util.spec_from_file_location("build_addon", ROOT / "scripts" / "build_addon.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RequirementsTests(unittest.TestCase):
    def test_repository_files_include_the_packaged_pins(self):
        for name in ("requirements-downloader.txt", "requirements-lidar.txt"):
            lines = [line.strip() for line in (ROOT / name).read_text(encoding="utf-8").splitlines()
                     if line.strip() and not line.startswith("#")]
            self.assertEqual(lines, [f"-r jarvizar_city_model/setup/{name}"])
            self.assertEqual(environment.pinned_versions(ROOT / name),
                             environment.pinned_versions(SETUP / name))

    def test_powershell_scripts_are_ascii(self):
        # Windows PowerShell 5.1 reads a file without a byte order mark in
        # the system code page.
        for path in (SETUP / "setup_downloader.ps1", ROOT / "scripts" / "setup_overture_env.ps1"):
            path.read_bytes().decode("ascii")


class ArchiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._directory = tempfile.TemporaryDirectory()
        builder = load_builder()
        cls.archives = {}
        for layout, prefix in ((False, "jarvizar_city_model/"), (True, "")):
            path = Path(cls._directory.name) / f"archive-{layout}.zip"
            builder.write_archive(path, extension_layout=layout)
            cls.archives[prefix] = path

    @classmethod
    def tearDownClass(cls):
        cls._directory.cleanup()

    def test_setup_files_ship_in_both_layouts(self):
        for prefix, path in self.archives.items():
            with zipfile.ZipFile(path) as archive:
                names = set(archive.namelist())
                for name in SETUP_FILES:
                    self.assertIn(f"{prefix}setup/{name}", names)
                self.assertIn(f"{prefix}external/probe_downloader.py", names)
                self.assertIn(f"{prefix}blender_manifest.toml", names)
                self.assertIn(f"{prefix}LICENSE", names)
                self.assertFalse(any("__pycache__" in name for name in names))

    def test_script_line_endings_suit_their_shells(self):
        for prefix, path in self.archives.items():
            with zipfile.ZipFile(path) as archive:
                shell = archive.getinfo(f"{prefix}setup/setup_downloader.sh")
                self.assertNotIn(b"\r", archive.read(shell))
                self.assertEqual((shell.external_attr >> 16) & 0o777, 0o755)
                batch = archive.read(f"{prefix}setup/setup_downloader.cmd")
                self.assertEqual(batch.count(b"\n"), batch.count(b"\r\n"))
                self.assertGreater(batch.count(b"\r\n"), 3)

    @unittest.skipUnless(shutil.which("sh"), "no POSIX shell")
    def test_shell_script_parses(self):
        with zipfile.ZipFile(self.archives[""]) as archive, tempfile.TemporaryDirectory() as folder:
            script = Path(folder) / "setup_downloader.sh"
            script.write_bytes(archive.read("setup/setup_downloader.sh"))
            result = subprocess.run([shutil.which("sh"), "-n", str(script)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(sys.platform.startswith("win") and shutil.which("powershell"), "Windows PowerShell")
    def test_powershell_scripts_parse(self):
        paths = [SETUP / "setup_downloader.ps1", ROOT / "scripts" / "setup_overture_env.ps1"]
        command = "; ".join(
            f"$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile("
            f"'{path}', [ref]$null, [ref]$errors); if ($errors) {{ $errors | Out-String; exit 1 }}"
            for path in paths)
        result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
