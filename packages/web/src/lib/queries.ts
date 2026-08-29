import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { api } from './api';

/**
 * Query helpers.
 *
 * Poll intervals are set per resource according to how fast the underlying data
 * actually changes. Polling everything every five seconds would make the
 * dashboard feel live while quietly generating a constant load the platform
 * gains nothing from.
 */

export const POLL = {
  /** Live operational state: jobs running, wallet balance, emergency stop. */
  fast: 15_000,
  /** Data that moves on a job cadence. */
  normal: 60_000,
  /** Analytics and anything recomputed daily. */
  slow: 300_000,
} as const;

export function useApiQuery<T>(
  key: readonly unknown[],
  path: string,
  options: Partial<UseQueryOptions<T, Error, T, readonly unknown[]>> = {},
) {
  return useQuery<T, Error, T, readonly unknown[]>({
    queryKey: key,
    queryFn: ({ signal }) => api<T>(path, { signal }),
    staleTime: 10_000,
    retry: (failureCount, error) => {
      // Never retry an auth or permission failure: it will not resolve itself
      // and each retry is another failed request in the log.
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403 || status === 404) return false;
      return failureCount < 2;
    },
    ...options,
  });
}

export function useApiMutation<TResult, TVariables = void>(
  path: string | ((variables: TVariables) => string),
  options: {
    method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    invalidate?: readonly (readonly unknown[])[];
    onSuccess?: (result: TResult, variables: TVariables) => void;
  } = {},
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, Error, TVariables>({
    mutationFn: (variables: TVariables) =>
      api<TResult>(typeof path === 'function' ? path(variables) : path, {
        method: options.method ?? 'POST',
        body: variables === undefined ? undefined : variables,
      }),
    onSuccess: (result, variables) => {
      for (const key of options.invalidate ?? []) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      options.onSuccess?.(result, variables);
    },
  });
}

export const queryKeys = {
  session: ['session'] as const,
  bootstrap: ['bootstrap'] as const,
  systemStatus: ['system', 'status'] as const,
  providers: ['system', 'providers'] as const,
  secrets: ['system', 'secrets'] as const,
  audit: (filters: unknown) => ['system', 'audit', filters] as const,
  logs: (filters: unknown) => ['system', 'logs'] as const,
  diagnostics: ['system', 'diagnostics'] as const,
  settings: ['settings'] as const,
  phases: ['settings', 'phases'] as const,
  trends: (filters: unknown) => ['trends', filters] as const,
  trend: (id: string) => ['trends', id] as const,
  opportunities: ['opportunities'] as const,
  candidates: (status: string) => ['candidates', status] as const,
  candidate: (id: string) => ['candidates', 'detail', id] as const,
  launches: ['launches'] as const,
  tokens: (filters: unknown) => ['tokens', filters] as const,
  token: (mint: string) => ['tokens', mint] as const,
  fees: ['fees'] as const,
  feesByToken: ['fees', 'by-token'] as const,
  wallet: ['wallet'] as const,
  jobs: ['jobs'] as const,
  analyticsOverview: ['analytics', 'overview'] as const,
  analyticsDistribution: (range: string) => ['analytics', 'distribution', range] as const,
  analyticsPnl: (range: string) => ['analytics', 'pnl', range] as const,
  analyticsDimension: (dimension: string, range: string) => ['analytics', 'by', dimension, range] as const,
  analyticsSeries: (metric: string, range: string, bucket: string) => ['analytics', 'series', metric, range, bucket] as const,
  analyticsSignals: ['analytics', 'signals'] as const,
  analyticsForecast: ['analytics', 'forecast'] as const,
  accountingLedger: (range: string) => ['accounting', 'ledger', range] as const,
  accountingMonthly: ['accounting', 'monthly'] as const,
  learning: ['learning'] as const,
  learningErrors: ['learning', 'errors'] as const,
  experiments: ['experiments'] as const,
  experiment: (id: string) => ['experiments', id] as const,
  strategies: ['strategies'] as const,
};
