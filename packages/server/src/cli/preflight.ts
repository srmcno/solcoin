import { loadEnv } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { safeErrorText } from '../core/errors.js';
import { createContainer } from '../container.js';
import { closeDatabase } from '../db/client.js';
import { SECRET_KEYS } from '../security/secrets.js';
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

    if (!secrets.has(SECRET_KEYS.heliusApiKey) && !secrets.has(SECRET_KEYS.rpcUrlMainnet)) {
      block(
        'Mainnet RPC',
        'Only the public Solana endpoint is available. It is rate-limited hard enough that launches and fee claims fail intermittently, and a launch that fails after broadcasting still costs you.',
      );
    } else {
      pass('Mainnet RPC', 'a dedicated endpoint is configured');
    }

    if (!secrets.has(SECRET_KEYS.pinataJwt)) {
      advise(
        'Metadata storage',
        'No Pinata JWT. Metadata falls back to the Pump.fun IPFS endpoint, which works but leaves you dependent on one provider being up at launch time.',
      );
    } else {
      pass('Metadata storage', 'Pinata configured');
    }

    const notifiers = [
      SECRET_KEYS.discordWebhook,
      SECRET_KEYS.slackWebhook,
      SECRET_KEYS.telegramBotToken,
      SECRET_KEYS.genericWebhook,
      SECRET_KEYS.smtpUrl,
    ].filter((k) => secrets.has(k));
    if (notifiers.length === 0) {
      block(
        'Notifications',
        'No channel configured. This platform can engage its own emergency stop; with nowhere to send that, you would find out by opening the dashboard.',
      );
    } else {
      pass('Notifications', `${notifiers.length} channel${notifiers.length === 1 ? '' : 's'} configured`);
    }

    /* --- the money itself ---------------------------------------------- */

    const floorLamports = settings.limits.walletBalanceFloorSol * 1e9;
    if (!wallet.address) {
      // Already blocked above; nothing further to say about a wallet that is absent.
    } else if (wallet.balanceCheckedAt === null) {
      block(
        'Wallet balance',
        'Never fetched. Switch to the target network and let one refresh run, so the balance floor is enforced against a real number rather than a default of zero.',
      );
    } else if (wallet.balanceLamports <= floorLamports) {
      block(
        'Wallet balance',
        `${lamportsToSol(wallet.balanceLamports).toFixed(4)} SOL is at or below the ${settings.limits.walletBalanceFloorSol} SOL floor, so every launch will be refused.`,
      );
    } else {
      const usable = lamportsToSol(wallet.balanceLamports) - settings.limits.walletBalanceFloorSol;
      pass(
        'Wallet balance',
        `${lamportsToSol(wallet.balanceLamports).toFixed(4)} SOL, ${usable.toFixed(4)} above the floor`,
      );
    }

    /* --- the settings that decide how much can go wrong ---------------- */

    if (settings.emergencyStop) {
      block('Emergency stop', `Engaged: ${settings.emergencyStopReason || 'no reason recorded'}. Nothing will run until it is released.`);
    } else {
      pass('Emergency stop', 'not engaged');
    }

    const dailyCeiling = settings.limits.maxSolSpendPerDay;
    const perLaunch = settings.execution.devBuySol + 0.006;
    advise(
      'Daily exposure',
      `At most ${dailyCeiling} SOL/day and ${settings.limits.maxLaunchesPerDay} launches/day. One launch costs roughly ${perLaunch.toFixed(4)} SOL, so a bad day costs about ${Math.min(dailyCeiling, settings.limits.maxLaunchesPerDay * perLaunch).toFixed(3)} SOL. Decide whether you are willing to lose that every day before proceeding.`,
    );

    if (settings.autonomy.launch === 'auto' && settings.execution.phase !== 'phase5_adaptive_autonomous') {
      advise('Autonomy', 'Launching is autonomous. Nobody will see a candidate before it becomes a real token.');
    }

    /* --- the honest one ------------------------------------------------ */

    const bundle = container.predictions.getBundle() as { trainedOnSamples?: number } | null;
    const samples = Number(bundle?.trainedOnSamples ?? 0);
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
