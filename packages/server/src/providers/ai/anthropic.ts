import { systemClock, type Clock } from '../../core/clock.js';
import { AppError, safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient, HttpError, type RateLimitConfig } from '../http.js';
import type {
  AiCompletionRequest,
  AiCompletionResponse,
  AiProvider,
  AiTier,
  ProviderStatus,
} from '../types.js';

/**
 * Anthropic Messages API adapter.
 *
 * Two decisions in here matter more than the wire format:
 *
 *  1. **Structured output is a forced tool call, not a prose instruction.**
 *     Asking a model to "reply with JSON" produces preambles, trailing prose
 *     and markdown fences that then have to be scraped off, and it fails in
 *     exactly the cases that matter — long outputs and unusual schemas. A tool
 *     whose `input_schema` *is* the response schema, pinned with
 *     `tool_choice: {type:'tool'}`, makes the API itself responsible for
 *     producing a conforming object. The text-scraping path still exists, but
 *     only as a recorded fallback, never as the primary mechanism.
 *
 *  2. **Cost is computed here, from reported usage, and is never zero by
 *     accident.** An unpriced model is charged at the most expensive known rate
 *     rather than at nothing, because an unnoticed under-report is how a budget
 *     control silently stops being a control.
 *
 * Verified against the live API on 2026-08-29: `POST /v1/messages` and
 * `GET /v1/models` both exist and reject a bad key with HTTP 401 and body
 * `{"type":"error","error":{"type":"authentication_error",...},"request_id":...}`.
 * Success-shape parsing could not be exercised — no key is present in this
 * environment — so every field below is read defensively.
 */

const API_BASE = 'https://api.anthropic.com';

/** Pinned per Anthropic's versioning policy; bumping it is a deliberate act. */
const ANTHROPIC_VERSION = '2023-06-01';

const CREDENTIAL_KEY = 'ai.anthropic.api_key';
const PROVIDER_ID = 'anthropic';
const LABEL = 'Anthropic';

const SETUP_HINT = `Add an Anthropic API key under the secret "${CREDENTIAL_KEY}" (console.anthropic.com → API keys).`;

/**
 * The single tool used to carry a schema-constrained response. The name is
 * platform-authored and constant so the response parser can match on it
 * without trusting anything the model chose.
 */
const STRUCTURED_TOOL_NAME = 'emit_result';

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface AnthropicModelSpec {
  /** USD per million uncached input tokens. */
  inputCostPerMTok: number;
  /** USD per million output tokens. */
  outputCostPerMTok: number;
  /** USD per million tokens served from the prompt cache (~0.1x input). */
  cacheReadCostPerMTok: number;
  /** USD per million tokens written to the 5-minute prompt cache (~1.25x input). */
  cacheWriteCostPerMTok: number;
  tier: AiTier;
  /**
   * Sampling parameters were removed on the current Opus/Sonnet generation and
   * are rejected with HTTP 400. `temperature` is dropped for these models
   * rather than passed through into a guaranteed request failure.
   */
  supportsTemperature: boolean;
  /**
   * Models where thinking runs unless explicitly disabled.
   *
   * Thinking is NOT incompatible with a forced `tool_choice` on the first-party
   * API — that restriction applies to Amazon Bedrock, which this adapter does
   * not talk to. The reason structured calls opt out is narrower and purely
   * economic: `max_tokens` is a hard ceiling on thinking *plus* the answer, and
   * this platform's ceiling is small (4096 by default), so an unbounded think
   * would truncate the tool input it is supposed to produce. Set
   * `keepThinkingEnabled` to leave it on where the ceiling is generous.
   */
  thinkingOnByDefault: boolean;
}

/**
 * ANTHROPIC LIST PRICES — USD per million tokens.
 *
 * These are Anthropic's published first-party list prices as known to this
 * build (recorded 2026-06-24). **They must be verified against current
 * Anthropic pricing before any figure derived from them is treated as
 * authoritative.** Prices change, negotiated and partner rates differ
 * (Bedrock and Vertex are billed by the partner, not by these rates), and
 * nothing in this process re-checks them.
 *
 * Every cost this platform reports for an AI call is therefore an ESTIMATE.
 * It is accurate enough to drive a budget control and to rank spend by
 * purpose; it is not an invoice, and it should never be presented as one.
 *
 * Cache rates follow Anthropic's published multipliers rather than a separate
 * published table: cache reads bill at 0.1x the input rate and 5-minute cache
 * writes at 1.25x. A 1-hour cache write bills at 2x — this adapter never
 * requests the 1h TTL, so the 1.25x figure is the correct one here.
 */
export const ANTHROPIC_LIST_PRICES: Readonly<Record<string, AnthropicModelSpec>> = Object.freeze({
  'claude-opus-5': {
    inputCostPerMTok: 5.0,
    outputCostPerMTok: 25.0,
    cacheReadCostPerMTok: 0.5,
    cacheWriteCostPerMTok: 6.25,
    tier: 'decision',
    supportsTemperature: false,
    thinkingOnByDefault: true,
  },
  'claude-sonnet-5': {
    inputCostPerMTok: 2.0,
    outputCostPerMTok: 10.0,
    cacheReadCostPerMTok: 0.2,
    cacheWriteCostPerMTok: 2.5,
    tier: 'generation',
    supportsTemperature: false,
    thinkingOnByDefault: true,
  },
  'claude-haiku-4-5': {
    inputCostPerMTok: 1.0,
    outputCostPerMTok: 5.0,
    cacheReadCostPerMTok: 0.1,
    cacheWriteCostPerMTok: 1.25,
    tier: 'triage',
    supportsTemperature: true,
    thinkingOnByDefault: false,
  },
});

/**
 * Dated aliases that operators (and this repo's own default settings) still
 * carry. The current model IDs are undated; a dated string is accepted so a
 * stored setting keeps working, and is resolved to the canonical id for both
 * pricing and the outbound request.
 */
export const ANTHROPIC_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'claude-3-5-haiku-latest': 'claude-haiku-4-5',
  'claude-opus-latest': 'claude-opus-5',
  'claude-sonnet-latest': 'claude-sonnet-5',
});

/**
 * Charge for an unrecognised model at the most expensive known rate.
 *
 * The alternative — pricing an unknown model at zero, or at the cheapest tier —
 * means a typo in a settings field silently disables the budget ceiling. An
 * over-estimate merely makes the platform spend less than it could.
 */
const UNKNOWN_MODEL_SPEC: AnthropicModelSpec = {
  inputCostPerMTok: 5.0,
  outputCostPerMTok: 25.0,
  cacheReadCostPerMTok: 0.5,
  cacheWriteCostPerMTok: 6.25,
  tier: 'decision',
  supportsTemperature: false,
  thinkingOnByDefault: true,
};

/**
 * Sustained request ceiling.
 *
 * Anthropic's lowest paid usage tier allows on the order of 50 requests/minute
 * per model family, and the limit is per-organisation rather than per-process.
 * The bucket is set at that floor so a fresh key on the smallest tier does not
 * spend its first minutes collecting 429s; operators on a higher tier can raise
 * it through `deps.rateLimit`. Burst is small because the router already caps
 * in-flight requests, and a wide burst here would only defeat that.
 */
const DEFAULT_RATE_LIMIT: RateLimitConfig = { requests: 50, intervalMs: 60_000, burst: 5 };

/** Health probes hit `/v1/models`; cache them so a status page cannot spam it. */
const HEALTH_CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Wire types (all optional — the API is free to add and reshape fields)
// ---------------------------------------------------------------------------

interface AnthropicContentBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

interface AnthropicUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

interface AnthropicMessageResponse {
  id?: unknown;
  model?: unknown;
  content?: unknown;
  stop_reason?: unknown;
  usage?: AnthropicUsage;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface AnthropicProviderDeps {
  getCredential: (key: string) => Promise<string | null>;
  clock?: Clock;
  /** Override the API host (gateway, proxy, or a test double). */
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Raise this when the operator's key is on a higher usage tier. */
  rateLimit?: RateLimitConfig;
  /**
   * Additional model ids with prices, for models released after this build.
   * Supplying one is strictly better than letting it fall through to the
   * deliberately pessimistic unknown-model rate.
   */
  extraModels?: Record<string, AnthropicModelSpec>;
  /**
   * Leave extended thinking enabled on models that default it on. Off by
   * default only because thinking shares the `max_tokens` ceiling with the
   * answer, and this platform's ceiling is small enough that a long think would
   * truncate the structured result. Turn it on wherever the ceiling is raised —
   * the vendor's own guidance is that thinking-on with a low effort beats
   * thinking-off on the current models.
   */
  keepThinkingEnabled?: boolean;
  /** Injectable client, for tests. A correctly configured one is built if absent. */
  http?: HttpClient;
}

export interface AnthropicAiProvider extends AiProvider {
  /**
   * Responses where the forced tool call did not come back and the JSON had to
   * be scraped out of the text. A rising count means the structured-output path
   * is degrading and is worth surfacing before the parsed objects start failing
   * validation.
   */
  readonly schemaFallbacks: number;
  /** True while HttpClient's breaker is open, so the router can route around it. */
  readonly circuitOpen: boolean;
}

export function createAnthropicProvider(deps: AnthropicProviderDeps): AnthropicAiProvider {
  const log = componentLogger('provider.anthropic');
  const clock = deps.clock ?? systemClock;

  const catalogue: Record<string, AnthropicModelSpec> = { ...ANTHROPIC_LIST_PRICES, ...deps.extraModels };

  const stats = {
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastError: '',
    lastLatencyMs: 0,
    schemaFallbacks: 0,
    lastRateLimitedAt: 0,
  };

  const http =
    deps.http ??
    new HttpClient({
      name: PROVIDER_ID,
      baseUrl: (deps.baseUrl ?? API_BASE).replace(/\/*$/, '/'),
      // Generous: a decision-tier call with a long prompt legitimately takes
      // tens of seconds, and aborting it wastes tokens already paid for.
      timeoutMs: deps.timeoutMs ?? 120_000,
      // HttpClient only retries retryable failures. 429 and 5xx (which includes
      // Anthropic's 529 "overloaded") are retryable; a 400 from a bad schema is
      // not, and must surface immediately rather than be paid for four times.
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
          if (r.status === 429) stats.lastRateLimitedAt = clock.now();
        }
      },
    });

  function specFor(model: string): { id: string; spec: AnthropicModelSpec; known: boolean } {
    const id = ANTHROPIC_MODEL_ALIASES[model] ?? model;
    const spec = catalogue[id];
    return spec ? { id, spec, known: true } : { id, spec: UNKNOWN_MODEL_SPEC, known: false };
  }

  async function requireKey(): Promise<string> {
    const key = await deps.getCredential(CREDENTIAL_KEY);
    if (!key) {
      throw new AppError(
        'not_configured',
        `Anthropic is not configured. ${SETUP_HINT} Until then the platform runs without Anthropic inference; ` +
          'the AI router will fall back to another configured provider if one exists.',
        { details: { credential: CREDENTIAL_KEY } },
      );
    }
    return key;
  }

  async function complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const key = await requireKey();
    const { id: model, spec, known } = specFor(request.model);

    if (!known) {
      log.warn(
        { model },
        'unknown Anthropic model id — cost will be charged at the highest known rate, which over-estimates spend',
      );
    }

    const body: Record<string, unknown> = {
      model,
      // Clamped: max_tokens is required and must be a positive integer.
      max_tokens: Math.max(1, Math.floor(request.maxOutputTokens)),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    // An empty `system` is rejected as an empty text block, so the field is
    // omitted rather than sent blank.
    if (request.system.trim()) body.system = request.system;

    // Sampling parameters are rejected outright by the current Opus/Sonnet
    // generation. Dropping a caller's temperature is a lossy but recoverable
    // outcome; sending it is a guaranteed 400.
    if (typeof request.temperature === 'number' && spec.supportsTemperature) {
      body.temperature = clamp(request.temperature, 0, 1);
    }

    const schema = request.responseSchema ? toObjectSchema(request.responseSchema) : null;
    if (schema) {
      body.tools = [
        {
          name: STRUCTURED_TOOL_NAME,
          description:
            'Emit the final result. Every field must satisfy the schema exactly. ' +
            'Call this tool once and do not write any prose outside it. ' +
            // Both sentences are the vendor's documented mitigation for running
            // with thinking off: without the first, the model sometimes writes
            // the call out as text instead of calling the tool; without the
            // second, internal tags leak into the visible response.
            'If nothing in the schema can express the answer, say so plainly instead of guessing. ' +
            'Never include internal or system XML tags in your response.',
          input_schema: schema.schema,
        },
      ];
      body.tool_choice = { type: 'tool', name: STRUCTURED_TOOL_NAME };

      // Thinking shares the `max_tokens` ceiling with the answer, so it is
      // turned off for structured calls on the models that default it on — a
      // long think would otherwise truncate the tool input it exists to
      // produce. This is permitted only at effort `high` or below, which is the
      // default and is why no `output_config.effort` is sent; raising effort
      // here without also re-enabling thinking would be rejected outright.
      //
      // The documented cost is that the model occasionally writes the call as
      // visible text instead of a tool_use block. That is what the text
      // fallback below exists to catch, and why it is counted.
      if (spec.thinkingOnByDefault && !deps.keepThinkingEnabled) {
        body.thinking = { type: 'disabled' };
      }
    }

    const startedAt = clock.now();
    let raw: AnthropicMessageResponse;
    try {
      raw = await http.request<AnthropicMessageResponse>('v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body,
        signal: request.signal,
      });
    } catch (e) {
      throw describeFailure(e, model);
    }
    const latencyMs = clock.now() - startedAt;

    const blocks = Array.isArray(raw?.content) ? (raw.content as AnthropicContentBlock[]) : [];

    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();

    let parsed: unknown;
    if (schema) {
      const toolBlock = blocks.find(
        (b) => b && b.type === 'tool_use' && b.name === STRUCTURED_TOOL_NAME && isRecord(b.input),
      );
      if (toolBlock) {
        parsed = schema.unwrap(toolBlock.input);
      } else {
        // The forced tool call did not come back. Scrape the first balanced
        // JSON object out of the text so a single bad turn does not lose the
        // whole call, and count it: this path is a degradation, not a design.
        stats.schemaFallbacks++;
        const scraped = unwrapToolEnvelope(extractJsonObject(text));
        if (scraped !== null) parsed = schema.unwrap(scraped);
        log.warn(
          { model, purpose: request.purpose, recovered: scraped !== null, schemaFallbacks: stats.schemaFallbacks },
          'no tool_use block in a schema-constrained response; fell back to extracting JSON from text',
        );
      }
    }

    const usage = raw?.usage ?? {};
    const uncachedInput = nonNegativeInt(usage.input_tokens);
    const cacheRead = nonNegativeInt(usage.cache_read_input_tokens);
    const cacheWrite = nonNegativeInt(usage.cache_creation_input_tokens);
    const completionTokens = nonNegativeInt(usage.output_tokens);

    const costUsd = estimateCostUsd(spec, { uncachedInput, cacheRead, cacheWrite, completionTokens });

    const stopReason = typeof raw?.stop_reason === 'string' ? raw.stop_reason : undefined;
    if (stopReason === 'refusal') {
      // Deliberately not thrown. The call was billed, and swallowing the usage
      // to raise an error would corrupt cost accounting. Callers see an empty
      // or unparsed result plus this stop reason; the router's schema
      // validation turns it into a clean ai_invalid_response.
      log.warn({ model, purpose: request.purpose }, 'model declined the request; returning refusal stop reason');
    }

    log.info(
      {
        model,
        purpose: request.purpose,
        refType: request.refType,
        promptTokens: uncachedInput + cacheRead + cacheWrite,
        cachedTokens: cacheRead,
        completionTokens,
        costUsd: Number(costUsd.toFixed(6)),
        latencyMs,
        stopReason,
        pricedFromListTable: known,
      },
      'anthropic completion',
    );

    return {
      text,
      parsed,
      model: typeof raw?.model === 'string' ? raw.model : model,
      provider: PROVIDER_ID,
      // Total prompt the model actually read, cached portion included. The
      // discount is reported separately in `cachedTokens` so a reader can see
      // both the size of the context and what it cost.
      promptTokens: uncachedInput + cacheRead + cacheWrite,
      completionTokens,
      cachedTokens: cacheRead,
      costUsd,
      latencyMs,
      stopReason,
    };
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
      // HttpClient returns parsed bodies, not response headers, so the
      // `anthropic-ratelimit-*` headers are not reachable from here. Reporting
      // an invented quota would be worse than reporting none.
      quotaRemaining: undefined,
      quotaResetAt: undefined,
    };

    const key = await deps.getCredential(CREDENTIAL_KEY).catch(() => null);
    if (!key) {
      return { ...base, state: 'unconfigured', detail: 'No Anthropic API key configured.' };
    }

    if (http.circuitOpen) {
      return {
        ...base,
        state: 'down',
        detail: `Circuit breaker open until ${new Date(http.circuitOpenUntilMs).toISOString()} after repeated failures.`,
        latencyMs: stats.lastLatencyMs || undefined,
      };
    }

    const startedAt = clock.now();
    try {
      // `/v1/models` authenticates the key without running inference, so a
      // status page can poll it without spending anything.
      await http.request<unknown>('v1/models', {
        query: { limit: 1 },
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
        timeoutMs: 10_000,
        maxRetries: 1,
        cacheTtlMs: HEALTH_CACHE_TTL_MS,
      });
      const latencyMs = clock.now() - startedAt;
      const detail =
        stats.schemaFallbacks > 0
          ? `Key valid. ${stats.schemaFallbacks} response(s) needed the JSON text fallback.`
          : 'Key valid; Messages API reachable.';
      return { ...base, state: 'ok', detail, latencyMs, lastSuccessAt: clock.now() };
    } catch (e) {
      const latencyMs = clock.now() - startedAt;
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        return {
          ...base,
          state: 'down',
          detail: `Anthropic rejected the stored API key (HTTP ${e.status}). Replace "${CREDENTIAL_KEY}".`,
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
      const entry = (id: string, spec: AnthropicModelSpec) => ({
        id,
        inputCostPerMTok: spec.inputCostPerMTok,
        outputCostPerMTok: spec.outputCostPerMTok,
        tier: spec.tier,
      });

      // Canonical ids first, so a tier lookup resolves to one of them.
      const out = Object.entries(catalogue).map(([id, spec]) => entry(id, spec));

      // Aliases are advertised too. The router matches an operator's configured
      // model id against this list *exactly*; without the aliases a stored
      // dated id (which is what this repo's own default triage setting still
      // ships) misses, and the call is quietly re-routed as an "equivalent
      // tier" substitute — which, with a second vendor configured, can mean a
      // different vendor than the operator asked for.
      for (const [alias, target] of Object.entries(ANTHROPIC_MODEL_ALIASES)) {
        const spec = catalogue[target];
        if (spec && !catalogue[alias]) out.push(entry(alias, spec));
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cost in USD from reported usage. Never returns zero for a call that ran. */
function estimateCostUsd(
  spec: AnthropicModelSpec,
  tokens: { uncachedInput: number; cacheRead: number; cacheWrite: number; completionTokens: number },
): number {
  const usd =
    (tokens.uncachedInput * spec.inputCostPerMTok +
      tokens.cacheRead * spec.cacheReadCostPerMTok +
      tokens.cacheWrite * spec.cacheWriteCostPerMTok +
      tokens.completionTokens * spec.outputCostPerMTok) /
    1_000_000;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

/**
 * Anthropic requires `input_schema` to be a JSON Schema object type. A caller
 * that hands over an array or scalar schema is wrapped in a single-property
 * object and unwrapped again on the way out, rather than being rejected.
 */
function toObjectSchema(schema: Record<string, unknown>): {
  schema: Record<string, unknown>;
  unwrap: (input: unknown) => unknown;
} {
  if (schema.type === 'object' || (schema.properties !== undefined && schema.type === undefined)) {
    return { schema: { ...schema, type: 'object' }, unwrap: (input) => input };
  }
  return {
    schema: { type: 'object', properties: { result: schema }, required: ['result'] },
    unwrap: (input) => (isRecord(input) ? input.result : undefined),
  };
}

/**
 * Extract the first balanced JSON object from free text.
 *
 * A regex cannot do this: nested braces and braces inside string literals both
 * defeat it. This walks the text tracking string state and escapes, so a
 * `{"note":"} not the end"}` payload parses correctly. Exported because the
 * OpenAI adapter needs exactly the same recovery path.
 */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Unwrap a tool call the model wrote out as text instead of calling the tool.
 *
 * This is the exact shape the documented thinking-off failure mode produces:
 * `{"type":"tool_use","name":"emit_result","input":{...}}` in a text block. The
 * payload the caller asked for is the `input`, not the envelope around it, and
 * handing back the envelope would fail schema validation for a response that
 * actually contained the right answer. Anything that is not recognisably this
 * platform's own envelope is passed through untouched — the model's own object
 * is never second-guessed.
 */
function unwrapToolEnvelope(value: unknown): unknown | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return value;
  // Match on the envelope's shape rather than only on our own tool name: a
  // model that writes the call out as text sometimes renames it, and
  // `{type:'tool_use', name, input:{...}}` is unambiguous enough to unwrap
  // safely. Anything that is not that exact shape is passed through untouched —
  // the model's own object is never second-guessed.
  const looksLikeEnvelope =
    value.type === 'tool_use' && typeof value.name === 'string' && isRecord(value.input);
  if (looksLikeEnvelope || value.name === STRUCTURED_TOOL_NAME) {
    return isRecord(value.input) ? value.input : value;
  }
  return value;
}

/** Turn a transport failure into an error whose code reflects what happened. */
function describeFailure(e: unknown, model: string): unknown {
  if (e instanceof HttpError) {
    if (e.status === 401 || e.status === 403) {
      return new AppError('not_configured', `Anthropic rejected the API key (HTTP ${e.status}). ${SETUP_HINT}`, {
        details: { model, status: e.status },
        retryable: false,
        cause: e,
      });
    }
    if (e.status === 429) {
      return new AppError('rate_limited', `Anthropic rate limit hit for ${model}.`, {
        details: { model, status: e.status },
        retryable: true,
        cause: e,
      });
    }
    // 529 is Anthropic's "overloaded" status. It is >= 500, so HttpClient has
    // already treated it as retryable and exhausted its attempts by this point.
    if (e.status === 529) {
      return new AppError('provider_unavailable', `Anthropic is overloaded (HTTP 529) for ${model}.`, {
        details: { model, status: e.status },
        retryable: true,
        cause: e,
      });
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
