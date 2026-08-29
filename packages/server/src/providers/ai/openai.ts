import { systemClock, type Clock } from '../../core/clock.js';
import { AppError, safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient, HttpError, type RateLimitConfig } from '../http.js';
import type {
  AiCompletionRequest,
  AiCompletionResponse,
  AiProvider,
  AiTier,
  ImageProvider,
  ProviderStatus,
} from '../types.js';
import { extractJsonObject } from './anthropic.js';

/**
 * OpenAI adapter — the second-vendor option.
 *
 * It exists so the platform is not a single-vendor system. Everything above the
 * `AiProvider` boundary is written against the interface, so an operator whose
 * Anthropic key is rate-limited, revoked, or simply more expensive than their
 * OpenAI one can move tiers across vendors by changing a settings field.
 *
 * Two deliberate differences from the Anthropic adapter:
 *
 *  - **Model ids are configuration, not constants.** OpenAI renames and retires
 *    chat models frequently, and a hardcoded id that no longer exists is a
 *    launch-blocking 404 discovered at the worst moment. The tier→model mapping
 *    comes from `deps.models` (which the platform sources from operator
 *    settings), and the built-in price table below covers only ids this build is
 *    reasonably confident about. Everything else is priced pessimistically.
 *
 *  - **A small parameter-repair path.** The Chat Completions surface has
 *    diverged: reasoning-family models reject `max_tokens` in favour of
 *    `max_completion_tokens`, and reject `temperature` entirely. Rather than
 *    hardcode which is which — a table that would be wrong within months — an
 *    HTTP 400 that names an offending parameter causes exactly one retry with
 *    that parameter removed, and the fact is remembered for the process.
 *
 * Verified against the live API on 2026-08-29: `POST /v1/chat/completions`,
 * `POST /v1/images/generations` and `GET /v1/models` all exist and reject a bad
 * key with HTTP 401 and body
 * `{"error":{"message":...,"type":"invalid_request_error","code":"invalid_api_key"}}`.
 * No key was available, so success shapes are parsed defensively throughout.
 */

const API_BASE = 'https://api.openai.com';
const CREDENTIAL_KEY = 'ai.openai.api_key';
const PROVIDER_ID = 'openai';
const LABEL = 'OpenAI';
const IMAGE_PROVIDER_ID = 'openai_images';

const SETUP_HINT = `Add an OpenAI API key under the secret "${CREDENTIAL_KEY}" (platform.openai.com → API keys).`;

/** Name attached to the strict json_schema response format. */
const SCHEMA_NAME = 'platform_result';

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface OpenAiModelPrice {
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  /**
   * Rate for tokens OpenAI served from its automatic prompt cache. Left
   * undefined when this build does not know the model's discount — in which
   * case cached tokens are billed at the full input rate, which over-states
   * cost rather than under-stating it.
   */
  cachedInputCostPerMTok?: number;
  /** Default tier this model is suited to; overridden by operator settings. */
  tier: AiTier;
}

/**
 * OPENAI LIST PRICES — USD per million tokens.
 *
 * These are OpenAI's published list prices as known to this build. **They must
 * be verified against current OpenAI pricing before any figure derived from
 * them is treated as authoritative.** OpenAI reprices existing models and
 * retires ids on its own schedule, and nothing in this process re-checks them.
 * Every cost this platform reports for an AI call is an ESTIMATE, useful for
 * budget control and spend attribution — not an invoice.
 *
 * Only ids this build is reasonably confident about are listed. Newer families
 * are deliberately absent rather than guessed: an invented price is worse than
 * no price, because it looks authoritative. An operator running a model not
 * listed here should supply its rates through `deps.prices`; until they do, it
 * is charged at `UNKNOWN_MODEL_PRICE` below.
 */
export const OPENAI_LIST_PRICES: Readonly<Record<string, OpenAiModelPrice>> = Object.freeze({
  'gpt-4o': { inputCostPerMTok: 2.5, outputCostPerMTok: 10.0, cachedInputCostPerMTok: 1.25, tier: 'decision' },
  'gpt-4o-mini': { inputCostPerMTok: 0.15, outputCostPerMTok: 0.6, cachedInputCostPerMTok: 0.075, tier: 'triage' },
  'gpt-4.1': { inputCostPerMTok: 2.0, outputCostPerMTok: 8.0, cachedInputCostPerMTok: 0.5, tier: 'decision' },
  'gpt-4.1-mini': { inputCostPerMTok: 0.4, outputCostPerMTok: 1.6, cachedInputCostPerMTok: 0.1, tier: 'generation' },
  'gpt-4.1-nano': { inputCostPerMTok: 0.1, outputCostPerMTok: 0.4, cachedInputCostPerMTok: 0.025, tier: 'triage' },
});

/**
 * Rate charged to a model this build has no price for.
 *
 * Set at the level of OpenAI's most expensive reasoning tier so that an
 * unpriced model can never make a call look cheap. Under-reporting cost
 * silently disables the budget ceiling; over-reporting only makes the platform
 * spend less than it could.
 */
export const UNKNOWN_MODEL_PRICE: OpenAiModelPrice = {
  inputCostPerMTok: 15.0,
  outputCostPerMTok: 60.0,
  tier: 'decision',
};

/**
 * IMAGE LIST PRICES — USD per generated image.
 *
 * Same standing caveat: list prices as known to this build, to be verified
 * against current OpenAI pricing. `gpt-image-1` is billed per token rather than
 * per image, so the figure here is a deliberately high per-image estimate for
 * a 1024x1024 render; it will over-state a low-quality render and is the
 * correct direction to err in for a spend control.
 */
export const OPENAI_IMAGE_PRICES: Readonly<Record<string, number>> = Object.freeze({
  'gpt-image-1': 0.19,
  'dall-e-3': 0.08,
  'dall-e-2': 0.02,
});

/** Charged when the image model is unrecognised. Never zero. */
const UNKNOWN_IMAGE_PRICE_USD = 0.25;

/**
 * Sustained request ceiling.
 *
 * OpenAI's request-per-minute allowance is per-model and scales with the
 * account's usage tier; the lowest paid tier is a few hundred RPM on the small
 * chat models. 250/min sits under that floor so a new key does not start by
 * collecting 429s, and operators on a higher tier can raise it. Burst is kept
 * narrow because the router already caps concurrency.
 */
const DEFAULT_RATE_LIMIT: RateLimitConfig = { requests: 250, intervalMs: 60_000, burst: 15 };

/**
 * Image generation is quota-limited far more tightly than chat — the lowest
 * tier allows single-digit images per minute. Artwork is produced once per
 * launch, so a conservative bucket costs nothing and avoids burning the
 * allowance on retries.
 */
const DEFAULT_IMAGE_RATE_LIMIT: RateLimitConfig = { requests: 5, intervalMs: 60_000, burst: 2 };

const HEALTH_CACHE_TTL_MS = 60_000;

/**
 * Conservative tier defaults.
 *
 * These are ids this build is confident exist and has prices for, chosen so a
 * misconfigured deployment fails safely rather than 404-ing mid-launch. They
 * are NOT a recommendation: an operator should set the models they actually
 * want in AI settings, which is where `deps.models` comes from.
 */
const FALLBACK_TIER_MODELS: Readonly<Record<AiTier, string>> = Object.freeze({
  triage: 'gpt-4o-mini',
  generation: 'gpt-4.1-mini',
  decision: 'gpt-4o',
});

// ---------------------------------------------------------------------------
// Wire types (all optional — parsed defensively)
// ---------------------------------------------------------------------------

interface OpenAiUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
}

interface OpenAiChoice {
  message?: { content?: unknown; refusal?: unknown } | null;
  finish_reason?: unknown;
}

interface OpenAiChatResponse {
  model?: unknown;
  choices?: unknown;
  usage?: OpenAiUsage | null;
}

interface OpenAiImageResponse {
  data?: unknown;
}

/** Request parameters this adapter will drop and retry without, on a 400. */
type RepairableParam = 'max_completion_tokens' | 'temperature' | 'response_format';

// ---------------------------------------------------------------------------
// Chat provider
// ---------------------------------------------------------------------------

export interface OpenAiProviderDeps {
  getCredential: (key: string) => Promise<string | null>;
  clock?: Clock;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  rateLimit?: RateLimitConfig;
  /**
   * Tier → model id, sourced from operator settings. Prefer setting this over
   * relying on the built-in fallbacks: OpenAI's current ids move faster than
   * this file does.
   */
  models?: Partial<Record<AiTier, string>>;
  /** Operator-supplied rates for models missing from the built-in table. */
  prices?: Record<string, OpenAiModelPrice>;
  http?: HttpClient;
}

export interface OpenAiAiProvider extends AiProvider {
  /** Responses where strict json_schema did not yield parsable JSON. */
  readonly schemaFallbacks: number;
  readonly circuitOpen: boolean;
}

export function createOpenAiProvider(deps: OpenAiProviderDeps): OpenAiAiProvider {
  const log = componentLogger('provider.openai');
  const clock = deps.clock ?? systemClock;

  const priceTable: Record<string, OpenAiModelPrice> = { ...OPENAI_LIST_PRICES, ...deps.prices };

  const stats = {
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastError: '',
    lastLatencyMs: 0,
    schemaFallbacks: 0,
  };

  /**
   * Parameters this endpoint has rejected during this process's lifetime.
   * Learned once from a 400 and then respected, so the repair costs at most one
   * wasted request per parameter per process — not one per call.
   */
  const unsupported = new Set<RepairableParam>();

  const http =
    deps.http ??
    new HttpClient({
      name: PROVIDER_ID,
      baseUrl: (deps.baseUrl ?? API_BASE).replace(/\/*$/, '/'),
      timeoutMs: deps.timeoutMs ?? 120_000,
      maxRetries: deps.maxRetries ?? 2,
      rateLimit: deps.rateLimit ?? { ...DEFAULT_RATE_LIMIT },
      clock,
      onResult: (r) => {
        stats.lastLatencyMs = r.latencyMs;
        if (r.ok) {
          stats.lastSuccessAt = clock.now();
          stats.lastError = '';
        } else {
          stats.lastFailureAt = clock.now();
          stats.lastError = r.error ?? 'request failed';
        }
      },
    });

  function tierModel(tier: AiTier): string {
    return deps.models?.[tier] ?? FALLBACK_TIER_MODELS[tier];
  }

  function priceFor(model: string): { price: OpenAiModelPrice; known: boolean } {
    const known = priceTable[model];
    return known ? { price: known, known: true } : { price: UNKNOWN_MODEL_PRICE, known: false };
  }

  async function requireKey(): Promise<string> {
    const key = await deps.getCredential(CREDENTIAL_KEY);
    if (!key) {
      throw new AppError(
        'not_configured',
        `OpenAI is not configured. ${SETUP_HINT} Until then the AI router will use another configured provider if one exists.`,
        { details: { credential: CREDENTIAL_KEY } },
      );
    }
    return key;
  }

  function buildBody(request: AiCompletionRequest, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: [
        // OpenAI carries the system prompt as the first message rather than a
        // separate field. It is always platform-authored.
        { role: 'system', content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };

    if (!unsupported.has('max_completion_tokens')) {
      body.max_completion_tokens = Math.max(1, Math.floor(request.maxOutputTokens));
    } else {
      // The legacy name. Reasoning models reject it and older deployments only
      // accept it, which is why the choice is learned rather than assumed.
      body.max_tokens = Math.max(1, Math.floor(request.maxOutputTokens));
    }

    if (typeof request.temperature === 'number' && !unsupported.has('temperature')) {
      body.temperature = Math.min(2, Math.max(0, request.temperature));
    }

    if (request.responseSchema && !unsupported.has('response_format')) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: SCHEMA_NAME,
          strict: true,
          schema: toStrictSchema(request.responseSchema),
        },
      };
    } else if (request.responseSchema) {
      // Strict schemas are unavailable on this model. Fall back to asking for
      // JSON in the system channel and scraping it out — strictly worse, and
      // recorded as a schema fallback so the degradation is visible.
      body.messages = [
        { role: 'system', content: `${request.system}\n\nRespond with a single JSON object and no other text.` },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ];
    }

    return body;
  }

  async function complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const key = await requireKey();
    const model = request.model || tierModel('generation');
    const { price, known } = priceFor(model);

    if (!known) {
      log.warn(
        { model },
        'unpriced OpenAI model id — cost is charged at the highest known rate, which over-estimates spend',
      );
    }

    const startedAt = clock.now();
    let raw: OpenAiChatResponse;
    try {
      raw = await send(key, request, model);
    } catch (e) {
      const repaired = repairableParam(e);
      if (!repaired) throw describeFailure(e, model);

      // Exactly one repair attempt: remember the rejected parameter and retry
      // without it. A second failure surfaces to the caller.
      unsupported.add(repaired);
      log.warn({ model, param: repaired }, 'OpenAI rejected a request parameter; retrying once without it');
      if (repaired === 'response_format') stats.schemaFallbacks++;
      try {
        raw = await send(key, request, model);
      } catch (e2) {
        throw describeFailure(e2, model);
      }
    }
    const latencyMs = clock.now() - startedAt;

    const choices = Array.isArray(raw?.choices) ? (raw.choices as OpenAiChoice[]) : [];
    const first = choices[0];
    const content = first?.message?.content;
    const text = typeof content === 'string' ? content.trim() : '';
    const refusal = typeof first?.message?.refusal === 'string' ? first.message.refusal : undefined;
    const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason : undefined;

    let parsed: unknown;
    if (request.responseSchema && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // strict json_schema should make this unreachable; it is reachable
        // whenever the schema path was dropped or the model was cut off.
        const scraped = extractJsonObject(text);
        if (scraped !== null) parsed = scraped;
        stats.schemaFallbacks++;
        log.warn(
          { model, purpose: request.purpose, recovered: scraped !== null, finishReason },
          'schema-constrained OpenAI response was not valid JSON; attempted text extraction',
        );
      }
    }

    const usage = raw?.usage ?? {};
    // OpenAI's prompt_tokens INCLUDES cached tokens; Anthropic's does not.
    // Subtracting here keeps the two adapters' cost maths comparable.
    const promptTokens = nonNegativeInt(usage.prompt_tokens);
    const cachedTokens = Math.min(promptTokens, nonNegativeInt(usage.prompt_tokens_details?.cached_tokens));
    const completionTokens = nonNegativeInt(usage.completion_tokens);
    const uncachedPrompt = promptTokens - cachedTokens;

    const cachedRate = price.cachedInputCostPerMTok ?? price.inputCostPerMTok;
    const costUsd =
      (uncachedPrompt * price.inputCostPerMTok +
        cachedTokens * cachedRate +
        completionTokens * price.outputCostPerMTok) /
      1_000_000;

    if (refusal) {
      // Not thrown: the call was billed, and losing the usage to raise an error
      // would corrupt cost accounting. The empty `parsed` makes the router's
      // validation fail cleanly instead.
      log.warn({ model, purpose: request.purpose }, 'OpenAI returned a refusal; surfacing it as the stop reason');
    }

    log.info(
      {
        model,
        purpose: request.purpose,
        refType: request.refType,
        promptTokens,
        cachedTokens,
        completionTokens,
        costUsd: Number(costUsd.toFixed(6)),
        latencyMs,
        finishReason,
        pricedFromListTable: known,
      },
      'openai completion',
    );

    return {
      text,
      parsed,
      model: typeof raw?.model === 'string' ? raw.model : model,
      provider: PROVIDER_ID,
      promptTokens,
      completionTokens,
      cachedTokens,
      costUsd: Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0,
      latencyMs,
      stopReason: refusal ? 'refusal' : finishReason,
    };
  }

  function send(key: string, request: AiCompletionRequest, model: string): Promise<OpenAiChatResponse> {
    return http.request<OpenAiChatResponse>('v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: buildBody(request, model),
      signal: request.signal,
    });
  }

  async function healthCheck(): Promise<ProviderStatus> {
    const base: Omit<ProviderStatus, 'state' | 'detail'> = {
      id: PROVIDER_ID,
      label: LABEL,
      kind: 'ai',
      requiresCredentials: true,
      setupHint: SETUP_HINT,
      lastSuccessAt: stats.lastSuccessAt || undefined,
      lastFailureAt: stats.lastFailureAt || undefined,
      // HttpClient exposes parsed bodies, not headers, so OpenAI's
      // `x-ratelimit-remaining-*` headers are unreachable here. Reporting an
      // invented quota would be worse than reporting none.
      quotaRemaining: undefined,
      quotaResetAt: undefined,
    };

    const key = await deps.getCredential(CREDENTIAL_KEY).catch(() => null);
    if (!key) {
      return { ...base, state: 'unconfigured', detail: 'No OpenAI API key configured.' };
    }

    if (http.circuitOpen) {
      return {
        ...base,
        state: 'down',
        detail: `Circuit breaker open until ${new Date(http.circuitOpenUntilMs).toISOString()} after repeated failures.`,
      };
    }

    const startedAt = clock.now();
    try {
      // Authenticates the key without running inference.
      await http.request<unknown>('v1/models', {
        headers: { authorization: `Bearer ${key}` },
        timeoutMs: 10_000,
        maxRetries: 1,
        cacheTtlMs: HEALTH_CACHE_TTL_MS,
      });
      return {
        ...base,
        state: 'ok',
        detail:
          stats.schemaFallbacks > 0
            ? `Key valid. ${stats.schemaFallbacks} response(s) needed a JSON fallback.`
            : 'Key valid; Chat Completions reachable.',
        latencyMs: clock.now() - startedAt,
        lastSuccessAt: clock.now(),
      };
    } catch (e) {
      const latencyMs = clock.now() - startedAt;
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        return {
          ...base,
          state: 'down',
          detail: `OpenAI rejected the stored API key (HTTP ${e.status}). Replace "${CREDENTIAL_KEY}".`,
          latencyMs,
        };
      }
      return {
        ...base,
        state: e instanceof HttpError && e.status === 429 ? 'degraded' : 'down',
        detail: safeErrorText(e, 200),
        latencyMs,
      };
    }
  }

  return {
    id: PROVIDER_ID,
    label: LABEL,
    kind: 'ai' as const,
    get schemaFallbacks() {
      return stats.schemaFallbacks;
    },
    get circuitOpen() {
      return http.circuitOpen;
    },
    healthCheck,
    complete,
    models() {
      // Every configured tier model, plus the priced catalogue, so the router
      // can resolve either a tier or an explicit id. Configured ids win on tier
      // assignment because that is the operator's stated intent.
      const out = new Map<string, { id: string; inputCostPerMTok: number; outputCostPerMTok: number; tier: AiTier }>();
      for (const [id, price] of Object.entries(priceTable)) {
        out.set(id, {
          id,
          inputCostPerMTok: price.inputCostPerMTok,
          outputCostPerMTok: price.outputCostPerMTok,
          tier: price.tier,
        });
      }
      for (const tier of ['triage', 'generation', 'decision'] as const) {
        const id = tierModel(tier);
        const { price } = priceFor(id);
        out.set(id, {
          id,
          inputCostPerMTok: price.inputCostPerMTok,
          outputCostPerMTok: price.outputCostPerMTok,
          tier,
        });
      }
      return [...out.values()];
    },
  };
}

// ---------------------------------------------------------------------------
// Image provider
// ---------------------------------------------------------------------------

export interface OpenAiImageProviderDeps {
  getCredential: (key: string) => Promise<string | null>;
  clock?: Clock;
  baseUrl?: string;
  timeoutMs?: number;
  rateLimit?: RateLimitConfig;
  /** Image model id, from operator settings. */
  model?: string;
  /** Per-image USD rates for models missing from the built-in table. */
  prices?: Record<string, number>;
  http?: HttpClient;
}

export function createOpenAiImageProvider(deps: OpenAiImageProviderDeps): ImageProvider {
  const log = componentLogger('provider.openai.images');
  const clock = deps.clock ?? systemClock;
  const model = deps.model ?? 'gpt-image-1';
  const priceTable: Record<string, number> = { ...OPENAI_IMAGE_PRICES, ...deps.prices };

  const stats = { lastSuccessAt: 0, lastFailureAt: 0, lastError: '' };

  const http =
    deps.http ??
    new HttpClient({
      name: IMAGE_PROVIDER_ID,
      baseUrl: (deps.baseUrl ?? API_BASE).replace(/\/*$/, '/'),
      // Image renders are slow; a short timeout throws away work already paid for.
      timeoutMs: deps.timeoutMs ?? 180_000,
      maxRetries: 1,
      rateLimit: deps.rateLimit ?? { ...DEFAULT_IMAGE_RATE_LIMIT },
      clock,
      onResult: (r) => {
        if (r.ok) stats.lastSuccessAt = clock.now();
        else {
          stats.lastFailureAt = clock.now();
          stats.lastError = r.error ?? 'image generation failed';
        }
      },
    });

  /**
   * Separate client for retrieving images returned as a URL. It is a different
   * host with a different quota, so it gets its own bucket rather than eating
   * the generation allowance.
   */
  const downloader = new HttpClient({
    name: `${IMAGE_PROVIDER_ID}-download`,
    timeoutMs: 60_000,
    maxRetries: 2,
    rateLimit: { requests: 30, intervalMs: 60_000, burst: 5 },
    clock,
  });

  async function healthCheck(): Promise<ProviderStatus> {
    const key = await deps.getCredential(CREDENTIAL_KEY).catch(() => null);
    const base: Omit<ProviderStatus, 'state' | 'detail'> = {
      id: IMAGE_PROVIDER_ID,
      label: 'OpenAI Images',
      kind: 'ai',
      requiresCredentials: true,
      setupHint: SETUP_HINT,
      lastSuccessAt: stats.lastSuccessAt || undefined,
      lastFailureAt: stats.lastFailureAt || undefined,
    };
    if (!key) {
      return { ...base, state: 'unconfigured', detail: 'No OpenAI API key configured; artwork falls back to procedural rendering.' };
    }
    if (http.circuitOpen) {
      return { ...base, state: 'down', detail: 'Circuit breaker open after repeated image failures.' };
    }
    // A real probe would cost a render, so status reflects recent use. An
    // invented "ok" would be worse than an honest "unknown".
    return {
      ...base,
      state: stats.lastFailureAt > stats.lastSuccessAt ? 'degraded' : stats.lastSuccessAt > 0 ? 'ok' : 'unknown',
      detail:
        stats.lastSuccessAt === 0 && stats.lastFailureAt === 0
          ? `Key present; no image generated yet (model ${model}).`
          : stats.lastFailureAt > stats.lastSuccessAt
            ? stats.lastError
            : `Last render succeeded (model ${model}).`,
    };
  }

  async function generate(request: {
    prompt: string;
    size?: string;
    refType?: string;
    refId?: string;
    signal?: AbortSignal;
  }): Promise<{ data: Buffer; mimeType: string; costUsd: number; model: string }> {
    const key = await deps.getCredential(CREDENTIAL_KEY);
    if (!key) {
      throw new AppError('not_configured', `OpenAI image generation is not configured. ${SETUP_HINT}`, {
        details: { credential: CREDENTIAL_KEY },
      });
    }

    const size = request.size ?? '1024x1024';
    const body: Record<string, unknown> = { model, prompt: request.prompt, n: 1, size };

    // gpt-image-1 always returns base64 and REJECTS response_format; the
    // dall-e models default to a URL unless told otherwise. Asking for base64
    // where it is accepted avoids a second network hop entirely.
    if (model.startsWith('dall-e')) body.response_format = 'b64_json';

    const raw = await http
      .request<OpenAiImageResponse>('v1/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
        signal: request.signal,
      })
      .catch((e: unknown) => {
        throw describeFailure(e, model);
      });

    const items = Array.isArray(raw?.data) ? raw.data : [];
    const first = items[0];
    if (!isRecord(first)) {
      throw new AppError('provider_error', 'OpenAI image generation returned no image data.', {
        details: { model },
      });
    }

    let data: Buffer;
    let mimeType = 'image/png';
    if (typeof first.b64_json === 'string' && first.b64_json.length > 0) {
      data = Buffer.from(first.b64_json, 'base64');
    } else if (typeof first.url === 'string' && /^https:\/\//i.test(first.url)) {
      // Signed, short-lived URLs on OpenAI's CDN. Fetched through HttpClient so
      // the download is timed, retried and rate-limited like everything else.
      data = await downloader.request<Buffer>(first.url, { responseType: 'buffer', signal: request.signal });
      if (/\.jpe?g(\?|$)/i.test(first.url)) mimeType = 'image/jpeg';
      else if (/\.webp(\?|$)/i.test(first.url)) mimeType = 'image/webp';
    } else {
      throw new AppError('provider_error', 'OpenAI image response contained neither b64_json nor a usable https url.', {
        details: { model },
      });
    }

    if (data.length === 0) {
      throw new AppError('provider_error', 'OpenAI image generation returned an empty image.', { details: { model } });
    }

    const costUsd = priceTable[model] ?? UNKNOWN_IMAGE_PRICE_USD;
    log.info(
      { model, size, bytes: data.length, costUsd, refType: request.refType, refId: request.refId },
      'openai image generated',
    );

    return { data, mimeType, costUsd, model };
  }

  return {
    id: IMAGE_PROVIDER_ID,
    label: 'OpenAI Images',
    kind: 'ai' as const,
    healthCheck,
    generate,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * OpenAI's `strict: true` mode requires every object to set
 * `additionalProperties: false` and to list every property in `required`.
 * Schemas written for Anthropic routinely do neither, so they are normalised
 * here rather than rejected — a 400 on schema shape is otherwise indistinguishable
 * from a 400 on model capability.
 */
function toStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return strictify(schema) as Record<string, unknown>;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!isRecord(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === 'properties' && isRecord(value) ? mapValues(value, strictify) : strictify(value);
  }

  if (out.type === 'object' || isRecord(out.properties)) {
    out.type = 'object';
    out.additionalProperties = false;
    const props = isRecord(out.properties) ? Object.keys(out.properties) : [];
    // strict mode has no concept of an optional property: every key must be
    // required. Optionality is expressed by allowing null in the value's type,
    // which is the caller's job — widening `required` here is what keeps the
    // request valid.
    out.required = props;
  }
  return out;
}

function mapValues(obj: Record<string, unknown>, fn: (v: unknown) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v);
  return out;
}

/**
 * Identify a request parameter the API just rejected, so it can be dropped and
 * the call retried once. Matching on the error body is unavoidable — OpenAI
 * returns a generic 400 with the offending parameter named only in prose.
 */
function repairableParam(e: unknown): RepairableParam | null {
  if (!(e instanceof HttpError) || e.status !== 400) return null;
  const body = e.bodyText.toLowerCase();
  if (body.includes('max_completion_tokens') || body.includes('max_tokens')) return 'max_completion_tokens';
  if (body.includes('temperature')) return 'temperature';
  if (body.includes('response_format') || body.includes('json_schema')) return 'response_format';
  return null;
}

function describeFailure(e: unknown, model: string): unknown {
  if (e instanceof HttpError) {
    if (e.status === 401 || e.status === 403) {
      return new AppError('not_configured', `OpenAI rejected the API key (HTTP ${e.status}). ${SETUP_HINT}`, {
        details: { model, status: e.status },
        retryable: false,
        cause: e,
      });
    }
    if (e.status === 429) {
      // 429 covers both rate limiting and an exhausted account balance; the
      // body is the only thing that distinguishes them, and the difference
      // matters because one clears on its own and the other does not.
      const insufficient = /insufficient_quota|exceeded your current quota/i.test(e.bodyText);
      return new AppError(
        insufficient ? 'not_configured' : 'rate_limited',
        insufficient
          ? 'The OpenAI account has no remaining quota. Add credit or switch the AI provider.'
          : `OpenAI rate limit hit for ${model}.`,
        { details: { model, status: e.status }, retryable: !insufficient, cause: e },
      );
    }
  }
  return e;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
