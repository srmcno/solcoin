# Strategy

The scoring, prediction and learning methodology, with the formulas and the
constants that are actually in the code. This document explains *why* each
choice was made, and says plainly where a choice is a judgement call, an
approximation, or not yet wired up.

Every number below was read out of the source. Where a figure is a default that
an operator can change, the settings path is given.

---

## The claim being made

The platform's edge, if it has one, is **timing and independent confirmation**.
It is not creativity, and it is not execution speed. Concretely, the chain of
reasoning is:

1. A cultural moment is visible on several unrelated platforms before it is
   tokenised. Resolving those sightings into one trend, and weighting them by
   how independent the platforms actually are, is free information.
2. A rising trend that nobody has tokenised is worth far more than a bigger
   trend with forty tokens already on it. That asymmetry is large enough that
   crowding must gate the score rather than merely reduce it.
3. Outcomes are extremely heavy-tailed. Any decision rule that multiplies
   averages together will systematically misprice both the downside (most
   launches earn nothing) and the upside (one launch carries the portfolio).

Everything in this document is machinery for those three sentences.

### The decision chain

```
raw signals ──▶ identity resolution ──▶ kinetics ──▶ opportunity score
                                                          │
                        ┌─────────────────────────────────┘
                        ▼
   concept generation ──▶ originality + saturation + risk screen
                                       │
                        ┌──────────────┘
                        ▼
   adversarial panel ──▶ feature vector ──▶ prediction heads ──▶ Monte Carlo EV
                                                                      │
                        ┌─────────────────────────────────────────────┘
                        ▼
              quality gate (hard blocks, soft thresholds, exploration)
                        │
                        ▼
              launch ──▶ outcome measurement at 24/72/168h ──▶ model update
```

---

## 1. Trend identity resolution

**File:** `packages/server/src/services/trend.service.ts`

The same moment arrives as a Google Trends query, a Bluesky topic, a Wikipedia
article title and a GDELT news cluster, under four different strings. If those
become four trend rows, the platform sees four weak single-source signals
instead of one strong four-source one — and cross-platform confirmation is the
single most informative free signal available. Over-merging is equally bad: two
distinct moments fused into one row produce a kinetics series that is the sum of
two unrelated curves, which is not a measurement of anything.

Matching is layered, cheapest first, against a candidate set restricted to
trends that are `active` or `watch`, were last seen within **14 days**, capped
at **1500 rows**. The age restriction matters: reviving a three-month-old trend
because a word matched would corrupt its `first_seen_at`, and therefore its age,
earliness and kinetics.

| Layer | Test | Threshold | Behaviour |
|---|---|---|---|
| 1. Slug | `slugify(title) === candidate.slug` | exact | Returns immediately, no further comparison |
| 2. Name confusability | `nameConfusability(title, candidate.title)` | `>= 0.78` (`MATCH_NAME_THRESHOLD`) | Best-scoring candidate wins |
| 3. Embedding cosine | dot product of unit-normalised local embeddings | `>= 0.72` (`MATCH_EMBEDDING_THRESHOLD`) | Only consulted when layer 2 did not fire for that candidate |

`nameConfusability` (`packages/shared/src/text/similarity.ts`) is deliberately
the **maximum** of five views rather than a blend, because any one of them firing
is enough for two strings to be the same thing:

- normalised edit similarity,
- Jaro-Winkler (better on short brand-like strings),
- trigram Jaccard (robust to word order),
- content-token Jaccard × 0.95,
- containment: 0.9 when one folded string contains the other and both are at
  least 4 characters — this is what catches `Labubu` inside `labubu dolls`.

All of these run on `confusableFold`, which lowercases, strips diacritics,
undoes leetspeak and Cyrillic/small-caps homoglyphs, removes everything outside
`[a-z0-9]`, and collapses repeated characters. `PEPE`, `p3p3`, `p-e-p-e` and
`рере` all fold to `pepe`.

### The embedding is lexical, not semantic

`localEmbed` (`packages/shared/src/text/embedding.ts`) is a 384-dimensional
signed-hash bag of features: content words at weight 1.0, word bigrams at 0.8,
character trigrams at 0.35, then L2-normalised. Signed hashing keeps the expected
inner product unbiased under collisions.

This is a deliberate trade. It requires no API key, so identity resolution works
on a fresh install, and it is excellent at near-duplicate surface forms. It does
**not** know that "Labubu" and "the ugly-cute plush thing" are the same subject.
When a real embedding provider is configured the platform stores those vectors
and labels them (`embedding_model`); vectors from different spaces are never
compared with each other.

`clusterByCosine` exists in the same file with a default threshold of 0.62, but
nothing in the server currently calls it — identity resolution uses the pairwise
greedy `findMatch` above instead.

### Active confirmation

`research.service.ts` runs discovery, scores everything once, and then spends a
small budget confirming specific trends: from the top 12 active trends it takes
those with `sourceCount < 3` **and** `opportunityScore >= 35`, caps that at 6
trends, and queries at most 2 providers that have not already seen the trend. A
second scoring pass runs only if a confirmation actually landed.

The logic is that confirmation is only worth paying for where it can change the
answer. A trend five platforms already show gains nothing from a sixth.

---

## 2. Source independence weighting

**File:** `packages/shared/src/domain/enums.ts` (`SOURCE_INDEPENDENCE`),
consumed by `computeSourceDiversity` in `trend.service.ts`.

Counting distinct sources treats two Fediverse instances as two independent
confirmations. They are not: they are largely the same people. Each source is
therefore assigned a **family** and an **independence weight**.

| Source | Family | Weight |
|---|---|---|
| `google_trends` | search | 1.00 |
| `wikipedia` | reference | 0.95 |
| `gdelt` | news | 0.90 |
| `rss` | news | 0.50 |
| `bluesky` | social | 0.85 |
| `x` | social | 0.90 |
| `mastodon` | social | 0.60 |
| `reddit` | forum | 0.85 |
| `hackernews` | forum | 0.60 |
| `stackexchange` | forum | 0.40 |
| `youtube` | video | 0.85 |
| `pumpfun_market` | onchain | 0.70 |
| `dexscreener` | onchain | 0.50 |
| `manual` | manual | 0.30 |

The measure keeps only the **highest weight per family**, sums those, and
saturates:

```
T = Σ over families of max(weight of sources seen in that family)
diversity = T / (T + 1.8)
```

Two consequences, both intended:

- Adding a second source **within** a family changes nothing unless it is the
  stronger of the two. Mastodon adds zero diversity when Bluesky is already
  present; adding X (0.90) raises the social family from 0.85 to 0.90.
- The measure saturates, so the first family is worth much more than the fifth.

| Sources seen | T | diversity |
|---|---|---|
| Google Trends only | 1.00 | 0.357 |
| + Wikipedia | 1.95 | 0.520 |
| + GDELT | 2.85 | 0.613 |
| + Bluesky | 3.70 | 0.673 |
| + Mastodon (same family, lower weight) | 3.70 | 0.673 |

The weights themselves are domain judgement, not measurement. Search demand is
scored highest because it reflects intent from people who are not performing for
an audience; Stack Exchange is scored lowest among forums because its traffic is
driven by work problems rather than culture. Nothing in the learning loop
currently updates these numbers — they are constants, and they should be read as
an argument rather than a finding.

---

## 3. Kinetics

**File:** `packages/shared/src/math/timeseries.ts`

`computeKinetics` turns an interest series into growth measurements. The series
it receives from `rescoreAll` is the **normalised** value per observation
(`logScale01(rawValue, sourceScaleReference)`, then multiplied by 1000), not the
raw count, so a source reporting millions of pageviews does not swamp one
reporting hundreds of posts.

### Why Theil-Sen on log1p rather than OLS on counts

Two separate problems, two separate fixes.

**log1p, not raw counts.** Attention grows multiplicatively. A subreddit going
from 50 to 100 mentions and a search term going from 50,000 to 100,000 are the
same event, and only the log transform makes them the same number. The slope of
`log(1+v)` against time is, to first order, the fractional growth rate per hour,
which is directly comparable across sources of wildly different magnitude.
`log1p` rather than `log` because zero observations are common and legitimate.

**Theil-Sen, not least squares.** Social counts are spiky: a single bot burst,
an outage that drops a poll, one viral post. OLS minimises squared residuals, so
a single 10× spike moves the slope substantially. Theil-Sen takes the **median of
all pairwise slopes**, so it tolerates up to roughly 29% arbitrarily bad points
before breaking down. The cost is O(n²) pairs, so the implementation caps the
pair count at 20,000 by striding the index — a pathological series cannot block
the event loop.

### What comes out

| Field | Definition |
|---|---|
| `level` | Latest observed value |
| `relativeVelocity` | Theil-Sen slope of `log1p(v)` against hours. Fractional growth per hour, unitless |
| `velocity` | `relativeVelocity × max(1, latest value)` — value-units per hour |
| `acceleration` | `(slope of newer half − slope of older half) / max(0.25, spanHours/2)`, per hour² |
| `consistency` | `0.5 × r² of the log-linear fit + 0.5 × fraction of non-negative first differences` |
| `spanHours`, `n` | Coverage of the series |
| `rateEstimable` | `false` when `n < 2` or `spanHours < 0.5` (`MIN_SPAN_HOURS`) — the rate is unknown, not zero |

`relativeVelocity` is what the model and the opportunity score use;
`velocity` is a presentational rescaling. Note that the `velocity` **column** on
the `trends` table stores `relativeVelocity`, not the value-unit figure — the
value-unit one only appears inside the `score_breakdown` JSON.

`consistency` mixes two things on purpose. `r²` alone rewards a clean straight
line even if it points downward; the positive-fraction term rewards monotone
growth even when it is noisy. A trend that doubles, halves and doubles again
scores poorly on both.

### Unknown is not zero, and the guards around it

Several sources are polled together, so a freshly discovered trend can have five
observations spread across two seconds. Fitting a per-hour slope to that divides
by a near-zero time delta and produces an enormous, meaningless velocity, which
then ranks a trend seen once above a genuine four-platform wave. Three guards
exist:

- **`MIN_SPAN_HOURS = 0.5`.** Below that span `computeKinetics` returns zeros
  with `rateEstimable: false`. That flag is the important part: downstream code
  must read it as "unknown", not as "flat" (section 4 shows what the opportunity
  score does with it).
- **Pair minimum.** `theilSenSlope` is called with `minDx = MIN_SPAN_HOURS / 4`,
  so individual pairs closer than 7.5 minutes are skipped even inside a
  long-enough series.
- **`MAX_RELATIVE_VELOCITY = 2.0`.** The slope is clamped to ±2.0 (already ~7×
  per hour sustained) and `acceleration` is clamped to ±1, so a counter reset or
  a backfill landing all at once cannot capture the ranking.

Note that the field comment on `relativeVelocity` and the `computeKinetics`
docstring both describe the growth rate as being "relative to the series
baseline". No baseline is computed anywhere in the function — the slope is taken
on `log1p` values, which is what makes it comparable across sources, and
`velocity` is scaled by the latest value rather than by a baseline. The comment
is stale; the behaviour is the one described in the table above.

### Phase classification

`classifyPhase(kinetics, ageHours)`:

| Condition (evaluated in order) | Phase |
|---|---|
| `!rateEstimable`, or `n < 3`, or `spanHours < 1` | `nascent` |
| `relativeVelocity > 0.05` and `acceleration >= -0.01` | `emerging` if `ageHours < 72`, otherwise `peaking` |
| `relativeVelocity > 0.005` | `peaking` |
| `relativeVelocity < -0.02` | `declining` |
| otherwise | `peaking` if `level > 0`, else `dormant` |

`emerging` is the phase the platform wants: real growth (>5% per hour, roughly
+230% per day), not yet decelerating, and less than three days old. The 72-hour
cut is the whole thesis expressed as a boolean.

Two rows deserve care. The first row means `nascent` covers both "genuinely new"
and "watched for less than half an hour, so nothing is known" — the two are not
distinguished by the label, only by `rateEstimable`. And the final row means a
completely flat trend with any non-zero level is classified `peaking`, not
`dormant`; `dormant` is reachable only at zero level. That makes `peaking` the
catch-all bucket, and the phase label should be read with that in mind. It
matters mainly through lifespan estimation, since the opportunity score does not
use the phase directly.

### Lifespan estimation

```
base = { nascent: 96, emerging: 120, peaking: 60, declining: 18, dormant: 4 }  (hours)
speedPenalty      = clamp(1 − |relativeVelocity| × 1.2, 0.35, 1.2)
consistencyBonus  = 0.7 + 0.6 × consistency
agePenalty        = clamp(1 − ageHours / 720, 0.25, 1)
remaining         = clamp(base × speedPenalty × consistencyBonus × agePenalty, 2, 720)
```

The shape encodes two beliefs: a sharper spike burns out faster (hence the
penalty on the *absolute* growth rate, applied in both directions), and steady
broad growth lasts longer (hence the consistency bonus). The `agePenalty` decays
linearly over 30 days.

The upper clamp on `speedPenalty` is unreachable — `1 − |v|×1.2` never exceeds 1
— so the effective range is `[0.35, 1]`. This is a curve fitted to intuition
about meme cycles, not to data. The lifespan head of the prediction model
(section 7) is what is meant to eventually replace it, and until launches
accumulate that head is itself just this judgement re-encoded.

---

## 4. Opportunity scoring

**File:** `packages/shared/src/scoring/opportunity.ts`

The question being answered: *is there a rising wave of attention here that
nobody has tokenised yet, and is there enough of it left to matter?*

Ten components, each normalised to `[0,1]`, combined through a weighted logit
and then passed through **two multiplicative gates** — one for crowding, one for
strength of growth evidence. The logit form is not decoration: it means every
weight is in the same unit (log-odds per unit of a `[0,1]` component), so weights
are directly comparable across components, individually explainable as
contributions, and learnable by the same machinery as the prediction heads if
that is ever wired up.

### Components

| Component | Formula | Default weight |
|---|---|---|
| `velocity` | `logistic((relativeVelocity − 0.02) / 0.045)` | 1.35 |
| `acceleration` | `logistic(acceleration / 0.02)` | 0.70 |
| `consistency` | `clamp(kinetics.consistency)` | 0.45 |
| `breadth` | `0.6 × logScale01(sourceCount, 6) + 0.4 × sourceDiversity` | 0.95 |
| `audience` | `logScale01(audienceEstimate, 5_000_000)` | 0.80 |
| `novelty` | supplied: `1 − max cosine to any other active trend` | 0.75 |
| `engagement` | supplied: max engagement across observations | 0.50 |
| `memeability` | supplied: AI enrichment rating | 0.85 |
| `earliness` | `exp(−ageHours / 60)` | 0.90 |
| `runway` | `logScale01(remainingLifespanHours, 240)` | 0.60 |
| bias | — | −2.60 |

where `logScale01(x, full) = log1p(x) / log1p(full)`, clamped to `[0,1]`.

The first three components are only computed when `kinetics.rateEstimable` is
true. When it is false — fewer than two observations, or a span under half an
hour — all three are set to `UNMEASURED_RATE_CREDIT = 0.12` instead, and the
score's rationale says so in words. This is deliberately *low* rather than
neutral: a trend observed once has no measurable growth, and "we cannot tell
whether this is rising" is a reason to rank it below a trend that has been
watched climbing, not to award it what an average riser would get. Scoring the
unknown as average is how a system ends up spending money on trends it has seen
exactly once.

The `velocity` sigmoid is centred at 2% growth per hour with a scale of 0.045,
so 2%/h scores 0.5, 6.5%/h scores about 0.73, and 10%/h scores about 0.86. (The
code comment beside that line describes 0.10/h as "roughly +170%/day". Since
`relativeVelocity` is a log slope, 0.10/h is `e^(0.1 × 24) ≈ 11×` a day, nearer
+1000%. The threshold is what matters, not the gloss.)
`earliness` has a 60-hour time constant: at 24 hours old a
trend retains 67% of its earliness, at 72 hours 30%, at 120 hours 13%. Together
with the `maxTrendAgeHours` gate (default 96) this is the mechanism that makes
the platform prefer being early over being right about a large trend.

`breadth` mixes raw source count with the independence-weighted diversity at
60/40. Raw count is kept in the mix because a genuinely broad trend usually is
seen by many providers, and diversity alone would treat one Google Trends
sighting (0.357) as most of the way to a strong signal.

### Combination

```
logit    = bias + Σ weight_i × component_i
rawScore = logistic(logit) × 100

saturationMultiplier = (1 − saturation) ^ saturationExponent      # default exponent 1.6

evidence             = 0.55 × velocity + 0.25 × acceleration + 0.20 × consistency
evidenceMultiplier   = evidenceFloor + (1 − evidenceFloor) × evidence   # default floor 0.3

score = rawScore × saturationMultiplier × evidenceMultiplier
```

With all ten components at 0.5 the logit is `−2.6 + 3.925 = 1.325`, giving a raw
score of about 79. With every component at 1 the raw score is 99.5; at 0 it is
6.9.

`rawScore` is not the score. That same all-at-0.5 trend has `evidence = 0.5` and
therefore `evidenceMultiplier = 0.65`, so with zero saturation it scores about
**51** — below the default launch gate of 58. The bias and the two multipliers
are set together so that a merely mediocre trend does not clear the gate.

The score is read at two different thresholds, in this order:

| Threshold | Default | Setting | What it controls |
|---|---|---|---|
| Concept generation | 52 | `research.conceptGenerationThreshold` | Whether the trend is worth spending model calls on at all |
| Launch | 58 | `qualityGate.minOpportunityScore` | Whether a resulting candidate may launch |

`selectForGeneration` applies the first, alongside `qualityGate.maxTrendAgeHours`
and a check that the trend has no live candidate already, ordering by score and
taking a caller-supplied limit — the pipeline passes 3. Each surviving trend then
gets `research.conceptsPerOpportunity` concepts (default 4). That mediocre
51-point trend does not even get concepts generated for it.

### The two multiplicative gates

There are two halves to the thesis — "rising attention" and "that nobody has
tokenised yet" — and each gets a multiplier rather than another additive term.

**Growth evidence** (`evidenceMultiplier`) gates the first half. Audience size,
novelty and earliness are all high for *every* freshly discovered item, so as
additive terms they sum to a large constant that carries the score regardless of
whether the trend is going anywhere. Gating on evidence means a large but static
topic cannot outrank a smaller one that is demonstrably climbing. The floor of
0.3 is what a trend with no growth evidence at all retains; the other 70% has to
be earned. Combined with `UNMEASURED_RATE_CREDIT`, a trend seen once scores at
most `0.3 + 0.7 × 0.12 ≈ 0.38` of its raw score.

`OpportunityScore` exposes `rawScore`, `saturationMultiplier` and
`evidenceMultiplier` separately, and the rationale strings name whichever gate
did the cutting, so a low score can always be attributed.

### Why saturation is multiplicative, and why it has an exponent

If saturation were an eleventh term in the logit with a negative weight, it would
be **compensable**: a sufficiently spectacular velocity plus audience plus
memeability could buy back the deduction, and the platform would launch into a
crowded space because everything else looked good. That is precisely the failure
this system exists to avoid. A trend with forty tokens on it is not "somewhat
worse" — as an opportunity for a *new* token, it is close to worthless no matter
how large it is.

Multiplying makes the penalty non-compensable. Nothing else in the score can
raise `score` above `rawScore × (1 − saturation)^1.6` — the evidence gate is
itself at most 1, so it can only lower that ceiling further.

The exponent controls how convex that gate is. At 1.0 the penalty is linear; at
1.6 moderate crowding is punished harder than a linear multiplier would:

| saturation | ×(1−s) linear | ×(1−s)^1.6 |
|---|---|---|
| 0.10 | 0.900 | 0.845 |
| 0.25 | 0.750 | 0.631 |
| 0.45 | 0.550 | 0.384 |
| 0.60 | 0.400 | 0.231 |
| 0.80 | 0.200 | 0.076 |

Both `rawScore` and `score` are persisted as columns
(`raw_opportunity_score` and `opportunity_score`), and the whole
`OpportunityScore` object — both multipliers, every component and every
contribution — is stringified into `score_breakdown` alongside the kinetics. So
an operator can always see how much of a low score is the trend itself, how much
is the crowd, and how much is missing growth evidence.

Two honest caveats:

- Saturation is penalised **twice** in the overall system: once here as a
  multiplier on the opportunity score, and again as a feature with a strongly
  negative prior weight in every prediction head (−0.35 to −0.70). This is
  deliberate — the two decisions are different questions ("is this worth
  generating concepts for" versus "will this specific token find holders") — but
  it does mean the total penalty is larger than either number alone suggests.
- The saturation figure fed into *trend* scoring is not the full
  `computeSaturation` result. `pipeline.service.ts` sets it to
  `min(1, competitorCount / 25)` from the sampled competitor set — a crude
  proxy, deliberately cheap because it must be computed for every trend
  including ones that never produce a candidate. The rich measure below is
  computed per *concept*, and it is the one the quality gate checks.

---

## 5. Saturation

**File:** `packages/shared/src/scoring/saturation.ts`

The module docstring names three populations that crowding is measured against.
In the code, they are handled as follows:

| Population | Where it is measured |
|---|---|
| Tokens already on-chain in the same concept space | `computeSaturation`, mass + burst + quality terms |
| The rate at which new competitors are appearing right now | `computeSaturation`, burst term |
| Concepts this platform previously generated | `computeOriginality` (section 6), a separate function |

So `computeSaturation` itself is about the market; self-repetition is scored
separately and gates separately.

### Similarity kinds

For each candidate competitor, three similarities are computed and the maximum
taken:

- `nameConfusability(name, competitor.name)` — kind `name`
- `tickerConfusability(symbol, competitor.symbol)` — kind `ticker`
- `embeddingSimilarity(embedding, competitor.embedding)` — kind `semantic`, and
  only when both embeddings exist and have the same dimension

Anything below `SIMILARITY_FLOOR = 0.42` is discarded. Ties resolve to `name`,
then `ticker`, then `semantic`, by the order of the comparison.

`tickerConfusability` is separate from name matching because tickers are short
and a one-character edit is a much bigger deal in a 4-character string than in a
14-character one. It is a step function: exact match 1.0; edit distance 1 gives
0.85 when the longer string is at least 4 characters, otherwise 0.7; edit
distance 2 gives 0.6 when the longer string is at least 6 characters; otherwise
it falls back to `jaroWinkler − 0.15`.

### Recency and traction weighting

A same-theme token from three weeks ago barely competes for today's attention;
one from three hours ago competes hard. A competitor with real traction crowds
the space far more than an empty shell with a similar name.

```
recencyWeight(ageHours)  = clamp(exp(−ageHours / 48), 0.02, 1)
tractionWeight(c)        = clamp(0.3
                                 + 0.9 × (0.4 × logScale01(marketCap, 2_000_000)
                                        + 0.3 × logScale01(volume24h, 500_000)
                                        + 0.3 × logScale01(holders, 2000))
                                 + (graduated ? 0.35 : 0),
                                 0.3, 1.8)
weight = similarity × recencyWeight × tractionWeight
```

The 48-hour recency constant means a competitor loses half its weight in about
33 hours. The floor of 0.02 stops an ancient token disappearing entirely.
`tractionWeight` has a floor of 0.3 — even a dead lookalike is some competition,
because it still occupies the name.

### The saturating mass function and its knee

```
totalWeight = Σ weight over all matches above the floor
massScore   = totalWeight / (totalWeight + 2.5)
```

The knee is at **2.5** units of weighted competitor mass. Below it, each
additional competitor moves the score a great deal; above it, the curve flattens.

| totalWeight | massScore |
|---|---|
| 0.5 | 0.167 |
| 1.0 | 0.286 |
| 2.5 | 0.500 |
| 5.0 | 0.667 |
| 10.0 | 0.800 |
| 20.0 | 0.889 |

This is the right shape because the decision being informed is binary-ish: going
from zero to three relevant competitors changes whether launching makes sense at
all, whereas going from twenty to twenty-three changes nothing an operator would
act on. A linear count would spend most of its dynamic range on differences that
do not matter.

### The composite

```
burstScore = logScale01(count of matches under 24h old, 12)
competitorQuality = max over matches of
      0.5 × logScale01(marketCap, 1_000_000)
    + 0.3 × logScale01(volume24h, 250_000)
    + (graduated ? 0.2 : 0)

score = 0.58 × massScore
      + 0.22 × burstScore
      + 0.12 × competitorQuality
      + 0.08 × socialTokenisationSignal
```

`burstScore` is separate from mass because *n* competitors appearing in the last
day is worse than the same *n* spread over a fortnight — it means other people
are already tokenising this in real time, which is a statement about the
remaining window, not just about the current field.

**`socialTokenisationSignal` is never supplied by the server.** No call site
passes it, so that 8% of the score is currently always zero. The parameter is
there for a signal ("how much social discussion already frames this as a coin")
that no provider currently measures. The remaining weights therefore effectively
sum to 0.92 in practice.

### Saturation score versus hard collision: two different axes

```
HARD_COLLISION_THRESHOLD = 0.88
hardCollision = any match with similarity >= 0.88 AND kind is 'name' or 'ticker'
```

These are deliberately not blended, and keeping them separate is one of the more
important design decisions in the scoring layer.

**Saturation is a continuous commercial measure**: how much competing attention
already exists in this concept space. It is a question about expected value, it
trades off against other signals, and the operator can reasonably tune where the
line sits (`qualityGate.maxSaturationScore`, default 0.45, relaxed to 0.6 on the
exploration path).

**Hard collision is a discrete factual claim**: a trader looking at a list would
mistake this token for an existing one. That is not an expected-value question.
It is close to a deception risk, it is not something a high opportunity score
should be able to outvote, and it does not become acceptable because the rest of
the candidate is excellent.

The two axes are genuinely independent in both directions:

- **Low saturation, hard collision.** One near-identical name in an otherwise
  empty space. Mass is small, so `score` might be 0.2 — and launching would still
  be launching a lookalike.
- **High saturation, no collision.** Twenty thematically related tokens, none of
  them confusable with the proposed name. `score` might be 0.75, and there is
  nothing deceptive about the candidate at all; it is simply a bad commercial
  idea.

Accordingly, `concept.service.ts` converts a hard collision into a `name_collision`
risk flag at **`block` severity**, and the quality gate treats it as a hard block
that the exploration path cannot relax (`qualityGate.blockOnHardCollision`,
default `true`).

One thing that setting does not do, despite its name: turning it off does not let
a colliding candidate through. It only skips the gate's dedicated
"Name/ticker collision" check. The `block`-severity `name_collision` flag is still
raised by `concept.service.ts` and is still caught by the gate's safety screen,
which runs first and is not conditional on anything. Switching
`blockOnHardCollision` off therefore changes the rejection *reason* from
`duplicate_concept` to `safety_block`, not the outcome.

Note also that semantic similarity, however high, never triggers a hard
collision. That is intentional: semantic closeness means "the same idea", which
is saturation. Name and ticker closeness means "traders confuse them", which is
collision. They are different failures.

---

## 6. Originality

**File:** `packages/shared/src/scoring/originality.ts`

Two failure modes are guarded against: the platform reinventing a concept it
already generated (wasted spend, and progressively more derivative output as the
generator drifts toward its own past work), and generic slop that has no chance
of organic attention regardless of the trend behind it.

### Prior-concept comparison

Similarity to each prior concept is the maximum of four views:

```
max( nameConfusability(name, prior.name),
     tickerConfusability(symbol, prior.symbol),
     embeddingSimilarity(embedding, prior.embedding),
     descriptionJaccard × 0.9 )
```

The description Jaccard is over `contentTokens` — normalised, stopword-stripped
words, with `coin`, `token`, `meme`, `memecoin`, `inu` and `official` in the
stopword list so that shared boilerplate does not read as a shared idea. It is
discounted by 0.9 because "same joke, different name" is a weaker signal of
repetition than a matching name, but still a real one.

A prior concept that was actually **launched** has its similarity multiplied by
1.08 (capped at 1). Repeating something already in the market is worse than
repeating something that never left the draft table.

`isDuplicate` fires at `maxPriorSimilarity >= 0.85`, and `concept.service.ts`
turns that into a `low_quality` flag at `block` severity.

### The cliché lexicon

Naming patterns that saturate every token list, and their penalty weights:

All are case-insensitive. Listed here by weight; the code declares them in a
different order, which does not matter because every match is summed.

| Pattern | Label | Weight |
|---|---|---|
| `\b(moon\|rocket\|lambo\|1000x\|100x)\b` | price-promise language | 0.30 |
| `\b\w+\s?2\.0\b` | "2.0" derivative | 0.25 |
| `\bsafe\w+` | "Safe X" pattern | 0.24 |
| `\binu\b` | "Inu" suffix | 0.22 |
| `\bbaby\s?\w+` | "Baby X" pattern | 0.20 |
| `\belon\b` | Elon reference | 0.20 |
| `\b(doge\|shib\|pepe\|bonk\|wif)\b` | established mascot reuse | 0.18 |
| `\bai\s?(coin\|token)\b` | generic "AI coin" | 0.18 |
| `\bv?\d+\b\s*$` | numeric version suffix | 0.15 |
| `\b(gm\|wagmi\|hodl\|fomo)\b` | generic crypto slang | 0.12 |
| `\b(king\|lord\|god\|based\|chad\|giga)\s?\w*` | generic hype modifier | 0.10 |

Weights are summed over all matches and capped at 0.75. The relative weighting
encodes a view: price-promise language is worst because it is both the most
generic and the closest to a compliance problem; hype modifiers are mildest
because they can be part of a genuinely funny name. Note that this is an *originality* penalty
only — the separate risk lexicon
(`packages/shared/src/safety/risk-lexicon.ts`) blocks explicit promises such as
"will moon", "1000x guaranteed" or "risk-free" at `block` severity, but a bare
"moon" or "1000x" trips the cliché penalty here and nothing else.

Note these are matched against `name + symbol + description` concatenated, so a
description that merely mentions Pepe scores the mascot-reuse penalty. That is a
false positive the code accepts in exchange for catching the real cases.

### The composite

```
distinctiveness = clamp((confusableFold(name).length − 2) / 10, 0, 1)
score = (1 − maxPriorSimilarity) × (1 − clichePenalty) × (0.6 + 0.4 × distinctiveness)
```

The three factors multiply because each is close to a veto: a repeat is a repeat
regardless of how clean the name is. `distinctiveness` bottoms out at 0.6 rather
than 0, so a very short name is discounted but not zeroed — a 2-character folded
name scores 0.6×, a 12-character one scores 1.0×.

### Name and ticker quality heuristics

`scoreNameQuality` and `scoreTickerQuality` return `[0,1]` scores that feed the
model as `name_quality` and `ticker_quality`. Both start at 0.5 and adjust:

**Names.** +0.18 for a folded length of 3–12, −0.20 above 18 ("long enough to be
forgettable"). +0.10 for at most 2 words, −0.12 for 4 or more. +0.12 for a vowel
ratio between 0.25 and 0.55, −0.12 otherwise. −0.15 for a run of 4 or more
consonants. −0.10 for any digit. +0.08 when every word starts with the same
letter, because alliteration genuinely aids recall.

**Tickers.** +0.25 for length 3–6; −0.15 below 3 (collides with existing
listings); −0.25 above 8 (truncated in most UIs). +0.12 for pure letters. −0.12
for digits. −0.12 when a ticker of 4 or more characters contains no vowel.

These are heuristics about memorability, and they are the least defensible
numbers in the scoring layer — nothing has validated them against outcomes. They
enter the model as features with modest prior weights (`name_quality` 0.22–0.34
across the four heads, `ticker_quality` 0.15–0.24), which is the right place for
a hunch: the learning loop can move them, and the notes they
produce are shown to the operator as text rather than being hidden inside a
score.

---

## 7. The adversarial panel

**File:** `packages/server/src/services/evaluation.service.ts`

A single model asked "is this good?" says yes. It has no incentive to reject its
own output and no information the generator did not have. The platform therefore
runs a small panel with roles that are adversarial **by construction**:

| Role | Brief | Model tier |
|---|---|---|
| `skeptic` | Find the reasons this fails, not a balanced view. Score 0.8+ only if no serious weakness exists | generation |
| `market_analyst` | Demand only: audience size, timing, competition, whether these people trade tokens at all | generation |
| `risk` | Legal, ethical and reputational exposure only. Explicitly told not to comment on commercial potential | generation |
| `creative_critic` | One test: would someone who knows this trend screenshot it and send it to a friend | triage |

Default roles are `skeptic`, `market_analyst`, `risk` (`ai.panelRoles`). They run
concurrently via `Promise.allSettled`; a role that fails is logged and the panel
proceeds with the rest, because losing one perspective is much better than losing
the candidate. If *every* role fails, the result is `panelScore: 0`,
`disagreement: 1`, and `requiresHumanReview: true` — not a pass.

```
panelScore   = Σ score × roleWeight / Σ roleWeight
               weights: skeptic 1.3, market_analyst 1.2, creative_critic 1.0, risk 0.6
disagreement = clamp(stddev(scores) × 2, 0, 1)
```

Two things are worth noting about that aggregation.

**The risk reviewer is a veto, not a vote.** Its weight in the average is the
lowest (0.6) precisely because averaging is the wrong instrument for it: a
`reject` verdict from the risk role sets `blocked = true` regardless of the
score, and the candidate cannot be launched. Giving it a large averaging weight
would let it drag good candidates down without actually stopping bad ones.

**Disagreement is a feature, not noise to be averaged away.** Two panellists at
0.3 and 0.9 describe a genuinely uncertain candidate, and that is different
information from two panellists at 0.6. It is passed to the prediction model as
`ai_panel_disagreement`, with a negative prior weight in every head (−0.10 to
−0.20), so the model can learn how much to discount contested candidates.
Disagreement above 0.45 also forces human review.

`requiresHumanReview` is set when the candidate is blocked, when any risk flag
fired, when disagreement exceeds 0.45, or when any role returned `reject`.

Each role declares its own model tier, and the tier is where the cost discipline
sits: `creative_critic` runs on the cheap triage model, the other three on the
mid generation model. Note that with the default role set — `skeptic`,
`market_analyst`, `risk` — every panellist is on the generation tier, so the
triage-tier saving only materialises if an operator adds `creative_critic`.

**The decision tier is configured but unused.** `ai.decisionModel` (default
`claude-opus-5`) is a real setting and `AiRouter` will route a `decision`-tier
request to it, but no role and no service in the pipeline ever asks for that
tier. There is no "only survivors reach the strongest model" step today; the
strongest model is wired up and idle.

---

## 8. The feature vector

**File:** `packages/shared/src/domain/features.ts`

Every prediction is a pure function of a `LaunchFeatures` object plus a versioned
model. The object is persisted verbatim next to the prediction, which is what
makes the learning loop honest: any old decision can be re-scored with a new
model, and any new model can be scored against old decisions.

28 numeric features, 4 interactions, and 3 categoricals hashed into 12 buckets
each — **68 dimensions total**.

Numeric features are standardised against **fixed reference scales**, not dataset
statistics:

```
z = clamp((raw − centre) / scale, −6, 6)
```

Using fixed centres and scales rather than a running mean and standard deviation
is a correctness requirement, not a simplification. If the encoder's scaling
drifted with the data, a stored feature vector would mean something different
each time it was re-encoded, and every stored model would silently become wrong.
Clipping at ±6 stops one outlier from dominating a single online gradient step.

A few of the reference points, to make the scale concrete:

| Feature | centre | scale |
|---|---|---|
| `trend_velocity` | 0.08 | 0.12 |
| `trend_age_hours` | 36 | 48 |
| `trend_expected_remaining_hours` | 72 | 72 |
| `saturation` | 0.40 | 0.25 |
| `market_graduation_rate` | 0.012 | 0.02 |

`neutralFeatures()` returns every numeric feature at its centre — used when a
signal is genuinely unavailable, so an absent input encodes as "average" rather
than as zero, which after standardisation would be a strong negative.

### Interactions

Four hand-chosen interaction terms encode domain knowledge that a linear model
cannot represent:

| Term | Definition | Meaning |
|---|---|---|
| `x_velocity_x_unsaturated` | `vel × (−sat)` | Fast growth is worth much more in an empty space |
| `x_velocity_x_originality` | `vel × orig` | Fast growth with an original concept |
| `x_early_x_breadth` | `(−age) × breadth` | Early *and* broadly confirmed |
| `x_velocity_sq` | `vel²` | Curvature in the growth response |

The first three carry meaningful prior weights (up to 0.40 for
`x_velocity_x_unsaturated` in the graduation head). `x_velocity_sq` appears in no
priors table, so it starts at weight 0 and only moves if the data moves it.

### Categoricals

`category`, `primary_source` and `concept_archetype` are hashed with FNV-1a into
12 one-hot buckets each. Fixed width is the point: adding a new category never
changes the vector length, which would invalidate every stored model. The cost is
collisions — there are 14 trend categories hashing into 12 buckets, so some
categories share a coefficient. That is an accepted trade for schema stability,
and it is a reason not to read much into any single categorical weight.

---

## 9. The prediction model

**File:** `packages/shared/src/model/linear.ts`, `predict.ts`

### Why an online linear model rather than gradient boosting

Sample size, and nothing else. Gradient boosting on a few dozen launches with 68
features would fit noise perfectly and generalise not at all. It also offers no
natural way to encode what the operator already believes before any data exists,
so the platform would have to run on a separate hand-written heuristic first and
cut over to a learned model later — two code paths, two sets of behaviour, and a
discontinuity exactly when the model is least trustworthy.

A linear model with informative priors avoids all of that. It **starts** as a
transparent heuristic (the priors are the heuristic), and it **becomes** a
learned model as evidence accumulates, with no cutover and no second code path.
Every prediction decomposes exactly into per-feature contributions
(`weight × value` summed to a log-odds), which is what makes the transparency UI
and the per-launch post-mortems possible at all.

The honest cost: the model cannot represent interactions it was not handed
(hence the four explicit interaction terms), and it will underfit once there are
thousands of launches. That is a good problem to have and a long way off.

### The four classification heads

| Head | Milestone | Prior base rate |
|---|---|---|
| `first_buy` | Anybody traded it at all | 0.420 |
| `ten_holders` | Reached 10 distinct holders | 0.160 |
| `hundred_holders` | Reached 100 distinct holders | 0.035 |
| `graduation` | Reached an AMM pool | 0.012 |

They are a nested ladder, and `predictLaunch` enforces that explicitly after
shrinkage:

```
p(ten_holders)     = min(p(ten_holders),     p(first_buy))
p(hundred_holders) = min(p(hundred_holders), p(ten_holders))
p(graduation)      = min(p(graduation),      p(hundred_holders))
```

Four separate models can otherwise produce incoherent output — a 3% chance of
graduating and a 2% chance of ten holders — which would be visibly wrong in the
UI and would poison the Monte Carlo, where graduation is drawn conditional on a
first buy.

Ten holders is the platform's headline call, and it is the milestone the quality
gate thresholds on. The reason is stated in `analytics.service.ts`: it is the
smallest milestone that cannot be reached by the creator's own dev buy plus a
couple of bots.

### The log-normal magnitude heads

Volume and lifespan are modelled as `log(1 + y) ~ Normal(μ(x), σ)`, which makes
the predictive distribution log-normal — the right shape for a quantity where the
top few percent carry most of the total.

```
μ(x) = bias + Σ w_i x_i
median = expm1(μ)
mean   = expm1(μ + σ²/2)
quantile(q) = expm1(μ + σ · Φ⁻¹(q))          # Acklam's rational approximation
```

The median and the mean are both exposed, and they differ enormously: with
`σ = 2.3` the log-normal mean is `e^(σ²/2) ≈ 14×` the median. Reporting only one
of them would be a choice about which lie to tell, so both exist and the UI
labels the median as the honest central estimate.

`σ` starts at a prior (2.3 for volume, 1.3 for lifespan) and is only re-estimated
from residuals once the head has at least 8 observations, then clamped to
`[0.4, 4]`. Before that the prior σ stands, because a residual standard deviation
from three points is not an estimate of anything.

### AdaGrad with L2 toward the prior

One update step, for both head types:

```
error = (p − y) × clamp(sampleWeight, 0, 10)                     # logistic
error = (μ − log1p(y)) × clamp(sampleWeight, 0, 10)              # log-normal

grad_i  = error × x_i + l2 × (w_i − priorWeight_i)
accum_i += grad_i²
w_i     -= learningRate / (sqrt(accum_i) + 1e-8) × grad_i
```

Defaults: `l2 = 0.15`, `learningRate = 0.08` (classification) or `0.06`
(log-normal).

Two choices worth spelling out.

**L2 toward the prior, not toward zero.** Standard L2 shrinks coefficients toward
zero, which encodes the belief that a feature has no effect until proved
otherwise. That is the wrong prior here. The platform's actual belief is that
saturation hurts, that cross-platform breadth helps, and so on — that is what
`priors.ts` is. Regularising toward those values means sparse evidence pulls the
model back to considered domain judgement rather than to agnosticism, and only
sustained contrary evidence moves a weight away. The prior array is kept
alongside the live weights for the whole life of the model, which is also what
makes the "weights that have moved" report in section 12 possible.

**AdaGrad rather than a fixed step.** The features have very different effective
frequencies — a categorical bucket fires on a minority of samples, `saturation`
is present in every one. A single global learning rate either crawls on the rare
features or oscillates on the common ones. AdaGrad's per-feature accumulator
gives large steps to rarely-seen features and small ones to features already
observed many times, which is the correct behaviour for sparse one-hot blocks.
Its known weakness — the accumulator only grows, so the effective rate decays
monotonically — is acceptable and arguably desirable here, because later
evidence *should* move an established weight less than early evidence did.

Updates are **non-mutating**: `updateLinearModel` returns a new state. That is
what lets the learning loop build a candidate bundle, score it, and throw it away
without having touched the live model.

### Confidence shrinkage

Raw probabilities from a model that has seen four launches are not probabilities.
Every head's output goes through:

```
trust = observations / (observations + 25)
p_out = clamp(trust × p + (1 − trust) × (0.5 × p + 0.5 × baseRate), 1e-4, 0.9999)
```

with `observations = bundle.trainedOn`. Note the exact behaviour at the extremes:
with zero evidence the output is not the base rate, it is the **midpoint of the
model's output and the base rate**. The features are still allowed to say
something; they are simply given half the vote. At 25 observations the weighting
is `0.75 p + 0.25 baseRate`.

Separately, a `confidence` figure is reported alongside every prediction:

```
confidence = clamp(0.25
                   + 0.5 × trainedOn / (trainedOn + 30)
                   + 0.25 × clamp(trend_source_breadth, 0, 1),
                   0.1, 0.95)
```

With no training data and a mid-range breadth this is about 0.375. Confidence
never reaches 1: the ceiling of 0.95 is a statement that this model does not get
to be certain. `prediction.service.ts` computes and persists the number only —
turning it into a sentence happens downstream, in the candidate detail page
(which raises a warning banner below its low-confidence threshold) and in
`notification.service.ts`.

---

## 10. The priors, and why they are pessimistic

**File:** `packages/shared/src/model/priors.ts`

```
BASE_RATES = { firstBuy: 0.42, tenHolders: 0.16, hundredHolders: 0.035, graduation: 0.012 }
PRIOR_BIASES = logit of each of the above
PRIOR_VOLUME_BIAS_24H = log1p(2.5)     # median 2.5 SOL of 24h turnover
PRIOR_VOLUME_SIGMA    = 2.3
PRIOR_LIFESPAN_BIAS   = log1p(30)      # median 30 hours
PRIOR_LIFESPAN_SIGMA  = 1.3
```

The biases are set as the logit of the base rate so that a candidate with an
entirely average feature vector — every feature at its `FEATURE_SCALES` centre,
hence every standardised value zero — predicts exactly the base rate. That is the
property that makes the priors interpretable: the bias is the answer for a
nothing-special launch, and the weights are everything the features add or
subtract from it.

The rates are deliberately pessimistic, and the reason is asymmetric cost. Every
launch spends SOL and generation budget; a system that starts optimistic will
over-launch during exactly the period when it has no evidence to correct itself,
and it will burn the operating float before the learning loop ever gets enough
labelled outcomes to notice. Starting pessimistic means the platform under-acts
early, which costs opportunity but not money, and the exploration path (section
12) exists specifically to stop that pessimism becoming self-sealing.

The numbers are also, as far as permissionless launch venues go, roughly honest:
a graduation rate near 1% and a "nobody ever bought it" rate near 58% is what
this market looks like. The dashboard states plainly that these are encoded
judgement, not measurement, and `observedBaseRates()` replaces each one only
after 30 labelled outcomes for that head (section 12).

Prior weights are declared per head, with magnitudes rising along the ladder —
`saturation` moves from −0.35 in `first_buy` to −0.70 in `graduation`,
`ai_panel_score` from 0.30 to 0.50. That gradient encodes the belief that
getting a single buyer is mostly luck, while getting to a hundred holders
requires the thing to actually be good. Any feature absent from a head's table
starts at weight 0, which is a real statement: `PRIOR_FIRST_BUY` deliberately has
no `cultural_relevance` term, because nothing about cultural fit predicts whether
one bot buys 0.01 SOL of your token.

---

## 11. Expected value by Monte Carlo

**File:** `packages/shared/src/model/predict.ts` (`simulateCreatorFees`)

### Why not multiply means

The tempting arithmetic is `P(success) × average revenue given success − cost`.
It is wrong here in both directions.

The outcome distribution is a mixture with a large point mass at zero (most
launches never trade) and a heavy right tail (one launch in fifty earns more than
the rest combined). Multiplying a probability by a conditional mean throws away
the shape entirely, and the shape is what the operator needs: the probability of
being net-positive, the p10–p90 spread, and how much of the expected value sits
in the top 1% of outcomes. A mean that is 14× the median is not a planning
figure. Reporting only that number, with no distribution behind it, is how a
system talks an operator into a strategy whose typical outcome is nothing.

So the platform simulates the joint outcome directly: **4000 draws**
(`MONTE_CARLO_DRAWS`), through a seeded generator (`createRng`), so any decision
can be replayed exactly during an audit.

### The staged simulation

Per draw:

**Stage 1 — does anybody trade it at all?**
```
if rng.next() > p(first_buy):  fees = 0, next draw
```
Most draws stop here. This is the point mass at zero, represented explicitly
rather than smeared into an average.

**Stage 2 — 24h organic volume, conditional on a first buyer.**
```
conditioningShift = −log(max(0.05, p(first_buy)))
vol24 = max(0, expm1(μ_vol + conditioningShift + σ_vol × normal()))
```

The shift is the important part. The volume head is fit on **all** launches
including the ones that never traded, so its `μ` already carries the mass at
zero. Sampling from that unconditional distribution *after* having already
conditioned on a first buy would double-count the failure mode and understate
every surviving draw. Re-centring by `−log(p)` — equivalently, multiplying the
median by `1/p(first_buy)` — restores the conditional distribution. With
`p = 0.42` that is a 2.4× uplift. The `max(0.05, ...)` caps the uplift at 20×, so
a near-zero first-buy probability cannot produce an absurd conditional volume.

This is an approximation, not an identity: the true conditional distribution of a
zero-inflated log-normal is not simply the unconditional one translated in log
space. It is the right direction and roughly the right magnitude, and it is
documented as such in the code.

**Stage 3 — lifespan, and how much tail volume materialises.**
```
lifeHours  = clamp(expm1(μ_life + σ_life × normal()), 0.5, 4380)
decayDays  = clamp(lifeHours / 24, 0.05, 90)
tailVolume = vol24 × clamp(3.2 × (1 − exp(−decayDays / 2.5)), 0, 40)
curveVolume = vol24 + tailVolume
```

`lifetimeVolumeMultiplier` (3.2) is the ceiling on how much day-one volume a
token repeats over its life, and the exponential term is how much of that ceiling
a token of a given lifespan actually reaches — a token that dies in six hours
gets almost none of it, one that lives a fortnight gets nearly all. Lifespan and
volume are drawn independently, which understates their real correlation; a token
that trades heavily on day one tends to live longer.

**Stage 4 — graduation and AMM fees.**
```
graduated  = rng.next() < p(graduation) / max(p(first_buy), 1e-6)
ammVolume  = graduated ? curveVolume × (1.5 + 4 × uniform()) : 0
```
The division converts the unconditional graduation probability into one
conditional on having reached this branch, which is required because stage 1
already consumed the first-buy draw. Post-graduation volume is drawn as 1.5× to
5.5× of curve volume, uniformly — a crude stand-in for "a graduated token keeps
trading for a while", not a modelled quantity.

**Fees and claim costs.**
```
fees   = curveVolume × 0.003 + ammVolume × 0.006
claims = fees > 0 ? min(12, ceil(decayDays / 3)) : 0
net    = max(0, fees − claims × 0.00002)
```

The curve rate (30 bps of trade volume, out of 125 bps total) is stated in
`DEFAULT_ECONOMICS` as verified on-chain. The AMM rate of 60 bps is a blended
estimate: canonical PumpSwap pools pay a market-cap-indexed creator share from
95 bps just after graduation down to 5 bps for very large caps, and a freshly
graduated coin sits near the top of that curve. Fee parameters are read from
chain at runtime elsewhere in the platform; these are the modelling defaults.

Claim costs are modelled honestly but are nearly irrelevant at these
magnitudes — the maximum of twelve claims costs 0.00024 SOL, against a total
modelled cost of 0.029 SOL per launch (0.025 on-chain plus 0.004 of generation).
The stage exists so that the arithmetic stays correct if fee-collection costs
ever become material, not because it changes any current decision.

### What comes out

```
expectedValueSol      = mean(draws) − (launchCostSol 0.025 + candidateCostSol 0.004)
probabilityProfitable = fraction of draws where net > 0.029
tailConcentration     = share of the total contributed by the top 40 draws (1%)
creatorFeesSol        = { mean, median, p10, p90, p99 }
```

`expectedValueSol` uses the **mean** of the simulated distribution, which is
correct — expected value is a mean by definition. What makes it safe to report is
that it never appears alone: `tailConcentration` says how much of it rests on the
top 1% of outcomes, and the median and p10 say what a typical draw looks like. An
EV of +0.02 SOL with a tail concentration of 0.85 and a median of 0 is a very
different proposition from the same EV with a median of 0.02, and the UI shows
both.

One inconsistency to be aware of: the reported `volume7dMedianSol` is a flat
`3.2 × volume24hMedianSol`, whereas the simulation derives tail volume from the
sampled lifespan. The two figures are therefore not derived from the same model
and will not reconcile exactly.

---

## 12. The quality gate

**File:** `packages/server/src/services/quality-gate.service.ts`

The most important property of this component is that **launching zero tokens
today is a normal, correct outcome**. Nothing in it tries to fill a quota. It
either finds a candidate that clears every threshold or it does not.

### Hard blocks — never relaxed, not even for exploration

| Check | Condition | Rejection reason |
|---|---|---|
| Safety screening | No risk flag at `block` severity | `safety_block` |
| Name/ticker collision | `!hardCollision` (when `blockOnHardCollision`, default `true`) | `duplicate_concept` |
| Trend freshness | `ageHours <= maxTrendAgeHours` (default 96) | `trend_expired` |

The first hard failure short-circuits: the gate returns immediately with
`rankScore: 0` and the specific reason, without evaluating the soft thresholds.
This is deliberate — a blocked candidate should produce one clear explanation,
not a list of scores next to a block.

Trend freshness sits among the hard blocks rather than the soft ones because it
is the thesis. A 200-hour-old trend is not a marginal candidate to be traded off
against a strong opportunity score; it is outside the window where being early
means anything.

### Soft thresholds — the exploration path may relax two of them

| Check | Default threshold | Exploration threshold |
|---|---|---|
| Opportunity score | `>= 58` | `>= min(58, 45)` |
| Originality | `>= 0.62` | unchanged |
| Saturation | `<= 0.45` | `<= max(0.45, 0.60)` |
| Source breadth | `>= 2` distinct platforms | unchanged |
| P(ten holders) | `>= 0.18` | unchanged |
| Expected value | `>= 0.0 SOL` net of costs | unchanged |
| P(profitable) | `>= 0.12` | unchanged |

Settings live under `qualityGate.*` and `exploration.*`. The `min`/`max`
construction means an operator who sets the main threshold *below* the
exploration threshold does not accidentally make exploration stricter than
exploitation. The relaxations apply only when `exploration.enabled` (default
`true`) is set *and* the per-concept draw described in section 13 comes up
inside the current exploration rate.

Only the two thresholds that encode the platform's *opinion* are relaxed —
"this trend does not look good enough" and "this space looks crowded". The ones
that encode arithmetic (expected value, probability of profit) and the ones that
encode quality floors (originality, breadth) are not, because exploring a region
the model is wrong about is useful, and launching something the model correctly
prices as a loss is not.

Every check is recorded in the `checks` array with its value, threshold and
comparison, whether it passed or failed, so the dashboard can show exactly what
happened rather than a verdict.

### Ranking passing candidates

```
freshness   = exp(−ageHours / 48)
evComponent = tanh(expectedValueSol × 40)
rankScore   = evComponent × (0.55 + 0.20 × confidence + 0.15 × originality + 0.10 × freshness)
```

Expected value is the objective, so it is the multiplicand and everything else is
a modifier bounded in `[0.55, 1.00]` — the tie-breakers can cut a candidate's
rank score by at most 45%. They therefore cannot reorder two candidates whose
`tanh(ev × 40)` values differ by more than a factor of `1 / 0.55 ≈ 1.8`. Note
that the bound is on the compressed `evComponent`, not on raw SOL: because `tanh`
flattens out, two candidates well into the tail (say +0.05 and +0.10 SOL, mapping
to 0.96 and 0.9993) are close enough in `evComponent` that the tie-breakers *can*
swap them. The guarantee holds where the EV differences are small, which is where
it matters.

`tanh(ev × 40)` compresses EV into a comparable range before combining. Without
it, EV in SOL is a small number (a good candidate might be +0.02) and the
tie-breakers, which live in `[0,1]`, would dominate the objective entirely. The
factor of 40 puts the interesting range of EV in the responsive part of the tanh:
0.01 SOL maps to 0.38, 0.025 SOL to 0.76, 0.05 SOL to 0.96.

The tie-breakers are chosen to counteract a specific failure: ranking on EV alone
concentrates every launch in whatever region the model is currently most
optimistic about, which is also the region where it is most likely to be wrong.
Confidence favours candidates whose value is better evidenced; originality
favours the less derivative one when two candidates price the same.

---

## 13. Exploration

**File:** `packages/shared/src/bandit/thompson.ts`, driven from
`quality-gate.service.ts`

### Why the rate decays with evidence

A fixed "10% of launches are experimental" is wrong at both ends of the
platform's life. Early on, when the model has seen nothing, a confident rejection
from an uninformed model is worth almost nothing — nearly everything should be
exploration. Late on, when the model has real evidence, spending a fixed tenth of
the budget on candidates it correctly rejects is pure waste.

```
explorationRate(totalLaunches) = clamp(max(floor, ceiling × halfLife / (halfLife + totalLaunches)), 0, 1)
```

The floor and ceiling are always supplied by the quality gate from settings
(`exploration.minExplorationRate` = 0.1, `exploration.maxExplorationRate` = 0.5);
`halfLife` is never passed, so the built-in 40 applies. (`explorationRate` also
carries its own fallback defaults of 0.1 / 0.6 / 40 for callers that pass
nothing, but the gate is the only caller and it always passes the first two.)
With those values:

| Launches so far | Exploration rate |
|---|---|
| 0 | 0.500 |
| 20 | 0.333 |
| 40 | 0.250 |
| 100 | 0.143 |
| 160+ | 0.100 (floor) |

The floor is not a rounding artefact. It exists because the market regime turns
over — launch rates, bot behaviour, who is buying — and a model that has stopped
exploring cannot discover that its world changed.

The draw is **deterministic per concept**: `createRng(hashSeed("explore:" + conceptId))`.
Re-evaluating the same candidate must not flip its decision by luck, or the
audit trail becomes meaningless.

### Thompson sampling over the arms

When a candidate takes the exploration path, an arm is selected by sampling each
arm's Beta posterior and taking the maximum:

```
sampled_i ~ Beta(priorAlpha + successes, priorBeta + failures)
chosen = argmax sampled_i
```

Default arm priors are `Beta(1, 3)` — a pessimistic prior, consistent with the
base rates: an untested strategy is assumed to work about a quarter of the time
until shown otherwise.

Sampling rather than picking the best posterior mean is the whole point. An arm
with a poor record still gets drawn occasionally in proportion to the probability
that it is actually the best, so an arm that was unlucky in its first three
attempts is not permanently dead. Arms are tried less as they look worse but
never fall to zero, which is the exploration/exploitation behaviour wanted here
with no hand-tuned percentage anywhere.

The five default arms (`ensureDefaultArms`, dimension `exploration_strategy`):

| Key | What it explores |
|---|---|
| `early_low_confidence` | Very early trends the model is unsure about |
| `high_saturation_differentiated` | Crowded spaces with a sharply differentiated angle |
| `off_hours` | Launch windows outside peak activity |
| `niche_audience` | Small but highly engaged audiences |
| `absurdist` | Absurdist concepts with no obvious market logic |

Each is a hypothesis about where the current model is systematically wrong.

The experiments page exposes both the posterior interval and a UCB value
(`clamp(mean + 1.4 × sqrt(log(max(2, totalPulls)) / n), 0, 2)`, with `n = 0`
returning 1) because they answer different questions: the interval says how much is known, the
UCB says what is worth trying next. An untested arm has a wide interval *and* a
high UCB, and reading only one of the two invites the wrong conclusion.

**Honest limitation.** The selected arm is recorded on the concept
(`concepts.exploration_arm`) and the analytics layer can group outcomes by it
(`byDimension('exploration_arm')`). But `experiments.updateBanditArm` — the
function that folds a launch outcome back into an arm's success/failure counters
— has **no caller anywhere in the server**. The bandit's posteriors therefore do
not currently update from real outcomes on their own; the arms keep their
`Beta(1, 3)` priors and sampling stays effectively uniform. Arm performance is
visible in analytics, but the loop is not closed automatically. The A/B
experiment machinery in `experiment.service.ts` is a separate mechanism and does
record its own arm outcomes.

---

## 14. The learning loop

**File:** `packages/server/src/services/learning.service.ts`

This is the only place the platform is allowed to claim it has learned something,
so the bar is set deliberately high.

### Outcome horizons

Outcomes are recorded at **24, 72 and 168 hours** (`STANDARD_HORIZON_HOURS`).

| Horizon | What it captures |
|---|---|
| 24h | Whether anybody showed up at all — how most launches are settled |
| 72h | The realistic window in which a meme token either compounds or dies |
| 168h | Terminal label: past this, a token that has not graduated essentially never does |

A launch becomes eligible for a horizon only once the **entire window** sits in
the past (`confirmed_at <= now − horizon`), with a second in-loop check for
clock-skew defence. This is not fussiness. Measuring a 168-hour outcome at hour
20 does not produce a noisy label, it produces a systematically wrong one — almost
every token looks like a failure four hours in — and a model trained on those
labels learns that nothing ever works.

Everything is measured **as of the horizon boundary**, not as of now, so an
outcome recorded late reads identically to one recorded on time. That is what
makes labels comparable across a backfill.

### Absence is not zero

The single most consequential rule in this service: a label that cannot be
measured is stored as `NULL`, never as `0`. Once a silent zero is in the table it
is indistinguishable from a measured failure.

This shows up everywhere in `recordOutcomes`:

- The holder label rests on `COUNT(holders)`, never `COUNT(*)`. A poll that
  returned no holder field is not a poll that saw zero holders.
- A token that was never polled at all (`obs_total = 0`) with no `first_trade_at`
  gets `y_first_buy = NULL`, because an absent first trade there means "nobody
  looked", not "nobody bought".
- Volume falls back to the token's all-time peak only when a volume figure was
  ever populated (`volume_obs_total > 0`) *and* either that peak is zero (a real
  measurement, since the peak is monotone) or the token has not been touched
  since the window closed.
- Lifespan is **right-censored**: a token still trading at hour 168 has a lifespan
  of *at least* 168 hours. Those samples are flagged
  (`lifespanCensored = lifespan >= horizonHours × 0.995`) and **dropped** from the
  lifespan head's training rather than clamped, because feeding "168" for every
  survivor would teach the model that tokens die precisely at the measurement
  boundary.

One launch produces up to three outcome rows describing the same event, so
training on all of them would triple its influence and mix contradictory labels.
`loadSamples` takes only the **longest available horizon** per launch, on the
grounds that it is a strictly more informative version of the shorter ones.

### Recency weighting

```
weight = 0.5 ^ (age / 30 days)
```

The market regime turns over in weeks. A launch from three months ago is genuine
evidence, but it is evidence about a *different* market, worth roughly an eighth
of one from last week. Thirty days is short enough to track the regime and long
enough that a quiet fortnight does not erase the model's memory. The weight is
passed straight into `updateLinearModel` as `sampleWeight`, where it scales the
gradient (clamped to `[0, 10]`).

### Why a retrained model is only activated if it does not worsen log loss

The procedure in `train()`:

1. Require at least **24** unapplied labelled outcomes (`DEFAULT_MIN_SAMPLES`).
2. Split **temporally**, not randomly: the most recent 25% (`HOLDOUT_FRACTION`,
   minimum 6 rows, `MIN_HOLDOUT_SAMPLES`) is held out.
3. Apply the online update to the older portion, producing a candidate bundle.
4. Score the old and the new bundle on the holdout, **shrinking probabilities
   exactly as `predictLaunch` does**, because the comparison must be between the
   numbers the platform would actually publish, not between raw logits nobody
   ever sees.
5. Accept only if `lossAfter <= lossBefore + 1e-6`. The tolerance covers float
   noise, nothing more.
6. If accepted, **refit from the original weights over every sample** — including
   the holdout — so no evidence is wasted. The holdout decides *whether* to
   update, not *what* the final weights are.
7. If rejected, the candidate is still persisted (inactive) with a note
   explaining the decision, and the outcomes stay unapplied so a later, larger
   batch can try again with the same evidence.

The temporal split is the load-bearing part. A random split leaks the current
regime into the validation set and flatters every update; the question being
asked is "does this help on launches the update has not seen yet", and that is a
question about *later* launches specifically.

Log loss is the acceptance criterion because it is a proper scoring rule that
punishes confident wrongness, which is the exact failure mode being guarded
against. A miscalibrated model is worse than a stale one: it keeps the same
interface, speaks with the same confidence, and downstream gates act on it.

The pooled log loss is **sample-weighted across heads**, not a flat mean of the
four head losses, so a head with six labels cannot outvote one with sixty in the
activation decision. Head sets differ in size by an order of magnitude —
`first_buy` gets labelled far more often than `graduation`.

When the activation decision rests on a thin holdout, the returned reason says
so: *"a 12-launch holdout cannot separate a real improvement from luck, so this
decision is provisional"*.

On acceptance, the observed base rates replace the hand-set ones (see below), the
new bundle is saved and activated as `v2-trained-{n}`, and every unapplied
outcome row for those predictions is marked applied — not just the row that was
used, so a shorter horizon cannot be re-fed later as new evidence about the same
launch.

### Observed base rates

```
if labelled count for this head < 30 (MIN_BASE_RATE_SAMPLES):
    return the domain prior, with n = 0 and source = 'prior'
else:
    Beta posterior with pseudo-counts (prior × 20, (1 − prior) × 20)
```

Two things here. First, a prior is returned with `n = 0` **on purpose** — a prior
is backed by no samples and must never be read as a measurement. The true count
stays visible in a separate `observedN` field. Second, the posterior is anchored
on the domain prior with a pseudo-count of 20, so a run of four lucky launches
cannot move the graduation rate from 1.2% to 100%.

This matters more than it looks, because base rates drive the shrinkage in
`predictLaunch`. A wrong base rate quietly biases every prediction the platform
makes.

### Calibration measurement

`evaluate()` scores the probabilities the platform **actually published** — the
ones stored at decision time, not re-scored with the current model.

For each head, the mean predicted probability is compared against the realised
frequency, with a 95% **Wilson interval** on the frequency:

| Condition | Verdict |
|---|---|
| `meanPredicted > interval.upper` | `overconfident` — promising more than the market delivers |
| `meanPredicted < interval.lower` | `underconfident` — talking these launches down |
| inside the interval | `well calibrated` |
| `n < 20` (`MIN_VERDICT_SAMPLES`) | `insufficient data` |

Using the interval rather than a point comparison is what stops ordinary sampling
noise being reported as miscalibration.

Reliability-diagram bins carry the same discipline: ten bins over a few dozen
launches are thin by construction, so each bin reports its own `n` and its own
Wilson interval, and an **empty bin reports `null`, not zero**. The same applies
to head metrics — log loss, Brier and observed rate are `null` when there is
nothing to measure, because a log loss of 0 reads as "perfect", which is the
opposite of what an empty head means. AUC is `null` unless both classes are
present, since the 0.5 a naive implementation returns would read as "no
discriminating power".

### Per-launch post-mortems

`predictionErrors()` produces a sentence per launch built from the feature
contributions stored with the prediction, branching on the direction of the miss:

- **Pessimistic miss** (`y = 1`, error < −0.15): names the largest negative
  driver — "the model marked it down mostly for on-chain saturation (−0.31 to the
  log-odds), and that read did not hold here".
- **Optimistic miss** (`y = 0`, error > 0.15): names the largest positive drivers
  — "the estimate rested on trend growth rate (+0.44) and cross-platform
  confirmation (+0.28), and this time holders did not follow".
- **Directionally right**: names the largest term behind it, and explicitly adds
  "That is what the model weighted, not a demonstrated cause of the outcome."

The holder count quoted in an explanation is the peak **inside the outcome
window**, never the token's all-time peak — quoting a later peak beside a label
measured at the horizon produces sentences that contradict their own label.

### Weight drift

`movedWeights()` reports the features whose learned weights have drifted furthest
from their priors, which is possible only because the prior array is retained for
the life of the model. Deltas below 0.02 are filtered as AdaGrad noise rather
than a change of mind. Every generated sentence is worded as an association —
"counts more toward ten holders than the priors assumed, on the launches seen so
far" — never as a cause.

---

## 15. Statistical discipline

**Files:** `packages/shared/src/math/stats.ts`,
`packages/server/src/services/analytics.service.ts`

Two rules run through every reported number.

### No rate without its sample size and an interval

`RateEstimate` is the only shape a proportion is allowed to take: point, lower,
upper, successes, n, method, and `reliable` (false below `MIN_RELIABLE_N = 8`).
Eight is where a `Beta(1,1)` posterior on a proportion first narrows to roughly
±0.3 — still wide, but no longer uninformative.

Two interval methods, used for different things:

- **Wilson** for observed rates (execution rate, success rate, graduation rate).
  It is well-behaved near 0 and 1, where the normal approximation to a binomial
  is badly wrong and where most of these rates actually live.
- **Beta posterior** where a small-sample point estimate would otherwise be
  absurd. `Beta(1,1)` is uniform, so a 1-for-1 group reports about 0.67 rather
  than 100%, and a 0-for-1 group reports about 0.33 rather than 0.

`betaPosterior` uses a normal approximation to the credible interval, clamped to
`[0,1]`. That is adequate for a dashboard and is documented as such; it is not
exact for very small `α` or `β`.

### Shrinkage toward a global mean

Group leaderboards (by category, archetype, source, saturation band, exploration
arm) rank on a **shrunk** mean:

```
shrunk = (groupMean × groupN + globalMean × 5) / (groupN + 5)      # SHRINK_STRENGTH = 5
```

Each group is treated as carrying five extra launches at the global average. With
typical group sizes of 5–30 this is strong enough that a single outlier cannot
win a leaderboard and weak enough that a genuinely good segment surfaces once it
has around 15 launches. Ties are broken by `n`, so between two equally shrunk
groups the better-evidenced one ranks first. The raw mean is reported alongside,
so the shrinkage is visible rather than hidden.

### Median, percentiles and tail share instead of the mean alone

Revenue follows a power law. The mean over a power-law sample describes almost
none of its members: one token in fifty earns more than the other forty-nine
combined, so the average describes no launch that ever happened.

Every revenue figure is therefore reported as a distribution:
median, p10/p25/p75/p90/p99, max, top 1%/5%/10% shares, a Gini coefficient, and a
`meanToMedianRatio`. Above about 2, that ratio means the average is a statement
about the tail rather than about a typical launch, and the analytics layer emits
a caveat saying so in words. When the median is zero it says that instead: *"the
median token earned nothing, so revenue per launch has no meaningful central
value; all of it sits in the tail."*

Below `MIN_RELIABLE_N = 8` the caveat states that the percentiles are "arithmetic
on these n values, not estimates of the underlying distribution". Below 100
tokens the tail-share figures carry a further note that the "top 1%" is in fact
one or two specific tokens, not a percentile of a population — `topShare` takes
`ceil(frac × n)` with a floor of 1.

The same treatment applies inside the learning service (`SkewedSummary`), where
the mean is included explicitly "so the figures reconcile" and the note tells the
reader which figures to actually read.

### The selection-bias caveat

`signalPredictiveness()` reports Spearman rank correlations between each stored
decision-time feature and realised creator fees. Rank rather than Pearson,
because one 10 SOL token would otherwise decide every coefficient; ties get
average ranks so that near-categorical features like `launch_hour_utc` are not
biased. Intervals are Fisher-z, returned as `null` when `n < 4` and also when the
sample correlation is exactly ±1, where the transform diverges and any interval
would be an artefact of the clamp.

Every correlation carries this caveat as **part of the data**, not as
decoration — it is a field on the returned object:

> Observational, not causal. The sample contains only candidates the platform
> chose to launch, so every feature is range-restricted by the quality gate and
> any apparent effect is confounded with that selection — the launches that would
> have tested the other end of each feature were never made. Outcomes are also
> right-censored: recently launched tokens are still accruing fees, so their
> revenue is understated relative to older ones, and any feature that drifted
> over time will correlate with that instead. Every feature is scored against the
> same outcome on the same sample, so the strongest of a long list is partly the
> winner of a multiple-comparisons draw. Treat a strong coefficient as a
> hypothesis to test with a deliberate exploration arm, never as a lever to pull.

Four distinct problems are named there, and all four are real: range restriction
from the gate, confounding with the selection rule, right-censoring of recent
launches, and multiple comparisons across roughly thirty features. A coefficient
is marked `reliable` only when it is non-degenerate, not exactly ±1, has a
defined interval, and has at least `MIN_CORRELATION_N = 20` observations.

The same two caveats — selection bias, and association rather than causation — are
attached verbatim to the calibration report, the observed base rates and the
learning summary, rather than being stated once and left for the reader to
remember.

---

## 16. What would make this better, with more data

Stated as honestly as the limitations in the README.

**The priors are the model.** Until there are a few hundred labelled launches,
almost everything the platform outputs is `priors.ts` with feature adjustments on
top. The `trustStatement` in the learning summary says this in plain language at
every sample size, and it is the single most important sentence on the dashboard.
Below 10 launches, rank ordering between candidates should not be trusted at all.

**Graduation will stay the weakest head for a very long time.** At a base rate
near 1.2%, several hundred launches contain only a handful of positive examples.
Its interval stays wide however much data arrives, and no amount of modelling
effort fixes a rare-event sample size. The most useful improvement would be
supervising it on *market-wide* graduations rather than only the platform's own —
tokens the platform did not launch are observable, and would multiply the
positive-example count by orders of magnitude, at the cost of a covariate shift
between the platform's candidates and the general population.

**Counterfactuals are modelled, never measured.** The platform only observes
outcomes for tokens it launched. The exploration path exists to widen that window
deliberately, and it is currently the only mechanism doing so — which is why the
uncoupled bandit counters noted in section 13 matter more than they look.

**Several constants have never been validated against anything.** The source
independence weights, the lifespan base hours per phase, the name and ticker
quality heuristics, the saturation exponent of 1.6, the evidence floor of 0.3 and
the 0.12 credit for an unmeasurable growth rate, the mass knee of 2.5, the AMM
volume multiplier range of 1.5–5.5×. Each is an argued judgement. With enough
outcomes, each could be fitted — the source weights against whether multi-family
confirmation actually predicts holders, the lifespan curve against realised
lifespans, the saturation exponent by grid search on held-out log loss. None of
that is possible at current sample sizes, and pretending otherwise would be worse
than leaving them as declared assumptions.

**Volume and lifespan are drawn independently in the Monte Carlo.** They are
correlated in reality — a token that trades heavily on day one lives longer —
which means the simulation understates both the very good and the very bad tails.
Fitting a joint distribution needs enough launches to estimate a correlation, and
would be a clear improvement once they exist.

**The conditioning shift in stage 2 is an approximation.** Translating the
unconditional log-normal by `−log(p)` is the right direction but not the exact
conditional distribution of a zero-inflated log-normal. A properly specified
hurdle model — one head for the zero mass, one for the positive part — would be
cleaner and is a natural upgrade once the volume head has real residuals to fit
against.

**Categorical hashing collides.** Fourteen trend categories into twelve buckets
means some share a coefficient. This is an accepted cost of keeping the vector
width stable across model versions, but it does mean no single categorical weight
should be interpreted on its own. Widening the block is a schema change that
invalidates stored models, so it should happen once, deliberately, not gradually.

**`socialTokenisationSignal` is specified but never supplied**, so 8% of the
saturation score is permanently zero. Measuring how much social discussion
already frames a trend as a coin would be one of the higher-value additions
available, because it is a leading indicator of exactly the crowding the
platform most wants to avoid — it fires before the competing tokens exist.

---

## Where the numbers live

| Constant | Value | File |
|---|---|---|
| `MATCH_NAME_THRESHOLD` | 0.78 | `server/src/services/trend.service.ts` |
| `MATCH_EMBEDDING_THRESHOLD` | 0.72 | `server/src/services/trend.service.ts` |
| Source-diversity knee | 1.8 | `server/src/services/trend.service.ts` |
| `SOURCE_INDEPENDENCE` | table | `shared/src/domain/enums.ts` |
| `LOCAL_EMBEDDING_DIM` | 384 | `shared/src/text/embedding.ts` |
| `DEFAULT_OPPORTUNITY_WEIGHTS` | table, bias −2.6, saturation exponent 1.6, evidence floor 0.3 | `shared/src/scoring/opportunity.ts` |
| `UNMEASURED_RATE_CREDIT` | 0.12 | `shared/src/scoring/opportunity.ts` |
| `MIN_SPAN_HOURS`, `MAX_RELATIVE_VELOCITY` | 0.5 h, 2.0 | `shared/src/math/timeseries.ts` |
| `SIMILARITY_FLOOR` | 0.42 | `shared/src/scoring/saturation.ts` |
| `HARD_COLLISION_THRESHOLD` | 0.88 | `shared/src/scoring/saturation.ts` |
| Saturation mass knee | 2.5 | `shared/src/scoring/saturation.ts` |
| `CLICHE_PATTERNS` | table, cap 0.75 | `shared/src/scoring/originality.ts` |
| Duplicate threshold | 0.85 | `shared/src/scoring/originality.ts` |
| `FEATURE_SCALES` | table, 68-dim vector | `shared/src/domain/features.ts` |
| `BASE_RATES` | 0.42 / 0.16 / 0.035 / 0.012 | `shared/src/model/priors.ts` |
| Prior σ (volume, lifespan) | 2.3, 1.3 | `shared/src/model/priors.ts` |
| L2, learning rate | 0.15, 0.08 / 0.06 | `shared/src/model/linear.ts` |
| Shrinkage half-life | 25 observations | `shared/src/model/linear.ts` |
| `MONTE_CARLO_DRAWS` | 4000 | `shared/src/model/predict.ts` |
| `DEFAULT_ECONOMICS` | 30 bps curve / 60 bps AMM, 0.025 + 0.004 SOL | `shared/src/model/predict.ts` |
| Exploration floor / ceiling (settings) | 0.1 / 0.5 | `shared/src/domain/settings.ts` |
| Exploration half-life (built in, never overridden) | 40 | `shared/src/bandit/thompson.ts` |
| Arm prior | `Beta(1, 3)` | `shared/src/bandit/thompson.ts`, `server/src/db/schema.ts` |
| Outcome horizons | 24 / 72 / 168 h | `server/src/services/learning.service.ts` |
| Recency half-life | 30 days | `server/src/services/learning.service.ts` |
| Verdict / base-rate / training minimums | 20 / 30 / 24 | `server/src/services/learning.service.ts` |
| Holdout fraction, minimum | 0.25, 6 | `server/src/services/learning.service.ts` |
| Base-rate prior pseudo-count | 20 | `server/src/services/learning.service.ts` |
| `MIN_RELIABLE_N`, `SHRINK_STRENGTH` | 8, 5 | `server/src/services/analytics.service.ts` |
| `MIN_CORRELATION_N` | 20 | `server/src/services/analytics.service.ts` |
| Quality-gate defaults | 58 / 0.62 / 0.45 / 0.18 / 0.0 / 0.12 / 2 / 96 h | `shared/src/domain/settings.ts` |
| `conceptGenerationThreshold` | 52 | `shared/src/domain/settings.ts` |

See [Configuration](configuration.md) for how to change the tunable ones, and
[Architecture](architecture.md) for how these components are wired together.
