#!/usr/bin/env python3
"""Capture native CPU stacks without launching or driving Immage."""
import argparse
import json
from pathlib import Path
import platform
import subprocess
import sys
import time


def command(args, output):
    with output.open('w') as stream:
        return subprocess.run(args, stdout=stream, stderr=subprocess.STDOUT, check=False).returncode


def capture(output, seconds, pid=None):
    output.mkdir(parents=True, exist_ok=False)
    metadata = {'platform': platform.platform(), 'seconds': seconds, 'pid': pid,
                'scope': 'single-process' if pid else 'all-processes', 'commands': []}

    def run(args, name):
        code = command(args, output / name)
        metadata['commands'].append({'argv': args, 'exitCode': code, 'log': name})
        return code

    def save():
        (output / 'capture.json').write_text(json.dumps(metadata, indent=2) + '\n')

    try:
        run(['xcodebuild', '-version'], 'xcode.txt')
        run(['sw_vers'], 'macos.txt')
        run(['ps', '-axo', 'pid,ppid,comm'], 'processes-before.txt')
        trace = output / 'cpu.trace'
        args = ['xcrun', 'xctrace', 'record', '--template', 'Time Profiler',
                '--time-limit', f'{seconds}s', '--output', str(trace)]
        args += ['--attach', str(pid)] if pid else ['--all-processes']
        metadata['recordCommandStartedUnixMs'] = time.time_ns() // 1_000_000
        print('Starting Time Profiler. Wait for its recording-start message, then run the GUI benchmark.', flush=True)
        # Inherit the terminal so authorization prompts and recording readiness are visible.
        code = subprocess.run(args, check=False).returncode
        metadata['recordCommandEndedUnixMs'] = time.time_ns() // 1_000_000
        metadata['commands'].append({'argv': args, 'exitCode': code})
        run(['ps', '-axo', 'pid,ppid,comm'], 'processes-after.txt')
        if code or not trace.exists():
            raise RuntimeError('Recording failed; retained evidence is in ' + str(output))
        if run(['xcrun', 'xctrace', 'export', '--input', str(trace), '--toc'], 'toc.xml'):
            raise RuntimeError('Trace saved, but table-of-contents export failed')
        code = run(['xcrun', 'xctrace', 'export', '--input', str(trace), '--xpath',
                    '/trace-toc/run/data/table[@schema="time-profile"]'], 'cpu-stacks.xml')
        metadata['stackExportSucceeded'] = code == 0
        if code:
            print('CPU stack export failed; keep cpu.trace for analysis in Instruments.', file=sys.stderr)
        print(f'Capture saved: {output}\nKeep the matching GUI benchmark JSON and exact app/engine binaries with this folder.')
    finally:
        save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='new capture directory')
    parser.add_argument('--seconds', type=int, default=180, help='capture duration, 10–600 seconds')
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument('--all-processes', action='store_true', help='include WebKit helpers and unrelated system processes')
    scope.add_argument('--pid', type=int, help='attach to one PID; excludes other processes')
    args = parser.parse_args()
    if not 10 <= args.seconds <= 600 or (args.pid is not None and args.pid <= 0):
        parser.error('duration must be 10–600 seconds and PID must be positive')
    if sys.platform != 'darwin':
        parser.error('capture requires macOS with full Xcode selected (xcrun xctrace)')
    try:
        capture(args.output.resolve(), args.seconds, args.pid)
    except (OSError, RuntimeError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
