import { randomBytes } from 'node:crypto';
import { DEFAULT_ECONOMICS, estimateAmmCreatorFeeBps, type ExecutionNetwork } from '@solcoin/shared';
import type { Env } from './config/env.js';
import { openDatabase, type Db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { EventBus } from './core/events.js';
import { componentLogger } from './core/logger.js';
import { AppError, errorCode, safeErrorText } from './core/errors.js';
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
  /**
   * Do the work a confirmed launch requires beyond its own row: mark the
   * concept launched, register the token for monitoring, record the cost.
   * The launch path calls it directly; recovery calls it for a launch that
   * confirmed while nobody was watching. Safe to call more than once.
   */
  finaliseConfirmedLaunch(input: {
    conceptId: string;
    launchId: string;
    mint: string;
    network: string;
    costLamports: number;
    createdOnChainAt: number;
  }): Promise<void>;
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
  /** Channels that would actually carry a message right now. */
  dispatchableChannels(): Promise<string[]>;
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

  /**
   * Everything a confirmed launch needs beyond its own row.
   *
   * Marking a launch confirmed is not the end of it: the concept has to move
   * to `launched`, the token has to be registered so the monitor starts
   * polling it, and the SOL it cost has to be recorded. Miss that and a real
   * token exists on chain that the platform has forgotten about — no market
   * observations, no fee detection, no learning sample.
   *
   * Both the launch path and the crash-recovery path go through here, because
   * a launch that had to be recovered is exactly the one most likely to be
   * left half-finished. It is safe to call twice: registering a token is
   * `ON CONFLICT DO NOTHING`, and the expense is skipped when one already
   * refers to this launch.
   */
  async function finaliseConfirmedLaunch(input: {
    conceptId: string;
    launchId: string;
    mint: string;
    network: string;
    costLamports: number;
    createdOnChainAt: number;
  }): Promise<void> {
    const concept = await concepts.getById(input.conceptId);
    concepts.setStatus(input.conceptId, 'launched');

    monitoring.registerToken({
      mint: input.mint,
      launchId: input.launchId,
      conceptId: input.conceptId,
      trendId: (concept?.trend_id as string) ?? null,
      network: input.network,
      name: String(concept?.name ?? ''),
      symbol: String(concept?.symbol ?? ''),
      metadataUri: (concept?.metadata_uri as string) ?? null,
      imageUri: (concept?.image_uri as string) ?? null,
      creatorAddress: (await keystore.getPublicKey()) ?? 'simulated',
      createdOnChainAt: input.createdOnChainAt,
    });

    const alreadyRecorded = db.$raw
      .prepare(`SELECT 1 FROM expenses WHERE ref_type = 'launch' AND ref_id = ? LIMIT 1`)
      .get(input.launchId);
    if (!alreadyRecorded) {
      await accounting
        .recordExpense({
          kind: 'launch_sol',
          description: `Launch of ${String(concept?.symbol ?? input.mint.slice(0, 8))}`,
          amountLamports: input.costLamports,
          refType: 'launch',
          refId: input.launchId,
          incurredAt: input.createdOnChainAt,
        })
        .catch(() => undefined);
    }
  }

  /**
   * Put the simulated world back the way the database says it is.
   *
   * Simulated tokens and fee vaults live only in the adapter's memory, so
   * after a restart the adapter knows nothing while the database still holds
   * every token it launched. This walks that gap: each simulated token is
   * rebuilt from its mint (the destiny is a pure function of it) and its
   * recorded creation time, and each creator's lifetime swept total is read
   * back from the fee ledger so the vaults do not refill with fees the
   * platform already collected.
   *
   * Cheap and idempotent — nothing already known is overwritten — so running
   * it on every refresh costs one indexed read and keeps a long-lived process
   * consistent with the database if rows arrive by another route.
   */
  function rehydrateSimulation(adapter: SimulationLaunchAdapter): void {
    try {
      const tokens = db.$raw
        .prepare(
          `SELECT mint, created_on_chain_at, created_at FROM tokens
            WHERE network = 'simulation' ORDER BY created_at DESC LIMIT 2000`,
        )
        .all() as Array<{ mint: string; created_on_chain_at: number | null; created_at: number }>;
      for (const token of tokens) {
        adapter.ensureToken(token.mint, Number(token.created_on_chain_at ?? token.created_at));
      }

      const swept = db.$raw
        .prepare(
          `SELECT wallet_address AS creator, COALESCE(SUM(lamports), 0) AS total
             FROM creator_fee_events
            WHERE kind = 'collection' AND source = 'simulation' AND wallet_address IS NOT NULL
            GROUP BY wallet_address`,
        )
        .all() as Array<{ creator: string; total: number }>;
      for (const row of swept) adapter.restoreClaimed(row.creator, Number(row.total));

      if (tokens.length > 0 || swept.length > 0) {
        log.info({ tokens: tokens.length, creators: swept.length }, 'simulated state rehydrated from the database');
      }
    } catch (e) {
      // Never fatal: an empty simulated world is recoverable, a server that
      // will not boot is not.
      log.warn({ err: safeErrorText(e, 200) }, 'could not rehydrate the simulated world');
    }
  }

  async function refreshProviders(): Promise<void> {
    const config = settings.get();
    const network = config.execution.network;

    // --- RPC -----------------------------------------------------------------
    state.rpc = await buildRpcForNetwork(network, getCredential);

    // --- Launch adapters -----------------------------------------------------
    /*
     * The simulation adapter survives a refresh; everything else is rebuilt.
     *
     * It holds the only copy of each simulated token's drawn fate and of the
     * simulated fee vaults, and it depends on nothing that a refresh changes —
     * no RPC, no credentials, no network. Replacing it on every credential or
     * settings change (which is what used to happen) silently emptied the
     * simulated world: previously launched tokens became unknown mints, the
     * monitor skipped them, and their vaults reset to nothing.
     */
    const existingSimulation = state.adapters.get('simulation');
    const simulation =
      existingSimulation instanceof SimulationLaunchAdapter ? existingSimulation : new SimulationLaunchAdapter({ now });
    state.adapters.clear();
    state.adapters.set('simulation', simulation);
    rehydrateSimulation(simulation);
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
    finaliseConfirmedLaunch,

    async launchApproved(conceptId, actor) {
      const concept = await concepts.getById(conceptId);
      if (!concept) throw new AppError('not_found', 'No such candidate.');
      const network = settings.get().execution.network;
      const balance = (await wallet.summary()).balanceLamports;

      /*
       * The prediction the pipeline made for this concept, carried onto the
       * launch row.
       *
       * This is what closes the learning loop. `LearningService.recordOutcomes`
       * only considers launches whose `prediction_id` is set — it has nothing
       * to score an outcome against otherwise — so leaving it null meant every
       * confirmed launch was skipped and the model never saw a single real
       * result. The platform would have gone on reporting informed priors
       * forever while appearing to learn.
       */
      const prediction = await predictions.getPrediction(conceptId);
      const predictionId = prediction ? String(prediction.id) : undefined;
      if (!predictionId) {
        log.warn(
          { conceptId },
          'launching a concept with no stored prediction; its outcome cannot become a training sample',
        );
      }

      /*
       * A candidate whose evaluation has expired must not be launched.
       *
       * Expiry is applied by the maintenance job, which runs hourly, while the
       * launch queue runs every two minutes — so for up to an hour a concept
       * can be `approved` and expired at the same time. Checking here rather
       * than relying on the sweep is what stops a stale concept going to
       * mainnet with real funds in that window.
       */
      const expiresAt = concept.expires_at === null || concept.expires_at === undefined ? null : Number(concept.expires_at);
      if (expiresAt !== null && expiresAt <= now()) {
        concepts.setStatus(conceptId, 'expired', {
          reason: 'expired',
          detail: 'The concept expired before it was launched. A trend is only worth a token while it is still moving.',
        });
        return {
          launchId: '',
          status: 'blocked',
          network,
          error: 'This candidate expired before it could be launched. Regenerate from the trend if it is still moving.',
          errorCode: 'conflict',
          simulated: network === 'simulation',
        };
      }

      /*
       * A person retrying a candidate that failed is asking for another
       * attempt, and the failed row still holds the idempotency key that would
       * make one impossible. Retiring it here is what makes the retry the
       * dashboard offers actually do something. Only on the manual path: the
       * scheduler retrying by itself is how one bad configuration becomes a run
       * of paid-for failures.
       */
      if (actor.actorId && String(concept.status) === 'failed') {
        launches.retireFailed(conceptId, network);
      }

      concepts.setStatus(conceptId, 'launching');

      /*
       * `launch()` can throw before it submits anything — no adapter for the
       * network, an adapter that reports itself unready. The status restore
       * below only runs when it *returns*, so a throw used to strand the
       * concept in `launching`: excluded from the launch queue, from stale
       * expiry, and from every launchable status in the UI. A transient
       * provider problem should not cost a candidate permanently.
       */
      let outcome: LaunchOutcome;
      try {
        outcome = await launches.launch(
          {
            conceptId,
            predictionId,
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
      } catch (e) {
        concepts.setStatus(conceptId, 'approved', {
          reason: errorCode(e),
          detail: `Launch setup failed before anything was submitted: ${safeErrorText(e, 200)}`,
        });
        throw e;
      }

      if (outcome.status === 'confirmed' && outcome.mintAddress) {
        await finaliseConfirmedLaunch({
          conceptId,
          launchId: outcome.launchId,
          mint: outcome.mintAddress,
          network,
          costLamports: outcome.costLamports ?? 0,
          createdOnChainAt: now(),
        });
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

      /*
       * The metadata document has to follow the edit.
       *
       * `metadata_uri` points at a JSON document that carries the name, symbol
       * and description as they were when the artwork was produced. The launch
       * puts the edited name on chain and that URI beside it, so leaving the
       * document stale ships a token whose own metadata contradicts it — the
       * dashboard would show one name and every wallet another.
       *
       * If re-publishing fails, the URI is detached rather than left wrong.
       * That takes the candidate out of the launch queue (which requires a
       * metadata URI) until artwork is produced again, which is the honest
       * outcome: a candidate that cannot currently be launched correctly.
       */
      let warning: string | undefined;
      const textChanged =
        name !== String(concept.name) ||
        symbol !== String(concept.symbol) ||
        description !== String(concept.description ?? '');
      if (textChanged && concept.metadata_uri) {
        const republished = await artwork.republishMetadata(conceptId, { name, symbol, description });
        if (!republished.ok) {
          concepts.clearMetadata(conceptId);
          warning = `${republished.reason} The candidate cannot be launched until its artwork and metadata are produced again.`;
          log.warn({ conceptId, reason: republished.reason }, 'could not re-publish metadata after an edit');
        }
      }

      audit.record({
        actorType: 'user',
        actorId: actor.id ?? null,
        actorLabel: actor.label ?? null,
        action: 'concept.edited',
        targetType: 'concept',
        targetId: conceptId,
        parameters: { name, symbol, metadataRepublished: textChanged && Boolean(concept.metadata_uri) && !warning },
        ipAddress: actor.ipAddress ?? null,
      });

      return warning ? { ok: true, reason: warning } : { ok: true };
    },

    async feeCollectionPreview(creator) {
      const network = settings.get().execution.network;
      const adapter = state.adapters.get(network === 'simulation' ? 'simulation' : 'pumpfun_sdk');
      if (!adapter) return { shouldCollect: false, reason: 'No execution adapter is available.' };
      const snapshot = await fees.snapshotAccruals(adapter, creator);
      return fees.decideCollection(snapshot, fees.collectionTiming(creator));
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
/**
 * Build an RPC for a specific network, independently of the selected one.
 *
 * Exported because the mainnet preflight has to ask mainnet about the wallet,
 * and it runs while the platform is still on simulation or devnet — asking the
 * currently-selected chain would let a simulated balance clear a mainnet gate.
 */
export async function buildRpcForNetwork(
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
