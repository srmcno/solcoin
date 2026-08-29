import { createHash, randomBytes } from 'node:crypto';
import { UNTRUSTED_DATA_PREAMBLE, detectInjection, wrapUntrusted } from '@solcoin/shared';
import { systemClock, type Clock } from '../../core/clock.js';
import { AppError, safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import type {
  AiCompletionRequest,
  AiCompletionResponse,
  AiProvider,
  AiTier,
  ProviderStatus,
} from '../types.js';

/**
 * Model routing and cost control.
 *
 * Every AI call in the platform goes through here, and it is the only place
 * that decides which model runs, whether the platform can afford it, and
 * whether the answer is usable. Four controls, in the order they apply:
 *
 *  1. **Routing** — a tier ('triage' | 'generation' | 'decision') is mapped to a
 *     model through operator settings, then to whichever configured provider
 *     serves it. A missing or broken provider falls back to another that serves
 *     the same tier rather than failing the job.
 *  2. **Cache** — identical (provider, model, system, messages, schema) calls are
 *     answered from cache. Hits are still recorded, at zero cost, so spend
 *     dashboards show the call happened and how much caching saved.
 *  3. **Budget** — a pre-flight cost estimate is put to `canSpend` before a
 *     single token is spent. This is a hard safety control, not a hint: an
 *     autonomous system with a malfunctioning loop must run out of permission
 *     before it runs out of money, and permission is the cheaper thing to lose.
 *  4. **Concurrency** — a semaphore caps in-flight requests, because provider
 *     rate limits are per-organisation and a fan-out job can otherwise turn the
 *     whole scheduler into a queue of 429s.
 *
 * Schema validation sits on top: a caller-supplied validator that fails gets
 * exactly one corrective retry, then a hard `ai_invalid_response`. One retry,
 * because a model that has misread a schema twice will usually misread it a
 * third time, and each attempt costs real money.
 */

export interface AiRouterSettings {
  triageModel: string;
  generationModel: string;
  decisionModel: string;
  /** Hard ceiling on output tokens for any single request. */
  maxOutputTokens: number;
  cacheTtlMinutes: number;
  maxConcurrentRequests: number;
}

export interface AiUsageRecord {
  provider: string;
  model: string;
  tier: AiTier;
  purpose: string;
  refType?: string;
  refId?: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  /** True when the response came from the router cache and cost nothing. */
  cacheHit: boolean;
  /** Corrective retries spent getting a schema-valid answer. */
  schemaRetries: number;
  ok: boolean;
  error?: string;
  at: number;
}

export interface AiResponseCache {
  get(key: string): Promise<AiCompletionResponse | null>;
  set(key: string, value: AiCompletionResponse, ttlMs: number): Promise<void>;
}

export type SchemaValidator = (parsed: unknown) => { ok: true; value: unknown } | { ok: false; error: string };

export interface AiRouterRequest extends Omit<AiCompletionRequest, 'model' | 'maxOutputTokens'> {
  tier: AiTier;
  /** Clamped to the settings ceiling; defaults to it when omitted. */
  maxOutputTokens?: number;
  /**
   * Optional structural check on `parsed`. A failure buys one corrective retry
   * that quotes the error back to the model.
   */
  validate?: SchemaValidator;
  /**
   * Force caching on or off. The default is derived from `temperature`: a call
   * asking for varied output should not be answered from cache, or every rerun
   * of a concept batch returns the identical batch.
   */
  cache?: boolean;
}

export interface AiRouterResponse extends AiCompletionResponse {
  tier: AiTier;
  cacheHit: boolean;
  schemaRetries: number;
}

export interface AiRouterDeps {
  providers: readonly AiProvider[];
  settings: () => AiRouterSettings;
  /**
   * Budget gate. Returning `{allowed:false}` must stop the call — this is the
   * platform's only defence against an unbounded spend loop.
   */
  canSpend: (
    usdEstimate: number,
    context: { tier: AiTier; model: string; purpose: string },
  ) => Promise<{ allowed: boolean; reason?: string }>;
  recordUsage: (record: AiUsageRecord) => Promise<void>;
  cache?: AiResponseCache;
  clock?: Clock;
  /** How long a provider health result is reused for routing decisions. */
  healthTtlMs?: number;
}

/**
 * Cost floor for a provider that reports no prices at all.
 *
 * Deliberately expensive: an unpriced provider must not look free to the budget
 * gate, because "free" would let a runaway loop past it indefinitely.
 */
const FALLBACK_PRICE = { inputCostPerMTok: 15, outputCostPerMTok: 60 };

/**
 * Characters per token for the pre-flight estimate.
 *
 * Four is the conventional English approximation and is close enough for a
 * budget gate: the estimate only has to be the right order of magnitude to stop
 * a loop, and the authoritative number is the provider's own reported usage,
 * which is what actually gets recorded.
 */
const CHARS_PER_TOKEN = 4;

const DEFAULT_HEALTH_TTL_MS = 60_000;

/** Above this temperature, caching is off by default — see AiRouterRequest.cache. */
const DETERMINISTIC_TEMPERATURE_CEILING = 0.3;

export class AiRouter {
  private readonly log = componentLogger('ai.router');
  private readonly clock: Clock;
  private readonly semaphore: Semaphore;
  private readonly health = new Map<string, { at: number; status: ProviderStatus }>();

  constructor(private readonly deps: AiRouterDeps) {
    this.clock = deps.clock ?? systemClock;
    this.semaphore = new Semaphore(Math.max(1, deps.settings().maxConcurrentRequests));
  }

  /**
   * Wrap untrusted external text for inclusion in a prompt.
   *
   * Exposed on the router because every caller that builds a prompt already
   * holds one, and routing this through a single place means no service can
   * accidentally paste scraped text into a prompt unfenced.
   */
  buildUntrustedContext(items: Array<{ label: string; content: string }>): {
    text: string;
    nonce: string;
    injectionScore: number;
  } {
    return buildUntrustedContext(items);
  }

  async complete(request: AiRouterRequest): Promise<AiRouterResponse> {
    const settings = this.deps.settings();
    this.semaphore.setLimit(settings.maxConcurrentRequests);

    const preferredModel = modelForTier(request.tier, settings);
    const route = await this.selectRoute(request.tier, preferredModel);

    const maxOutputTokens = Math.max(
      1,
      Math.min(request.maxOutputTokens ?? settings.maxOutputTokens, settings.maxOutputTokens),
    );

    const base: AiCompletionRequest = {
      system: request.system,
      messages: request.messages,
      model: route.model,
      maxOutputTokens,
      temperature: request.temperature,
      responseSchema: request.responseSchema,
      purpose: request.purpose,
      refType: request.refType,
      refId: request.refId,
      signal: request.signal,
    };

    const cacheable =
      request.cache ??
      (request.temperature === undefined || request.temperature <= DETERMINISTIC_TEMPERATURE_CEILING);
    const cacheTtlMs = Math.max(0, settings.cacheTtlMinutes) * 60_000;
    const cacheKey = cacheKeyFor(route.provider.id, base);

    if (cacheable && cacheTtlMs > 0 && this.deps.cache) {
      const hit = await this.deps.cache.get(cacheKey).catch((e: unknown) => {
        this.log.warn({ err: safeErrorText(e, 160) }, 'ai cache read failed; treating as a miss');
        return null;
      });
      if (hit) {
        // Recorded even though it cost nothing: an unrecorded cache hit makes
        // the platform look like it did less work than it did, and hides how
        // much the cache is actually saving.
        await this.record({
          provider: hit.provider,
          model: hit.model,
          tier: request.tier,
          purpose: request.purpose,
          refType: request.refType,
          refId: request.refId,
          promptTokens: hit.promptTokens,
          completionTokens: hit.completionTokens,
          cachedTokens: hit.cachedTokens,
          costUsd: 0,
          latencyMs: 0,
          cacheHit: true,
          schemaRetries: 0,
          ok: true,
          at: this.clock.now(),
        });
        return { ...hit, costUsd: 0, latencyMs: 0, tier: request.tier, cacheHit: true, schemaRetries: 0 };
      }
    }

    const release = await this.semaphore.acquire();
    let schemaRetries = 0;
    try {
      let attempt = base;

      for (let round = 0; round <= 1; round++) {
        await this.assertAffordable(route, attempt, request.tier);

        let response: AiCompletionResponse;
        try {
          response = await route.provider.complete(attempt);
        } catch (e) {
          await this.record({
            provider: route.provider.id,
            model: route.model,
            tier: request.tier,
            purpose: request.purpose,
            refType: request.refType,
            refId: request.refId,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            costUsd: 0,
            latencyMs: 0,
            cacheHit: false,
            schemaRetries,
            ok: false,
            error: safeErrorText(e, 300),
            at: this.clock.now(),
          });
          throw e;
        }

        await this.record({
          provider: response.provider,
          model: response.model,
          tier: request.tier,
          purpose: request.purpose,
          refType: request.refType,
          refId: request.refId,
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
          cachedTokens: response.cachedTokens,
          costUsd: response.costUsd,
          latencyMs: response.latencyMs,
          cacheHit: false,
          schemaRetries,
          ok: true,
          at: this.clock.now(),
        });

        const verdict = request.validate ? request.validate(response.parsed) : ({ ok: true } as const);
        if (verdict.ok) {
          if (cacheable && cacheTtlMs > 0 && this.deps.cache) {
            await this.deps.cache
              .set(cacheKey, response, cacheTtlMs)
              .catch((e: unknown) => this.log.warn({ err: safeErrorText(e, 160) }, 'ai cache write failed'));
          }
          return { ...response, tier: request.tier, cacheHit: false, schemaRetries };
        }

        if (round === 1) break;

        // One corrective round. The model is shown its own output and the
        // validator's complaint; the complaint is platform-authored, so it is
        // safe to quote verbatim.
        schemaRetries++;
        this.log.warn(
          { provider: route.provider.id, model: route.model, purpose: request.purpose, error: verdict.error },
          'model response failed schema validation; retrying once with a correction',
        );
        attempt = {
          ...base,
          messages: [
            ...base.messages,
            { role: 'assistant', content: previousTurnText(response) },
            {
              role: 'user',
              content:
                `Your previous response failed validation with: ${verdict.error}\n` +
                'Return a corrected response that satisfies the required schema exactly. ' +
                'Do not explain the correction and do not include any text outside the structured result.',
            },
          ],
        };
      }

      throw new AppError(
        'ai_invalid_response',
        `${route.provider.label} (${route.model}) did not produce a schema-valid response for "${request.purpose}" after one corrective retry.`,
        { details: { provider: route.provider.id, model: route.model, purpose: request.purpose } },
      );
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /**
   * Pick the provider that serves the tier's model, or the closest substitute.
   *
   * A provider is skipped when it has no credentials or its circuit is open —
   * both are states where calling it is guaranteed to waste time, and both are
   * exactly why a second vendor is configured in the first place.
   */
  private async selectRoute(
    tier: AiTier,
    preferredModel: string,
  ): Promise<{ provider: AiProvider; model: string; price: { inputCostPerMTok: number; outputCostPerMTok: number } }> {
    interface Candidate {
      provider: AiProvider;
      model: string;
      price: { inputCostPerMTok: number; outputCostPerMTok: number };
      /** 0 = serves the exact configured model; 1 = serves an equivalent tier. */
      rank: number;
    }

    const candidates: Candidate[] = [];
    for (const provider of this.deps.providers) {
      if (provider.kind !== 'ai') continue;
      const models = safeModels(provider);
      const exact = models.find((m) => m.id === preferredModel);
      if (exact) {
        candidates.push({ provider, model: exact.id, price: exact, rank: 0 });
        continue;
      }
      const equivalent = models.find((m) => m.tier === tier);
      if (equivalent) candidates.push({ provider, model: equivalent.id, price: equivalent, rank: 1 });
    }
    candidates.sort((a, b) => a.rank - b.rank);

    const skipped: string[] = [];
    for (const candidate of candidates) {
      const usable = await this.isUsable(candidate.provider);
      if (usable.ok) {
        if (candidate.rank > 0) {
          this.log.warn(
            { tier, preferredModel, provider: candidate.provider.id, model: candidate.model },
            'configured model unavailable; routing to an equivalent-tier substitute',
          );
        }
        return { provider: candidate.provider, model: candidate.model, price: candidate.price };
      }
      skipped.push(`${candidate.provider.label}: ${usable.reason}`);
    }

    const hints = await this.setupHints();
    throw new AppError(
      'not_configured',
      `No AI provider is available for the ${tier} tier (model "${preferredModel}"). ` +
        (hints.length ? `Configure one of: ${hints.join(' ')}` : 'No AI providers are registered.') +
        (skipped.length ? ` Skipped — ${skipped.join('; ')}.` : ''),
      { details: { tier, preferredModel, skipped } },
    );
  }

  private async isUsable(provider: AiProvider): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Duck-typed: `circuitOpen` is not on the AiProvider contract, but every
    // adapter built on HttpClient exposes it, and skipping a provider whose
    // breaker is open saves the caller a guaranteed-failing round trip.
    const breaker = (provider as { circuitOpen?: unknown }).circuitOpen;
    if (breaker === true) return { ok: false, reason: 'circuit breaker open' };

    const status = await this.cachedHealth(provider);
    if (status.state === 'unconfigured') return { ok: false, reason: 'no credentials configured' };
    return { ok: true };
  }

  private async cachedHealth(provider: AiProvider): Promise<ProviderStatus> {
    const ttl = this.deps.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS;
    const cached = this.health.get(provider.id);
    if (cached && this.clock.now() - cached.at < ttl) return cached.status;

    let status: ProviderStatus;
    try {
      status = await provider.healthCheck();
    } catch (e) {
      // A health probe that throws is itself a signal, but not a reason to
      // refuse to route: the completion call may still succeed. Treat it as
      // unknown rather than unconfigured.
      status = {
        id: provider.id,
        label: provider.label,
        kind: 'ai',
        state: 'unknown',
        detail: safeErrorText(e, 160),
        requiresCredentials: true,
      };
    }
    this.health.set(provider.id, { at: this.clock.now(), status });
    return status;
  }

  private async setupHints(): Promise<string[]> {
    const hints: string[] = [];
    for (const provider of this.deps.providers) {
      if (provider.kind !== 'ai') continue;
      const status = await this.cachedHealth(provider);
      if (status.setupHint) hints.push(status.setupHint);
    }
    return hints;
  }

  // -------------------------------------------------------------------------
  // Budget
  // -------------------------------------------------------------------------

  /**
   * Pre-flight spend check.
   *
   * The estimate assumes the response fills `maxOutputTokens`, which is the
   * worst case and the only honest thing to check a ceiling against — checking
   * against an expected-case guess would let a run of long responses walk
   * straight through the limit.
   */
  private async assertAffordable(
    route: { provider: AiProvider; model: string; price: { inputCostPerMTok: number; outputCostPerMTok: number } },
    request: AiCompletionRequest,
    tier: AiTier,
  ): Promise<void> {
    const inputTokens = estimateInputTokens(request);
    const price = route.price.inputCostPerMTok > 0 || route.price.outputCostPerMTok > 0 ? route.price : FALLBACK_PRICE;
    const usdEstimate =
      (inputTokens * price.inputCostPerMTok + request.maxOutputTokens * price.outputCostPerMTok) / 1_000_000;

    const verdict = await this.deps.canSpend(usdEstimate, {
      tier,
      model: route.model,
      purpose: request.purpose,
    });

    if (!verdict.allowed) {
      this.log.warn(
        { tier, model: route.model, purpose: request.purpose, usdEstimate: Number(usdEstimate.toFixed(6)) },
        'AI call refused by the budget control',
      );
      throw new AppError(
        'ai_budget_exceeded',
        `Refused a ${tier}-tier call to ${route.model} for "${request.purpose}": ` +
          (verdict.reason ?? 'the AI spend budget is exhausted.'),
        {
          details: {
            tier,
            model: route.model,
            purpose: request.purpose,
            usdEstimate,
            reason: verdict.reason,
          },
        },
      );
    }
  }

  private async record(record: AiUsageRecord): Promise<void> {
    // Accounting must never take down the call it is accounting for.
    await this.deps.recordUsage(record).catch((e: unknown) => {
      this.log.error({ err: safeErrorText(e, 200), purpose: record.purpose }, 'failed to record AI usage');
    });
  }
}

// ---------------------------------------------------------------------------
// Untrusted context
// ---------------------------------------------------------------------------

/**
 * Fence external content for a prompt, dropping what looks like an attack.
 *
 * Three things happen here, and all three matter:
 *
 *  - a fresh CSPRNG nonce per call, so scraped text cannot forge the closing
 *    delimiter and escape the fence (a fixed nonce would be published in the
 *    source and therefore guessable);
 *  - every item is scored for injection and QUARANTINED items are dropped
 *    entirely rather than fenced, because a fence is a mitigation and dropping
 *    is a prevention;
 *  - the maximum score across all items — including the dropped ones — is
 *    returned, so the record built from this prompt can be flagged even when
 *    the offending text never reached the model.
 */
export function buildUntrustedContext(items: Array<{ label: string; content: string }>): {
  text: string;
  nonce: string;
  injectionScore: number;
} {
  const log = componentLogger('ai.untrusted');
  // 16 bytes of CSPRNG output; hex so it survives wrapUntrusted's
  // alphanumeric-only sanitisation of the nonce intact.
  const nonce = randomBytes(16).toString('hex');

  const blocks: string[] = [];
  let injectionScore = 0;

  for (const item of items ?? []) {
    const content = typeof item?.content === 'string' ? item.content : '';
    if (!content.trim()) continue;

    const detection = detectInjection(content);
    injectionScore = Math.max(injectionScore, detection.score);

    if (detection.quarantine) {
      log.warn(
        {
          label: typeof item?.label === 'string' ? item.label : 'unlabelled',
          score: Number(detection.score.toFixed(3)),
          matches: detection.matches.map((m) => m.label),
        },
        'dropped external content that scored as a prompt-injection attempt',
      );
      continue;
    }

    // wrapUntrusted sanitises the content itself, so the raw string is passed
    // through deliberately: sanitising twice would corrupt the detection score
    // that was just computed over the original text.
    blocks.push(wrapUntrusted(typeof item?.label === 'string' ? item.label : 'external', content, nonce));
  }

  const text = blocks.length > 0 ? [UNTRUSTED_DATA_PREAMBLE, '', ...blocks].join('\n') : '';
  return { text, nonce, injectionScore };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function modelForTier(tier: AiTier, settings: AiRouterSettings): string {
  switch (tier) {
    case 'triage':
      return settings.triageModel;
    case 'generation':
      return settings.generationModel;
    case 'decision':
      return settings.decisionModel;
  }
}

/**
 * Cache identity.
 *
 * Provider and model are in the key because the same prompt gives different
 * answers on different models; temperature and the output ceiling are in it
 * because they change the answer too, and a key that ignored them would serve a
 * short deterministic answer to a request that asked for a long varied one.
 */
function cacheKeyFor(providerId: string, request: AiCompletionRequest): string {
  const material = JSON.stringify({
    provider: providerId,
    model: request.model,
    system: request.system,
    messages: request.messages.map((m) => [m.role, m.content]),
    schema: request.responseSchema ?? null,
    temperature: request.temperature ?? null,
    maxOutputTokens: request.maxOutputTokens,
  });
  return createHash('sha256').update(material).digest('hex');
}

function estimateInputTokens(request: AiCompletionRequest): number {
  let chars = request.system.length;
  for (const message of request.messages) chars += message.content.length;
  if (request.responseSchema) chars += JSON.stringify(request.responseSchema).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** A provider whose `models()` throws must not take down routing. */
function safeModels(provider: AiProvider): ReturnType<AiProvider['models']> {
  try {
    const models = provider.models();
    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
}

/**
 * The assistant turn to echo back before a correction.
 *
 * A structured-output response often has no text at all — the content was a
 * tool call — so the parsed object is re-serialised instead. The string is
 * never allowed to be empty, because an empty assistant turn is rejected by
 * the Messages API.
 */
function previousTurnText(response: AiCompletionResponse): string {
  if (response.text.trim()) return response.text;
  if (response.parsed !== undefined) {
    try {
      return JSON.stringify(response.parsed);
    } catch {
      // Circular or otherwise unserialisable; fall through.
    }
  }
  return '(no usable content was returned)';
}

/** Caps in-flight provider calls. */
class Semaphore {
  private active = 0;
  private limit: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  setLimit(limit: number): void {
    const next = Math.max(1, Math.floor(limit));
    if (next === this.limit) return;
    this.limit = next;
    this.drain();
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }

    // Guarded so a caller that releases twice cannot inflate the limit.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (!next) break;
      this.active++;
      next();
    }
  }
}

