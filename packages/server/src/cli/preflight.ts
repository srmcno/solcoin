import { loadEnv } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { safeErrorText } from '../core/errors.js';
import { createContainer, buildRpcForNetwork } from '../container.js';
import { closeDatabase } from '../db/client.js';
import { SECRET_KEYS } from '../security/secrets.js';
import { launchImpossibleReasons } from './preflight-checks.js';
import { lamportsToSol } from '@solcoin/shared';

/**
 * `npm run preflight` — may this platform be pointed at real money yet?
 *
 * `doctor` answers "is anything broken". This answers a narrower and more
 * consequential question, and it answers it as a gate: every blocker is
 * something that will cost money or lose a launch if it is still true when the
 * first mainnet transaction goes out.
 *
 * It exits non-zero while any blocker stands, so it can sit in a deploy script
 * ahead of the switch to mainnet. It never changes a setting — moving to
 * mainnet stays a deliberate act performed by a person who has read this.
 */

const ESC = String.fromCharCode(27);
const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (c: string): string => (colour ? `${ESC}[${c}m` : '');
const B = sgr('1');
const D = sgr('2');
const G = sgr('32');
const Y = sgr('33');
const R = sgr('31');
const X = sgr('0');

interface Check {
  label: string;
  state: 'pass' | 'block' | 'advice';
  detail: string;
}

const checks: Check[] = [];
const pass = (label: string, detail: string): void => void checks.push({ label, state: 'pass', detail });
const block = (label: string, detail: string): void => void checks.push({ label, state: 'block', detail });
const advise = (label: string, detail: string): void => void checks.push({ label, state: 'advice', detail });


/**
 * Ask one endpoint, and only that endpoint, for its current slot.
 *
 * Deliberately a bare connection rather than the platform's `SolanaRpc`, whose
 * whole job is to fail over to another endpoint — which is the behaviour that
 * made this check meaningless.
 */
async function probeEndpoint(url: string): Promise<{ ok: true; slot: number } | { ok: false; reason: string }> {
  try {
    const { Connection } = await import('@solana/web3.js');
    const connection = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true });
    const slot = await Promise.race([
      connection.getSlot('confirmed'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out after 10s')), 10_000)),
    ]);
    return { ok: true, slot };
  } catch (e) {
    return { ok: false, reason: safeErrorText(e, 120) };
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  createLogger({ level: 'error', pretty: false });

  const container = await createContainer({ env });

  try {
    const settings = container.settings.get();
    const secrets = new Set((await container.secrets.list()).map((s) => s.key));
    const wallet = await container.wallet.summary();

    /* --- things that make a launch impossible ------------------------- */

    if (!env.SOLCOIN_MASTER_KEY) {
      block('Master key', 'SOLCOIN_MASTER_KEY is not set, so no credential and no wallet key can be read.');
    } else if (env.SOLCOIN_MASTER_KEY.length < 32) {
      advise('Master key', `Only ${env.SOLCOIN_MASTER_KEY.length} characters. 32 or more is meaningfully stronger.`);
    } else {
      pass('Master key', 'present');
    }

    if (!wallet.address) {
      block('Operating wallet', 'None configured. Run `npm run setup`, or create one from Settings → Wallet.');
    } else if (!wallet.canSign) {
      block('Operating wallet', `${wallet.address} is watch-only. The platform cannot sign a launch with it.`);
    } else {
      pass('Operating wallet', `${wallet.address} (${wallet.custody})`);
    }

    if (!secrets.has(SECRET_KEYS.anthropicApiKey) && !secrets.has(SECRET_KEYS.openaiApiKey)) {
      block('AI provider', 'No Anthropic or OpenAI key. Trends are still discovered, but no concept can be generated.');
    } else {
      pass('AI provider', [secrets.has(SECRET_KEYS.anthropicApiKey) && 'Anthropic', secrets.has(SECRET_KEYS.openaiApiKey) && 'OpenAI'].filter(Boolean).join(' + '));
    }

    /* --- things that make a launch unreliable rather than impossible --- */

    /*
     * Probe the dedicated endpoint itself, not the fallback chain.
     *
     * `buildRpcForNetwork` appends the public endpoints behind whatever is
     * configured, and `SolanaRpc.call` falls through to them transparently. So
     * a revoked Helius key or a dead custom URL still let every read succeed —
     * over the public endpoint — and this gate reported a dedicated RPC ready
     * on the strength of a secret merely existing. The point of the check is
     * reliability under load, which a public endpoint does not provide.
     */
    const heliusKey = await container.secrets.get(SECRET_KEYS.heliusApiKey);
    const customUrl = await container.secrets.get(SECRET_KEYS.rpcUrlMainnet);
    /*
     * Both configured endpoints are probed, and one answering is enough.
     *
     * `buildRpcForNetwork` registers the custom URL and Helius ahead of any
     * public endpoint, so if either works, launches use a dedicated endpoint
     * and the reliability this check exists to protect is intact. Probing only
     * the first and blocking on it would fail a perfectly good setup whose
     * stale custom URL is already being skipped in favour of Helius.
     */
    const dedicatedEndpoints: Array<{ label: string; url: string }> = [];
    if (customUrl) dedicatedEndpoints.push({ label: 'configured endpoint', url: customUrl });
    if (heliusKey) dedicatedEndpoints.push({ label: 'Helius', url: `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` });

    if (dedicatedEndpoints.length === 0) {
      block(
        'Mainnet RPC',
        'Only the public Solana endpoint is available. It is rate-limited hard enough that launches and fee claims fail intermittently, and a launch that fails after broadcasting still costs you.',
      );
    } else {
      const probes = await Promise.all(
        dedicatedEndpoints.map(async (e) => ({ ...e, result: await probeEndpoint(e.url) })),
      );
      const answered = probes.filter((p) => p.result.ok);
      const failed = probes.filter((p) => !p.result.ok);

      if (answered.length > 0) {
        pass('Mainnet RPC', answered.map((p) => `${p.label} answered`).join(', '));
        for (const p of failed) {
          advise('Mainnet RPC', `${p.label} did not answer: ${'reason' in p.result ? p.result.reason : 'unknown'}. Another dedicated endpoint covers it, but it is dead weight.`);
        }
      } else {
        block(
          'Mainnet RPC',
          `No configured endpoint answered (${failed.map((p) => `${p.label}: ${'reason' in p.result ? p.result.reason : 'unknown'}`).join('; ')}). Reads would silently fall through to the public endpoint, which is exactly the unreliability this check exists to catch.`,
        );
      }
    }

    if (!secrets.has(SECRET_KEYS.pinataJwt)) {
      advise(
        'Metadata storage',
        'No Pinata JWT. Metadata falls back to the Pump.fun IPFS endpoint, which works but leaves you dependent on one provider being up at launch time.',
      );
    } else {
      pass('Metadata storage', 'Pinata configured');
    }

    /*
     * Ask the notification service what it would actually dispatch on, rather
     * than looking for stored secrets.
     *
     * A stored credential is not a working channel: a Discord webhook with
     * `discordEnabled` off delivers nothing, a Telegram token without a chat
     * ID delivers nothing, and email is excluded from dispatch entirely
     * because the service does not implement it. Checking the secret store
     * passed this gate for exactly those cases — including the one the setup
     * wizard itself used to produce — and an emergency stop would then have
     * reached nothing but the in-app inbox.
     */
    const channels = await container.notifications.dispatchableChannels();
    if (channels.length === 0) {
      const stored = [SECRET_KEYS.discordWebhook, SECRET_KEYS.telegramBotToken, SECRET_KEYS.genericWebhook].filter((k) =>
        secrets.has(k),
      );
      block(
        'Notifications',
        stored.length > 0
          ? 'A webhook credential is stored but no channel is switched on, so nothing would be delivered. Enable it in Settings -> Notifications; Telegram also needs a chat ID. This platform can engage its own emergency stop, and with nowhere to send that you would find out by opening the dashboard.'
          : 'No channel would deliver anything. This platform can engage its own emergency stop, and with nowhere to send that you would find out by opening the dashboard.',
      );
    } else {
      pass('Notifications', `would dispatch on ${channels.join(', ')}`);
    }

    /* --- the money itself ---------------------------------------------- */

    /*
     * Ask mainnet about the wallet, not whichever network is selected.
     *
     * `wallet.summary()` returns the balance cached for the *current* network,
     * and this command is meant to be run before switching — which is when a
     * simulated wallet (handed a synthetic 2 SOL float so the limits are
     * exercised end to end) or a funded devnet wallet would satisfy a mainnet
     * gate while the same address holds nothing on mainnet. Preflight would
     * then have reported ready for the one case it exists to catch.
     *
     * Not being able to ask is itself a blocker. "I could not check" is not
     * "it is fine", and refusing to guess is this command's whole job.
     */
    const floorLamports = settings.limits.walletBalanceFloorSol * 1e9;
    if (wallet.address) {
      const mainnetRpc = await buildRpcForNetwork('mainnet', (key) => container.secrets.get(key)).catch(() => null);
      if (!mainnetRpc) {
        block('Wallet balance', 'No mainnet RPC could be built, so the mainnet balance cannot be verified.');
      } else {
        const onChain = await mainnetRpc.getBalance(wallet.address).catch((e: unknown) => {
          block('Wallet balance', `Mainnet RPC could not be reached: ${safeErrorText(e, 120)}`);
          return null;
        });
        if (onChain !== null) {
          /*
           * The floor is applied *after* the spend, not before it.
           * `checkSpend` subtracts one launch's reserved cost and then compares
           * the remainder against the floor, so a balance merely above the
           * floor still refuses every launch — 0.051 SOL against a 0.05 floor
           * looked fine here and could not launch anything.
           */
          const needed = floorLamports + container.guard.estimatedLaunchCostLamports();
          if (onChain < needed) {
            block(
              'Wallet balance',
              `${lamportsToSol(onChain).toFixed(4)} SOL on mainnet. One launch reserves ${lamportsToSol(container.guard.estimatedLaunchCostLamports()).toFixed(4)} SOL and the floor holds back ${settings.limits.walletBalanceFloorSol} SOL, so at least ${lamportsToSol(needed).toFixed(4)} SOL is needed before anything can launch.`,
            );
          } else {
            const usable = lamportsToSol(onChain) - settings.limits.walletBalanceFloorSol;
            pass('Wallet balance', `${lamportsToSol(onChain).toFixed(4)} SOL on mainnet, ${usable.toFixed(4)} above the floor`);
          }
        }
      }
    }

    /* --- the settings that decide how much can go wrong ---------------- */

    if (settings.emergencyStop) {
      block('Emergency stop', `Engaged: ${settings.emergencyStopReason || 'no reason recorded'}. Nothing will run until it is released.`);
    } else {
      pass('Emergency stop', 'not engaged');
    }

    /*
     * Releasing the emergency stop does not clear the failure breaker.
     * They are separate routes, and `checkLaunch` refuses every launch while
     * the consecutive-failure count is at its threshold — so an operator who
     * released the stop and stopped there had a platform that would launch
     * nothing, and a gate that said no blockers.
     */
    // Mainnet's count, not the selected network's. Preflight runs before the
    // switch, so reading the current network would miss unacknowledged mainnet
    // failures that halt launching the instant the switch happens.
    const failures = container.guard.consecutiveLaunchFailures('mainnet');
    const threshold = settings.limits.consecutiveFailureShutdown;
    if (failures >= threshold) {
      block(
        'Failure breaker',
        `${failures} consecutive launch failures on mainnet at a threshold of ${threshold}. Every launch is refused until they are acknowledged (POST /api/system/clear-launch-failures); releasing the emergency stop does not clear this.`,
      );
    } else {
      pass('Failure breaker', `${failures} consecutive failures, threshold ${threshold}`);
    }

    /*
     * A limit that refuses every launch is a blocker, not a note.
     *
     * `GuardService` reserves `devBuySol + 0.006` and tests it against the
     * per-transaction, hourly and daily SOL caps, and counts launches against
     * the hourly and daily launch caps. Any of those set below what one launch
     * needs means every mainnet launch is refused — while this command printed
     * "No blockers" and the operator went looking for the wrong problem.
     */
    const dailyCeiling = settings.limits.maxSolSpendPerDay;
    const perLaunch = container.guard.estimatedLaunchCostLamports() / 1e9;

    const impossible = launchImpossibleReasons(settings.limits, perLaunch);

    if (impossible.length > 0) {
      block('Limits', `Every launch would be refused: ${impossible.join('; ')}.`);
    } else {
      pass('Limits', `one launch reserves ${perLaunch.toFixed(4)} SOL and every cap admits it`);
      advise(
        'Daily exposure',
        `At most ${dailyCeiling} SOL/day and ${settings.limits.maxLaunchesPerDay} launches/day. One launch reserves roughly ${perLaunch.toFixed(4)} SOL, so a bad day costs about ${Math.min(dailyCeiling, settings.limits.maxLaunchesPerDay * perLaunch).toFixed(3)} SOL. Decide whether you are willing to lose that every day before proceeding.`,
      );
    }

    /*
     * Autonomy switched off refuses every launch, manual ones included.
     * `checkOperational` rejects with `autonomy_off` before any limit is even
     * consulted, so this belongs with the other settings that make launching
     * impossible rather than being absent from the report entirely.
     */
    if (settings.autonomy.launch === 'off') {
      block('Autonomy', 'settings.autonomy.launch is off, so every launch is refused before any limit is checked.');
    } else if (settings.autonomy.launch === 'auto' && settings.execution.phase !== 'phase5_adaptive_autonomous') {
      advise('Autonomy', 'Launching is autonomous. Nobody will see a candidate before it becomes a real token.');
    } else {
      pass('Autonomy', `launch autonomy is "${settings.autonomy.launch}"`);
    }

    /* --- the honest one ------------------------------------------------ */

    // `trainedOn`, which is what a bundle actually exposes and what `doctor`
    // and the backtest service both read. The previous cast invented
    // `trainedOnSamples` and, being a cast, silenced the mismatch — so every
    // operator was told the model had zero outcomes behind it however many it
    // had actually scored.
    const bundle = container.predictions.getBundle() as { trainedOn?: number } | null;
    const samples = Number(bundle?.trainedOn ?? 0);
    if (samples < 30) {
      advise(
        'Model evidence',
        `The prediction model has ${samples} real outcome${samples === 1 ? '' : 's'} behind it. Below roughly 30 its quality gate is expressing priors, not learned judgement — its scores are a considered guess.`,
      );
    } else {
      pass('Model evidence', `${samples} real outcomes scored`);
    }

    /* --- report -------------------------------------------------------- */

    const blockers = checks.filter((c) => c.state === 'block');
    const advice = checks.filter((c) => c.state === 'advice');

    process.stdout.write(`\n${B}Mainnet preflight${X}\n`);
    process.stdout.write(`${D}Current phase: ${settings.execution.phase} · network: ${settings.execution.network}${X}\n\n`);

    for (const c of checks) {
      const marker = c.state === 'pass' ? `${G}ok   ${X}` : c.state === 'block' ? `${R}BLOCK${X}` : `${Y}note ${X}`;
      process.stdout.write(`  ${marker}  ${c.label.padEnd(20)} ${D}${c.detail}${X}\n`);
    }

    process.stdout.write('\n');
    if (blockers.length > 0) {
      process.stdout.write(`  ${R}${B}Not ready for mainnet.${X} ${blockers.length} blocker${blockers.length === 1 ? '' : 's'} above.\n\n`);
      closeDatabase(container.db);
      process.exit(1);
    }

    process.stdout.write(`  ${G}${B}No blockers.${X} Everything required to launch on mainnet is configured.\n`);
    if (advice.length > 0) {
      process.stdout.write(`  ${D}${advice.length} thing${advice.length === 1 ? '' : 's'} to have decided deliberately, marked "note" above.${X}\n`);
    }
    process.stdout.write(
      `\n  ${D}This command does not change anything. Moving to mainnet is done in Settings,\n  deliberately, by a person who has read the above.${X}\n\n`,
    );
    closeDatabase(container.db);
  } catch (e) {
    closeDatabase(container.db);
    throw e;
  }
}

main().catch((e: unknown) => {
  process.stdout.write(`\n${R}Preflight could not run:${X} ${safeErrorText(e, 400)}\n\n`);
  process.exit(2);
});
