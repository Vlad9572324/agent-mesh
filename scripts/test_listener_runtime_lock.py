"""Real local Python child lock inheritance, never a provider or network call."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from dev_trial_runtimes import run_job


class ListenerRuntimeLockTests(unittest.TestCase):
    def test_unrelated_descriptor_rejected_before_child_start(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "work").mkdir()
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaisesRegex(ValueError, "job directory"):
                    run_job("codex", root / "work", "synthetic", root / "evidence", None,
                            inherited_lock_fd=fd)
            finally:
                os.close(fd)

    @unittest.skipUnless(hasattr(os, "pidfd_open"), "Linux pidfd required for owned fake-child cleanup")
    def test_owned_child_retains_workspace_lock_after_listener_sigkill(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            work = root / "work"
            work.mkdir()
            ready = root / "ready.json"
            driver_code = '''
import fcntl, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import dev_trial_runtimes as runtime
work, evidence, ready = sys.argv[2:]
fd = os.open(work, os.O_RDONLY | os.O_DIRECTORY)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
child = "import json,os,time; from pathlib import Path; Path(" + repr(ready) + ").write_text(json.dumps({'pid':os.getpid()})); time.sleep(15)"
runtime._command = lambda *a, **kw: [sys.executable, '-c', child]
runtime.run_job('codex',work,'synthetic',evidence,None,timeout=20,inherited_lock_fd=fd)
'''
            driver = subprocess.Popen([sys.executable, "-B", "-c", driver_code, str(Path(__file__).parent),
                                       str(work), str(root / "evidence"), str(ready)],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            child_fd = None
            lock = os.open(work, os.O_RDONLY | os.O_DIRECTORY)
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    if driver.poll() is not None:
                        self.fail("synthetic runtime exited before lock test")
                    time.sleep(0.02)
                self.assertTrue(ready.exists())
                child_fd = os.pidfd_open(json.loads(ready.read_text())["pid"])
                driver.kill()
                driver.wait(timeout=5)
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                signal.pidfd_send_signal(child_fd, signal.SIGTERM)
                deadline = time.monotonic() + 5
                while True:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise
                        time.sleep(0.02)
            finally:
                if child_fd is not None:
                    try:
                        signal.pidfd_send_signal(child_fd, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    os.close(child_fd)
                if driver.poll() is None:
                    driver.kill()
                driver.wait(timeout=5)
                driver.stderr.close()
                os.close(lock)


if __name__ == "__main__":
    unittest.main()
