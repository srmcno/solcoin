import { z } from 'zod';
import { AutonomyLevel, ExecutionNetwork, NotificationEvent, OperatingPhase, TrendSourceId } from './enums.js';

/**
 * Runtime strategy configuration.
 *
 * Everything a human would reasonably want to tune lives here and is editable
 * from the UI. Nothing in this object is a secret — API keys and wallet
 * material live in the encrypted secret store, never in settings.
 */

export const AutonomySettings = z.object({
  research: AutonomyLevel.default('auto'),
  concept_generation: AutonomyLevel.default('auto'),
  artwork: AutonomyLevel.default('auto'),
  metadata: AutonomyLevel.default('auto'),
  launch: AutonomyLevel.default('approve'),
  social: AutonomyLevel.default('off'),
  fee_collection: AutonomyLevel.default('approve'),
  wallet_transfer: AutonomyLevel.default('off'),
});
export type AutonomySettings = z.infer<typeof AutonomySettings>;

export const QualityGateSettings = z.object({
  /** 0..100. Candidates below this opportunity score never proceed. */
  minOpportunityScore: z.number().min(0).max(100).default(58),
  /** 0..1 */
  minOriginalityScore: z.number().min(0).max(1).default(0.62),
  /** 0..1 */
  maxSaturationScore: z.number().min(0).max(1).default(0.45),
  /** 0..1 minimum modelled probability of at least ten organic holders. */
  minProbabilityTenHolders: z.number().min(0).max(1).default(0.18),
  /** Minimum modelled expected value in SOL, net of costs. */
  minExpectedValueSol: z.number().default(0.0),
  /** Minimum modelled probability the launch is net profitable. */
  minProbabilityProfitable: z.number().min(0).max(1).default(0.12),
  /** Require a minimum number of independent trend sources. */
  minSourceBreadth: z.number().int().min(1).max(10).default(2),
  /** Reject candidates whose trend is older than this. */
  maxTrendAgeHours: z.number().min(1).default(96),
  /** Block launch entirely when a hard name/ticker collision is detected. */
  blockOnHardCollision: z.boolean().default(true),
  /** Require human review whenever any risk flag fires, even a soft one. */
  humanReviewOnAnyRiskFlag: z.boolean().default(true),
});
export type QualityGateSettings = z.infer<typeof QualityGateSettings>;

export const LimitSettings = z.object({
  maxLaunchesPerHour: z.number().int().min(0).max(20).default(1),
  maxLaunchesPerDay: z.number().int().min(0).max(50).default(3),
  maxSolSpendPerDay: z.number().min(0).default(0.5),
  maxSolPerTransaction: z.number().min(0).default(0.15),
  maxSolPerHour: z.number().min(0).default(0.3),
  maxAiSpendUsdPerDay: z.number().min(0).default(10),
  /** Operating wallet balance below which all spending stops. */
  walletBalanceFloorSol: z.number().min(0).default(0.05),
  /** Consecutive launch failures before the platform halts itself. */
  consecutiveFailureShutdown: z.number().int().min(1).default(3),
  /** Consecutive RPC errors before the RPC pool is marked down. */
  rpcFailureThreshold: z.number().int().min(1).default(8),
  maxTransactionRetries: z.number().int().min(0).max(10).default(3),
  /** Refuse to run at all if the machine clock drifts beyond this. */
  maxClockDriftSeconds: z.number().min(1).default(120),
});
export type LimitSettings = z.infer<typeof LimitSettings>;

export const WalletSettings = z.object({
  /** Sweep operating-wallet balance above this into treasury. */
  sweepThresholdSol: z.number().min(0).default(1.0),
  /** Leave at least this much in the operating wallet after a sweep. */
  operatingFloatSol: z.number().min(0).default(0.3),
  /** Automatic sweeps require `wallet_transfer` autonomy to be `auto`. */
  autoSweepEnabled: z.boolean().default(false),
  /** Treasury address (public key). Never holds a key in this process. */
  treasuryAddress: z.string().optional(),
});
export type WalletSettings = z.infer<typeof WalletSettings>;

export const FeeSettings = z.object({
  /** Minimum accrued SOL before a collection transaction is worth submitting. */
  collectionThresholdSol: z.number().min(0).default(0.002),
  /** Never collect more often than this per token. */
  minHoursBetweenCollections: z.number().min(0).default(6),
  /** Required ratio of accrued fees to estimated transaction cost. */
  minCollectionValueRatio: z.number().min(1).default(5),
  /** Sweep every token with any balance once per this interval regardless. */
  forceCollectionIntervalHours: z.number().min(0).default(168),
});
export type FeeSettings = z.infer<typeof FeeSettings>;

export const MonitoringSettings = z.object({
  /** Poll interval for tokens in their first hours. */
  hotIntervalSeconds: z.number().int().min(15).default(60),
  warmIntervalSeconds: z.number().int().min(60).default(600),
  coolIntervalSeconds: z.number().int().min(300).default(3600),
  dormantIntervalSeconds: z.number().int().min(3600).default(86400),
  /** Hours of no volume and no holder growth before a token is marked dormant. */
  dormantAfterQuietHours: z.number().min(1).default(72),
  /** Keep hot polling for this long after launch. */
  hotWindowHours: z.number().min(0.25).default(6),
  warmWindowHours: z.number().min(1).default(48),
});
export type MonitoringSettings = z.infer<typeof MonitoringSettings>;

export const ResearchSettings = z.object({
  enabledSources: z.array(TrendSourceId).default(['reddit', 'hackernews', 'wikipedia', 'gdelt']),
  discoveryIntervalMinutes: z.number().int().min(5).default(30),
  /** Maximum trends to keep in the active working set. */
  maxActiveTrends: z.number().int().min(10).default(400),
  /** Minimum opportunity score for a trend to earn concept generation. */
  conceptGenerationThreshold: z.number().min(0).max(100).default(52),
  /** Concepts generated per qualifying opportunity. */
  conceptsPerOpportunity: z.number().int().min(1).max(12).default(4),
  /** Additional subreddits / RSS feeds / query terms the operator wants watched. */
  customSubreddits: z.array(z.string()).default([]),
  customRssFeeds: z.array(z.string().url()).default([]),
  customKeywords: z.array(z.string()).default([]),
});
export type ResearchSettings = z.infer<typeof ResearchSettings>;

export const AiSettings = z.object({
  /** Cheap model for triage and classification. */
  triageModel: z.string().default('claude-haiku-4-5-20251001'),
  /** Mid model for candidate generation. */
  generationModel: z.string().default('claude-sonnet-5'),
  /** Strong model for the final launch decision. */
  decisionModel: z.string().default('claude-opus-5'),
  imageModel: z.string().default('none'),
  /** Enable the multi-agent evaluation panel (costs more, better decisions). */
  panelEnabled: z.boolean().default(true),
  /** Roles to run in the panel. */
  panelRoles: z.array(z.enum(['skeptic', 'market_analyst', 'risk', 'creative_critic'])).default(['skeptic', 'market_analyst', 'risk']),
  /** Cache identical prompts for this many minutes. */
  cacheTtlMinutes: z.number().int().min(0).default(240),
  maxConcurrentRequests: z.number().int().min(1).max(16).default(4),
  /** Hard cap on tokens per single request, to bound cost. */
  maxOutputTokens: z.number().int().min(256).default(4096),
});
export type AiSettings = z.infer<typeof AiSettings>;

export const ExplorationSettings = z.object({
  enabled: z.boolean().default(true),
  /** Floor on the fraction of launches reserved for exploration. */
  minExplorationRate: z.number().min(0).max(1).default(0.1),
  maxExplorationRate: z.number().min(0).max(1).default(0.5),
  /** Exploration candidates still must clear these (looser) gates. */
  explorationMinOpportunityScore: z.number().min(0).max(100).default(45),
  explorationMaxSaturation: z.number().min(0).max(1).default(0.6),
});
export type ExplorationSettings = z.infer<typeof ExplorationSettings>;

export const NotificationSettings = z.object({
  enabledEvents: z.array(NotificationEvent).default([
    'launch_succeeded',
    'launch_failed',
    'token_graduated',
    'large_fee_accrual',
    'wallet_balance_low',
    'emergency_stop',
    'candidate_awaiting_approval',
  ]),
  /** Channel toggles; credentials live in the secret store. */
  webhookEnabled: z.boolean().default(false),
  discordEnabled: z.boolean().default(false),
  telegramEnabled: z.boolean().default(false),
  emailEnabled: z.boolean().default(false),
  /** Minimum SOL accrual that counts as a "large" fee event. */
  largeFeeAccrualSol: z.number().min(0).default(0.05),
  /** Minimum 24h volume in SOL that counts as "high organic volume". */
  highVolumeSol: z.number().min(0).default(50),
  /** Suppress duplicate notifications for the same key within this window. */
  dedupeWindowMinutes: z.number().int().min(0).default(60),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const ExecutionSettings = z.object({
  network: ExecutionNetwork.default('simulation'),
  phase: OperatingPhase.default('phase1_research'),
  /** Optional initial developer buy, in SOL. Zero means create-only. */
  devBuySol: z.number().min(0).max(5).default(0),
  /** Slippage tolerance in basis points for the optional dev buy. */
  slippageBps: z.number().int().min(0).max(10000).default(500),
  /** Priority fee in micro-lamports per compute unit; 0 = auto-estimate. */
  priorityFeeMicroLamports: z.number().int().min(0).default(0),
  /** Jito tip in SOL, 0 to disable bundle submission. */
  jitoTipSol: z.number().min(0).default(0),
  /** Preferred launch execution adapter. */
  adapter: z.enum(['auto', 'pumpportal_local', 'pumpfun_sdk', 'simulation']).default('auto'),
  /** Confirmation commitment for launch transactions. */
  commitment: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
});
export type ExecutionSettings = z.infer<typeof ExecutionSettings>;

export const PlatformSettings = z.object({
  autonomy: AutonomySettings.default({}),
  qualityGate: QualityGateSettings.default({}),
  limits: LimitSettings.default({}),
  wallet: WalletSettings.default({}),
  fees: FeeSettings.default({}),
  monitoring: MonitoringSettings.default({}),
  research: ResearchSettings.default({}),
  ai: AiSettings.default({}),
  exploration: ExplorationSettings.default({}),
  notifications: NotificationSettings.default({}),
  execution: ExecutionSettings.default({}),
  /** Global kill switch. When true, no job with side effects runs. */
  emergencyStop: z.boolean().default(false),
  /** Human-readable reason recorded when the stop was engaged. */
  emergencyStopReason: z.string().default(''),
  /** Onboarding completion marker. */
  onboardingCompleted: z.boolean().default(false),
});
export type PlatformSettings = z.infer<typeof PlatformSettings>;

export function defaultSettings(): PlatformSettings {
  return PlatformSettings.parse({});
}

/**
 * Settings changes that materially increase risk. These require elevated
 * permissions and are always written to the audit log with before/after values.
 */
export const SENSITIVE_SETTING_PATHS = [
  'autonomy.launch',
  'autonomy.fee_collection',
  'autonomy.wallet_transfer',
  'execution.network',
  'execution.phase',
  'execution.devBuySol',
  'limits.maxLaunchesPerDay',
  'limits.maxLaunchesPerHour',
  'limits.maxSolSpendPerDay',
  'limits.maxSolPerTransaction',
  'limits.maxSolPerHour',
  'limits.walletBalanceFloorSol',
  'wallet.treasuryAddress',
  'wallet.autoSweepEnabled',
  'qualityGate.minOpportunityScore',
  'qualityGate.maxSaturationScore',
  'qualityGate.minExpectedValueSol',
  'qualityGate.blockOnHardCollision',
  'emergencyStop',
] as const;

export function isSensitiveSettingPath(path: string): boolean {
  return SENSITIVE_SETTING_PATHS.some((p) => path === p || path.startsWith(`${p}.`));
}
