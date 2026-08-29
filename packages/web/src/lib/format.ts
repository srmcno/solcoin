/**
 * Formatting helpers.
 *
 * Consistency matters more than cleverness here: the same quantity must read
 * identically on every screen, and precision must match the magnitude so that
 * a 0.00004 SOL fee is not rendered as "0.00 SOL".
 */

export function formatSol(value: number | null | undefined, options: { digits?: number; sign?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = options.digits ?? (abs === 0 ? 2 : abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= 0.001 ? 4 : 6);
  const sign = options.sign && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)} SOL`;
}

export function formatUsd(value: number | null | undefined, options: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (options.compact && abs >= 10_000) {
    return `$${Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`;
  }
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatScore(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/** Relative time that stays readable at every scale. */
export function formatRelative(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return 'never';
  const delta = now - timestamp;
  const future = delta < 0;
  const seconds = Math.abs(delta) / 1000;

  const render = (value: number, unit: string): string => {
    const rounded = Math.round(value);
    const plural = rounded === 1 ? unit : `${unit}s`;
    return future ? `in ${rounded} ${plural}` : `${rounded} ${plural} ago`;
  };

  if (seconds < 45) return future ? 'shortly' : 'just now';
  if (seconds < 5400) return render(seconds / 60, 'minute');
  if (seconds < 129_600) return render(seconds / 3600, 'hour');
  if (seconds < 2_592_000) return render(seconds / 86_400, 'day');
  if (seconds < 31_536_000) return render(seconds / 2_592_000, 'month');
  return render(seconds / 31_536_000, 'year');
}

export function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function truncateAddress(address: string | null | undefined, chars = 4): string {
  if (!address) return '—';
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

export function solscanUrl(kind: 'account' | 'tx' | 'token', value: string, network: string): string {
  const cluster = network === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/${kind}/${value}${cluster}`;
}

export function pumpFunUrl(mint: string): string {
  return `https://pump.fun/coin/${mint}`;
}

/** Human-readable label for an enum-ish identifier. */
export function humanise(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bUsd\b/g, 'USD')
    .replace(/\bSol\b/g, 'SOL')
    .replace(/\bRpc\b/g, 'RPC')
    .replace(/\bAmm\b/g, 'AMM');
}
