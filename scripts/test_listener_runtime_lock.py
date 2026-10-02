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
from unittest.mock import patch

from dev_trial_runtimes import run_job


class ListenerRuntimeLockTests(unittest.TestCase):
    def test_unrelated_descriptor_rejected_before_child_start(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "work").mkdir()
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with patch("dev_trial_runtimes.subprocess.Popen") as spawn, self.assertRaisesRegex(ValueError, "job directory"):
                    run_job("codex", root / "work", "synthetic", root / "evidence", None,
                            inherited_lock_fd=fd)
                spawn.assert_not_called()
            finally:
                os.close(fd)

    @unittest.skipUnless(hasattr(os, "pidfd_open"), "Linux pidfd required for owned fake-child cleanup")
    def test_owned_child_retains_workspace_lock_after_listener_sigkill(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()),
                                     "--subreaper-probe", temporary],
                                    capture_output=True, text=True, timeout=25)
            self.assertEqual(result.returncode, 0, result.stderr)

    def _subreaper_probe(self, root):
        # Only this isolated helper becomes a subreaper. The unittest runner's
        # process-wide child ownership is never changed.
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)  # PR_SET_CHILD_SUBREAPER
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
child = "import json,os,time; from pathlib import Path; p=Path(" + repr(ready) + "); q=p.with_suffix('.tmp'); q.write_text(json.dumps({'pid':os.getpid()})); os.replace(q,p); time.sleep(15)"
runtime._command = lambda *a, **kw: [sys.executable, '-c', child]
runtime.run_job('codex',work,'synthetic',evidence,None,timeout=20,inherited_lock_fd=fd)
'''
        driver = subprocess.Popen([sys.executable, "-B", "-c", driver_code, str(Path(__file__).parent),
                                   str(work), str(root / "evidence"), str(ready)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        child_fd = None
        child_pid = None
        lock = os.open(work, os.O_RDONLY | os.O_DIRECTORY)
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                if driver.poll() is not None:
                    self.fail("synthetic runtime exited before lock test")
                time.sleep(0.02)
            self.assertTrue(ready.exists())
            child_pid = json.loads(ready.read_text())["pid"]
            child_fd = os.pidfd_open(child_pid)
            driver.kill()
            driver.wait(timeout=5)
            with self.assertRaises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            signal.pidfd_send_signal(child_fd, signal.SIGTERM)
            # The killed driver has reparented this exact fake runtime to the
            # helper. Reap it rather than relying on the host's PID 1.
            self.assertEqual(os.waitpid(child_pid, 0)[0], child_pid)
            child_pid = None
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
            # Also cover failures before atomic readiness: after the known
            # driver is reaped, only its adopted fake children can remain.
            # This helper creates no other subprocesses. Own children cannot
            # reuse their PID until we reap them, and signals use pidfds.
            children = Path("/proc/self/task/" + str(os.getpid()) + "/children")
            for identifier in children.read_text().split():
                owned_pid = int(identifier)
                owned_fd = os.pidfd_open(owned_pid)
                try:
                    try:
                        signal.pidfd_send_signal(owned_fd, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    self.assertEqual(os.waitpid(owned_pid, 0)[0], owned_pid)
                finally:
                    os.close(owned_fd)
            os.close(lock)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--subreaper-probe":
        ListenerRuntimeLockTests()._subreaper_probe(Path(sys.argv[2]))
    else:
        unittest.main()
