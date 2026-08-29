import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_ECONOMICS, estimateAmmCreatorFeeBps, lamportsToSol, type ExecutionNetwork } from '@solcoin/shared';
import type { Env } from './config/env.js';
import { openDatabase, type Db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { EventBus } from './core/events.js';
import { componentLogger } from './core/logger.js';
import { AppError, safeErrorText } from './core/errors.js';
import { systemClock, type Clock } from './core/clock.js';
import { AuditLog } from './security/audit.js';
import { AuthService } from './security/auth.js';
import { SecretStore, SECRET_KEYS } from './security/secrets.js';
import { WalletKeystore } from './security/keystore.js';
import { SolanaRpc, type RpcEndpoint } from './providers/solana/rpc.js';
import { PumpFunLaunchAdapter } from './providers/solana/pumpfun-adapter.js';
import { SimulationLaunchAdapter } from './providers/solana/simulation-adapter.js';
import type { LaunchAdapter } from './providers/solana/launch-adapter.js';
import { ChainedMetadataStorage, PinataIpfsProvider, PumpFunIpfsProvider } from './providers/storage/ipfs.js';
import type { ImageProvider, MarketProvider, Provider, TrendProvider } from './providers/types.js';
import { SettingsService } from './services/settings.service.js';
import { GuardService } from './services/guard.service.js';
import { TrendService } from './services/trend.service.js';
import { ResearchService } from './services/research.service.js';
import { ConceptService, type GeneratedConcept } from './services/concept.service.js';
import { EvaluationService } from './services/evaluation.service.js';
import { PredictionService } from './services/prediction.service.js';
import { QualityGateService } from './services/quality-gate.service.js';
import { ArtworkService } from './services/artwork.service.js';
import { LaunchService, type LaunchOutcome } from './services/launch.service.js';
import { MonitoringService } from './services/monitoring.service.js';
import { FeeService } from './services/fee.service.js';
import { WalletService } from './services/wallet.service.js';
import { PipelineService } from './services/pipeline.service.js';
import { JobScheduler } from './jobs/scheduler.js';

/**
 * Composition root.
 *
 * Everything is constructed once, here, with explicit dependencies. There is no
 * service locator and no ambient singleton: if a service needs the database it
 * is handed the database, which is what makes the whole system testable with a
 * fake clock and an in-memory database.
 *
 * Providers are rebuilt on demand (`refreshProviders`) because credentials can
 * be added from the UI at runtime, and a platform that required a restart to
 * pick up an API key would fail the first-run experience.
 */

export interface AppContainer {
  env: Env;
  db: Db;
  clock: Clock;
  events: EventBus;
  audit: AuditLog;
  auth: AuthService;
  secrets: SecretStore;
  keystore: WalletKeystore;
  settings: SettingsService;
  guard: GuardService;
  trends: TrendService;
  research: ResearchService;
  concepts: ConceptService;
  evaluation: EvaluationService;
  predictions: PredictionService;
  gate: QualityGateService;
  artwork: ArtworkService;
  launches: LaunchService;
  monitoring: MonitoringService;
  fees: FeeService;
  wallet: WalletService;
  pipeline: PipelineService;
  scheduler: JobScheduler;
  analytics: AnalyticsLike;
  learning: LearningLike;
  experiments: ExperimentsLike;
  accounting: AccountingLike;
  notifications: NotificationsLike;
  health: HealthLike;
  backtest: BacktestLike;
  rpc: SolanaRpc | null;
  adapters: Map<string, LaunchAdapter>;
  trendProviders: TrendProvider[];
  marketProviders: MarketProvider[];

  /** Rebuild providers after a credential or settings change. */
  refreshProviders(): Promise<void>;
  /** Launch an already-approved candidate. */
  launchApproved(conceptId: string, actor: { actorId?: string; actorLabel?: string }): Promise<LaunchOutcome>;
  /** Regenerate a fresh concept slate for a trend. */
  regenerateForTrend(trendId: string): Promise<GeneratedConcept[]>;
  /** Apply an operator edit to a candidate, re-running the safety screen. */
  editCandidate(
    conceptId: string,
    edits: { name?: string; symbol?: string; description?: string },
    actor: { id?: string; label?: string; ipAddress?: string },
  ): Promise<{ ok: boolean; blocked?: boolean; reason?: string }>;
  /** Preview whether a fee collection would run right now. */
  feeCollectionPreview(creator: string): Promise<unknown>;
  collectFeesNow(actor: { actorId?: string; actorType?: 'user' | 'system' | 'job' }): Promise<{
    collected: boolean;
    lamports: number;
    signature?: string;
    reason?: string;
  }>;
  refreshToken(mint: string): Promise<{ refreshed: boolean; reason?: string }>;
  diagnostics(): Promise<unknown>;
  shutdown(): Promise<void>;
}

/**
 * Structural types for the services built alongside this file. Declaring the
 * shape the container depends on (rather than importing a concrete class)
 * keeps the composition root compiling independently of their internals.
 */
export interface AnalyticsLike {
  overview(network: string): Promise<unknown>;
  revenueDistribution(options: { sinceMs: number; network?: string }): Promise<unknown>;
  profitAndLoss(options: { sinceMs: number; network?: string }): Promise<unknown>;
  byDimension(dimension: string, options: { sinceMs: number; network?: string }): Promise<unknown[]>;
  timeSeries(metric: string, options: { bucket: string; sinceMs: number; network?: string }): Promise<unknown[]>;
  signalPredictiveness(): Promise<unknown[]>;
  forecast(): Promise<unknown>;
}

export interface LearningLike {
  recordOutcomes(options: { horizonHours: number }): Promise<{ recorded: number }>;
  train(options: { minSamples?: number }): Promise<unknown>;
  evaluate(modelVersion?: string): Promise<unknown>;
  predictionErrors(limit: number): Promise<unknown[]>;
  observedBaseRates(): Promise<unknown>;
  summary(): Promise<unknown>;
}

export interface ExperimentsLike {
  create(input: Record<string, unknown>): Promise<unknown>;
  start(id: string, actor: { id?: string; label?: string }): Promise<void>;
  stop(id: string, conclusion: string, actor: { id?: string; label?: string }): Promise<void>;
  assign(conceptId: string, experimentId?: string): Promise<{ experimentId: string; armId: string; armKey: string; config: unknown } | null>;
  recordOutcome(conceptId: string, value: number, success: boolean): Promise<void>;
  results(experimentId: string): Promise<unknown>;
  banditArms(dimension: string): Promise<unknown[]>;
  updateBanditArm(dimension: string, key: string, success: boolean, reward: number): Promise<void>;
}

export interface AccountingLike {
  recordExpense(input: Record<string, unknown>): Promise<void>;
  ledger(options: Record<string, unknown>): Promise<unknown[]>;
  summary(options: Record<string, unknown>): Promise<unknown>;
  exportCsv(options: Record<string, unknown>): Promise<string>;
  exportJson(options: Record<string, unknown>): Promise<string>;
  monthlyBreakdown(): Promise<unknown[]>;
}

export interface NotificationsLike {
  notify(input: Record<string, unknown>): Promise<{ sent: boolean; reason?: string }>;
  retryFailedDeliveries(): Promise<{ retried: number }>;
  subscribe(): void;
  list(options: Record<string, unknown>): Promise<unknown[]>;
  markRead(id: string): Promise<void>;
  unreadCount(): Promise<number>;
}

export interface HealthLike {
  register(providers: Provider[]): void;
  checkAll(options?: { force?: boolean }): Promise<unknown>;
  recordProviderResult(providerId: string, ok: boolean, latencyMs: number, detail?: string): void;
  history(providerId: string, limit: number): Promise<unknown[]>;
}

export interface BacktestLike {
  replay(options: Record<string, unknown>): Promise<unknown>;
  compareStrategies(strategies: Array<{ name: string; config: Record<string, unknown> }>, options: Record<string, unknown>): Promise<unknown>;
  defaultStrategies(): Array<{ name: string; description: string; config: Record<string, unknown> }>;
  monteCarloProjection(options: Record<string, unknown>): Promise<unknown>;
  sweepThreshold(options: Record<string, unknown>): Promise<unknown[]>;
}

export interface ContainerOptions {
  env: Env;
  clock?: Clock;
  /** Override the database, for tests. */
  db?: Db;
  /** Skip migrations when the caller has already run them. */
  skipMigrations?: boolean;
}

export async function createContainer(options: ContainerOptions): Promise<AppContainer> {
  const log = componentLogger('container');
  const { env } = options;
  const clock = options.clock ?? systemClock;
  const now = () => clock.now();

  const db = options.db ?? openDatabase({ path: env.DATABASE_PATH, verbose: false });
  if (!options.skipMigrations) runMigrations(db);

  const events = new EventBus();
  const audit = new AuditLog(db, now);
  const auth = new AuthService(db, audit, now);
  const secrets = new SecretStore(db, env.SOLCOIN_MASTER_KEY, now);
  const keystore = new WalletKeystore(secrets, now);
  const settings = new SettingsService(db, audit, events, now);
  const guard = new GuardService(db, settings, audit, events, now);

  const getCredential = (key: string) => secrets.get(key);

  // --- Services constructed from the modules built alongside this file -------
  const [
    { AnalyticsService },
    { LearningService },
    { ExperimentService },
    { AccountingService },
    { NotificationService },
    { HealthService },
    { BacktestService },
  ] = await Promise.all([
    import('./services/analytics.service.js'),
    import('./services/learning.service.js'),
    import('./services/experiment.service.js'),
    import('./services/accounting.service.js'),
    import('./services/notification.service.js'),
    import('./services/health.service.js'),
    import('./services/backtest.service.js'),
  ]);

  const predictions = new PredictionService(db, now);
  const analytics = new AnalyticsService(db, now) as unknown as AnalyticsLike;
  const learning = new LearningService(db, predictions, events, now) as unknown as LearningLike;
  const experiments = new ExperimentService(db, audit, now) as unknown as ExperimentsLike;
  const accountingService = new AccountingService(db, now);
  const accounting = accountingService as unknown as AccountingLike;
  const notifications = new NotificationService(db, settings, getCredential, events, now) as unknown as NotificationsLike;
  const health = new HealthService(db, settings, now) as unknown as HealthLike;
  const backtest = new BacktestService(db, predictions, now) as unknown as BacktestLike;

  const trends = new TrendService(db, events, now);
  const research = new ResearchService(db, settings, guard, trends, now);
  const monitoring = new MonitoringService(db, settings, events, now);
  const fees = new FeeService(db, settings, guard, audit, events, now);
  const gate = new QualityGateService(db, settings, now);
  const evaluation = new EvaluationService(db, {} as never, now);

  // Mutable provider state, rebuilt whenever credentials change.
  const state: {
    rpc: SolanaRpc | null;
    adapters: Map<string, LaunchAdapter>;
    trendProviders: TrendProvider[];
    marketProviders: MarketProvider[];
    imageProvider: ImageProvider | null;
    aiRouter: unknown;
  } = {
    rpc: null,
    adapters: new Map(),
    trendProviders: [],
    marketProviders: [],
    imageProvider: null,
    aiRouter: null,
  };

  const storage = new ChainedMetadataStorage([
    new PumpFunIpfsProvider({ getCredential, now }),
    new PinataIpfsProvider({ getCredential, now }),
  ]);

  const concepts = new ConceptService(db, {} as never, events, now);
  const artwork = new ArtworkService(db, concepts, storage, null, accountingService, env.DATA_DIR, now);
  const wallet = new WalletService(db, settings, keystore, guard, audit, events, null, now);
  const launches = new LaunchService(db, settings, guard, audit, events, state.adapters, now);

  const pipeline = new PipelineService({
    db,
    settings,
    guard,
    research,
    trends,
    concepts,
    evaluation,
    predictions,
    gate,
    artwork,
    experiments: experiments as never,
    events,
    marketProviders: state.marketProviders,
    now,
  });

  const scheduler = new JobScheduler({ db, settings, now, tickMs: env.isTest ? 1_000 : 5_000 });

  /**
   * The mint-derivation secret.
   *
   * Deterministic mint addresses are the platform's duplicate-launch defence,
   * and their unpredictability matters: anyone holding this secret could
   * compute a future mint address before it is created. It is generated once
   * and stored encrypted, never in configuration.
   */
  async function mintDerivationSecret(): Promise<string> {
    const key = 'execution.mint_derivation_secret';
    const existing = await secrets.get(key);
    if (existing) return existing;
    if (!secrets.unlocked) {
      // A deterministic fallback tied to the master key would be predictable,
      // so instead the launch path refuses rather than using a weak secret.
      throw new AppError('locked', 'The secret store is locked, so a mint derivation secret cannot be established.');
    }
    const generated = randomBytes(32).toString('base64url');
    await secrets.set(key, generated, 'execution');
    return generated;
  }

  async function refreshProviders(): Promise<void> {
    const config = settings.get();
    const network = config.execution.network;

    // --- RPC -----------------------------------------------------------------
    state.rpc = await buildRpc(network, getCredential);

    // --- Launch adapters -----------------------------------------------------
    state.adapters.clear();
    state.adapters.set('simulation', new SimulationLaunchAdapter({ now }));
    if (state.rpc && network !== 'simulation') {
      try {
        state.adapters.set(
          'pumpfun_sdk',
          new PumpFunLaunchAdapter({
            rpc: state.rpc,
            network,
            mintDerivationSecret: await mintDerivationSecret(),
            now,
          }),
        );
      } catch (e) {
        log.warn({ err: safeErrorText(e, 200) }, 'the on-chain launch adapter could not be constructed');
      }
    }

    // --- Trend and market providers -----------------------------------------
    const built = await buildDataProviders({ getCredential, settings, now, db });
    state.trendProviders = built.trendProviders;
    state.marketProviders.length = 0;
    state.marketProviders.push(...built.marketProviders);
    state.imageProvider = built.imageProvider;
    state.aiRouter = built.aiRouter;

    // Rebind the services that hold provider references directly.
    (concepts as unknown as { ai: unknown }).ai = built.aiRouter;
    (evaluation as unknown as { ai: unknown }).ai = built.aiRouter;
    (artwork as unknown as { imageProvider: ImageProvider | null }).imageProvider = built.imageProvider;
    (wallet as unknown as { rpc: SolanaRpc | null }).rpc = state.rpc;

    health.register([...built.trendProviders, ...built.marketProviders, ...built.aiProviders, storage]);

    log.info(
      {
        network,
        rpcEndpoints: state.rpc ? 1 : 0,
        trendProviders: state.trendProviders.length,
        marketProviders: state.marketProviders.length,
        adapters: [...state.adapters.keys()],
      },
      'providers refreshed',
    );
  }

  await refreshProviders();
  gate.ensureDefaultArms();
  notifications.subscribe();

  const container: AppContainer = {
    env,
    db,
    clock,
    events,
    audit,
    auth,
    secrets,
    keystore,
    settings,
    guard,
    trends,
    research,
    concepts,
    evaluation,
    predictions,
    gate,
    artwork,
    launches,
    monitoring,
    fees,
    wallet,
    pipeline,
    scheduler,
    analytics,
    learning,
    experiments,
    accounting,
    notifications,
    health,
    backtest,
    get rpc() {
      return state.rpc;
    },
    adapters: state.adapters,
    get trendProviders() {
      return state.trendProviders;
    },
    get marketProviders() {
      return state.marketProviders;
    },

    refreshProviders,

    async launchApproved(conceptId, actor) {
      const concept = await concepts.getById(conceptId);
      if (!concept) throw new AppError('not_found', 'No such candidate.');
      const network = settings.get().execution.network;
      const balance = (await wallet.summary()).balanceLamports;

      concepts.setStatus(conceptId, 'launching');

      const outcome = await launches.launch(
        {
          conceptId,
          predictionId: undefined,
          name: String(concept.name),
          symbol: String(concept.symbol),
          description: String(concept.description ?? ''),
          metadataUri: String(concept.metadata_uri ?? ''),
          imageUri: (concept.image_uri as string) ?? undefined,
          approvalMode: actor.actorId ? 'manual' : 'autonomous',
          initiatedBy: actor.actorId,
          actorLabel: actor.actorLabel,
        },
        wallet.signerFor(network),
        { walletBalanceLamports: balance },
      );

      if (outcome.status === 'confirmed' && outcome.mintAddress) {
        concepts.setStatus(conceptId, 'launched');
        monitoring.registerToken({
          mint: outcome.mintAddress,
          launchId: outcome.launchId,
          conceptId,
          trendId: (concept.trend_id as string) ?? null,
          network,
          name: String(concept.name),
          symbol: String(concept.symbol),
          metadataUri: (concept.metadata_uri as string) ?? null,
          imageUri: (concept.image_uri as string) ?? null,
          creatorAddress: (await keystore.getPublicKey()) ?? 'simulated',
          createdOnChainAt: now(),
        });
        await accounting
          .recordExpense({
            kind: 'launch_sol',
            description: `Launch of ${String(concept.symbol)}`,
            amountLamports: outcome.costLamports ?? 0,
            refType: 'launch',
            refId: outcome.launchId,
            incurredAt: now(),
          })
          .catch(() => undefined);
      } else {
        concepts.setStatus(conceptId, outcome.status === 'blocked' ? 'approved' : 'failed', {
          reason: outcome.errorCode,
          detail: outcome.error,
        });
      }

      return outcome;
    },

    async regenerateForTrend(trendId) {
      const trend = await trends.getById(trendId);
      if (!trend) throw new AppError('not_found', 'No such trend.');
      const priorConcepts = await concepts.loadPriorConcepts();
      return concepts.generate({
        trend,
        competitors: [],
        priorConcepts,
        count: settings.get().research.conceptsPerOpportunity,
      });
    },

    async editCandidate(conceptId, edits, actor) {
      const { screenRisk } = await import('@solcoin/shared');
      const concept = await concepts.getById(conceptId);
      if (!concept) throw new AppError('not_found', 'No such candidate.');

      const name = edits.name ?? String(concept.name);
      const symbol = (edits.symbol ?? String(concept.symbol)).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const description = edits.description ?? String(concept.description ?? '');

      // An operator edit re-enters the same safety screen. Allowing a human to
      // hand-edit around a block would defeat the control entirely.
      const risk = screenRisk(name, symbol, description);
      if (risk.blocked) {
        return {
          ok: false,
          blocked: true,
          reason: `The edit was rejected by safety screening: ${risk.flags.find((f) => f.severity === 'block')?.label}`,
        };
      }

      db.$raw
        .prepare('UPDATE concepts SET name = ?, symbol = ?, description = ?, updated_at = ? WHERE id = ?')
        .run(name, symbol, description, now(), conceptId);

      audit.record({
        actorType: 'user',
        actorId: actor.id ?? null,
        actorLabel: actor.label ?? null,
        action: 'concept.edited',
        targetType: 'concept',
        targetId: conceptId,
        parameters: { name, symbol },
        ipAddress: actor.ipAddress ?? null,
      });

      return { ok: true };
    },

    async feeCollectionPreview(creator) {
      const network = settings.get().execution.network;
      const adapter = state.adapters.get(network === 'simulation' ? 'simulation' : 'pumpfun_sdk');
      if (!adapter) return { shouldCollect: false, reason: 'No execution adapter is available.' };
      const snapshot = await fees.snapshotAccruals(adapter, creator);
      return fees.decideCollection(snapshot, fees.lastCollectionAt(creator));
    },

    async collectFeesNow(actor) {
      const network = settings.get().execution.network;
      const adapter = state.adapters.get(network === 'simulation' ? 'simulation' : 'pumpfun_sdk');
      if (!adapter) return { collected: false, lamports: 0, reason: 'No execution adapter is available.' };
      const creator = await keystore.getPublicKey();
      if (!creator) return { collected: false, lamports: 0, reason: 'No operating wallet is configured.' };
      return fees.collect(adapter, creator, wallet.signerFor(network), actor);
    },

    async refreshToken(mint) {
      if (state.marketProviders.length === 0) {
        return { refreshed: false, reason: 'No market data provider is configured.' };
      }
      const result = await monitoring.pollBatch([mint], state.marketProviders);
      return { refreshed: result.updated > 0, reason: result.updated > 0 ? undefined : 'No provider had data for this mint.' };
    },

    async diagnostics() {
      const config = settings.get();
      const walletSummary = await wallet.summary();
      const adapterReadiness = await Promise.all(
        [...state.adapters.entries()].map(async ([id, adapter]) => ({ id, ...(await adapter.ready()) })),
      );
      return {
        checkedAt: now(),
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
          uptimeSeconds: Math.round(process.uptime()),
          databasePath: env.DATABASE_PATH,
        },
        secretStore: { unlocked: secrets.unlocked, secretCount: (await secrets.list()).length },
        wallet: {
          configured: Boolean(walletSummary.address),
          canSign: walletSummary.canSign,
          custody: walletSummary.custody,
          balanceSol: walletSummary.balanceSol,
          belowFloor: walletSummary.belowFloor,
        },
        execution: {
          network: config.execution.network,
          phase: config.execution.phase,
          adapters: adapterReadiness,
          rpc: state.rpc ? await state.rpc.health() : [],
        },
        providers: {
          trend: state.trendProviders.map((p) => p.id),
          market: state.marketProviders.map((p) => p.id),
          ai: state.aiRouter ? 'configured' : 'unconfigured',
          image: state.imageProvider ? state.imageProvider.id : 'none (procedural artwork will be used)',
        },
        model: { version: predictions.getBundle().version, trainedOn: predictions.getBundle().trainedOn },
        economics: {
          ...DEFAULT_ECONOMICS,
          ammCreatorFeeBpsAtTypicalGraduation: estimateAmmCreatorFeeBps(1_500),
        },
        auditChain: audit.verifyChain({ limit: 5_000 }),
      };
    },

    async shutdown() {
      await scheduler.stop();
    },
  };

  return container;
}

/**
 * Build the RPC pool.
 *
 * Public endpoints are always included as a last resort: a platform that stops
 * working because one provider is down is worse than one that runs slowly.
 */
async function buildRpc(
  network: ExecutionNetwork,
  getCredential: (key: string) => Promise<string | null>,
): Promise<SolanaRpc | null> {
  if (network === 'simulation') return null;

  const endpoints: RpcEndpoint[] = [];
  const heliusKey = await getCredential(SECRET_KEYS.heliusApiKey);
  const custom = await getCredential(network === 'devnet' ? SECRET_KEYS.rpcUrlDevnet : SECRET_KEYS.rpcUrlMainnet);

  if (custom) endpoints.push({ url: custom, label: 'Configured RPC', priority: 0 });
  if (heliusKey) {
    endpoints.push({
      url: `https://${network === 'devnet' ? 'devnet' : 'mainnet'}.helius-rpc.com/?api-key=${heliusKey}`,
      label: 'Helius',
      priority: 1,
    });
  }

  if (network === 'devnet') {
    endpoints.push({ url: 'https://api.devnet.solana.com', label: 'Solana devnet (public)', priority: 5 });
  } else {
    endpoints.push({ url: 'https://api.mainnet-beta.solana.com', label: 'Solana mainnet (public)', priority: 5 });
    endpoints.push({ url: 'https://solana-rpc.publicnode.com', label: 'PublicNode', priority: 6 });
  }

  return new SolanaRpc({ endpoints, commitment: 'confirmed' });
}

/** Construct every data provider that has what it needs to run. */
async function buildDataProviders(deps: {
  getCredential: (key: string) => Promise<string | null>;
  settings: SettingsService;
  now: () => number;
  db: Db;
}): Promise<{
  trendProviders: TrendProvider[];
  marketProviders: MarketProvider[];
  aiProviders: Provider[];
  imageProvider: ImageProvider | null;
  aiRouter: unknown;
}> {
  const log = componentLogger('providers');
  const trendProviders: TrendProvider[] = [];
  const marketProviders: MarketProvider[] = [];
  const aiProviders: Provider[] = [];
  let imageProvider: ImageProvider | null = null;
  let aiRouter: unknown = null;

  const load = async <T>(name: string, factory: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await factory();
    } catch (e) {
      // A provider that cannot be constructed must not stop the platform
      // booting: the rest of the system degrades around it.
      log.warn({ provider: name, err: safeErrorText(e, 200) }, 'provider could not be constructed');
      return null;
    }
  };

  const modules = await import('./providers/index.js');
  const built = await modules.buildAllProviders(deps);
  void log;
  trendProviders.push(...built.trendProviders);
  marketProviders.push(...built.marketProviders);
  aiProviders.push(...built.aiProviders);
  imageProvider = built.imageProvider;
  aiRouter = built.aiRouter;
  void load;

  return { trendProviders, marketProviders, aiProviders, imageProvider, aiRouter };
}
