import { componentLogger } from './logger.js';

/**
 * Tiny in-process event bus.
 *
 * Deliberately not a message broker: this is a single-node modular monolith and
 * the bus exists to decouple services (a launch confirming should not need to
 * know that notifications, analytics and monitoring all care). Handlers are
 * isolated so one failing subscriber cannot break the emitter.
 */

export interface PlatformEventMap {
  'trend.discovered': { trendId: string; title: string; opportunityScore: number };
  'trend.scored': { trendId: string; opportunityScore: number; previousScore: number };
  'concept.generated': { conceptId: string; trendId: string | null; name: string; symbol: string };
  'concept.rejected': { conceptId: string; reason: string; detail: string };
  'concept.awaiting_approval': { conceptId: string; name: string; symbol: string; expectedValueSol: number };
  'concept.approved': { conceptId: string; approvedBy: string };
  'launch.queued': { launchId: string; conceptId: string };
  'launch.submitted': { launchId: string; signature: string; network: string };
  'launch.confirmed': { launchId: string; mint: string; network: string; signature: string };
  'launch.failed': { launchId: string; error: string; code: string; attempts: number };
  'token.first_trade': { mint: string; atMs: number };
  'token.lifecycle_changed': { mint: string; from: string; to: string };
  'token.graduated': { mint: string; marketCapUsd: number };
  'token.high_volume': { mint: string; volume24hSol: number };
  'fees.accrued': { mint: string; lamports: number; claimableLamports: number };
  'fees.collected': { mint: string; lamports: number; signature: string };
  'wallet.low_balance': { address: string; balanceLamports: number; floorLamports: number };
  'wallet.swept': { from: string; to: string; lamports: number; signature: string };
  'system.emergency_stop': { engaged: boolean; reason: string; actor: string };
  'system.provider_state': { provider: string; state: string; detail: string };
  'model.retrained': { version: string; trainedOn: number; logLoss: number };
}

export type PlatformEventName = keyof PlatformEventMap;

type Handler<K extends PlatformEventName> = (payload: PlatformEventMap[K]) => void | Promise<void>;

export class EventBus {
  private readonly handlers = new Map<PlatformEventName, Set<Handler<PlatformEventName>>>();
  private readonly log = componentLogger('events');

  on<K extends PlatformEventName>(event: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as Handler<PlatformEventName>);
    this.handlers.set(event, set);
    return () => {
      set.delete(handler as Handler<PlatformEventName>);
    };
  }

  /** Fire and forget; handler failures are logged, never propagated. */
  emit<K extends PlatformEventName>(event: K, payload: PlatformEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      void Promise.resolve()
        .then(() => (handler as Handler<K>)(payload))
        .catch((e) => this.log.error({ event, err: e }, 'event handler failed'));
    }
  }

  /** Await all handlers — used in tests and where ordering genuinely matters. */
  async emitAndWait<K extends PlatformEventName>(event: K, payload: PlatformEventMap[K]): Promise<void> {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    const results = await Promise.allSettled([...set].map((h) => (h as Handler<K>)(payload)));
    for (const r of results) {
      if (r.status === 'rejected') this.log.error({ event, err: r.reason }, 'event handler failed');
    }
  }
}
