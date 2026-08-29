import { z } from 'zod';

/** How much the platform is allowed to do on its own, per capability. */
export const AutonomyLevel = z.enum(['off', 'suggest', 'approve', 'auto']);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export const AutonomyCapability = z.enum([
  'research',
  'concept_generation',
  'artwork',
  'metadata',
  'launch',
  'social',
  'fee_collection',
  'wallet_transfer',
]);
export type AutonomyCapability = z.infer<typeof AutonomyCapability>;

/**
 * Phased activation ladder. Each phase must be deliberately enabled and every
 * phase above SIMULATION additionally requires the phase gate checks to pass.
 */
export const OperatingPhase = z.enum([
  'phase1_research',
  'phase2_devnet',
  'phase3_mainnet_approval',
  'phase4_limited_autonomous',
  'phase5_adaptive_autonomous',
]);
export type OperatingPhase = z.infer<typeof OperatingPhase>;

export const ExecutionNetwork = z.enum(['simulation', 'devnet', 'mainnet']);
export type ExecutionNetwork = z.infer<typeof ExecutionNetwork>;

/**
 * Trend data sources.
 *
 * The first block is the zero-auth core: every one of these works on a fresh
 * install with no signup, which is why the platform can discover opportunities
 * out of the box. The second block needs credentials and is optional.
 *
 * Notably absent from the default set: Reddit (unauthenticated JSON endpoints
 * now return 403 and OAuth access is gated behind an approval process) and
 * X (no free tier; reads are billed per returned post). Both are supported when
 * the operator supplies credentials, neither is required.
 */
export const TrendSourceId = z.enum([
  // Zero-auth core.
  'google_trends',
  'bluesky',
  'mastodon',
  'wikipedia',
  'hackernews',
  'gdelt',
  'stackexchange',
  'rss',
  // Credentialed, optional.
  'youtube',
  'reddit',
  'x',
  // On-chain / market-derived.
  'pumpfun_market',
  'dexscreener',
  'manual',
]);
export type TrendSourceId = z.infer<typeof TrendSourceId>;

/** Sources that work with no API key at all. */
export const ZERO_AUTH_TREND_SOURCES: TrendSourceId[] = [
  'google_trends',
  'bluesky',
  'mastodon',
  'wikipedia',
  'hackernews',
  'gdelt',
  'stackexchange',
  'rss',
];

/**
 * Independence weights for cross-platform confirmation.
 *
 * Sources measuring the same population should not both count as independent
 * evidence. Search demand, social conversation, encyclopaedia lookups and news
 * coverage are genuinely different populations; two Fediverse instances are not.
 */
export const SOURCE_INDEPENDENCE: Record<TrendSourceId, { family: string; weight: number }> = {
  google_trends: { family: 'search', weight: 1.0 },
  wikipedia: { family: 'reference', weight: 0.95 },
  gdelt: { family: 'news', weight: 0.9 },
  bluesky: { family: 'social', weight: 0.85 },
  mastodon: { family: 'social', weight: 0.6 },
  x: { family: 'social', weight: 0.9 },
  reddit: { family: 'forum', weight: 0.85 },
  hackernews: { family: 'forum', weight: 0.6 },
  stackexchange: { family: 'forum', weight: 0.4 },
  youtube: { family: 'video', weight: 0.85 },
  rss: { family: 'news', weight: 0.5 },
  pumpfun_market: { family: 'onchain', weight: 0.7 },
  dexscreener: { family: 'onchain', weight: 0.5 },
  manual: { family: 'manual', weight: 0.3 },
};

export const TrendCategory = z.enum([
  'internet_culture',
  'ai_tech',
  'crypto_native',
  'gaming',
  'sports',
  'entertainment',
  'music',
  'politics_news',
  'science',
  'finance',
  'animals',
  'food',
  'absurdist',
  'other',
]);
export type TrendCategory = z.infer<typeof TrendCategory>;

export const TrendStatus = z.enum(['active', 'watch', 'fading', 'archived']);
export type TrendStatus = z.infer<typeof TrendStatus>;

export const TrendPhaseEnum = z.enum(['nascent', 'emerging', 'peaking', 'declining', 'dormant']);
export type TrendPhaseEnum = z.infer<typeof TrendPhaseEnum>;

export const ConceptStatus = z.enum([
  'draft',
  'evaluating',
  'rejected',
  'candidate',
  'awaiting_approval',
  'approved',
  'queued',
  'launching',
  'launched',
  'failed',
  'expired',
]);
export type ConceptStatus = z.infer<typeof ConceptStatus>;

export const RejectionReason = z.enum([
  'below_opportunity_threshold',
  'below_originality_threshold',
  'above_saturation_threshold',
  'below_expected_value',
  'risk_flagged',
  'duplicate_concept',
  'trademark_risk',
  'impersonation_risk',
  'daily_limit_reached',
  'budget_exhausted',
  'trend_expired',
  'human_rejected',
  'quality_gate',
  'safety_block',
]);
export type RejectionReason = z.infer<typeof RejectionReason>;

export const LaunchStatus = z.enum([
  'pending',
  'preparing',
  'submitted',
  'confirmed',
  'failed',
  'abandoned',
]);
export type LaunchStatus = z.infer<typeof LaunchStatus>;

/** Data-driven post-launch classification. */
export const TokenLifecycle = z.enum([
  'new',
  'early_traction',
  'growing',
  'high_momentum',
  'graduated',
  'active',
  'declining',
  'dormant',
  'failed',
]);
export type TokenLifecycle = z.infer<typeof TokenLifecycle>;

export const FeeEventKind = z.enum(['accrual_snapshot', 'collection', 'adjustment']);
export type FeeEventKind = z.infer<typeof FeeEventKind>;

export const ExpenseKind = z.enum([
  'ai_inference',
  'ai_image',
  'rpc',
  'market_data',
  'launch_sol',
  'network_fee',
  'priority_fee',
  'infrastructure',
  'other',
]);
export type ExpenseKind = z.infer<typeof ExpenseKind>;

export const RiskFlag = z.enum([
  'trademark',
  'copyrighted_character',
  'real_person',
  'company_impersonation',
  'existing_project_collision',
  'misleading_financial_claim',
  'hate_or_harassment',
  'sexual_content',
  'violence',
  'illegal_activity',
  'medical_or_legal_claim',
  'election_related',
  'tragedy_exploitation',
  'minor_related',
  'deceptive_theme',
  'ticker_collision',
  'name_collision',
  'prompt_injection_detected',
  'low_quality',
]);
export type RiskFlag = z.infer<typeof RiskFlag>;

export const UserRole = z.enum(['owner', 'admin', 'analyst', 'viewer']);
export type UserRole = z.infer<typeof UserRole>;

export const Permission = z.enum([
  'view',
  'run_research',
  'generate_concepts',
  'approve_candidate',
  'reject_candidate',
  'launch_token',
  'collect_fees',
  'transfer_funds',
  'edit_wallet_config',
  'edit_limits',
  'edit_autonomy',
  'manage_users',
  'manage_experiments',
  'view_audit',
  'export_accounting',
  'emergency_stop',
]);
export type Permission = z.infer<typeof Permission>;

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: Permission.options.slice(),
  admin: Permission.options.filter((p) => p !== 'manage_users'),
  analyst: ['view', 'run_research', 'generate_concepts', 'reject_candidate', 'manage_experiments', 'view_audit', 'export_accounting'],
  viewer: ['view'],
};

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

export const HealthState = z.enum(['ok', 'degraded', 'down', 'unconfigured', 'unknown']);
export type HealthState = z.infer<typeof HealthState>;

export const NotificationEvent = z.enum([
  'token_graduated',
  'high_organic_volume',
  'large_fee_accrual',
  'fees_collected',
  'launch_succeeded',
  'launch_failed',
  'wallet_balance_low',
  'system_paused',
  'emergency_stop',
  'provider_unavailable',
  'unusual_activity',
  'high_value_opportunity',
  'candidate_awaiting_approval',
  'model_retrained',
  'daily_digest',
]);
export type NotificationEvent = z.infer<typeof NotificationEvent>;

export const AiPurpose = z.enum([
  'trend_triage',
  'trend_enrichment',
  'concept_generation',
  'concept_critique',
  'market_analysis',
  'risk_review',
  'decision',
  'image_prompt',
  'image_generation',
  'summarisation',
  'embedding',
]);
export type AiPurpose = z.infer<typeof AiPurpose>;
