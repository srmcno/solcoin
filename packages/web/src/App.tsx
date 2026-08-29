import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { LoadingRows } from '@/components/ui';
import { useSession } from '@/lib/session';
import { LoginPage } from '@/pages/LoginPage';
import { OverviewPage } from '@/pages/OverviewPage';

// Everything past the overview is code-split: the first paint should not carry
// the charting library or the settings forms.
const OpportunitiesPage = lazy(() => import('@/pages/OpportunitiesPage'));
const TrendDetailPage = lazy(() => import('@/pages/TrendDetailPage'));
const CandidatesPage = lazy(() => import('@/pages/CandidatesPage'));
const CandidateDetailPage = lazy(() => import('@/pages/CandidateDetailPage'));
const TokensPage = lazy(() => import('@/pages/TokensPage'));
const TokenDetailPage = lazy(() => import('@/pages/TokenDetailPage'));
const FeesPage = lazy(() => import('@/pages/FeesPage'));
const WalletPage = lazy(() => import('@/pages/WalletPage'));
const AccountingPage = lazy(() => import('@/pages/AccountingPage'));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'));
const LearningPage = lazy(() => import('@/pages/LearningPage'));
const ExperimentsPage = lazy(() => import('@/pages/ExperimentsPage'));
const StrategyPage = lazy(() => import('@/pages/StrategyPage'));
const HealthPage = lazy(() => import('@/pages/HealthPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));

export function App() {
  const { user, loading, needsBootstrap } = useSession();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ground">
        <div className="w-64 space-y-3">
          <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-base font-bold text-white">
            S
          </div>
          <LoadingRows rows={2} />
        </div>
      </div>
    );
  }

  if (!user || needsBootstrap) {
    return <LoginPage />;
  }

  return (
    <Layout>
      <Suspense fallback={<LoadingRows rows={6} />}>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/opportunities" element={<OpportunitiesPage />} />
          <Route path="/opportunities/:id" element={<TrendDetailPage />} />
          <Route path="/candidates" element={<CandidatesPage />} />
          <Route path="/candidates/:id" element={<CandidateDetailPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/tokens/:mint" element={<TokenDetailPage />} />
          <Route path="/fees" element={<FeesPage />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/accounting" element={<AccountingPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/learning" element={<LearningPage />} />
          <Route path="/experiments" element={<ExperimentsPage />} />
          <Route path="/strategy" element={<StrategyPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
