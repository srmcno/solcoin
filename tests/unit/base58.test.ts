import { describe, expect, it } from 'vitest';
import { decodeBase58, encodeBase58 } from '../../packages/server/src/security/keystore.js';

/**
 * Base58 round-tripping, where the interesting case is a leading zero byte.
 *
 * Each leading '1' encodes exactly one zero byte. Getting that off by one is
 * invisible for most inputs and fatal for the roughly one key in 256 whose
 * first byte is zero: it decodes one byte too long and is rejected on import,
 * so the operator holding it simply cannot restore their wallet.
 */

const SAMPLES: number[][] = [
  [],
  [0],
  [0, 0],
  [0, 0, 0],
  [1],
  [0, 1, 2],
  [255, 0, 255],
  [0, 255, 255, 0],
];

describe('base58', () => {
  it('round-trips every shape, leading zeroes included', () => {
    for (const bytes of SAMPLES) {
      const encoded = encodeBase58(Uint8Array.from(bytes));
      expect(Array.from(decodeBase58(encoded)), `round trip of [${bytes}] via "${encoded}"`).toEqual(bytes);
    }
  });

  it('encodes one leading zero byte as exactly one "1"', () => {
    expect(encodeBase58(Uint8Array.from([0]))).toBe('1');
    expect(encodeBase58(Uint8Array.from([0, 0]))).toBe('11');
    // "11" for a single zero byte is the bug: it decodes back to two.
    expect(encodeBase58(Uint8Array.from([0, 1]))).toBe('12');
  });

  it('preserves the length of a 64-byte key beginning with zero', () => {
    // The case that matters: a secret key whose first byte happens to be zero.
    const key = Uint8Array.from([0, ...Array.from({ length: 63 }, (_, i) => (i * 7 + 3) % 256)]);
    const round = decodeBase58(encodeBase58(key));
    expect(round.length).toBe(64);
    expect(Array.from(round)).toEqual(Array.from(key));
  });

  it('preserves the length of a 32-byte seed beginning with zero', () => {
    const seed = Uint8Array.from([0, ...Array.from({ length: 31 }, (_, i) => (i * 11 + 5) % 256)]);
    expect(decodeBase58(encodeBase58(seed)).length).toBe(32);
  });

  it('round-trips a large random sample, including the zero-prefixed ones', () => {
    // Deterministic, so a failure is reproducible.
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 256;
    };
    let zeroPrefixed = 0;
    for (let n = 0; n < 400; n++) {
      const bytes = Array.from({ length: 32 }, () => next());
      if (n % 4 === 0) {
        bytes[0] = 0;
        zeroPrefixed++;
      }
      expect(Array.from(decodeBase58(encodeBase58(Uint8Array.from(bytes))))).toEqual(bytes);
    }
    expect(zeroPrefixed).toBeGreaterThan(50);
  });

  it('rejects a character outside the alphabet', () => {
    expect(() => decodeBase58('abc0def')).toThrow(/invalid base58/i);
  });
});
