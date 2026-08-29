import { clamp, logScale01 } from '../math/stats.js';
import { embeddingSimilarity } from '../text/embedding.js';
import { nameConfusability, tickerConfusability } from '../text/similarity.js';

/**
 * Saturation detection.
 *
 * The core edge this platform claims is *timing*: finding a wave before it has
 * been tokenised twenty times. Saturation is therefore not a nice-to-have
 * filter, it is the single most important negative signal in the system.
 *
 * We measure it against three populations:
 *   1. Tokens already launched on-chain that occupy the same concept space.
 *   2. Concepts this platform has previously generated (do not reinvent).
 *   3. The rate at which new competitors are appearing right now.
 */

export interface CompetitorToken {
  mint?: string;
  name: string;
  symbol: string;
  /** Optional description used for semantic comparison. */
  description?: string;
  /** Optional embedding of name + description. */
  embedding?: readonly number[];
  createdAtMs: number;
  marketCapUsd?: number;
  volume24hUsd?: number;
  holders?: number;
  /** True when the token reached an AMM pool. */
  graduated?: boolean;
}

export interface SaturationInput {
  /** Proposed token name. */
  name: string;
  /** Proposed ticker. */
  symbol: string;
  /** Concept description used for semantic comparison. */
  description: string;
  /** Embedding of the proposed concept, same space as competitor embeddings. */
  embedding?: readonly number[];
  /** Candidate competitor set, ideally pre-filtered by keyword. */
  competitors: readonly CompetitorToken[];
  /** Current time in ms, injected for determinism. */
  nowMs: number;
  /** Optional measure of how much social discussion already frames this as a coin. */
  socialTokenisationSignal?: number;
}

export interface SaturationMatch {
  name: string;
  symbol: string;
  mint?: string;
  similarity: number;
  kind: 'name' | 'ticker' | 'semantic';
  ageHours: number;
  marketCapUsd?: number;
  volume24hUsd?: number;
  graduated?: boolean;
  /** How much this single competitor contributes to the saturation score. */
  weight: number;
}

export interface SaturationResult {
  /** 0..1, higher means more crowded. */
  score: number;
  /** Count of competitors above the similarity floor. */
  competitorCount: number;
  /** Competitors launched in the last 24h above the floor. */
  recentCompetitorCount: number;
  /** 0..1 quality of the best competing token (its traction). */
  competitorQuality: number;
  /** Largest competing market cap in USD. */
  bestCompetitorMarketCapUsd: number;
  /** True if an existing token is close enough that launching would be confusing. */
  hardCollision: boolean;
  matches: SaturationMatch[];
  rationale: string[];
}

const SIMILARITY_FLOOR = 0.42;
/** Above this, the names are close enough that traders would confuse them. */
export const HARD_COLLISION_THRESHOLD = 0.88;

/**
 * Competitor relevance decays with age: a same-theme token from three weeks ago
 * barely competes for today's attention, one from three hours ago competes hard.
 */
function recencyWeight(ageHours: number): number {
  if (ageHours < 0) return 1;
  return clamp(Math.exp(-ageHours / 48), 0.02, 1);
}

/** A competitor that already has real traction crowds the space far more. */
function tractionWeight(c: CompetitorToken): number {
  const mcap = logScale01(c.marketCapUsd ?? 0, 2_000_000);
  const vol = logScale01(c.volume24hUsd ?? 0, 500_000);
  const holders = logScale01(c.holders ?? 0, 2000);
  const grad = c.graduated ? 0.35 : 0;
  return clamp(0.3 + 0.9 * (0.4 * mcap + 0.3 * vol + 0.3 * holders) + grad, 0.3, 1.8);
}

export function computeSaturation(input: SaturationInput): SaturationResult {
  const matches: SaturationMatch[] = [];

  for (const c of input.competitors) {
    const ageHours = Math.max(0, (input.nowMs - c.createdAtMs) / 3_600_000);
    const nameSim = nameConfusability(input.name, c.name);
    const tickerSim = tickerConfusability(input.symbol, c.symbol);
    const semanticSim =
      input.embedding && c.embedding && input.embedding.length === c.embedding.length
        ? embeddingSimilarity(input.embedding, c.embedding)
        : 0;

    const best = Math.max(nameSim, tickerSim, semanticSim);
    if (best < SIMILARITY_FLOOR) continue;

    const kind: SaturationMatch['kind'] =
      best === nameSim ? 'name' : best === tickerSim ? 'ticker' : 'semantic';

    matches.push({
      name: c.name,
      symbol: c.symbol,
      mint: c.mint,
      similarity: best,
      kind,
      ageHours,
      marketCapUsd: c.marketCapUsd,
      volume24hUsd: c.volume24hUsd,
      graduated: c.graduated,
      weight: best * recencyWeight(ageHours) * tractionWeight(c),
    });
  }

  matches.sort((a, b) => b.weight - a.weight);

  const competitorCount = matches.length;
  const recentCompetitorCount = matches.filter((m) => m.ageHours <= 24).length;
  const totalWeight = matches.reduce((acc, m) => acc + m.weight, 0);
  const bestCompetitorMarketCapUsd = matches.reduce((acc, m) => Math.max(acc, m.marketCapUsd ?? 0), 0);
  const competitorQuality = matches.length
    ? clamp(
        Math.max(
          ...matches.map((m) =>
            0.5 * logScale01(m.marketCapUsd ?? 0, 1_000_000) +
            0.3 * logScale01(m.volume24hUsd ?? 0, 250_000) +
            (m.graduated ? 0.2 : 0),
          ),
        ),
        0,
        1,
      )
    : 0;

  const hardCollision = matches.some(
    (m) => m.similarity >= HARD_COLLISION_THRESHOLD && (m.kind === 'name' || m.kind === 'ticker'),
  );

  // Weighted competitor mass saturates: going from 0 to 3 relevant competitors
  // matters enormously; 20 to 23 barely changes anything.
  const massScore = clamp(totalWeight / (totalWeight + 2.5), 0, 1);
  // A burst of competitors right now is worse than the same count spread out.
  const burstScore = clamp(logScale01(recentCompetitorCount, 12), 0, 1);
  const social = clamp(input.socialTokenisationSignal ?? 0, 0, 1);

  const score = clamp(
    0.58 * massScore + 0.22 * burstScore + 0.12 * competitorQuality + 0.08 * social,
    0,
    1,
  );

  const rationale: string[] = [];
  if (competitorCount === 0) {
    rationale.push('No similar tokens found in the sampled market data — the concept space looks open.');
  } else {
    rationale.push(
      `${competitorCount} similar token${competitorCount === 1 ? '' : 's'} found (${recentCompetitorCount} in the last 24h).`,
    );
    const top = matches[0];
    if (top) {
      rationale.push(
        `Closest: "${top.name}" ($${top.symbol}) at ${(top.similarity * 100).toFixed(0)}% ${top.kind} similarity, ${top.ageHours.toFixed(1)}h old.`,
      );
    }
    if (bestCompetitorMarketCapUsd > 0) {
      rationale.push(`Largest competing market cap: $${Math.round(bestCompetitorMarketCapUsd).toLocaleString('en-US')}.`);
    }
  }
  if (hardCollision) rationale.push('Hard collision: an existing token is close enough to be confused with this one.');

  return {
    score,
    competitorCount,
    recentCompetitorCount,
    competitorQuality,
    bestCompetitorMarketCapUsd,
    hardCollision,
    matches: matches.slice(0, 25),
    rationale,
  };
}
