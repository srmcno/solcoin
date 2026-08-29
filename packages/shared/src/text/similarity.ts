import { charNgrams, confusableFold, contentTokens, normalise } from './normalise.js';

/** Levenshtein edit distance with an early-exit band. */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length]!;
}

/** Normalised edit similarity in [0,1]. */
export function editSimilarity(a: string, b: string): number {
  const x = confusableFold(a);
  const y = confusableFold(b);
  const maxLen = Math.max(x.length, y.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(x, y) / maxLen;
}

/** Jaro-Winkler — better than plain edit distance for short brand-like names. */
export function jaroWinkler(a: string, b: string): number {
  const s1 = confusableFold(a);
  const s2 = confusableFold(b);
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);
  let matches = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Token-set similarity over content words (order-insensitive). */
export function tokenSimilarity(a: string, b: string): number {
  return jaccard(contentTokens(a), contentTokens(b));
}

/** Trigram similarity — robust to word order and minor spelling changes. */
export function trigramSimilarity(a: string, b: string): number {
  return jaccard(charNgrams(a, 3), charNgrams(b, 3));
}

/**
 * Composite "would a trader confuse these?" score in [0,1].
 *
 * Deliberately takes the maximum of several views: any one of them firing is
 * enough to make two names confusable in a token list.
 */
export function nameConfusability(a: string, b: string): number {
  const foldA = confusableFold(a);
  const foldB = confusableFold(b);
  if (foldA.length === 0 || foldB.length === 0) return 0;
  if (foldA === foldB) return 1;
  const containment =
    foldA.length >= 4 && foldB.length >= 4 && (foldA.includes(foldB) || foldB.includes(foldA)) ? 0.9 : 0;
  return Math.max(
    editSimilarity(a, b),
    jaroWinkler(a, b),
    trigramSimilarity(a, b),
    tokenSimilarity(a, b) * 0.95,
    containment,
  );
}

/** Ticker confusability — tickers are short, so exact/near-exact matters most. */
export function tickerConfusability(a: string, b: string): number {
  const x = confusableFold(a);
  const y = confusableFold(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const dist = levenshtein(x, y, 2);
  if (dist === 1 && Math.max(x.length, y.length) >= 4) return 0.85;
  if (dist === 1) return 0.7;
  if (dist === 2 && Math.max(x.length, y.length) >= 6) return 0.6;
  return Math.max(0, jaroWinkler(a, b) - 0.15);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export { normalise };
