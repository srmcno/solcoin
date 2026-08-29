import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { lamportsToSol } from '@solcoin/shared';
import { AppError } from '../../core/errors.js';
import { parseJson } from '../../core/json.js';
import { requirePermission } from '../server.js';
import type { AppContainer } from '../../container.js';

export default async function tokenRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  app.get('/api/tokens', async (request) => {
    requirePermission(request, 'view');
    const query = z
      .object({
        lifecycle: z.string().optional(),
        network: z.string().optional(),
        limit: z.coerce.number().min(1).max(200).default(50),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(request.query);

    const tokens = await container.monitoring.listTokens(query);
    const counts = container.db.$raw
      .prepare('SELECT lifecycle, COUNT(*) AS n FROM tokens GROUP BY lifecycle')
      .all() as Array<{ lifecycle: string; n: number }>;

    return {
      tokens: tokens.map(shapeToken),
      lifecycleCounts: Object.fromEntries(counts.map((c) => [c.lifecycle, c.n])),
      monitoringTiers: await container.monitoring.tierSummary(),
    };
  });

  app.get('/api/tokens/:mint', async (request) => {
    requirePermission(request, 'view');
    const { mint } = z.object({ mint: z.string() }).parse(request.params);

    const token = await container.monitoring.getToken(mint);
    if (!token) throw new AppError('not_found', 'No such token.');

    const since = Date.now() - 30 * 86_400_000;
    const [observations, holders, feeEvents, launch, prediction] = await Promise.all([
      container.monitoring.getObservations(mint, since, 800),
      Promise.resolve(
        container.db.$raw
          .prepare('SELECT * FROM holder_snapshots WHERE token_mint = ? ORDER BY observed_at ASC LIMIT 500')
          .all(mint),
      ),
      Promise.resolve(
        container.db.$raw
          .prepare('SELECT * FROM creator_fee_events WHERE token_mint = ? ORDER BY observed_at DESC LIMIT 200')
          .all(mint),
      ),
      token.launch_id ? container.launches.getById(String(token.launch_id)) : Promise.resolve(null),
      token.concept_id ? container.predictions.getPrediction(String(token.concept_id)) : Promise.resolve(null),
    ]);

    const concept = token.concept_id ? await container.concepts.getById(String(token.concept_id)) : null;
    const trend = token.trend_id ? await container.trends.getById(String(token.trend_id)) : null;

    // The comparison a reviewer actually wants: what did we predict, and what
    // happened? Presented side by side with the error, not buried in two tabs.
    const comparison = prediction
      ? {
          predicted: {
            pFirstBuy: Number(prediction.p_first_buy ?? 0),
            pTenHolders: Number(prediction.p_ten_holders ?? 0),
            pHundredHolders: Number(prediction.p_hundred_holders ?? 0),
            pGraduation: Number(prediction.p_graduation ?? 0),
            volume24hSol: Number(prediction.expected_volume_24h_sol ?? 0),
            creatorFeesSol: Number(prediction.expected_creator_fees_sol ?? 0),
            lifespanHours: Number(prediction.expected_lifespan_hours ?? 0),
            modelVersion: String(prediction.model_version ?? ''),
          },
          actual: {
            gotFirstBuy: token.first_trade_at !== null,
            holders: Number(token.holders ?? 0),
            peakHolders: Number(token.peak_holders ?? 0),
            graduated: token.graduated_at !== null,
            volume24hSol: Number(token.volume_24h_sol ?? 0),
            peakVolume24hSol: Number(token.peak_volume_24h_sol ?? 0),
            creatorFeesSol: lamportsToSol(
              Number(token.creator_fees_collected_lamports ?? 0) + Number(token.creator_fees_accrued_lamports ?? 0),
            ),
            lifespanHours:
              token.first_trade_at && token.last_trade_at
                ? (Number(token.last_trade_at) - Number(token.first_trade_at)) / 3_600_000
                : null,
          },
        }
      : null;

    return {
      token: shapeToken(token),
      observations,
      holders,
      feeEvents,
      launch,
      concept: concept
        ? {
            id: concept.id,
            name: concept.name,
            symbol: concept.symbol,
            description: concept.description,
            narrative: concept.narrative,
            archetype: concept.archetype,
            reasoningSummary: concept.reasoning_summary,
            riskFlags: parseJson(concept.risk_flags as string | null, []),
            isExploration: Boolean(concept.is_exploration),
            explorationArm: concept.exploration_arm,
          }
        : null,
      trend,
      comparison,
    };
  });

  app.post('/api/tokens/:mint/refresh', async (request) => {
    requirePermission(request, 'view');
    const { mint } = z.object({ mint: z.string() }).parse(request.params);
    const result = await container.refreshToken(mint);
    return result;
  });
}

function shapeToken(row: Record<string, unknown>): Record<string, unknown> {
  const accrued = Number(row.creator_fees_accrued_lamports ?? 0);
  const collected = Number(row.creator_fees_collected_lamports ?? 0);
  return {
    mint: row.mint,
    launchId: row.launch_id,
    conceptId: row.concept_id,
    trendId: row.trend_id,
    network: row.network,
    name: row.name,
    symbol: row.symbol,
    imageUri: row.image_uri,
    metadataUri: row.metadata_uri,
    creatorAddress: row.creator_address,
    lifecycle: row.lifecycle,
    poolAddress: row.pool_address,
    createdOnChainAt: row.created_on_chain_at !== null ? Number(row.created_on_chain_at) : null,
    firstTradeAt: row.first_trade_at !== null ? Number(row.first_trade_at) : null,
    lastTradeAt: row.last_trade_at !== null ? Number(row.last_trade_at) : null,
    graduatedAt: row.graduated_at !== null ? Number(row.graduated_at) : null,
    dormantAt: row.dormant_at !== null ? Number(row.dormant_at) : null,
    holders: Number(row.holders ?? 0),
    peakHolders: Number(row.peak_holders ?? 0),
    marketCapUsd: Number(row.market_cap_usd ?? 0),
    peakMarketCapUsd: Number(row.peak_market_cap_usd ?? 0),
    liquidityUsd: Number(row.liquidity_usd ?? 0),
    volume1hSol: Number(row.volume_1h_sol ?? 0),
    volume24hSol: Number(row.volume_24h_sol ?? 0),
    peakVolume24hSol: Number(row.peak_volume_24h_sol ?? 0),
    volumeTotalSol: Number(row.volume_total_sol ?? 0),
    txCount: Number(row.tx_count ?? 0),
    holderGini: Number(row.holder_gini ?? 0),
    creatorFeesAccruedSol: lamportsToSol(accrued),
    creatorFeesCollectedSol: lamportsToSol(collected),
    creatorFeesTotalSol: lamportsToSol(accrued + collected),
    monitorTier: row.monitor_tier,
    nextPollAt: row.next_poll_at !== null ? Number(row.next_poll_at) : null,
    dataSource: row.data_source,
    createdAt: Number(row.created_at ?? 0),
  };
}
