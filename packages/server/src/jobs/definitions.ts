import { TIME, lamportsToSol, solToLamports } from '@solcoin/shared';
import { safeErrorText } from '../core/errors.js';
import { componentLogger } from '../core/logger.js';
import type { AppContainer } from '../container.js';
import type { JobDefinition } from './scheduler.js';

/**
 * The recurring work.
 *
 * Every job is idempotent, bounded and observable. Idempotent because the
 * scheduler may run one twice after a crash; bounded because an unbounded job
 * will eventually exhaust a rate limit or a budget; observable because a
 * platform whose autonomous behaviour cannot be inspected is not one anybody
 * should point at a funded wallet.
 *
 * Jobs marked `hasSideEffects` are suspended by the emergency stop. Read-only
 * jobs keep running so the dashboard stays accurate while the platform is
 * paused — a paused system that also stops reporting is much harder to debug.
 */
export function buildJobs(container: AppContainer): JobDefinition[] {
  const log = componentLogger('jobs');

  return [
    {
      name: 'trend-discovery',
      description: 'Polls every enabled trend source and folds new signals into the trend graph.',
      intervalSeconds: container.settings.get().research.discoveryIntervalMinutes * 60,
      hasSideEffects: true,
      timeoutSeconds: 300,
      run: async ({ signal, progress }) => {
        const result = await container.research.discover({
          providers: container.trendProviders,
          marketProviders: container.marketProviders,
          signal,
        });
        progress(result.signals);
        return { itemsProcessed: result.signals, result };
      },
    },

    {
      name: 'market-scan',
      description: 'Samples the launch market for saturation analysis and regime features.',
      intervalSeconds: 900,
      hasSideEffects: true,
      timeoutSeconds: 180,
      run: async () => {
        let cached = 0;
        let regime: { launchesPerHour: number; graduationRate: number; sampleSize: number } | null = null;

        for (const provider of container.marketProviders) {
          const withRegime = provider as unknown as {
            getMarketRegime?: () => Promise<{ launchesPerHour: number; graduationRate: number; sampleSize: number }>;
          };
          if (typeof withRegime.getMarketRegime === 'function') {
            regime = await withRegime.getMarketRegime().catch(() => null);
            if (regime) break;
          }
        }

        // The recent-launch stream doubles as the competitor corpus that
        // saturation scoring runs against, so it is cached rather than
        // re-fetched per candidate.
        for (const provider of container.marketProviders) {
          if (typeof provider.recentLaunches !== 'function') continue;
          const launches = await provider.recentLaunches({ limit: 200 }).catch(() => []);
          const insert = container.db.$raw.prepare(
            `INSERT INTO competitor_tokens (id, mint, name, symbol, description, created_on_chain_at,
                                            market_cap_usd, volume_24h_usd, liquidity_usd, holders, graduated,
                                            source, observed_at, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(mint) DO UPDATE SET market_cap_usd = excluded.market_cap_usd,
                                             volume_24h_usd = excluded.volume_24h_usd,
                                             holders = excluded.holders,
                                             graduated = excluded.graduated,
                                             observed_at = excluded.observed_at`,
          );
          container.db.$raw.transaction(() => {
            for (const token of launches) {
              if (!token.mint) continue;
              insert.run(
                `cmp_${token.mint.slice(0, 24)}`,
                token.mint,
                token.name ?? '',
                token.symbol ?? '',
                null,
                token.createdAtMs ?? container.clock.now(),
                token.marketCapUsd ?? null,
                token.volume24hSol ?? null,
                token.liquidityUsd ?? null,
                token.holders ?? null,
                token.graduated ? 1 : 0,
                token.source,
                token.observedAt || container.clock.now(),
                container.clock.now(),
              );
              cached++;
            }
          })();
          if (cached > 0) break;
        }

        if (regime) {
          const solPrice = await firstSolPrice(container);
          container.research.recordMarketSnapshot({
            launchesPerHour: regime.launchesPerHour,
            graduationRate: regime.graduationRate,
            solPriceUsd: solPrice ?? undefined,
            source: 'market-scan',
          });
        }

        // Competitor rows older than a month no longer compete for attention
        // and only slow the saturation query down.
        container.db.$raw
          .prepare('DELETE FROM competitor_tokens WHERE created_on_chain_at < ?')
          .run(container.clock.now() - 30 * TIME.day);

        return { itemsProcessed: cached, result: { cached, regime } };
      },
    },

    {
      name: 'candidate-pipeline',
      description: 'Turns qualifying opportunities into evaluated, gated launch candidates.',
      intervalSeconds: 1800,
      hasSideEffects: true,
      timeoutSeconds: 900,
      enabledWhen: (settings) => settings.get().autonomy.concept_generation !== 'off',
      run: async ({ signal, progress }) => {
        const result = await container.pipeline.run({ signal });
        progress(result.conceptsGenerated);
        return { itemsProcessed: result.conceptsGenerated, result };
      },
    },

    {
      name: 'launch-queue',
      description: 'Launches approved candidates when autonomy and limits permit.',
      intervalSeconds: 120,
      hasSideEffects: true,
      timeoutSeconds: 300,
      run: async ({ progress }) => {
        const settings = container.settings.get();
        // Approval-mode candidates wait for a human. This job only picks up what
        // is already approved, so it is safe at any autonomy level.
        const approved = container.db.$raw
          .prepare(
            `SELECT id, name, symbol FROM concepts
              WHERE status = 'approved' AND metadata_uri IS NOT NULL
              ORDER BY approved_at ASC, created_at ASC LIMIT 5`,
          )
          .all() as Array<{ id: string; name: string; symbol: string }>;

        if (approved.length === 0) return { itemsProcessed: 0 };

        // The guard is checked once up front so a blocked state does not produce
        // one failure log per queued candidate.
        const permitted = await container.guard.checkLaunch();
        if (!permitted.allowed) {
          return { itemsProcessed: 0, result: { skipped: approved.length, reason: permitted.reason } };
        }

        let launched = 0;
        const outcomes: Array<Record<string, unknown>> = [];
        for (const candidate of approved) {
          const outcome = await container.launchApproved(candidate.id, {}).catch((e: unknown) => ({
            status: 'failed' as const,
            error: safeErrorText(e, 300),
            launchId: '',
            network: settings.execution.network,
            simulated: settings.execution.network === 'simulation',
          }));
          outcomes.push({ concept: candidate.symbol, status: outcome.status, error: outcome.error });
          if (outcome.status === 'confirmed') launched++;
          progress(launched);
          // One launch per tick: the per-hour limit is the real control, and
          // launching a batch back-to-back gives the market no chance to
          // differentiate them.
          break;
        }
        return { itemsProcessed: launched, result: { outcomes } };
      },
    },

    {
      name: 'launch-recovery',
      description: 'Resolves launches that were broadcast but never confirmed.',
      intervalSeconds: 180,
      hasSideEffects: false,
      timeoutSeconds: 120,
      run: async () => {
        const unresolved = await container.launches.listUnresolved();
        if (unresolved.length === 0) return { itemsProcessed: 0 };

        let resolved = 0;
        for (const row of unresolved) {
          const ageMs = container.clock.now() - Number(row.created_at ?? 0);
          // Give an in-flight launch a couple of minutes before intervening.
          if (ageMs < 2 * TIME.minute) continue;

          const outcome = await container.launches.resolveUnconfirmed(String(row.id), async (mint, signature) => {
            if (String(row.network) === 'simulation') return 'confirmed';
            if (!container.rpc) return 'unknown';
            // The mint account existing is the definitive answer: the token
            // either exists on chain or it does not.
            const account = await container.rpc.getAccountInfo(mint).catch(() => null);
            if (account) return 'confirmed';
            if (signature) {
              const status = await container.rpc.getSignatureStatus(signature).catch(() => null);
              if (status?.err) return 'expired';
            }
            return ageMs > 10 * TIME.minute ? 'expired' : 'unknown';
          });
          if (outcome !== 'pending') resolved++;
        }
        return { itemsProcessed: resolved };
      },
    },

    {
      name: 'token-monitor',
      description: 'Polls launched tokens for market activity at their monitoring tier.',
      intervalSeconds: 60,
      hasSideEffects: false,
      timeoutSeconds: 240,
      run: async ({ progress }) => {
        const due = container.monitoring.dueForPoll(60);
        if (due.length === 0) return { itemsProcessed: 0 };

        const network = container.settings.get().execution.network;
        if (network === 'simulation') {
          // Simulated tokens have no market data provider; their state comes
          // from the simulation adapter's own outcome model.
          const adapter = container.adapters.get('simulation');
          const simulated = adapter as unknown as {
            getSimulatedMarket?: (mint: string) => {
              exists: boolean;
              volume24hSol: number;
              volume1hSol: number;
              holders: number;
              marketCapUsd: number;
              graduated: boolean;
            };
          };
          let updated = 0;
          for (const token of due) {
            const market = simulated.getSimulatedMarket?.(token.mint);
            if (!market?.exists) continue;
            container.monitoring.applyObservation(token.mint, {
              mint: token.mint,
              volume24hSol: market.volume24hSol,
              volume1hSol: market.volume1hSol,
              holders: market.holders,
              marketCapUsd: market.marketCapUsd,
              graduated: market.graduated,
              txCount24h: Math.round(market.volume24hSol * 4),
              source: 'simulation',
              observedAt: container.clock.now(),
            });
            updated++;
          }
          progress(updated);
          return { itemsProcessed: updated };
        }

        const solPrice = await firstSolPrice(container);
        const result = await container.monitoring.pollBatch(
          due.map((d) => d.mint),
          container.marketProviders,
          { solPriceUsd: solPrice ?? undefined },
        );
        progress(result.updated);
        return { itemsProcessed: result.updated, result };
      },
    },

    {
      name: 'token-lifecycle',
      description: 'Marks quiet tokens dormant so monitoring effort follows attention.',
      intervalSeconds: 3600,
      hasSideEffects: false,
      run: async () => ({ itemsProcessed: container.monitoring.markDormant() }),
    },

    {
      name: 'fee-detect',
      description: 'Reads the on-chain creator-fee vaults and records accrual snapshots.',
      intervalSeconds: 600,
      hasSideEffects: false,
      timeoutSeconds: 120,
      run: async () => {
        const network = container.settings.get().execution.network;
        const adapter = container.adapters.get(network === 'simulation' ? 'simulation' : 'pumpfun_sdk');
        if (!adapter) return { itemsProcessed: 0, result: { skipped: 'no adapter' } };

        const creator =
          network === 'simulation'
            ? (await container.keystore.getPublicKey()) ?? simulatedCreator(container)
            : await container.keystore.getPublicKey();
        if (!creator) return { itemsProcessed: 0, result: { skipped: 'no wallet configured' } };

        if (network === 'simulation') {
          // Accrue simulated fees from simulated volume so the collection
          // economics are exercised honestly rather than skipped.
          const sim = container.adapters.get('simulation') as unknown as {
            accrueFees?: (mint: string, creator: string, curveRate: number, ammRate: number) => void;
          };
          const tokens = container.db.$raw
            .prepare(`SELECT mint FROM tokens WHERE network = 'simulation' AND lifecycle NOT IN ('failed')`)
            .all() as Array<{ mint: string }>;
          for (const token of tokens) sim.accrueFees?.(token.mint, creator, 0.003, 0.006);
        }

        const solPrice = await firstSolPrice(container);
        const snapshot = await container.fees.snapshotAccruals(adapter, creator, solPrice ?? undefined);
        return {
          itemsProcessed: 1,
          result: {
            claimableSol: lamportsToSol(snapshot.totalClaimableLamports),
            deltaSol: lamportsToSol(snapshot.deltaLamports),
          },
        };
      },
    },

    {
      name: 'fee-collect',
      description: 'Claims accrued creator fees when doing so is economically sensible.',
      intervalSeconds: 3600,
      hasSideEffects: true,
      timeoutSeconds: 180,
      enabledWhen: (settings) => settings.get().autonomy.fee_collection === 'auto',
      run: async () => {
        const creator = await container.keystore.getPublicKey();
        if (!creator) return { itemsProcessed: 0, result: { skipped: 'no wallet configured' } };

        const network = container.settings.get().execution.network;
        const adapter = container.adapters.get(network === 'simulation' ? 'simulation' : 'pumpfun_sdk');
        if (!adapter) return { itemsProcessed: 0 };

        const snapshot = await container.fees.snapshotAccruals(adapter, creator);
        const decision = container.fees.decideCollection(snapshot, container.fees.collectionTiming(creator));
        if (!decision.shouldCollect) {
          return { itemsProcessed: 0, result: { skipped: decision.reason } };
        }

        const result = await container.collectFeesNow({ actorType: 'job' });
        return { itemsProcessed: result.collected ? 1 : 0, result };
      },
    },

    {
      name: 'wallet-reconcile',
      description: 'Refreshes wallet balances and sweeps surplus revenue to the treasury.',
      intervalSeconds: 600,
      hasSideEffects: false,
      timeoutSeconds: 120,
      run: async () => {
        const balances = await container.wallet.refreshBalances();
        const settings = container.settings.get();

        if (settings.wallet.autoSweepEnabled && settings.autonomy.wallet_transfer === 'auto') {
          const evaluation = await container.wallet.evaluateSweep();
          if (evaluation.shouldSweep && evaluation.destination) {
            await container.wallet
              .transfer({
                destination: evaluation.destination,
                lamports: evaluation.amountLamports,
                purpose: 'treasury_sweep',
                actorType: 'job',
              })
              .catch((e: unknown) => log.warn({ err: safeErrorText(e, 200) }, 'automatic treasury sweep failed'));
          }
        }

        return { itemsProcessed: 1, result: { operating: balances.operating, treasury: balances.treasury } };
      },
    },

    {
      name: 'learning-outcomes',
      description: 'Measures realised outcomes against stored predictions.',
      intervalSeconds: 3600,
      hasSideEffects: false,
      timeoutSeconds: 300,
      run: async () => {
        let recorded = 0;
        // Three horizons: the first tells you whether anyone showed up, the
        // last tells you what it was worth.
        for (const horizonHours of [24, 72, 168]) {
          const result = await container.learning.recordOutcomes({ horizonHours });
          recorded += result.recorded;
        }
        return { itemsProcessed: recorded };
      },
    },

    {
      name: 'model-train',
      description: 'Folds new outcomes into the success model, if they improve it.',
      intervalSeconds: 21_600,
      hasSideEffects: false,
      timeoutSeconds: 600,
      run: async () => {
        const result = (await container.learning.train({})) as { trained?: boolean; samples?: number };
        return { itemsProcessed: result.samples ?? 0, result };
      },
    },

    {
      name: 'analytics-rollup',
      description: 'Recomputes daily metric rollups so analytics queries stay fast.',
      intervalSeconds: 3600,
      hasSideEffects: false,
      timeoutSeconds: 180,
      run: async () => {
        const network = container.settings.get().execution.network;
        const day = new Date(container.clock.now()).toISOString().slice(0, 10);
        const dayStart = Date.parse(`${day}T00:00:00.000Z`);
        const dayEnd = dayStart + TIME.day;

        const scalar = (sql: string, ...params: unknown[]): number => {
          const row = container.db.$raw.prepare(sql).get(...params) as { v: number } | undefined;
          return row?.v ?? 0;
        };

        container.db.$raw
          .prepare(
            `INSERT INTO daily_metrics (day, network, launches, launch_failures, concepts_generated, concepts_rejected,
                                        trends_discovered, creator_fees_collected_lamports, organic_volume_sol,
                                        spend_lamports, ai_spend_usd, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(day, network) DO UPDATE SET
               launches = excluded.launches, launch_failures = excluded.launch_failures,
               concepts_generated = excluded.concepts_generated, concepts_rejected = excluded.concepts_rejected,
               trends_discovered = excluded.trends_discovered,
               creator_fees_collected_lamports = excluded.creator_fees_collected_lamports,
               organic_volume_sol = excluded.organic_volume_sol, spend_lamports = excluded.spend_lamports,
               ai_spend_usd = excluded.ai_spend_usd, updated_at = excluded.updated_at`,
          )
          .run(
            day,
            network,
            scalar(`SELECT COUNT(*) AS v FROM launches WHERE network=? AND status='confirmed' AND created_at>=? AND created_at<?`, network, dayStart, dayEnd),
            scalar(`SELECT COUNT(*) AS v FROM launches WHERE network=? AND status='failed' AND created_at>=? AND created_at<?`, network, dayStart, dayEnd),
            scalar(`SELECT COUNT(*) AS v FROM concepts WHERE created_at>=? AND created_at<?`, dayStart, dayEnd),
            scalar(`SELECT COUNT(*) AS v FROM concepts WHERE status='rejected' AND updated_at>=? AND updated_at<?`, dayStart, dayEnd),
            scalar(`SELECT COUNT(*) AS v FROM trends WHERE created_at>=? AND created_at<?`, dayStart, dayEnd),
            scalar(`SELECT COALESCE(SUM(lamports),0) AS v FROM creator_fee_events WHERE kind='collection' AND observed_at>=? AND observed_at<?`, dayStart, dayEnd),
            scalar(`SELECT COALESCE(SUM(volume_24h_sol),0) AS v FROM tokens WHERE network=? AND updated_at>=? AND updated_at<?`, network, dayStart, dayEnd),
            scalar(`SELECT COALESCE(SUM(total_cost_lamports),0) AS v FROM launches WHERE network=? AND created_at>=? AND created_at<?`, network, dayStart, dayEnd),
            scalar(`SELECT COALESCE(SUM(cost_usd),0) AS v FROM ai_requests WHERE created_at>=? AND created_at<?`, dayStart, dayEnd),
            container.clock.now(),
          );

        return { itemsProcessed: 1 };
      },
    },

    {
      name: 'health-check',
      description: 'Probes every configured provider and records its state.',
      intervalSeconds: 300,
      hasSideEffects: false,
      timeoutSeconds: 60,
      run: async () => {
        const health = (await container.health.checkAll()) as { components?: unknown[] };
        return { itemsProcessed: health.components?.length ?? 0 };
      },
    },

    {
      name: 'notification-retry',
      description: 'Retries notification deliveries that failed.',
      intervalSeconds: 600,
      hasSideEffects: true,
      run: async () => {
        const result = await container.notifications.retryFailedDeliveries();
        return { itemsProcessed: result.retried };
      },
    },

    {
      name: 'maintenance',
      description: 'Prunes stale data, expires candidates and checkpoints the database.',
      intervalSeconds: 3600,
      hasSideEffects: false,
      timeoutSeconds: 300,
      run: async () => {
        const expired = container.concepts.expireStale();
        const pruned = await container.trends.prune({});
        const sessions = container.auth.pruneSessions();

        container.db.$raw.prepare('DELETE FROM ai_cache WHERE expires_at < ?').run(container.clock.now());
        container.db.$raw.prepare('DELETE FROM idempotency_keys WHERE expires_at < ?').run(container.clock.now());
        // Keep the operational log bounded; the audit log is never pruned.
        container.db.$raw
          .prepare('DELETE FROM system_events WHERE created_at < ?')
          .run(container.clock.now() - 30 * TIME.day);
        container.db.$raw
          .prepare('DELETE FROM job_runs WHERE created_at < ?')
          .run(container.clock.now() - 14 * TIME.day);
        // Market observations are the largest table by far; thin the history of
        // dormant tokens rather than keeping every poll forever.
        container.db.$raw
          .prepare(
            `DELETE FROM market_observations
              WHERE observed_at < ?
                AND token_mint IN (SELECT mint FROM tokens WHERE lifecycle IN ('dormant','failed'))`,
          )
          .run(container.clock.now() - 30 * TIME.day);

        container.db.$raw.pragma('incremental_vacuum(200)');
        container.db.$raw.pragma('wal_checkpoint(PASSIVE)');

        return {
          itemsProcessed: expired + pruned.archived + sessions,
          result: { expiredConcepts: expired, ...pruned, prunedSessions: sessions },
        };
      },
    },
  ];
}

async function firstSolPrice(container: AppContainer): Promise<number | null> {
  for (const provider of container.marketProviders) {
    const priced = provider as unknown as { getSolPriceUsd?: () => Promise<number | null> };
    if (typeof priced.getSolPriceUsd !== 'function') continue;
    const value = await priced.getSolPriceUsd().catch(() => null);
    if (typeof value === 'number' && value > 0) return value;
  }
  return null;
}

/** Deterministic stand-in creator address for simulation runs with no wallet. */
function simulatedCreator(container: AppContainer): string {
  void container;
  return 'SimuLatedCreator11111111111111111111111111';
}
