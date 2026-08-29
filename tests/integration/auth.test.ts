import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../helpers.js';
import { AuthService } from '../../packages/server/src/security/auth.js';

/**
 * Sessions around a password change.
 *
 * Changing a password must end every session an attacker could be holding.
 * It must not end the one doing the changing: that session just proved it
 * knows the current password, and signing it out leaves the person holding a
 * cookie that stops working on their next request with nothing having said so.
 */

let harness: TestHarness;
let auth: AuthService;
const PASSWORD = 'quince-lantern-frosted-9412';
const NEXT_PASSWORD = 'thicket-marmalade-8817';

async function signIn(): Promise<string> {
  const session = await auth.login({ email: 'owner@example.invalid', password: PASSWORD });
  return session.token;
}

beforeEach(async () => {
  harness = createHarness();
  auth = new AuthService(harness.db, harness.audit, () => harness.clock.now());
  await auth.createUser({
    email: 'owner@example.invalid',
    password: PASSWORD,
    displayName: 'Owner',
    role: 'owner',
  });
});

afterEach(() => harness.cleanup());

describe('changing a password', () => {
  it('keeps the session that made the change signed in', async () => {
    const mine = await signIn();
    const user = await auth.authenticate(mine);
    expect(user).not.toBeNull();

    await auth.changePassword(user!.user.id, PASSWORD, NEXT_PASSWORD, mine);

    // The endpoint says "all other sessions have been signed out". This is
    // what makes that sentence true.
    expect(await auth.authenticate(mine)).not.toBeNull();
  });

  it('signs out every other session', async () => {
    const older = await signIn();
    const mine = await signIn();
    const user = await auth.authenticate(mine);

    await auth.changePassword(user!.user.id, PASSWORD, NEXT_PASSWORD, mine);

    expect(await auth.authenticate(older)).toBeNull();
    expect(await auth.authenticate(mine)).not.toBeNull();
  });

  it('signs out everything when no session is named', async () => {
    const a = await signIn();
    const b = await signIn();
    const user = await auth.authenticate(a);

    // A password reset performed on someone's behalf has no session to keep.
    await auth.changePassword(user!.user.id, PASSWORD, NEXT_PASSWORD);

    expect(await auth.authenticate(a)).toBeNull();
    expect(await auth.authenticate(b)).toBeNull();
  });

  it('actually changes the password', async () => {
    const mine = await signIn();
    const user = await auth.authenticate(mine);
    await auth.changePassword(user!.user.id, PASSWORD, NEXT_PASSWORD, mine);

    await expect(auth.login({ email: 'owner@example.invalid', password: PASSWORD })).rejects.toThrow();
    await expect(auth.login({ email: 'owner@example.invalid', password: NEXT_PASSWORD })).resolves.toBeTruthy();
  });

  it('refuses when the current password is wrong, and touches no session', async () => {
    const mine = await signIn();
    const user = await auth.authenticate(mine);

    await expect(auth.changePassword(user!.user.id, 'not-the-password-at-all', NEXT_PASSWORD, mine)).rejects.toThrow();
    expect(await auth.authenticate(mine)).not.toBeNull();
    await expect(auth.login({ email: 'owner@example.invalid', password: PASSWORD })).resolves.toBeTruthy();
  });
});

describe('demoting the last owner', () => {
  async function seedOwner(email: string): Promise<string> {
    const user = await auth.createUser({
      email,
      password: 'quince-lantern-frosted-9412',
      displayName: 'Owner',
      role: 'owner',
    });
    return user.id;
  }

  function roleOf(id: string): string {
    return (auth as unknown as { db: { $raw: { prepare: (s: string) => { get: (a: string) => { role: string } } } } }).db.$raw
      .prepare('SELECT role FROM users WHERE id = ?')
      .get(id).role;
  }

  it('refuses when they are the only one', async () => {
    const only = (await auth.listUsers()).find((u) => u.role === 'owner');
    await expect(auth.setRole(only!.id, 'analyst', 'actor')).rejects.toThrow(/last remaining owner/i);
    expect(roleOf(only!.id)).toBe('owner');
  });

  it('allows it while another owner remains', async () => {
    const second = await seedOwner('second@example.invalid');
    const first = (await auth.listUsers()).find((u) => u.role === 'owner' && u.id !== second);
    await auth.setRole(first!.id, 'analyst', 'actor');
    expect(roleOf(first!.id)).toBe('analyst');
    expect(roleOf(second)).toBe('owner');
  });

  it('never leaves the platform without one, however the demotions are ordered', async () => {
    const second = await seedOwner('third@example.invalid');
    const first = (await auth.listUsers()).find((u) => u.role === 'owner' && u.id !== second)!.id;

    // Two demotions of two owners. The check is part of the write, so whichever
    // lands second sees the first and is refused — leaving the platform
    // administrable rather than locked out of itself.
    const results = await Promise.allSettled([
      auth.setRole(first, 'analyst', 'actor'),
      auth.setRole(second, 'analyst', 'actor'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const owners = (await auth.listUsers()).filter((u) => u.role === 'owner');
    expect(owners).toHaveLength(1);
  });
});
