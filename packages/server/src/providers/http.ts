import { setTimeout as delay } from 'node:timers/promises';
import { AppError, safeErrorText } from '../core/errors.js';
import { componentLogger } from '../core/logger.js';
import type { Clock } from '../core/clock.js';

/**
 * The single HTTP client every external call goes through.
 *
 * It exists because the platform depends on a dozen third-party APIs with
 * wildly different reliability, and a naive `fetch` loop across them will
 * either hammer a rate limit into a ban or stall the whole scheduler behind one
 * dead host. Responsibilities:
 *
 *   - per-host token-bucket rate limiting, so we stay inside published quotas;
 *   - bounded retries with full-jitter exponential backoff on transient errors;
 *   - `Retry-After` compliance, because ignoring it is how keys get revoked;
 *   - a circuit breaker so a dead provider fails fast instead of consuming the
 *     job budget;
 *   - hard timeouts, since a hung socket is worse than an error;
 *   - a small response cache for endpoints polled far more often than they change.
 */

export interface RateLimitConfig {
  /** Sustained requests permitted per interval. */
  requests: number;
  intervalMs: number;
  /** Burst capacity; defaults to `requests`. */
  burst?: number;
}

export interface HttpClientOptions {
  name: string;
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  rateLimit?: RateLimitConfig;
  /** Failures before the breaker opens. */
  circuitThreshold?: number;
  circuitCooldownMs?: number;
  clock?: Clock;
  /** Cache successful GET responses for this long. Zero disables caching. */
  cacheTtlMs?: number;
  /** Called on every completed request, for health accounting. */
  onResult?: (result: { ok: boolean; status?: number; latencyMs: number; error?: string }) => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Send `body` as multipart/form-data. */
  formData?: FormData;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  /** Override the client cache TTL for this call. */
  cacheTtlMs?: number;
  /** Treat these statuses as success and return the parsed body. */
  acceptStatuses?: number[];
  /** Expected response shape; `text` skips JSON parsing. */
  responseType?: 'json' | 'text' | 'buffer';
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly clock: Clock,
  ) {
    this.tokens = capacity;
    this.lastRefill = clock.now();
  }

  /** Milliseconds the caller must wait before a token is available. */
  reserve(): number {
    const now = this.clock.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefill = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const deficit = 1 - this.tokens;
    this.tokens = 0;
    return Math.ceil(deficit / this.refillPerMs);
  }
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

export class HttpError extends AppError {
  readonly status: number;
  readonly bodyText: string;

  constructor(status: number, statusText: string, bodyText: string, url: string) {
    const retryable = status === 408 || status === 429 || status >= 500;
    super(retryable ? 'provider_unavailable' : 'provider_error', `HTTP ${status} ${statusText} for ${url}`, {
      statusCode: status,
      retryable,
      details: { status, body: bodyText.slice(0, 500) },
    });
    this.name = 'HttpError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

export class HttpClient {
  private readonly log = componentLogger('http');
  private readonly bucket: TokenBucket | null;
  private readonly cache = new Map<string, CacheEntry>();
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  /** Serialises rate-limit reservations so concurrent callers cannot overdraw. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: HttpClientOptions) {
    const clock = options.clock ?? { now: () => Date.now(), date: () => new Date(), sleep: (ms) => delay(ms) };
    this.clock = clock;
    this.bucket = options.rateLimit
      ? new TokenBucket(
          options.rateLimit.burst ?? options.rateLimit.requests,
          options.rateLimit.requests / options.rateLimit.intervalMs,
          clock,
        )
      : null;
  }

  private readonly clock: Clock;

  get circuitOpen(): boolean {
    return this.clock.now() < this.circuitOpenUntil;
  }

  get circuitOpenUntilMs(): number {
    return this.circuitOpenUntil;
  }

  resetCircuit(): void {
    this.circuitOpenUntil = 0;
    this.consecutiveFailures = 0;
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const method = options.method ?? 'GET';
    const cacheTtl = options.cacheTtlMs ?? this.options.cacheTtlMs ?? 0;
    const cacheKey = method === 'GET' && cacheTtl > 0 ? url : null;

    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > this.clock.now()) return hit.value as T;
      if (hit) this.cache.delete(cacheKey);
    }

    if (this.circuitOpen) {
      throw new AppError(
        'provider_unavailable',
        `${this.options.name} circuit is open until ${new Date(this.circuitOpenUntil).toISOString()}`,
        { retryable: true },
      );
    }

    const maxRetries = options.maxRetries ?? this.options.maxRetries ?? 3;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // Full-jitter exponential backoff: prevents synchronised retry storms
        // across the many jobs that share a provider.
        const base = Math.min(30_000, 400 * 2 ** (attempt - 1));
        await this.clock.sleep(Math.floor(Math.random() * base));
      }

      await this.waitForRateLimit();
      const started = this.clock.now();

      try {
        const result = await this.execute<T>(url, method, options);
        const latencyMs = this.clock.now() - started;
        this.consecutiveFailures = 0;
        this.options.onResult?.({ ok: true, latencyMs });
        if (cacheKey) this.cache.set(cacheKey, { expiresAt: this.clock.now() + cacheTtl, value: result });
        return result;
      } catch (e) {
        lastError = e;
        const latencyMs = this.clock.now() - started;
        const retryable = e instanceof AppError ? e.retryable : isTransientNetworkError(e);
        this.options.onResult?.({
          ok: false,
          status: e instanceof HttpError ? e.status : undefined,
          latencyMs,
          error: safeErrorText(e, 200),
        });

        if (e instanceof HttpError && e.status === 429) {
          const retryAfter = parseRetryAfter(e.bodyText);
          if (retryAfter > 0) await this.clock.sleep(Math.min(retryAfter, 60_000));
        }

        if (!retryable || attempt === maxRetries) {
          this.recordFailure();
          throw e;
        }
        this.log.debug(
          { provider: this.options.name, attempt, url: redactUrl(url), err: safeErrorText(e, 160) },
          'retrying request',
        );
      }
    }

    this.recordFailure();
    throw lastError ?? new AppError('provider_error', `${this.options.name} request failed`);
  }

  private async execute<T>(url: string, method: string, options: RequestOptions): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 20_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);

    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const headers: Record<string, string> = {
        // Wikimedia and several others require a descriptive User-Agent and
        // will rate-limit or reject anonymous clients.
        'user-agent': 'solcoin/0.1 (autonomous token research platform)',
        accept: 'application/json, text/plain, */*',
        ...this.options.defaultHeaders,
        ...options.headers,
      };

      let body: string | FormData | undefined;
      if (options.formData) {
        body = options.formData;
        delete headers['content-type'];
      } else if (options.body !== undefined) {
        body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        headers['content-type'] = headers['content-type'] ?? 'application/json';
      }

      const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'follow' });

      const accepted = options.acceptStatuses ?? [];
      if (!response.ok && !accepted.includes(response.status)) {
        const text = await response.text().catch(() => '');
        throw new HttpError(response.status, response.statusText, text, redactUrl(url));
      }

      switch (options.responseType ?? 'json') {
        case 'text':
          return (await response.text()) as T;
        case 'buffer':
          return Buffer.from(await response.arrayBuffer()) as T;
        default: {
          const text = await response.text();
          if (!text) return undefined as T;
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new AppError('provider_error', `${this.options.name} returned non-JSON response`, {
              details: { preview: text.slice(0, 200) },
              retryable: false,
            });
          }
        }
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (isAbortError(e)) {
        throw new AppError('provider_unavailable', `${this.options.name} request timed out after ${timeoutMs}ms`, {
          retryable: true,
          cause: e,
        });
      }
      throw new AppError('provider_unavailable', `${this.options.name} network error: ${safeErrorText(e, 160)}`, {
        retryable: true,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async waitForRateLimit(): Promise<void> {
    if (!this.bucket) return;
    // Chain reservations so two concurrent callers cannot both see a free token.
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = this.bucket.reserve();
      if (waitMs > 0) await this.clock.sleep(waitMs);
    } finally {
      release();
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    const threshold = this.options.circuitThreshold ?? 6;
    if (this.consecutiveFailures >= threshold) {
      const cooldown = this.options.circuitCooldownMs ?? 120_000;
      this.circuitOpenUntil = this.clock.now() + cooldown;
      this.log.warn(
        { provider: this.options.name, failures: this.consecutiveFailures, cooldownMs: cooldown },
        'circuit breaker opened',
      );
    }
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = this.options.baseUrl;
    const url = path.startsWith('http') ? new URL(path) : new URL(path, base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  clearCache(): void {
    this.cache.clear();
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.message.includes('timeout') || e.message.includes('aborted'));
}

function isTransientNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('eai_again') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  );
}

function parseRetryAfter(bodyText: string): number {
  const match = bodyText.match(/retry[- ]after["\s:]+(\d+)/i);
  if (!match?.[1]) return 0;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

/** Strip query-string credentials before a URL reaches a log line. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/key|token|secret|password|auth/i.test(key)) parsed.searchParams.set(key, '[redacted]');
    }
    if (parsed.username || parsed.password) {
      parsed.username = '[redacted]';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return url.replace(/(api[-_]?key|token|secret)=[^&\s]+/gi, '$1=[redacted]');
  }
}
