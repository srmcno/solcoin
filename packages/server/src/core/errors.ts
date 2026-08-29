/** Error taxonomy. Every thrown error carries a stable machine-readable code. */
export type ErrorCode =
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'provider_error'
  | 'ai_invalid_response'
  | 'ai_budget_exceeded'
  | 'rpc_error'
  | 'transaction_failed'
  | 'transaction_expired'
  | 'insufficient_funds'
  | 'limit_exceeded'
  | 'safety_block'
  | 'emergency_stop'
  | 'not_configured'
  | 'locked'
  | 'internal';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { statusCode?: number; details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = options.statusCode ?? defaultStatusFor(code);
    this.details = options.details;
    this.retryable = options.retryable ?? defaultRetryableFor(code);
  }
}

function defaultStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'validation_failed':
      return 400;
    case 'unauthorized':
      return 401;
    case 'forbidden':
    case 'safety_block':
    case 'emergency_stop':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'limit_exceeded':
    case 'rate_limited':
      return 429;
    case 'not_configured':
      return 412;
    case 'locked':
      return 423;
    case 'provider_unavailable':
      return 503;
    default:
      return 500;
  }
}

function defaultRetryableFor(code: ErrorCode): boolean {
  return (
    code === 'rate_limited' ||
    code === 'provider_unavailable' ||
    code === 'rpc_error' ||
    code === 'transaction_expired' ||
    code === 'provider_error'
  );
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function errorCode(e: unknown): ErrorCode {
  return isAppError(e) ? e.code : 'internal';
}

/** Truncate and strip anything secret-looking before an error reaches storage. */
export function safeErrorText(e: unknown, maxLength = 800): string {
  const raw = errorMessage(e);
  return redactSecrets(raw).slice(0, maxLength);
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\b[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  /"?(api[_-]?key|apikey|secret|password|passphrase|private[_-]?key|token)"?\s*[:=]\s*"?[^\s",}]{8,}/gi,
  /\b[0-9a-fA-F]{64}\b/g,
  /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}
