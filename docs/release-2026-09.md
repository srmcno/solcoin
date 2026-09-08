# September 2026 decision integrity update

Solcoin discovers cultural trends and evaluates original token concepts for creator-fee revenue. It is not a token trading bot. The public Pages site is a guide and interactive economics desk; the private dashboard still requires a running server and database.

## Changes

- Revenue simulation no longer invents additional volume after graduation. Continuing volume moves to the AMM fee venue. The lifetime multiplier includes day one instead of adding it twice.
- Survival adjustment scales volume after `expm1`, removing the fictitious volume produced by shifting a log1p prediction. This preserves the arithmetic mean in expectation but remains an approximate mixture, not an empirically fitted conditional distribution.
- Non-finite, negative or incorrectly scaled economic inputs are rejected.
- The quality gate rejects source observations older than 60 minutes by default, including in exploration. Mainnet execution rechecks observation freshness before reservation and execution.
- Correlated platforms count as one source family for the breadth gate.
- Forecasts with more than 65% of fee revenue supplied by their top 1% of simulations fail the default gate. This is a configurable risk preference, not an empirically optimal cutoff.
- Settings provides an aggressive early-discovery preset: 62 opportunity score, 25% maximum saturation, 24-hour trend age, 20-minute observation age, two source families, 55% maximum tail share, nonnegative EV and 15% minimum modelled profit probability. It stages changes for review without raising budgets or activating mainnet. These thresholds are hypotheses to test, not a proven edge.
- Pages now has a cost-sensitive break-even calculator and Coinbase SOL/USD spot reference, polled every 60 seconds while visible. Errors show unavailable/stale status; no fabricated fallback price is used.

## U.S. scope and platform permission

Reviewed September 8, 2026:

- [Pump terms](https://pump.fun/docs/terms-and-conditions), section 21(c), require written agreement for commercial use. Mainnet launches require human confirmations that the operator reviewed applicable U.S./state requirements and obtained required Pump commercial permission. Jobs cannot make these attestations. They do not constitute permission or legal clearance. Existing users will see the new requirements before further mainnet launches.
- [SEC staff statement](https://www.sec.gov/newsroom/speeches-statements/staff-statement-meme-coins) is a limited staff view, not blanket approval. Token design and actual conduct matter; fraud and other federal/state rules still apply. No revenue-sharing token rights, manipulated activity or geographic evasion are added.
- [Pump fees](https://pump.fun/docs/fees) lists a 0.300% bonding-curve creator share and variable graduated fees. The calculator's constant-rate scenarios do not replace runtime quotes.
- [Coinbase spot API](https://docs.cdp.coinbase.com/coinbase-app/track-apis/prices) is an unauthenticated reference endpoint, not an executable order quote.

No MEXC integration exists. No funded wallet, commercial authorization or running production backend is supplied by this repository update. No real-money launch was executed for validation.

## Operating the update

Use Node 22, run `npm ci`, `npm run build`, then `npm start`. Start in simulation and use Settings to stage the research preset if desired. Review realised results and the model's held-out calibration before changing operating phase. Keep funds out of the operating wallet until deployment, eligibility, provider readiness and risk limits are verified.

Stored predictions remain historical records. Reevaluate pending candidates to produce forecasts with the corrected economics; do not compare older and newer expected values as though their simulation formulas were identical.

The existing default branch remains authoritative. CI and Pages now trigger on that branch; redundant branches can be removed after merge without retaining a separate deployment branch.
