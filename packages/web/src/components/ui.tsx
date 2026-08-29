import clsx from 'clsx';
import type { ReactNode } from 'react';
import { formatPercent } from '@/lib/format';

/**
 * The shared component vocabulary.
 *
 * Kept small on purpose. A dashboard reads as one product when every page uses
 * the same six primitives; it reads as a collection of scripts when each page
 * invents its own card.
 */

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return <div className={clsx('card', padded && 'p-4 sm:p-5', className)}>{children}</div>;
}

export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export type Tone = 'neutral' | 'accent' | 'positive' | 'warning' | 'negative' | 'info';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-surface-raised text-ink-muted border-border',
  accent: 'bg-accent-dim/40 text-accent-soft border-accent-dim',
  positive: 'bg-positive-dim/40 text-positive border-positive-dim',
  warning: 'bg-warning-dim/40 text-warning border-warning-dim',
  negative: 'bg-negative-dim/40 text-negative border-negative-dim',
  info: 'bg-info-dim/40 text-info border-info-dim',
};

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={clsx('chip', TONE_CLASSES[tone], className)}>{children}</span>;
}

/**
 * A headline metric.
 *
 * `hint` exists because almost every number on this platform needs a caveat —
 * a sample size, an estimate flag, a definition — and burying those in a
 * tooltip means nobody reads them.
 */
export function StatTile({
  label,
  value,
  hint,
  delta,
  tone = 'neutral',
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: { value: number; label?: string };
  tone?: Tone;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('card p-4', className)}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</span>
        {icon && <span className="text-ink-subtle">{icon}</span>}
      </div>
      <div
        className={clsx(
          'tnum mt-2 text-2xl font-semibold tracking-tight',
          tone === 'positive' && 'text-positive',
          tone === 'negative' && 'text-negative',
          tone === 'warning' && 'text-warning',
          tone === 'accent' && 'text-accent-soft',
          tone === 'neutral' && 'text-ink',
          tone === 'info' && 'text-info',
        )}
      >
        {value}
      </div>
      {delta !== undefined && (
        <div className={clsx('tnum mt-1 text-xs font-medium', delta.value >= 0 ? 'text-positive' : 'text-negative')}>
          {delta.value >= 0 ? '▲' : '▼'} {formatPercent(Math.abs(delta.value), 1)}
          {delta.label && <span className="ml-1 text-ink-subtle">{delta.label}</span>}
        </div>
      )}
      {hint && <div className="mt-1.5 text-xs leading-relaxed text-ink-subtle">{hint}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="text-3xl opacity-50">{icon}</div>}
      <div className="text-sm font-semibold text-ink">{title}</div>
      {description && <div className="max-w-md text-sm leading-relaxed text-ink-muted">{description}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="text-sm font-semibold text-negative">Could not load this</div>
      <div className="max-w-lg text-sm leading-relaxed text-ink-muted">{message}</div>
      {onRetry && (
        <button className="btn btn-ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-lg bg-surface-raised', className)} />;
}

export function LoadingRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={clsx('space-y-2', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

/** Horizontal bar for a 0..1 score, coloured by whether higher is better. */
export function ScoreBar({
  value,
  max = 1,
  tone = 'accent',
  className,
  invert = false,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  className?: string;
  invert?: boolean;
}) {
  const pct = Math.max(0, Math.min(1, value / max));
  const effectiveTone: Tone = invert ? (pct > 0.66 ? 'negative' : pct > 0.33 ? 'warning' : 'positive') : tone;
  const barColour = {
    neutral: 'bg-ink-subtle',
    accent: 'bg-accent',
    positive: 'bg-positive',
    warning: 'bg-warning',
    negative: 'bg-negative',
    info: 'bg-info',
  }[effectiveTone];

  return (
    <div className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-surface-raised', className)}>
      <div className={clsx('h-full rounded-full transition-all', barColour)} style={{ width: `${pct * 100}%` }} />
    </div>
  );
}

/**
 * Table that scrolls horizontally on narrow screens rather than squashing.
 *
 * A dashboard that reflows a twelve-column table into unreadable slivers on a
 * phone is worse than one that scrolls.
 */
export function DataTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('-mx-4 overflow-x-auto sm:mx-0', className)}>
      <div className="inline-block min-w-full align-middle px-4 sm:px-0">
        <table className="min-w-full border-separate border-spacing-0 text-sm">{children}</table>
      </div>
    </div>
  );
}

export function Th({ children, className, align = 'left' }: { children?: ReactNode; className?: string; align?: 'left' | 'right' | 'center' }) {
  return (
    <th
      scope="col"
      className={clsx(
        'sticky top-0 z-10 whitespace-nowrap border-b border-border bg-surface px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-subtle',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align = 'left',
}: {
  children?: ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <td
      className={clsx(
        'border-b border-border/60 px-3 py-2.5 align-middle text-ink-muted',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={clsx('scrollbar-none flex gap-1 overflow-x-auto border-b border-border', className)} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={clsx(
            'relative whitespace-nowrap px-3 py-2 text-sm font-medium transition-colors',
            active === tab.id ? 'text-ink' : 'text-ink-subtle hover:text-ink-muted',
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="tnum ml-1.5 text-xs text-ink-subtle">{tab.count}</span>
          )}
          {active === tab.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card-raised max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-b-none sm:rounded-b-2xl">
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-border bg-surface-raised px-5 py-3.5">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <button className="text-ink-subtle transition-colors hover:text-ink" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

/** An explanatory note. Used wherever a number needs a caveat to be honest. */
export function Note({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <p
      className={clsx(
        'rounded-lg border px-3 py-2 text-xs leading-relaxed',
        tone === 'warning' && 'border-warning-dim bg-warning-dim/20 text-warning',
        tone === 'negative' && 'border-negative-dim bg-negative-dim/20 text-negative',
        tone === 'info' && 'border-info-dim bg-info-dim/20 text-info',
        tone === 'positive' && 'border-positive-dim bg-positive-dim/20 text-positive',
        tone === 'accent' && 'border-accent-dim bg-accent-dim/20 text-accent-soft',
        tone === 'neutral' && 'border-border bg-surface-raised text-ink-muted',
      )}
    >
      {children}
    </p>
  );
}

/** Sample-size marker. Every rate on this platform shows one. */
export function SampleSize({ n, minimum = 8 }: { n: number; minimum?: number }) {
  const reliable = n >= minimum;
  return (
    <span
      className={clsx('tnum text-xs', reliable ? 'text-ink-subtle' : 'text-warning')}
      title={reliable ? `${n} observations` : `Only ${n} observations — not enough to be reliable`}
    >
      n={n}
      {!reliable && ' ⚠'}
    </span>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  return (
    <button
      className="text-xs text-ink-subtle transition-colors hover:text-accent-soft"
      onClick={() => void navigator.clipboard?.writeText(value)}
      title={`Copy ${value}`}
    >
      {label}
    </button>
  );
}
