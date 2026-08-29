import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { safeErrorText } from '../../core/errors.js';
import { isSensitiveSettingPath } from '@solcoin/shared';
import { actorFrom, requirePermission } from '../server.js';
import type { AppContainer } from '../../container.js';

/**
 * Settings routes.
 *
 * Permission is checked against the *specific paths being changed*, not against
 * the endpoint. Changing a notification preference and raising the daily spend
 * limit arrive at the same URL and must not carry the same authority.
 */
export default async function settingsRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  app.get('/api/settings', async (request) => {
    requirePermission(request, 'view');
    return { settings: container.settings.get() };
  });

  app.patch('/api/settings', async (request) => {
    requirePermission(request, 'view');
    const body = z.object({ patch: z.record(z.unknown()), reason: z.string().max(500).optional() }).parse(request.body);

    const paths = collectPaths(body.patch);
    const touchesAutonomy = paths.some((p) => p.startsWith('autonomy.'));
    const touchesLimits = paths.some((p) => p.startsWith('limits.') || p.startsWith('qualityGate.'));
    const touchesWallet = paths.some((p) => p.startsWith('wallet.') || p.startsWith('execution.'));
    const touchesStop = paths.includes('emergencyStop');

    if (touchesAutonomy) requirePermission(request, 'edit_autonomy');
    if (touchesLimits) requirePermission(request, 'edit_limits');
    if (touchesWallet) requirePermission(request, 'edit_wallet_config');
    if (touchesStop) requirePermission(request, 'emergency_stop');
    if (!touchesAutonomy && !touchesLimits && !touchesWallet && !touchesStop) {
      requirePermission(request, 'edit_limits');
    }

    const result = container.settings.update(body.patch, actorFrom(request), body.reason);

    /*
     * The RPC connection and the launch adapter are built against whichever
     * network was configured when they were constructed. Changing
     * `execution.network` without rebuilding them leaves a live adapter still
     * pointed at the previous chain, which is how a launch an operator
     * believes is going to devnet ends up broadcast to mainnet.
     *
     * The adapter now declares only the network it is bound to, so a stale one
     * is refused rather than used — but a refusal is a poor answer to a
     * setting the operator just changed, so the providers are rebuilt here and
     * the switch simply takes effect. A failure to rebuild is reported rather
     * than swallowed: it leaves the platform unable to launch, and the
     * operator needs to know that now rather than at the next launch.
     */
    const rebuilt = result.changed.some((c) => c.path === 'execution.network');
    let providerRefreshError: string | null = null;
    if (rebuilt) {
      try {
        await container.refreshProviders();
      } catch (e) {
        providerRefreshError = safeErrorText(e, 300);
      }
    }

    return {
      settings: result.settings,
      changed: result.changed,
      sensitiveChanges: result.changed.filter((c) => isSensitiveSettingPath(c.path)).map((c) => c.path),
      ...(rebuilt ? { providersRebuilt: providerRefreshError === null } : {}),
      ...(providerRefreshError ? { providerRefreshError } : {}),
    };
  });

  app.get('/api/settings/history', async (request) => {
    requirePermission(request, 'view_audit');
    const query = z.object({ limit: z.coerce.number().min(1).max(500).default(100), path: z.string().optional() }).parse(request.query);
    const rows = container.db.$raw
      .prepare(
        `SELECT * FROM setting_history WHERE (? IS NULL OR path = ?) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(query.path ?? null, query.path ?? null, query.limit);
    return { history: rows };
  });

  /** The phase ladder, so the UI can explain what each step unlocks. */
  app.get('/api/settings/phases', async (request) => {
    requirePermission(request, 'view');
    return {
      current: container.settings.get().execution.phase,
      phases: [
        {
          id: 'phase1_research',
          name: 'Research and simulation',
          description:
            'Discovers trends, generates and evaluates concepts, and runs paper launches. Nothing is broadcast and no funds are at risk.',
          networks: ['simulation'],
          maxAutonomy: 'approve',
        },
        {
          id: 'phase2_devnet',
          name: 'Devnet execution',
          description:
            'Exercises the real on-chain launch path against Solana devnet. Transactions are genuine but the SOL is not. Note that devnet bonding-curve reserves differ from mainnet, so pricing will not match.',
          networks: ['simulation', 'devnet'],
          maxAutonomy: 'approve',
        },
        {
          id: 'phase3_mainnet_approval',
          name: 'Mainnet with approval',
          description: 'Real launches on mainnet, each one requiring an explicit human approval before it is submitted.',
          networks: ['simulation', 'devnet', 'mainnet'],
          maxAutonomy: 'approve',
        },
        {
          id: 'phase4_limited_autonomous',
          name: 'Limited autonomous',
          description:
            'The platform may launch without approval, within the configured daily and hourly limits. Recommended only after a meaningful run in phase 3.',
          networks: ['simulation', 'devnet', 'mainnet'],
          maxAutonomy: 'auto',
        },
        {
          id: 'phase5_adaptive_autonomous',
          name: 'Adaptive autonomous',
          description:
            'Full autonomy with the model actively steering thresholds from its own performance history. Appropriate only once calibration is demonstrably good.',
          networks: ['simulation', 'devnet', 'mainnet'],
          maxAutonomy: 'auto',
        },
      ],
    };
  });
}

function collectPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...collectPaths(value as Record<string, unknown>, path));
    } else {
      out.push(path);
    }
  }
  return out;
}
