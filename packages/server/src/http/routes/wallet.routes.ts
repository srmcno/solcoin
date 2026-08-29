import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { lamportsToSol, solToLamports } from '@solcoin/shared';
import { AppError } from '../../core/errors.js';
import { AUDIT_ACTIONS } from '../../security/audit.js';
import { requirePermission } from '../server.js';
import type { AppContainer } from '../../container.js';

/**
 * Wallet routes.
 *
 * There is deliberately no endpoint that returns a private key in a normal
 * response. Export exists, requires the highest permission, demands an exact
 * confirmation phrase, and is audited — because an export is indistinguishable
 * from a theft after the fact.
 */
export default async function walletRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  app.get('/api/wallet', async (request) => {
    requirePermission(request, 'view');
    const [summary, transactions, accounts] = await Promise.all([
      container.wallet.summary(),
      container.wallet.transactions(50),
      container.wallet.accounts(),
    ]);
    const sweep = await container.wallet.evaluateSweep();
    return { summary, transactions, accounts, sweep, settings: container.settings.get().wallet };
  });

  // Refreshing balances calls the RPC. Same reasoning as the token refresh: a
  // read-only role should not be able to make the platform talk to anyone.
  app.post('/api/wallet/refresh', async (request) => {
    requirePermission(request, 'run_research');
    const balances = await container.wallet.refreshBalances();
    return {
      operatingSol: balances.operating !== null ? lamportsToSol(balances.operating) : null,
      treasurySol: balances.treasury !== null ? lamportsToSol(balances.treasury) : null,
    };
  });

  app.post('/api/wallet/create', async (request) => {
    const actor = requirePermission(request, 'edit_wallet_config');
    const { label } = z.object({ label: z.string().max(120).optional() }).parse(request.body ?? {});
    const result = await container.keystore.createOperatingWallet(label ?? 'Operating wallet');
    container.audit.record({
      actorType: 'user',
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: AUDIT_ACTIONS.walletCreated,
      targetType: 'wallet',
      targetId: result.publicKey,
      ipAddress: request.ip,
    });
    await container.wallet.refreshBalances();
    return {
      publicKey: result.publicKey,
      message:
        'Operating wallet created and encrypted. Fund it with only what near-term launches need, and set a treasury address so revenue is swept out of it.',
    };
  });

  app.post('/api/wallet/import', async (request) => {
    const actor = requirePermission(request, 'edit_wallet_config');
    const { secret, label } = z.object({ secret: z.string().min(32), label: z.string().max(120).optional() }).parse(request.body);
    const result = await container.keystore.importOperatingWallet(secret, label ?? 'Operating wallet');
    container.audit.record({
      actorType: 'user',
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: AUDIT_ACTIONS.walletImported,
      targetType: 'wallet',
      targetId: result.publicKey,
      ipAddress: request.ip,
    });
    await container.wallet.refreshBalances();
    return { publicKey: result.publicKey };
  });

  app.post('/api/wallet/watch-only', async (request) => {
    const actor = requirePermission(request, 'edit_wallet_config');
    const { address, label } = z.object({ address: z.string().min(32).max(64), label: z.string().max(120).optional() }).parse(request.body);
    await container.keystore.setWatchOnly(address, label ?? 'External wallet');
    container.audit.record({
      actorType: 'user',
      actorId: actor.id,
      action: AUDIT_ACTIONS.walletImported,
      targetType: 'wallet',
      targetId: address,
      parameters: { custody: 'watch_only' },
      ipAddress: request.ip,
    });
    return { ok: true, message: 'Watching this address. This process cannot sign for it, so launches will need an external signer.' };
  });

  app.post('/api/wallet/transfer', async (request) => {
    const actor = requirePermission(request, 'transfer_funds');
    const body = z
      .object({ destination: z.string().min(32).max(64), amountSol: z.number().positive() })
      .parse(request.body);

    const result = await container.wallet.transfer({
      destination: body.destination,
      lamports: solToLamports(body.amountSol),
      purpose: 'manual_transfer',
      actorId: actor.id,
      actorType: 'user',
      actorLabel: actor.displayName,
    });
    return { ok: true, signature: result.signature, amountSol: lamportsToSol(result.lamports) };
  });

  app.post('/api/wallet/sweep', async (request) => {
    const actor = requirePermission(request, 'transfer_funds');
    const evaluation = await container.wallet.evaluateSweep();
    if (!evaluation.shouldSweep || !evaluation.destination) {
      throw new AppError('conflict', evaluation.reason);
    }
    const result = await container.wallet.transfer({
      destination: evaluation.destination,
      lamports: evaluation.amountLamports,
      purpose: 'treasury_sweep',
      actorId: actor.id,
      actorType: 'user',
      actorLabel: actor.displayName,
    });
    return { ok: true, signature: result.signature, amountSol: lamportsToSol(result.lamports) };
  });

  /** Reveal the private key. Intentionally hard to do by accident. */
  app.post('/api/wallet/export', async (request) => {
    const actor = requirePermission(request, 'transfer_funds');
    const { confirmation } = z.object({ confirmation: z.string() }).parse(request.body);
    const secret = await container.keystore.exportSecretKey(confirmation);
    container.audit.record({
      actorType: 'user',
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: AUDIT_ACTIONS.walletExported,
      targetType: 'wallet',
      targetId: (await container.keystore.getPublicKey()) ?? '',
      result: 'ok',
      reason: 'Private key exported by an operator.',
      ipAddress: request.ip,
    });
    return {
      secretKeyBase64: secret,
      warning: 'Anyone holding this key controls the wallet. This export has been recorded in the audit log.',
    };
  });
}
