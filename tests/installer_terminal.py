"""Regression check for attended startup from a curl-to-bash pipeline."""

import errno
import os
from pathlib import Path
import pty
import runpy
import traceback
import unittest


INSTALLER = Path(__file__).resolve().parents[1] / "onboarding/install.py"
concrete_terminal_fd = runpy.run_path(
    str(INSTALLER), init_globals={"__PACKAGE_PATHS_JSON__": []}
)["concrete_terminal_fd"]


class InstallerTerminalTest(unittest.TestCase):
    def test_pipeline_starts_with_concrete_terminal(self):
        pid, master = pty.fork()
        if pid == 0:
            try:
                read_fd, write_fd = os.pipe()
                os.dup2(read_fd, 0)
                os.close(read_fd)
                os.close(write_fd)
                tty = os.open("/dev/tty", os.O_RDWR)
                source = concrete_terminal_fd(tty)
                assert source in (1, 2)
                for fd in (0, 1, 2):
                    os.dup2(source, fd)
                os.close(tty)
                assert all(os.isatty(fd) and os.ttyname(fd) != "/dev/tty" for fd in (0, 1, 2))
                os._exit(0)
            except BaseException:
                traceback.print_exc()
                os._exit(1)
        try:
            output = bytearray()
            while True:
                try:
                    chunk = os.read(master, 4096)
                    if not chunk:
                        break
                    output.extend(chunk)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0, output.decode(errors="replace"))
        finally:
            os.close(master)


if __name__ == "__main__":
    unittest.main()
