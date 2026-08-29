import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useApiQuery, POLL, queryKeys } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { Badge } from './ui';
import { humanise } from '@/lib/format';

interface SystemStatus {
  emergencyStop: boolean;
  emergencyStopReason: string;
  network: string;
  phase: string;
  health: { overall: 'ok' | 'degraded' | 'down' };
  usage: { launchesToday: number; limits: { maxLaunchesPerDay: number } };
}

const NAV: Array<{ to: string; label: string; icon: string; group: string }> = [
  { to: '/', label: 'Overview', icon: '◈', group: 'Operate' },
  { to: '/opportunities', label: 'Opportunities', icon: '◎', group: 'Operate' },
  { to: '/candidates', label: 'Candidates', icon: '◇', group: 'Operate' },
  { to: '/tokens', label: 'Live tokens', icon: '◆', group: 'Operate' },
  { to: '/fees', label: 'Creator fees', icon: '⬢', group: 'Money' },
  { to: '/wallet', label: 'Wallet', icon: '⬡', group: 'Money' },
  { to: '/accounting', label: 'Accounting', icon: '▤', group: 'Money' },
  { to: '/analytics', label: 'Analytics', icon: '▦', group: 'Learn' },
  { to: '/learning', label: 'AI learning', icon: '◐', group: 'Learn' },
  { to: '/experiments', label: 'Experiments', icon: '◑', group: 'Learn' },
  { to: '/strategy', label: 'Strategy lab', icon: '◭', group: 'Learn' },
  { to: '/health', label: 'System health', icon: '◉', group: 'System' },
  { to: '/settings', label: 'Settings', icon: '⚙', group: 'System' },
];

const MOBILE_NAV = NAV.filter((n) => ['/', '/opportunities', '/candidates', '/tokens', '/fees'].includes(n.to));

export function Layout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const { user, logout } = useSession();
  const { data: status } = useApiQuery<SystemStatus>(queryKeys.systemStatus, '/api/system/status', {
    refetchInterval: POLL.fast,
  });

  const groups = [...new Set(NAV.map((n) => n.group))];

  return (
    <div className="min-h-dvh bg-ground">
      {status?.emergencyStop && (
        <div className="sticky top-0 z-40 border-b border-negative-dim bg-negative-dim/60 px-4 py-2 text-center text-sm text-ink backdrop-blur">
          <strong className="font-semibold">Emergency stop engaged.</strong>{' '}
          <span className="text-ink-muted">
            {status.emergencyStopReason || 'All operations with side effects are suspended.'}
          </span>
        </div>
      )}

      <div className="flex">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-surface lg:flex">
          <div className="flex h-14 items-center gap-2 border-b border-border px-4">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white">S</div>
            <span className="text-sm font-semibold tracking-tight">Solcoin</span>
          </div>

          <nav className="flex-1 overflow-y-auto px-2 py-3">
            {groups.map((group) => (
              <div key={group} className="mb-4">
                <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-ink-subtle">{group}</div>
                {NAV.filter((n) => n.group === group).map((item) => (
                  <NavItem key={item.to} {...item} />
                ))}
              </div>
            ))}
          </nav>

          <div className="border-t border-border p-3">
            <NetworkBadge network={status?.network} phase={status?.phase} health={status?.health.overall} />
            {user && (
              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-ink">{user.displayName}</div>
                  <div className="truncate text-[11px] text-ink-subtle">{humanise(user.role)}</div>
                </div>
                <button className="text-xs text-ink-subtle transition-colors hover:text-negative" onClick={() => void logout()}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile header */}
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur lg:hidden">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white">S</div>
              <span className="text-sm font-semibold">Solcoin</span>
            </div>
            <div className="flex items-center gap-2">
              <NetworkBadge network={status?.network} phase={status?.phase} health={status?.health.overall} compact />
              <button
                className="rounded-lg border border-border px-2.5 py-1.5 text-sm text-ink-muted"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Menu"
                aria-expanded={menuOpen}
              >
                ☰
              </button>
            </div>
          </header>

          {menuOpen && (
            <div className="border-b border-border bg-surface px-2 py-2 lg:hidden">
              {NAV.map((item) => (
                <NavItem key={item.to} {...item} onNavigate={() => setMenuOpen(false)} />
              ))}
              <button
                className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm text-ink-subtle"
                onClick={() => void logout()}
              >
                Sign out
              </button>
            </div>
          )}

          <main className="min-w-0 flex-1 px-4 pb-24 pt-5 sm:px-6 lg:pb-10" key={location.pathname}>
            <div className="mx-auto w-full max-w-[1400px]">{children}</div>
          </main>

          {/* Mobile bottom bar for the screens used most */}
          <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-surface/95 backdrop-blur lg:hidden">
            {MOBILE_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  clsx(
                    'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
                    isActive ? 'text-accent-soft' : 'text-ink-subtle',
                  )
                }
              >
                <span className="text-base leading-none">{item.icon}</span>
                <span className="truncate px-1">{item.label.split(' ')[0]}</span>
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

function NavItem({ to, label, icon, onNavigate }: { to: string; label: string; icon: string; onNavigate?: () => void }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      onClick={onNavigate}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
          isActive ? 'bg-accent-dim/40 text-accent-soft' : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
        )
      }
    >
      <span className="w-4 text-center text-xs opacity-70">{icon}</span>
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

function NetworkBadge({
  network,
  phase,
  health,
  compact,
}: {
  network?: string;
  phase?: string;
  health?: 'ok' | 'degraded' | 'down';
  compact?: boolean;
}) {
  const tone = network === 'mainnet' ? 'negative' : network === 'devnet' ? 'warning' : 'info';
  const healthTone = health === 'ok' ? 'positive' : health === 'degraded' ? 'warning' : 'negative';
  return (
    <div className={clsx('flex items-center gap-1.5', compact ? 'flex-row' : 'flex-col items-start gap-2')}>
      <Badge tone={tone}>
        {network === 'simulation' ? 'Simulation' : network === 'devnet' ? 'Devnet' : network === 'mainnet' ? 'MAINNET' : '—'}
      </Badge>
      {!compact && phase && <span className="text-[11px] text-ink-subtle">{humanise(phase.replace(/^phase\d_/, ''))}</span>}
      <Badge tone={healthTone}>{health === 'ok' ? 'Healthy' : health === 'degraded' ? 'Degraded' : health === 'down' ? 'Down' : '—'}</Badge>
    </div>
  );
}
