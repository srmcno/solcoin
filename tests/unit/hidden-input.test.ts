import { describe, expect, it } from 'vitest';

/**
 * How the wizard's no-echo prompt turns terminal bytes back into a string.
 *
 * Extracted here as the exact accumulate-and-decode the CLI performs, because
 * the CLI needs a real TTY and this is the part that was wrong: a per-byte
 * `String.fromCharCode` mangles every non-ASCII character, both prompts mangle
 * it identically so the confirmation matches, and the operator is left with an
 * account whose password they can never type.
 */
function decodeTypedBytes(chunks: Buffer[]): string {
  const bytes: number[] = [];
  for (const chunk of chunks) {
    for (const byte of chunk) {
      if (byte === 0x7f || byte === 0x08) {
        while (bytes.length > 0 && (bytes[bytes.length - 1]! & 0xc0) === 0x80) bytes.pop();
        bytes.pop();
        continue;
      }
      if (byte >= 0x20) bytes.push(byte);
    }
  }
  return Buffer.from(bytes).toString('utf8').trim();
}

/** What the pre-fix implementation did, kept so the difference is explicit. */
function decodePerByte(chunks: Buffer[]): string {
  let out = '';
  for (const chunk of chunks) {
    for (const byte of chunk) {
      if (byte === 0x7f || byte === 0x08) {
        out = out.slice(0, -1);
        continue;
      }
      if (byte >= 0x20) out += String.fromCharCode(byte);
    }
  }
  return out.trim();
}

describe('hidden terminal input', () => {
  it('round-trips a plain ASCII passphrase', () => {
    const typed = 'a-long-enough-passphrase';
    expect(decodeTypedBytes([Buffer.from(typed, 'utf8')])).toBe(typed);
  });

  it.each([
    ['a Latin-1 accent', 'påsswörd-långt-nog'],
    ['a non-Latin script', 'парольдлинныйдостаточно'],
    ['CJK', '这是一个很长的密码短语'],
    ['an emoji', 'passphrase-with-🔐-in-it'],
  ])('round-trips %s', (_label, typed) => {
    expect(decodeTypedBytes([Buffer.from(typed, 'utf8')])).toBe(typed);
  });

  it('survives a multi-byte character split across two reads', () => {
    // A terminal can deliver one character in two chunks; decoding each chunk
    // independently would corrupt it.
    const full = Buffer.from('naïve-passphrase', 'utf8');
    const split = full.indexOf(0xc3) + 1;
    expect(decodeTypedBytes([full.subarray(0, split), full.subarray(split)])).toBe('naïve-passphrase');
  });

  it('deletes a whole character on backspace, not one byte of it', () => {
    const chunks = [Buffer.from('paßword', 'utf8'), Buffer.from([0x7f])];
    expect(decodeTypedBytes(chunks)).toBe('paßwor');
  });

  it('is what the per-byte version got wrong', () => {
    const typed = 'påsswörd-långt-nog';
    expect(decodePerByte([Buffer.from(typed, 'utf8')])).not.toBe(typed);
    expect(decodeTypedBytes([Buffer.from(typed, 'utf8')])).toBe(typed);
  });
});

describe('migration folder resolution', () => {
  /**
   * The bundle is emitted at two depths — `dist/main.js` and `dist/cli/*.js` —
   * and only the deeper one was covered by a relative candidate. The server
   * found its migrations solely because a cwd-relative candidate matched when
   * the process happened to start from the repository root; from a systemd
   * unit with any other WorkingDirectory it died on boot with
   * "Can't find meta/_journal.json".
   */
  it('finds the migrations regardless of the working directory', async () => {
    const { migrationsFolder } = await import('../../packages/server/src/db/migrate.js');
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const original = process.cwd();
    try {
      process.chdir('/');
      const folder = migrationsFolder();
      expect(existsSync(resolve(folder, 'meta/_journal.json'))).toBe(true);
    } finally {
      process.chdir(original);
    }
  });
});
