# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared helpers for the headless robustness checks (hostile-inputs.py,
memory.py, stress.py): a memory gate before each engine launch, an engine
driver that never waits forever (every request has a timeout, and a dead
engine is an error the caller can count), and a small pass/fail/known-bug
report. The engine itself is background-priority.py's `Engine`."""
import json
import os
from pathlib import Path
import resource
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
background = __import__('background-priority')
ROOT = background.ROOT
tiff = background.tiff

MIN_AVAILABLE_GIB = 4
MAX_SWAP_PERCENT = 50


class EngineDied(Exception):
    """The engine's output closed or its process ended."""


def memory_gate():
    """(ok, text): MemAvailable >= 4 GiB and swap use <= 50% (Linux)."""
    try:
        info = {}
        for line in Path('/proc/meminfo').read_text().splitlines():
            key, _, rest = line.partition(':')
            info[key] = int(rest.split()[0])
        avail = info['MemAvailable'] / 1048576
        swap_total, swap_free = info['SwapTotal'], info['SwapFree']
        swap = 100.0 * (swap_total - swap_free) / swap_total if swap_total else 0.0
    except (OSError, KeyError, ValueError, IndexError):
        return False, 'cannot read /proc/meminfo'
    text = f'MemAvailable {avail:.1f} GiB, swap used {swap:.0f}%'
    return avail >= MIN_AVAILABLE_GIB and swap <= MAX_SWAP_PERCENT, text


def require_memory(what):
    ok, text = memory_gate()
    if not ok:
        print(f'not {what}: {text} (need >= {MIN_AVAILABLE_GIB} GiB and swap <= {MAX_SWAP_PERCENT}%)')
        sys.exit(2)
    return text


def rss_kib(pid, field='VmRSS'):
    """A /proc/<pid>/status size in KiB, or None."""
    try:
        for line in Path(f'/proc/{pid}/status').read_text().splitlines():
            if line.startswith(field + ':'):
                return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return None


class Eng(background.Engine):
    """background-priority's Engine with timeouts that return instead of
    raise, a request id on every untagged request, and an address-space cap
    so a hostile size cannot take the machine with it."""

    def __init__(self, binary, work, limit_gib=None, **kw):
        work.mkdir(parents=True, exist_ok=True)
        super().__init__(binary, work, **kw)
        self.rid = 0
        self.crash_log = ''
        if limit_gib:
            try:
                limit = int(limit_gib * (1 << 30))
                resource.prlimit(self.child.pid, resource.RLIMIT_AS, (limit, limit))
            except (OSError, ValueError, AttributeError) as e:
                print(f'warning: no address-space cap on the engine ({e})', file=sys.stderr)

    def alive(self):
        return self.child.poll() is None

    def log_tail(self, lines=12):
        try:
            self.log.flush()
            return '\n'.join(self.log_path.read_text(errors='replace').splitlines()[-lines:])
        except OSError:
            return ''

    def _pump(self, timeout):
        try:
            return self.pump(timeout)
        except AssertionError as e:
            self.crash_log = str(e)
            raise EngineDied(self.exit_text())

    def exit_text(self):
        code = self.child.poll()
        if code is None:
            try:
                code = self.child.wait(timeout=2)
            except Exception:
                code = None
        import re
        tail = self.log_tail(40)
        frames = re.findall(r'\((\w+)\+0x[0-9a-f]+\)', tail.split('crashed, backtrace:')[-1])
        where = ' <- '.join(f for f in frames[:5]) if 'crashed, backtrace' in tail else 'no backtrace'
        last = [l for l in tail.splitlines() if l.startswith('[engine] >')][-1:]
        return f'engine exited ({code}); crash in {where}; last request: {(last or [""])[0][:220]}'

    def send_raw(self, data: bytes):
        try:
            self.child.stdin.buffer.write(data)
            self.child.stdin.buffer.flush()
        except (BrokenPipeError, OSError, ValueError):
            raise EngineDied(self.exit_text())

    def ask(self, data, timeout=60):
        """One untagged request; the reply (ok or error) or None on timeout.
        Matched by `rid`; others are dropped (counted in `stale`)."""
        self.rid += 1
        rid = self.rid
        self.send_raw((json.dumps(data | {'rid': rid}) + '\n').encode())
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            reply = self._pump(0.5)
            if reply is not None:
                if reply.get('rid') == rid:
                    return reply
                self.stale = getattr(self, 'stale', 0) + 1
            elif not self.alive():
                raise EngineDied(self.exit_text())
        return None

    def ask_tagged(self, data, timeout=60):
        """One tagged request; its reply or None on timeout."""
        tag = self.tagged_send_raw(data)
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if tag in self.tagged:
                return self.tagged.pop(tag)[1]
            self._pump(0.5)
            if not self.alive():
                raise EngineDied(self.exit_text())
        return None

    def tagged_send_raw(self, data):
        self.tag += 1
        self.send_raw((json.dumps(data | {'tag': self.tag}) + '\n').encode())
        return self.tag

    def ok(self, data, timeout=120):
        reply = self.ask(data, timeout)
        assert reply is not None, f'no reply (timeout): {str(data)[:200]}'
        assert reply.get('ok'), f'{str(data)[:200]}: {reply}'
        return reply

    def responsive(self, timeout=30):
        try:
            reply = self.ask({'cmd': 'version'}, timeout)
        except EngineDied:
            return False
        return bool(reply and reply.get('ok'))

    def shutdown(self):
        try:
            if self.alive():
                self.ask({'cmd': 'quit'}, 30)
                self.child.wait(timeout=30)
        except Exception:
            pass
        finally:
            if self.child.poll() is None:
                self.child.kill()
                self.child.wait()
            try:
                self.log.close()
            except OSError:
                pass


class Report:
    """PASS / FAIL / KNOWN BUG lines. A robustness violation (crash, hang, no
    reply, leak) whose key is in `known` prints KNOWN BUG and does not fail
    the run unless --strict; any other violation fails it."""

    def __init__(self, known=(), strict=False):
        self.known = dict(known)
        self.strict = strict
        self.failures = []
        self.bugs = {}
        self.passes = 0

    def ok(self, text):
        self.passes += 1
        print(f'PASS {text}')

    def fail(self, text):
        self.failures.append(text)
        print(f'FAIL {text}')

    def bug(self, key, text):
        """A violation: known ones are reported, new ones fail."""
        base = next((k for k in self.known if key == k or (k.endswith('*') and key.startswith(k[:-1]))),
                    key.split('|')[0])
        if base in self.known:
            self.bugs.setdefault(base, []).append(text)
            if len(self.bugs[base]) <= 2:
                print(f'KNOWN BUG [{base}] {self.known[base]}: {text[:700]}')
            if self.strict:
                self.failures.append(f'[{base}] {text}')
        else:
            self.failures.append(f'[{base}] {text.splitlines()[0][:250]}')
            print(f'FAIL [{base}] {text[:900]}')

    def finish(self):
        for key, texts in self.bugs.items():
            print(f'known bug {key}: {len(texts)} occurrence(s) ({self.known[key]})')
        print(f'{self.passes} passed, {len(self.failures)} failed, '
              f'{sum(len(v) for v in self.bugs.values())} known-bug occurrence(s)')
        if self.failures:
            print('FAILED:')
            for f in self.failures[:30]:
                print(f'  {f}')
            return 1
        print('passed; no GUI launched')
        return 0
