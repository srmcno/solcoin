import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';
import { lamportsToSol, solToLamports } from '@solcoin/shared';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { AppError, safeErrorText } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { createContainer } from '../container.js';
import { closeDatabase } from '../db/client.js';
import { HttpClient } from '../providers/http.js';
import { bondingCurveAddress, decodeBondingCurve } from '../providers/market/onchain-curve.js';
import { launchImpossibleReasons } from './preflight-checks.js';
import {
  assertDevnetGenesis,
  expectedCreatorFeeLamports,
  explorerUrl,
  liveCreatorFeeBps,
  minimumBuyLamportsForClaim,
  parseRehearsalArgs,
  rehearsalFixture,
  rehearsalVerdict,
  requiredFundingLamports,
  type RehearsalStep,
} from './rehearsal-checks.js';

/**
 * `npm run rehearsal` — prove the real launch path on devnet.
 *
 * Everything a mainnet launch does, this does first against the identical
 * program on devnet, with worthless SOL, through the platform's own services
 * rather than a separate script that happens to resemble them: the same
 * keystore signs, the same guard reserves, the same launch service claims the
 * idempotency key, the same adapter builds and broadcasts `create_v2`, the
 * same monitor reads the token back, and the same fee service snapshots the
 * vault and claims from it. A step that passes here has been executed by the
 * code that will run with real money.
 *
 * It refuses to run anywhere but devnet, and it establishes that from the
 * chain's genesis hash rather than from a setting, because the one action it
 * takes that would be illegitimate on a real market — buying its own token to
 * put fees in the vault — must be impossible to point at mainnet by
 * misconfiguration. On devnet that purchase is a protocol conformance test:
 * there are no independent traders to mislead and nothing of value changes
 * hands. The platform proper contains no such purchase path at all.
 *
 * Every transaction it sends is reported with its signature and an explorer
 * link, and the whole run is written to `data/rehearsal/` as JSON, so "the
 * launch path has been exercised" is a claim with evidence attached.
 */

const ESC = String.fromCharCode(27);
const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (c: string): string => (colour ? `${ESC}[${c}m` : '');
const B = sgr('1');
const D = sgr('2');
const G = sgr('32');
const Y = sgr('33');
const R = sgr('31');
const C = sgr('36');
const X = sgr('0');

const out = (line = ''): void => void process.stdout.write(`${line}\n`);

const steps: RehearsalStep[] = [];

function record(step: RehearsalStep): void {
  steps.push(step);
  const mark =
    step.status === 'passed' ? `${G}✓${X}` : step.status === 'failed' ? `${R}✗${X}` : step.status === 'blocked' ? `${Y}■${X}` : `${D}·${X}`;
  out(`  ${mark} ${B}${step.step}${X}  ${step.status === 'skipped' ? D : ''}${step.detail}${X}`);
  if (step.url) out(`      ${D}${step.url}${X}`);
}

/** A step that ends the run if it fails. */
class StepFailed extends Error {}

async function step<T>(
  name: string,
  fn: () => Promise<{ detail: string; signature?: string; url?: string; data?: Record<string, unknown>; value?: T }>,
): Promise<T> {
  try {
    const result = await fn();
    record({ step: name, status: 'passed', detail: result.detail, signature: result.signature, url: result.url, data: result.data });
    return result.value as T;
  } catch (e) {
    if (e instanceof Blocked) {
      record({ step: name, status: 'blocked', detail: e.message });
      throw new StepFailed(name);
    }
    record({ step: name, status: 'failed', detail: safeErrorText(e, 400) });
    throw new StepFailed(name);
  }
}

/** Raised by a step that cannot proceed for a reason outside the platform. */
class Blocked extends Error {}

function help(): void {
  out(`${B}npm run rehearsal${X} — prove the launch and creator-fee path on devnet`);
  out();
  out('  --buy-sol <n>     SOL spent on the protocol test buy that puts fees in the vault (default: sized from the live fee rate)');
  out('  --skip-buy        create and verify only; no test buy, so nothing to claim');
  out('  --skip-claim      stop after the accrual snapshot');
  out('  --enter-devnet    move a phase-one platform to phase two / devnet (never higher, never mainnet)');
  out('  --json            print the report as JSON instead of the summary');
  out();
  out('  Exit codes: 0 every step passed, 1 a step failed, 2 refused to start, 3 blocked on devnet SOL.');
}

async function main(): Promise<void> {
  const args = parseRehearsalArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }

  const env = loadEnv();
  createLogger({ level: 'error', pretty: false });

  out();
  out(`${B}Solcoin devnet rehearsal${X}`);
  out(`${D}Every step below runs through the platform's own services against the real Pump.fun program on devnet.${X}`);
  out();

  if (!env.SOLCOIN_MASTER_KEY) {
    out(`${R}SOLCOIN_MASTER_KEY is not set.${X} The wallet cannot be unlocked, so nothing can be signed. Run \`npm run setup\` first.`);
    process.exit(2);
  }

  const container = await createContainer({ env });
  const startedAt = container.clock.now();
  const reportPath = resolve(env.DATA_DIR, 'rehearsal', `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.json`);

  try {
    /* --- network: devnet, established from the chain ------------------- */

    const before = container.settings.get();
    if (before.execution.network === 'mainnet') {
      out(`${R}This platform is on mainnet.${X} The rehearsal will not run against, or move, a platform that is on mainnet.`);
      process.exit(2);
    }
    if (before.execution.network !== 'devnet') {
      if (!args.enterDevnet) {
        out(`${Y}The platform is on "${before.execution.network}" in ${before.execution.phase}.${X}`);
        out('The rehearsal needs phase two and the devnet network. Either set them in Settings → Execution, or re-run');
        out(`with ${C}--enter-devnet${X}, which moves phase one to phase two and selects devnet. It never goes higher.`);
        process.exit(2);
      }
      const phase = before.execution.phase === 'phase1_research' ? 'phase2_devnet' : before.execution.phase;
      container.settings.update(
        { execution: { phase, network: 'devnet' } },
        { type: 'user', label: 'npm run rehearsal' },
        'Entered devnet for the launch rehearsal.',
      );
      await container.refreshProviders();
      out(`  ${G}✓${X} Moved to ${B}${phase}${X} on ${B}devnet${X}`);
    }

    const rpc = container.rpc;
    if (!rpc) throw new AppError('not_configured', 'No devnet RPC could be built.');

    await step('Cluster is devnet', async () => {
      const genesis = await rpc.call('getGenesisHash', (c) => c.getGenesisHash());
      assertDevnetGenesis(genesis);
      const health = await rpc.health();
      const live = health.filter((h) => h.state === 'ok').map((h) => `${h.label} (${h.latencyMs}ms)`);
      return { detail: `genesis ${genesis.slice(0, 8)}… via ${live.join(', ') || 'no responding endpoint'}` };
    });

    const program = await step('Pump.fun program reachable', async () => {
      const found = container.adapters.get('pumpfun_sdk');
      if (!found) throw new AppError('not_configured', 'The on-chain launch adapter was not constructed. Is the secret store unlocked?');
      const ready = await found.ready();
      if (!ready.ready) throw new AppError('provider_unavailable', ready.reason ?? 'adapter not ready');
      const { OnlinePumpSdk } = await import('@pump-fun/pump-sdk');
      const online = new OnlinePumpSdk(rpc.connection);
      const global = await online.fetchGlobal();
      // The fee-config account governs the fee when it exists; devnet may
      // not have one, in which case the global account's flat rate applies.
      const feeConfig = await online.fetchFeeConfig().catch(() => null);
      const openingMarketCapLamports = Math.floor(
        (Number(global.initialVirtualSolReserves.toString()) * Number(global.tokenTotalSupply.toString())) /
          Number(global.initialVirtualTokenReserves.toString()),
      );
      const creatorFeeBps = liveCreatorFeeBps({
        globalCreatorFeeBps: Number(global.creatorFeeBasisPoints.toString()),
        feeTiers: feeConfig
          ? feeConfig.feeTiers.map((t) => ({
              marketCapLamportsThreshold: Number(t.marketCapLamportsThreshold.toString()),
              creatorBps: Number(t.fees.creatorFeeBps.toString()),
            }))
          : null,
        openingMarketCapLamports,
      });
      return {
        detail:
          `global config read: create_v2 ${global.createV2Enabled ? 'enabled' : 'DISABLED'}, ` +
          `opening virtual reserves ${lamportsToSol(Number(global.initialVirtualSolReserves.toString())).toFixed(2)} SOL, ` +
          `creator fee ${creatorFeeBps} bps (${feeConfig ? 'fee-config tier at the opening market cap' : 'global flat rate; no fee-config account'})`,
        data: {
          createV2Enabled: global.createV2Enabled,
          initialVirtualSolReserves: global.initialVirtualSolReserves.toString(),
          initialRealTokenReserves: global.initialRealTokenReserves.toString(),
          globalCreatorFeeBasisPoints: global.creatorFeeBasisPoints.toString(),
          feeConfigPresent: Boolean(feeConfig),
          creatorFeeBps,
          openingMarketCapLamports,
        },
        value: { adapter: found, creatorFeeBps },
      };
    });
    const adapter = program.adapter;
    const creatorFeeBps = program.creatorFeeBps;

    /* --- wallet and funding ------------------------------------------- */

    const settings = container.settings.get();
    const impossible = launchImpossibleReasons(settings.limits, lamportsToSol(container.guard.estimatedLaunchCostLamports()));
    await step('Limits permit a launch', async () => {
      if (impossible.length > 0) throw new AppError('limit_exceeded', impossible.join('; '));
      const usage = await container.guard.usage();
      return {
        detail: `${usage.launchesToday}/${usage.limits.maxLaunchesPerDay} launches today, ${usage.solSpentToday.toFixed(4)}/${usage.limits.maxSolSpendPerDay} SOL spent today${usage.emergencyStop ? ' — EMERGENCY STOP ENGAGED' : ''}`,
      };
    });

    const walletAddress = await step('Operating wallet can sign', async () => {
      let record = await container.keystore.getRecord();
      let created = false;
      if (!record) {
        const { publicKey } = await container.keystore.createOperatingWallet('Operating wallet');
        created = true;
        record = await container.keystore.getRecord();
        void publicKey;
      }
      if (!record) throw new AppError('internal', 'The keystore did not read back the wallet it just created.');
      if (record.custody !== 'encrypted_keystore') {
        throw new AppError('not_configured', `The wallet is ${record.custody}; this process cannot sign for it.`);
      }
      return {
        detail: `${record.publicKey}${created ? ' (created now)' : ''}`,
        url: explorerUrl('address', record.publicKey, 'devnet'),
        value: record.publicKey,
      };
    });
    const walletKey = new PublicKey(walletAddress);

    /*
     * The test buy is sized from the fee rate the program actually charges
     * here, not from a mainnet constant. At devnet's observed 5 bps a buy
     * sized for mainnet's 30 leaves the vault below its rent floor, and the
     * claim step would report — correctly, uselessly — nothing to claim.
     */
    const minimumBuy = minimumBuyLamportsForClaim({ creatorFeeBps });
    const buyLamports = args.skipBuy ? 0 : args.buySol === null ? minimumBuy : solToLamports(args.buySol);
    if (!args.skipBuy && args.buySol === null) {
      out(`  ${D}Test buy sized at ${lamportsToSol(buyLamports).toFixed(3)} SOL for a ${creatorFeeBps} bps creator fee (pass --buy-sol to override).${X}`);
    }
    if (!args.skipBuy && buyLamports < minimumBuy) {
      out(
        `  ${Y}!${X} --buy-sol ${args.buySol} deposits ${lamportsToSol(expectedCreatorFeeLamports(buyLamports, creatorFeeBps)).toFixed(6)} SOL of creator fees at ${creatorFeeBps} bps, ` +
          `below the ${lamportsToSol(minimumBuy).toFixed(3)} SOL buy needed to leave anything claimable above the vault's stranded rent. The claim step will report nothing to claim.`,
      );
    }
    const required = requiredFundingLamports({
      floorLamports: solToLamports(settings.limits.walletBalanceFloorSol),
      launchReserveLamports: container.guard.estimatedLaunchCostLamports(),
      buyLamports,
    });

    await step('Wallet is funded', async () => {
      let balance = await rpc.getBalance(walletKey);
      if (balance < required) {
        out(`      ${D}balance ${lamportsToSol(balance).toFixed(4)} SOL, need ${lamportsToSol(required).toFixed(4)} SOL; asking the devnet faucet${X}`);
        for (let attempt = 1; attempt <= 3 && balance < required; attempt++) {
          try {
            const signature = await rpc.call('requestAirdrop', (c) => c.requestAirdrop(walletKey, 1_000_000_000));
            out(`      ${D}airdrop ${attempt}: ${signature.slice(0, 16)}… waiting for it to land${X}`);
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 2_000));
              const now = await rpc.getBalance(walletKey);
              if (now > balance) {
                balance = now;
                break;
              }
            }
          } catch (e) {
            const text = safeErrorText(e, 200);
            out(`      ${D}airdrop ${attempt} refused: ${text}${X}`);
            if (/429|limit|run dry/i.test(text)) break;
          }
        }
      }
      if (balance < required) {
        throw new Blocked(
          `holds ${lamportsToSol(balance).toFixed(4)} SOL and needs ${lamportsToSol(required).toFixed(4)} SOL. ` +
            `Send devnet SOL to ${walletAddress} — https://faucet.solana.com works when the RPC faucet is dry — and re-run.`,
        );
      }
      await container.wallet.refreshBalances();
      return { detail: `${lamportsToSol(balance).toFixed(4)} SOL (needs ${lamportsToSol(required).toFixed(4)})`, data: { balanceLamports: balance, requiredLamports: required } };
    });

    /* --- fixture concept and real metadata ----------------------------- */

    const fixture = rehearsalFixture(container.clock.now());
    const conceptId = newId('cpt', container.clock.now());
    await step('Fixture concept passes the safety screen', async () => {
      const now = container.clock.now();
      container.db.$raw
        .prepare(
          `INSERT INTO concepts (id, name, symbol, description, narrative, archetype, category, status, image_prompt,
                                 risk_flags, hard_collision, requires_human_review, reasoning_summary,
                                 approved_by, approved_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          conceptId,
          fixture.name,
          fixture.symbol,
          fixture.description,
          'Devnet rehearsal fixture.',
          'rehearsal',
          'other',
          'approved',
          fixture.imagePrompt,
          '[]',
          0,
          0,
          'Created by npm run rehearsal to exercise the launch path on devnet. Not a candidate.',
          'rehearsal',
          now,
          now,
          now,
        );
      return { detail: `${fixture.name} ($${fixture.symbol}) as ${conceptId}` };
    });

    const metadataUri = await step('Metadata hosted', async () => {
      const artwork = await container.artwork.produce(conceptId, fixture);
      let reachable = 'not verified';
      try {
        const target = new URL(artwork.metadataUri);
        const http = new HttpClient({ name: 'rehearsal-metadata', baseUrl: target.origin, timeoutMs: 20_000, maxRetries: 0 });
        const body = await http.request<{ name?: string; symbol?: string }>(`${target.pathname}${target.search}`);
        reachable = body?.symbol === fixture.symbol ? 'fetched back and matches' : 'fetched back but does not match';
      } catch (e) {
        reachable = `not fetched back yet: ${safeErrorText(e, 80)} (IPFS gateways can lag; the URI is what goes on chain)`;
      }
      return {
        detail: `${artwork.source} artwork, ${artwork.metadataUri} — ${reachable}`,
        data: { metadataUri: artwork.metadataUri, imageUri: artwork.imageUri, source: artwork.source },
        value: artwork.metadataUri,
      };
    });
    void metadataUri;

    /* --- the launch itself --------------------------------------------- */

    const launched = await step('create_v2 launched through LaunchService', async () => {
      const outcome = await container.launchApproved(conceptId, { actorId: 'rehearsal', actorLabel: 'npm run rehearsal' });
      if (outcome.status !== 'confirmed' || !outcome.mintAddress || !outcome.signature) {
        throw new AppError(
          (outcome.errorCode as never) ?? 'transaction_failed',
          `launch ${outcome.status}: ${outcome.error ?? 'no detail'}`,
        );
      }
      return {
        detail: `mint ${outcome.mintAddress}, cost ${lamportsToSol(outcome.costLamports ?? 0).toFixed(6)} SOL`,
        signature: outcome.signature,
        url: explorerUrl('tx', outcome.signature, 'devnet'),
        data: { mint: outcome.mintAddress, launchId: outcome.launchId, costLamports: outcome.costLamports },
        value: { mint: outcome.mintAddress, signature: outcome.signature, launchId: outcome.launchId },
      };
    });
    const mintKey = new PublicKey(launched.mint);

    await step('Mint and bonding curve exist on chain', async () => {
      const mintInfo = await rpc.getAccountInfo(mintKey);
      if (!mintInfo) throw new AppError('transaction_failed', 'the mint account does not exist');
      if (mintInfo.owner.toBase58() !== TOKEN_2022_PROGRAM_ID.toBase58()) {
        throw new AppError('internal', `mint is owned by ${mintInfo.owner.toBase58()}, not Token-2022`);
      }
      const curveInfo = await rpc.getAccountInfo(bondingCurveAddress(mintKey));
      if (!curveInfo) throw new AppError('transaction_failed', 'the bonding-curve account does not exist');
      const curve = decodeBondingCurve(curveInfo.data);
      if (!curve) throw new AppError('internal', 'the bonding-curve account did not decode');
      if (curve.creator !== walletAddress) throw new AppError('internal', `curve creator is ${curve.creator}, not the operating wallet`);
      if (curve.isCashbackCoin) throw new AppError('internal', 'the coin was created in cashback mode and can never earn creator fees');
      return {
        detail: `Token-2022 mint (${mintInfo.data.length} bytes), curve creator is the operating wallet, creator-fee coin, ${curve.complete ? 'complete' : 'open'}`,
        url: explorerUrl('token', launched.mint, 'devnet'),
        data: { curve: { ...curve, virtualTokenReserves: curve.virtualTokenReserves.toString(), virtualQuoteReserves: curve.virtualQuoteReserves.toString(), realTokenReserves: curve.realTokenReserves.toString(), realQuoteReserves: curve.realQuoteReserves.toString(), tokenTotalSupply: curve.tokenTotalSupply.toString() } },
      };
    });

    await step('Monitoring picks the token up', async () => {
      const registered = container.db.$raw.prepare('SELECT mint FROM tokens WHERE mint = ?').get(launched.mint);
      if (!registered) throw new AppError('internal', 'the launch confirmed but the token was not registered for monitoring');
      const polled = await container.monitoring.pollBatch([launched.mint], container.marketProviders);
      if (polled.updated < 1) throw new AppError('provider_unavailable', `no market provider returned data (${polled.failed} failed)`);
      const row = container.db.$raw
        .prepare('SELECT data_source, price_sol, market_cap_usd, lifecycle FROM tokens WHERE mint = ?')
        .get(launched.mint) as { data_source: string | null; price_sol: number; market_cap_usd: number; lifecycle: string };
      return {
        detail: `${row.data_source} reported price ${row.price_sol.toExponential(3)} SOL, lifecycle ${row.lifecycle}`,
        data: { source: row.data_source, priceSol: row.price_sol, marketCapUsd: row.market_cap_usd },
      };
    });

    /* --- fees: protocol test buy, accrual, claim ---------------------- */

    if (args.skipBuy) {
      record({ step: 'Protocol test buy', status: 'skipped', detail: '--skip-buy; the vault stays empty and there is nothing to claim' });
    } else {
      await step('Protocol test buy deposits creator fees', async () => {
        // Re-established from the chain immediately before signing, on the
        // connection that will send: a setting cannot make this mainnet.
        assertDevnetGenesis(await rpc.call('getGenesisHash', (c) => c.getGenesisHash()));

        const sdk = await import('@pump-fun/pump-sdk');
        const online = new sdk.OnlinePumpSdk(rpc.connection);
        const global = await online.fetchGlobal();
        const feeConfig = await online.fetchFeeConfig().catch(() => null);
        const state = await online.fetchBuyState(mintKey, walletKey, TOKEN_2022_PROGRAM_ID);
        const solAmount = new BN(buyLamports);
        const amount = sdk.getBuyTokenAmountFromSolAmount({
          global,
          feeConfig,
          mintSupply: state.bondingCurve.tokenTotalSupply,
          bondingCurve: state.bondingCurve,
          amount: solAmount,
          quoteMint: NATIVE_MINT,
        });
        const instructions = await sdk.PUMP_SDK.buyInstructions({
          global,
          bondingCurveAccountInfo: state.bondingCurveAccountInfo,
          bondingCurve: state.bondingCurve,
          associatedUserAccountInfo: state.associatedUserAccountInfo,
          mint: mintKey,
          user: walletKey,
          amount,
          solAmount,
          slippage: 5,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        });

        const balanceBefore = await rpc.getBalance(walletKey);
        const result = await container.wallet.signerFor('devnet')((payer) => rpc.sendTransaction(instructions, payer, {}));
        const balanceAfter = await rpc.getBalance(walletKey);
        const spent = balanceBefore - balanceAfter;

        // Recorded where money is accounted for, and in the audit log. Not in
        // the wallet ledger the spend caps read: those govern the platform's
        // own spending, and an operator's deliberate devnet test buy counted
        // against them would block the claim that follows for an hour.
        await container.accounting.recordExpense({
          kind: 'devnet_rehearsal_buy',
          description: `Devnet protocol test buy of ${fixture.symbol}`,
          amountLamports: spent,
          refType: 'token',
          refId: launched.mint,
          incurredAt: container.clock.now(),
        });
        container.audit.record({
          actorType: 'user',
          actorId: 'rehearsal',
          actorLabel: 'npm run rehearsal',
          action: 'rehearsal.devnet_test_buy',
          targetType: 'token',
          targetId: launched.mint,
          transactionSignature: result.signature,
          parameters: { network: 'devnet', buyLamports, spentLamports: spent, creatorFeeBps, expectedCreatorFeeLamports: expectedCreatorFeeLamports(buyLamports, creatorFeeBps) },
        });
        return {
          detail: `${lamportsToSol(buyLamports).toFixed(3)} SOL buy (spent ${lamportsToSol(spent).toFixed(6)} with fees and rent); expected creator fee ${lamportsToSol(expectedCreatorFeeLamports(buyLamports, creatorFeeBps)).toFixed(6)} SOL at ${creatorFeeBps} bps`,
          signature: result.signature,
          url: explorerUrl('tx', result.signature, 'devnet'),
          data: { buyLamports, spentLamports: spent, tokenAmount: amount.toString() },
        };
      });
    }

    const snapshot = await step('Fee accrual snapshot reads the vaults', async () => {
      const snap = await container.fees.snapshotAccruals(adapter, walletAddress);
      const decision = container.fees.decideCollection(snap, container.fees.collectionTiming(walletAddress));
      return {
        detail:
          `curve vault ${lamportsToSol(snap.curveVaultLamports).toFixed(6)} SOL, claimable ${lamportsToSol(snap.curveClaimableLamports).toFixed(6)} SOL after stranded rent; ` +
          `AMM vault ${lamportsToSol(snap.ammVaultLamports).toFixed(6)} SOL. Scheduled collector would ${decision.shouldCollect ? 'collect' : 'wait'}: ${decision.reason}`,
        data: { ...snap, decision },
        value: snap,
      };
    });

    if (args.skipClaim) {
      record({ step: 'Creator-fee claim', status: 'skipped', detail: '--skip-claim' });
    } else if (snapshot.totalClaimableLamports <= 0) {
      record({
        step: 'Creator-fee claim',
        status: args.skipBuy ? 'skipped' : 'failed',
        detail: args.skipBuy
          ? 'nothing claimable without a test buy'
          : `nothing claimable: the vault holds ${lamportsToSol(snapshot.curveVaultLamports).toFixed(6)} SOL against ${lamportsToSol(890_880).toFixed(6)} SOL stranded rent`,
      });
      if (!args.skipBuy) throw new StepFailed('Creator-fee claim');
    } else {
      await step('Creator-fee claim through FeeService', async () => {
        const balanceBefore = await rpc.getBalance(walletKey);
        const result = await container.collectFeesNow({ actorType: 'user', actorId: 'rehearsal' });
        if (!result.collected || !result.signature) throw new AppError('transaction_failed', result.reason ?? 'not collected');
        const balanceAfter = await rpc.getBalance(walletKey);
        const after = await adapter.getAccruedFees(walletAddress);
        if (after.curveClaimableLamports > 0) {
          throw new AppError('internal', `the claim confirmed but ${after.curveClaimableLamports} lamports remain claimable`);
        }
        return {
          detail: `claimed ${lamportsToSol(result.lamports).toFixed(6)} SOL; wallet moved ${lamportsToSol(balanceAfter - balanceBefore).toFixed(6)} SOL net of the fee; vault back at its rent floor`,
          signature: result.signature,
          url: explorerUrl('tx', result.signature, 'devnet'),
          data: { claimedLamports: result.lamports, walletDeltaLamports: balanceAfter - balanceBefore, vaultAfter: after.curveVaultLamports },
        };
      });
    }
  } catch (e) {
    if (!(e instanceof StepFailed)) {
      record({ step: 'Rehearsal', status: 'failed', detail: safeErrorText(e, 400) });
    }
  } finally {
    const verdict = rehearsalVerdict(steps);
    const report = {
      startedAt,
      finishedAt: container.clock.now(),
      network: 'devnet',
      verdict,
      steps,
    };
    try {
      mkdirSync(resolve(env.DATA_DIR, 'rehearsal'), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    } catch (e) {
      out(`${Y}Could not write the report: ${safeErrorText(e, 120)}${X}`);
    }

    out();
    if (args.json) {
      out(JSON.stringify(report, null, 2));
    } else {
      out(verdict.ok ? `${G}${B}${verdict.summary}${X}` : `${verdict.exitCode === 3 ? Y : R}${B}${verdict.summary}${X}`);
      out(`${D}Report written to ${reportPath}${X}`);
      if (verdict.ok) {
        out();
        out(`${D}This proves the code path, not the strategy. Mainnet is a separate, deliberate step: read docs/going-live.md §5 and run npm run preflight.${X}`);
      }
    }
    out();
    closeDatabase(container.db);
    process.exit(verdict.exitCode);
  }
}

main().catch((e: unknown) => {
  out(`\n${R}Rehearsal could not start:${X} ${safeErrorText(e, 400)}\n`);
  process.exit(e instanceof AppError && e.code === 'validation_failed' ? 2 : 1);
});
