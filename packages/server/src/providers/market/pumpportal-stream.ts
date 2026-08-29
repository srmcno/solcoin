import { sanitiseExternalText } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import type { Provider, ProviderStatus } from '../types.js';

/**
 * PumpPortal real-time stream — launch and graduation detection.
 *
 * This is the platform's only sub-second view of pump.fun. The REST adapter
 * (`pumpfun-api.ts`) can page the launch feed, but at ~2,000 launches/hour a
 * poller either misses coins between ticks or burns its whole quota; the
 * websocket delivers every `create` and every `migrate` as it lands, which is
 * what makes launch-rate and graduation-rate measurement honest rather than
 * sampled.
 *
 *   wss://pumpportal.fun/api/data
 *   {"method":"subscribeNewToken"}   free, no API key
 *   {"method":"subscribeMigration"}  free, no API key
 *
 * THE ONE-CONNECTION RULE
 *
 * PumpPortal's terms are explicit that a client opens exactly ONE websocket and
 * subscribes on it; opening a connection per subscription, or reconnecting in a
 * tight loop, gets the source IP timed out for up to an hour. An hour of
 * blindness during a launch window is the most expensive failure this file can
 * produce, so the connection is a process-wide singleton (`getPumpPortalStream`)
 * guarded by a module-level owner token, reconnects never fire faster than every
 * 5 seconds, and the backoff is exponential with jitter capped at 5 minutes.
 * `status().detail` and `reconnects` expose the count so a reconnect storm is
 * visible on the dashboard rather than silent.
 *
 * COST WARNING — READ BEFORE ENABLING TRADE SUBSCRIPTIONS
 *
 * `subscribeNewToken` and `subscribeMigration` are free. `subscribeTokenTrade`
 * and `subscribeAccountTrade` are NOT: they are metered at 0.01 SOL per 10,000
 * messages, and a single trending coin can push 10,000 fills in a couple of
 * minutes. They are therefore never enabled by default and are only reachable
 * through the explicit `meteredSubscriptions` option, which every caller must
 * opt into deliberately and budget for.
 *
 * Message shapes are NOT contractually stable and are parsed defensively; a
 * malformed message is counted and dropped, never thrown. Verified live
 * 2026-08-29:
 *
 *   ack:       {"message":"Successfully subscribed to token creation events."}
 *   create:    {signature, mint, traderPublicKey, txType:"create", initialBuy,
 *               solAmount, bondingCurveKey, vTokensInBondingCurve,
 *               vSolInBondingCurve, marketCapSol, name, symbol, uri,
 *               is_mayhem_mode, pool:"pump"}
 *   migrate:   {signature, mint, txType:"migrate", pool:"pump-amm"}
 *
 * Two things the docs do not say, both observed: the migration message carries
 * ONLY those four fields (no name, symbol or pool address), and `pool` uses a
 * hyphen there (`pump-amm`) while the create message uses `pump`. Reserve values
 * on the create message are already UI amounts (whole tokens, whole SOL), unlike
 * the REST API's raw base units.
 *
 * `name`, `symbol` and `uri` are written by whoever deployed the coin — the
 * most directly attacker-controlled strings in the whole platform, since minting
 * a coin called "ignore previous instructions" costs a fraction of a SOL and it
 * flows straight into saturation analysis and model prompts. They are sanitised
 * here, at the edge, before any consumer sees them.
 *
 * This class never touches the database. It parses and emits; the service layer
 * decides what to persist.
 */

const DEFAULT_URL = 'wss://pumpportal.fun/api/data';

const SOURCE = 'pumpportal';
const LABEL = 'PumpPortal realtime stream';

/**
 * Hard floor between connection attempts. The provider's stated failure mode is
 * an IP timeout for connection storms, so this is a safety limit, not a tuning
 * knob: nothing in this file may schedule a reconnect sooner.
 */
const MIN_RECONNECT_DELAY_MS = 5_000;
/** Ceiling on backoff. Five minutes of blindness is the worst case we accept. */
const MAX_RECONNECT_DELAY_MS = 300_000;

/**
 * A half-open TCP socket looks identical to a quiet market from userspace. New
 * tokens arrive several times a minute around the clock, so five minutes of
 * total silence is far outside normal and means the socket is dead.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/** How often the heartbeat checks for silence. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Ceiling on a connection that neither opens nor fails.
 *
 * Node's WebSocket has no connect timeout of its own, and a socket stuck in
 * CONNECTING is invisible to the idle heartbeat (which only watches an open
 * connection). Without this, one black-holed TCP handshake ends the stream for
 * the life of the process.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Bounded dispatch queue. Consumers may be async (a DB write, an AI call), and
 * a slow one must degrade into dropped events with a visible counter rather than
 * an unbounded array that eventually takes the process out with it.
 */
const DEFAULT_MAX_QUEUED_EVENTS = 500;

/** Anything larger than this is not a message we understand; drop unparsed. */
const MAX_MESSAGE_BYTES = 64 * 1024;

/** Consecutive failed connections before the stream reports 'down'. */
const DOWN_AFTER_FAILURES = 3;

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface PumpPortalNewTokenEvent {
  signature: string;
  mint: string;
  /** `traderPublicKey`: the wallet that created the coin and made the dev buy. */
  creator: string;
  bondingCurveKey?: string;
  /** `pump` on create messages. */
  pool?: string;
  /** Sanitised. Deployer-controlled. */
  name?: string;
  /** Sanitised. Deployer-controlled. */
  symbol?: string;
  /** Sanitised. Deployer-controlled metadata URI — treat as a claim, not a link. */
  uri?: string;
  /** Tokens the creator bought in the same transaction, UI units. */
  initialBuyTokens?: number;
  /** SOL the creator spent on that buy. A large dev buy is a real risk signal. */
  initialBuySol?: number;
  /** Curve reserves at creation, already in UI units. */
  virtualTokenReserves?: number;
  virtualSolReserves?: number;
  marketCapSol?: number;
  /** When this process received the message, not when the slot landed. */
  receivedAt: number;
}

export interface PumpPortalMigrationEvent {
  signature: string;
  mint: string;
  /** `pump-amm` — note the hyphen, unlike the REST API's `pump_amm`. */
  pool?: string;
  receivedAt: number;
}

/**
 * A metered trade message. Only ever emitted when `meteredSubscriptions` is
 * configured; see the cost warning in the file header.
 */
export interface PumpPortalTradeEvent {
  signature: string;
  mint: string;
  trader: string;
  side: 'buy' | 'sell';
  tokenAmount?: number;
  solAmount?: number;
  marketCapSol?: number;
  pool?: string;
  receivedAt: number;
}

export type Unsubscribe = () => void;

export interface PumpPortalStreamCounters {
  messagesReceived: number;
  newTokenEvents: number;
  migrationEvents: number;
  tradeEvents: number;
  /** Messages that parsed as JSON but matched no known shape. */
  unrecognisedMessages: number;
  /** Messages dropped before parsing (oversized or undecodable). */
  malformedMessages: number;
  /** Events discarded because the dispatch queue was full. */
  droppedEvents: number;
  /** Connection attempts after the first. */
  reconnects: number;
  consecutiveFailures: number;
}

export interface PumpPortalStreamOptions {
  url?: string;
  clock?: Clock;
  /** Silence tolerated before the socket is assumed half-open. Default 5 min. */
  idleTimeoutMs?: number;
  /** Never lowered below the 5s hard floor, whatever is passed. */
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  maxQueuedEvents?: number;
  /**
   * PAID SUBSCRIPTIONS. 0.01 SOL per 10,000 messages, and a hot coin produces
   * that in minutes. Leave unset unless you have deliberately budgeted for it;
   * there is no automatic spend cap on the provider's side.
   */
  meteredSubscriptions?: {
    /** Mints to receive every fill for. */
    tokenTrade?: readonly string[];
    /** Wallets to receive every fill for. */
    accountTrade?: readonly string[];
  };
  /** Socket factory, for tests. Defaults to Node 22's global WebSocket. */
  createSocket?: (url: string) => WebSocket;
}

export interface PumpPortalStream extends Provider {
  readonly kind: 'market';
  /** Opens the connection. Idempotent: calling it twice does not open a second. */
  start(): void;
  /** Closes the connection and cancels any pending reconnect. */
  stop(): void;
  onNewToken(cb: (event: PumpPortalNewTokenEvent) => void | Promise<void>): Unsubscribe;
  onMigration(cb: (event: PumpPortalMigrationEvent) => void | Promise<void>): Unsubscribe;
  /** Only fires when `meteredSubscriptions` is configured. */
  onTrade(cb: (event: PumpPortalTradeEvent) => void | Promise<void>): Unsubscribe;
  status(): ProviderStatus;
  counters(): PumpPortalStreamCounters;
}

// ---------------------------------------------------------------------------
// Process-wide connection ownership
// ---------------------------------------------------------------------------

/**
 * Enforces the one-connection rule across the whole process. A second stream
 * that tries to start while another holds the socket refuses loudly instead of
 * quietly earning the IP a one-hour timeout for both of them.
 */
let connectionOwner: symbol | null = null;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPumpPortalStream(options: PumpPortalStreamOptions = {}): PumpPortalStream {
  const log = componentLogger('provider.pumpportal');
  const clock = options.clock ?? systemClock;
  const url = options.url ?? DEFAULT_URL;
  const idleTimeoutMs = Math.max(HEARTBEAT_INTERVAL_MS, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  const minDelayMs = Math.max(MIN_RECONNECT_DELAY_MS, options.minReconnectDelayMs ?? MIN_RECONNECT_DELAY_MS);
  const maxDelayMs = Math.max(minDelayMs, options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS);
  const maxQueued = Math.max(1, options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS);
  const openSocket = options.createSocket ?? ((target: string) => new WebSocket(target));

  const identity = {
    id: SOURCE,
    label: LABEL,
    kind: 'market' as const,
    // The two subscriptions this stream uses are free and keyless, so it is
    // never 'unconfigured'. Only the metered subscriptions cost anything, and
    // those are opt-in rather than credential-gated.
    requiresCredentials: false,
  };
  const setupHint =
    'No credentials required for new-token and migration events. Trade subscriptions are metered at ' +
    '0.01 SOL per 10,000 messages and must be opted into via meteredSubscriptions.';

  const ownerToken = Symbol('pumpportal-stream');

  const newTokenHandlers = new Set<(e: PumpPortalNewTokenEvent) => void | Promise<void>>();
  const migrationHandlers = new Set<(e: PumpPortalMigrationEvent) => void | Promise<void>>();
  const tradeHandlers = new Set<(e: PumpPortalTradeEvent) => void | Promise<void>>();

  const counters: PumpPortalStreamCounters = {
    messagesReceived: 0,
    newTokenEvents: 0,
    migrationEvents: 0,
    tradeEvents: 0,
    unrecognisedMessages: 0,
    malformedMessages: 0,
    droppedEvents: 0,
    reconnects: 0,
    consecutiveFailures: 0,
  };

  type Phase = 'idle' | 'connecting' | 'open' | 'waiting' | 'blocked';
  let phase: Phase = 'idle';
  let running = false;
  /** Distinguishes "never started" from "deliberately stopped" in status(). */
  let everStarted = false;
  let socket: WebSocket | null = null;
  let attempt = 0;
  let lastMessageAt = 0;
  let connectedAt = 0;
  let lastConnectAttemptAt = 0;
  let lastError: string | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  // -------------------------------------------------------------------------
  // Bounded dispatch
  // -------------------------------------------------------------------------

  type Queued =
    | { kind: 'new_token'; event: PumpPortalNewTokenEvent }
    | { kind: 'migration'; event: PumpPortalMigrationEvent }
    | { kind: 'trade'; event: PumpPortalTradeEvent };

  const queue: Queued[] = [];
  let draining = false;

  function enqueue(item: Queued): void {
    if (queue.length >= maxQueued) {
      // Drop the OLDEST. In a launch stream the newest event is the one with
      // value; a stale create from two minutes ago is already useless.
      queue.shift();
      counters.droppedEvents++;
      if (counters.droppedEvents % 100 === 1) {
        log.warn(
          { dropped: counters.droppedEvents, queueLimit: maxQueued },
          'pumpportal consumer is too slow; dropping events',
        );
      }
    }
    queue.push(item);
    void drain();
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) break;
        await dispatch(item);
      }
    } finally {
      draining = false;
    }
  }

  async function dispatch(item: Queued): Promise<void> {
    const handlers: Iterable<(e: never) => void | Promise<void>> =
      item.kind === 'new_token'
        ? newTokenHandlers
        : item.kind === 'migration'
          ? migrationHandlers
          : tradeHandlers;
    for (const handler of handlers) {
      try {
        // Awaited so a slow consumer applies backpressure into the bounded queue
        // above rather than accumulating unresolved promises.
        await (handler as (e: Queued['event']) => void | Promise<void>)(item.event);
      } catch (e) {
        // One bad consumer must not take down the stream for every other one.
        log.warn({ kind: item.kind, err: safeErrorText(e, 200) }, 'pumpportal consumer threw');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  function subscribe(ws: WebSocket): void {
    send(ws, { method: 'subscribeNewToken' });
    send(ws, { method: 'subscribeMigration' });

    const metered = options.meteredSubscriptions;
    const tokenTrade = metered?.tokenTrade?.filter((k) => MINT_RE.test(k)) ?? [];
    const accountTrade = metered?.accountTrade?.filter((k) => MINT_RE.test(k)) ?? [];
    if (tokenTrade.length > 0 || accountTrade.length > 0) {
      // Loud on purpose: this line is the audit trail for real SOL being spent.
      log.warn(
        { tokenTradeKeys: tokenTrade.length, accountTradeKeys: accountTrade.length },
        'enabling METERED pumpportal trade subscriptions (0.01 SOL / 10k messages)',
      );
      if (tokenTrade.length > 0) send(ws, { method: 'subscribeTokenTrade', keys: tokenTrade });
      if (accountTrade.length > 0) send(ws, { method: 'subscribeAccountTrade', keys: accountTrade });
    }
  }

  function send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      log.warn({ err: safeErrorText(e, 160) }, 'failed to send pumpportal subscription');
    }
  }

  function connect(): void {
    if (!running) return;
    if (socket !== null) return;

    if (connectionOwner !== null && connectionOwner !== ownerToken) {
      // Refusing is strictly better than connecting: two sockets from one IP is
      // exactly the pattern that earns an hour-long ban for both.
      phase = 'blocked';
      lastError = 'another PumpPortalStream in this process already owns the single permitted connection';
      log.error({}, lastError);
      return;
    }
    connectionOwner = ownerToken;

    phase = 'connecting';
    lastConnectAttemptAt = clock.now();
    attempt++;
    if (attempt > 1) counters.reconnects++;

    let ws: WebSocket;
    try {
      ws = openSocket(url);
    } catch (e) {
      lastError = safeErrorText(e, 200);
      counters.consecutiveFailures++;
      scheduleReconnect();
      return;
    }
    socket = ws;

    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (socket === ws && phase !== 'open') {
        failConnection(ws, `connection did not open within ${CONNECT_TIMEOUT_MS / 1000}s`);
      }
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();

    ws.addEventListener('open', () => {
      if (socket !== ws) return;
      clearConnectTimer();
      phase = 'open';
      connectedAt = clock.now();
      lastMessageAt = clock.now();
      counters.consecutiveFailures = 0;
      // The backoff resets only on a *successful* open, so a server that accepts
      // and immediately closes still gets progressively longer waits.
      attempt = 1;
      lastError = undefined;
      log.info({ url, reconnects: counters.reconnects }, 'pumpportal connected');
      subscribe(ws);
    });

    ws.addEventListener('message', (event) => {
      if (socket !== ws) return;
      lastMessageAt = clock.now();
      counters.messagesReceived++;
      handleMessage(event.data);
    });

    ws.addEventListener('error', () => {
      if (socket !== ws) return;
      // The browser-style error event carries no useful detail by design. Once
      // the socket is open a `close` event follows with the real reason, so the
      // teardown is left to that handler; before it opens, nothing follows.
      if (phase === 'open') {
        lastError = 'websocket error';
        return;
      }
      clearConnectTimer();
      failConnection(ws, 'connection failed before open (network error or non-101 status)');
    });

    ws.addEventListener('close', (event) => {
      if (socket !== ws) return;
      socket = null;
      clearConnectTimer();
      if (phase !== 'open') counters.consecutiveFailures++;
      const reason = sanitiseExternalText(String(event.reason ?? ''), 120);
      lastError = `closed (code ${event.code}${reason ? `: ${reason}` : ''})`;
      log.warn({ code: event.code, reason, uptimeMs: connectedAt > 0 ? clock.now() - connectedAt : 0 }, 'pumpportal disconnected');
      connectedAt = 0;
      scheduleReconnect();
    });
  }

  /**
   * Terminal failure of a connection that never opened.
   *
   * Node's WebSocket (undici) emits `error` and then NOTHING for a refused or
   * black-holed connection: no `close` event ever arrives and `readyState`
   * stays CONNECTING forever. Verified live against a closed port. So a pre-open
   * error must drive the teardown itself rather than waiting for a close that is
   * never coming — that omission is what turns a transient DNS blip into a
   * permanently silent stream.
   */
  function failConnection(ws: WebSocket, reason: string): void {
    if (socket !== ws) return;
    lastError = reason;
    counters.consecutiveFailures++;
    hardClose();
    scheduleReconnect();
  }

  /**
   * Exponential backoff with full jitter above a hard 5s floor.
   *
   * The jitter matters even for a single client: without it, a provider-side
   * outage means every deployment of this platform reconnects on the same
   * schedule and hammers the recovery.
   */
  function scheduleReconnect(): void {
    if (!running || reconnectTimer !== null) return;
    phase = 'waiting';

    const ceiling = Math.min(maxDelayMs, minDelayMs * 2 ** Math.max(0, attempt - 1));
    const jittered = minDelayMs + Math.random() * Math.max(0, ceiling - minDelayMs);
    // Also enforce the floor against the last *attempt*, so an immediate close
    // after a successful open cannot produce a faster-than-5s reconnect cycle.
    const sinceLastAttempt = clock.now() - lastConnectAttemptAt;
    const delay = Math.max(jittered, minDelayMs - sinceLastAttempt);

    log.info({ delayMs: Math.round(delay), attempt, reconnects: counters.reconnects }, 'pumpportal reconnect scheduled');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function clearConnectTimer(): void {
    if (connectTimer === null) return;
    clearTimeout(connectTimer);
    connectTimer = null;
  }

  /** Detach and close, so a zombie socket's events can never be acted on. */
  function hardClose(): void {
    clearConnectTimer();
    const ws = socket;
    socket = null;
    if (!ws) return;
    try {
      ws.close(1000, 'client shutdown');
    } catch {
      // Already closing or in a state that refuses close; nothing to do. The
      // reference is dropped either way, and the guards above ignore its events.
    }
  }

  function startHeartbeat(): void {
    if (heartbeatTimer !== null) return;
    heartbeatTimer = setInterval(() => {
      if (!running || phase !== 'open') return;
      const silentFor = clock.now() - lastMessageAt;
      if (silentFor < idleTimeoutMs) return;
      // A half-open socket reports OPEN forever and delivers nothing. The only
      // recovery is to tear it down and reconnect on the normal backoff.
      log.warn({ silentForMs: silentFor, idleTimeoutMs }, 'pumpportal silent past idle timeout; reconnecting');
      lastError = `no message for ${Math.round(silentFor / 1000)}s; assumed half-open`;
      counters.consecutiveFailures++;
      hardClose();
      scheduleReconnect();
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  function handleMessage(data: unknown): void {
    const text = decodeMessage(data);
    if (text === null || text.length > MAX_MESSAGE_BYTES) {
      counters.malformedMessages++;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      counters.malformedMessages++;
      return;
    }
    if (!isRecord(parsed)) {
      counters.malformedMessages++;
      return;
    }

    // Subscription acks and provider-side errors both arrive on this socket.
    if (typeof parsed['message'] === 'string' && parsed['txType'] === undefined) {
      log.debug({ message: sanitiseExternalText(parsed['message'], 200) }, 'pumpportal notice');
      return;
    }
    if (parsed['errors'] !== undefined) {
      lastError = sanitiseExternalText(JSON.stringify(parsed['errors']), 200);
      log.warn({ errors: lastError }, 'pumpportal reported an error');
      return;
    }

    const receivedAt = clock.now();
    const txType = typeof parsed['txType'] === 'string' ? parsed['txType'] : null;

    if (txType === 'create') {
      const event = toNewTokenEvent(parsed, receivedAt);
      if (!event) {
        counters.malformedMessages++;
        return;
      }
      counters.newTokenEvents++;
      enqueue({ kind: 'new_token', event });
      return;
    }

    if (txType === 'migrate') {
      const event = toMigrationEvent(parsed, receivedAt);
      if (!event) {
        counters.malformedMessages++;
        return;
      }
      counters.migrationEvents++;
      enqueue({ kind: 'migration', event });
      return;
    }

    if (txType === 'buy' || txType === 'sell') {
      const event = toTradeEvent(parsed, txType, receivedAt);
      if (!event) {
        counters.malformedMessages++;
        return;
      }
      counters.tradeEvents++;
      enqueue({ kind: 'trade', event });
      return;
    }

    counters.unrecognisedMessages++;
  }

  // -------------------------------------------------------------------------
  // Provider surface
  // -------------------------------------------------------------------------

  function buildStatus(): ProviderStatus {
    const now = clock.now();
    const silentFor = lastMessageAt > 0 ? now - lastMessageAt : undefined;

    let state: ProviderStatus['state'];
    let detail: string;

    if (!running) {
      state = 'unknown';
      detail = everStarted ? 'stopped' : 'not started';
    } else if (phase === 'blocked') {
      state = 'down';
      detail = lastError ?? 'another stream owns the single permitted connection';
    } else if (phase === 'open') {
      // Connected but silent is a real degradation: the heartbeat has not fired
      // yet, but the feed is already not delivering what it should.
      const stale = silentFor !== undefined && silentFor > idleTimeoutMs / 2;
      state = stale ? 'degraded' : 'ok';
      detail =
        `connected ${Math.round((now - connectedAt) / 1000)}s; ` +
        `${counters.newTokenEvents} launches, ${counters.migrationEvents} migrations, ` +
        `${counters.reconnects} reconnects` +
        (stale ? `; no message for ${Math.round((silentFor ?? 0) / 1000)}s` : '') +
        (counters.droppedEvents > 0 ? `; ${counters.droppedEvents} events dropped` : '');
    } else if (counters.consecutiveFailures >= DOWN_AFTER_FAILURES) {
      state = 'down';
      detail = `${counters.consecutiveFailures} consecutive connection failures: ${lastError ?? 'unknown'}`;
    } else {
      state = 'degraded';
      detail = phase === 'connecting' ? 'connecting' : `reconnecting: ${lastError ?? 'disconnected'}`;
    }

    return {
      ...identity,
      state,
      detail,
      setupHint,
      // The last message is the only proof the feed actually works; a socket
      // that connects and says nothing has not succeeded at anything.
      ...(lastMessageAt > 0 ? { lastSuccessAt: lastMessageAt } : {}),
      ...(lastError !== undefined ? { lastFailureAt: lastConnectAttemptAt } : {}),
    };
  }

  return {
    id: SOURCE,
    label: LABEL,
    kind: 'market',

    start(): void {
      if (running) return;
      running = true;
      everStarted = true;
      attempt = 0;
      startHeartbeat();
      connect();
    },

    stop(): void {
      running = false;
      phase = 'idle';
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      hardClose();
      // Release the process-wide slot so a replacement stream can take over.
      if (connectionOwner === ownerToken) connectionOwner = null;
      connectedAt = 0;
    },

    onNewToken(cb): Unsubscribe {
      newTokenHandlers.add(cb);
      return () => newTokenHandlers.delete(cb);
    },

    onMigration(cb): Unsubscribe {
      migrationHandlers.add(cb);
      return () => migrationHandlers.delete(cb);
    },

    onTrade(cb): Unsubscribe {
      tradeHandlers.add(cb);
      return () => tradeHandlers.delete(cb);
    },

    status: buildStatus,

    counters: () => ({ ...counters }),

    // A websocket has no cheap out-of-band probe, and opening a second
    // connection to test the first would violate the one-connection rule. The
    // liveness signal is the stream's own state.
    healthCheck: async (): Promise<ProviderStatus> => buildStatus(),
  };
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let shared: PumpPortalStream | null = null;

/**
 * The connection every consumer should use.
 *
 * Options are read only on first call: once the socket exists, a second caller
 * asking for different options gets the existing stream rather than a second
 * connection, because one connection is the rule this whole file is built
 * around. Tests wanting an isolated instance use `createPumpPortalStream`.
 */
export function getPumpPortalStream(options: PumpPortalStreamOptions = {}): PumpPortalStream {
  return (shared ??= createPumpPortalStream(options));
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function toNewTokenEvent(raw: Record<string, unknown>, receivedAt: number): PumpPortalNewTokenEvent | null {
  const mint = asBase58(raw['mint']);
  const signature = asSignature(raw['signature']);
  const creator = asBase58(raw['traderPublicKey']);
  // Without these three the event cannot be deduplicated, attributed, or acted
  // on, so a message missing any of them is not salvageable.
  if (!mint || !signature || !creator) return null;

  return {
    signature,
    mint,
    creator,
    ...optional('bondingCurveKey', asBase58(raw['bondingCurveKey'])),
    ...optional('pool', sanitiseShort(raw['pool'], 32)),
    // Deployer-controlled free text. Sanitised at the edge so no consumer can
    // forget to do it later.
    ...optional('name', sanitiseShort(raw['name'], 120)),
    ...optional('symbol', sanitiseShort(raw['symbol'], 32)),
    ...optional('uri', sanitiseShort(raw['uri'], 300)),
    // Already UI amounts on this feed, unlike the REST API's raw base units.
    ...optional('initialBuyTokens', positiveNumber(raw['initialBuy'])),
    ...optional('initialBuySol', positiveNumber(raw['solAmount'])),
    ...optional('virtualTokenReserves', positiveNumber(raw['vTokensInBondingCurve'])),
    ...optional('virtualSolReserves', positiveNumber(raw['vSolInBondingCurve'])),
    ...optional('marketCapSol', positiveNumber(raw['marketCapSol'])),
    receivedAt,
  };
}

function toMigrationEvent(raw: Record<string, unknown>, receivedAt: number): PumpPortalMigrationEvent | null {
  const mint = asBase58(raw['mint']);
  const signature = asSignature(raw['signature']);
  if (!mint || !signature) return null;
  // Observed live: migration messages carry nothing else. Do not expect a name,
  // a symbol, or the new pool address here — fetch those from the REST adapter.
  return {
    signature,
    mint,
    ...optional('pool', sanitiseShort(raw['pool'], 32)),
    receivedAt,
  };
}

function toTradeEvent(
  raw: Record<string, unknown>,
  side: 'buy' | 'sell',
  receivedAt: number,
): PumpPortalTradeEvent | null {
  const mint = asBase58(raw['mint']);
  const signature = asSignature(raw['signature']);
  const trader = asBase58(raw['traderPublicKey']);
  if (!mint || !signature || !trader) return null;
  return {
    signature,
    mint,
    trader,
    side,
    ...optional('tokenAmount', positiveNumber(raw['tokenAmount'])),
    ...optional('solAmount', positiveNumber(raw['solAmount'])),
    ...optional('marketCapSol', positiveNumber(raw['marketCapSol'])),
    ...optional('pool', sanitiseShort(raw['pool'], 32)),
    receivedAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The socket may hand back a string or binary frame depending on the peer. */
function decodeMessage(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Base58 address validated by shape. Never sanitised — it is not free text. */
function asBase58(value: unknown): string | null {
  return typeof value === 'string' && MINT_RE.test(value) ? value : null;
}

function asSignature(value: unknown): string | null {
  return typeof value === 'string' && SIGNATURE_RE.test(value) ? value : null;
}

/**
 * Numeric fields are advisory here — a create message with a nonsensical
 * `marketCapSol` should still yield a usable launch event, so a bad number is
 * dropped rather than failing the whole message.
 */
function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function sanitiseShort(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const clean = sanitiseExternalText(value, maxLength);
  return clean.length > 0 ? clean : undefined;
}

function optional<K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}
