import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Database schema.
 *
 * Conventions:
 *  - Primary keys are sortable string IDs (see `core/ids.ts`), so rows order by
 *    creation time without a separate sequence.
 *  - Timestamps are unix milliseconds stored as integers. SQLite has no date
 *    type worth using and integers sort, index and diff correctly.
 *  - Monetary amounts are stored as integer lamports wherever they represent
 *    real on-chain values; floating point never touches money.
 *  - Columns holding structured data store JSON text and are read through the
 *    typed helpers in `db/json.ts`.
 */

const now = sql`(unixepoch('subsec') * 1000)`;

// ---------------------------------------------------------------------------
// Identity and access control
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role').notNull().default('viewer'),
    passwordHash: text('password_hash').notNull(),
    /** scrypt parameters and salt, stored alongside the hash. */
    passwordParams: text('password_params').notNull(),
    /** Base32 TOTP secret, encrypted at rest. Null when 2FA is off. */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: integer('locked_until'),
    lastLoginAt: integer('last_login_at'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the session token; the raw token never touches the database. */
    tokenHash: text('token_hash').notNull(),
    /** Rotating CSRF token bound to this session. */
    csrfToken: text('csrf_token').notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull().default(now),
    lastSeenAt: integer('last_seen_at').notNull().default(now),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Configuration and secrets
// ---------------------------------------------------------------------------

export const settings = sqliteTable('settings', {
  /** Always the literal 'current'; a single row holds the live configuration. */
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: integer('updated_at').notNull().default(now),
  updatedBy: text('updated_by'),
});

export const settingHistory = sqliteTable(
  'setting_history',
  {
    id: text('id').primaryKey(),
    path: text('path').notNull(),
    previousValue: text('previous_value'),
    newValue: text('new_value'),
    changedBy: text('changed_by'),
    actorType: text('actor_type').notNull().default('user'),
    reason: text('reason'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('setting_history_path_idx').on(t.path, t.createdAt)],
);

/**
 * Encrypted secret store. Values are AES-256-GCM ciphertext; the key is derived
 * from the master passphrase and never persisted. Reads are audited.
 */
export const secrets = sqliteTable(
  'secrets',
  {
    key: text('key').primaryKey(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    /** Key-derivation salt, per secret, so rotating one does not touch others. */
    salt: text('salt').notNull(),
    kdf: text('kdf').notNull().default('scrypt'),
    /** Non-secret hint shown in the UI, e.g. "sk-ant-…7f2a". */
    hint: text('hint'),
    category: text('category').notNull().default('api_key'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('secrets_category_idx').on(t.category)],
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Append-only, hash-chained audit log. Each row commits to the previous row's
 * hash, so any deletion or edit breaks the chain and is detectable.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    sequence: integer('sequence').notNull(),
    /** 'user' | 'system' | 'job' | 'ai' */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    /** Entity type and id the action targeted. */
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** JSON parameters, with secrets redacted before write. */
    parameters: text('parameters'),
    result: text('result').notNull().default('ok'),
    resultDetail: text('result_detail'),
    /** Model or transaction identifiers involved, when relevant. */
    modelVersion: text('model_version'),
    transactionSignature: text('transaction_signature'),
    reason: text('reason'),
    ipAddress: text('ip_address'),
    previousHash: text('previous_hash').notNull(),
    hash: text('hash').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('audit_sequence_uq').on(t.sequence),
    index('audit_action_idx').on(t.action, t.createdAt),
    index('audit_target_idx').on(t.targetType, t.targetId),
  ],
);

// ---------------------------------------------------------------------------
// Trend discovery
// ---------------------------------------------------------------------------

export const trends = sqliteTable(
  'trends',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    category: text('category').notNull().default('other'),
    status: text('status').notNull().default('active'),
    phase: text('phase').notNull().default('nascent'),
    /** Packed float32 embedding of title + summary. */
    embedding: text('embedding'),
    embeddingModel: text('embedding_model').notNull().default('local-hash-v1'),
    /** Keywords used to search competitor tokens and re-find this trend. */
    keywords: text('keywords').notNull().default('[]'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    /** Latest computed scores, denormalised for fast listing. */
    opportunityScore: real('opportunity_score').notNull().default(0),
    rawOpportunityScore: real('raw_opportunity_score').notNull().default(0),
    saturationScore: real('saturation_score').notNull().default(0),
    velocity: real('velocity').notNull().default(0),
    acceleration: real('acceleration').notNull().default(0),
    consistency: real('consistency').notNull().default(0),
    novelty: real('novelty').notNull().default(0),
    audienceEstimate: real('audience_estimate').notNull().default(0),
    sourceCount: integer('source_count').notNull().default(0),
    engagement: real('engagement').notNull().default(0),
    memeability: real('memeability').notNull().default(0),
    remainingLifespanHours: real('remaining_lifespan_hours').notNull().default(0),
    /** Full scoring breakdown JSON for the transparency UI. */
    scoreBreakdown: text('score_breakdown'),
    /** Cached AI enrichment (why this matters, meme angles). */
    aiSummary: text('ai_summary'),
    /** True when untrusted source text tripped the injection detector. */
    injectionFlagged: integer('injection_flagged', { mode: 'boolean' }).notNull().default(false),
    scoredAt: integer('scored_at'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('trends_slug_uq').on(t.slug),
    index('trends_status_score_idx').on(t.status, t.opportunityScore),
    index('trends_last_seen_idx').on(t.lastSeenAt),
    index('trends_category_idx').on(t.category),
  ],
);

export const trendObservations = sqliteTable(
  'trend_observations',
  {
    id: text('id').primaryKey(),
    trendId: text('trend_id')
      .notNull()
      .references(() => trends.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    observedAt: integer('observed_at').notNull(),
    /** Raw platform metric (upvotes, pageviews, mentions, tone-weighted count). */
    rawValue: real('raw_value').notNull(),
    /** Source-normalised 0..1 interest level. */
    normalisedValue: real('normalised_value').notNull().default(0),
    rank: integer('rank'),
    engagement: real('engagement'),
    audience: real('audience'),
    /** Sanitised excerpt kept for provenance; never fed back as instructions. */
    excerpt: text('excerpt'),
    url: text('url'),
    externalId: text('external_id'),
    metadata: text('metadata'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('trend_obs_trend_time_idx').on(t.trendId, t.observedAt),
    index('trend_obs_source_time_idx').on(t.source, t.observedAt),
    uniqueIndex('trend_obs_dedupe_uq').on(t.trendId, t.source, t.externalId),
  ],
);

// ---------------------------------------------------------------------------
// Concepts and evaluation
// ---------------------------------------------------------------------------

export const concepts = sqliteTable(
  'concepts',
  {
    id: text('id').primaryKey(),
    trendId: text('trend_id').references(() => trends.id, { onDelete: 'set null' }),
    batchId: text('batch_id'),
    name: text('name').notNull(),
    symbol: text('symbol').notNull(),
    description: text('description').notNull(),
    narrative: text('narrative'),
    archetype: text('archetype').notNull().default('unknown'),
    category: text('category').notNull().default('other'),
    status: text('status').notNull().default('draft'),
    rejectionReason: text('rejection_reason'),
    rejectionDetail: text('rejection_detail'),

    imagePrompt: text('image_prompt'),
    imagePath: text('image_path'),
    imageUri: text('image_uri'),
    metadataUri: text('metadata_uri'),
    /** Perceptual hash of the artwork, for duplicate-image detection. */
    imageHash: text('image_hash'),

    embedding: text('embedding'),
    embeddingModel: text('embedding_model').notNull().default('local-hash-v1'),

    originalityScore: real('originality_score').notNull().default(0),
    saturationScore: real('saturation_score').notNull().default(0),
    opportunityScore: real('opportunity_score').notNull().default(0),
    nameQuality: real('name_quality').notNull().default(0),
    tickerQuality: real('ticker_quality').notNull().default(0),
    aiPanelScore: real('ai_panel_score').notNull().default(0),
    aiPanelDisagreement: real('ai_panel_disagreement').notNull().default(0),
    memeIntensity: real('meme_intensity').notNull().default(0),
    culturalRelevance: real('cultural_relevance').notNull().default(0),
    artworkQuality: real('artwork_quality').notNull().default(0),

    /** JSON array of RiskFlag values plus detail. */
    riskFlags: text('risk_flags').notNull().default('[]'),
    hardCollision: integer('hard_collision', { mode: 'boolean' }).notNull().default(false),
    requiresHumanReview: integer('requires_human_review', { mode: 'boolean' }).notNull().default(true),

    /** JSON of the saturation and originality analyses for the UI. */
    saturationDetail: text('saturation_detail'),
    originalityDetail: text('originality_detail'),
    /** Concise, non-chain-of-thought decision summary. */
    reasoningSummary: text('reasoning_summary'),

    generatorModel: text('generator_model'),
    generationCostUsd: real('generation_cost_usd').notNull().default(0),

    /** Set when this candidate was selected as an exploration arm. */
    isExploration: integer('is_exploration', { mode: 'boolean' }).notNull().default(false),
    explorationArm: text('exploration_arm'),

    approvedBy: text('approved_by'),
    approvedAt: integer('approved_at'),
    expiresAt: integer('expires_at'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    index('concepts_status_idx').on(t.status, t.createdAt),
    index('concepts_trend_idx').on(t.trendId),
    index('concepts_batch_idx').on(t.batchId),
    index('concepts_symbol_idx').on(t.symbol),
  ],
);

export const conceptEvaluations = sqliteTable(
  'concept_evaluations',
  {
    id: text('id').primaryKey(),
    conceptId: text('concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    /** 'skeptic' | 'market_analyst' | 'risk' | 'creative_critic' | 'decision' */
    role: text('role').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** 0..1 overall score from this evaluator. */
    score: real('score').notNull().default(0),
    /** JSON of sub-scores. */
    subScores: text('sub_scores'),
    verdict: text('verdict'),
    /** Concise summary, never raw chain of thought. */
    summary: text('summary'),
    concerns: text('concerns').notNull().default('[]'),
    strengths: text('strengths').notNull().default('[]'),
    riskFlags: text('risk_flags').notNull().default('[]'),
    costUsd: real('cost_usd').notNull().default(0),
    latencyMs: integer('latency_ms'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('concept_eval_concept_idx').on(t.conceptId), index('concept_eval_role_idx').on(t.role)],
);

// ---------------------------------------------------------------------------
// Predictions and models
// ---------------------------------------------------------------------------

export const modelVersions = sqliteTable(
  'model_versions',
  {
    id: text('id').primaryKey(),
    version: text('version').notNull(),
    kind: text('kind').notNull().default('success_bundle'),
    /** Serialised model state. */
    state: text('state').notNull(),
    trainedOn: integer('trained_on').notNull().default(0),
    /** Evaluation metrics JSON: log loss, Brier, AUC, calibration bins. */
    metrics: text('metrics'),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('model_versions_version_uq').on(t.version), index('model_versions_active_idx').on(t.active)],
);

export const predictions = sqliteTable(
  'predictions',
  {
    id: text('id').primaryKey(),
    conceptId: text('concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    modelVersion: text('model_version').notNull(),
    /** Verbatim feature vector at decision time — the key to fair evaluation. */
    features: text('features').notNull(),
    pFirstBuy: real('p_first_buy').notNull().default(0),
    pTenHolders: real('p_ten_holders').notNull().default(0),
    pHundredHolders: real('p_hundred_holders').notNull().default(0),
    pGraduation: real('p_graduation').notNull().default(0),
    expectedVolume1hSol: real('expected_volume_1h_sol').notNull().default(0),
    expectedVolume24hSol: real('expected_volume_24h_sol').notNull().default(0),
    expectedVolume7dSol: real('expected_volume_7d_sol').notNull().default(0),
    expectedCreatorFeesSol: real('expected_creator_fees_sol').notNull().default(0),
    creatorFeesP10Sol: real('creator_fees_p10_sol').notNull().default(0),
    creatorFeesP90Sol: real('creator_fees_p90_sol').notNull().default(0),
    creatorFeesMedianSol: real('creator_fees_median_sol').notNull().default(0),
    expectedLifespanHours: real('expected_lifespan_hours').notNull().default(0),
    expectedValueSol: real('expected_value_sol').notNull().default(0),
    probabilityProfitable: real('probability_profitable').notNull().default(0),
    tailConcentration: real('tail_concentration').notNull().default(0),
    confidence: real('confidence').notNull().default(0),
    /** Top feature contributions JSON. */
    drivers: text('drivers'),
    /** Economic assumptions in force when this was computed. */
    economics: text('economics'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('predictions_concept_idx').on(t.conceptId), index('predictions_model_idx').on(t.modelVersion)],
);

/** Realised outcomes, joined to predictions for the learning loop. */
export const predictionOutcomes = sqliteTable(
  'prediction_outcomes',
  {
    id: text('id').primaryKey(),
    predictionId: text('prediction_id')
      .notNull()
      .references(() => predictions.id, { onDelete: 'cascade' }),
    tokenMint: text('token_mint'),
    /** Hours after launch at which the outcome was measured. */
    horizonHours: real('horizon_hours').notNull(),
    yFirstBuy: integer('y_first_buy'),
    yTenHolders: integer('y_ten_holders'),
    yHundredHolders: integer('y_hundred_holders'),
    yGraduation: integer('y_graduation'),
    actualVolume24hSol: real('actual_volume_24h_sol'),
    actualCreatorFeesSol: real('actual_creator_fees_sol'),
    actualLifespanHours: real('actual_lifespan_hours'),
    /** True once this row has been folded into a model update. */
    appliedToModel: integer('applied_to_model', { mode: 'boolean' }).notNull().default(false),
    appliedModelVersion: text('applied_model_version'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('prediction_outcome_uq').on(t.predictionId, t.horizonHours),
    index('prediction_outcome_applied_idx').on(t.appliedToModel),
  ],
);

// ---------------------------------------------------------------------------
// Launch execution
// ---------------------------------------------------------------------------

export const launches = sqliteTable(
  'launches',
  {
    id: text('id').primaryKey(),
    conceptId: text('concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    predictionId: text('prediction_id').references(() => predictions.id, { onDelete: 'set null' }),
    /**
     * Idempotency key derived from the concept. A unique index on this column is
     * what actually prevents a retried job from minting the same token twice.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    network: text('network').notNull(),
    adapter: text('adapter').notNull(),
    status: text('status').notNull().default('pending'),

    mintAddress: text('mint_address'),
    /** Encrypted mint keypair, retained only until launch is confirmed. */
    mintSecretEncrypted: text('mint_secret_encrypted'),
    creatorAddress: text('creator_address'),
    transactionSignature: text('transaction_signature'),
    blockhash: text('blockhash'),
    lastValidBlockHeight: integer('last_valid_block_height'),
    slot: integer('slot'),

    metadataUri: text('metadata_uri'),
    imageUri: text('image_uri'),

    devBuyLamports: integer('dev_buy_lamports').notNull().default(0),
    priorityFeeMicroLamports: integer('priority_fee_micro_lamports').notNull().default(0),
    totalCostLamports: integer('total_cost_lamports').notNull().default(0),
    networkFeeLamports: integer('network_fee_lamports').notNull().default(0),

    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    errorCode: text('error_code'),
    /** JSON array of every submission attempt, for post-mortems. */
    attemptLog: text('attempt_log').notNull().default('[]'),

    approvalMode: text('approval_mode').notNull().default('manual'),
    initiatedBy: text('initiated_by'),
    submittedAt: integer('submitted_at'),
    confirmedAt: integer('confirmed_at'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('launches_idempotency_uq').on(t.idempotencyKey),
    uniqueIndex('launches_mint_uq').on(t.mintAddress),
    index('launches_status_idx').on(t.status, t.createdAt),
    index('launches_network_idx').on(t.network),
  ],
);

// ---------------------------------------------------------------------------
// Launched tokens and monitoring
// ---------------------------------------------------------------------------

export const tokens = sqliteTable(
  'tokens',
  {
    mint: text('mint').primaryKey(),
    launchId: text('launch_id').references(() => launches.id, { onDelete: 'set null' }),
    conceptId: text('concept_id').references(() => concepts.id, { onDelete: 'set null' }),
    trendId: text('trend_id').references(() => trends.id, { onDelete: 'set null' }),
    network: text('network').notNull(),
    name: text('name').notNull(),
    symbol: text('symbol').notNull(),
    metadataUri: text('metadata_uri'),
    imageUri: text('image_uri'),
    creatorAddress: text('creator_address').notNull(),
    lifecycle: text('lifecycle').notNull().default('new'),
    /** Bonding-curve or pool addresses discovered post-launch. */
    bondingCurveAddress: text('bonding_curve_address'),
    poolAddress: text('pool_address'),
    poolIsCanonical: integer('pool_is_canonical', { mode: 'boolean' }),

    createdOnChainAt: integer('created_on_chain_at'),
    firstTradeAt: integer('first_trade_at'),
    lastTradeAt: integer('last_trade_at'),
    graduatedAt: integer('graduated_at'),
    dormantAt: integer('dormant_at'),

    /** Denormalised latest metrics for fast listing. */
    holders: integer('holders').notNull().default(0),
    peakHolders: integer('peak_holders').notNull().default(0),
    uniqueBuyers: integer('unique_buyers').notNull().default(0),
    marketCapUsd: real('market_cap_usd').notNull().default(0),
    peakMarketCapUsd: real('peak_market_cap_usd').notNull().default(0),
    priceSol: real('price_sol').notNull().default(0),
    liquidityUsd: real('liquidity_usd').notNull().default(0),
    volume1hSol: real('volume_1h_sol').notNull().default(0),
    volume24hSol: real('volume_24h_sol').notNull().default(0),
    /*
     * Cumulative traded volume, integrated from the rolling 24-hour windows the
     * market providers report. Each observation contributes the share of its
     * window that has elapsed since the last one accounted for, so a token
     * polled often and one polled rarely accumulate comparably and neither
     * double-counts an overlap. It is an estimate, not a measured lifetime
     * total — no provider reports one — and irregular polling makes it a rough
     * one. `peakVolume24hSol` is the separate question of the best single day.
     */
    volumeTotalSol: real('volume_total_sol').notNull().default(0),
    /** Observation time the running total above has been advanced to. */
    volumeAccountedAt: integer('volume_accounted_at'),
    peakVolume24hSol: real('peak_volume_24h_sol').notNull().default(0),
    txCount: integer('tx_count').notNull().default(0),
    buyCount: integer('buy_count').notNull().default(0),
    sellCount: integer('sell_count').notNull().default(0),
    holderGini: real('holder_gini').notNull().default(0),

    creatorFeesAccruedLamports: integer('creator_fees_accrued_lamports').notNull().default(0),
    creatorFeesCollectedLamports: integer('creator_fees_collected_lamports').notNull().default(0),
    lastFeeCheckAt: integer('last_fee_check_at'),
    lastFeeCollectionAt: integer('last_fee_collection_at'),

    /** Monitoring tier drives poll frequency; dormant tokens cost nothing. */
    monitorTier: text('monitor_tier').notNull().default('hot'),
    nextPollAt: integer('next_poll_at'),
    pollFailureCount: integer('poll_failure_count').notNull().default(0),
    dataSource: text('data_source'),

    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    index('tokens_lifecycle_idx').on(t.lifecycle),
    index('tokens_next_poll_idx').on(t.nextPollAt),
    index('tokens_network_idx').on(t.network),
    index('tokens_created_idx').on(t.createdAt),
  ],
);

export const marketObservations = sqliteTable(
  'market_observations',
  {
    id: text('id').primaryKey(),
    tokenMint: text('token_mint')
      .notNull()
      .references(() => tokens.mint, { onDelete: 'cascade' }),
    observedAt: integer('observed_at').notNull(),
    source: text('source').notNull(),
    priceSol: real('price_sol'),
    priceUsd: real('price_usd'),
    marketCapUsd: real('market_cap_usd'),
    liquidityUsd: real('liquidity_usd'),
    volume5mSol: real('volume_5m_sol'),
    volume1hSol: real('volume_1h_sol'),
    volume24hSol: real('volume_24h_sol'),
    holders: integer('holders'),
    txCount24h: integer('tx_count_24h'),
    buys24h: integer('buys_24h'),
    sells24h: integer('sells_24h'),
    bondingCurveProgress: real('bonding_curve_progress'),
    raw: text('raw'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('market_obs_token_time_idx').on(t.tokenMint, t.observedAt),
    uniqueIndex('market_obs_dedupe_uq').on(t.tokenMint, t.source, t.observedAt),
  ],
);

export const holderSnapshots = sqliteTable(
  'holder_snapshots',
  {
    id: text('id').primaryKey(),
    tokenMint: text('token_mint')
      .notNull()
      .references(() => tokens.mint, { onDelete: 'cascade' }),
    observedAt: integer('observed_at').notNull(),
    holderCount: integer('holder_count').notNull(),
    top10Share: real('top10_share'),
    gini: real('gini'),
    source: text('source').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('holder_snap_token_time_idx').on(t.tokenMint, t.observedAt)],
);

// ---------------------------------------------------------------------------
// Creator fees and accounting
// ---------------------------------------------------------------------------

export const creatorFeeEvents = sqliteTable(
  'creator_fee_events',
  {
    id: text('id').primaryKey(),
    tokenMint: text('token_mint').references(() => tokens.mint, { onDelete: 'cascade' }),
    /** 'accrual_snapshot' | 'collection' | 'adjustment' */
    kind: text('kind').notNull(),
    /** 'curve' | 'amm' — the two vaults accrue independently. */
    vault: text('vault').notNull().default('curve'),
    vaultAddress: text('vault_address'),
    walletAddress: text('wallet_address'),
    lamports: integer('lamports').notNull().default(0),
    /** For accrual snapshots: the claimable amount net of stranded rent. */
    claimableLamports: integer('claimable_lamports').notNull().default(0),
    usdValue: real('usd_value'),
    solPriceUsd: real('sol_price_usd'),
    transactionSignature: text('transaction_signature'),
    networkFeeLamports: integer('network_fee_lamports').notNull().default(0),
    source: text('source').notNull().default('rpc'),
    observedAt: integer('observed_at').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('fee_events_token_idx').on(t.tokenMint, t.observedAt),
    index('fee_events_kind_idx').on(t.kind, t.observedAt),
    uniqueIndex('fee_events_signature_uq').on(t.transactionSignature, t.vault),
  ],
);

export const expenses = sqliteTable(
  'expenses',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    description: text('description'),
    amountUsd: real('amount_usd').notNull().default(0),
    amountLamports: integer('amount_lamports').notNull().default(0),
    solPriceUsd: real('sol_price_usd'),
    /** What this cost was incurred for. */
    refType: text('ref_type'),
    refId: text('ref_id'),
    provider: text('provider'),
    incurredAt: integer('incurred_at').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('expenses_kind_time_idx').on(t.kind, t.incurredAt), index('expenses_ref_idx').on(t.refType, t.refId)],
);

export const walletAccounts = sqliteTable(
  'wallet_accounts',
  {
    id: text('id').primaryKey(),
    /** 'operating' | 'treasury' | 'external' */
    role: text('role').notNull(),
    address: text('address').notNull(),
    label: text('label').notNull(),
    network: text('network').notNull(),
    /** True when this process can sign for the account. */
    hasSigningKey: integer('has_signing_key', { mode: 'boolean' }).notNull().default(false),
    /** How the key is held: 'encrypted_keystore' | 'external' | 'watch_only'. */
    custody: text('custody').notNull().default('watch_only'),
    balanceLamports: integer('balance_lamports').notNull().default(0),
    balanceCheckedAt: integer('balance_checked_at'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('wallet_address_network_uq').on(t.address, t.network), index('wallet_role_idx').on(t.role)],
);

export const walletTransactions = sqliteTable(
  'wallet_transactions',
  {
    id: text('id').primaryKey(),
    walletAddress: text('wallet_address').notNull(),
    network: text('network').notNull(),
    signature: text('signature'),
    direction: text('direction').notNull(),
    purpose: text('purpose').notNull(),
    lamports: integer('lamports').notNull(),
    feeLamports: integer('fee_lamports').notNull().default(0),
    counterparty: text('counterparty'),
    status: text('status').notNull().default('pending'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    idempotencyKey: text('idempotency_key'),
    initiatedBy: text('initiated_by'),
    error: text('error'),
    occurredAt: integer('occurred_at').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('wallet_tx_signature_uq').on(t.signature),
    uniqueIndex('wallet_tx_idempotency_uq').on(t.idempotencyKey),
    index('wallet_tx_wallet_time_idx').on(t.walletAddress, t.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// Market intelligence
// ---------------------------------------------------------------------------

/** Cached competitor tokens used for saturation analysis. */
export const competitorTokens = sqliteTable(
  'competitor_tokens',
  {
    id: text('id').primaryKey(),
    mint: text('mint'),
    name: text('name').notNull(),
    symbol: text('symbol').notNull(),
    description: text('description'),
    embedding: text('embedding'),
    createdOnChainAt: integer('created_on_chain_at').notNull(),
    marketCapUsd: real('market_cap_usd'),
    volume24hUsd: real('volume_24h_usd'),
    liquidityUsd: real('liquidity_usd'),
    holders: integer('holders'),
    graduated: integer('graduated', { mode: 'boolean' }).notNull().default(false),
    source: text('source').notNull(),
    observedAt: integer('observed_at').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('competitor_mint_uq').on(t.mint),
    index('competitor_symbol_idx').on(t.symbol),
    index('competitor_created_idx').on(t.createdOnChainAt),
    index('competitor_observed_idx').on(t.observedAt),
  ],
);

/** Aggregate market-condition snapshots that feed the regime features. */
export const marketSnapshots = sqliteTable(
  'market_snapshots',
  {
    id: text('id').primaryKey(),
    observedAt: integer('observed_at').notNull(),
    launchesPerHour: real('launches_per_hour'),
    graduationsPerHour: real('graduations_per_hour'),
    graduationRate: real('graduation_rate'),
    medianTimeToFirstBuyMinutes: real('median_time_to_first_buy_minutes'),
    solPriceUsd: real('sol_price_usd'),
    solPriceChange24h: real('sol_price_change_24h'),
    /** 0..1 composite risk-appetite measure. */
    regimeScore: real('regime_score'),
    /** Per-category launch counts JSON. */
    categoryBreakdown: text('category_breakdown'),
    source: text('source').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('market_snapshots_time_idx').on(t.observedAt)],
);

// ---------------------------------------------------------------------------
// AI usage
// ---------------------------------------------------------------------------

export const aiRequests = sqliteTable(
  'ai_requests',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    purpose: text('purpose').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    latencyMs: integer('latency_ms'),
    cacheHit: integer('cache_hit', { mode: 'boolean' }).notNull().default(false),
    ok: integer('ok', { mode: 'boolean' }).notNull().default(true),
    errorCode: text('error_code'),
    error: text('error'),
    /** Hash of the prompt, for cache lookup and dedupe. Never the prompt itself. */
    promptHash: text('prompt_hash'),
    /** Set when the response failed schema validation and was retried. */
    schemaRetries: integer('schema_retries').notNull().default(0),
    injectionDetected: integer('injection_detected', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('ai_requests_time_idx').on(t.createdAt),
    index('ai_requests_purpose_idx').on(t.purpose, t.createdAt),
    index('ai_requests_ref_idx').on(t.refType, t.refId),
  ],
);

/** Response cache keyed by prompt hash, to avoid paying twice for the same call. */
export const aiCache = sqliteTable(
  'ai_cache',
  {
    key: text('key').primaryKey(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    purpose: text('purpose').notNull(),
    response: text('response').notNull(),
    hits: integer('hits').notNull().default(0),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('ai_cache_expiry_idx').on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// Experiments and bandits
// ---------------------------------------------------------------------------

export const experiments = sqliteTable(
  'experiments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    hypothesis: text('hypothesis').notNull(),
    /** The candidate attribute being varied, e.g. 'ticker_style'. */
    factor: text('factor').notNull(),
    status: text('status').notNull().default('draft'),
    /** Primary metric: 'creator_fees_sol' | 'ten_holders' | 'volume_24h_sol'. */
    metric: text('metric').notNull().default('creator_fees_sol'),
    minSamplesPerArm: integer('min_samples_per_arm').notNull().default(12),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    conclusion: text('conclusion'),
    createdBy: text('created_by'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('experiments_status_idx').on(t.status)],
);

export const experimentArms = sqliteTable(
  'experiment_arms',
  {
    id: text('id').primaryKey(),
    experimentId: text('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** JSON describing how this arm modifies generation. */
    config: text('config').notNull().default('{}'),
    successes: integer('successes').notNull().default(0),
    failures: integer('failures').notNull().default(0),
    rewardSum: real('reward_sum').notNull().default(0),
    rewardCount: integer('reward_count').notNull().default(0),
    priorAlpha: real('prior_alpha').notNull().default(1),
    priorBeta: real('prior_beta').notNull().default(3),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('experiment_arm_uq').on(t.experimentId, t.key)],
);

export const experimentAssignments = sqliteTable(
  'experiment_assignments',
  {
    id: text('id').primaryKey(),
    experimentId: text('experiment_id')
      .notNull()
      .references(() => experiments.id, { onDelete: 'cascade' }),
    armId: text('arm_id')
      .notNull()
      .references(() => experimentArms.id, { onDelete: 'cascade' }),
    conceptId: text('concept_id').references(() => concepts.id, { onDelete: 'cascade' }),
    tokenMint: text('token_mint'),
    /** Realised metric value, filled in once the outcome window closes. */
    outcomeValue: real('outcome_value'),
    outcomeSuccess: integer('outcome_success', { mode: 'boolean' }),
    outcomeAt: integer('outcome_at'),
    assignedAt: integer('assigned_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('experiment_assignment_uq').on(t.experimentId, t.conceptId),
    index('experiment_assignment_arm_idx').on(t.armId),
  ],
);

/** Standalone bandit arms used by the exploration policy outside formal experiments. */
export const banditArms = sqliteTable(
  'bandit_arms',
  {
    id: text('id').primaryKey(),
    dimension: text('dimension').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    successes: integer('successes').notNull().default(0),
    failures: integer('failures').notNull().default(0),
    rewardSum: real('reward_sum').notNull().default(0),
    rewardCount: integer('reward_count').notNull().default(0),
    priorAlpha: real('prior_alpha').notNull().default(1),
    priorBeta: real('prior_beta').notNull().default(3),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    updatedAt: integer('updated_at').notNull().default(now),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('bandit_arm_uq').on(t.dimension, t.key)],
);

// ---------------------------------------------------------------------------
// Jobs, health, notifications, logs
// ---------------------------------------------------------------------------

export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    jobName: text('job_name').notNull(),
    status: text('status').notNull().default('queued'),
    /** Prevents two schedulers from running the same job concurrently. */
    lockToken: text('lock_token'),
    trigger: text('trigger').notNull().default('schedule'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    durationMs: integer('duration_ms'),
    itemsProcessed: integer('items_processed').notNull().default(0),
    result: text('result'),
    error: text('error'),
    attempt: integer('attempt').notNull().default(1),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('job_runs_name_time_idx').on(t.jobName, t.createdAt), index('job_runs_status_idx').on(t.status)],
);

export const jobState = sqliteTable('job_state', {
  jobName: text('job_name').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  intervalSeconds: integer('interval_seconds').notNull(),
  lastRunAt: integer('last_run_at'),
  nextRunAt: integer('next_run_at'),
  lastStatus: text('last_status'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** Held by the running instance; expires so a crashed run cannot deadlock. */
  lockedUntil: integer('locked_until'),
  lockToken: text('lock_token'),
  updatedAt: integer('updated_at').notNull().default(now),
});

/** Generic idempotency guard for any side-effecting operation. */
export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    scope: text('scope').notNull(),
    status: text('status').notNull().default('in_progress'),
    resultRef: text('result_ref'),
    result: text('result'),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('idempotency_scope_idx').on(t.scope), index('idempotency_expiry_idx').on(t.expiresAt)],
);

export const providerHealth = sqliteTable('provider_health', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  kind: text('kind').notNull(),
  state: text('state').notNull().default('unknown'),
  detail: text('detail'),
  latencyMs: integer('latency_ms'),
  successCount: integer('success_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** Circuit breaker: requests are refused until this time. */
  circuitOpenUntil: integer('circuit_open_until'),
  rateLimitResetAt: integer('rate_limit_reset_at'),
  lastSuccessAt: integer('last_success_at'),
  lastFailureAt: integer('last_failure_at'),
  checkedAt: integer('checked_at').notNull().default(now),
});

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    event: text('event').notNull(),
    severity: text('severity').notNull().default('info'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Used to suppress duplicates within the dedupe window. */
    dedupeKey: text('dedupe_key'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    data: text('data'),
    readAt: integer('read_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('notifications_event_time_idx').on(t.event, t.createdAt), index('notifications_dedupe_idx').on(t.dedupeKey, t.createdAt)],
);

export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    id: text('id').primaryKey(),
    notificationId: text('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    deliveredAt: integer('delivered_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('notification_deliveries_status_idx').on(t.status)],
);

export const systemEvents = sqliteTable(
  'system_events',
  {
    id: text('id').primaryKey(),
    level: text('level').notNull().default('info'),
    component: text('component').notNull(),
    message: text('message').notNull(),
    /** Structured context JSON, already redacted. */
    context: text('context'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('system_events_time_idx').on(t.createdAt),
    index('system_events_level_idx').on(t.level, t.createdAt),
    index('system_events_component_idx').on(t.component, t.createdAt),
  ],
);

/** Daily rollups, recomputed idempotently, so analytics queries stay fast. */
export const dailyMetrics = sqliteTable(
  'daily_metrics',
  {
    day: text('day').notNull(),
    network: text('network').notNull(),
    launches: integer('launches').notNull().default(0),
    launchFailures: integer('launch_failures').notNull().default(0),
    conceptsGenerated: integer('concepts_generated').notNull().default(0),
    conceptsRejected: integer('concepts_rejected').notNull().default(0),
    trendsDiscovered: integer('trends_discovered').notNull().default(0),
    creatorFeesLamports: integer('creator_fees_lamports').notNull().default(0),
    creatorFeesCollectedLamports: integer('creator_fees_collected_lamports').notNull().default(0),
    organicVolumeSol: real('organic_volume_sol').notNull().default(0),
    spendLamports: integer('spend_lamports').notNull().default(0),
    aiSpendUsd: real('ai_spend_usd').notNull().default(0),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.day, t.network] })],
);
