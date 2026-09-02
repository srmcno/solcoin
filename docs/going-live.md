# Going live

The path from a fresh clone to a platform that can actually earn creator fees,
in the order the steps have to happen, with the parts you must do yourself
named as such.

Read the economics section first. It is the part that decides whether the rest
is worth doing, and it is not encouraging.

---

## 1. What this can actually earn

### The mechanism

You earn when **other people trade a token you created**. Nothing else in this
system makes money. There is no trading strategy, no arbitrage, no yield.

Fees come from two places, and they are not the same size.

**On the bonding curve** — where every token starts — a trade pays a total fee
of **1.25%** of its value. That splits into 0.95% to the protocol and **0.30%
to you, the creator**. So:

```
your revenue  =  0.0030  ×  (SOL volume traded on the curve)
```

**After graduation to a canonical PumpSwap pool**, the creator share follows a
25-step ladder keyed to market cap in SOL, decoded from the live fee-config
account on 2026-08-30. It is **0.30% below 420 SOL of market cap**, jumps to
its maximum of **0.95% in the 420–1,470 SOL band**, then declines step by step
to **0.05%** above 98,240 SOL. The total swap fee falls from 1.25% to 0.30%
across the same ladder, and a parallel 25-tier ladder with the same creator
rates applies to USDC-denominated pools. Most tokens never get here.

Two details worth knowing if you reconcile against pump.fun's published table:
where its docs show half-basis-point rates (0.275%, 0.225%, 0.175%, 0.125%,
0.075%) the on-chain config actually charges 28, 23, 18, 13 and 8 bps; and
pump.fun has signalled an intent to replace this dynamic-fee model entirely,
which is a further reason not to treat the snapshot below as durable.

**On a non-canonical pool** — a Raydium migration, say — the creator share is
**zero**. You earn nothing from those pools no matter how much they trade.

> ### The 0.30% is real, but only for a Creator Fee coin
>
> Pump.fun introduced **Cashback Coins** on 2026-02-17. At creation, a coin is
> either a *Creator Fee* coin or a *Cashback* coin, and **the choice is locked
> permanently**. Under cashback, the entire 0.30% creator leg of every
> bonding-curve trade is redirected to the traders' volume accumulators, and
> the creator earns **nothing on the curve, ever**.
>
> This was verified on chain on 2026-08-30, both directions:
>
> - On a Cashback Coin, across six consecutive buys and sells by four distinct
>   traders, the creator vault received **0.00 bps** while the traders'
>   accumulators received exactly 30.00 bps. Traders later withdrew it through
>   an instruction named `ClaimCashbackV2`.
> - On an ordinary Creator Fee coin, the creator vault received exactly
>   **30.00 bps** from two independent buyers, with 95.00 bps to the protocol.
>
> **This platform launches Creator Fee coins.** The launch adapter passes
> `cashback: false` explicitly on every create instruction, and a test fails
> the build if that argument is ever dropped. The SDK happens to default it to
> false, but a default is not a guarantee — a dependency upgrade that flipped
> it would silently make every future launch unable to earn, with nothing
> failing and nothing visible in a diff.
>
> **Verify it anyway on your first mainnet launch.** Watch your creator vault —
> `PDA["creator-vault", <your address>]` — and confirm the balance actually
> rises after somebody trades. It costs nothing to check and it is the single
> assumption the whole business model rests on.

**These figures are protocol state, not constants, and the platform does not
re-read them.** They are a snapshot in
`packages/shared/src/domain/pumpfun.ts`, verified on 2026-08-29 by decoding
the on-chain `FeeConfig` accounts, and every economic estimate the platform
makes — the opportunity model, the predictions, the fee projections on the
dashboard — uses that snapshot. Only the developer-buy pricing path reads fee
config live from chain.

So if Pump.fun changes its fee schedule, the platform's revenue estimates go
stale without saying so. Check the current rates yourself before you scale up
spending, and treat a large divergence between projected and actual fee income
as a reason to go and look.

### What it costs

Measured from a real mainnet launch on 2026-08-30, not estimated:

| Item | Cost |
| --- | --- |
| Mint account (Token-2022) | 0.00369576 SOL — varies with metadata length |
| Bonding-curve account | 0.00169128 SOL |
| Bonding-curve token account | 0.00207408 SOL |
| **Creating one token, no dev buy** | **≈ 0.0085 SOL** including network and priority fees |
| Creator token account, if you dev-buy | + 0.00207408 SOL, plus the buy itself |
| pump.fun platform fee to create | **0 SOL** |
| Graduation to PumpSwap | 0.015 SOL, charged if the coin graduates |
| Claiming fees | 5,000 lamports per claim, plus priority |
| Stranded curve-vault rent | **890,880 lamports**, once — see below |

The bonding-curve creator vault is derived from *your* address, not from each
mint, so all your tokens accrue into one vault. Its rent-exempt minimum can
never be withdrawn: it is paid once, not per token. The platform refuses a
claim that would cost more in fees than it recovers, and says so rather than
silently skipping it.

### The break-even, stated plainly

At 0.30% of curve volume, a token costing ~0.0085 SOL to create must be traded
**about 2.8 SOL** before it has paid for itself.

At the shipped default limits — 3 launches a day — you are spending roughly
**0.026 SOL a day, about 0.77 SOL a month**, before any API costs. To break
even on-chain your tokens must collectively trade around **255 SOL a month**.

These figures assume a Creator Fee coin, which is what this platform launches —
see the box above.

### The part that decides everything

None of the above is the hard question. The hard question is what fraction of
launched tokens trade *anything at all*.

The best evidence is a survival analysis of **832,941 launches** observed
between 2026-05-08 and 2026-06-10
([arXiv:2607.02823](https://arxiv.org/abs/2607.02823)), which is a far better
basis than the journalistic figures that circulate:

| | |
| --- | --- |
| Pooled graduation rate | **0.198%** (Wilson 95% CI 0.189–0.208%) — the authors call this a lower bound |
| Earlier comparison point | 0.63% for Sept–Oct 2025, so a 3.2× decline in under a year |
| Gone on launch day | **~70%**, and 80% within two days |
| Surviving past 90 days | **4.55%** |
| Ever held $1,000 of liquidity | ~97,000 of roughly 7 million launched — about **1.4%** |
| Graduation threshold | roughly **85 SOL** of curve purchases |

Now put that against the cost arithmetic. Take **1,000** launches:

- They cost **8.5 SOL** to create.
- About **two** graduate. Each means ≥85 SOL of curve volume, so the pair
  returns **≥0.51 SOL** in creator fees — about **6%** of what the thousand
  launches cost.
- Which leaves roughly **8 SOL** to be earned by the other 998, or about
  **2.7 SOL of trading volume each**.

And the liquidity figure says that is implausible: if only ~1.4% of tokens ever
hold $1,000 of liquidity — under 5 SOL at recent prices — then the typical
token is nowhere near trading 2.7 SOL.

**So on these numbers, launching at volume with no differentiator loses money.**
That is the honest reading, and it is the number this platform exists to try to
beat by selecting better rather than launching more.

### Two levers the same study actually measured

| Lever | Effect |
| --- | --- |
| A **Telegram channel** on the listing | graduates at **1.485%** vs 0.166% without — an **8.94× lift** (Cox HR 5.40, CI 4.73–6.17) |
| **Initial market cap above the 30 SOL default** | the strongest single predictor (Cox HR 4.51); top quartile graduated at 0.634% |

Both are real and both come with a condition.

The second is a developer buy — `execution.devBuySol`, which ships at 0. Raising
it is a genuine capital commitment that raises your cost and your loss per
failed launch in exchange for a better shot. That is a straightforward risk
trade and the caps are there to bound it.

The first needs stating carefully. A **real** community channel that a person
actually runs is a legitimate thing to attach. An **empty** channel created
only to trip the signal is manufacturing an appearance of community that does
not exist — which is precisely what this platform is built not to do, and no
amount of measured lift makes it something else. The platform does not create
social channels, and this document is not suggesting it should start.

What follows:

What follows:

- **Expected value is dominated by the tail.** Reasoning from a median outcome
  misleads in one direction; reasoning from a good one misleads much further
  in the other.
- **Small samples tell you nothing.** At a 0.2% base rate, five hundred launches
  most likely contain one graduation whether your selection is excellent or
  worthless. Ten launches are not evidence of anything at all.
- **The realistic goal of the first months is not profit.** It is a dataset:
  enough scored predictions to know whether the selection process beats
  chance. Until then you are paying for information.

This platform's own simulation encodes that shape deliberately — its outcome
model is not flattering, because a simulation that made every launch look
promising would teach the model the wrong thing.

What follows from that:

- **Expected value is dominated by the tail.** Reasoning from a median outcome
  will mislead you in one direction; reasoning from a good outcome will
  mislead you much further in the other.
- **Small samples tell you nothing.** Ten launches cannot distinguish a good
  selection process from a lucky one. The platform's quality gate ships as
  informed priors and says so on every screen until it has real outcomes to
  learn from.
- **The realistic goal of the first months is not profit.** It is a dataset:
  enough scored predictions to know whether the selection process is better
  than chance. Until then you are paying for information.

Decide now what you are willing to spend to find that out, set
`limits.maxSolSpendPerDay` to that number divided by thirty, and let the caps
enforce it rather than your judgement at 2am.

Sources: the graduation rate, the confidence interval, the Telegram lift and
the market-cap predictor are all from
[Pump.fun Graduation Regime Windows (arXiv:2607.02823)](https://arxiv.org/abs/2607.02823),
whose dataset is published under CC-BY-4.0. Survival figures from
[CoinGecko's lifespan study](https://www.coingecko.com/research/publications/average-lifespan-of-pumpfun-tokens);
the graduation threshold from
[pump.fun's bonding-curve documentation](https://pump.fun/docs/bonding-curve).

> This is an engineering document, not financial advice. Creating and
> distributing tokens has tax and regulatory consequences that differ by
> jurisdiction and that this document does not address. Find out what applies
> to you before you launch anything on mainnet, not after.

---

## 2. What you must obtain yourself

Four things cannot be automated, because they are accounts, money and consent.

| What | Where | Needed for |
| --- | --- | --- |
| **Anthropic API key** | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Generating and evaluating concepts. Without an AI provider the platform discovers and scores trends but produces no candidates. |
| **Solana RPC endpoint** | [dashboard.helius.dev](https://dashboard.helius.dev) — free tier is enough to start | Mainnet and devnet. The public endpoint is rate-limited hard enough that launches and fee claims fail intermittently, and a launch that fails *after* broadcasting still costs you. |
| **A funded Solana wallet** | Any exchange or wallet you already use | Paying for launches. Use a **new** wallet holding only what you have decided to risk. |
| **A notification channel** | A Discord or Slack webhook takes a minute | Knowing when it launched something, hit a limit, or stopped itself. |

Optional, and genuinely optional: an OpenAI key (a second opinion in the
concept panel, and the only source of generated artwork — without it artwork
falls back to a deterministic procedural image, which pump.fun's metadata
uploader has been verified to accept), a YouTube key, Reddit app credentials,
a Pinata JWT.

---

## 3. Automated setup

```bash
git clone https://github.com/srmcno/solcoin.git
cd solcoin
npm install
npm run setup
```

`npm run setup` does everything that can be done for you:

- generates a master key and writes `.env` at mode 0600
- applies the database migrations
- creates your owner account
- stores each credential you paste, encrypted, and reads it back to confirm
- creates or imports the operating wallet and prints its funding address
- reports what is still missing and why it matters

It reads secrets without echoing them, and if the terminal cannot hide input it
tells you rather than quietly printing your private key. It **never advances
the operating phase** — setup ends in research mode whatever else you
configured.

**Back up `SOLCOIN_MASTER_KEY` somewhere off the machine before you go
further.** It encrypts every credential and the wallet's private key. Without
it, nobody — including you — can recover that wallet from the database.

Then:

```bash
npm run dev        # API + dashboard, http://127.0.0.1:4317
npm run doctor     # which providers actually answered
```

---

## 4. The phase ladder

The platform will not let you skip these, and the ladder is the main thing
protecting you from your own enthusiasm.

| Phase | What it permits | What you are checking |
| --- | --- | --- |
| **1 · research** | Discovery and scoring only. Nothing can launch. | Do the trend sources work? Do the scores look sane on trends you recognise? |
| **2 · devnet** | Real transactions, worthless SOL. | Does a launch actually land? Does monitoring pick the token up? Does a fee claim work end to end? |
| **3 · mainnet with approval** | Real launches, each one approved by you. | Are the candidates ones you would have picked yourself? |
| **4 · limited autonomy** | It launches without asking, under caps. | Does it behave the same when you are not watching? |
| **5 · adaptive** | It tunes its own thresholds within bounds. | Only once the model has real outcomes behind it. |

Spend real time in phases 1 and 2. Everything expensive that can go wrong is
cheaper to find on devnet, and the platform is designed so devnet exercises the
identical code path.

### Phase 2 in one command

```bash
npm run rehearsal --enter-devnet
```

`npm run rehearsal` is phase two's checklist, executed rather than read. It
runs the platform's own services — the same keystore, guard, launch service,
adapter, monitor and fee service that mainnet will use — against the real
Pump.fun program on devnet, and reports each step with the transaction
signature and an explorer link:

1. confirms the RPC is devnet by **genesis hash**, not by its URL or a setting
2. reads the program's global and fee-config accounts and the creator-fee rate
   a new curve actually pays there (devnet's tier table has been observed to
   differ from its global flat rate)
3. checks the limits permit a launch and that the wallet can sign, creating an
   operating wallet if there is none
4. checks the balance covers the run and asks the devnet faucet if not; when
   the faucet is dry it prints the address, points at
   [faucet.solana.com](https://faucet.solana.com), and exits with code 3
5. inserts a fixture concept that passes the same safety screen a generated
   one must, and hosts its artwork and metadata for real (pump.fun's uploader
   accepts the procedural SVG, so no image key is needed for a launch)
6. launches it through `launchApproved`, so the idempotency key, the spend
   reservation, `create_v2`, the signature-before-broadcast record and the
   monitoring registration all happen as they would on mainnet
7. reads the mint and bonding-curve accounts back and checks the curve's
   creator is the operating wallet and the coin is a creator-fee coin
8. polls the token through the monitor; on devnet the on-chain curve reader
   is the provider that answers, since no aggregator indexes devnet
9. makes a **protocol test buy** of its own token, sized from the live fee
   rate so the curve vault ends above its stranded rent, and records it as an
   expense and in the audit log — this is the one action that would be
   self-trading on a real market, which is why the cluster is re-checked by
   genesis hash immediately before signing it and the platform proper has no
   such path at all
10. snapshots the vaults through the fee service, reports what the scheduled
    collector would decide, and claims through `FeeService.collect`, then
    verifies the wallet moved and the vault is back at its rent floor

`--skip-buy` stops after monitoring; `--skip-claim` after the snapshot;
`--buy-sol` overrides the sized buy. Every run is written to
`data/rehearsal/<timestamp>.json`. Exit codes: 0 every step passed, 1 a step
failed, 2 it refused to start, 3 blocked on devnet SOL.

It refuses to run on, or to move, a platform that is on mainnet. With
`--enter-devnet` it moves a phase-one platform to phase two and selects
devnet; it never goes higher. Run it with the server stopped, or accept that
the platform is on devnet afterwards, which is where phase two lives anyway.

A run that passes proves the code path, not the strategy.

---

## 5. Before mainnet

```bash
npm run preflight
```

This is a gate, not a report. It exits non-zero while any blocker stands, so it
can sit in a deploy script ahead of the switch. It checks the things that cost
money if they are still wrong when the first real transaction goes out:

- a wallet that can actually sign, funded above the balance floor, with a
  balance that has genuinely been fetched rather than defaulted to zero
- a dedicated RPC rather than the public endpoint
- at least one notification channel — this platform can engage its own
  emergency stop, and with nowhere to send that you would find out by opening
  the dashboard
- the emergency stop not already engaged
- how much a bad day costs at your current limits, stated as a number

It changes nothing. Switching to mainnet stays a deliberate act performed in
Settings by a person who has read the output.

### Set the limits before you switch, not after

The shipped defaults are deliberately timid:

| Setting | Default | What it means |
| --- | --- | --- |
| `limits.maxLaunchesPerDay` | 3 | at most three tokens a day |
| `limits.maxSolSpendPerDay` | 0.5 | hard daily ceiling on all spending |
| `limits.maxSolPerHour` | 0.3 | hourly ceiling |
| `limits.walletBalanceFloorSol` | 0.05 | never spend below this, so fee claims stay affordable |
| `limits.consecutiveFailureShutdown` | 3 | three failures in a row stops launching |
| `execution.devBuySol` | 0 | create-only; no developer buy |

Raise them slowly and for a reason. Every one of them is enforced atomically —
concurrent launches cannot each clear a cap their sum exceeds — so a limit you
set is a limit that holds.

### Claiming what it earns

Creator fees accrue in two on-chain vaults per wallet, not per token. The
platform reads them every ten minutes and records a snapshot; the Fees page
shows the claimable balance (the curve vault keeps 0.00089 SOL of rent forever,
so it is always a little less than the vault) and what the scheduled collector
would decide right now, with its reason.

Until phase four, `autonomy.fee_collection` cannot be `auto` — the ladder gates
unattended transactions of every kind — so in phase three the claim is yours
to trigger, from the Fees page or `POST /api/fees/collect`. It goes through
the same `FeeService.collect` the job uses: it refuses a claim that would cost
more than it recovers, reserves the fee against the spend caps, records the
signature before broadcasting, and attributes the proceeds back to the tokens
that earned them. From phase four set `autonomy.fee_collection` to `auto` and
the hourly job takes over, subject to `fees.collectionThresholdSol`,
`fees.minCollectionValueRatio` and `fees.minHoursBetweenCollections`.

---

## 6. Running it continuously

The platform must run continuously to monitor tokens and claim fees. A laptop
that sleeps will miss both.

### What it costs to host

Prices checked 2026-08-30. All three of these are real VMs with a persistent
disk you control, root access, systemd for restart-on-crash, and a static IPv4
that is also the outbound source address — which is what a process holding an
encrypted key and running 24/7 wants.

| Option | Spec | Price |
| --- | --- | --- |
| Hetzner CX23 (EU) | 2 vCPU, 4 GB, 40 GB NVMe | €5.49 / $6.49 per month, plus ~€0.50 for IPv4 |
| DigitalOcean Basic | 1 vCPU, 1 GB, 25 GB SSD | $6.00 per month |
| AWS Lightsail | 2 vCPU, 1 GB, 40 GB SSD | $7.00 per month, static IP included |

Fly.io works but fits worst: the filesystem is ephemeral so the key and
database need a Volume, that Volume is single-host and unreplicated (Fly's own
docs warn against running one), and a stable outbound IP is a $3.60/month
add-on. Railway needs the $20/month Pro plan for static outbound IPs at all.
Hetzner's US regions tripled in price in June 2026 and are no longer
competitive; use its EU regions or pick DigitalOcean.

**Realistic monthly total:**

| | |
| --- | --- |
| Floor | **~$10** — Hetzner or DigitalOcean, Helius free tier, Sonnet for concepts |
| Sensible | **~$18–22** — the above plus backups, running concepts on Opus |
| Once you need a paid RPC | **~$60–70** — Helius Developer is $49 and dominates everything else |

The largest lever is the AI model, not the server: moving concept generation
from Opus to Sonnet saves more per month than the entire VPS costs. The Helius
free tier (1M credits, 10 req/sec) genuinely suffices for a service doing a
few reads a minute and a few transactions a day; you need the paid tier for
staked connections, which matter for landing transactions reliably.

**Terms of service:** none of Hetzner, DigitalOcean, AWS, Railway or Fly.io
prohibits crypto workloads generally. Hetzner, DigitalOcean and Railway each
ban *mining* specifically, which does not describe holding a key, signing
transactions, or calling an RPC. Fly.io and AWS have no crypto clause at all.

One thing no price tier fixes: an encrypted key on disk only helps if the
passphrase is not sitting beside it. If `SOLCOIN_MASTER_KEY` lives in a `.env`
on the same box, anyone with disk access has both halves.

### Deployment

`docs/operations.md` has the detail — systemd unit, Docker, reverse proxy, the
one-scheduler rule for split deployments. In outline:

- a small VPS is sufficient; this is one Node process and a SQLite file
- put it behind TLS if it is reachable from anywhere but localhost
- `SOLCOIN_MASTER_KEY` goes in a root-owned file at mode 0400, not in the
  shell history and not in the repository
- back up the database *and* the master key, and test the restore before you
  need it — the database without the key is unreadable

### What to watch

| When | What |
| --- | --- |
| First week, daily | Every candidate it produced. Would you have launched it? If not, tighten the quality gate rather than hoping. |
| Weekly | Accounting: total spent against total claimed. The number that matters is net, not gross fees. |
| Weekly | Learning page: how many real outcomes has the model scored? Below ~30 it is still expressing priors. |
| On any notification | Emergency stops and consecutive-failure halts are the platform telling you something is systematically wrong. Find out what before releasing them. |

### When to stop

Decide these thresholds now, while you are not invested in the answer:

- a total spend at which you stop regardless of results
- a number of launches after which, if net revenue is still negative, you
  conclude the selection process is not working
- any sign the platform is producing candidates you would be embarrassed to
  have launched

The system will not make this call for you. Its quality gate can decline to
launch anything on a given day, and a day with zero launches is a correct
outcome — but it cannot tell you the whole endeavour is not paying.

---

## 7. What is deliberately not automated

- **Enabling GitHub Pages**, if you want the project site — creating a Pages
  site for the first time needs a repository owner; a workflow token is
  refused.
- **Advancing the phase.** Every step toward real money is a person's decision.
- **Funding the wallet.**
- **Raising a limit.** The platform will never widen its own caps below phase
  five, and even there only within bounds you set.
