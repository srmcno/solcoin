/** Text normalisation shared by originality, saturation and dedup logic. */

const LEET_MAP: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'i',
};

/** Lowercase, strip diacritics, collapse whitespace. */
export function normalise(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Aggressive "confusability" fold: what a human would read at a glance.
 * `PEPE`, `p3p3`, `p-e-p-e` and `рере` (Cyrillic homoglyphs) all fold together.
 */
export function confusableFold(input: string): string {
  const homoglyphs: Record<string, string> = {
    а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
    ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ɢ: 'g', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm',
    ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ʀ: 'r', ѕ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
  };
  let s = normalise(input);
  s = [...s].map((ch) => homoglyphs[ch] ?? LEET_MAP[ch] ?? ch).join('');
  s = s.replace(/[^a-z0-9]+/g, '');
  // Collapse runs of a repeated character ("pepeee" -> "pepe").
  s = s.replace(/(.)\1{1,}/g, '$1');
  return s;
}

export function tokenise(input: string): string[] {
  return normalise(input)
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'it', 'this', 'that',
  'with', 'as', 'at', 'by', 'from', 'but', 'be', 'are', 'was', 'were', 'has', 'have', 'had',
  'coin', 'token', 'meme', 'memecoin', 'inu', 'the', 'official',
]);

export function contentTokens(input: string): string[] {
  return tokenise(input).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Character n-grams of the confusable-folded string. */
export function charNgrams(input: string, n = 3): string[] {
  const s = confusableFold(input);
  if (s.length === 0) return [];
  if (s.length <= n) return [s];
  const out: string[] = [];
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  return out;
}

/** Slugify for stable, URL-safe identifiers. */
export function slugify(input: string, maxLength = 64): string {
  const s = normalise(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'item').slice(0, maxLength).replace(/-+$/g, '');
}
