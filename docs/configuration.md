# Configuration

Configuration lives in three places, and the split is deliberate.

| Layer | Holds | Edited via | Survives |
|---|---|---|---|
| Environment (`.env`) | Infrastructure only: where to listen, where the database is, and the one key that unlocks everything else | A text file, read at boot | Restart |
| Encrypted secret store | Every credential: API keys, RPC URLs, webhook URLs, the wallet keystore | `PUT /api/system/secrets/:key`, Settings → Providers & secrets | The `secrets` table |
| Platform settings | Every strategy and safety knob | `PATCH /api/settings`, Settings pages | The `settings` table, versioned, with full history |

The reason for the split: environment variables cannot be changed without a
deploy, so only things that genuinely cannot change at runtime live there.
Credentials are never in settings because settings are returned wholesale to any
user with `view`. Settings are never in the environment because an operator
needs to tune them at 2am without redeploying.

---

## Environment variables

Parsed and validated by `packages/server/src/config/env.ts`. An invalid value
throws at boot with the offending field named — the process does not start with
a half-understood configuration.

`.env.example` at the repository root is a commented starting point; copy it to
`.env`. The loader reads `.env` from the working directory and **never overrides a
variable already present in the real environment**, so a container's injected
variables win over a stale file. Surrounding single or double quotes are
stripped; nothing else is interpreted.

One sharp edge in that starting point: the loader assigns an empty string for a
line like `SOLCOIN_MASTER_KEY=`, and an empty string is *present*, not absent, so
it is validated rather than defaulted. `SOLCOIN_MASTER_KEY=`, `BOOTSTRAP_EMAIL=`
and `BOOTSTRAP_PASSWORD=` left empty fail `min(16)`, `email()` and `min(12)`
respectively and the process refuses to start. Fill those three in or delete the
lines; `WEB_DIST=`, `CORS_ORIGINS=` and the boolean flags are safe empty.

| Variable | Default | Required | What it does |
|---|---|---|---|
| `SOLCOIN_MASTER_KEY` | unset | For any credentialed feature | Unlocks the secret store and the wallet keystore. Minimum 16 characters. See below. |
| `NODE_ENV` | `development` | No | One of `development`, `test`, `production`. Sets `isProduction`/`isTest` and the default for `LOG_PRETTY`. |
| `HOST` | `127.0.0.1` | No | Listen address. The default binds to loopback only; change it deliberately. |
| `PORT` | `4317` | No | Listen port, 1–65535. |
| `DATABASE_PATH` | `./data/solcoin.db` | No | SQLite file. Absolute or relative to the working directory. |
| `DATA_DIR` | `./data` | No | Directory for generated artwork and metadata staging. |
| `LOG_LEVEL` | `info` | No | One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `LOG_PRETTY` | unset → pretty unless `NODE_ENV=production` | No | `true` or `1` forces human-readable logs; any other value forces JSON. |
| `CORS_ORIGINS` | `""` | No | Comma-separated browser origins allowed to call the API. Empty means no cross-origin allowance is registered at all, which is correct when the dashboard is served from the same origin (the default). |
| `TRUST_PROXY` | unset (false) | No | `true`/`1` makes Fastify trust `X-Forwarded-*`. Only enable behind a proxy you control — it affects the client IP written to the audit log. |
| `DISABLE_SCHEDULER` | unset (false) | No | `true`/`1` serves the API without registering any background job. Intended for a read-only replica. |
| `WEB_DIST` | unset → `<cwd>/packages/web/dist` | No | Absolute path to the built dashboard, served as static files. |
| `BOOTSTRAP_EMAIL` | unset | No | Creates the first owner account non-interactively. Must be a valid email. |
| `BOOTSTRAP_PASSWORD` | unset | No | Password for that account, minimum 12 characters. |

`BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` are honoured **only when the user
table is empty**, and only when both are set. A failure to create the account is
logged, not fatal — a headless deploy with a bad bootstrap password still serves
the UI so you can create the account by hand.

### `SOLCOIN_MASTER_KEY`

This is the only genuine secret in the environment, and it is the root of the
platform's confidentiality.

**What it protects.** Every row in the `secrets` table is AES-256-GCM ciphertext
under a key derived by scrypt (`N = 2^15`, `r = 8`, `p = 1`) from this
passphrase, with a fresh 16-byte salt and 12-byte IV per row. The operating
wallet's private key gets a *second, independent* envelope inside that: the
keystore record is encrypted under `wallet:${SOLCOIN_MASTER_KEY}` before the
secret store wraps it again. A bug that leaks one secret row therefore still does
not leak the wallet key.

**Generating one.**

```bash
openssl rand -base64 32
```

Paste the result into the existing `SOLCOIN_MASTER_KEY=` line. Do **not** append
a second line with `>>`: within one file the loader keeps the *first* value it
sees for a key, so an appended key loses to the empty line `.env.example` ships
with, and the boot then fails the 16-character check.

The schema enforces 16 characters. `npm run doctor` warns below 24 and advises 32
or more. There is no upper bound.

**Without it the platform still runs, locked.** `SecretStore.unlocked` is false,
which means:

- `set()` throws `locked` — no credential can be stored.
- `get()` returns `null` rather than throwing, so every credentialed provider
  reports health state `unconfigured` and the feature degrades instead of
  crashing. This is the design rule: a missing credential must never take down
  the platform.
- The wallet cannot be unlocked, so nothing can be signed.
- The six zero-auth trend sources, the three no-key market sources, scoring,
  prediction and simulation launches all work normally.

Boot logs a warning saying exactly this, and `npm run doctor` reports it.

**If the key is lost, the secrets are gone.** There is no escrow and no recovery
path. A decryption failure is caught, logged as
`failed to decrypt secret — the master key may have changed since this secret was stored`,
and `get()` returns `null` — so a wrong key looks identical to an unconfigured
platform rather than producing an error you can act on. API keys can simply be
re-entered. **The operating wallet's private key cannot**, so any SOL in that
wallet is stranded. This is the argument for the treasury split: the operating
wallet should hold only what near-term launches need.

**Rotation.** `SecretStore.rotateMasterKey(newMasterKey)` decrypts every row
under the current key and re-encrypts it under the new one inside a single
transaction, returning `{ rotated }`. The transaction matters: a half-rotated
store is unreadable, which is worse than a lost credential. It requires the
store to be currently unlocked and the new key to be at least 16 characters.

Three honest caveats before you use it:

1. **Nothing calls it.** There is no CLI command and no HTTP route — it is a
   library method. Rotating today means writing a short script against the
   built server bundle.
2. **It does not rewrite `.env`.** Rotate, then update `SOLCOIN_MASTER_KEY` and
   restart. Between those two steps the store is unreadable.
3. **It does not re-wrap the wallet's inner envelope.** `rotateMasterKey` walks
   the `secrets` rows and re-encrypts each row's *plaintext*, which for the
   wallet is the keystore record JSON — the inner blob inside that record is
   still keyed on `wallet:${OLD_KEY}`. (A comment in `keystore.ts` claims
   rotation re-wraps both layers; it does not.) After rotation `withSigner`
   will fail to decrypt.

So the safe rotation procedure is:

```
1. Export the wallet key while the OLD key is still active
   (POST /api/wallet/export, exact confirmation phrase, audited).
2. Run rotateMasterKey(newKey).
3. Update SOLCOIN_MASTER_KEY in the environment and restart.
4. Re-import the operating wallet (POST /api/wallet/import) so its inner
   envelope is rewritten under the new key.
```

Step 4 is an import, not a create: `POST /api/wallet/create` refuses with
`conflict` while a wallet exists, whereas import overwrites the keystore record
in place. There is no route that removes a wallet — `WalletKeystore.remove()`
exists but nothing calls it — so importing over the old record is the only path.

Note that export returns `secretKeyBase64` while import expects base58 or a JSON
byte array, so step 4 needs a conversion — decode the base64 to bytes and paste
the resulting `[...]` array.

---

## Credentials

Stored under the keys in `SECRET_KEYS` (`packages/server/src/security/secrets.ts`).
Reads are cached in memory for 60 seconds; a read that misses the cache stamps
`lastUsedAt`, so an operator can see which credentials are actually being used
and revoke the rest — at 60-second granularity, not per call. Only
metadata — key, category, a hint, timestamps — is ever returned over the API;
plaintext never crosses the HTTP boundary.

Setting or deleting a secret requires the `edit_wallet_config` permission
(owner or admin), is written to the audit log, and immediately refreshes the
provider registry so the change takes effect without a restart.

| Key | Unlocks | Costs money | Where to get it |
|---|---|---|---|
| `ai.anthropic.api_key` | Concept generation, the adversarial panel, the launch decision | Yes, per token | console.anthropic.com |
| `ai.openai.api_key` | The same AI tiers via OpenAI, and generated artwork | Yes, per token/image | platform.openai.com |
| `rpc.helius.api_key` | A Helius RPC endpoint, registered at priority 1 | Free tier, then paid | helius.dev |
| `rpc.mainnet.url` | Your own mainnet RPC, registered at priority 0 (tried first) | Depends on provider | Any RPC provider, or your own node |
| `rpc.devnet.url` | The same for devnet | Usually free | As above |
| `trends.youtube.api_key` | The YouTube trend source | Free quota | Google Cloud console, YouTube Data API v3 |
| `trends.reddit.client_id` | The Reddit trend source (with the secret below) | Free, approval-gated | reddit.com/prefs/apps |
| `trends.reddit.client_secret` | As above | — | As above |
| `storage.pinata.jwt` | Pinata as the fallback metadata/artwork pin | Free tier | pinata.cloud |
| `notify.discord.webhook` | Discord notifications, when `notifications.discordEnabled` | Free | A Discord channel's integration settings |
| `notify.slack.webhook` | Slack notifications — **the credential is itself the opt-in**, there is no `slackEnabled` toggle | Free | A Slack incoming-webhook app |
| `notify.telegram.bot_token` | Telegram notifications, with the chat id and `telegramEnabled` | Free | @BotFather |
| `notify.telegram.chat_id` | As above | — | The chat's id |
| `notify.webhook.url` | A generic JSON POST, when `notifications.webhookEnabled` | — | Your own endpoint |
| `wallet.operating.keystore` | The operating wallet. Written by the wallet routes, not typed in by hand | — | Created or imported in Settings → Wallet |
| `market.birdeye.api_key` | **Nothing.** Declared, no consumer in the codebase | — | — |
| `trends.x.bearer_token` | **Nothing.** There is no X trend provider | — | — |
| `execution.pumpportal.api_key` | **Nothing.** The PumpPortal market stream uses the public WebSocket and reads no key | — | — |
| `notify.smtp.url` | **Nothing.** Email delivery is not implemented (see Notifications) | — | — |

### What is actually optional

Almost all of it. The platform is built so that any subset of integrations can
be present:

- **Trend discovery** needs no credential. Six sources are enabled by default and
  all of them are zero-auth. Two more zero-auth sources (`stackexchange`, `rss`)
  ship disabled and cost nothing to turn on.
- **Market data** needs no credential — Jupiter, DexScreener and the pump.fun API
  are all keyless. Jupiter additionally looks for a `market.jupiter.api_key`
  secret and switches to its paid tier and rate limit when it finds one; that key
  is not declared in `SECRET_KEYS`, so it does not appear in the Providers UI and
  has to be stored through `PUT /api/system/secrets/market.jupiter.api_key`.
- **Metadata pinning** tries pump.fun's own IPFS endpoint first, which needs no
  credential; Pinata is the fallback.
- **Artwork** falls back to deterministic procedural artwork when no image model
  is available, and records `source: 'procedural'` with a below-baseline quality
  score so the substitution is visible rather than hidden.
- **RPC** falls back to public endpoints; a Helius key or your own URL buys
  reliability, not capability.

### What is not optional

**AI is the one hard gate.** With neither an Anthropic nor an OpenAI key, the
router raises `not_configured` naming the tiers and the setup hints, and concept
generation and evaluation simply do not run. There is no local model and no
placeholder-concept path. Everything upstream of generation — discovery,
identity resolution, opportunity scoring — still works, which is why a fresh
install with no keys is genuinely useful.

Model routing is per tier, not per provider. If the configured model id is not
served by any healthy provider, the router falls back to any model of the same
tier from a usable provider and logs
`configured model unavailable; routing to an equivalent-tier substitute`. A
provider with an open circuit breaker or no credentials is skipped rather than
tried.

---

## Hard ceilings

`HARD_LIMITS` in `packages/shared/src/constants.ts` are the values no UI, no API
call and no model-driven update can exceed.

| Ceiling | Value | Binds |
|---|---|---|
| `maxLaunchesPerDayAbsolute` | 24 | `limits.maxLaunchesPerDay` |
| `maxSolPerTransactionAbsolute` | 2 | `limits.maxSolPerTransaction` |
| `maxSolPerDayAbsolute` | 5 | `limits.maxSolSpendPerDay` |
| `maxAiSpendUsdPerDayAbsolute` | 200 | `limits.maxAiSpendUsdPerDay` |
| `maxTrendsPerDiscovery` | 500 | Divided across the enabled sources to give each provider its per-run limit, with a floor of 10 each |
| `maxConceptsPerCycle` | 40 | Declared but not referenced by any code path |

**They are applied by clamping, not by rejection.** `clampSettings()` runs on
every read *and* every write, so a request to set `maxLaunchesPerDay` to 20
returns HTTP 200 with the value 20 — but a request to set it to 40 returns
HTTP 200 with the value **24**. Check the `settings` object in the response
rather than assuming your value was taken.

Three of the clamps are relational rather than absolute, and are easy to trip
over:

```
maxLaunchesPerHour  ≤ maxLaunchesPerDay
maxSolPerHour       ≤ maxSolSpendPerDay
execution.devBuySol ≤ limits.maxSolPerTransaction
```

So lowering `maxSolSpendPerDay` silently lowers `maxSolPerHour` with it, and
`devBuySol` cannot exceed the per-transaction cap regardless of its own `max(5)`
schema bound. (`clampSettings` also pins `research.conceptsPerOpportunity` to 12,
which is already its schema maximum, so that one never binds.)

Zod bounds are a separate, earlier layer and *do* reject. `maxLaunchesPerDay`
has a schema maximum of 50, so 40 is accepted-then-clamped to 24 while 60 is
refused outright with `validation_failed`. Fields with no schema maximum
(`maxSolPerTransaction`, `maxSolSpendPerDay`, `maxAiSpendUsdPerDay`) are only
ever clamped.

---

## Settings reference

Defaults come from `packages/shared/src/domain/settings.ts`. Every value below
is the shipped default; ranges are the schema's, before clamping.

### `autonomy`

How much the platform may do unattended, per capability.

| Field | Default | Values |
|---|---|---|
| `research` | `auto` | `off`, `suggest`, `approve`, `auto` |
| `concept_generation` | `auto` | as above |
| `artwork` | `auto` | as above |
| `metadata` | `auto` | as above |
| `launch` | `approve` | as above |
| `social` | `off` | as above |
| `fee_collection` | `approve` | as above |
| `wallet_transfer` | `off` | as above |

What each level actually does, in code:

- **`off`** blocks the operation at the guard for `research`, `concept_generation`,
  `launch`, `fee_collection` and `wallet_transfer`, with code `autonomy_off`.
  `concept_generation` set to `off` also stops the generation job being scheduled
  at all.
- **`auto`** is the only level that lets the platform act without a human.
  `launch: auto` skips the approval queue (subject to risk flags, below);
  `fee_collection: auto` enables the automatic collection job; `wallet_transfer:
  auto` is required — together with `wallet.autoSweepEnabled` — for automatic
  treasury sweeps.
- **`suggest` and `approve` are not distinguished anywhere.** Only `off` and
  `auto` are tested for. Setting `launch: suggest` behaves exactly like
  `approve`: the candidate lands in the approval queue.
- **`artwork`, `metadata` and `social` have no consumer at all.** They are
  editable and audited but change no behaviour. `social` is only referenced in
  the phase-ceiling check.

Even at `launch: auto`, a candidate is routed to human review when any risk flag
has severity `review`, or when `qualityGate.humanReviewOnAnyRiskFlag` is true and
the concept carries any flag whatsoever.

Autonomy above `approve` is rejected below phase 4 — see *Phase enforcement*.

### `qualityGate`

The thresholds a concept must clear to become a launch candidate.

| Field | Default | Range | Effect |
|---|---|---|---|
| `minOpportunityScore` | `58` | 0–100 | Trend opportunity score floor. Soft: the exploration path may lower it. |
| `minOriginalityScore` | `0.62` | 0–1 | Concept originality floor. Never relaxed by exploration. |
| `maxSaturationScore` | `0.45` | 0–1 | Ceiling on how tokenised the space already is. Soft: exploration may raise it. |
| `minProbabilityTenHolders` | `0.18` | 0–1 | Modelled probability of at least ten organic holders. |
| `minExpectedValueSol` | `0.0` | unbounded | Modelled EV in SOL net of launch and generation costs. Negative values are legal and meaningful — see the Exploratory profile. |
| `minProbabilityProfitable` | `0.12` | 0–1 | Modelled probability the launch is net profitable. |
| `minSourceBreadth` | `2` | 1–10 (integer) | Independent trend sources that must confirm. This is the platform's central thesis expressed as a number. |
| `maxTrendAgeHours` | `96` | ≥ 1 | **Hard** block: a trend older than this is rejected outright, exploration included. |
| `blockOnHardCollision` | `true` | boolean | **Hard** block on a name/ticker collision close enough to confuse traders. |
| `humanReviewOnAnyRiskFlag` | `true` | boolean | Routes to approval on any flag, including advisory ones. |

The gate evaluates in two passes. Hard blocks — blocking safety flags, hard
collision (when enabled), trend age — are checked first and are never relaxed.
Soft thresholds are checked second, and the rejection *reason* names only the
first one that failed. Every check's value and threshold is still recorded on the
decision, so the full picture is in the candidate record even when the headline
reason mentions one line of it.

**When you would change these.** Raise `minOpportunityScore`,
`minProbabilityTenHolders` and `minProbabilityProfitable` together when you are
paying for launches that never find a holder. Lower `maxSaturationScore` when
you keep launching into crowded spaces. Raise `minSourceBreadth` to 3 when you
suspect a single noisy source is driving your candidates — this is the cheapest
quality improvement available, and the most likely to reduce volume to near
zero. Turn `humanReviewOnAnyRiskFlag` off only if you are reading the flags in
the audit log instead.

### `limits`

The safety envelope. Every side-effecting operation consults `GuardService`
first, and all counters are derived from the database rather than held in
memory, so a crash loop cannot reset a daily limit.

| Field | Default | Range | Effect |
|---|---|---|---|
| `maxLaunchesPerHour` | `1` | 0–20 (integer) | Launches counted per network in the last hour. Clamped to `maxLaunchesPerDay`. |
| `maxLaunchesPerDay` | `3` | 0–50 (integer) | Clamped to 24. |
| `maxSolSpendPerDay` | `0.5` | ≥ 0 | Clamped to 5. Counts all committed spend, not just launches. |
| `maxSolPerTransaction` | `0.15` | ≥ 0 | Clamped to 2. Also the effective ceiling on `devBuySol`. |
| `maxSolPerHour` | `0.3` | ≥ 0 | Clamped to `maxSolSpendPerDay`. |
| `maxAiSpendUsdPerDay` | `10` | ≥ 0 | Clamped to 200. Checked before each request against a rolling 24h window, using an estimate that assumes the response fills `ai.maxOutputTokens`. |
| `walletBalanceFloorSol` | `0.05` | ≥ 0 | Spending that would take the operating wallet below this is refused, so the platform can always afford to collect the fees it has earned. |
| `consecutiveFailureShutdown` | `3` | ≥ 1 (integer) | Consecutive launch failures before launching halts. |
| `maxClockDriftSeconds` | `120` | ≥ 1 | Health check compares the wall clock against a monotonic reference taken at startup. Blockhashes expire on wall-clock time. |
| `rpcFailureThreshold` | `8` | ≥ 1 (integer) | **Not consumed by any code path.** |
| `maxTransactionRetries` | `3` | 0–10 (integer) | **Not consumed by any code path.** Retries are handled inside the RPC client with its own constants. |

A launch pre-flight reserves `devBuySol + 0.006 SOL` against the per-transaction,
hourly, daily and floor checks — the 0.006 is the fixed allowance for rent and
fees, so a zero dev buy still consumes budget.

**When you would change these.** The defaults are sized for a first mainnet run:
three launches a day and half a SOL. Raise `maxSolSpendPerDay` before
`maxLaunchesPerDay` — running out of SOL mid-day produces a confusing failure
mode where the launch limit looks untouched. Raise `maxAiSpendUsdPerDay` first
if generation stops with `ai_budget`; $10/day is easy to exhaust with the panel
enabled and Opus on the decision tier.

### `wallet`

| Field | Default | Range | Effect |
|---|---|---|---|
| `sweepThresholdSol` | `1.0` | ≥ 0 | Balance above which a sweep to treasury is proposed. |
| `operatingFloatSol` | `0.3` | ≥ 0 | Left behind after a sweep. |
| `autoSweepEnabled` | `false` | boolean | Automatic sweeping. Requires `autonomy.wallet_transfer === 'auto'` as well — both, or nothing happens. |
| `treasuryAddress` | unset | optional string | Public key only. This process never holds the treasury key. |

The health check warns when `autoSweepEnabled` is true and `treasuryAddress` is
unset, because that combination silently does nothing. Manual sweeps
(`POST /api/wallet/sweep`) need `transfer_funds` and ignore `autoSweepEnabled`
but still respect the threshold and float.

### `fees`

Creator fees accrue in **two vaults per creator wallet, not per token** — the
bonding-curve vault and the AMM coin-creator vault — so a claim is a wallet
operation and every setting below is evaluated per wallet, never per mint.
Attributing the proceeds back to individual tokens is bookkeeping the fee
service does after the fact. Collection costs a transaction, so collecting too
eagerly loses money.

| Field | Default | Range | Effect |
|---|---|---|---|
| `collectionThresholdSol` | `0.002` | ≥ 0 | Minimum claimable before a collection is considered. |
| `minHoursBetweenCollections` | `6` | ≥ 0 | Minimum hours since the wallet's last collection. |
| `minCollectionValueRatio` | `5` | ≥ 1 | Claim must recover at least this multiple of its estimated transaction cost. |
| `forceCollectionIntervalHours` | `168` | ≥ 0 | Once fees have been accruing this long without being claimed, the threshold and ratio checks are waived. `0` disables the override. |

The force interval waives the **threshold and the value-ratio** checks — not
`minHoursBetweenCollections`, which still applies, and not the absolute
never-pay-for-itself guard: a claim whose claimable balance does not exceed its
estimated transaction cost is refused first, before any of these settings are
consulted, forced or not. Note also that the bonding-curve vault permanently
retains its rent-exempt minimum, so a small nonzero vault balance is not
claimable at all.

Lower `minCollectionValueRatio` towards 2 if dust is accumulating faster than
the weekly sweep clears it; raise it if collections are eating their own
proceeds.

### `monitoring`

Polling frequency follows attention rather than age alone.

| Field | Default | Range | Effect |
|---|---|---|---|
| `hotIntervalSeconds` | `60` | ≥ 15 (integer) | Poll interval in the hot tier. |
| `warmIntervalSeconds` | `600` | ≥ 60 (integer) | Warm tier. |
| `coolIntervalSeconds` | `3600` | ≥ 300 (integer) | Cool tier. |
| `dormantIntervalSeconds` | `86400` | ≥ 3600 (integer) | Dormant tier. |
| `dormantAfterQuietHours` | `72` | ≥ 1 | No volume and no holder growth for this long marks a token dormant. |
| `hotWindowHours` | `6` | ≥ 0.25 | Age within which a token stays hot. |
| `warmWindowHours` | `48` | ≥ 1 | Age within which a token stays warm. |

Tier selection is not purely by age: `high_momentum` and `growing` tokens are
hot regardless of age, `dormant` and `failed` are dormant regardless, and any
token quiet for more than 24 hours drops to cool even inside `warmWindowHours`.
That 24-hour figure is a constant, not a setting. Each computed interval gets
±10% jitter so a tier does not become due all at once and spike into a rate
limit.

Shorten the hot interval only if your RPC and market providers can take it —
these settings are the platform's main source of outbound request volume.

### `research`

| Field | Default | Range | Effect |
|---|---|---|---|
| `enabledSources` | `['google_trends','bluesky','mastodon','wikipedia','hackernews','gdelt']` | any `TrendSourceId` | Only these providers run during discovery. |
| `discoveryIntervalMinutes` | `30` | ≥ 5 (integer) | Discovery job interval. Read when the job is registered at boot — see below. |
| `maxActiveTrends` | `400` | ≥ 10 (integer) | Working-set size for rescoring. |
| `conceptGenerationThreshold` | `52` | 0–100 | Opportunity score a trend must reach to earn concept generation. Deliberately below `qualityGate.minOpportunityScore` — generation is cheap relative to the information it produces. |
| `conceptsPerOpportunity` | `4` | 1–12 (integer) | Concepts generated per qualifying opportunity. |
| `customSubreddits` | `[]` | strings | Extra subreddits for the Reddit provider (needs credentials). Read once when the provider is constructed. |
| `mastodonInstances` | `['mastodon.social','fosstodon.org','mstdn.social']` | strings | Polling more instances de-biases any single community. |
| `googleTrendsRegions` | `['US','GB','CA','AU']` | region codes | Regions swept. |
| `customRssFeeds` | `[]` | URLs (validated) | Feeds for the `rss` provider. |
| `customKeywords` | `[]` | strings | **Seeds GDELT.** GDELT has no discovery endpoint of its own, so with an empty keyword list it is a confirmation source with nothing to confirm. |

Two zero-auth sources ship **disabled**: `stackexchange` and `rss`. `gdelt` ships
enabled but does nothing useful until `customKeywords` is populated. Adding a
source to `enabledSources` has no effect unless its provider registered at boot —
`youtube` and `reddit` need credentials, and `x` has no provider implementation
at all despite being a valid enum value.

**When a change takes effect.** Only `customKeywords` (GDELT) and
`customRssFeeds` (the RSS provider) are read through closures on every use and
therefore apply immediately. `googleTrendsRegions`, `mastodonInstances` and
`customSubreddits` are snapshotted when the provider registry is built, and the
registry is rebuilt only at boot and whenever a secret is stored or deleted
(`PUT`/`DELETE /api/system/secrets/:key`). Until one of those happens, editing
them changes the stored settings and nothing else. The same applies to
`ai.imageModel`, and to `execution.network`, which selects the RPC endpoints and
launch adapters at registry-build time — switch the network and the matching
adapter does not exist until the next rebuild, so a launch fails with
`not_configured`. Restarting is the reliable way to apply any of these.

`discoveryIntervalMinutes` is read once more narrowly still: the scheduler takes
it when it registers the `trend-discovery` job at boot and reschedules from that
in-memory value thereafter. `PATCH /api/jobs/trend-discovery` with an
`intervalSeconds` shifts only the *next* run; the run after it returns to the
boot-time interval. Restart to change it for good.

### `ai`

| Field | Default | Range | Effect |
|---|---|---|---|
| `triageModel` | `claude-haiku-4-5-20251001` | string | Cheap tier: triage and classification. |
| `generationModel` | `claude-sonnet-5` | string | Mid tier: candidate generation. |
| `decisionModel` | `claude-opus-5` | string | Strong tier: the final launch decision. |
| `imageModel` | `none` | string | `none` leaves the OpenAI image provider on its own default of `gpt-image-1`; any other value is passed through as the model id. It does **not** disable image generation, despite what the dashboard's help text for this field says. |
| `panelEnabled` | `true` | boolean | The multi-agent evaluation panel. Costs more, decides better. |
| `panelRoles` | `['skeptic','market_analyst','risk']` | subset of `skeptic`, `market_analyst`, `risk`, `creative_critic` | Roles run in the panel. `creative_critic` is available but off by default. |
| `cacheTtlMinutes` | `240` | ≥ 0 (integer) | Identical prompts are served from cache, but only for calls the caller marks cacheable or that run at temperature ≤ 0.3 — a deliberately varied call is never cached. `0` disables caching entirely. |
| `maxConcurrentRequests` | `4` | 1–16 (integer) | Applied by a semaphore, resized on each call. |
| `maxOutputTokens` | `4096` | ≥ 256 (integer) | Hard per-request ceiling. Callers may request less, never more. |

Cache identity includes provider, model, system prompt, messages, response
schema, temperature and the output ceiling — changing any of them is a miss.
Cache hits are still recorded to the AI ledger at zero cost, so the dashboard
shows how much work was done and how much the cache saved.

Model ids are strings, not an enum, so a typo is not caught at write time; it
surfaces as the tier-substitute warning or as `not_configured`. Cost estimation
uses each provider's published per-model prices and assumes the response fills
`maxOutputTokens`, which makes the budget check conservative — it will refuse a
request slightly before the real spend would exceed the cap.

The cheapest meaningful economy is `panelEnabled: false`; the next is dropping
`decisionModel` a tier. Both degrade decisions, and both are visible in the
prediction confidence.

### `exploration`

Deliberately launching some candidates the gate would otherwise reject, because
a model trained only on candidates that passed the gate cannot learn where the
gate is wrong.

| Field | Default | Range | Effect |
|---|---|---|---|
| `enabled` | `true` | boolean | Master switch. |
| `minExplorationRate` | `0.1` | 0–1 | Floor on the fraction of launches reserved for exploration. |
| `maxExplorationRate` | `0.5` | 0–1 | Starting rate, which decays with evidence. |
| `explorationMinOpportunityScore` | `45` | 0–100 | Relaxed opportunity floor for exploration candidates. |
| `explorationMaxSaturation` | `0.6` | 0–1 | Relaxed saturation ceiling. |

The effective rate is `max(floor, ceiling × 40 / (40 + totalLaunches))` — half the
exploration budget is gone by 40 launches, and it decays towards the floor
thereafter. The half-life of 40 is a constant, not a setting.

Two things worth knowing before you tune this:

- Exploration relaxes **only** the opportunity score and the saturation ceiling,
  and only in the safe direction (`min()` and `max()` respectively). Setting
  `explorationMinOpportunityScore` above `qualityGate.minOpportunityScore` has no
  effect. Originality, EV, both probability gates and every hard block apply
  unchanged.
- The decision is deterministic per concept — seeded from the concept id — so
  re-evaluating a candidate never flips it by luck.

### `notifications`

| Field | Default | Range | Effect |
|---|---|---|---|
| `enabledEvents` | `launch_succeeded`, `launch_failed`, `token_graduated`, `large_fee_accrual`, `wallet_balance_low`, `emergency_stop`, `candidate_awaiting_approval` | any `NotificationEvent` | An event not listed is dropped before anything is written — a disabled event does not accumulate in the notification table either. The caller gets a reason back but nothing is persisted. |
| `webhookEnabled` | `false` | boolean | Generic JSON POST. Needs `notify.webhook.url`. |
| `discordEnabled` | `false` | boolean | Needs `notify.discord.webhook`. |
| `telegramEnabled` | `false` | boolean | Needs both the bot token and the chat id. |
| `emailEnabled` | `false` | boolean | **Not implemented.** See below. |
| `largeFeeAccrualSol` | `0.05` | ≥ 0 | Threshold for `large_fee_accrual`. |
| `highVolumeSol` | `50` | ≥ 0 | 24h volume threshold for `high_organic_volume`. |
| `dedupeWindowMinutes` | `60` | ≥ 0 (integer) | Duplicate suppression window per dedupe key. `0` disables it. |

Eight more events exist and ship off: `high_organic_volume`, `fees_collected`,
`system_paused`, `provider_unavailable`, `unusual_activity`,
`high_value_opportunity`, `model_retrained`, `daily_digest`.

Two channel quirks:

- **Slack has no toggle.** Storing `notify.slack.webhook` is the opt-in; deleting
  it is the opt-out.
- **Email does not send.** The notification service speaks HTTP only. Email rows
  are written and immediately marked `skipped` with the reason
  `Email delivery is not implemented in this service; configure a webhook, Discord, Telegram or Slack channel instead.`
  This is deliberate — it makes a misconfigured expectation visible in the
  delivery table rather than leaving you wondering why no mail arrives.

A channel is used only when it is switched on *and* its credential exists —
except email, which is selected by `emailEnabled` alone (no credential is ever
read) and then skipped at delivery. Delivery uses `allSettled`, so a dead channel
cannot cancel the others.

### `execution`

| Field | Default | Range | Effect |
|---|---|---|---|
| `network` | `simulation` | `simulation`, `devnet`, `mainnet` | Must be permitted by the current phase, or the update is refused. |
| `phase` | `phase1_research` | the five phases | The autonomy ladder. See below. |
| `devBuySol` | `0` | 0–5, clamped to `maxSolPerTransaction` | Optional developer buy at creation. `0` means create-only. |
| `slippageBps` | `500` | 0–10000 (integer) | Slippage tolerance for the dev buy, in basis points. 500 = 5%. |
| `priorityFeeMicroLamports` | `0` | ≥ 0 (integer) | `0` means auto-estimate. Non-zero overrides the estimate. |
| `adapter` | `auto` | `auto`, `pumpportal_local`, `pumpfun_sdk`, `simulation` | `auto` picks the first registered adapter supporting the network. A named adapter that is unavailable or does not support the network falls back to `auto` behaviour rather than failing. Only two adapters are ever registered — `simulation`, and `pumpfun_sdk` on devnet and mainnet — so **`pumpportal_local` selects nothing** and behaves exactly like `auto`. |
| `jitoTipSol` | `0` | ≥ 0 | **Not consumed by any code path.** No bundle submission exists. |
| `commitment` | `confirmed` | `processed`, `confirmed`, `finalized` | **Not consumed by any code path.** The RPC client is constructed with `confirmed` unconditionally. |

`network: simulation` always routes to the simulation adapter regardless of the
`adapter` setting. Changing `network` does not itself rebuild the RPC endpoints
or the launch adapters — those are built from the network in effect at the last
provider-registry build, so restart after switching networks (see *When a change
takes effect*, above).

### Top level

| Field | Default | Effect |
|---|---|---|
| `emergencyStop` | `false` | Global kill switch. Blocks every guarded operation — including research and concept generation, because a paused system that keeps burning AI credits is not paused. Read-only jobs continue so the dashboard stays accurate. |
| `emergencyStopReason` | `''` | Recorded with the stop and quoted in every refusal. |
| `onboardingCompleted` | `false` | UI marker only. |

The guard can engage the stop itself via `autoStop()` — the consecutive-failure
breaker is the main caller. Engaging and releasing are both audited and emit
`system.emergency_stop`.

---

## Phase enforcement

`SettingsService.assertPhaseAllowsAutonomy` enforces the ladder on every write.

| Phase | Networks permitted | Max autonomy |
|---|---|---|
| `phase1_research` | `simulation` | `approve` |
| `phase2_devnet` | `simulation`, `devnet` | `approve` |
| `phase3_mainnet_approval` | `simulation`, `devnet`, `mainnet` | `approve` |
| `phase4_limited_autonomous` | `simulation`, `devnet`, `mainnet` | `auto` |
| `phase5_adaptive_autonomous` | `simulation`, `devnet`, `mainnet` | `auto` |

A network the phase does not permit is refused with `forbidden`. Autonomy above
the ceiling — checked for `launch`, `fee_collection`, `wallet_transfer` and
`social` — is refused *when the patch raises it*. A value that already exceeded
the ceiling, which a phase downgrade can produce, is clamped down to the ceiling
and logged instead, so a stale over-reach does not lock you out of editing
unrelated settings.

The practical consequence: `phase` and `network` must be raised in separate,
ordered steps, and `autonomy.launch: auto` is impossible before phase 4. That
ordering is the thing preventing an accidental mainnet launch.

---

## Sensitive settings

`SENSITIVE_SETTING_PATHS` marks the changes that materially increase risk:

```
autonomy.launch              limits.maxSolPerTransaction
autonomy.fee_collection      limits.maxSolPerHour
autonomy.wallet_transfer     limits.walletBalanceFloorSol
execution.network            wallet.treasuryAddress
execution.phase              wallet.autoSweepEnabled
execution.devBuySol          qualityGate.minOpportunityScore
limits.maxLaunchesPerDay     qualityGate.maxSaturationScore
limits.maxLaunchesPerHour    qualityGate.minExpectedValueSol
limits.maxSolSpendPerDay     qualityGate.blockOnHardCollision
emergencyStop
```

`isSensitiveSettingPath` matches a listed path exactly or any path beneath it,
so `autonomy.launch.anything` counts too.

**What the marking does.** Sensitive changes are written to the tamper-evident
audit log as a single `settings.changed` entry carrying before/after values, the
actor, the IP address and the reason. `execution.phase` and `emergencyStop`
additionally get their own dedicated audit actions. The `PATCH /api/settings`
response echoes `sensitiveChanges` so a UI can confirm what was just escalated.

**What it does not do.** It is not the permission model. *Every* settings change
— sensitive or not — is written to `setting_history` with the previous value,
the new value, the actor and an optional reason. And permissions are checked by
path prefix at the route, on a different partition:

| Paths touched | Permission required |
|---|---|
| `autonomy.*` | `edit_autonomy` |
| `limits.*`, `qualityGate.*` | `edit_limits` |
| `wallet.*`, `execution.*` | `edit_wallet_config` |
| `emergencyStop` | `emergency_stop` |
| anything else (`ai.*`, `research.*`, `monitoring.*`, `fees.*`, `notifications.*`, `exploration.*`) | `edit_limits` |

A patch touching several groups must satisfy every applicable permission. Because
none of the settings permissions are held by the `analyst` or `viewer` roles,
settings are effectively owner- and admin-only; `analyst` can read them and read
the history (`view_audit`) but change nothing.

---

## Tuning profiles

The Strategy Lab ships three presets, readable at `GET /api/strategies` and
defined in `BacktestService.defaultStrategies()`. They are **backtest
strategies, not settings bundles** — there is no endpoint that applies one. Each
preset combines `qualityGate` fields with `maxLaunchesPerDay`, which in live
settings lives under `limits`. Compare them against your own history first, then
apply the numbers by hand.

| Setting | Selective | Balanced (shipped defaults) | Exploratory |
|---|---|---|---|
| `qualityGate.minOpportunityScore` | 72 | 58 | 45 |
| `qualityGate.minOriginalityScore` | 0.75 | 0.62 | 0.5 |
| `qualityGate.maxSaturationScore` | 0.28 | 0.45 | 0.65 |
| `qualityGate.minProbabilityTenHolders` | 0.32 | 0.18 | 0.08 |
| `qualityGate.minExpectedValueSol` | 0.02 | 0.0 | −0.01 |
| `qualityGate.minProbabilityProfitable` | 0.25 | 0.12 | 0.05 |
| `qualityGate.minSourceBreadth` | 3 | 2 | 1 |
| `qualityGate.maxTrendAgeHours` | 48 | 96 | 120 |
| `qualityGate.blockOnHardCollision` | true | true | true |
| `qualityGate.humanReviewOnAnyRiskFlag` | true | true | true |
| `limits.maxLaunchesPerDay` | 1 | 3 | 5 |

**Selective.** Thesis: creator fees are so concentrated in a few winners that
the only decision that matters is refusing the rest. Launch at most one token a
day, only into fast-moving and largely unclaimed trends, and only when the model
expects a clear positive return. Risk: with one launch a day and a tail-dominated
payoff, the strategy can go weeks without touching a winner while still paying
the per-launch cost, and the small sample it generates starves the model of the
outcomes it needs to improve.

**Balanced.** Thesis: the shipped defaults are a reasonable prior. Risk: it is a
compromise, so it is beaten by Selective in a market where only the very best
candidates pay and by Exploratory in a market whose winners the current model
cannot yet recognise — and it will not tell you which market you are in.

**Exploratory.** Thesis: the model is trained on too few outcomes to be trusted
as a filter, so the binding constraint is information, not selection. Accept
weaker candidates and more of them, tolerate crowded trends, and buy outcomes to
learn from. Note the negative `minExpectedValueSol`: this profile deliberately
accepts candidates the model expects to lose a little money on, because their
information value is higher than their cost. Risk: this is the only preset that
can lose money steadily rather than in bursts — more launches means more certain
cost against a payoff that still depends on rare tails, and a permissive gate
raises the chance of launching into a saturated or reputationally awkward space.

`blockOnHardCollision` and `humanReviewOnAnyRiskFlag` are `true` in all three,
including Exploratory, and that is intentional in the source: a hard name
collision is a trader-confusion problem, not a return problem, and exploration is
no excuse for it.

### Applying a profile

Budgets are not part of the presets, and whether they bind depends on
`execution.devBuySol`. A launch reserves `devBuySol + 0.006 SOL`, so at the
default dev buy of `0` even Exploratory's five launches a day reserve only 0.03
SOL and `maxSolSpendPerDay` never binds. Put a 0.1 SOL dev buy behind those same
five launches and the reservation is 0.53 SOL, which the default
`maxSolSpendPerDay` of 0.5 refuses partway through the day — and the launch
counter will look untouched while it happens. Set the spend limits in the same
patch as the launch count.

The API authenticates with an HttpOnly session cookie, and every non-GET request
must also carry the session's CSRF token in an `x-csrf-token` header
(`GET /api/auth/session` returns it), so a `curl` example needs both — the
dashboard's Settings pages are the ordinary path.

```bash
curl -X PATCH http://127.0.0.1:4317/api/settings \
  -H 'content-type: application/json' \
  -H "x-csrf-token: $CSRF_TOKEN" \
  -b "solcoin_session=$SESSION_TOKEN" \
  -d '{
    "patch": {
      "qualityGate": { "minOpportunityScore": 72, "minOriginalityScore": 0.75,
                       "maxSaturationScore": 0.28, "minProbabilityTenHolders": 0.32,
                       "minExpectedValueSol": 0.02, "minProbabilityProfitable": 0.25,
                       "minSourceBreadth": 3, "maxTrendAgeHours": 48 },
      "limits": { "maxLaunchesPerDay": 1, "maxLaunchesPerHour": 1,
                  "maxSolSpendPerDay": 0.2, "maxSolPerHour": 0.2 }
    },
    "reason": "Moving to the Selective profile after 40 launches"
  }'
```

That patch touches `qualityGate` and `limits`, so it needs `edit_limits` —
owner or admin.

Always read the `settings` object back from the response rather than assuming
the patch applied verbatim — clamping is silent, and the relational clamps in
particular will change values you did not name.

---

## Settings that currently do nothing

Collected in one place so nobody spends an afternoon on them:

| Setting or key | Status |
|---|---|
| `autonomy.artwork`, `autonomy.metadata` | No consumer |
| `autonomy.social` | Only referenced by the phase-ceiling check |
| Autonomy level `suggest` | Never distinguished from `approve` |
| `limits.rpcFailureThreshold` | No consumer |
| `limits.maxTransactionRetries` | No consumer; retries use RPC-client constants |
| `execution.adapter: pumpportal_local` | Valid enum value, no adapter registered under that id; behaves as `auto` |
| `execution.jitoTipSol` | No consumer; no bundle submission exists |
| `execution.commitment` | No consumer; the RPC client is built with `confirmed` |
| `notifications.emailEnabled` | Records deliveries as `skipped`; SMTP is not implemented |
| `HARD_LIMITS.maxConceptsPerCycle` | No consumer |
| `market.birdeye.api_key`, `trends.x.bearer_token`, `execution.pumpportal.api_key`, `notify.smtp.url` | No consumer |
| Trend source `x` | Valid enum value, no provider implementation |

They validate, persist, audit and appear in the API — they simply change no
behaviour.
