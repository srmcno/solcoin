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
across the same ladder. Most tokens never get here.

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

The honest answer is that the distribution is brutally skewed: the large
majority of tokens launched on this kind of venue attract essentially no
volume and earn their creator essentially nothing, while a very small minority
carries whatever return exists. This platform's own simulation encodes that
shape deliberately — its outcome model is not flattering, because a simulation
that made every launch look promising would teach the model the wrong thing.

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
falls back to a deterministic procedural image), a YouTube key, Reddit app
credentials, a Pinata JWT.

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
