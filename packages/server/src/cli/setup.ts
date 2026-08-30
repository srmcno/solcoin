import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadEnv, resetEnvCache } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { safeErrorText } from '../core/errors.js';
import { createContainer } from '../container.js';
import { openDatabase, closeDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { SECRET_KEYS } from '../security/secrets.js';

/**
 * `npm run setup` — the guided path from a fresh clone to a running platform.
 *
 * This exists because the alternative is a checklist in a document, and a
 * checklist cannot tell you that step four silently did nothing. Every step
 * here performs the work and then reads it back from the same store the server
 * will read it from, so "configured" means configured rather than typed.
 *
 * Three rules it does not break:
 *
 *  1. **It never advances the phase.** Setup finishes in phase one, research
 *     only, whatever else has been configured. Moving toward real funds is a
 *     decision an operator makes deliberately, having seen the platform work.
 *  2. **It never prints a secret.** Keys and passwords are read without echo
 *     and never written to the terminal, the logs, or the shell history.
 *  3. **It never claims something works because it was entered.** Credentials
 *     are stored and then re-read; the wallet is created and its address read
 *     back from the keystore.
 *
 * Re-running is safe. Anything already done is detected and skipped.
 */

const ESC = String.fromCharCode(27);
const colour = stdout.isTTY && !process.env.NO_COLOR;
const sgr = (c: string): string => (colour ? `${ESC}[${c}m` : '');
const B = sgr('1');
const D = sgr('2');
const G = sgr('32');
const Y = sgr('33');
const R = sgr('31');
const C = sgr('36');
const X = sgr('0');

const rl = createInterface({ input: stdin, output: stdout });

function heading(title: string): void {
  stdout.write(`\n${B}${title}${X}\n${D}${'─'.repeat(Math.min(title.length + 8, 60))}${X}\n`);
}

function say(text = ''): void {
  stdout.write(`${text}\n`);
}

function note(text: string): void {
  stdout.write(`${D}${text}${X}\n`);
}

function done(text: string): void {
  stdout.write(`  ${G}✓${X} ${text}\n`);
}

function skip(text: string): void {
  stdout.write(`  ${D}·${X} ${D}${text}${X}\n`);
}

function warn(text: string): void {
  stdout.write(`  ${Y}!${X} ${text}\n`);
}

async function ask(question: string, fallback = ''): Promise<string> {
  const suffix = fallback ? ` ${D}[${fallback}]${X}` : '';
  const answer = (await rl.question(`  ${question}${suffix}: `)).trim();
  return answer || fallback;
}

async function confirm(question: string, fallback = false): Promise<boolean> {
  const hint = fallback ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`  ${question} ${D}[${hint}]${X}: `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === 'y' || answer === 'yes';
}

/**
 * Read a line without echoing it.
 *
 * `readline` has no hidden-input mode, so the terminal is put into raw mode and
 * the keystrokes are consumed directly. Anything that goes wrong here falls
 * back to a visible prompt with an explicit warning rather than silently
 * echoing a private key while the operator believes it is hidden.
 */
async function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    warn('This terminal cannot hide input. What you type next will be visible.');
    return (await rl.question(`  ${question}: `)).trim();
  }

  stdout.write(`  ${question}: `);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolveInput) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        // Enter, or either half of a CRLF.
        if (byte === 0x0d || byte === 0x0a) {
          stdin.off('data', onData);
          stdin.setRawMode(wasRaw);
          stdout.write('\n');
          resolveInput(buffer.trim());
          return;
        }
        // Ctrl-C: leave the terminal usable, then stop.
        if (byte === 0x03) {
          stdin.off('data', onData);
          stdin.setRawMode(wasRaw);
          stdout.write('\n');
          rl.close();
          process.exit(130);
        }
        // Backspace / delete.
        if (byte === 0x7f || byte === 0x08) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        if (byte >= 0x20) buffer += String.fromCharCode(byte);
      }
    };
    stdin.on('data', onData);
  });
}

/** Credentials the wizard offers, in the order they start mattering. */
const CREDENTIALS: Array<{
  key: string;
  label: string;
  why: string;
  where: string;
  tier: 'needed-to-generate' | 'needed-for-mainnet' | 'optional';
}> = [
  {
    key: SECRET_KEYS.anthropicApiKey,
    label: 'Anthropic API key',
    why: 'Generates and adversarially evaluates token concepts. Without an AI provider the platform discovers and scores trends but cannot produce a candidate.',
    where: 'https://console.anthropic.com/settings/keys',
    tier: 'needed-to-generate',
  },
  {
    key: SECRET_KEYS.openaiApiKey,
    label: 'OpenAI API key',
    why: 'A second opinion in the concept panel, and the only source of generated artwork. Without it artwork falls back to a deterministic procedural image.',
    where: 'https://platform.openai.com/api-keys',
    tier: 'optional',
  },
  {
    key: SECRET_KEYS.heliusApiKey,
    label: 'Helius API key',
    why: 'A reliable Solana RPC. The free public endpoints are rate-limited hard enough that launches and fee claims fail intermittently on them.',
    where: 'https://dashboard.helius.dev — the free tier is enough to start',
    tier: 'needed-for-mainnet',
  },
  {
    key: SECRET_KEYS.youtubeApiKey,
    label: 'YouTube Data API key',
    why: 'One more trend source. Nine others work without any credential.',
    where: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
    tier: 'optional',
  },
  {
    key: SECRET_KEYS.redditClientId,
    label: 'Reddit client ID',
    why: 'Reddit trend discovery. Reddit requires an identifiable app, and the platform refuses to poll it anonymously.',
    where: 'https://www.reddit.com/prefs/apps — create a "script" app',
    tier: 'optional',
  },
  {
    key: SECRET_KEYS.redditClientSecret,
    label: 'Reddit client secret',
    why: 'Paired with the client ID above.',
    where: 'Same app page as the client ID',
    tier: 'optional',
  },
  {
    key: SECRET_KEYS.discordWebhook,
    label: 'Discord webhook URL',
    why: 'Where the platform tells you it launched something, hit a limit, or stopped itself. Running unattended without any notification channel means finding out late.',
    where: 'Discord → Server Settings → Integrations → Webhooks',
    tier: 'optional',
  },
];

const TIER_LABEL: Record<string, string> = {
  'needed-to-generate': `${Y}needed to generate concepts${X}`,
  'needed-for-mainnet': `${Y}needed before mainnet${X}`,
  optional: `${D}optional${X}`,
};

/* ------------------------------------------------------------------ env --- */

/**
 * Ensure a `.env` exists with a master key.
 *
 * The master key encrypts every credential and the wallet keystore. Losing it
 * makes all of them unrecoverable, which is why this generates one rather than
 * asking the operator to invent it, states plainly what it protects, and never
 * regenerates over an existing value.
 */
function ensureEnvFile(root: string): { created: boolean; hasKey: boolean; path: string } {
  const path = resolve(root, '.env');
  const examplePath = resolve(root, '.env.example');

  if (!existsSync(path)) {
    const template = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : 'SOLCOIN_MASTER_KEY=\n';
    const withKey = template.replace(/^SOLCOIN_MASTER_KEY=.*$/m, `SOLCOIN_MASTER_KEY=${randomBytes(32).toString('base64')}`);
    writeFileSync(path, withKey, { mode: 0o600 });
    chmodSync(path, 0o600);
    return { created: true, hasKey: true, path };
  }

  const current = readFileSync(path, 'utf8');
  const match = /^SOLCOIN_MASTER_KEY=(.*)$/m.exec(current);
  const value = (match?.[1] ?? '').trim();
  if (value.length >= 16) return { created: false, hasKey: true, path };

  const filled = match
    ? current.replace(/^SOLCOIN_MASTER_KEY=.*$/m, `SOLCOIN_MASTER_KEY=${randomBytes(32).toString('base64')}`)
    : `${current.trimEnd()}\nSOLCOIN_MASTER_KEY=${randomBytes(32).toString('base64')}\n`;
  writeFileSync(path, filled, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { created: false, hasKey: true, path };
}

/* ----------------------------------------------------------------- main --- */

async function main(): Promise<void> {
  const root = resolve(process.cwd());

  say();
  say(`${B}Solcoin setup${X}`);
  note('Everything that can be automated, done here. Everything that cannot is named,');
  note('with where to go and why it matters.');

  if (!stdin.isTTY) {
    say();
    say(`${R}This wizard needs an interactive terminal.${X}`);
    note('Run it directly rather than through a pipe or a CI step. For headless');
    note('deployment set BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD instead — see docs/going-live.md.');
    rl.close();
    process.exit(2);
  }

  /* --- 1. environment ------------------------------------------------- */

  heading('1. Environment');

  const major = Number(process.version.slice(1).split('.')[0]);
  if (major < 20) {
    say(`  ${R}Node ${process.version} is too old; 20.11 or newer is required.${X}`);
    rl.close();
    process.exit(1);
  }
  done(`Node ${process.version}`);

  const env0 = ensureEnvFile(root);
  if (env0.created) {
    done('Created .env with a freshly generated master key (mode 0600)');
  } else {
    done('.env already present, master key left untouched');
  }

  say();
  warn('Back up SOLCOIN_MASTER_KEY somewhere outside this machine, now.');
  note('  It encrypts every credential and the wallet private key. If you lose it,');
  note('  the wallet cannot be recovered from this database by anyone, including you.');

  resetEnvCache();
  const env = loadEnv();
  createLogger({ level: 'error', pretty: false });

  mkdirSync(dirname(resolve(root, env.DATABASE_PATH)), { recursive: true });
  mkdirSync(resolve(root, env.DATA_DIR), { recursive: true });

  // Migrations run against their own connection and it is closed again, so the
  // container below opens the database in its normal configuration rather than
  // inheriting one this file set up.
  const migrationDb = openDatabase({ path: env.DATABASE_PATH });
  runMigrations(migrationDb);
  closeDatabase(migrationDb);
  done(`Database ready at ${env.DATABASE_PATH}, migrations applied`);

  const container = await createContainer({ env });

  try {
    /* --- 2. owner account --------------------------------------------- */

    heading('2. Owner account');

    if (container.auth.userCount() > 0) {
      skip('An account already exists; skipping. Use the dashboard to add more.');
    } else {
      note('  This is the login for the dashboard. It is stored locally, hashed.');
      say();
      const email = await ask('Email');
      const displayName = await ask('Display name', email.split('@')[0] ?? 'Owner');

      let created = false;
      while (!created) {
        const password = await askSecret('Password (12+ characters)');
        const again = await askSecret('Password again');
        if (password !== again) {
          warn('Those did not match. Try again.');
          continue;
        }
        try {
          await container.auth.createUser({
            email,
            password,
            displayName,
            role: 'owner',
            requireFirstUser: true,
          });
          created = true;
        } catch (e) {
          warn(safeErrorText(e, 200));
        }
      }
      done(`Owner account created for ${email}`);
    }

    /* --- 3. credentials ----------------------------------------------- */

    heading('3. Credentials');
    note('  Each one is optional to enter now and can be added later in the dashboard');
    note('  under Settings → Credentials. Press Enter to skip any of them.');

    const stored = new Set((await container.secrets.list()).map((s) => s.key));

    for (const cred of CREDENTIALS) {
      say();
      say(`  ${C}${cred.label}${X}  ${TIER_LABEL[cred.tier]}`);
      note(`    ${cred.why}`);
      note(`    Get one: ${cred.where}`);

      if (stored.has(cred.key)) {
        skip('Already stored. Enter a new value to replace it, or press Enter to keep it.');
      }

      const value = await askSecret('    Paste it (or Enter to skip)');
      if (!value) {
        if (!stored.has(cred.key)) skip('Skipped.');
        continue;
      }

      await container.secrets.set(cred.key, value, 'api_key');
      // Read it back from the store rather than trusting the write.
      const readBack = await container.secrets.get(cred.key);
      if (readBack === value) {
        done(`${cred.label} stored and verified (${value.length} characters, encrypted at rest)`);
      } else {
        warn(`${cred.label} did not read back correctly. Check SOLCOIN_MASTER_KEY.`);
      }
    }

    /* --- 4. wallet ----------------------------------------------------- */

    heading('4. Operating wallet');

    const existingWallet = await container.keystore.getPublicKey();
    if (existingWallet) {
      skip(`A wallet is already configured: ${existingWallet}`);
    } else {
      note('  This wallet pays for launches and receives creator fees. Its private key is');
      note('  encrypted with your master key and never leaves this machine.');
      say();
      note('  Use a NEW wallet used for nothing else. Do not import a wallet that holds');
      note('  funds you are not prepared to have this platform spend.');
      say();

      const importing = await confirm('Import an existing private key instead of generating one?', false);
      if (importing) {
        const secret = await askSecret('Private key (base58, or a JSON array of bytes)');
        try {
          const { publicKey } = await container.keystore.importOperatingWallet(secret);
          done(`Imported wallet ${publicKey}`);
        } catch (e) {
          warn(`Could not import that key: ${safeErrorText(e, 160)}`);
          warn('Skipping wallet setup. Re-run this wizard or use the dashboard.');
        }
      } else {
        const { publicKey } = await container.keystore.createOperatingWallet();
        done(`Generated wallet ${publicKey}`);
        say();
        say(`  ${B}Fund this address to launch anything:${X}`);
        say(`  ${C}${publicKey}${X}`);
        note('  Export the private key later from Settings → Wallet if you want an offline');
        note('  backup. It requires typing an exact confirmation phrase.');
      }
    }

    /* --- 5. what is still missing -------------------------------------- */

    heading('5. Where this leaves you');

    const settings = container.settings.get();
    const walletAddress = await container.keystore.getPublicKey();
    const secretsNow = new Set((await container.secrets.list()).map((s) => s.key));
    const balance = await container.wallet.summary().catch(() => null);

    say(`  Phase          ${B}${settings.execution.phase}${X} ${D}(research only — nothing can be launched)${X}`);
    say(`  Network        ${B}${settings.execution.network}${X}`);
    say(`  Wallet         ${walletAddress ? `${B}${walletAddress}${X}` : `${Y}not configured${X}`}`);
    /*
     * A balance that was never fetched is not a balance of zero.
     *
     * `summary()` returns zero lamports with a null `balanceCheckedAt` when
     * nothing has queried a chain yet, which is exactly the state a wallet is
     * in the moment this wizard creates it. Printing "0.0000 SOL" there would
     * tell an operator their funded wallet is empty — the same mistake the
     * dashboard is careful not to make.
     */
    const checked = balance?.balanceCheckedAt ?? null;
    say(
      `  Balance        ${
        checked === null
          ? `${D}not checked yet — no chain has been queried${X}`
          : `${B}${(balance!.balanceLamports / 1e9).toFixed(4)} SOL${X}`
      }`,
    );

    say();
    const blockers: string[] = [];
    if (!secretsNow.has(SECRET_KEYS.anthropicApiKey) && !secretsNow.has(SECRET_KEYS.openaiApiKey)) {
      blockers.push('No AI provider. Trends will be discovered and scored, but no concept can be generated.');
    }
    if (!walletAddress) blockers.push('No operating wallet. Nothing can be launched or claimed.');
    if (!secretsNow.has(SECRET_KEYS.heliusApiKey)) {
      blockers.push('No dedicated RPC. Fine for research and simulation; add one before devnet or mainnet.');
    }

    if (blockers.length === 0) {
      done('Nothing is missing for research and simulation.');
    } else {
      say(`  ${B}Still missing${X}`);
      for (const b of blockers) say(`    ${Y}·${X} ${b}`);
    }

    say();
    say(`  ${B}Next${X}`);
    say(`    1. ${C}npm run dev${X}  — then open http://127.0.0.1:${env.PORT} and sign in`);
    say('    2. Run the trend-discovery job from the Health page and watch it find things');
    say('    3. Generate candidates and read what it produces, in simulation, for a few days');
    say(`    4. Only then read ${C}docs/going-live.md${X} for the path to devnet and mainnet`);
    say();
    note('  This wizard deliberately leaves you in phase one. Advancing is a decision');
    note('  you make in Settings once you have seen the platform work.');
    say();
  } finally {
    closeDatabase(container.db);
    rl.close();
  }
}

main().catch((e: unknown) => {
  stdout.write(`\n${R}Setup failed:${X} ${safeErrorText(e, 400)}\n\n`);
  rl.close();
  process.exit(1);
});
