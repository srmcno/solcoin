/**
 * API client.
 *
 * Session state lives in an HttpOnly cookie the browser sends automatically, so
 * there is no token to store and nothing for injected script to steal. The CSRF
 * token is the one piece of session material JavaScript needs; it is kept in
 * memory only, never in localStorage, and refreshed whenever a response tells
 * us it has rotated.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
  get isPermissionError(): boolean {
    return this.status === 403;
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Return the raw text rather than parsing JSON, for CSV exports. */
  raw?: boolean;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;

  const response = await fetch(path.startsWith('/') ? path : `/api/${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (options.raw) {
    if (!response.ok) throw await toApiError(response);
    return (await response.text()) as T;
  }

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    const error = await toApiError(response);
    if (error.status === 401) onUnauthorized?.();
    throw error;
  }

  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'internal';
  let message = `Request failed with status ${response.status}.`;
  let details: unknown;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    // A non-JSON error body (a proxy error page, say) keeps the default message.
  }
  return new ApiError(code, message, response.status, details);
}

/** Trigger a browser download for an export endpoint. */
export async function downloadExport(path: string, filename: string): Promise<void> {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw await toApiError(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
