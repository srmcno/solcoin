import { loadEnv } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { safeErrorText } from '../core/errors.js';
import { createContainer } from '../container.js';
import { closeDatabase } from '../db/client.js';

/**
 * `npm run doctor` — a pre-flight check.
 *
 * Answers the one question an operator has before pointing this at a funded
 * wallet: is everything it needs actually working, and what is missing? It
 * reports honestly, including saying "not configured" where that is the truth,
 * and exits non-zero only on a genuine fault rather than on an optional feature
 * being switched off.
 */

const ESC = String.fromCharCode(27);
/** Colour is suppressed when the output is piped, so logs stay clean. */
const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string): string => (colour ? `${ESC}[${code}m` : '');
const GREEN = sgr('32');
const YELLOW = sgr('33');
const RED = sgr('31');
const DIM = sgr('2');
const BOLD = sgr('1');
const RESET = sgr('0');

type Level = 'ok' | 'warn' | 'fail' | 'info';

const lines: string[] = [];
let failures = 0;
let warnings = 0;

function report(level: Level, label: string, detail: string): void {
  const marker =
    level === 'ok'
      ? `${GREEN}ok  ${RESET}`
      : level === 'warn'
        ? `${YELLOW}warn${RESET}`
        : level === 'fail'
          ? `${RED}FAIL${RESET}`
          : `${DIM}    ${RESET}`;
  if (level === 'fail') failures++;
  if (level === 'warn') warnings++;
  lines.push(`  ${marker}  ${label.padEnd(24)} ${DIM}${detail}${RESET}`);
}

function section(title: string): void {
  lines.push('', `${BOLD}${title}${RESET}`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  createLogger({ level: 'error', pretty: false });

  lines.push('', `${BOLD}Solcoin diagnostics${RESET}`);

  section('Environment');
  const major = Number(process.version.slice(1).split('.')[0]);
  report(major >= 20 ? 'ok' : 'fail', 'Node.js', `${process.version}${major >= 20 ? '' : ' (20 or newer required)'}`);
  report('info', 'Mode', env.NODE_ENV);
  report('info', 'Database', env.DATABASE_PATH);

  if (!env.SOLCOIN_MASTER_KEY) {
    report(
      'warn',
      'Secret store',
      'SOLCOIN_MASTER_KEY is not set. The platform runs locked: no credential can be stored or read, and no launch can be signed.',
    );
  } else if (env.SOLCOIN_MASTER_KEY.length < 24) {
    report('warn', 'Secret store', `Master key is only ${env.SOLCOIN_MASTER_KEY.length} characters; 32 or more is advisable.`);
  } else {
    report('ok', 'Secret store', 'Master key present.');
  }

  let container: Awaited<ReturnType<typeof createContainer>> | null = null;
  try {
    container = await createContainer({ env });
  } catch (e) {
    report('fail', 'Startup', safeErrorText(e, 300));
    finish();
    return;
  }

  section('Database');
  try {
    const pageInfo = container.db.$raw
      .prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()')
      .get() as { bytes: number };
    const journal = container.db.$raw.pragma('journal_mode', { simple: true });
    report('ok', 'Connection', `${(pageInfo.bytes / 1_048_576).toFixed(1)} MiB, journal mode ${String(journal)}`);
    const chain = container.audit.verifyChain({ limit: 20_000 });
    report(
      chain.valid ? 'ok' : 'fail',
      'Audit chain',
      chain.valid ? `${chain.checked} entries verified` : `broken at sequence ${chain.brokenAtSequence}: ${chain.detail}`,
    );
  } catch (e) {
    report('fail', 'Database', safeErrorText(e, 200));
  }

  section('Accounts and configuration');
  const userCount = container.auth.userCount();
  report(
    userCount > 0 ? 'ok' : 'warn',
    'Accounts',
    userCount > 0 ? `${userCount} configured` : 'none yet. Open the dashboard to create the first owner account.',
  );
  const settings = container.settings.get();
  report('info', 'Operating phase', settings.execution.phase);
  report(
    settings.execution.network === 'mainnet' ? 'warn' : 'info',
    'Network',
    settings.execution.network === 'mainnet' ? 'MAINNET. Launches spend real funds.' : settings.execution.network,
  );
  report('info', 'Launch autonomy', settings.autonomy.launch);
  if (settings.emergencyStop) {
    report('warn', 'Emergency stop', `engaged: ${settings.emergencyStopReason || 'no reason recorded'}`);
  } else {
    report('ok', 'Emergency stop', 'not engaged');
  }

  section('Wallet');
  const wallet = await container.wallet.summary();
  if (!wallet.address) {
    report('warn', 'Operating wallet', 'not configured. Create or import one before launching.');
  } else {
    report('ok', 'Operating wallet', `${wallet.address} (${wallet.custody})`);
    report(
      wallet.belowFloor ? 'warn' : 'ok',
      'Balance',
      `${wallet.balanceSol.toFixed(4)} SOL${wallet.belowFloor ? `, below the ${wallet.floorSol} SOL reserve` : ''}`,
    );
    report(
      wallet.canSign ? 'ok' : 'warn',
      'Signing',
      wallet.canSign ? 'this process can sign' : 'this process cannot sign for this wallet',
    );
  }
  report(
    wallet.treasuryAddress ? 'ok' : 'warn',
    'Treasury',
    wallet.treasuryAddress ?? 'not set. Revenue will accumulate in the hot wallet.',
  );

  section('Providers');
  const health = (await container.health.checkAll()) as {
    components?: Array<{ label: string; state: string; detail: string; setupHint?: string; essential?: boolean }>;
  };
  for (const component of health.components ?? []) {
    // A provider being down is a warning, not a failure: the platform is built
    // to degrade around any one of them, and exiting non-zero because a single
    // third-party API is having a bad day would make this check useless in CI.
    // Only an essential component being down is a genuine fault.
    const essential = (component as { essential?: boolean }).essential === true;
    const level: Level =
      component.state === 'ok'
        ? 'ok'
        : component.state === 'unconfigured'
          ? 'info'
          : component.state === 'unknown'
            ? 'info'
            : component.state === 'degraded'
              ? 'warn'
              : essential
                ? 'fail'
                : 'warn';
    report(level, component.label, component.state === 'unconfigured' ? (component.setupHint ?? 'not configured') : component.detail);
  }

  section('Execution');
  for (const [id, adapter] of container.adapters) {
    const readiness = await adapter.ready();
    report(readiness.ready ? 'ok' : 'warn', `Adapter: ${id}`, readiness.ready ? 'ready' : (readiness.reason ?? 'not ready'));
  }
  if (container.rpc) {
    for (const endpoint of await container.rpc.health()) {
      report(
        endpoint.state === 'ok' ? 'ok' : endpoint.state === 'degraded' ? 'warn' : 'fail',
        endpoint.label,
        `${endpoint.detail} (${endpoint.latencyMs}ms)`,
      );
    }
  } else {
    report('info', 'Solana RPC', 'not required in simulation mode');
  }

  section('Model');
  const bundle = container.predictions.getBundle();
  report(
    bundle.trainedOn > 0 ? 'ok' : 'info',
    'Success model',
    bundle.trainedOn > 0
      ? `${bundle.version}, trained on ${bundle.trainedOn} outcomes`
      : `${bundle.version}. No real outcomes yet, so predictions are informed priors rather than measurements.`,
  );

  closeDatabase(container.db);
  finish();
}

function finish(): void {
  lines.push('');
  if (failures > 0) {
    lines.push(
      `${RED}${failures} problem${failures === 1 ? '' : 's'} found${RESET}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`,
    );
  } else if (warnings > 0) {
    lines.push(`${YELLOW}No faults. ${warnings} thing${warnings === 1 ? '' : 's'} to look at.${RESET}`);
  } else {
    lines.push(`${GREEN}Everything checks out.${RESET}`);
  }
  lines.push('');
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Diagnostics failed to run:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
