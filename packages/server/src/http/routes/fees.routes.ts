import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { lamportsToSol } from '@solcoin/shared';
import { AppError } from '../../core/errors.js';
import { requirePermission } from '../server.js';
import type { AppContainer } from '../../container.js';

export default async function feeRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  app.get('/api/fees', async (request) => {
    requirePermission(request, 'view');
    const [totals, history, wallet] = await Promise.all([
      container.fees.totals(),
      container.fees.history(100),
      container.wallet.summary(),
    ]);

    const decision = wallet.address ? await container.feeCollectionPreview(wallet.address) : null;

    return {
      totals: {
        collectedSol: lamportsToSol(totals.collectedLamports),
        collectedTodaySol: lamportsToSol(totals.collectedTodayLamports),
        collected7dSol: lamportsToSol(totals.collected7dLamports),
        collected30dSol: lamportsToSol(totals.collected30dLamports),
        outstandingSol: lamportsToSol(totals.outstandingLamports),
        // Surfaced deliberately: the vault balance and the claimable amount
        // never agree, and an operator who does not know why will think fees
        // are being lost.
        strandedRentSol: lamportsToSol(totals.strandedRentLamports),
        collectionCount: totals.collectionCount,
      },
      history,
      nextCollection: decision,
      settings: container.settings.get().fees,
      autonomy: container.settings.get().autonomy.fee_collection,
    };
  });

  app.post('/api/fees/collect', async (request) => {
    const actor = requirePermission(request, 'collect_fees');
    const result = await container.collectFeesNow({ actorId: actor.id, actorType: 'user' });
    if (!result.collected) {
      throw new AppError('conflict', result.reason ?? 'Nothing was collected.');
    }
    return { ok: true, collectedSol: lamportsToSol(result.lamports), signature: result.signature };
  });

  app.get('/api/fees/by-token', async (request) => {
    requirePermission(request, 'view');
    const rows = container.db.$raw
      .prepare(
        `SELECT mint, name, symbol, lifecycle, network,
                creator_fees_accrued_lamports, creator_fees_collected_lamports,
                volume_total_sol, created_at
           FROM tokens
          WHERE creator_fees_accrued_lamports > 0 OR creator_fees_collected_lamports > 0
          ORDER BY (creator_fees_accrued_lamports + creator_fees_collected_lamports) DESC
          LIMIT 200`,
      )
      .all() as Array<Record<string, unknown>>;

    return {
      tokens: rows.map((r) => ({
        mint: r.mint,
        name: r.name,
        symbol: r.symbol,
        lifecycle: r.lifecycle,
        network: r.network,
        accruedSol: lamportsToSol(Number(r.creator_fees_accrued_lamports ?? 0)),
        collectedSol: lamportsToSol(Number(r.creator_fees_collected_lamports ?? 0)),
        totalSol: lamportsToSol(
          Number(r.creator_fees_accrued_lamports ?? 0) + Number(r.creator_fees_collected_lamports ?? 0),
        ),
        volumeTotalSol: Number(r.volume_total_sol ?? 0),
        createdAt: Number(r.created_at ?? 0),
      })),
      note: 'Per-token amounts are an attribution estimate: creator fees accrue into two wallet-level vaults, not per token, so accrual is apportioned by each token’s share of measured organic volume. Wallet-level totals are exact.',
    };
  });
}
