import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createHarness, type TestHarness } from '../helpers.js';
import { LaunchService } from '../../packages/server/src/services/launch.service.js';
import { SimulationLaunchAdapter } from '../../packages/server/src/providers/solana/simulation-adapter.js';
import type { LaunchAdapter } from '../../packages/server/src/providers/solana/launch-adapter.js';
import { WalletService } from '../../packages/server/src/services/wallet.service.js';

/**
 * States the platform could get into and never get out of.
 *
 * Each of these is a safety mechanism that worked exactly once: it engaged
 * correctly, and then there was no way back. A guard with no release is not a
 * guard, it is a trap — and the operator's only remaining option is to edit the
 * database by hand.
 */

let harness: TestHarness;
const signer = Keypair.fromSeed(new Uint8Array(32).fill(5));
const withSigner = async <T>(fn: (kp: Keypair) => Promise<T>): Promise<T> => fn(signer);

beforeEach(() => {
  harness = createHarness();
});
afterEach(() => harness.cleanup());

function service(): LaunchService {
  return new LaunchService(
    harness.db,
    harness.settings,
    harness.guard,
    harness.audit,
    harness.events,
    new Map<string, LaunchAdapter>([['simulation', new SimulationLaunchAdapter({ now: () => harness.clock.now() })]]),
    () => harness.clock.now(),
  );
}

function seedFailedLaunch(id: string, conceptId: string): void {
  harness.db.$raw
    .prepare(
      `INSERT INTO concepts (id, name, symbol, description, status, metadata_uri, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(conceptId, 'Concept', 'CPT', 'test', 'failed', 'https://example.invalid/m.json', harness.clock.now(), harness.clock.now());
  harness.db.$raw
    .prepare(
      `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status, last_error, error_code, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      conceptId,
      LaunchService.idempotencyKey(conceptId, 'simulation'),
      'simulation',
      'simulation',
      'failed',
      'RPC unavailable',
      'provider_unavailable',
      harness.clock.now(),
      harness.clock.now(),
    );
}

describe('the consecutive-failure breaker', () => {
  it('engages after the configured number of failures', () => {
    harness.settings.update({ limits: { consecutiveFailureShutdown: 3 } }, { type: 'system' });
    for (let i = 0; i < 3; i++) seedFailedLaunch(`lch_f${i}`, `cpt_f${i}`);

    const decision = harness.guard.checkLaunch();
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('consecutive_failures');
  });

  it('names the operation that releases it, rather than a mechanism that does not exist', () => {
    harness.settings.update({ limits: { consecutiveFailureShutdown: 2 } }, { type: 'system' });
    seedFailedLaunch('lch_m0', 'cpt_m0');
    seedFailedLaunch('lch_m1', 'cpt_m1');
    expect(harness.guard.checkLaunch().reason).toContain('/api/system/clear-launch-failures');
  });

  it('can be released, which is the whole point', () => {
    harness.settings.update({ limits: { consecutiveFailureShutdown: 3 } }, { type: 'system' });
    for (let i = 0; i < 3; i++) seedFailedLaunch(`lch_r${i}`, `cpt_r${i}`);
    expect(harness.guard.checkLaunch().allowed).toBe(false);

    const cleared = harness.guard.clearLaunchFailures({ actorId: 'usr_1', actorLabel: 'Operator' }, 'RPC provider replaced');
    expect(cleared).toBe(3);

    // Without a release the breaker is permanent: every launch is refused
    // before it can produce the success that would reset the count.
    expect(harness.guard.checkLaunch().allowed).toBe(true);
    expect(harness.guard.consecutiveLaunchFailures()).toBe(0);
  });

  it('keeps the failures in the record rather than deleting them', () => {
    harness.settings.update({ limits: { consecutiveFailureShutdown: 3 } }, { type: 'system' });
    for (let i = 0; i < 3; i++) seedFailedLaunch(`lch_k${i}`, `cpt_k${i}`);
    harness.guard.clearLaunchFailures({ actorId: 'usr_1' }, 'acknowledged');

    const rows = harness.db.$raw.prepare('SELECT status FROM launches').all() as Array<{ status: string }>;
    expect(rows).toHaveLength(3);
    // Reclassified, not erased: the failure analytics count both.
    expect(rows.every((r) => r.status === 'abandoned')).toBe(true);
    expect(harness.audit.verifyChain().valid).toBe(true);
  });
});

describe('retrying a failed launch', () => {
  it('is refused while the failed attempt still holds the idempotency key', async () => {
    seedFailedLaunch('lch_x', 'cpt_x');
    const outcome = await service().launch(
      {
        conceptId: 'cpt_x',
        name: 'Concept',
        symbol: 'CPT',
        description: 'test',
        metadataUri: 'https://example.invalid/m.json',
        approvalMode: 'manual',
      },
      withSigner,
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('previous launch attempt');
  });

  it('succeeds once the failed attempt is retired', async () => {
    seedFailedLaunch('lch_y', 'cpt_y');
    const launches = service();

    expect(launches.retireFailed('cpt_y', 'simulation')).toBe(1);

    const outcome = await launches.launch(
      {
        conceptId: 'cpt_y',
        name: 'Concept',
        symbol: 'CPT',
        description: 'test',
        metadataUri: 'https://example.invalid/m.json',
        approvalMode: 'manual',
      },
      withSigner,
    );
    // The dashboard offers a retry on a failed candidate; this is what makes
    // pressing it do something.
    expect(outcome.status).toBe('confirmed');
    expect(outcome.mintAddress).toBeTruthy();
  });

  it('keeps the retired attempt, so the history still shows the failure', () => {
    seedFailedLaunch('lch_z', 'cpt_z');
    service().retireFailed('cpt_z', 'simulation');
    const row = harness.db.$raw.prepare('SELECT status, idempotency_key FROM launches WHERE id = ?').get('lch_z') as {
      status: string;
      idempotency_key: string;
    };
    expect(row.status).toBe('abandoned');
    expect(row.idempotency_key).toBe('retired:lch_z');
  });

  it('does nothing to a launch that is still in flight', () => {
    harness.db.$raw
      .prepare(
        `INSERT INTO concepts (id, name, symbol, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run('cpt_live', 'C', 'C', 't', 'launching', harness.clock.now(), harness.clock.now());
    harness.db.$raw
      .prepare(
        `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('lch_live', 'cpt_live', LaunchService.idempotencyKey('cpt_live', 'simulation'), 'simulation', 'simulation', 'submitted', harness.clock.now(), harness.clock.now());

    // Retiring a submitted launch would let a second token be minted for a
    // transaction that may still land.
    expect(service().retireFailed('cpt_live', 'simulation')).toBe(0);
  });
});

describe('outgoing transactions left pending', () => {
  /**
   * A wallet transaction row is written before the transaction is sent and
   * updated after. A process that dies in between strands one: it shows on the
   * wallet page as an outgoing transfer that is neither confirmed nor failed,
   * forever, because nothing else ever looked at it.
   */
  const HOUR = 3_600_000;

  function seedPending(id: string, purpose: string, signature: string | null, ageMs: number): void {
    harness.db.$raw
      .prepare(
        `INSERT INTO wallet_transactions (id, wallet_address, network, direction, purpose, lamports, fee_lamports,
                                          counterparty, status, signature, occurred_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, 'Wallet1111', 'devnet', 'out', purpose, 100_000, 5_000, 'Dest1111', 'pending', signature, harness.clock.now() - ageMs, harness.clock.now() - ageMs);
  }

  function statusOf(id: string): { status: string; fee_lamports: number } {
    return harness.db.$raw.prepare('SELECT status, fee_lamports FROM wallet_transactions WHERE id = ?').get(id) as {
      status: string;
      fee_lamports: number;
    };
  }

  /** A wallet with no RPC: the case a fresh or simulated install is in. */
  function walletService() {
    return new WalletService(
      harness.db,
      harness.settings,
      { getPublicKey: async () => null, getRecord: async () => null } as never,
      harness.guard,
      harness.audit,
      harness.events,
      null,
      () => harness.clock.now(),
    );
  }

  it('voids a fee-claim reservation whose claim never reported', async () => {
    seedPending('wtx_res', 'fee_claim', null, 2 * HOUR);
    const result = await walletService().reconcilePending();

    expect(result.voided).toBe(1);
    const row = statusOf('wtx_res');
    expect(row.status).toBe('failed');
    // The allowance it was holding is released with it.
    expect(row.fee_lamports).toBe(0);
  });

  it('leaves a transfer whose outcome is genuinely unknown alone', async () => {
    // No signature means the send never reported back — but it may still have
    // been broadcast in the instant before the process died. Marking it either
    // way would be a guess presented as a fact.
    seedPending('wtx_unknown', 'manual_transfer', null, 2 * HOUR);
    const result = await walletService().reconcilePending();

    expect(result.unknown).toBe(1);
    expect(statusOf('wtx_unknown').status).toBe('pending');
  });

  it('does not touch a transaction that is merely recent', async () => {
    seedPending('wtx_recent', 'fee_claim', null, 60_000);
    const result = await walletService().reconcilePending();
    expect(result).toEqual({ confirmed: 0, failed: 0, voided: 0, unknown: 0 });
    expect(statusOf('wtx_recent').status).toBe('pending');
  });

  it('resolves a signed transaction against the chain', async () => {
    seedPending('wtx_landed', 'manual_transfer', 'Sig-landed', 2 * HOUR);
    seedPending('wtx_reverted', 'manual_transfer', 'Sig-reverted', 2 * HOUR);

    const rpc = {
      getSignatureStatus: async (signature: string) =>
        signature === 'Sig-landed' ? { err: null } : { err: { InstructionError: [0, 'Custom'] } },
    };
    const wallet = new WalletService(
      harness.db,
      harness.settings,
      { getPublicKey: async () => null, getRecord: async () => null } as never,
      harness.guard,
      harness.audit,
      harness.events,
      rpc as never,
      () => harness.clock.now(),
    );

    const result = await wallet.reconcilePending();
    expect(result.confirmed).toBe(1);
    expect(result.failed).toBe(1);
    expect(statusOf('wtx_landed').status).toBe('confirmed');
    expect(statusOf('wtx_reverted').status).toBe('failed');
  });
});

describe('candidates stranded mid-launch', () => {
  const MINUTE = 60_000;

  function seedLaunching(id: string, ageMs: number, withLaunchRow: boolean): void {
    const at = harness.clock.now();
    harness.db.$raw
      .prepare(
        `INSERT INTO concepts (id, name, symbol, description, status, metadata_uri, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, 'Concept', 'CPT', 'test', 'launching', 'https://example.invalid/m.json', at - ageMs, at - ageMs);
    if (withLaunchRow) {
      harness.db.$raw
        .prepare(
          `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(`lch_${id}`, id, LaunchService.idempotencyKey(id, 'simulation'), 'simulation', 'simulation', 'submitted', at - ageMs, at - ageMs);
    }
  }

  function statusOf(id: string): string {
    return (harness.db.$raw.prepare('SELECT status FROM concepts WHERE id = ?').get(id) as { status: string }).status;
  }

  it('restores one whose launch row was never written', () => {
    // The process died between marking the concept `launching` and claiming
    // the launch. Nothing looks at that state: the queue selects `approved`,
    // the recovery job scans `launches`, and the expiry sweep skips
    // `launching` so it cannot expire something mid-flight.
    seedLaunching('cpt_stranded', 30 * MINUTE, false);
    expect(service().restoreStrandedCandidates()).toBe(1);
    expect(statusOf('cpt_stranded')).toBe('approved');
  });

  it('leaves one whose launch was actually claimed', () => {
    // A claimed attempt decides its own outcome. Restoring a concept whose
    // transaction may still land is how a second token gets minted.
    seedLaunching('cpt_claimed', 30 * MINUTE, true);
    expect(service().restoreStrandedCandidates()).toBe(0);
    expect(statusOf('cpt_claimed')).toBe('launching');
  });

  it('leaves a launch that has only just started', () => {
    seedLaunching('cpt_inflight', 30_000, false);
    expect(service().restoreStrandedCandidates()).toBe(0);
    expect(statusOf('cpt_inflight')).toBe('launching');
  });
});

describe('a broadcast transaction is never called failed', () => {
  /**
   * The dangerous asymmetry: "the confirmation failed" and "the transaction
   * failed" are not the same claim, and only the chain can tell them apart.
   * Recording the second when only the first is known loses the transaction —
   * and, because a retry retires a failed launch's idempotency key, invites a
   * second token for one that was already on its way.
   */
  it('leaves a signed launch submitted when confirmation throws', async () => {
    seedFailedLaunch('lch_sig', 'cpt_sig');
    // Reshape the seeded row into the real situation: broadcast, signature
    // recorded by `onSigned`, then the confirmation poll died.
    harness.db.$raw
      .prepare(`UPDATE launches SET status = 'failed', transaction_signature = 'Sig-broadcast' WHERE id = ?`)
      .run('lch_sig');

    // Neither retirement path may free it: doing so would let a second token
    // be minted for a transaction that may still land.
    expect(service().retireFailed('cpt_sig', 'simulation')).toBe(0);
    expect(harness.guard.clearLaunchFailures({ actorId: 'usr_1' }, 'acknowledged')).toBe(0);

    const row = harness.db.$raw.prepare('SELECT status, idempotency_key FROM launches WHERE id = ?').get('lch_sig') as {
      status: string;
      idempotency_key: string;
    };
    expect(row.status).toBe('failed');
    expect(row.idempotency_key).not.toMatch(/^retired:/);
  });

  it('still frees an attempt that never reached the chain', () => {
    seedFailedLaunch('lch_nosig', 'cpt_nosig');
    // No signature: nothing was broadcast, so there is nothing to duplicate.
    expect(service().retireFailed('cpt_nosig', 'simulation')).toBe(1);
  });
});

describe('a transfer whose confirmation fails', () => {
  const DEST = 'BqPYaPBw7DUZQ7NBLKAyDMJDaTGCPB2LMbP2ecmKfEXk';

  function walletWith(rpc: unknown) {
    // The phase ladder refuses a network the current phase does not permit, and
    // it is checked before the network — which is exactly what stops an
    // accidental mainnet launch — so the phase moves first.
    harness.settings.update({ execution: { phase: 'phase2_devnet' } }, { type: 'system' });
    harness.settings.update(
      {
        autonomy: { wallet_transfer: 'approve' },
        execution: { network: 'devnet' },
        limits: { maxSolSpendPerDay: 5, maxSolPerHour: 5, maxSolPerTransaction: 5 },
      },
      { type: 'system' },
    );
    const signer = Keypair.fromSeed(new Uint8Array(32).fill(21));
    return new WalletService(
      harness.db,
      harness.settings,
      {
        getPublicKey: async () => signer.publicKey.toBase58(),
        getRecord: async () => ({ publicKey: signer.publicKey.toBase58() }),
        withSigner: async <T>(fn: (kp: Keypair) => Promise<T>): Promise<T> => fn(signer),
      } as never,
      harness.guard,
      harness.audit,
      harness.events,
      rpc as never,
      () => harness.clock.now(),
    );
  }

  /** Broadcasts, reports the signature, then dies before confirming. */
  const broadcastThenFail = {
    getBalance: async () => 5_000_000_000,
    sendTransaction: async (
      _ix: unknown,
      _payer: unknown,
      options: { onSigned?: (i: { signature: string; blockhash: string; lastValidBlockHeight: number }) => void },
    ) => {
      await options.onSigned?.({ signature: 'Sig-in-flight', blockhash: 'bh', lastValidBlockHeight: 1 });
      throw new Error('status poll failed after the transaction was broadcast');
    },
  };

  it('stays pending with its signature rather than being called failed', async () => {
    const wallet = walletWith(broadcastThenFail);
    await expect(
      wallet.transfer({ destination: DEST, lamports: 1_000_000, purpose: 'manual_transfer', actorId: 'usr_1' }),
    ).rejects.toThrow(/not yet known/i);

    const row = harness.db.$raw
      .prepare(`SELECT status, signature FROM wallet_transactions WHERE direction = 'out' ORDER BY created_at DESC LIMIT 1`)
      .get() as { status: string; signature: string | null };

    // `failed` would put it outside the reconciler, which only looks at
    // pending rows — losing a transfer whose SOL may well have moved.
    expect(row.status).toBe('pending');
    expect(row.signature).toBe('Sig-in-flight');
  });

  it('refuses an identical transfer while the first is unresolved', async () => {
    const wallet = walletWith(broadcastThenFail);
    await expect(
      wallet.transfer({ destination: DEST, lamports: 1_000_000, purpose: 'manual_transfer', actorId: 'usr_1' }),
    ).rejects.toThrow(/not yet known/i);

    // The idempotency key is bucketed by minute, so a retry a minute later
    // would otherwise send the amount a second time.
    harness.clock.advance(5 * 60_000);
    await expect(
      wallet.transfer({ destination: DEST, lamports: 1_000_000, purpose: 'manual_transfer', actorId: 'usr_1' }),
    ).rejects.toThrow(/still unresolved/i);

    const count = harness.db.$raw
      .prepare(`SELECT COUNT(*) AS n FROM wallet_transactions WHERE direction = 'out'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('still marks a transfer failed when nothing was ever broadcast', async () => {
    const wallet = walletWith({
      getBalance: async () => 5_000_000_000,
      sendTransaction: async () => {
        throw new Error('the RPC refused the transaction outright');
      },
    });

    await expect(
      wallet.transfer({ destination: DEST, lamports: 1_000_000, purpose: 'manual_transfer', actorId: 'usr_1' }),
    ).rejects.toThrow(/refused the transaction/i);

    const row = harness.db.$raw
      .prepare(`SELECT status, signature FROM wallet_transactions WHERE direction = 'out' ORDER BY created_at DESC LIMIT 1`)
      .get() as { status: string; signature: string | null };
    // No signature means nothing went out, so there is nothing to reconcile.
    expect(row.status).toBe('failed');
    expect(row.signature).toBeNull();
  });
});
