#!/usr/bin/env python3
"""Does the setup wizard actually hide what it says it hides?

This has to drive a real pty on *stdin*, not just capture a pty stdout. The
leak it guards against is readline redrawing keystrokes that raw mode stopped
the terminal driver from echoing, and it only happens when stdin is a terminal.
Feeding answers from a pipe or a file makes the wizard take its non-TTY branch
and the check passes while every credential and pasted private key is being
printed to the screen.

Exits non-zero if any secret appears in the transcript.
"""
import os
import pty
import select
import shutil
import subprocess
import sys
import tempfile
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(REPO, 'packages', 'server', 'dist', 'cli', 'setup.js')

SECRET_PW = 'SUPER-SECRET-PASSPHRASE-9'
SECRET_KEY = 'sk-ant-SECRETAPIKEYVALUE-1234'

# (prompt fragment to wait for, what to type)
SCRIPT = [
    ('Email', 'owner@example.com\r'),
    ('Display name', 'Owner\r'),
    ('Password (12+', SECRET_PW + '\r'),
    ('Password again', SECRET_PW + '\r'),
    ('Anthropic', SECRET_KEY + '\r'),
    ('OpenAI', '\r'),
    ('Helius', '\r'),
    ('YouTube', '\r'),
    ('Reddit client ID', '\r'),
    ('Reddit client secret', '\r'),
    ('Discord', '\r'),
    ('Import an existing', 'n\r'),
]


def main() -> int:
    if not os.path.exists(CLI):
        print(f'FAIL: {CLI} is missing; run `npm run build` first', file=sys.stderr)
        return 2

    work = tempfile.mkdtemp(prefix='solcoin-echo-')
    try:
        example = os.path.join(REPO, '.env.example')
        if os.path.exists(example):
            shutil.copy(example, os.path.join(work, '.env.example'))

        env = dict(os.environ, DATABASE_PATH='./data/echo-check.db', DATA_DIR='./data', NODE_ENV='development')
        for key in ('SOLCOIN_MASTER_KEY', 'BOOTSTRAP_EMAIL', 'BOOTSTRAP_PASSWORD'):
            env.pop(key, None)

        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(work)
            os.execve('/usr/bin/env', ['env', 'node', CLI], env)

        buf, index, chunks = b'', 0, []
        deadline = time.time() + 180
        while time.time() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.5)
            if ready:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                chunks.append(chunk)
            if index < len(SCRIPT):
                needle, reply = SCRIPT[index]
                if needle.encode() in buf:
                    time.sleep(0.25)
                    os.write(fd, reply.encode('utf8'))
                    buf = b''
                    index += 1
        os.close(fd)

        transcript = b''.join(chunks).decode('utf8', 'replace')

        failures = []
        if SECRET_PW in transcript:
            failures.append('the password appeared in the terminal transcript')
        if SECRET_KEY in transcript:
            failures.append('the API key appeared in the terminal transcript')
        if index < len(SCRIPT):
            failures.append(f'the wizard did not reach the end ({index}/{len(SCRIPT)} prompts answered)')

        for failure in failures:
            print(f'FAIL: {failure}', file=sys.stderr)
        if failures:
            return 1

        print('ok: the wizard ran to completion and no secret appeared in the terminal transcript')
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
