import { clamp } from '../math/stats.js';
import { embeddingSimilarity } from '../text/embedding.js';
import { confusableFold, contentTokens } from '../text/normalise.js';
import { nameConfusability, tickerConfusability } from '../text/similarity.js';

/**
 * Originality scoring.
 *
 * Two failure modes this guards against:
 *   1. The platform reinventing a concept it already generated (wasted spend,
 *      and increasingly derivative output as the model drifts toward its own
 *      past outputs).
 *   2. Producing generic slop — "SomethingInu", "BabyPepe2.0" — that has no
 *      chance of organic attention regardless of the trend behind it.
 */

export interface PriorConcept {
  id: string;
  name: string;
  symbol: string;
  description: string;
  embedding?: readonly number[];
  createdAtMs: number;
  /** Did it launch? Reused *failed* concepts are worse than reused unlaunched ones. */
  launched: boolean;
}

export interface OriginalityInput {
  name: string;
  symbol: string;
  description: string;
  embedding?: readonly number[];
  priorConcepts: readonly PriorConcept[];
  nowMs: number;
}

export interface OriginalityResult {
  /** 0..1, higher is more original. */
  score: number;
  /** Highest similarity to any prior concept. */
  maxPriorSimilarity: number;
  nearestPrior?: { id: string; name: string; symbol: string; similarity: number };
  /** 0..1 penalty for generic meme-naming patterns. */
  clichePenalty: number;
  cliches: string[];
  /** True when the concept is effectively a repeat. */
  isDuplicate: boolean;
  rationale: string[];
}

/**
 * Naming patterns that saturate every token list. A name built from these alone
 * carries no information and gets no organic attention.
 */
const CLICHE_PATTERNS: Array<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /\binu\b/i, label: '"Inu" suffix', weight: 0.22 },
  { pattern: /\bbaby\s?\w+/i, label: '"Baby X" pattern', weight: 0.2 },
  { pattern: /\b(doge|shib|pepe|bonk|wif)\b/i, label: 'established mascot reuse', weight: 0.18 },
  { pattern: /\b\w+\s?2\.0\b/i, label: '"2.0" derivative', weight: 0.25 },
  { pattern: /\bsafe\w+/i, label: '"Safe X" pattern', weight: 0.24 },
  { pattern: /\b(moon|rocket|lambo|1000x|100x)\b/i, label: 'price-promise language', weight: 0.3 },
  { pattern: /\belon\b/i, label: 'Elon reference', weight: 0.2 },
  { pattern: /\bai\s?(coin|token)\b/i, label: 'generic "AI coin"', weight: 0.18 },
  { pattern: /\b(gm|wagmi|hodl|fomo)\b/i, label: 'generic crypto slang', weight: 0.12 },
  { pattern: /\b(king|lord|god|based|chad|giga)\s?\w*/i, label: 'generic hype modifier', weight: 0.1 },
  { pattern: /\bv?\d+\b\s*$/i, label: 'numeric version suffix', weight: 0.15 },
];

export function detectCliches(text: string): Array<{ label: string; weight: number }> {
  const out: Array<{ label: string; weight: number }> = [];
  for (const { pattern, label, weight } of CLICHE_PATTERNS) {
    if (pattern.test(text)) out.push({ label, weight });
  }
  return out;
}

function similarityToPrior(input: OriginalityInput, prior: PriorConcept): number {
  const nameSim = nameConfusability(input.name, prior.name);
  const tickerSim = tickerConfusability(input.symbol, prior.symbol);
  const semantic =
    input.embedding && prior.embedding && input.embedding.length === prior.embedding.length
      ? embeddingSimilarity(input.embedding, prior.embedding)
      : 0;
  // Description overlap catches "same joke, different name".
  const descTokens = new Set(contentTokens(input.description));
  const priorTokens = new Set(contentTokens(prior.description));
  let inter = 0;
  for (const t of descTokens) if (priorTokens.has(t)) inter++;
  const union = descTokens.size + priorTokens.size - inter;
  const descSim = union > 0 ? inter / union : 0;

  return Math.max(nameSim, tickerSim, semantic, descSim * 0.9);
}

export function computeOriginality(input: OriginalityInput): OriginalityResult {
  let maxPriorSimilarity = 0;
  let nearestPrior: OriginalityResult['nearestPrior'];

  for (const prior of input.priorConcepts) {
    const sim = similarityToPrior(input, prior);
    // A concept we already *launched* is a stronger reason to avoid repeating.
    const adjusted = prior.launched ? Math.min(1, sim * 1.08) : sim;
    if (adjusted > maxPriorSimilarity) {
      maxPriorSimilarity = adjusted;
      nearestPrior = { id: prior.id, name: prior.name, symbol: prior.symbol, similarity: adjusted };
    }
  }

  const clicheHits = detectCliches(`${input.name} ${input.symbol} ${input.description}`);
  const clichePenalty = clamp(
    clicheHits.reduce((acc, c) => acc + c.weight, 0),
    0,
    0.75,
  );

  // Very short or purely generic names carry no distinctiveness.
  const folded = confusableFold(input.name);
  const distinctiveness = clamp((folded.length - 2) / 10, 0, 1);

  const score = clamp((1 - maxPriorSimilarity) * (1 - clichePenalty) * (0.6 + 0.4 * distinctiveness), 0, 1);
  const isDuplicate = maxPriorSimilarity >= 0.85;

  const rationale: string[] = [];
  if (nearestPrior && maxPriorSimilarity > 0.5) {
    rationale.push(
      `Closest prior concept "${nearestPrior.name}" ($${nearestPrior.symbol}) at ${(maxPriorSimilarity * 100).toFixed(0)}% similarity.`,
    );
  } else {
    rationale.push('No close match in the historical concept corpus.');
  }
  if (clicheHits.length) {
    rationale.push(`Naming clichés detected: ${clicheHits.map((c) => c.label).join(', ')}.`);
  }
  if (isDuplicate) rationale.push('Treated as a duplicate — the platform has generated this concept before.');

  return {
    score,
    maxPriorSimilarity,
    nearestPrior,
    clichePenalty,
    cliches: clicheHits.map((c) => c.label),
    isDuplicate,
    rationale,
  };
}

/**
 * Heuristic name quality: how well does this read as a memorable ticker brand?
 *
 * Rewards short, pronounceable, distinctive names; penalises numerals,
 * unpronounceable consonant runs, and excessive length.
 */
export function scoreNameQuality(name: string): { score: number; notes: string[] } {
  const notes: string[] = [];
  const folded = confusableFold(name);
  const words = contentTokens(name);
  let score = 0.5;

  const len = folded.length;
  if (len >= 3 && len <= 12) {
    score += 0.18;
  } else if (len > 18) {
    score -= 0.2;
    notes.push('Name is long enough to be forgettable.');
  }

  if (words.length <= 2) score += 0.1;
  else if (words.length >= 4) {
    score -= 0.12;
    notes.push('More than three words is hard to recall as a ticker brand.');
  }

  // Pronounceability: vowel ratio and consonant clusters.
  const vowels = (folded.match(/[aeiouy]/g) ?? []).length;
  const ratio = len > 0 ? vowels / len : 0;
  if (ratio >= 0.25 && ratio <= 0.55) score += 0.12;
  else {
    score -= 0.12;
    notes.push('Unusual vowel balance makes the name hard to say.');
  }
  if (/[bcdfghjklmnpqrstvwxz]{4,}/.test(folded)) {
    score -= 0.15;
    notes.push('Contains an unpronounceable consonant run.');
  }

  if (/\d/.test(name)) {
    score -= 0.1;
    notes.push('Digits in a name read as low-effort.');
  }

  // Alliteration / internal rhyme is genuinely memorable.
  if (words.length >= 2 && words.every((w) => w[0] === words[0]![0])) {
    score += 0.08;
    notes.push('Alliterative, which aids recall.');
  }

  return { score: clamp(score, 0, 1), notes };
}

export function scoreTickerQuality(symbol: string): { score: number; notes: string[] } {
  const notes: string[] = [];
  const s = confusableFold(symbol);
  let score = 0.5;

  if (s.length >= 3 && s.length <= 6) score += 0.25;
  else if (s.length < 3) {
    score -= 0.15;
    notes.push('Very short tickers collide with existing listings.');
  } else if (s.length > 8) {
    score -= 0.25;
    notes.push('Tickers longer than eight characters get truncated in most UIs.');
  }

  if (/^[a-z]+$/.test(s)) score += 0.12;
  if (/\d/.test(symbol)) {
    score -= 0.12;
    notes.push('Digits in a ticker look like a derivative token.');
  }
  const vowels = (s.match(/[aeiouy]/g) ?? []).length;
  if (s.length >= 4 && vowels === 0) {
    score -= 0.12;
    notes.push('No vowels — hard to pronounce aloud.');
  }
  return { score: clamp(score, 0, 1), notes };
}
