import {
  DEFAULT_ECONOMICS,
  estimateAmmCreatorFeeBps,
  type CompetitorToken,
  type EconomicAssumptions,
  type RejectionReason,
} from '@solcoin/shared';
import { safeErrorText } from '../core/errors.js';
import { componentLogger } from '../core/logger.js';
import { parseJson } from '../core/json.js';
import type { Db } from '../db/client.js';
import type { EventBus } from '../core/events.js';
import type { MarketProvider } from '../providers/types.js';
import type { ConceptService, GeneratedConcept } from './concept.service.js';
import type { EvaluationService, PanelRole } from './evaluation.service.js';
import type { PredictionService } from './prediction.service.js';
import type { QualityGateService } from './quality-gate.service.js';
import type { ResearchService } from './research.service.js';
import type { SettingsService } from './settings.service.js';
import type { TrendService, ScoredTrend } from './trend.service.js';
import type { GuardService } from './guard.service.js';
import type { ArtworkService } from './artwork.service.js';
import type { ExperimentService } from './experiment.service.js';

/**
 * The candidate pipeline.
 *
 * Ties discovery through to an approved, launch-ready candidate:
 *
 *   qualifying trend → competitor sample → concept slate → deterministic screen
 *   → evaluation panel → prediction → quality gate → artwork + metadata
 *   → approval queue (or autonomous launch)
 *
 * The ordering is chosen so that the cheapest filters run first. Deterministic
 * screening costs nothing and eliminates most bad candidates; the evaluation
 * panel costs a few cents; artwork and metadata hosting cost the most and are
 * therefore only produced for candidates that have already cleared the gate.
 * Generating artwork for a candidate that will be rejected is pure waste, and
 * doing it in the wrong order is the most common way a system like this becomes
 * expensive without becoming better.
 */

export interface PipelineResult {
  trendsProcessed: number;
  conceptsGenerated: number;
  conceptsScreenedOut: number;
  conceptsEvaluated: number;
  candidatesPassed: number;
  candidatesRejected: number;
  awaitingApproval: number;
  autoLaunched: number;
  aiCostUsd: number;
  rejections: Array<{ conceptId: string; name: string; reason: RejectionReason; detail: string }>;
  errors: string[];
  durationMs: number;
}

export interface PipelineDeps {
  db: Db;
  settings: SettingsService;
  guard: GuardService;
  research: ResearchService;
  trends: TrendService;
  concepts: ConceptService;
  evaluation: EvaluationService;
  predictions: PredictionService;
  gate: QualityGateService;
  artwork: ArtworkService;
  experiments: ExperimentService;
  events: EventBus;
  marketProviders: MarketProvider[];
  now?: () => number;
}

export class PipelineService {
  private readonly log = componentLogger('pipeline');
  private readonly now: () => number;

  constructor(private readonly deps: PipelineDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** One full generation cycle across the qualifying opportunities. */
  async run(options: { maxTrends?: number; signal?: AbortSignal } = {}): Promise<PipelineResult> {
    const started = this.now();
    const result: PipelineResult = {
      trendsProcessed: 0,
      conceptsGenerated: 0,
      conceptsScreenedOut: 0,
      conceptsEvaluated: 0,
      candidatesPassed: 0,
      candidatesRejected: 0,
      awaitingApproval: 0,
      autoLaunched: 0,
      aiCostUsd: 0,
      rejections: [],
      errors: [],
      durationMs: 0,
    };

    const operational = this.deps.guard.checkOperational('concept_generation');
    if (!operational.allowed) {
      result.errors.push(operational.reason ?? 'Concept generation is not permitted right now.');
      result.durationMs = this.now() - started;
      return result;
    }

    const config = this.deps.settings.get();
    const trends = await this.deps.research.selectForGeneration(options.maxTrends ?? 3);

    if (trends.length === 0) {
      this.log.info('no trends currently qualify for concept generation');
      result.durationMs = this.now() - started;
      return result;
    }

    const priorConcepts = await this.deps.concepts.loadPriorConcepts();

    for (const trend of trends) {
      if (options.signal?.aborted) break;
      try {
        const outcome = await this.processTrend(trend, priorConcepts, config.research.conceptsPerOpportunity, options.signal);
        result.trendsProcessed++;
        result.conceptsGenerated += outcome.generated;
        result.conceptsScreenedOut += outcome.screenedOut;
        result.conceptsEvaluated += outcome.evaluated;
        result.candidatesPassed += outcome.passed;
        result.candidatesRejected += outcome.rejected;
        result.awaitingApproval += outcome.awaitingApproval;
        result.aiCostUsd += outcome.aiCostUsd;
        result.rejections.push(...outcome.rejections);
      } catch (e) {
        const message = safeErrorText(e, 300);
        result.errors.push(`${trend.slug}: ${message}`);
        this.log.warn({ trend: trend.slug, err: message }, 'pipeline failed for a trend');
      }
    }

    result.durationMs = this.now() - started;
    this.log.info(
      {
        trends: result.trendsProcessed,
        generated: result.conceptsGenerated,
        passed: result.candidatesPassed,
        aiCostUsd: Number(result.aiCostUsd.toFixed(4)),
      },
      'pipeline cycle complete',
    );
    return result;
  }

  private async processTrend(
    trend: ScoredTrend,
    priorConcepts: Awaited<ReturnType<ConceptService['loadPriorConcepts']>>,
    conceptCount: number,
    signal?: AbortSignal,
  ): Promise<{
    generated: number;
    screenedOut: number;
    evaluated: number;
    passed: number;
    rejected: number;
    awaitingApproval: number;
    aiCostUsd: number;
    rejections: PipelineResult['rejections'];
  }> {
    const outcome = {
      generated: 0,
      screenedOut: 0,
      evaluated: 0,
      passed: 0,
      rejected: 0,
      awaitingApproval: 0,
      aiCostUsd: 0,
      rejections: [] as PipelineResult['rejections'],
    };

    const competitors = await this.sampleCompetitors(trend);
    // Recording saturation on the trend itself keeps the opportunity screen
    // honest even for trends that never produce a candidate.
    const trendSaturation = competitors.length > 0 ? Math.min(1, competitors.length / 25) : 0;
    this.deps.trends.setSaturation(trend.id, trendSaturation);

    const experimentArm = await this.deps.experiments
      .assign(`trend:${trend.id}`)
      .catch(() => null);

    const concepts = await this.deps.concepts.generate({
      trend,
      competitors,
      priorConcepts,
      count: conceptCount,
      experimentArm: experimentArm
        ? {
            key: experimentArm.armKey,
            label: experimentArm.armKey,
            instruction: String(parseJson<Record<string, unknown>>(JSON.stringify(experimentArm.config), {}).instruction ?? experimentArm.armKey),
          }
        : undefined,
    });

    outcome.generated = concepts.length;
    const viable = concepts.filter((c) => !c.blocked);
    outcome.screenedOut = concepts.length - viable.length;

    if (viable.length === 0) return outcome;

    const config = this.deps.settings.get();
    const market = this.deps.research.latestMarketConditions();
    const economics = this.economics(market.solPriceUsd);
    const totalLaunches = this.countLaunches();

    // Evaluate the slate, then rank. Every candidate is scored before any is
    // promoted, so the platform picks the best of the batch rather than the
    // first one that happens to clear the bar.
    const evaluated: Array<{
      concept: GeneratedConcept;
      panelScore: number;
      disagreement: number;
      predictionId: string;
      rank: number;
      gateDecision: ReturnType<QualityGateService['evaluate']>;
      expectedValueSol: number;
    }> = [];

    for (const concept of viable) {
      if (signal?.aborted) break;

      const evaluation = await this.deps.evaluation.evaluate(
        {
          conceptId: concept.id,
          name: concept.name,
          symbol: concept.symbol,
          description: concept.description,
          narrative: concept.narrative,
          archetype: concept.archetype,
          trend,
          competitorSummary: competitors
            .slice(0, 8)
            .map((c) => `${c.name} ($${c.symbol})`)
            .join(', '),
          originalityScore: concept.originalityScore,
          saturationScore: concept.saturationScore,
          existingRiskFlags: concept.riskFlags,
        },
        config.ai.panelEnabled ? (config.ai.panelRoles as PanelRole[]) : [],
      );
      outcome.evaluated++;
      outcome.aiCostUsd += evaluation.totalCostUsd;

      this.deps.db.$raw
        .prepare(
          `UPDATE concepts SET ai_panel_score = ?, ai_panel_disagreement = ?, requires_human_review = ?,
                               reasoning_summary = ?, status = ?, rejection_reason = ?, rejection_detail = ?,
                               risk_flags = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          evaluation.panelScore,
          evaluation.disagreement,
          evaluation.requiresHumanReview ? 1 : 0,
          `${concept.reasoningSummary} ${evaluation.summary}`.slice(0, 4000),
          evaluation.blocked ? 'rejected' : 'evaluating',
          evaluation.blocked ? 'risk_flagged' : null,
          evaluation.blocked ? (evaluation.blockReason ?? 'Rejected by the risk reviewer.') : null,
          JSON.stringify([
            ...concept.riskFlags,
            ...evaluation.aggregatedRiskFlags.map((f) => ({ flag: f, severity: 'review', label: `Flagged by the evaluation panel: ${f}` })),
          ]),
          this.now(),
          concept.id,
        );

      if (evaluation.blocked) {
        outcome.rejected++;
        outcome.rejections.push({
          conceptId: concept.id,
          name: concept.name,
          reason: 'risk_flagged',
          detail: evaluation.blockReason ?? 'Rejected by the risk reviewer.',
        });
        this.deps.events.emit('concept.rejected', {
          conceptId: concept.id,
          reason: 'risk_flagged',
          detail: evaluation.blockReason ?? '',
        });
        continue;
      }

      const features = this.deps.predictions.buildFeatures({
        trend,
        concept: {
          id: concept.id,
          symbol: concept.symbol,
          archetype: concept.archetype,
          originalityScore: concept.originalityScore,
          saturationScore: concept.saturationScore,
          nameQuality: concept.nameQuality,
          tickerQuality: concept.tickerQuality,
          memeIntensity: concept.memeIntensity,
          culturalRelevance: concept.culturalRelevance,
          // Artwork does not exist yet at prediction time, so a neutral value
          // is used rather than a flattering guess. It is refreshed if artwork
          // is later scored.
          artworkQuality: 0.6,
        },
        panel: { score: evaluation.panelScore, disagreement: evaluation.disagreement },
        competition: {
          recentCount: competitors.filter((c) => this.now() - c.createdAtMs < 86_400_000).length,
          bestMarketCapUsd: competitors.reduce((acc, c) => Math.max(acc, c.marketCapUsd ?? 0), 0),
          quality: Math.min(1, competitors.filter((c) => c.graduated).length / 5),
        },
        market: {
          launchesPerHour: market.launchesPerHour,
          graduationRate: market.graduationRate,
          solMomentum: market.solMomentum,
          regime: market.regime,
        },
        atMs: this.now(),
      });

      const { predictionId, result: prediction } = await this.deps.predictions.predict(concept.id, features, economics);

      const gateDecision = this.deps.gate.evaluate({
        conceptId: concept.id,
        trend,
        concept: {
          originalityScore: concept.originalityScore,
          saturationScore: concept.saturationScore,
          hardCollision: concept.hardCollision,
          riskFlags: concept.riskFlags,
          status: 'evaluating',
        },
        prediction,
        totalLaunches,
      });

      if (!gateDecision.passed) {
        outcome.rejected++;
        outcome.rejections.push({
          conceptId: concept.id,
          name: concept.name,
          reason: gateDecision.reason ?? 'quality_gate',
          detail: gateDecision.detail ?? gateDecision.summary,
        });
        this.deps.concepts.setStatus(concept.id, 'rejected', {
          reason: gateDecision.reason ?? 'quality_gate',
          detail: gateDecision.detail ?? gateDecision.summary,
        });
        this.recordGateChecks(concept.id, gateDecision);
        this.deps.events.emit('concept.rejected', {
          conceptId: concept.id,
          reason: gateDecision.reason ?? 'quality_gate',
          detail: gateDecision.detail ?? '',
        });
        continue;
      }

      this.recordGateChecks(concept.id, gateDecision);
      evaluated.push({
        concept,
        panelScore: evaluation.panelScore,
        disagreement: evaluation.disagreement,
        predictionId,
        rank: gateDecision.rankScore,
        gateDecision,
        expectedValueSol: prediction.expectedValueSol,
      });
    }

    if (evaluated.length === 0) return outcome;

    // Only the best candidate per trend proceeds. Launching several variants of
    // the same trend competes with itself for the same audience and multiplies
    // cost without multiplying expected revenue.
    evaluated.sort((a, b) => b.rank - a.rank);
    const winner = evaluated[0]!;
    const runnersUp = evaluated.slice(1);

    for (const loser of runnersUp) {
      outcome.rejected++;
      const detail = `A stronger candidate for the same trend was selected ("${winner.concept.name}", expected value ${winner.expectedValueSol.toFixed(4)} SOL versus ${loser.expectedValueSol.toFixed(4)} SOL here).`;
      outcome.rejections.push({ conceptId: loser.concept.id, name: loser.concept.name, reason: 'quality_gate', detail });
      this.deps.concepts.setStatus(loser.concept.id, 'rejected', { reason: 'quality_gate', detail });
    }

    outcome.passed++;

    // Artwork and metadata are produced only now, for the single winner.
    try {
      await this.deps.artwork.produce(winner.concept.id, {
        name: winner.concept.name,
        symbol: winner.concept.symbol,
        description: winner.concept.description,
        imagePrompt: winner.concept.imagePrompt,
      });
    } catch (e) {
      this.log.warn(
        { conceptId: winner.concept.id, err: safeErrorText(e, 200) },
        'artwork or metadata production failed; the candidate stays queued and will be retried before launch',
      );
    }

    if (winner.gateDecision.isExploration) {
      this.deps.db.$raw
        .prepare('UPDATE concepts SET is_exploration = 1, exploration_arm = ?, updated_at = ? WHERE id = ?')
        .run(winner.gateDecision.explorationArm ?? null, this.now(), winner.concept.id);
    }

    const launchAutonomy = config.autonomy.launch;
    const needsReview =
      launchAutonomy !== 'auto' ||
      winner.concept.riskFlags.some((f) => f.severity === 'review') ||
      (config.qualityGate.humanReviewOnAnyRiskFlag && winner.concept.riskFlags.length > 0);

    if (needsReview) {
      this.deps.concepts.setStatus(winner.concept.id, 'awaiting_approval');
      outcome.awaitingApproval++;
      this.deps.events.emit('concept.awaiting_approval', {
        conceptId: winner.concept.id,
        name: winner.concept.name,
        symbol: winner.concept.symbol,
        expectedValueSol: winner.expectedValueSol,
      });
    } else {
      this.deps.concepts.setStatus(winner.concept.id, 'approved', { actorId: 'system' });
    }

    return outcome;
  }

  /**
   * Sample the competitive landscape for a trend.
   *
   * Uses the trend's own keywords against every configured market provider, and
   * caches results so repeated pipeline runs within a short window do not burn
   * the same rate limit twice.
   */
  private async sampleCompetitors(trend: ScoredTrend): Promise<CompetitorToken[]> {
    const terms = [trend.title, ...trend.keywords.slice(0, 3)].filter(Boolean);
    const collected = new Map<string, CompetitorToken>();

    for (const provider of this.deps.marketProviders) {
      if (typeof provider.searchTokens !== 'function') continue;
      for (const term of terms.slice(0, 3)) {
        try {
          const found = await provider.searchTokens(term, { limit: 30 });
          for (const token of found) {
            const key = token.mint ?? `${token.name}:${token.symbol}`;
            if (collected.has(key)) continue;
            collected.set(key, {
              mint: token.mint,
              name: token.name ?? '',
              symbol: token.symbol ?? '',
              createdAtMs: token.createdAtMs ?? this.now(),
              marketCapUsd: token.marketCapUsd,
              volume24hUsd: token.volume24hSol,
              holders: token.holders,
              graduated: token.graduated,
            });
          }
        } catch (e) {
          this.log.debug({ provider: provider.id, term, err: safeErrorText(e, 120) }, 'competitor search failed');
        }
      }
    }

    // Fold in anything the market-intelligence cache already knows about, which
    // covers launches the search APIs have not indexed yet.
    const cached = this.deps.db.$raw
      .prepare(
        `SELECT mint, name, symbol, description, created_on_chain_at, market_cap_usd, volume_24h_usd, holders, graduated
           FROM competitor_tokens WHERE created_on_chain_at >= ? ORDER BY created_on_chain_at DESC LIMIT 400`,
      )
      .all(this.now() - 7 * 86_400_000) as Array<Record<string, unknown>>;

    for (const row of cached) {
      const key = String(row.mint ?? `${row.name}:${row.symbol}`);
      if (collected.has(key)) continue;
      collected.set(key, {
        mint: (row.mint as string) ?? undefined,
        name: String(row.name ?? ''),
        symbol: String(row.symbol ?? ''),
        description: (row.description as string) ?? undefined,
        createdAtMs: Number(row.created_on_chain_at ?? this.now()),
        marketCapUsd: row.market_cap_usd !== null ? Number(row.market_cap_usd) : undefined,
        volume24hUsd: row.volume_24h_usd !== null ? Number(row.volume_24h_usd) : undefined,
        holders: row.holders !== null ? Number(row.holders) : undefined,
        graduated: Boolean(row.graduated),
      });
    }

    return [...collected.values()];
  }

  /**
   * Current economic assumptions.
   *
   * The AMM creator rate is market-cap dependent, so the blended figure used
   * for expected value reflects where a newly graduated token would actually
   * sit on the fee curve rather than a single constant.
   */
  private economics(solPriceUsd: number | null): EconomicAssumptions {
    const config = this.deps.settings.get();
    // A token that graduates typically sits in the low thousands of SOL of
    // market cap for the period when most of its volume occurs.
    const ammBps = estimateAmmCreatorFeeBps(1_500);
    return {
      ...DEFAULT_ECONOMICS,
      creatorFeeRateAmm: ammBps / 10_000,
      launchCostSol: 0.006 + config.execution.devBuySol,
      solPriceUsd: solPriceUsd ?? 0,
    };
  }

  private recordGateChecks(conceptId: string, decision: ReturnType<QualityGateService['evaluate']>): void {
    const existing = this.deps.db.$raw.prepare('SELECT reasoning_summary FROM concepts WHERE id = ?').get(conceptId) as
      | { reasoning_summary: string | null }
      | undefined;
    const merged = [existing?.reasoning_summary ?? '', decision.summary].filter(Boolean).join(' ');
    this.deps.db.$raw
      .prepare('UPDATE concepts SET reasoning_summary = ?, saturation_detail = COALESCE(saturation_detail, ?), updated_at = ? WHERE id = ?')
      .run(merged.slice(0, 4000), JSON.stringify({ gateChecks: decision.checks }), this.now(), conceptId);
    // The full check list lives in its own column so the UI can render the gate
    // as a table without re-parsing prose.
    this.deps.db.$raw
      .prepare('UPDATE concepts SET originality_detail = json_patch(COALESCE(originality_detail, ' + "'{}'" + '), ?) WHERE id = ?')
      .run(JSON.stringify({ gateChecks: decision.checks, gatePassed: decision.passed }), conceptId);
  }

  private countLaunches(): number {
    const row = this.deps.db.$raw.prepare(`SELECT COUNT(*) AS n FROM launches WHERE status = 'confirmed'`).get() as {
      n: number;
    };
    return row?.n ?? 0;
  }
}
