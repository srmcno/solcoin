import { useState, type FormEvent } from 'react';
import { Card, Note } from '@/components/ui';
import { useSession } from '@/lib/session';

/**
 * The server enforces the same minimum (BootstrapBody.password.min(12)).
 * Duplicating it here keeps a predictable failure in the form rather than
 * spending a round trip to be told the obvious.
 */
const MIN_PASSWORD_LENGTH = 12;

export function LoginPage() {
  const { needsBootstrap, login, bootstrap, secretStoreUnlocked } = useSession();

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const passwordMismatch = confirmPassword.length > 0 && confirmPassword !== password;

  const submitDisabled =
    pending ||
    email.trim().length === 0 ||
    password.length === 0 ||
    (needsBootstrap && (displayName.trim().length === 0 || passwordShort || password !== confirmPassword));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (needsBootstrap) {
      if (displayName.trim().length === 0) {
        setError('Enter the name you want to appear beside your actions in the audit log.');
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password !== confirmPassword) {
        setError('The two passwords do not match.');
        return;
      }
    }

    setPending(true);
    try {
      if (needsBootstrap) {
        await bootstrap({ email: email.trim(), password, displayName: displayName.trim() });
      } else {
        await login(email.trim(), password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-ground px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        <header className="flex flex-col items-center gap-2.5 text-center">
          <div
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-lg font-bold text-white"
            aria-hidden="true"
          >
            S
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Solcoin</h1>
          <p className="max-w-sm text-sm leading-relaxed text-ink-muted">
            {needsBootstrap
              ? 'Nobody has set this platform up yet. Create the owner account to begin.'
              : 'Trend research, launch operations and revenue accounting. Sign in to continue.'}
          </p>
        </header>

        {!secretStoreUnlocked && (
          <Note tone="warning">
            <strong className="font-semibold">The secret store is locked.</strong> The environment variable{' '}
            <code className="font-mono">SOLCOIN_MASTER_KEY</code> is not set, so the platform is running in a locked
            state: wallet keys cannot be decrypted, provider credentials cannot be read, and no credentialed feature —
            launching, fee collection, AI research — will work. The operator should set{' '}
            <code className="font-mono">SOLCOIN_MASTER_KEY</code> to a random secret of at least 16 characters in the
            server environment and restart the process. Signing in still works; almost nothing behind it will.
          </Note>
        )}

        <Card>
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div>
              <h2 className="text-base font-semibold tracking-tight text-ink">
                {needsBootstrap ? 'Create the owner account' : 'Sign in'}
              </h2>
              {needsBootstrap && (
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  This is the first and only account that can be created from this screen. It holds every permission —
                  autonomy, wallet configuration, secrets and the emergency stop — and every action it takes is recorded
                  against this name in the audit log.
                </p>
              )}
            </div>

            <div>
              <label className="label" htmlFor="login-email">
                Email
              </label>
              <input
                id="login-email"
                className="input"
                type="email"
                inputMode="email"
                autoComplete={needsBootstrap ? 'email' : 'username'}
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>

            {needsBootstrap && (
              <div>
                <label className="label" htmlFor="login-name">
                  Display name
                </label>
                <input
                  id="login-name"
                  className="input"
                  type="text"
                  autoComplete="name"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Sam Moffitt"
                />
              </div>
            )}

            <div>
              <label className="label" htmlFor="login-password">
                Password
              </label>
              <input
                id="login-password"
                className="input"
                type="password"
                autoComplete={needsBootstrap ? 'new-password' : 'current-password'}
                required
                minLength={needsBootstrap ? MIN_PASSWORD_LENGTH : undefined}
                aria-invalid={needsBootstrap && passwordShort ? true : undefined}
                aria-describedby={needsBootstrap ? 'login-password-help' : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {needsBootstrap && (
                <p
                  id="login-password-help"
                  className={`mt-1.5 text-xs leading-relaxed ${passwordShort ? 'text-warning' : 'text-ink-subtle'}`}
                >
                  At least {MIN_PASSWORD_LENGTH} characters. Length matters far more than symbols — a memorable phrase
                  of four or five words beats a short password with punctuation in it.{' '}
                  <span className="tnum">
                    {password.length}/{MIN_PASSWORD_LENGTH}
                  </span>
                  {passwordShort && ' — too short'}
                </p>
              )}
            </div>

            {needsBootstrap && (
              <div>
                <label className="label" htmlFor="login-confirm">
                  Confirm password
                </label>
                <input
                  id="login-confirm"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  required
                  aria-invalid={passwordMismatch ? true : undefined}
                  aria-describedby={passwordMismatch ? 'login-confirm-help' : undefined}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
                {passwordMismatch && (
                  <p id="login-confirm-help" className="mt-1.5 text-xs text-warning">
                    The two passwords do not match.
                  </p>
                )}
              </div>
            )}

            {error && (
              <p
                role="alert"
                className="rounded-lg border border-negative-dim bg-negative-dim/20 px-3 py-2 text-xs leading-relaxed text-negative"
              >
                {error}
              </p>
            )}

            <button type="submit" className="btn btn-primary w-full" disabled={submitDisabled}>
              {pending
                ? needsBootstrap
                  ? 'Creating account…'
                  : 'Signing in…'
                : needsBootstrap
                  ? 'Create owner account'
                  : 'Sign in'}
            </button>
          </form>
        </Card>

        <p className="text-center text-xs leading-relaxed text-ink-subtle">
          {needsBootstrap
            ? 'After setup the platform starts in research-only mode. Nothing is spent on-chain until you move it up the phase ladder in Settings.'
            : 'Sessions are held in an HttpOnly cookie and expire on their own. Close the tab to leave it where it is.'}
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
