import ctypes
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from jarvizar_city_model.external.lidar_worker import cache_owner
from jarvizar_city_model.data.lidar import LidarPreparation
from jarvizar_city_model.data.cache import Bounds, CacheBundle


class WorkerTests(unittest.TestCase):
    def test_cache_owner_excludes_second_job_and_releases_after_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'test failure'):
                with cache_owner(temp):
                    with self.assertRaisesRegex(ValueError, 'Another LiDAR preparation'):
                        with cache_owner(temp):
                            pass
                    raise RuntimeError('test failure')
            with cache_owner(temp):
                pass

    @unittest.skipUnless(os.name == 'nt', 'Windows venv launcher regression')
    def test_cancel_and_parent_exit_stop_real_venv_child(self):
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        root = Path(__file__).resolve().parents[1]
        interpreter = root/'.venv-overture/Scripts/python.exe'
        if not interpreter.is_file():
            self.skipTest('Windows venv fixture unavailable')
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            worker = temp/'worker.py'
            marker = temp/'pid'
            worker.write_text(
                'import os,sys,time\nfrom pathlib import Path\n'
                f'sys.path.insert(0, {str(root)!r})\n'
                'from jarvizar_city_model.external.lidar_worker import watch_parent\n'
                'watch_parent(int(sys.argv[sys.argv.index("--parent-pid")+1]))\n'
                f'Path({str(marker)!r}).write_text(str(os.getpid()))\n'
                'time.sleep(60)\n')
            def child_handle():
                for _ in range(100):
                    if marker.is_file() and marker.read_text():
                        return kernel.OpenProcess(0x00100000, False, int(marker.read_text()))
                    time.sleep(.05)
                self.fail('Worker failed to start')

            bundle = CacheBundle(temp, Bounds(-74, 40, -73, 41))
            popen = subprocess.Popen
            def launch(command, **kwargs):
                if '--bundle' in command:
                    command = [command[0], str(worker), *command[2:]]
                return popen(command, **kwargs)
            with patch('subprocess.Popen', side_effect=launch):
                job = LidarPreparation(interpreter, bundle, {'algorithm': 7})
                handle = child_handle()
                try:
                    self.assertTrue(handle)
                    job.cancel()
                    self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0)
                finally:
                    kernel.CloseHandle(handle)
                    if job.process.poll() is None:
                        job.cancel()

            marker.unlink()
            owner = temp/'owner.py'
            owner.write_text('import os,subprocess,time\n'
                             f'subprocess.Popen([{str(interpreter)!r}, {str(worker)!r}, "--parent-pid", str(os.getpid())])\n'
                             'time.sleep(60)\n')
            # sys.executable is the real interpreter; owner has no launcher.
            process = popen([sys.executable, str(owner)])
            handle = child_handle()
            try:
                self.assertTrue(handle)
                process.terminate()
                process.wait(timeout=5)
                self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0)
            finally:
                kernel.CloseHandle(handle)
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
