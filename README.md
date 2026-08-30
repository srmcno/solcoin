# Solcoin

An autonomous research platform that looks for emerging cultural trends, develops
original token concepts around the ones that look genuinely underserved, evaluates
them adversarially, launches the few that survive on Solana via Pump.fun, monitors
what happens, collects creator fees, and measures every prediction against what
actually occurred.

The product is **opportunity discovery and prediction**, not token creation. Token
creation is a few hundred lines. Knowing *which* token is worth creating, *when*,
and being honest with yourself about whether it worked, is the hard part and is
where almost all of this codebase lives.

**Setting it up for real:** [`docs/going-live.md`](docs/going-live.md) — the
economics before anything else, then what you must obtain yourself, then
`npm run setup`.

**Project site:** https://srmcno.github.io/solcoin/ — architecture, the guardrails,
and the full review history. The dashboard itself is not hosted there; it needs the
server, its database and its credentials.

---

## What it actually does

```
 discover ──▶ resolve identity ──▶ score opportunity ──▶ generate concepts
                                                              │
                        ┌─────────────────────────────────────┘
                        ▼
  deterministic screen ──▶ adversarial panel ──▶ predict ──▶ quality gate
                                                                  │
                        ┌─────────────────────────────────────────┘
                        ▼
   artwork + metadata ──▶ approve ──▶ launch ──▶ monitor ──▶ collect fees
                                                    │
                        ┌───────────────────────────┘
                        ▼
        compare prediction to reality ──▶ update the model ──▶ (loop)
```

Every stage is inspectable in the dashboard, and every decision records the exact
inputs it was made from.

### The thesis

The edge this platform claims is **timing and independent confirmation**, not
creativity. Concretely:

- The same cultural moment appears on Google Trends, Bluesky, Wikipedia and in
  news coverage under four different names. Resolving those into one trend, and
  weighting confirmation by *source family* (search demand and encyclopaedia
  lookups are independent populations; two Fediverse instances are not), is the
  single most informative signal available for free.
- A trend that is rising but not yet tokenised is worth far more than a bigger
  trend that already has forty tokens. Saturation therefore enters scoring
  multiplicatively, not as one term among many.
- Token outcomes are extremely heavy-tailed. Expected value is computed by Monte
  Carlo over the joint outcome distribution, never by multiplying averages, and
  every revenue figure is reported with its median and percentiles because the
  mean on its own is misleading.

### What it will not do

The platform earns money only when independent people voluntarily trade a token
it created. It contains no mechanism for manufacturing that activity, and this
is enforced in code rather than stated as policy: there is no trading engine, no
secondary wallet management, no social automation, and no code path that buys or
sells a launched token beyond an optional, configurable, disclosed developer buy
at creation.

No wash trading. No self-trading. No coordinated wallets. No fake holders, volume
or engagement. No impersonation, fabricated endorsements, or invented news. No
guaranteed-return claims. The deterministic risk screen blocks protected marks,
financial promises, tragedy exploitation and impersonation before any model is
consulted, and a model cannot argue its way past it.

---

## Quick start

Requires Node.js 20.11 or newer.

```bash
git clone <this repository>
cd solcoin
npm install

# Generate a master key. It encrypts every credential and the wallet keystore.
echo "SOLCOIN_MASTER_KEY=$(openssl rand -base64 32)" > .env

npm run build
npm start
```

Open <http://127.0.0.1:4317> and create the owner account.

That is the whole setup. **No API keys are required to get useful output.** Six
trend sources work with no credentials at all (Google Trends, Bluesky, Mastodon,
Wikipedia, Hacker News, Stack Exchange), as do three market-data sources (Jupiter,
DexScreener, the pump.fun API). The platform starts in simulation mode on
`phase1_research`, so it discovers and scores real opportunities immediately
while broadcasting nothing.

To see what is configured and what is missing:

```bash
npm run doctor
```

### Adding capability

| To enable | Configure | Where |
|---|---|---|
| Concept generation and evaluation | An Anthropic or OpenAI API key | Settings → Providers |
| Generated artwork | An OpenAI key (otherwise procedural artwork is used) | Settings → Providers |
| Devnet or mainnet launches | An operating wallet | Settings → Wallet |
| Faster, more reliable RPC | A Helius key or your own RPC URL | Settings → Providers |
| YouTube and Reddit trend sources | Their respective credentials | Settings → Providers |
| Notifications | A Discord, Slack, Telegram or generic webhook | Settings → Notifications |

Concept generation is the one thing that genuinely requires a credential: there
is no local model, and the platform reports that plainly rather than producing
placeholder concepts.

---

## Phased activation

Autonomy is unlocked in deliberate steps. The server enforces the ladder — it is
not advice, and an attempt to skip it is refused with an explanation.

| Phase | Network | Max autonomy | What it does |
|---|---|---|---|
| 1 · Research | simulation | approve | Discovers, scores, generates and paper-launches. Nothing is broadcast. |
| 2 · Devnet | + devnet | approve | Exercises the real on-chain launch path with worthless SOL. |
| 3 · Mainnet, approved | + mainnet | approve | Real launches, each requiring a human click. |
| 4 · Limited autonomous | mainnet | auto | Launches without approval, inside the configured limits. |
| 5 · Adaptive autonomous | mainnet | auto | The model steers its own thresholds from its performance history. |

`approve` is available from phase 1 because it still requires a person to act.
The ladder gates *unattended* action.

Devnet is genuinely useful here: the Pump programs are deployed on devnet at the
identical addresses, so the whole launch path can be exercised for free. Note
that devnet bonding-curve reserves differ from mainnet, so devnet pricing and
market-cap figures will not match mainnet.

---

## Safety envelope

Every side-effecting operation asks one service for permission first, so there
is exactly one thing to audit and one thing to test.

- **Hard ceilings** no UI, API or model can exceed: launches per day, SOL per
  transaction, per hour and per day, AI spend per day.
- **Counters derived from the database**, never held in memory, so a crash loop
  cannot reset a daily limit.
- **Consecutive-failure breaker** that engages the emergency stop automatically
  rather than burning rent on transactions that will not land.
- **Wallet balance floor** so the platform cannot spend itself into a state
  where it cannot afford to collect the fees it has earned.
- **Global emergency stop** that suspends every job with side effects while
  leaving read-only jobs running, so the dashboard stays accurate while paused.

## Wallet custody

```
   TREASURY            key held elsewhere; the platform knows only the address
      ▲
      │ periodic sweeps of accumulated revenue
      │
   OPERATING WALLET    encrypted keystore, funded with only what is needed soon
      │
      ▼
   launches, fee claims
```

The point is bounded loss: a total compromise of this process costs the operating
float, not the accumulated revenue. The private key is stored only as AES-256-GCM
ciphertext under a key derived from a passphrase that lives in the environment and
is never written to disk by this application, exists in plaintext only inside a
single signing call, and never crosses the HTTP boundary. Export is possible, but
requires an exact confirmation phrase and is written to the audit log.

This is not hardware-backed. A process-level compromise during a signing window
can reach the key. Operators who need a stronger guarantee should run in
`watch_only` custody with an external signer.

---

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | How the pieces fit, and why each choice was made |
| [Configuration](docs/configuration.md) | Every setting, what it does, and how to tune it |
| [Strategy](docs/strategy.md) | The scoring, prediction and learning methodology in detail |
| [Security](docs/security.md) | Threat model, key custody, prompt-injection defence, audit log |
| [Operations](docs/operations.md) | Deployment, monitoring, backup, recovery, troubleshooting |

---

## Development

```bash
npm run dev        # API with rebuild-on-change, plus the dashboard dev server
npm run typecheck  # every package
npm run lint       # ESLint, warnings included
npm test           # unit, integration and end-to-end suites
npm run doctor     # pre-flight diagnostics
```

The test suite is offline. Every provider is either faked or pointed at the
simulation adapter, so a slow or blocked network cannot make it fail. The
network is exercised by `npm run doctor` instead, which is honest about which
providers actually answered.

CI runs the typecheck, the lint, the tests and a production build on every
pull request, then applies the migrations to an empty database — a migration
that does not apply cleanly is a deploy-time failure otherwise.

The server is bundled with esbuild rather than run from loose files. This is a
correctness requirement, not a packaging preference: several Solana packages ship
ESM that imports named bindings from CommonJS-only dependencies, which Node's
loader cannot resolve statically. Bundling resolves the interop at build time and
keeps development and production on identical code paths.

### Layout

```
packages/
  shared/    statistics, scoring, prediction, safety — no I/O, heavily tested
  server/    database, providers, services, jobs, HTTP API
  web/       React dashboard
tests/
  unit/          pure logic
  integration/   services against a real database
  e2e/           the whole workflow through the real HTTP surface
```

---

## Honest limitations

Stated here rather than discovered later:

- **The model starts as a prior, not a measurement.** Until real launches
  accumulate, every probability is encoded domain judgement. The dashboard says
  so, and confidence is reported alongside every prediction.
- **Backtesting a launch strategy suffers selection bias.** The platform only
  observes outcomes for tokens it actually launched. Counterfactuals are
  modelled, never measured, and the Strategy Lab separates realised from
  modelled figures rather than merging them into one comforting number.
- **Per-token fee attribution is an estimate.** Creator fees accrue into two
  wallet-level vaults, not per token, so accrual is apportioned by each token's
  share of measured organic volume. Wallet-level totals are exact.
- **Third-party APIs change without notice.** Pump.fun's interfaces have already
  changed more than once. Execution sits behind an adapter interface so a
  protocol change is a new adapter rather than a rewrite, and fee parameters are
  read from chain at runtime rather than hardcoded.
- **Most launches earn nothing.** That is a property of the market, not of this
  software. The analytics are built to make that visible rather than to hide it
  behind an average.
- **This is not financial or legal advice**, and the accounting exports are
  bookkeeping records rather than tax filings.

## Licence

No licence is granted by default. Add one before distributing.
