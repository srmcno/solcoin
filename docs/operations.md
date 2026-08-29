# Operations

Running Solcoin in production. Deployment, first boot, the scheduler, what to
watch, backups, and what to do when something breaks.

The shape of the system determines most of what follows: **one Node process, one
SQLite file, one scheduler.** There is no broker, no cache server, no second
database. That makes deployment unusually simple and it makes exactly one thing
your responsibility — the data directory.

---

## What must persist

| Path (default) | Contents | Losing it costs |
|---|---|---|
| `./data/solcoin.db` | Everything: trends, concepts, launches, tokens, fee events, settings, audit log, **and the encrypted `secrets` table containing the wallet keystore** | Everything |
| `./data/solcoin.db-wal`, `-shm` | WAL and shared-memory files alongside the database | Uncommitted recent writes |
| `./data/artwork/` | A local copy of every generated image (`<conceptId>.svg` or `.png`) | Local provenance only — launched tokens reference IPFS URIs, so on-chain metadata is unaffected |
| `SOLCOIN_MASTER_KEY` (environment, **not** on the volume) | The scrypt passphrase every secret and the wallet key are encrypted under | Every credential and the operating wallet, irrecoverably |

`DATABASE_PATH` defaults to `./data/solcoin.db` and `DATA_DIR` to `./data`, so in
the default layout one directory is the whole persistent state. Keep them
together.

The master key is deliberately *not* part of the data directory. That is what
makes a stolen backup useless — and what makes a backup without the key useless
to you. See [Backups](#backups).

---

## Deployment

### What actually ships

`npm run build` produces three things:

```
packages/shared/dist/      # tsc output, inlined into the server bundle
packages/server/dist/      # esbuild bundle: main.js, cli/doctor.js, cli/migrate.js
packages/web/dist/         # the dashboard, served as static files
```

The server is bundled by `packages/server/build.mjs` into a single ESM file per
entry point. Two things are marked `external` and are therefore **not** in the
bundle:

- **`better-sqlite3`** — a native addon (`build/Release/better_sqlite3.node`)
  that cannot be bundled. It must exist in `node_modules` at runtime, compiled
  or prebuilt for the exact platform, architecture, libc and Node ABI of the
  process that will run it.
- **`pino-pretty`** — only loaded when `LOG_PRETTY` is on. It is a
  *devDependency*, so a production install without dev dependencies does not
  have it. Do not set `LOG_PRETTY=true` in such an image.

One further file set is needed at runtime that the build does *not* copy:
**`packages/server/src/db/migrations/`**. `migrationsFolder()` in
`src/db/migrate.ts` deliberately leaves the `.sql` files in `src` and searches
four locations in order:

1. `<dir of the running file>/migrations`
2. `<dir of the running file>/../../src/db/migrations`
3. `<cwd>/packages/server/src/db/migrations`
4. `<cwd>/src/db/migrations`

The first directory containing `meta/_journal.json` wins. For a bundled
deployment the practical answer is candidate 3: **keep the repository layout and
run from the repository root**, which is what both `npm start` and the unit file
below do.

So a minimal production tree is:

```
/opt/solcoin/
  package.json
  node_modules/                        # production install; better-sqlite3 required
  packages/server/dist/                # the bundle
  packages/server/src/db/migrations/   # .sql + meta/_journal.json
  packages/web/dist/                   # dashboard
  data/                                # the volume
```

### systemd

Build on the target host (or on an identical one — the native module must
match), then:

```ini
# /etc/systemd/system/solcoin.service
[Unit]
Description=Solcoin
Documentation=file:///opt/solcoin/docs/operations.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=solcoin
Group=solcoin
WorkingDirectory=/opt/solcoin
ExecStart=/usr/bin/node packages/server/dist/main.js

Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=4317
Environment=DATABASE_PATH=/var/lib/solcoin/solcoin.db
Environment=DATA_DIR=/var/lib/solcoin
Environment=WEB_DIST=/opt/solcoin/packages/web/dist
Environment=TRUST_PROXY=true
# SOLCOIN_MASTER_KEY only. chmod 0400, chown root:solcoin.
EnvironmentFile=/etc/solcoin/master-key.env

Restart=on-failure
RestartSec=5
# main.ts forces exit 20s after SIGTERM if in-flight jobs have not unwound.
TimeoutStopSec=45
KillSignal=SIGTERM

# Filesystem
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/solcoin
StateDirectory=solcoin

# Process
NoNewPrivileges=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
MemoryDenyWriteExecute=false
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
```

`MemoryDenyWriteExecute=false` is required: V8 needs W+X pages for its JIT.

Note the honest trade-off on the master key. The application never writes it to
disk, but `EnvironmentFile=` means *systemd* reads it from a file that root can
read and that is captured by a filesystem backup of `/etc`. `LoadCredential=` is
not usable here because the process reads the key only from the environment.
Keep the file `0400`, keep it out of `/etc` backups, or inject it from a secrets
manager into the unit's environment at start.

```bash
install -d -m 0700 -o solcoin -g solcoin /var/lib/solcoin
install -d -m 0750 /etc/solcoin
printf 'SOLCOIN_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" > /etc/solcoin/master-key.env
chmod 0400 /etc/solcoin/master-key.env && chown root:solcoin /etc/solcoin/master-key.env
systemctl daemon-reload && systemctl enable --now solcoin
journalctl -u solcoin -f
```

`doctor` reads its configuration the same way the server does — from the process
environment, plus a `.env` in the **current working directory**. Run it as the
service user, from the service's working directory, with the same environment:

```bash
cd /opt/solcoin
sudo -u solcoin --preserve-env env $(cat /etc/solcoin/master-key.env) \
  NODE_ENV=production DATABASE_PATH=/var/lib/solcoin/solcoin.db DATA_DIR=/var/lib/solcoin \
  node packages/server/dist/cli/doctor.js
```

Running it from anywhere else, or without those variables, inspects a different
(possibly newly created, empty) database and tells you nothing useful. Note the
cost of that one-liner: `$(cat …)` is expanded by the *invoking* shell, so it has
to be run as root, and the key is briefly visible in `ps` output for anyone on
the box. On a shared host, source the file into the root shell first
(`set -a; . /etc/solcoin/master-key.env; set +a`) and pass the variable through
instead.

### Docker

Both stages must use the same base image so the `better_sqlite3.node` compiled
in the build stage matches the runtime's libc and Node ABI. Debian slim is used
here rather than Alpine because better-sqlite3 publishes prebuilt binaries for
glibc but not for musl — on Alpine every build compiles from source, which works
but needs `build-base python3` and adds several minutes.

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS build
# node-gyp needs these if no prebuilt better-sqlite3 binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY . .
RUN npm run build \
 && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    DATABASE_PATH=/data/solcoin.db \
    DATA_DIR=/data \
    WEB_DIST=/app/packages/web/dist

# The bundle, the native module, the migration SQL, and the dashboard.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
# node_modules/@solcoin/shared is a workspace symlink; keep its target present
# so nothing dangles, even though the bundle already inlines this code.
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/src/db/migrations ./packages/server/src/db/migrations
COPY --from=build /app/packages/web/dist ./packages/web/dist

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4317

# /api/health needs no session (login, session and bootstrap are the other
# routes that do not). No curl in the slim image, so node does the probing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM
CMD ["node", "packages/server/dist/main.js"]
```

`WORKDIR /app` is load-bearing: it is what makes migration-folder candidate 3
(`/app/packages/server/src/db/migrations`) resolve.

`npm prune --omit=dev` removes esbuild, drizzle-kit, vitest **and pino-pretty**.
If you would rather not risk prune touching the workspace symlinks, drop that
step and accept a larger image.

### docker compose

```yaml
services:
  solcoin:
    build: .
    image: solcoin:local
    restart: unless-stopped
    # Bind to loopback and put nginx in front. Do not publish 4317 publicly.
    ports:
      - "127.0.0.1:4317:4317"
    environment:
      NODE_ENV: production
      SOLCOIN_MASTER_KEY: ${SOLCOIN_MASTER_KEY:?set SOLCOIN_MASTER_KEY in .env}
      TRUST_PROXY: "true"
      LOG_LEVEL: info
      # Headless first run. Remove both once the owner account exists.
      # BOOTSTRAP_EMAIL: you@example.com
      # BOOTSTRAP_PASSWORD: ${BOOTSTRAP_PASSWORD}
    volumes:
      - solcoin-data:/data
    stop_grace_period: 45s

volumes:
  solcoin-data:
```

`solcoin-data` holds `solcoin.db`, its WAL files and `artwork/`. It is the only
thing in this stack worth backing up — and it is worthless without
`SOLCOIN_MASTER_KEY`, which is deliberately not in the volume.

---

## Reverse proxy

The dashboard and the API share one origin and there is no inbound WebSocket or
SSE endpoint, so the proxy configuration is ordinary.

```nginx
server {
    listen 443 ssl http2;
    server_name solcoin.example.com;

    ssl_certificate     /etc/letsencrypt/live/solcoin.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/solcoin.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # The app sets its own CSP, HSTS and frame headers via @fastify/helmet.
    # Do not add competing ones here.

    # Generated artwork is a few hundred KB; the API body limit is 2 MiB.
    client_max_body_size 4m;

    location / {
        proxy_pass         http://127.0.0.1:4317;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        # Trend discovery and the candidate pipeline can hold a request open.
        proxy_read_timeout 120s;
    }
}

server {
    listen 80;
    server_name solcoin.example.com;
    return 301 https://$host$request_uri;
}
```

### TLS is not optional in production

The session cookie is set with `secure: env.isProduction`. With
`NODE_ENV=production` and plain HTTP, the browser refuses to store or return
`solcoin_session` and sign-in silently fails to stick. Either terminate TLS or
do not set `NODE_ENV=production`.

### The `TRUST_PROXY` caveat

`TRUST_PROXY=true` sets Fastify's `trustProxy`, which makes `request.ip` come
from `X-Forwarded-For`. Two things read `request.ip`:

- the global rate limiter (`600 requests/minute`, keyed by IP), and
- the audit log and session records.

**Without** it behind a proxy, every request appears to come from the proxy's
address: the rate limit becomes a single shared 600/min bucket for all clients,
and every audit entry records the proxy's IP.

**With** it and *no* proxy — or a proxy that does not overwrite the header —
anyone can send `X-Forwarded-For: 1.2.3.4` and both evade the rate limit and
poison the audit log's IP field. Enable it only when a proxy you control sets
`X-Forwarded-For` itself, and make sure the app is not reachable except through
that proxy.

---

## First run

### The boot sequence

`packages/server/src/main.ts`, in order:

1. **`loadEnv()`** — reads `.env` from the working directory (never overriding a
   variable already in the real environment), then validates against the Zod
   schema. An invalid value throws before anything else happens, naming the
   field.
2. **Logger** — created next so everything after it is captured. JSON to stdout
   unless `LOG_PRETTY` is on (default: pretty unless `NODE_ENV=production`).
3. **Master-key check** — a warning if absent; the process continues.
4. **`createContainer()`** — opens the database (creating the file and its parent
   directory if needed), **runs migrations**, then constructs the secret store,
   keystore, services, providers and adapters.
5. **Bootstrap** — if `auth.userCount() === 0`.
6. **Scheduler** — jobs registered and started unless `DISABLE_SCHEDULER` is set.
7. **HTTP last** — `createServer()` then `listen()`. Traffic is never served
   before the container is ready.

Then one `solcoin is ready` line carrying the URL, network, phase, launch
autonomy, emergency-stop state and provider counts. Those counts are how many
providers were *constructed* (10 trend, 3 market on a normal boot), not how many
will actually be polled: `trend-discovery` filters against
`research.enabledSources`, which lists 6 by default.

Shutdown on `SIGTERM`/`SIGINT` is the reverse: HTTP closed, scheduler stopped
(in-flight jobs aborted and given 5 seconds to unwind), `wal_checkpoint(TRUNCATE)`,
database closed. A 20-second watchdog forces `exit(1)` if that stalls. An
`uncaughtException` runs the same shutdown; an `unhandledRejection` is logged and
the process keeps running.

### With and without `SOLCOIN_MASTER_KEY`

| | Key set (≥ 16 chars) | Key absent |
|---|---|---|
| Server starts | yes | yes |
| Dashboard, accounts, sign-in | yes | yes |
| Zero-credential trend discovery and scoring | yes | yes |
| Storing or reading any credential | yes | **no** — `secrets.get()` returns `null` |
| AI concept generation, evaluation, artwork | yes | **no** — providers report `unconfigured` |
| Wallet create/import/unlock, signing | yes | **no** — `AppError('locked')` |

Without the key the boot log carries an explicit warning:

> `SOLCOIN_MASTER_KEY is not set. The platform will start in a LOCKED state: the dashboard works and zero-auth research runs, but no credential can be stored or read, no wallet can be unlocked, and no launch can be signed. Set a key of at least 16 characters and restart to enable those features.`

The key is only read at boot. Changing it does not re-encrypt anything: every
secret stored under the old key becomes undecryptable, `secrets.get()` returns
`null`, and the log records `failed to decrypt secret — the master key may have
changed since this secret was stored`. Treat it as permanent.

### Headless first account

If the `users` table is empty **and both** `BOOTSTRAP_EMAIL` and
`BOOTSTRAP_PASSWORD` are set, main.ts creates an `owner` account named `Owner`
and logs `bootstrap owner account created from the environment`. Constraints
come from the env schema: the email must parse as an email, the password must be
at least 12 characters.

Creation failure is **logged, not fatal** — `bootstrap account creation failed`,
and the server still comes up so you can create the account through the UI.

If the table is empty and the variables are not set, you get
`No accounts exist yet. Open the dashboard to create the first owner account.`
and `POST /api/system/bootstrap` (rate-limited to 5 per 10 minutes) is open until
the first user exists.

Remove both variables once the account exists. They are ignored while any user
exists, but leaving a plaintext password in a unit file or compose file has no
upside.

### What to check afterwards

```bash
npm run doctor
```

`doctor` builds the same container the server does and reports on: Node version,
mode, database path, master key, database size and journal mode, **audit chain
validity**, account count, phase, network, launch autonomy, emergency stop,
wallet address/custody/balance/floor/signing, treasury address, every provider's
health state, every launch adapter's readiness, RPC endpoint health, and the
success model's training count.

It exits non-zero only on a genuine fault. A provider being `unconfigured` is
reported as information, not a failure — that is deliberate, so the check stays
useful in CI. An `essential` component being `down` (database, disk, clock) is a
failure.

Then in the dashboard: confirm the phase is `phase1_research` and the network is
`simulation` (the shipped defaults), and leave it there long enough to see
`trend-discovery` and `candidate-pipeline` complete at least once.

---

## The scheduler

`packages/server/src/jobs/scheduler.ts`. A 5-second tick selects jobs whose
`next_run_at` has passed and whose lease is free, then takes the lease with a
single conditional `UPDATE` on `job_state` before running anything.

- **Durable** — `next_run_at` lives in the database, so a restart resumes rather
  than resetting every interval.
- **Staggered** — first run is offset by `2000 + hash(jobName) % 45000` ms, so a
  cold start does not fire all sixteen jobs at once.
- **Leased** — `locked_until` = now + timeout. A lease whose holder died is
  released on a later tick and its `job_runs` row is marked failed with `The
  process running this job stopped before it finished.`
- **Backed off** — after a failure, next run is `min(1 hour, interval × 2^min(failures, 6))`.
- **Jittered** — every scheduled time is multiplied by `1 ± 7.5%` so jobs
  registered together do not stay locked in step.
- **Timed out** — `timeoutSeconds`, or `max(120, interval × 3)` when unset. The
  job's `AbortSignal` fires; the job must honour it.
- **Halted** — a job with `hasSideEffects: true` does not run at all while the
  emergency stop is engaged. Read-only jobs continue so the dashboard stays
  accurate while paused.

### Every job

Defaults from `jobs/definitions.ts`. `PATCH /api/jobs/:name` accepts
`{ enabled?, intervalSeconds? }` (interval 15–86400) without a restart, but the
two fields behave very differently and the difference matters:

- **`enabled` is durable.** It is written to `job_state.enabled` and `register()`
  does not overwrite it, so a disabled job stays disabled across restarts.
- **`intervalSeconds` is not.** It updates `job_state.interval_seconds` and moves
  `next_run_at` once, but `scheduleNext()` computes every subsequent run from
  `job.intervalSeconds` on the in-memory definition, and `register()` rewrites the
  column back to the code default on the next boot. In practice a `PATCH` shifts
  the *next* run and then the job reverts to its compiled-in interval. Only
  `trend-discovery` has a genuinely configurable interval, through
  `research.discoveryIntervalMinutes` — and that too is read once, at
  `registerAll()`, so it needs a restart to take effect. To change any other
  interval permanently, edit `jobs/definitions.ts`.

| Job | Interval | Timeout | Side effects | Gated on | What it does |
|---|---|---|---|---|---|
| `trend-discovery` | `research.discoveryIntervalMinutes × 60` — **1800 s** by default | 300 s | yes | — | Polls every enabled trend source and folds new signals into the trend graph. |
| `market-scan` | 900 s | 180 s | yes | — | Pulls up to 200 recent launches into `competitor_tokens` (the corpus saturation scoring runs against), records a market-regime snapshot, and deletes competitor rows older than 30 days. |
| `candidate-pipeline` | 1800 s | 900 s | yes | `autonomy.concept_generation !== 'off'` | Turns qualifying opportunities into evaluated, gated launch candidates. The job that spends AI budget. |
| `launch-queue` | 120 s | 300 s | yes | — | Picks up to 5 `approved` concepts with a `metadata_uri`, checks the guard once, then launches **at most one per tick** — deliberately, so a batch is not launched back-to-back. |
| `launch-recovery` | 180 s | 120 s | no | — | Resolves launches broadcast but never confirmed. Waits 2 minutes before intervening; treats the mint account existing as definitive; gives up as `expired` after 10 minutes. |
| `token-monitor` | 60 s | 240 s | no | — | Polls launched tokens due for a poll at their monitoring tier. In `simulation` reads the simulation adapter's own outcome model instead. |
| `token-lifecycle` | 3600 s | 10800 s (derived) | no | — | Marks quiet tokens dormant so monitoring effort follows attention. |
| `fee-detect` | 600 s | 120 s | no | — | Reads the on-chain creator-fee vaults and records accrual snapshots. In simulation it also accrues simulated fees from simulated volume. |
| `fee-collect` | 3600 s | 180 s | yes | `autonomy.fee_collection === 'auto'` | Claims accrued creator fees when `decideCollection` says it is economically worth the transaction. |
| `wallet-reconcile` | 600 s | 120 s | **no** (see the note below) | — | Refreshes wallet balances; **and** sweeps surplus to treasury when `wallet.autoSweepEnabled` *and* `autonomy.wallet_transfer === 'auto'` (both off by default). |
| `learning-outcomes` | 3600 s | 300 s | no | — | Measures realised outcomes against stored predictions at 24 h, 72 h and 168 h. |
| `model-train` | 21600 s (6 h) | 600 s | no | — | Folds new outcomes into the success model, if they improve it. |
| `analytics-rollup` | 3600 s | 180 s | no | — | Recomputes today's row in `daily_metrics` so analytics queries stay fast. |
| `health-check` | 300 s | 60 s | no | — | Probes every registered provider and records its state; writes a `system_events` row on each state *transition*. |
| `notification-retry` | 600 s | 1800 s (derived) | yes | — | Retries notification deliveries that failed. |
| `maintenance` | 3600 s | 300 s | no | — | Prunes stale data, expires candidates, checkpoints the database. See [Database maintenance](#database-maintenance). |

> **`wallet-reconcile` is marked `hasSideEffects: false` even though its sweep
> branch calls `wallet.transfer({ purpose: 'treasury_sweep' })`.** The scheduler
> suspends jobs by that flag, so this one keeps running during an emergency stop
> and still attempts the transfer. No SOL moves, though: `wallet.transfer()` goes
> through `guard.requireSpend({ operation: 'wallet_transfer' })`, and
> `checkOperational` denies every `wallet_transfer` while the stop is engaged (and
> whenever `autonomy.wallet_transfer` is `off`). The visible symptom of a stop
> during a due sweep is a warn line, `automatic treasury sweep failed`, not a
> sweep. The flag is still mislabelled and worth knowing about — a job that can
> spend should not be classed as read-only — but the kill switch does cover this
> path.

Two more things about automatic sweeps, if you turn them on:

- They need **both** `wallet.autoSweepEnabled` (default `false`) and
  `autonomy.wallet_transfer === 'auto'` (default `off`, and `auto` is only
  reachable from phase 4 or 5), plus `wallet.treasuryAddress` set and a signing
  key in this process. On the `simulation` network `wallet.transfer()` refuses
  outright — there are no real funds to move — so the branch only ever does
  anything on devnet or mainnet.
- `evaluateSweep()` only fires above `wallet.sweepThresholdSol` (**1.0**) and
  leaves `wallet.operatingFloatSol` (**0.3**) behind, so the smallest sweep it can
  propose is around **0.7 SOL** — which `guard.checkSpend` then rejects against
  `limits.maxSolPerTransaction` (**0.15 SOL**), `maxSolPerHour` (**0.3**) and
  `maxSolSpendPerDay` (**0.5**). At the shipped limits an automatic sweep can
  never succeed. Raise those limits deliberately, or sweep manually via
  `POST /api/wallet/sweep`, which is subject to exactly the same guard.

### Split-process deployment, and the one-scheduler rule

`DISABLE_SCHEDULER=true` (or `1`) makes a process serve the API only. It logs
`Scheduler disabled by DISABLE_SCHEDULER; this process serves the API only.` and
never calls `registerAll`.

That gives you an API-only replica in front of the same database file — for
example a second process to absorb dashboard traffic while the worker does the
real work. **Exactly one process must run the scheduler.** The lease is a genuine
atomic guard against two processes running the same job simultaneously, but it is
the *only* thing standing between two schedulers and duplicated side effects, and
several important pieces of state are per-process and never invalidated:

- **`SettingsService` caches settings in memory indefinitely.** The cache is
  refreshed only by that process's own `update()`; there is no cross-process
  invalidation (`invalidate()` exists at `services/settings.service.ts:253` and
  has no callers anywhere in `packages/server/src`). **An emergency stop
  engaged on the API replica is invisible to the scheduler process until it
  restarts.** So is a phase change, an autonomy change and a limit change. If you
  run split, treat "restart the worker" as part of applying any settings change,
  and prefer engaging the emergency stop on the process that runs jobs.
- **`scheduler.status()` filters to jobs registered in *this* process.** On an
  API-only replica `GET /api/jobs` returns an empty `jobs` array (its `recentRuns`
  still come from the shared `job_runs` table) and `POST /api/jobs/:name/run`
  fails with `No job named "…"`. The health check's
  scheduler component reads `job_state` directly from the database, so *it* still
  reports correctly on either process.
- Provider circuit-breaker state, the AI response cache and the secret cache are
  per-process.

If you do not have a specific reason to split, do not. One process is the
supported shape.

Two further consequences of SQLite: both processes must have the database file on
a **local** filesystem (WAL over NFS or a network block store shared between
hosts will corrupt it), and only one host can be involved.

---

## Monitoring

### What to watch

| Signal | Where | Threshold that means something |
|---|---|---|
| Job overdue | `jobs[].overdueSeconds`, health component `scheduler` | Health degrades when a job is late by more than **2× its own interval**; it reports `down` when *every* enabled job is overdue, which means the loop itself is dead. |
| Consecutive job failures | `jobs[].consecutiveFailures` | Health degrades above **2**. Backoff means a failing job retries at up to 1-hour intervals, so a broken dependency looks quiet, not noisy. |
| Consecutive **launch** failures | `usage.consecutiveFailures` from `GET /api/system/status` | At `limits.consecutiveFailureShutdown` (**default 3**) `guard.checkLaunch()` blocks launching, and the failure handler in `launch.service.ts` calls `guard.autoStop()`, which engages the global emergency stop. |
| Provider state | health components of kind `provider` | `unconfigured` is normal and never degrades overall health. `degraded`/`down` on a non-essential provider is a warning. |
| Wallet vs floor | `wallet.belowFloor`, health component `wallet` | `guard.checkSpend` refuses any operation that would take the balance below `limits.walletBalanceFloorSol` (**default 0.05 SOL**) — when the caller passes the current balance, which the launch and transfer paths do, so those stop. Fee collection goes through `checkOperational` instead and is *not* floor-blocked — the floor exists precisely so there is always enough SOL left to pay for a claim. Watch it anyway: below the floor the platform is doing nothing useful. |
| Emergency stop | `emergencyStop`, `emergencyStopReason` | Any `true` you did not set yourself means the guard tripped. The reason is recorded. |
| Audit chain | `GET /api/system/audit/verify` | `valid: false` with `brokenAtSequence` means a row was deleted or edited. Investigate before anything else. |
| Disk | health component `disk` (essential) | `degraded` below 10% free, **`down` below 100 MiB or 2%** — SQLite cannot commit on a full volume. |
| Clock | health component `clock` (essential) | Wall clock diverging from the monotonic reference by more than `limits.maxClockDriftSeconds` (**default 120 s**). A stepped clock expires blockhashes and breaks scheduling. |
| Database latency | health component `database` (essential) | Median of 5 trivial queries above **250 ms**. |

### Endpoints

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /api/health` | **none** | `{ status: 'ok', uptimeSeconds }`. Liveness only — it does not consult the database. Use it for load-balancer and container probes. |
| `GET /api/system/status` | `view` | The one call worth polling: `health`, `usage` (every limit and its current consumption), `wallet`, `phase`, `network`, `autonomy`, `emergencyStop`, `emergencyStopReason`, and `jobs` (the full scheduler status array). |
| `GET /api/system/providers` | `view` | The same `checkAll()` payload as `status.health` — every component, including the provider ones with their availability estimates. |
| `GET /api/system/diagnostics` | `view` | Environment, secret-store state, wallet, adapters, RPC endpoint health, provider ids, model version, economic assumptions, audit-chain verification over the last 5,000 entries. |
| `GET /api/system/audit/verify` | `view_audit` | `{ valid, checked, brokenAtSequence?, detail? }`. |
| `GET /api/system/audit?limit&offset&action&targetType&targetId` | `view_audit` | The audit log. `limit` max 500. |
| `GET /api/system/logs?limit&level&component` | `view` | Rows from `system_events` (30-day retention). `limit` max 500. |
| `GET /api/jobs` | `view` | Job status plus the 40 most recent runs. |
| `GET /api/jobs/:name/runs` | `view` | The 60 most recent runs of one job. |
| `POST /api/jobs/:name/run` | `run_research` | Run a job now, outside its schedule. |
| `PATCH /api/jobs/:name` | `edit_limits` | `{ enabled?, intervalSeconds? }`. |
| `POST /api/system/emergency-stop` | `emergency_stop` | Body `{ reason }`, 3–500 characters. |
| `POST /api/system/emergency-release` | `emergency_stop` | Body `{ reason }`, 3–500 characters. |

**Every endpoint that reports anything about the system requires a session
cookie.** Five routes are exempt from the auth hook and none of them are useful
for monitoring: `GET /api/health`, `POST /api/auth/login`,
`GET /api/auth/session`, and `GET`/`POST /api/system/bootstrap` (the last two are
first-run only and reveal nothing once an account exists).

There is no API token and no Prometheus endpoint. External monitoring therefore
has three options: probe `/api/health` for liveness; script a login against
`POST /api/auth/login` and reuse the `solcoin_session` cookie (state-changing
methods additionally need the `x-csrf-token` header — and note that login is
rate-limited to **10 attempts per 5 minutes**, so a monitor must hold the session
rather than sign in on every poll); or read the SQLite file directly with a
read-only connection — `job_state`, `provider_health` and `system_events` are the
useful tables and their columns are stable.

### What the log lines look like

Pino JSON on stdout (one object per line), with `component` on every record and
aggressive redaction of anything credential-shaped. `NODE_ENV=production`
defaults to JSON; anything else defaults to pretty output via `pino-pretty`.

```json
{"level":"info","time":1756400000000,"component":"boot","url":"http://127.0.0.1:4317","network":"simulation","phase":"phase1_research","launchAutonomy":"approve","emergencyStop":false,"trendProviders":10,"marketProviders":3,"msg":"solcoin is ready"}
{"level":"info","time":1756400000000,"component":"scheduler","jobs":16,"instanceId":"…","msg":"job scheduler started"}
{"level":"error","time":1756400000000,"component":"scheduler","job":"trend-discovery","err":"…","durationMs":41230,"msg":"job failed"}
{"level":"info","time":1756400000000,"component":"scheduler","job":"candidate-pipeline","durationMs":184002,"itemsProcessed":12,"msg":"job completed"}
{"level":"info","time":1756400000000,"component":"health","provider":"dexscreener","from":"ok","to":"degraded","msg":"provider state changed"}
{"level":"error","time":1756400000000,"component":"guard","reason":"3 consecutive launch failures on mainnet. Most recent: …","msg":"engaging emergency stop automatically"}
{"level":"info","time":1756400000000,"component":"http","method":"POST","url":"/api/candidates/…/launch","status":500,"ms":8210,"user":"usr_…","msg":"request"}
```

Two deliberate quiet rules, so alerting on volume will mislead you:

- A successful job logs `job completed` **only if it took longer than 30
  seconds**. Routine successful runs produce no log line at all; they are visible
  in `job_runs` and `GET /api/jobs`.
- HTTP requests are logged **only** when the status is ≥ 400 or the request took
  longer than 1500 ms. There is no access log.

The lines worth alerting on are `msg:"job failed"`, `msg:"engaging emergency stop
automatically"`, `level:"fatal"` (`uncaught exception; shutting down`), and
`msg:"provider state changed"` with `to:"down"`.

---

## Backups

### The online backup

`backupDatabase(db, destination)` in `packages/server/src/db/client.ts` wraps
better-sqlite3's `db.backup()`, which is SQLite's **online backup API**. It walks
the database page by page, restarting if a write invalidates its progress, and
produces a consistent snapshot **while the platform is serving traffic**. No
locking, no downtime, no torn read across the WAL boundary — which is exactly
what copying `solcoin.db` with `cp` gives you if a write lands mid-copy.

Be aware: **nothing in the shipped build calls `backupDatabase`.** There is no
backup endpoint, no CLI command and no scheduled backup job. It is an exported
function waiting for a caller. Until one exists, use the `sqlite3` CLI's
`.backup`, which uses the same online backup API:

```bash
#!/usr/bin/env bash
# /usr/local/bin/solcoin-backup
set -euo pipefail

DB=/var/lib/solcoin/solcoin.db
DEST=/var/backups/solcoin
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$DEST"

# Online backup: consistent snapshot without stopping the service.
sqlite3 "$DB" ".backup '$DEST/solcoin-$STAMP.db'"
sqlite3 "$DEST/solcoin-$STAMP.db" 'PRAGMA integrity_check;' | grep -qx ok

# Generated artwork. Small, and the only copy outside IPFS.
tar -czf "$DEST/artwork-$STAMP.tar.gz" -C /var/lib/solcoin artwork

gzip -9 "$DEST/solcoin-$STAMP.db"
find "$DEST" -name 'solcoin-*.db.gz'   -mtime +30 -delete
find "$DEST" -name 'artwork-*.tar.gz'  -mtime +30 -delete
```

```cron
# /etc/cron.d/solcoin-backup
17 * * * * solcoin /usr/local/bin/solcoin-backup >>/var/log/solcoin-backup.log 2>&1
```

Hourly is reasonable: the database is small (megabytes, not gigabytes) and an
hour of lost trend data costs nothing, whereas an hour of lost launch and fee
records costs bookkeeping accuracy.

### What else to back up

1. **`DATA_DIR/artwork/`** — the local copy of every generated image. Launched
   tokens reference IPFS URIs produced by the storage provider, so losing this
   does not break any token; it loses your own provenance copy.
2. **`SOLCOIN_MASTER_KEY`** — separately, somewhere the database backup is not.

> **A database backup without the master key is useless for credentials.** Every
> row in the `secrets` table is AES-256-GCM ciphertext under a scrypt-derived key
> from that passphrase, and the operating wallet's private key sits inside a
> second envelope within it. Restore the database with the wrong key and you get
> a fully working platform with zero credentials, no wallet, and a log line
> reading `failed to decrypt secret — the master key may have changed since this
> secret was stored`. There is no recovery path. Store the key in a password
> manager or a secrets manager, and verify you can read it back **before** you
> need to.

This cuts both ways and is the point: an attacker who exfiltrates only the
database file gets analytics and an audit trail, not your wallet.

### Restore

```bash
systemctl stop solcoin

# Keep what is there; a "restore" onto a live file is how you lose both copies.
mv /var/lib/solcoin/solcoin.db     /var/lib/solcoin/solcoin.db.pre-restore
rm -f /var/lib/solcoin/solcoin.db-wal /var/lib/solcoin/solcoin.db-shm

gunzip -c /var/backups/solcoin/solcoin-20260829T031700Z.db.gz \
  > /var/lib/solcoin/solcoin.db
chown solcoin:solcoin /var/lib/solcoin/solcoin.db

tar -xzf /var/backups/solcoin/artwork-20260829T031700Z.tar.gz -C /var/lib/solcoin

sqlite3 /var/lib/solcoin/solcoin.db 'PRAGMA integrity_check;'   # expect: ok

# Same master key as the backup, or the secrets are gone.
systemctl start solcoin
# Run doctor as the service user, from the service's working directory.
```

Delete the `-wal` and `-shm` files: they belong to the *old* database and pairing
them with a restored file is undefined behaviour. A backup taken with the online
backup API is already fully checkpointed.

Then check three things in `doctor` output specifically:

- **Audit chain** — `ok    Audit chain    N entries verified`. A restored file
  that fails here was corrupted in transit.
- **Secret store** — `Master key present.`, and providers that were configured
  before are not now `unconfigured`. If they are, the master key does not match.
- **Wallet** — the expected address, custody and `this process can sign`.

Migrations run automatically on the next boot, so a backup from an older schema
is upgraded in place. Restoring a backup from a *newer* schema onto an older
build is not supported.

---

## Database maintenance

The connection is opened (in `db/client.ts`) with `journal_mode=WAL`,
`synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`,
`cache_size=-64000` (64 MiB), `temp_store=MEMORY`, `mmap_size=268435456` and
`auto_vacuum=INCREMENTAL`.

`synchronous=NORMAL` in WAL mode survives a process crash intact; only a power
loss or kernel panic can lose the last transaction. That is the trade being made
for write throughput, and it is the right one here — the platform's writes are
recoverable observations, and the launch path has its own idempotency machinery.

### Checkpointing and vacuum

Two places handle it, and no cron job should duplicate them:

| When | What |
|---|---|
| `maintenance` job, hourly | `PRAGMA incremental_vacuum(200)` then `PRAGMA wal_checkpoint(PASSIVE)` |
| `closeDatabase()`, on shutdown | `PRAGMA wal_checkpoint(TRUNCATE)` — best-effort; a locked database still closes cleanly |

`incremental_vacuum(200)` reclaims up to 200 pages per run rather than doing a
full `VACUUM`, which would need to rewrite the entire file while holding an
exclusive lock. `PASSIVE` checkpointing never blocks a reader or writer; it just
does less work when the database is busy. Between them the WAL stays bounded
without a maintenance window.

If the WAL has grown large after a long busy period and you want it collapsed
immediately, restarting the service is the supported way — shutdown runs
`TRUNCATE`.

### What `maintenance` prunes

| Table | Rule |
|---|---|
| `ai_cache` | `expires_at` in the past |
| `idempotency_keys` | `expires_at` in the past |
| `system_events` | older than **30 days** |
| `job_runs` | older than **14 days** |
| `market_observations` | older than **30 days**, and only for tokens whose `lifecycle` is `dormant` or `failed` |
| concepts | `concepts.expireStale()` |
| trends | `trends.prune({})` |
| sessions | `auth.pruneSessions()` |

`market_observations` is the largest table by a wide margin; thinning the history
of dormant and failed tokens while keeping every observation for live ones is the
compromise. `competitor_tokens` is pruned separately by `market-scan` (rows whose
`created_on_chain_at` is more than 30 days old).

> **The audit log is never pruned.** `audit_log` is a hash-chained record — each
> row's hash covers the previous one — so deleting a row breaks the chain and
> `verifyChain` will point at exactly where. It grows without bound, deliberately.
> That is the trade: an append-only record of what the platform did, on whose
> authority, with which model version. If it ever becomes a size problem, archive
> whole prefixes rather than deleting rows, and expect `verifyChain` to report the
> gap.

Retention windows for the pruned tables are hardcoded in `jobs/definitions.ts`,
not configurable at runtime.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Process exits immediately, nothing in the log | `loadEnv()` threw before the logger existed. The message goes to **stderr** as `Failed to start: Error: Invalid environment configuration:` followed by the offending fields. Under systemd with stderr discarded you see nothing. | `journalctl -u solcoin -n 50`. Check every field it names. |
| `Invalid environment configuration: SOLCOIN_MASTER_KEY: String must contain at least 16 character(s)` after `cp .env.example .env` | `.env.example` ships `SOLCOIN_MASTER_KEY=` (and `BOOTSTRAP_EMAIL=`, `BOOTSTRAP_PASSWORD=`) as **empty strings**, and an empty string is not the same as unset — it is parsed and fails validation. | Fill the key in, or delete the empty lines entirely. Same for the two bootstrap variables. |
| `The secret store is locked. Set SOLCOIN_MASTER_KEY (at least 16 characters) and restart to enable credentialed features.` | `SOLCOIN_MASTER_KEY` is unset in the process's environment. | Set it and restart. The key is read only at boot. |
| `SOLCOIN_MASTER_KEY is not set; the wallet cannot be unlocked.` | The same condition reaching the keystore. | As above. |
| A provider stays `unconfigured` after you saved its key | Either the secret store is locked (nothing was stored), or the key was stored under a **different** master key and now fails to decrypt. | Look for `failed to decrypt secret — the master key may have changed since this secret was stored`. If the master key changed, the old secrets are unrecoverable: delete and re-enter them. `PUT /api/system/secrets/:key` calls `refreshProviders()`, so a correct save takes effect immediately with no restart. |
| `<provider> circuit is open until <ISO timestamp>` | The HTTP client tripped its breaker after **6** consecutive failures (`providers/http.ts`), holding it open for a fixed **120 s** — some providers configure their own, e.g. GDELT 4 failures / 5 minutes, notifications 8 / 5 minutes. A *separate* streak counter in `health.service.ts` opens after 5 failures with a cooldown that doubles from 30 s to a 15-minute ceiling, and that is what the provider health component reports. | Usually a third party having a bad day. Nothing to do; it self-heals. If it never closes, check the credential and the endpoint. |
| `Blockhash was not found by the RPC node; rebuild the transaction.` (`transaction_expired`) | The RPC node has not seen the blockhash the transaction was signed against — usually a lagging or load-balanced public endpoint. | Configure a dedicated RPC (Helius key or your own URL). The error is marked retryable and `launch-recovery` will resolve the launch record. |
| `Transaction <sig> expired: block height N passed M without confirmation.` | The transaction was broadcast but never landed within its blockhash validity window — congestion, or a priority fee too low for current conditions. | With `execution.priorityFeeMicroLamports: 0` the fee is auto-estimated at the 75th percentile of recent fees; set an explicit, higher value if launches keep expiring. Never re-sign by hand — re-signing creates a *second* transaction that could also land. |
| `Daily AI budget exhausted: $X of $Y spent in the last 24 hours.` | `limits.maxAiSpendUsdPerDay` (default **$10**) reached. The counter is a `SUM(cost_usd)` over `ai_requests` in the last 24 hours, derived from the database, so a restart does not reset it. | Raise the limit (hard ceiling **$200/day**), or reduce `research.conceptsPerOpportunity` (default 4) / disable the evaluation panel. |
| `No launch adapter is available for the "<network>" network.` | No adapter is registered for the configured network — almost always mainnet or devnet selected with no RPC configured, so `pumpfun_sdk` never got built. Note that `execution.adapter` accepts `pumpportal_local`, but no adapter with that id is registered by this build; choosing it silently falls back to whichever adapter serves the network, exactly as `auto` would. | `npm run doctor` prints every adapter and its readiness reason. |
| Launching stops: `N consecutive launch failures. Launching is halted until the cause is resolved and the counter is cleared.` | `limits.consecutiveFailureShutdown` (default **3**) reached. Separately, the launch failure handler calls `guard.autoStop()` at the same threshold, which engages the global emergency stop. | Find the *first* failure — the later ones are usually the same cause. Fix it, then `POST /api/system/emergency-release` with a reason. The counter clears when a launch succeeds. |
| Everything paused, dashboard still updating | Emergency stop engaged. Jobs with side effects are skipped; read-only jobs keep running by design, so the dashboard stays accurate while paused. | `GET /api/system/status` → `emergencyStopReason`. Release when resolved. |
| `does not provide an export named 'BN'` (or similar) at startup | Someone is running the server unbundled — `node src/main.js`, `tsx src/main.ts`, or a loader that skips esbuild. `@coral-xyz/anchor` is CommonJS-only and other packages import named bindings from it; Node's ESM loader resolves those by statically lexing the CJS module and fails. | Run the bundle: `npm run build && npm start`. This is a correctness requirement, not a packaging preference — see `packages/server/build.mjs`. |
| Migrations fail at boot, or the schema is empty | The `.sql` files were not shipped. They stay in `packages/server/src/db/migrations`; the build does not copy them into `dist`. | Ship that directory and run from a working directory where one of the four `migrationsFolder()` candidates resolves — the repository root is candidate 3. Verify with `ls packages/server/src/db/migrations/meta/_journal.json`. |
| `SQLITE_BUSY` / `database is locked` | Two writers. Almost always a second process on the same file — a stray instance, `npm run dev` alongside the service, or a `sqlite3` shell with an open write transaction. | `busy_timeout` is 5000 ms, so brief contention is absorbed. Sustained errors mean a genuine second writer; find and stop it. Never place the database on a network filesystem. |
| Sign-in appears to succeed but you are immediately signed out | `NODE_ENV=production` sets the session cookie `Secure`, and the browser will not return it over plain HTTP. | Terminate TLS in front of the app (see [Reverse proxy](#reverse-proxy)). |
| `Cannot find module 'pino-pretty'` | `LOG_PRETTY=true` in an image built with `--omit=dev` / `npm prune --omit=dev`. `pino-pretty` is a devDependency and is external to the bundle. | Unset `LOG_PRETTY` in production; JSON is the correct output there anyway. |
| `Cannot find module 'better-sqlite3'`, or `invalid ELF header` / `NODE_MODULE_VERSION mismatch` | The native module is missing, or was compiled for a different platform, libc or Node major version. | Build and run on the same base image. Do not copy `node_modules` between glibc and musl, or between Node majors. |
| Every job overdue; health says the scheduler loop is not running | The process has the scheduler disabled, or the tick has died. | Check for `Scheduler disabled by DISABLE_SCHEDULER`. If unexpected, restart — the schedule is durable and resumes from `job_state`. |
| `GET /api/jobs` returns an empty list on one node | That process runs with `DISABLE_SCHEDULER`; `scheduler.status()` only reports jobs registered in the current process. | Expected. Query the node that runs the scheduler, or read `job_state` directly. |
| A settings change had no effect | In a split deployment, settings are cached per process and never invalidated across processes. | Restart the scheduler process, or make the change on it. Do not run split unless you need to. |
| Audit chain `valid: false` at sequence N | A row in `audit_log` was deleted or modified. | Treat as a security event before treating it as a bug. Correlate with `system_events` and filesystem access around that timestamp. |
| Clock component `down` | The wall clock jumped more than `limits.maxClockDriftSeconds` (default 120 s) relative to the monotonic reference taken at startup — an NTP step, a VM resume, or a manual change. | Re-sync via NTP and **restart** — the reference is taken once at construction. Blockhash expiry and job scheduling both depend on wall-clock time. |

---

## Cost expectations

### What actually costs money

| Item | Figure in the code | Where |
|---|---|---|
| Mainnet launch, create-only | **0.00551 SOL** — Token-2022 mint rent 3,700,000 + bonding-curve account rent 1,800,000 + base transaction fee 10,000 lamports | `providers/solana/pumpfun-adapter.ts`, measured on chain |
| Launch with a developer buy | the above **+ 2,074,080 lamports** associated-token-account rent **+ the buy itself** | same |
| Priority fee | Small. `execution.priorityFeeMicroLamports` defaults to **0**, which means *auto-estimate*, not *no fee*: the RPC pool takes the 75th percentile of `getRecentPrioritizationFees` for the accounts being touched, floored at **1,000 µlamports/CU** (**10,000** if the node does not implement the method). At the floor, a 400,000-CU launch pays 400 lamports. | `providers/solana/rpc.ts` |
| Fee collection transaction | ~**0.00002 SOL** modelled | `DEFAULT_ECONOMICS.feeCollectionCostSol` |
| AI per candidate | **0.004 SOL** modelled | `DEFAULT_ECONOMICS.candidateCostSol` |
| Artwork | **$0** by default (`ai.imageModel: 'none'` → procedural SVG). With OpenAI: `gpt-image-1` **$0.19**, `dall-e-3` **$0.08**, `dall-e-2` **$0.02** per image; an unrecognised model is charged **$0.25** | `providers/ai/openai.ts` |
| RPC, IPFS pinning, YouTube/Reddit data | no figures exist in the code — these are third-party plans priced by the vendor | — |

One inconsistency to know about: the adapter's `costBreakdown` computes the
priority-fee line as `ceil(400,000 × execution.priorityFeeMicroLamports ÷
1,000,000)`, using the raw setting. With the default of `0` that line reads zero
while the transaction actually submitted pays the auto-estimated fee. The
amounts are small enough not to matter for budgeting, but the estimate is not
the payment.

The rents are not fees: they sit in accounts that the mint keeps. The mint's
rent-exempt minimum is **permanently stranded** — it is not recoverable, and the
same is true of the bonding-curve vault's rent-exempt minimum, which is why the
claimable fee figure is always below the raw vault balance.

Note a real discrepancy: `DEFAULT_ECONOMICS.launchCostSol` is **0.025 SOL**,
roughly 4.5× the adapter's measured create-only breakdown. That is the prior the
expected-value model spends against — deliberately conservative, and it leaves
headroom for a priority fee and a small dev buy. Actual spend recorded against a
launch comes from the adapter's `costBreakdown`, not from this constant. The
guard's own pre-flight assumes `devBuySol + 0.006 SOL` per launch.

### AI, concretely

The default model settings are `claude-haiku-4-5-20251001` for triage (a dated
alias the router resolves to `claude-haiku-4-5`), `claude-sonnet-5` for
generation and `claude-opus-5` for the decision tier. List prices recorded in
`providers/ai/anthropic.ts` (USD per million tokens):

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| `claude-opus-5` | 5.00 | 25.00 | 0.50 | 6.25 |
| `claude-sonnet-5` | 2.00 | 10.00 | 0.20 | 2.50 |
| `claude-haiku-4-5` | 1.00 | 5.00 | 0.10 | 1.25 |

Those prices are a snapshot recorded in the source (dated `2026-06-24`) and
nothing re-checks them at runtime. **Every cost the platform reports is an
estimate**, good enough to drive a budget control and rank spend by purpose, and
not an invoice. An unrecognised model is charged at the most expensive known rate
so that a typo in a settings field cannot silently disable the budget ceiling.

Only two of those three tiers are ever actually requested. Every AI call in the
shipped code is `tier: 'generation'` (concept generation and the `skeptic`,
`market_analyst` and `risk` panel roles) except `creative_critic`, which is
`tier: 'triage'` and is off by default. **No code path requests the `decision`
tier**, so `ai.decisionModel` — and the opus row in the table above — is
configuration with no current caller.

Per qualifying opportunity, with the shipped defaults: **one** generation-tier
call produces all `research.conceptsPerOpportunity` concepts (**4**) in a single
response, and then each of those 4 concepts is run past the 3-role panel — one
generation-tier call per role. That is 1 + 12 = **13 generation-tier calls per
opportunity**, not per candidate. Identical prompts are cached for
`ai.cacheTtlMinutes` (**240**) and cost nothing on a hit.

Do not budget from that arithmetic. Budget from the ceiling: **`limits.maxAiSpendUsdPerDay`
defaults to $10/day**, is enforced from a database sum rather than an in-memory
counter, and cannot be raised above **$200/day** by any code path.

### The spending envelope

`clampSettings()` in `services/settings.service.ts` rewrites any value above its
ceiling on every read and every write, so these are hard, not advisory. Several
are also clamped *relative to another setting*, which is easy to miss:

| Setting | Default | Absolute ceiling |
|---|---|---|
| `limits.maxLaunchesPerHour` | 1 | 20 (schema max), then clamped to `maxLaunchesPerDay` |
| `limits.maxLaunchesPerDay` | 3 | **24** (`HARD_LIMITS`; the schema alone allows 50) |
| `limits.maxSolPerTransaction` | 0.15 SOL | **2 SOL** (`HARD_LIMITS`) |
| `limits.maxSolPerHour` | 0.3 SOL | clamped to `maxSolSpendPerDay`, so **5 SOL** |
| `limits.maxSolSpendPerDay` | 0.5 SOL | **5 SOL** (`HARD_LIMITS`) |
| `limits.maxAiSpendUsdPerDay` | $10 | **$200** (`HARD_LIMITS`) |
| `limits.walletBalanceFloorSol` | 0.05 SOL | not clamped |
| `execution.devBuySol` | **0** | 5 (schema max), then clamped to `maxSolPerTransaction` — so **0.15 SOL** at the shipped limits and **2 SOL** at the absolute maximum |
| `research.conceptsPerOpportunity` | 4 | 12 |

At the shipped defaults, a fully busy day is 3 launches — around **0.017 SOL** of
rent and fees — plus at most **$10** of AI. The dev buy is the variable that
turns a small cost into a large one, and it is zero by default.

### Revenue

Plainly: **most launches earn nothing.** That is a property of the market, not of
this software, and the analytics are built to make it visible rather than to
average it away.

The platform earns only when independent people voluntarily trade a token it
created. The creator's share is **30 bps of bonding-curve volume**
(`creatorFeeRateCurve: 0.003`, verified on chain) and a market-cap-indexed share
on canonical PumpSwap pools that runs from 95 bps just after graduation down to
5 bps at very large caps — `creatorFeeRateAmm: 0.006` is the blended rate a
typical graduate is modelled to earn across its active life. A token that nobody
trades produces exactly zero of both, and the rent already spent is not returned.

Expected value is computed by Monte Carlo over the joint outcome distribution and
reported with its median and percentiles, because the mean of a heavy-tailed
distribution is misleading on its own. Until real launches accumulate, every
probability is an encoded prior rather than a measurement — `doctor` says so
explicitly (`No real outcomes yet, so predictions are informed priors rather than
measurements`). Treat the first few dozen launches as the cost of finding out.

---

## Upgrading

Migrations are Drizzle-generated `.sql` files in
`packages/server/src/db/migrations`, tracked by `meta/_journal.json`. They are
applied **automatically at boot** by `runMigrations(db)` inside
`createContainer()` — there is no separate deploy step to forget. `npm run
db:migrate` delegates to the server workspace's `node dist/cli/migrate.js`, which
runs the same function standalone against `DATABASE_PATH` — useful for applying a
schema change before starting the new binary. Because npm runs a workspace script
with that package as the working directory, the migrations folder resolves via
candidate 4 (`<cwd>/src/db/migrations`) there rather than candidate 3.

There is no down-migration path. Rolling back a schema change means restoring a
backup.

```bash
# 1. Back up first. Non-negotiable: migrations are one-way.
/usr/local/bin/solcoin-backup

# 2. Fetch and build.
cd /opt/solcoin
git fetch && git checkout <tag>
npm ci
npm run build

# 3. Optional: apply migrations before the swap, to shorten the outage.
#    Run as the service user — root would leave root-owned -wal/-shm files
#    behind. DATABASE_PATH comes from the environment, so pass the real one.
sudo -u solcoin DATABASE_PATH=/var/lib/solcoin/solcoin.db \
  node packages/server/dist/cli/migrate.js

# 4. Restart. Migrations run again on boot; already-applied ones are skipped.
systemctl restart solcoin

# 5. Verify (doctor as the service user, from this directory — see above).
journalctl -u solcoin -n 100
```

Check three things in step 5: the boot log's `solcoin is ready` line shows the
expected `network` and `phase`; `doctor` reports the audit chain valid; and the
providers that were configured before are still configured (if they are not, the
master key did not survive the deploy).

For Docker, the same shape: back up the volume, `docker compose build`, `docker
compose up -d`. The volume carries the database across the image swap, and
migrations run on the new container's first boot.

Restarting during an in-flight launch is survivable but should be avoided.
Shutdown aborts running jobs and gives them 5 seconds to unwind; a launch that
was broadcast but not confirmed is picked up by `launch-recovery` within a few
minutes and resolved against the chain. That machinery exists to survive a crash,
not to be relied on routinely — `systemctl stop`, wait for `shutdown complete`,
then deploy.

---

## See also

| | |
|---|---|
| [Configuration](configuration.md) | Every environment variable and setting, with defaults and tuning guidance |
| [Security](security.md) | Threat model, key custody, the audit log, prompt-injection defence |
| [Architecture](architecture.md) | How the pieces fit and why each choice was made |
