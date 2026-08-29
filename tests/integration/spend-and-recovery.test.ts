import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createHarness, type TestHarness } from '../helpers.js';
import { LaunchService } from '../../packages/server/src/services/launch.service.js';
import { SimulationLaunchAdapter } from '../../packages/server/src/providers/solana/simulation-adapter.js';
import type { LaunchAdapter } from '../../packages/server/src/providers/solana/launch-adapter.js';
import { PumpFunLaunchAdapter } from '../../packages/server/src/providers/solana/pumpfun-adapter.js';
import type { SolanaRpc } from '../../packages/server/src/providers/solana/rpc.js';

/**
 * Three ways a launch could quietly go wrong, all found by review.
 */

let harness: TestHarness;
const signer = Keypair.fromSeed(new Uint8Array(32).fill(3));
const withSigner = async <T>(fn: (kp: Keypair) => Promise<T>): Promise<T> => fn(signer);

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => harness.cleanup());

function seedConcept(id: string): void {
  harness.db.$raw
    .prepare(
      `INSERT INTO concepts (id, name, symbol, description, status, metadata_uri, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(id, 'Concept', 'CPT', 'A concept used in tests', 'approved', 'https://example.invalid/m.json', harness.clock.now(), harness.clock.now());
}

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

describe('adapter network binding', () => {
  /**
   * The pump.fun program lives at the same addresses on devnet and mainnet, so
   * it is tempting for the adapter to declare both. Its RPC connection is
   * fixed at construction, though, and settings can change underneath it. An
   * adapter that claims a network it cannot reach is how a launch an operator
   * believes is going to devnet gets broadcast to mainnet and spends real SOL.
   */
  const rpc = { connection: {} } as unknown as SolanaRpc;

  it('claims only the network it was built for', () => {
    const mainnet = new PumpFunLaunchAdapter({
      rpc,
      network: 'mainnet',
      mintDerivationSecret: 'a-secret-long-enough-for-the-check',
      now: () => harness.clock.now(),
    });
    expect(mainnet.networks).toEqual(['mainnet']);
    expect(mainnet.networks).not.toContain('devnet');
  });

  it('is refused for the other network rather than silently used', () => {
    const mainnetAdapter = new PumpFunLaunchAdapter({
      rpc,
      network: 'mainnet',
      mintDerivationSecret: 'a-secret-long-enough-for-the-check',
      now: () => harness.clock.now(),
    });
    const launches = new LaunchService(
      harness.db,
      harness.settings,
      harness.guard,
      harness.audit,
      harness.events,
      new Map<string, LaunchAdapter>([['pumpfun_sdk', mainnetAdapter]]),
      () => harness.clock.now(),
    );

    // Reaching into the private selector is deliberate: this is the exact
    // decision the defect turned on, and there is no public path to it that
    // does not require a live chain.
    const pick = (launches as unknown as { adapterFor: (n: string) => LaunchAdapter }).adapterFor.bind(launches);
    expect(() => pick('devnet')).toThrow(/No launch adapter is available/);
    expect(pick('mainnet')).toBe(mainnetAdapter);
  });
});

describe('a confirmed launch carries its prediction', () => {
  it('records the prediction id so the outcome can become a training sample', async () => {
    seedConcept('cpt_p');
    harness.db.$raw
      .prepare(
        `INSERT INTO predictions (id, concept_id, model_version, features, p_first_buy, p_ten_holders,
                                  p_hundred_holders, p_graduation, expected_creator_fees_sol, expected_value_sol,
                                  probability_profitable, tail_concentration, confidence, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('prd_1', 'cpt_p', 'v1-priors', '{}', 0.4, 0.2, 0.05, 0.01, 0.02, -0.001, 0.3, 0.5, 0.3, harness.clock.now());

    const outcome = await service().launch(
      {
        conceptId: 'cpt_p',
        predictionId: 'prd_1',
        name: 'Concept',
        symbol: 'CPT',
        description: 'A concept used in tests',
        metadataUri: 'https://example.invalid/m.json',
        approvalMode: 'manual',
      },
      withSigner,
    );
    expect(outcome.status).toBe('confirmed');

    const row = harness.db.$raw.prepare('SELECT prediction_id FROM launches WHERE id = ?').get(outcome.launchId) as {
      prediction_id: string | null;
    };
    // Null here means `recordOutcomes` skips the launch forever and the model
    // never sees a single real result.
    expect(row.prediction_id).toBe('prd_1');
  });
});

describe('recovering a launch nobody was watching', () => {
  it('marks it confirmed so the caller can finish the work', async () => {
    seedConcept('cpt_r');
    const launches = service();

    harness.db.$raw
      .prepare(
        `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status, mint_address,
                               transaction_signature, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('lch_r', 'cpt_r', 'idem_r', 'simulation', 'simulation', 'submitted', 'Mint1111', 'Sig1111', harness.clock.now(), harness.clock.now());

    const result = await launches.resolveUnconfirmed('lch_r', async () => 'confirmed');
    expect(result).toBe('confirmed');

    const row = harness.db.$raw.prepare('SELECT status, confirmed_at FROM launches WHERE id = ?').get('lch_r') as {
      status: string;
      confirmed_at: number | null;
    };
    expect(row.status).toBe('confirmed');
    expect(row.confirmed_at).not.toBeNull();
    // The token registration and expense are the caller's to do, because they
    // need the concept and the wallet. `container.finaliseConfirmedLaunch` is
    // what the recovery job calls, and it is exercised end to end there.
  });

  it('fails a launch that never got as far as a mint address', async () => {
    seedConcept('cpt_r2');
    harness.db.$raw
      .prepare(
        `INSERT INTO launches (id, concept_id, idempotency_key, network, adapter, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('lch_r2', 'cpt_r2', 'idem_r2', 'simulation', 'simulation', 'preparing', harness.clock.now(), harness.clock.now());

    expect(await service().resolveUnconfirmed('lch_r2', async () => 'confirmed')).toBe('failed');
  });
});
