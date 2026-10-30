# /// script
# requires-python = ">=3.10"
# dependencies = ["pyte==0.8.2"]
# ///
"""Terminal smoke test: runs a real omp in a pseudo-terminal and checks the drop-up contract.

The plugin must already be linked or installed for the omp under test, e.g.
`omp plugin link .` with the same HOME. Run with `uv run test/smoke.py`; set OMP_BIN to
pick the omp binary (default `omp` on PATH).

For every scenario, typing `/se`, narrowing to one match, widening again and pressing Esc must:
- keep the input row (where the cursor sits) fixed;
- render the list only above the input, never below it;
- leave every row below the input untouched (e.g. the claude shape's bottom status bar);
- shrink the box with the list, restoring the transcript rows it uncovered;
- restore the screen exactly once the list closes.
"""

from __future__ import annotations

import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from dataclasses import dataclass

import pyte

OMP = os.environ.get("OMP_BIN", "omp")
COLS = 110
STEP_SECONDS = 1.2
KEY_BYTES = {"ESC": b"\x1b", "BS": b"\x7f", "CR": b"\r"}
STEPS = ["/", "s", "e", "z", "BS", "ESC"]


@dataclass(frozen=True)
class Scenario:
    name: str
    rows: int
    shape: str
    setup_keys: tuple[str, ...] = ()


SCENARIOS = [
    # Live transcript filling the screen (bash output needs no model).
    Scenario("filled-band", 20, "band", ("!!seq 1 60", "CR")),
    Scenario("filled-claude", 20, "claude", ("!!seq 1 60", "CR")),
    # Small terminal: the startup banner is partly in native scrollback above the live viewport.
    Scenario("scrollback-claude", 12, "claude"),
]


class Terminal:
    def __init__(self, rows: int, args: list[str]):
        self.rows = rows
        self.screen = pyte.Screen(COLS, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ["TERM"] = "xterm-256color"
            # Never attach to the omp session that may be running this test.
            for key in [k for k in os.environ if k.startswith("PI_SESSION")]:
                del os.environ[key]
            os.execvp(OMP, [OMP, *args])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, COLS, 0, 0))

    def pump(self, seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            if not select.select([self.fd], [], [], 0.05)[0]:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return
            self.stream.feed(data)
            # Answer cursor-position queries so the TUI does not stall waiting for them.
            if b"\x1b[6n" in data:
                os.write(self.fd, f"\x1b[{self.screen.cursor.y + 1};{self.screen.cursor.x + 1}R".encode())

    def lines(self) -> list[str]:
        return [self.screen.display[i].rstrip() for i in range(self.rows)]

    def wait_settled(self, minimum: float = 3.0, quiet: float = 1.5, limit: float = 45.0) -> None:
        start = time.time()
        last, changed_at = self.lines(), time.time()
        while time.time() - start < limit:
            self.pump(0.25)
            now = self.lines()
            if now != last:
                last, changed_at = now, time.time()
            elif time.time() - start >= minimum and time.time() - changed_at >= quiet:
                return

    def send(self, key: str) -> None:
        os.write(self.fd, KEY_BYTES.get(key, key.encode()))

    def close(self) -> None:
        for _ in range(2):
            try:
                os.write(self.fd, b"\x03")
            except OSError:
                break
            self.pump(0.3)
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass


def run(scenario: Scenario, config_dir: str) -> list[str]:
    config = os.path.join(config_dir, f"{scenario.name}.yml")
    with open(config, "w") as f:
        f.write(f"composer:\n  shape: {scenario.shape}\nstartup:\n  setupWizard: false\n")
    term = Terminal(scenario.rows, ["--config", config])
    failures: list[str] = []
    try:
        term.wait_settled()
        for key in scenario.setup_keys:
            term.send(key)
            term.pump(1.5)
        term.wait_settled(minimum=0.5)
        pre = term.lines()
        input_row = term.screen.cursor.y
        for key in STEPS:
            term.send(key)
            term.pump(STEP_SECONDS)
            now = term.lines()
            cursor_row = term.screen.cursor.y
            changed = [i for i in range(scenario.rows) if now[i] != pre[i] and i != input_row]
            where = f"after {key!r}"
            if cursor_row != input_row:
                failures.append(f"{where}: input moved from row {input_row} to {cursor_row}")
            below = [i for i in changed if i > input_row]
            if below:
                failures.append(f"{where}: rows below the input changed: {below}")
            if key in ("s", "e") and not any("settings" in now[i] for i in changed):
                failures.append(f"{where}: no list above the input (is the plugin loaded?)")
            if key == "z" and len(changed) > 3:
                failures.append(f"{where}: box did not shrink to one item, changed rows {changed}")
            if key == "ESC" and changed:
                failures.append(f"{where}: screen not restored, changed rows {changed}")
        if failures:
            failures.append("screen:\n" + "\n".join(f"  {i:2}|{line}" for i, line in enumerate(term.lines())))
    finally:
        term.close()
    return failures


def main() -> int:
    version = subprocess.run([OMP, "--version"], capture_output=True, text=True).stdout.strip()
    print(f"omp under test: {version}")
    failed = 0
    with tempfile.TemporaryDirectory() as config_dir:
        for scenario in SCENARIOS:
            failures = run(scenario, config_dir)
            print(f"{'PASS' if not failures else 'FAIL'} {scenario.name}")
            for failure in failures:
                print(f"  {failure}")
            failed += bool(failures)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
