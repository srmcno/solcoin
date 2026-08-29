# Architecture

How the pieces fit together, and why each choice was made. This document
describes what is in the code today, including the places where the code is
less tidy than the design intent.

---

## The shape: one process, hard internal boundaries

Solcoin is a modular monolith. One Node process holds the HTTP API, the job
scheduler, every service, and an embedded SQLite database. There is no message
broker, no service mesh, and no separate worker tier.

That is a deliberate fit to the workload, not a shortcut:

- **The work is bounded by other people's rate limits, not by CPU.** Discovery
  polls ten trend sources on intervals measured in minutes. The candidate
  pipeline runs every 30 minutes and processes at most three trends per cycle.
  The heaviest job, `token-monitor`, runs every 60 seconds against a list of
  mints. Nothing here saturates a single core.
- **Almost every operation needs several of the same facts.** Scoring a trend
  needs the trend graph, the market snapshot, the competitor cache and the
  settings. Splitting those across services would convert local reads into
  network calls and add failure modes without removing any.
- **The correctness-critical path is a single transaction, once.** A launch must
  never happen twice. In one process with one database, that is a unique index
  plus a deterministic key. Distributed, it becomes a consensus problem, and
  the failure it protects against costs real money.
- **The deployment target is one operator on one machine.** An operational
  footprint of "one binary, one file" is a feature for that audience.

The boundaries are still real — they are just compile-time rather than network
boundaries. Services take their dependencies as constructor arguments, providers
sit behind interfaces, and the pure decision logic lives in a package that
performs no I/O at all.

### The three packages

| Package | Responsibility | Constraint |
|---|---|---|
| `@solcoin/shared` | Statistics, time-series, scoring, saturation, originality, the prediction model, Thompson sampling, the risk lexicon, prompt-injection detection, settings and enum schemas, pump.fun economics | No I/O of any kind: the package imports nothing from `node:`, calls no `fetch`, and its only dependency is `zod`. It also reads no ambient state — no `Date.now()`, no `Math.random()`; randomness comes from a seeded RNG (`math/random.ts`) and time is always a parameter. The rule is enforced: `eslint.config.js` restricts `node:*` imports, `fetch` and `process` in this package, and rejects `Date.now()`, `new Date()` and `Math.random()` outright. Compiled with `tsc` to `dist/` and consumed as a normal workspace dependency. |
| `@solcoin/server` | Database and migrations, providers, services, jobs, security (auth, secrets, keystore, audit), the Fastify HTTP API | Bundled with esbuild into `dist/main.js`. Owns all state. |
| `@solcoin/web` | React 19 dashboard, built by Vite, served as static files by the server | Talks only to the server's `/api` surface. No direct access to anything else. |

The `shared` constraint is what makes the interesting logic testable. Opportunity
scoring, expected-value Monte Carlo and the risk screen are all deterministic
functions of their inputs, so `tests/unit` exercises them without a database, a
network or a clock. `vitest.config.ts` aliases `@solcoin/shared` straight at
`packages/shared/src/index.ts`, so tests run against sources rather than a stale
build.

---

## Data flow: trend signal to launched token to model update

```
 EXTERNAL SOURCES                JOBS                        SERVICES / TABLES
 ────────────────                ────                        ─────────────────

 google_trends  ┐
 bluesky        │
 mastodon       │        trend-discovery                       ResearchService
 wikipedia      ├──────▶ (research.discoveryIntervalMinutes) ─▶ TrendService
 hackernews     │        side effects: yes                     ├─▶ trends
 gdelt          │                                              └─▶ trend_observations
 stackexchange  │
 rss            │        identity resolution, then confirmation weighted by
 youtube*       │        SOURCE_INDEPENDENCE family — search, reference, news,
 reddit*        ┘        social, forum, video, onchain, manual
                         (* needs credentials)
                                     │
 jupiter        ┐        market-scan │  MarketProvider.recentLaunches()
 dexscreener    ├──────▶ (900 s) ────┼─▶ market_snapshots, competitor_tokens
 pump.fun API   ┘                    │
                                     ▼
                         candidate-pipeline (1800 s)  ── PipelineService.run()
                                     │
              cheapest filter first: │
              ┌──────────────────────┴────────────────────────────────┐
              │ 1. sampleCompetitors()   market providers + cache      │
              │ 2. ConceptService.generate()        → concepts         │
              │ 3. screenRisk()  deterministic, free, cannot be argued │
              │    past by a model                                     │
              │ 4. EvaluationService (adversarial panel)               │
              │                            → concept_evaluations       │
              │ 5. PredictionService.predict()      → predictions      │
              │ 6. QualityGateService.evaluate()                       │
              │ 7. rank the slate, keep ONE winner per trend           │
              │ 8. ArtworkService.produce()  → IPFS metadata_uri       │
              └──────────────────────┬────────────────────────────────┘
                                     ▼
                       concepts.status = awaiting_approval | approved
                                     │
                         launch-queue (120 s)
                                     │
                              LaunchService.launch()
                                     │
                    GuardService.checkLaunch()  ── emergency stop, autonomy,
                                     │             per-tx / hourly / daily SOL
                                     │             caps, balance floor, hourly
                                     │             and daily launch counts,
                                     │             consecutive-failure breaker
                                     ▼
                    INSERT launches (idempotency_key)   ← claim before any
                                     │                    side effect
                    LaunchAdapter.prepare()  simulation | pumpfun_sdk
                                     │
                    SolanaRpc.sendTransaction()
                      sign once → onSigned persists signature
                      → rebroadcast identical bytes
                      → poll getSignatureStatuses
                                     ▼
                            launches.status = confirmed
                                     │
                    MonitoringService.registerToken() → tokens
                                     │
        ┌────────────────────────────┼──────────────────────────────┐
        ▼                            ▼                              ▼
 token-monitor (60 s)        fee-detect (600 s)          token-lifecycle (3600 s)
 → market_observations       → creator_fee_events        → tokens.lifecycle,
 → tokens (denormalised)       (accrual_snapshot)          tokens.monitor_tier
                                     │
                              fee-collect (3600 s)
                              → claim to operating wallet
                              → creator_fee_events (collection)
                                     │
        ┌────────────────────────────┘
        ▼
 learning-outcomes (3600 s)  horizons 24 h, 72 h, 168 h
 → prediction_outcomes   (joined to the verbatim feature vector stored at
                          decision time, which is what makes the evaluation
                          fair rather than retrospective)
        │
        ▼
 model-train (21 600 s) → LearningService.train() → model_versions
        │                  a new version becomes active only if it improves
        ▼
 PredictionService picks up the active bundle → next candidate-pipeline run
```

Every arrow crossing a job boundary goes through the database. Nothing is passed
in memory between jobs, so a restart in the middle of any stage resumes from
persisted state rather than losing work.

---

## The composition root

`packages/server/src/container.ts` constructs everything, once, with explicit
dependencies. There is no service locator, no module-level singleton holding a
database handle, and no `getDb()`.

```ts
const events = new EventBus();
const audit = new AuditLog(db, now);
const auth = new AuthService(db, audit, now);
const secrets = new SecretStore(db, env.SOLCOIN_MASTER_KEY, now);
const settings = new SettingsService(db, audit, events, now);
const guard = new GuardService(db, settings, audit, events, now);
```

Two things fall out of this that matter more than the tidiness:

**Time is injected.** Every service takes `now: () => number`, sourced from a
`Clock` (`core/clock.ts`). `createFixedClock(startMs)` gives tests a timeline
they control, including a `sleep` that advances the clock instead of waiting.
Backtests and the simulation adapter use the same mechanism. No service body
calls `Date.now()`; the only `Date.now` in the service layer is the constructor
default (`now: () => number = Date.now`), which the container always overrides
with the clock.

**The database is a parameter.** The container takes its handle as an argument
rather than reaching for a module-level one, and `ContainerOptions` accepts `db`
and `skipMigrations` for a caller that wants to supply its own — though no
caller does today. `tests/e2e/workflow.test.ts` instead points `DATABASE_PATH`
at a temporary file, builds the real container over it, and drives the whole
workflow through the real HTTP surface with `app.inject`.
`tests/helpers.ts` deliberately uses a file-backed database rather than
`:memory:`, because the platform depends on WAL, `busy_timeout` and incremental
vacuum, and testing a differently-configured engine tests the wrong thing.

### Rebuilding providers at runtime

Credentials are added from the dashboard, not from the environment. A platform
that needed a restart to notice a newly-pasted API key would fail its own
first-run experience, so `refreshProviders()` reconstructs the provider graph in
place:

1. `buildRpc(network, getCredential)` builds a fresh `SolanaRpc` endpoint pool.
   A configured RPC URL gets priority 0, Helius priority 1, and the public
   endpoints priorities 5–6. Public endpoints are always appended: a platform
   that stops working because one provider is down is worse than one that runs
   slowly.
2. The adapter map is cleared and repopulated — `simulation` always, plus
   `pumpfun_sdk` when the network is not `simulation` and RPC exists. A failure
   constructing the on-chain adapter is logged and swallowed; the platform still
   boots.
3. `buildAllProviders()` reconstructs every trend, market, AI and image
   provider from current settings and credentials.
4. Services holding direct provider references are rebound.

Step 4 is the ugly part, and it is worth being honest about it:

```ts
(concepts as unknown as { ai: unknown }).ai = built.aiRouter;
(evaluation as unknown as { ai: unknown }).ai = built.aiRouter;
(artwork as unknown as { imageProvider: ImageProvider | null }).imageProvider = built.imageProvider;
(wallet as unknown as { rpc: SolanaRpc | null }).rpc = state.rpc;
```

Those four services are constructed with `{} as never` or `null` in the provider
slot and patched afterwards through a cast. It works, and the cast is confined
to this one function, but it defeats the type system at exactly the point where
the container's contract is being established. The array-shaped collections avoid
the problem properly: `state.marketProviders` is mutated in place
(`length = 0` then `push(...)`) so `PipelineService`, which was handed the array
at construction, sees the new contents without rebinding. `state.adapters` is a
`Map` shared with `LaunchService` for the same reason. `trendProviders` is
reassigned rather than mutated, which is safe only because every consumer reads
it through the container's getter.

The container also owns the **mint derivation secret**. It is generated with
`randomBytes(32)` on first use and stored encrypted under the key
`execution.mint_derivation_secret`. If the secret store is locked, the launch
path refuses rather than falling back to something derived from the master key —
a deterministic fallback would be predictable, and anyone able to predict a
future mint address could front-run it.

---

## Data layer: SQLite and Drizzle

`packages/server/src/db/client.ts` opens one `better-sqlite3` handle and wraps
it in Drizzle. The Drizzle handle also exposes the raw driver as `db.$raw`.

### Why SQLite is the right choice here

- **Single node.** There is exactly one writer. The main argument for a client/
  server database — many processes contending for the same data — does not
  apply. `DISABLE_SCHEDULER` exists so a second process can serve the API
  read-mostly, and even that is an unusual deployment.
- **Write volume is bounded by third-party rate limits.** The write-heavy path is
  `market_observations`, one row per token per poll, with polling frequency set
  by the token's monitor tier. Peak load is a few hundred writes a minute. That
  is roughly two orders of magnitude below what a local SQLite file handles
  comfortably.
- **WAL gives concurrent readers.** The dashboard polls analytics endpoints
  continuously while jobs write. In WAL mode readers never block the writer and
  the writer never blocks readers, which is the only concurrency property this
  workload actually needs.
- **`synchronous = NORMAL` has the right durability shape.** In WAL mode this
  fsyncs the WAL at checkpoints rather than at every commit. A process crash —
  the failure this platform actually has to survive, since it is the one the
  idempotency machinery is built around — loses nothing. Only a power loss or
  kernel panic can lose the last transaction or two. Paying `FULL`'s fsync per
  commit to protect against that is the wrong trade for this data.
- **Backup is one atomic call.** `backupDatabase()` uses SQLite's online backup
  API, which is safe to run while the server is serving traffic, and produces a
  single consistent file. Compare with the operational apparatus needed for a
  consistent Postgres snapshot.
- **No operational dependency.** `npm install && npm start` produces a working
  system with no separate service to provision, secure or upgrade.

### The pragmas

Set in `openDatabase()`, in this order:

| Pragma | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | Concurrent readers alongside the writer; commits append to a log rather than rewriting pages. |
| `synchronous` | `NORMAL` | Durable across process crashes; only a power loss can lose the tail. Avoids an fsync per commit. |
| `foreign_keys` | `ON` | Off by default in SQLite. The schema declares cascades and `set null` behaviours that are inert without this. |
| `busy_timeout` | `5000` | Wait up to five seconds for the write lock instead of throwing `SQLITE_BUSY` immediately. |
| `cache_size` | `-64000` | 64 MiB page cache (negative means KiB). The working set is small; this keeps analytics queries off disk. |
| `temp_store` | `MEMORY` | Sorts and temporary b-trees stay in memory. Analytics does a fair amount of grouping. |
| `mmap_size` | `268435456` | 256 MiB memory-mapped I/O, avoiding a copy on read-heavy paths. |
| `auto_vacuum` | `INCREMENTAL` | The `maintenance` job deletes old observations hourly. Incremental vacuum reclaims those pages via `incremental_vacuum(200)` without a full `VACUUM`, which would need to rewrite the whole file and hold an exclusive lock. |

`closeDatabase()` runs `wal_checkpoint(TRUNCATE)` before closing, so a clean
shutdown leaves a single file with an empty WAL. The `maintenance` job runs
`wal_checkpoint(PASSIVE)` hourly to keep the WAL from growing without bound
during normal operation.

### When SQLite would stop being appropriate

Stated plainly, because the answer is not "never":

- **More than one writing process.** Two schedulers on two machines against a
  shared file over a network filesystem will corrupt it. The job lease mechanism
  is designed for it, but the storage layer is not. This is the first thing that
  breaks.
- **Sustained write rates above a few thousand per second**, or any single write
  transaction long enough to starve the others — SQLite serialises writers
  globally.
- **Analytics over tens of millions of observation rows.** There is no parallel
  query execution and no cost-based optimiser worth the name. The `daily_metrics`
  rollup table exists precisely to defer this, but it defers rather than
  removes.
- **A separate reporting or BI consumer** that wants to connect over the network.
- **Point-in-time recovery** finer than the backup interval, or streaming
  replication.

None of those describe a single operator running one instance. All of them are
plausible if the platform grows.

### The Postgres-swap claim, honestly

The comment in `db/client.ts` says the repository layer avoids SQLite-specific
SQL, so a move to Postgres would be a driver swap. **That is aspirational rather
than true of the current code.** The actual counts:

- 252 uses of `db.$raw.prepare(...)` across 37 files — raw SQL against the
  synchronous `better-sqlite3` API — plus 21 further `$raw.pragma` /
  `$raw.transaction` / `$raw.backup` calls and the 8 pragmas in
  `openDatabase()`.
- 5 uses of the Drizzle query builder, all of them in `security/secrets.ts` and
  `security/audit.ts`.

Two concrete obstacles, in increasing order of pain:

1. **Dialect.** `json_patch(...)` in `PipelineService.recordGateChecks` and
   `unixepoch('subsec')` in the schema defaults are SQLite-only, as are the
   pragmas, `incremental_vacuum`, `wal_checkpoint`, the `pragma_page_count()`
   table-valued function in `backupDatabase()` and the online backup API itself.
   `ON CONFLICT` (15 uses) is fine — Postgres supports it.
2. **Synchrony.** `better-sqlite3` is synchronous; every Postgres driver is
   async. Services call `.prepare().run()` and `.get()` inline, without
   `await`, all over the codebase. Converting them means making a large fraction
   of the service layer async and revisiting every call site.

What *is* true and does carry over: the schema itself is largely portable (no
SQLite-only column types, no `rowid` dependence, IDs generated in application
code, timestamps stored as plain integers and written explicitly by almost every
insert — the `unixepoch` column default is the one piece that needs rewriting),
and the query shapes are ordinary SQL. A migration would be substantial
mechanical work, not a rewrite of the design — but it would not be a driver swap.

---

## The schema

`packages/server/src/db/schema.ts`, grouped as it is in the file.

**Identity and access control**

| Table | Purpose |
|---|---|
| `users` | Accounts, scrypt password hash with its parameters, optional encrypted TOTP secret, lockout counters. |
| `sessions` | Active login sessions. |

**Configuration and secrets**

| Table | Purpose |
|---|---|
| `settings` | A single row (`id = 'current'`) holding the live configuration. |
| `setting_history` | Every change to that row, for "what did we change before it broke". |
| `secrets` | AES-256-GCM ciphertext of every credential, keyed by name. |

**Audit**

| Table | Purpose |
|---|---|
| `audit_log` | Append-only, hash-chained: each row commits to the previous row's hash, so a deletion or edit breaks the chain and `audit.verifyChain()` detects it. Never pruned. |

**Trend discovery**

| Table | Purpose |
|---|---|
| `trends` | One resolved trend identity, with denormalised latest scores and the full scoring breakdown as JSON. |
| `trend_observations` | Individual signals per source and timestamp, deduplicated by `(trend_id, source, external_id)`. |

**Concepts and evaluation**

| Table | Purpose |
|---|---|
| `concepts` | Generated token concepts and their lifecycle status. |
| `concept_evaluations` | One row per adversarial panel role, with sub-scores and a concise summary — never raw chain of thought. |

**Predictions and models**

| Table | Purpose |
|---|---|
| `model_versions` | Serialised model state, sample count, evaluation metrics, and which version is active. |
| `predictions` | The verbatim feature vector at decision time plus every predicted quantity and its percentiles. |
| `prediction_outcomes` | Realised outcomes at a given horizon, unique per `(prediction_id, horizon_hours)`, with a flag for whether they have been folded into a model update. |

**Launch execution**

| Table | Purpose |
|---|---|
| `launches` | One row per launch attempt: idempotency key, mint, signature, blockhash and `last_valid_block_height`, cost breakdown, and a JSON `attempt_log` for post-mortems. |

**Launched tokens and monitoring**

| Table | Purpose |
|---|---|
| `tokens` | One row per launched mint, with denormalised latest metrics and the monitoring tier that drives poll frequency. |
| `market_observations` | Time series of market data per token per source, deduplicated by `(token_mint, source, observed_at)`. The largest table by far. |
| `holder_snapshots` | Holder count and concentration over time. |

**Creator fees and accounting**

| Table | Purpose |
|---|---|
| `creator_fee_events` | Accrual snapshots and collections, tagged `curve` or `amm` because the two vaults accrue independently. |
| `expenses` | Every cost incurred, in lamports or USD, with a reference to what incurred it. |
| `wallet_accounts` | Operating, treasury and external addresses, with how the key is held. |
| `wallet_transactions` | Transfers in and out. |

**Market intelligence**

| Table | Purpose |
|---|---|
| `competitor_tokens` | Cached competitor launches used for saturation analysis. |
| `market_snapshots` | Aggregate market-condition snapshots feeding the regime features. |

**AI usage**

| Table | Purpose |
|---|---|
| `ai_requests` | Per-call ledger: provider, model, purpose, tokens, cost, latency, schema retries. This is what the daily AI budget is computed from. |
| `ai_cache` | Response cache keyed by prompt hash, so a restart does not re-pay for prompts already answered. |

**Experiments and bandits**

| Table | Purpose |
|---|---|
| `experiments`, `experiment_arms`, `experiment_assignments` | Formal A/B structure over a candidate attribute, with the realised metric filled in when the outcome window closes. |
| `bandit_arms` | Standalone Thompson-sampling arms used by the exploration policy outside formal experiments. |

**Jobs, health, notifications, logs**

| Table | Purpose |
|---|---|
| `job_runs` | Every run, with duration, status, item count and error. |
| `job_state` | Per-job schedule, enablement, consecutive failures, and the lease (`locked_until`, `lock_token`). |
| `idempotency_keys` | Intended as a generic guard for any side-effecting operation, with expiry. **Currently unused**: nothing writes to or reads it, and the only reference in the codebase is the `maintenance` job deleting expired rows. Launch idempotency lives on `launches.idempotency_key`; wallet transfers use `wallet_transactions.idempotency_key`. |
| `provider_health` | Per-provider state, latency, failure counters, circuit-open-until and rate-limit-reset timestamps. |
| `notifications`, `notification_deliveries` | Notification records with a dedupe key, and per-channel delivery attempts. |
| `system_events` | Operational log, already redacted. Pruned after 30 days. |
| `daily_metrics` | Idempotently recomputed daily rollups keyed `(day, network)`, so analytics queries stay fast. |

### Conventions

- **Sortable string IDs.** `core/ids.ts` generates a ULID-compatible identifier:
  a 48-bit millisecond timestamp in Crockford base32 (no I, L, O or U) followed
  by 16 random characters. Primary keys therefore order by creation time, which
  keeps b-tree inserts append-only and makes `ORDER BY id` free. Most rows carry
  a short type prefix (`lch_`, `job_`, `air_`).
- **Unix milliseconds as integers.** SQLite has no date type worth using, and
  integers sort, index and difference correctly. The default is
  `(unixepoch('subsec') * 1000)`, though most rows set the value explicitly from
  the injected clock so tests control it.
- **Integer lamports for money.** Any value representing real on-chain SOL is
  stored as an integer lamport count. Floating point never touches money.
  Derived analytics quantities (`volume_24h_sol`, `market_cap_usd`,
  `organic_volume_sol`) are `real`, because they are estimates rather than
  balances.
- **JSON text columns for structured data.** `score_breakdown`, `features`,
  `drivers`, `economics`, `attempt_log`, `risk_flags`, `metrics`, `sub_scores`.
  Read through the typed helpers in `core/json.ts` — `parseJson` and
  `parseJsonSchema` — which return a supplied default rather than throwing on
  malformed content. (The comment at the top of `schema.ts` still points at
  `db/json.ts`; the file has moved and the comment has not.) The trade-off is
  accepted deliberately: these fields are read as whole objects by the
  application and rendered in the UI, never filtered or joined on.
- **Denormalised latest values.** `trends` and `tokens` both carry current
  metrics alongside their observation tables, so a list view is one query. The
  observation tables remain the source of truth.

---

## The provider layer

Every external dependency implements one of the interfaces in
`providers/types.ts`: `TrendProvider`, `MarketProvider`, `AiProvider`,
`ImageProvider`, `MetadataStorageProvider`, plus `HolderProvider` and
`PriceProvider`. All extend a common `Provider` with `id`, `label`, `kind` and
`healthCheck()`, where the health check must be cheap and must not consume
meaningful quota.

Optional capabilities are optional methods, not thrown errors:
`TrendProvider.measure?` is absent on sources that cannot look up a specific
term, and `MarketProvider.searchTokens?` / `recentLaunches?` are absent where the
API does not support them. Callers test for the method
(`typeof provider.searchTokens !== 'function'`) and skip. A provider that cannot
answer returns `null` rather than guessing.

### `unconfigured` is an outcome, not an error

`buildAllProviders()` constructs **every** provider it wires in, unconditionally
and without checking credentials first. The ones that need credentials the
operator has not supplied are still built; they report
`state: 'unconfigured'` with `requiresCredentials: true` and a `setupHint`
describing what unlocks them, and return nothing when asked for data.

This is why the System Health screen can list a provider the operator *could*
enable, next to the hint that enables it, instead of silently omitting it. A
provider that is missing from a list is indistinguishable from one that is
broken; a provider that says "add a YouTube API key" is actionable.

Construction is individually guarded. `attempt(name, factory)` catches, logs and
returns `null`, so one bad constructor cannot stop the platform booting with the
rest — ten trend providers, three market providers, two AI providers and the
image provider are each built behind their own `attempt`. The same principle
appears at the container level: a failure building the on-chain launch adapter
degrades to simulation rather than aborting startup.

One caveat on "every provider": `buildAllProviders()` constructs every provider
it imports, and `providers/market/pumpportal-stream.ts` is not one of them. That
module is fully written — a singleton websocket client for pump.fun's launch and
migration streams — but nothing imports it, so it is dead code today and no
health entry appears for it.

One shared detail worth noting: pump.fun's API is both a market provider and the
SOL price source, so it is constructed first and a single 60-second-cached
`solPriceUsd()` closure is handed to the others. Several providers convert USD to
SOL, and they must not disagree with each other or fetch the rate independently.

### `HttpClient`

Every outbound HTTP call goes through `providers/http.ts`. A naive `fetch` loop
across a dozen third-party APIs with different reliability will either hammer a
rate limit into a ban or stall the scheduler behind one dead host. Each
responsibility earns its place:

| Mechanism | Default | Why it matters |
|---|---|---|
| Token-bucket rate limit | none unless configured; `burst` defaults to `requests` | Stays inside published quotas. Reservations are chained through a promise queue so two concurrent callers cannot both see the same free token and overdraw. |
| Full-jitter backoff | `min(30_000, 400 * 2^(attempt-1))`, actual wait uniform in `[0, base)` | Many jobs share a provider. Without jitter their retries synchronise into a storm; full jitter (uniform over the whole window, not base-plus-jitter) spreads them properly. |
| Retries | `maxRetries` 3 | Only for errors marked retryable: HTTP 408, 429, 5xx, and transient network errors matched by message (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `socket hang up`, `network`, `fetch failed`). Any other 4xx is not retried. |
| Retry-After | capped at 60 s, on HTTP 429 only | Ignoring it is how API keys get revoked. |
| Circuit breaker | opens after 6 consecutive failures, 120 s cooldown | A dead provider fails fast with `provider_unavailable` instead of consuming a job's whole time budget. `resetCircuit()` clears it manually. |
| Timeout | 20 s | A hung socket is worse than an error: it holds a job slot until the scheduler's own timeout fires. |
| Response cache | off unless `cacheTtlMs` set | For endpoints polled far more often than they change. GET only, keyed on the full resolved URL. |
| `onResult` hook | — | Fires on every completed request. Each provider uses it to keep its own last-success / last-failure / latency counters, which its `healthCheck()` then reports, so the health view carries evidence from real traffic and not only from the synthetic probe. |

Three honest caveats:

- **`HealthService.recordProviderResult()` is never called.** It exists, it is
  documented as being fed by the `onResult` hook, and it upserts the
  `provider_health` row that would give availability counters from live traffic
  — but no provider wires `onResult` to it, so `provider_health` is written only
  by the `health-check` probe path. The per-provider closures described above
  are what actually carry live-traffic evidence today, and they are in-memory
  and lost on restart.
- **`Retry-After` is parsed from the response body, not the header.**
  `parseRetryAfter` regex-matches `retry-after` in `HttpError.bodyText`. Providers
  that return the standard `Retry-After` *header* and an unrelated body get no
  respect for their stated delay — the request falls back to ordinary jittered
  backoff. This works for the APIs that put the value in a JSON error body and
  silently does nothing for the rest.
- **The response cache is unbounded.** Entries are evicted only when read after
  expiry, or by `clearCache()`. With short TTLs and a fixed set of endpoints this
  is fine in practice, but it is a `Map` with no size limit.

Both `redactUrl` (here) and `redactRpcUrl` (in `rpc.ts`) strip credentials before
a URL reaches a log line; the RPC variant additionally masks long path segments,
because Helius and QuickNode put the key in the path rather than the query.

---

## The execution abstraction

Pump.fun's on-chain interface has already changed more than once: `create` was
superseded by `create_v2`, which moved to Token-2022 with metadata as a mint
extension rather than a separate Metaplex account. No service in this codebase
talks to the protocol directly. Everything goes through `LaunchAdapter`
(`providers/solana/launch-adapter.ts`):

```ts
ready(): Promise<{ ready: boolean; reason?: string }>
prepare(request, payer): Promise<LaunchPlan>       // builds, broadcasts nothing
execute(plan, payer, options): Promise<LaunchReceipt>
getAccruedFees(creator): Promise<AccruedFees>
prepareFeeClaim(creator): Promise<FeeClaimPlan | null>
executeFeeClaim(plan, payer, options)
```

The `prepare`/`execute` split is the important shape. `prepare` produces a
`LaunchPlan` carrying a human-readable `summary`, the mint address, the
instruction list, an estimated cost and a labelled `costBreakdown` — all without
touching the network beyond reads, so what is about to be broadcast can be
inspected before anything is.

Two honest limits on that. First, the plan is built *inside*
`LaunchService.launch()`, after the operator has already approved the candidate;
approval in the dashboard is approval of a concept, not of a specific
transaction, and there is no endpoint that returns a plan for review. Second,
only `plan.mintAddress` and `plan.estimatedCostLamports` are persisted (onto the
`launches` row) — `summary` and `costBreakdown` are computed on every launch and
then discarded, so nothing in the UI displays them today. The split earns its
keep as a testing and safety seam rather than as a review workflow.

**The settings schema offers three adapter choices, but only two are
implemented.** `execution.adapter` in `packages/shared/src/domain/settings.ts` is
`z.enum(['auto', 'pumpportal_local', 'pumpfun_sdk', 'simulation'])`:

| Adapter id | Networks | Status |
|---|---|---|
| `simulation` | `simulation` | Implemented. Always registered. Broadcasts nothing. Derives its mint the same way the real adapter does, so a plan reviewed in simulation has the same shape as one reviewed on mainnet. Drives a seeded, heavy-tailed synthetic market — deliberately unflattering, because a simulation that makes every launch look profitable would validate a strategy that loses money. |
| `pumpfun_sdk` | `devnet`, `mainnet` | Implemented. Built on `@pump-fun/pump-sdk` directly. Registered only when the network is not `simulation` and RPC construction succeeded. |
| `pumpportal_local` | — | **Not implemented.** No class implements it and nothing registers it. Selecting it is harmless rather than fatal: `LaunchService.adapterFor` ignores a configured id that is not in the adapter map and falls through to the first registered adapter supporting the network, so the platform behaves as if `auto` were set. It should either be built or removed from the enum. |

Direct SDK use rather than a relay API was
chosen because a relay charges 0.5–1% of the developer buy for what is
underneath an instruction builder, adds a third-party availability dependency to
the single most consequential operation the platform performs, and supports no
devnet — which is exactly where the launch path should be exercised first. The
Pump programs are deployed on devnet at identical addresses.

The SDK is imported lazily (`sdkModule ??= import('@pump-fun/pump-sdk')`) on
first on-chain use. It pulls in the Anchor runtime and several hundred kilobytes
of IDL that simulation mode never needs, and its dependency chain is the source
of the CJS/ESM interop problem described under *The build*.

**How a protocol change is absorbed.** Write a new class implementing
`LaunchAdapter`, register it in `refreshProviders()` under a new id, and set
`execution.adapter` to that id. `LaunchService.adapterFor(network)` honours an
explicit setting when the chosen adapter supports the network and otherwise
falls back to the first registered adapter that does, so `auto` keeps working
through the transition. Nothing in `LaunchService`, `FeeService`,
`MonitoringService` or the HTTP layer changes. Fee parameters are read from chain
at runtime (`fetchGlobal()`, `fetchFeeConfig()`) rather than hardcoded, which is
also why devnet's 1 SOL of initial virtual reserves and mainnet's 30 SOL are both
handled without a branch.

Costs that genuinely cannot be read from chain are stated as measured constants
with labels, not as magic numbers: Token-2022 mint rent 3 700 000 lamports,
bonding-curve account rent 1 800 000, base transaction fee 10 000, associated
token account rent 2 074 080.

---

## Transaction reliability

`providers/solana/rpc.ts`. The hard part of Solana is not building a transaction,
it is landing it exactly once.

### Rebroadcast, never re-sign

A transaction is valid until its blockhash's `lastValidBlockHeight` passes.
`broadcastAndConfirm` serialises the signed transaction once and rebroadcasts
**the identical bytes** until the transaction confirms or the height passes.

This is the difference between one token and two. Rebroadcasting is safe because
the signature is identical and the network deduplicates it. Re-signing with a
fresh blockhash creates a *second, different* transaction — and if the first one
was in flight rather than lost, both can land.

The first send runs with preflight so an obviously-invalid transaction fails fast
with a useful message. Subsequent rebroadcasts use `skipPreflight: true`:
preflight already passed, and re-running it costs an RPC call per attempt.
Rebroadcasts are spaced 1.5 s apart, capped at 30 by default.

Three send errors are classified rather than retried blindly: `insufficient
funds` becomes a non-retryable `insufficient_funds`, `blockhash not found`
becomes `transaction_expired`, and `already processed` is treated as success —
the transaction is on chain, so the loop proceeds to confirmation.

### Poll `getSignatureStatuses`, do not `confirmTransaction`

`confirmTransaction` collapses several distinct outcomes into one promise and
gives no visibility into which one occurred. Polling `getSignatureStatuses`
(with `searchTransactionHistory: true`) distinguishes four states that need
different handling:

| Observed | Meaning | Action |
|---|---|---|
| `status.err` set | Failed on chain | Throw `transaction_failed`, non-retryable. The transaction is settled; retrying is wrong. |
| `confirmationStatus` at or above required commitment | Landed | Fetch metering detail, return. |
| No status, block height still below `lastValidBlockHeight` | Not yet seen | Rebroadcast and keep waiting. |
| No status, block height past `lastValidBlockHeight` | Expired | Throw `transaction_expired`, retryable. Safe to build a new transaction — the old one can no longer land. |

Commitment comparison uses an explicit rank (`processed` 1, `confirmed` 2,
`finalized` 3) rather than string equality, so `finalized` satisfies a
`confirmed` requirement.

`getTransactionDetail` negotiates `maxSupportedTransactionVersion` rather than
hardcoding it: it probes highest-first (`[1, 0]`), remembers the version that
worked, and only retries on an error that actually names the version problem. A
client pinned to 0 goes dark on a network version bump instead of degrading.

### Compute units by simulation, priority fees by percentile

`estimateComputeUnits` builds the transaction with a provisional 1 400 000 CU
limit (so simulation is not itself truncated), simulates with `sigVerify: false`
and `replaceRecentBlockhash: true`, and returns `ceil(consumed * 1.2) + 1000`,
capped at 1 400 000. The 20% headroom absorbs account-state changes between
simulation and execution without paying for unused units. If simulation fails,
`sendTransaction` falls back to 300 000.

This matters concretely: `create_v2` has been measured consuming 328k–368k CU,
so the 320k limit some third-party relays hardcode is not enough. The adapter
deliberately passes `computeUnitLimit: undefined` so simulation decides.

`estimatePriorityFee` calls `getRecentPrioritizationFees` scoped to the writable
accounts the transaction will actually touch (capped at 128), sorts the non-zero
values and takes the 75th percentile, with a floor of 1 000 µlamports/CU. The
asymmetry justifies the high percentile: missing a launch window costs far more
than overpaying by a fraction of a cent. A provider that does not implement the
method returns 10 000 rather than blocking the launch.

### Endpoint failover

Endpoints are ordered by priority and benched for 60 s after 4 consecutive
failures. `call()` walks healthy endpoints first, then benched ones, and fails
over on error. When everything is benched, `pickState()` returns whichever
recovers soonest rather than failing outright.

The docblock on `call()` says writes never use it and that `sendTransaction`
pins one endpoint per attempt. **That is not what the code does**:
`broadcastAndConfirm` issues both the initial `sendRawTransaction` and every
rebroadcast through `call()`, so a broadcast that errors is retried against the
next endpoint. What makes that survivable is the property the whole design rests
on — the bytes are identical and already signed, so a second endpoint accepting
them produces the same signature and the network deduplicates it. The danger
`call()` would introduce is re-*signing* across endpoints, which never happens.
The comment is stale rather than describing a defect, but it should be corrected
in the source rather than believed.

### Duplicate-launch defence, three independent mechanisms

Documented in `services/launch.service.ts`. Each one alone has a hole; together
they close each other's.

**1. A unique index on `launches.idempotency_key`.**

```ts
static idempotencyKey(conceptId: string, network: ExecutionNetwork): string {
  return createHash('sha256').update(`launch:${network}:${conceptId}`).digest('hex').slice(0, 40);
}
```

Network is in the key, so a concept can legitimately launch once on devnet and
once on mainnet but never twice on the same network. The row is inserted
**before anything is prepared or broadcast**, so a concurrent or retried attempt
hits `launches_idempotency_uq` rather than racing. A constraint violation here is
a correctness success, not an error: the catch block looks the conflicting row up
and reconciles it.

*Its hole:* it depends on the database row surviving.

**2. Deterministic mint derivation.**

```ts
hkdfSync('sha256', mintDerivationSecret,
         sha256(idempotencyKey),          // salt
         'solcoin/mint/v1',               // info
         32)                              // → Keypair.fromSeed
```

Even if the database row were lost entirely, a second attempt derives the *same*
mint address, and the on-chain `create_v2` fails with "account already in use"
instead of minting a second token. `prepare()` additionally checks
`getAccountInfo(mint)` first and throws `conflict` when the account already
exists, so the common case surfaces as a clear reconciliation prompt rather than
a cryptic program error.

*Its hole:* it protects the mint, not the developer buy or the fee spend, and it
requires the derivation secret to be stable and secret. Anyone holding the secret
could compute a future mint address before it is created, which is why it is
generated with `randomBytes(32)`, stored encrypted, and never placed in
configuration.

**3. The signature is persisted at the moment of signing.**

`sendTransaction` invokes `onSigned` after signing and *before* the first
broadcast. `LaunchService` uses that hook to write `status = 'submitted'` with
the signature, blockhash and `last_valid_block_height`. A process that dies
mid-flight leaves a record the recovery path can act on.

`reconcile()` then refuses to guess. A row in `submitted` with a signature is
**not** retried and **not** marked failed; it returns an outcome saying the
result is unknown and is being reconciled on chain. The `launch-recovery` job
(every 180 s; `hasSideEffects: false`, meaning it broadcasts nothing — it does
write the resolved launch row) resolves it, and only once the row is at least two
minutes old: the mint account existing is the definitive answer, a signature
status carrying `err` means expired, and anything still ambiguous after 10
minutes is treated as expired. Rows in `failed` or
`abandoned` are deliberately not auto-retried either — the failure reason may
still hold, and the scheduler retrying by itself is how one bad configuration
becomes a run of paid-for failures. A person asking for another attempt is a
different matter: the manual launch path calls `LaunchService.retireFailed`
first, which reclassifies the failed row and retires the idempotency key that
would otherwise make the retry impossible. Without that the dashboard's retry
on a failed candidate could never submit anything, however many times it was
pressed.

Beyond these three, `LaunchService` engages the emergency stop automatically once
consecutive launch failures reach `limits.consecutiveFailureShutdown`, because
repeated failures usually mean something systemic and continuing to burn rent on
transactions that will not land is the expensive way to find out.

---

## The job scheduler

`jobs/scheduler.ts`. Deliberately not a queue library: the workload is a fixed
set of 16 recurring jobs on a single node, and a broker would add an operational
dependency without solving a problem this system has. What it does provide:

**Durable schedules.** `next_run_at` lives in `job_state`, so a restart resumes
rather than resetting every interval. First runs are staggered by a deterministic
hash of the job name into 2–47 s, so a cold start does not fire sixteen jobs at
once and immediately exhaust several rate limits — and two identical deployments
stagger identically rather than by luck.

**Expiring leases.** Acquisition is a single conditional `UPDATE`:

```sql
UPDATE job_state SET locked_until = ?, lock_token = ?, updated_at = ?
 WHERE job_name = ? AND (locked_until IS NULL OR locked_until < ?)
```

If another process took the lease between the `SELECT` of due jobs and this
statement, `changes` is zero and this process quietly does nothing. The lease
expires after `timeoutSeconds ?? max(120, intervalSeconds * 3)`, so a crashed
run cannot deadlock the job forever. `releaseStaleLocks` clears expired leases
and marks the corresponding `job_runs` row failed with "The process running this
job stopped before it finished.", so it does not sit as `running` and skew the
health view.

**Exponential backoff with jitter.**

```
backoff = failures > 0
  ? min(3_600_000, intervalMs * 2^min(failures, 6))
  : intervalMs
jitter  = 1 + (random() - 0.5) * 0.15        // ±7.5%
```

Backoff stops a job hammering a broken dependency every interval for the rest of
the day, capped at an hour. Jitter prevents convoying: without it, jobs
registered together stay locked in step forever and spike the same rate limits
simultaneously.

**Observability.** Every run gets a `job_runs` row with duration, status, item
count and either a truncated result JSON or the error. `progress(n, note)` lets a
long job report partial counts. Runs longer than 30 s are logged at info.

**Timeouts and abort.** Each run gets an `AbortController` aborted at the lease
timeout. The signal is passed into `JobContext`, but only two jobs actually take
it and forward it down into `HttpClient` and `SolanaRpc`: `trend-discovery` and
`candidate-pipeline`, which are the two long ones. The rest ignore it, so an
overrunning `token-monitor` or `launch-queue` run simply keeps going past its
lease expiry. It does not become a duplicate — `releaseStaleLocks` skips a job
this process is still running — but the timeout is advisory for those jobs. For
`launch-queue` that is arguably right — `launchApproved()` takes no signal, and
aborting a broadcast in progress is worse than letting it land — but elsewhere it
is a gap rather than a design statement. On shutdown, running
jobs are aborted and given up to 5 s to unwind so their run rows finalise.

### Why the emergency stop suspends only side-effecting jobs

```ts
if (job.hasSideEffects && settings.emergencyStop) {
  this.scheduleNext(job, 'skipped');
  return;
}
```

A paused system that also stops reporting is much harder to debug than one that
keeps observing. When the stop is engaged, the platform must not spend money or
broadcast anything — but the operator needs to see current token performance,
current wallet balances, current provider health and current fee accrual in order
to decide whether it is safe to resume. Read-only jobs therefore keep running and
the dashboard stays accurate while everything with a side effect is suspended.

| Suspended by the emergency stop | Continue running |
|---|---|
| `trend-discovery`, `market-scan`, `candidate-pipeline`, `launch-queue`, `fee-collect`, `notification-retry` | `launch-recovery`, `token-monitor`, `token-lifecycle`, `fee-detect`, `wallet-reconcile`, `learning-outcomes`, `model-train`, `analytics-rollup`, `health-check`, `maintenance` |

One flag in that table is wrong and should be treated as a known defect rather
than a design decision: **`wallet-reconcile` is marked `hasSideEffects: false`
but can broadcast a treasury sweep** when `wallet.autoSweepEnabled` and
`autonomy.wallet_transfer === 'auto'`. In practice the transfer is still blocked,
because `WalletService.transfer` reserves through `guard.reserveSpend()` and
`GuardService.checkOperational` refuses everything while the stop is engaged —
so defence in depth catches it. The flag should nonetheless be `true`.

`enabledWhen(settings)` is the second gate, for jobs that only make sense under
certain configuration; a job that fails it is marked `skipped` and rescheduled
normally rather than counted as a failure.

---

## The event bus

`core/events.ts` is about seventy lines. It is a `Map<eventName, Set<handler>>`
with a strongly-typed `PlatformEventMap` covering 21 events —
`trend.discovered`, `concept.awaiting_approval`, `launch.confirmed`,
`fees.collected`, `wallet.low_balance`, `system.emergency_stop`,
`model.retrained` and so on.

It exists to decouple services: a launch confirming should not need to know that
notifications, analytics and monitoring all care. Handlers are isolated —
`emit` dispatches through `Promise.resolve().then(...)` and logs rejections, so
one failing subscriber cannot break the emitter or another subscriber.
`emitAndWait` uses `Promise.allSettled` and is there for tests and for any place
that genuinely needs to wait on handlers — nothing calls it yet, in `src` or in
`tests`.

**It is deliberately not a message broker**, and the distinction is worth being
explicit about because the two look similar in a diagram and are not similar at
all:

- **Events are not durable.** They exist only in this process's memory. A crash
  loses any event in flight.
- **There is no delivery guarantee, no retry, no dead-letter queue.** A handler
  that throws is logged and forgotten.
- **There is no ordering guarantee** across events, and no back-pressure.

That is acceptable because **nothing correctness-critical depends on an event**.
Every durable state transition is a database write made by the service itself
before the event is emitted. Events drive notifications, cache invalidation and
dashboard freshness — things where a missed message means a missing notification,
not a lost token or a double launch. Where durability is genuinely required, the
mechanism is a table (`launches.idempotency_key`, `notification_deliveries` with
retry, `job_runs`), not the bus.

If a future requirement did need at-least-once delivery across processes, that
would be the point to introduce a broker. Introducing one now would add an
operational dependency to buy a guarantee nothing currently relies on.

---

## The build

`packages/server/build.mjs` bundles the server with esbuild into `dist/`
(`main.js`, plus `cli/doctor.js` and `cli/migrate.js`), ESM, targeting Node 20,
with sourcemaps. `npm run build -w @solcoin/server` runs `tsc --noEmit` first, so
type errors fail the build even though esbuild does not type-check.

**This is a correctness requirement, not a packaging preference.** Several
dependencies in the Solana ecosystem are CommonJS-only — `@coral-xyz/anchor`
chief among them — and are imported with *named* bindings by other packages, for
example `import { BN } from '@coral-xyz/anchor'`. Node's ESM loader resolves
those bindings by statically lexing the CommonJS module, which fails on anchor's
build, so the process dies at link time with:

```
SyntaxError: The requested module '@coral-xyz/anchor' does not provide an export named 'BN'
```

Bundling resolves the interop at build time. The same problem appears in tests,
where the fix is Vite's rather than esbuild's — `vitest.config.ts` sets
`server.deps.inline: [/@pump-fun\//, /@coral-xyz\//]` so Vite transforms those
packages itself and applies the interop they assume they will get. Both
environments therefore run code that has had the same fix applied, which is the
point: development, test and production stay on identical code paths.

Two things stay outside the bundle:

- `external: ['better-sqlite3', 'pino-pretty']`. `better-sqlite3` loads a native
  `.node` binary that cannot be bundled; `pino-pretty` is a development-only
  transport loaded by name at runtime.
- A `banner` re-establishing `require`, `__filename` and `__dirname` in the ESM
  output, because several bundled CommonJS dependencies reference them at module
  scope.

**What this means for deployment.** The artefact is one JavaScript file plus
`node_modules/better-sqlite3` (which must be built for the target platform and
Node ABI), the `packages/web/dist` static bundle, and `src/db/migrations` — the
`.sql` migration files are not copied into `dist`, so `migrationsFolder()`
searches four candidate paths for one containing `meta/_journal.json`. `npm start`
runs `node packages/server/dist/main.js`.

One consequence of bundling is called out in `db/migrate.ts` and is easy to get
wrong: `migrateCli()` is *not* guarded by the usual
`import.meta.url === process.argv[1]` check, because after bundling that
comparison is true for every module in the file and would fire the migration CLI
on every boot.

---

## The HTTP surface

Fastify, listening on `HOST:PORT` (default `127.0.0.1:4317`), with a 2 MiB body
limit. Twelve route modules are registered lazily under `/api`; anything else
falls through to `packages/web/dist/index.html` for the single-page app. If the
dashboard bundle is missing, `/` returns a message saying to run `npm run build`
rather than a 404.

The security posture, since this server can spend money:

- Session cookies are HttpOnly, SameSite=Lax, and Secure in production.
- Every state-changing request — anything other than `GET`, `HEAD` and
  `OPTIONS` — must additionally present the session's CSRF token in the
  `x-csrf-token` header. SameSite alone does not cover all browsers and proxy
  configurations.
- A strict CSP with `scriptSrc: 'self'` and no `unsafe-inline` for script. The
  dashboard is a compiled bundle and has no need for inline script, so refusing
  it costs nothing and is the single most effective XSS mitigation available.
  `styleSrc` does allow `unsafe-inline`, because Vite injects a style element for
  the initial paint and inline styles cannot execute code.
- Authentication runs for every `/api/` request. Public routes are an explicit
  set of five `METHOD:/path` keys — `POST:/api/auth/login`,
  `GET:/api/auth/session`, `GET:/api/system/bootstrap`,
  `POST:/api/system/bootstrap`, `GET:/api/health` — rather than a prefix
  allow-list, which is easy to get wrong.
- Global rate limit of 600 requests per minute per IP, with a much tighter
  per-route limit on `POST:/api/system/bootstrap` (5 per 10 minutes), since that
  is the one public route that creates an account.
- CORS headers are emitted only when `CORS_ORIGINS` is set. The default
  deployment serves the dashboard from the same origin and needs none.
- Errors always return `{ error: { code, message, details? } }` with a stable
  code from the `ErrorCode` union. `AppError` messages are written to be shown,
  so they are returned verbatim at any status; an *unexpected* error is not —
  at 5xx it is replaced with a fixed sentence pointing at the server log, and
  below 5xx its message is passed through `redactSecrets` first. Nothing ever
  returns a stack trace.

`AppError` (`core/errors.ts`) carries a machine-readable code that maps to both
an HTTP status and a default retryability. The mapping is worth knowing:
`not_configured` → 412, `locked` → 423, `safety_block` and `emergency_stop` →
403, `limit_exceeded` and `rate_limited` → 429, `provider_unavailable` → 503.
Retryable by default: `rate_limited`, `provider_unavailable`, `provider_error`,
`rpc_error`, `transaction_expired`.

Redaction happens at three layers, because a credential reaching a log
aggregator is not recoverable: pino path-based redaction for a fixed list of
field names (`core/logger.ts`), a regex sweep (`redactSecrets`) over rendered log
strings, and `safeErrorText()` — the same sweep plus truncation — applied to
error text before it is logged or written to a `job_runs`, `launches` or
`system_events` row.

---

## Extending it

### A trend source

1. Add the id to `TrendSourceId` in
   `packages/shared/src/domain/enums.ts`, and give it a family and weight in
   `SOURCE_INDEPENDENCE`. This is the step that actually matters: the weight
   decides how much independent confirmation the source contributes, and putting
   a new forum in the `forum` family is what stops it double-counting with
   Hacker News and Reddit. Add it to `ZERO_AUTH_TREND_SOURCES` if it needs no
   credentials.
2. Create `packages/server/src/providers/trends/<name>.ts` exporting a
   `create<Name>Provider(options)` factory returning a `TrendProvider`. Use
   `HttpClient` with a `rateLimit` matching the published quota — do not call
   `fetch` directly. Implement `discover()`; implement `measure()` only if the
   API genuinely supports looking up a specific term.
3. Return `RawTrendSignal` with a `rawValue` that is a *rate*, not a cumulative
   total, where the platform metric is monotonic. The Hacker News provider is the
   reference for this: it reports points per hour, because ranking by cumulative
   points measures how long a story has been up as much as how interesting it is.
4. Sanitise every text field with `sanitiseExternalText`
   (`packages/shared/src/safety/prompt-injection.ts`, re-exported from
   `@solcoin/shared`, default `maxLength` 2000). Source text is written by
   strangers and is treated as untrusted throughout.
5. Register it in `buildAllProviders()` in `providers/index.ts`, wrapped in
   `attempt('<name>', ...)`.
6. Report `unconfigured` from `healthCheck()` with a `setupHint` when the
   credential is absent. Do not throw, and do not omit the provider.

### A market source

Same shape, in `providers/market/`, implementing `MarketProvider`. `getTokens()`
is required; `searchTokens()` and `recentLaunches()` are optional and callers
feature-detect them, so implement only what the API really supports. Register it
in the `marketProviders` array in `buildAllProviders()`. If it can price SOL,
expose `getSolPriceUsd()` — both `firstSolPrice()` in `jobs/definitions.ts` and
the shared price closure in `providers/index.ts` duck-type for that method.

### A launch adapter

1. Implement `LaunchAdapter` in `providers/solana/`. Give it a stable `id` and
   the `networks` it can execute against.
2. `prepare()` must not broadcast. It must derive its mint deterministically from
   `request.idempotencyKey` and should check whether that mint already exists,
   throwing `conflict` if it does.
3. `execute()` must be safe to call at most once per plan, and must call
   `options.onSigned` after signing and before the first broadcast. That callback
   is what makes crash recovery possible without risking a duplicate; an adapter
   that skips it silently removes the third duplicate-launch defence.
4. Register it in `refreshProviders()` in `container.ts`. It becomes selectable
   via `execution.adapter`, and reachable through `auto` for any network it
   declares.
5. Add the id to the `execution.adapter` enum in
   `packages/shared/src/domain/settings.ts`, so the id can actually be selected.

Note that four call sites currently hardcode the lookup as
`network === 'simulation' ? 'simulation' : 'pumpfun_sdk'` rather than going
through `LaunchService.adapterFor`: `feeCollectionPreview` and `collectFeesNow`
in `container.ts`, and the `fee-detect` and `fee-collect` jobs in
`jobs/definitions.ts`. A third adapter would need all four updated too — the
abstraction is clean on the launch path and leaky on the fee path.
