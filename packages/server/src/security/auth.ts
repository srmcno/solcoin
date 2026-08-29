import { eq, sql } from 'drizzle-orm';
import { ROLE_PERMISSIONS, roleHasPermission, type Permission, type UserRole } from '@solcoin/shared';
import { AppError } from '../core/errors.js';
import { newId, newToken } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import { AUDIT_ACTIONS, type AuditLog } from './audit.js';
import { hashPassword, safeEqual, sha256, verifyPassword } from './crypto.js';

/**
 * Authentication and session management.
 *
 * Choices worth stating:
 *  - Sessions are opaque server-side records, not JWTs. Revocation must be
 *    immediate for a system that can spend money, and a stateless token cannot
 *    be revoked without the state a JWT was chosen to avoid.
 *  - Only the SHA-256 of a session token is stored, so a database leak does not
 *    hand over live sessions.
 *  - Failed logins are counted and lock the account temporarily. The lockout is
 *    on the account, not the IP, because the threat here is credential stuffing
 *    against a known operator, not volumetric abuse.
 *  - Login timing is equalised: an unknown email still performs a password
 *    verification against a dummy hash, so response time does not reveal which
 *    addresses exist.
 */

export const SESSION_COOKIE = 'solcoin_session';
export const CSRF_HEADER = 'x-csrf-token';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  permissions: Permission[];
}

export interface SessionResult {
  token: string;
  csrfToken: string;
  expiresAt: number;
  user: AuthenticatedUser;
}

/** A constant, valid scrypt record used to equalise timing for unknown users. */
let dummyPasswordRecord: { hash: string; params: string } | null = null;

export class AuthService {
  private readonly log = componentLogger('auth');

  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly now: () => number = Date.now,
  ) {}

  async createUser(input: {
    email: string;
    password: string;
    displayName: string;
    role: UserRole;
    actorId?: string;
  }): Promise<AuthenticatedUser> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AppError('validation_failed', 'That does not look like a valid email address.');
    }
    assertPasswordStrength(input.password);

    const existing = this.db.$raw.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) throw new AppError('conflict', 'An account with that email already exists.');

    const record = await hashPassword(input.password);
    const id = newId('usr', this.now());

    this.db.$raw
      .prepare(
        `INSERT INTO users (id, email, display_name, role, password_hash, password_params, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,1,?,?)`,
      )
      .run(id, email, input.displayName.trim().slice(0, 120), input.role, record.hash, record.params, this.now(), this.now());

    this.audit.record({
      actorType: input.actorId ? 'user' : 'system',
      actorId: input.actorId ?? null,
      action: AUDIT_ACTIONS.userCreated,
      targetType: 'user',
      targetId: id,
      parameters: { email, role: input.role },
    });

    return { id, email, displayName: input.displayName, role: input.role, permissions: ROLE_PERMISSIONS[input.role] };
  }

  async login(input: {
    email: string;
    password: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<SessionResult> {
    const email = input.email.trim().toLowerCase();
    const row = this.db.$raw.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | Record<string, unknown>
      | undefined;

    if (!row) {
      // Equalise timing so a probe cannot enumerate accounts.
      dummyPasswordRecord ??= await hashPassword(newToken(24));
      await verifyPassword(input.password, dummyPasswordRecord);
      this.audit.record({
        actorType: 'system',
        action: AUDIT_ACTIONS.userLoginFailed,
        targetType: 'user',
        targetId: null,
        result: 'failed',
        resultDetail: 'unknown account',
        ipAddress: input.ipAddress ?? null,
      });
      throw new AppError('unauthorized', 'Incorrect email or password.');
    }

    const lockedUntil = row.locked_until !== null ? Number(row.locked_until) : 0;
    if (lockedUntil > this.now()) {
      throw new AppError(
        'forbidden',
        `This account is temporarily locked after repeated failed sign-ins. Try again in ${Math.ceil((lockedUntil - this.now()) / 60_000)} minutes.`,
      );
    }
    if (!row.active) throw new AppError('forbidden', 'This account has been deactivated.');

    const valid = await verifyPassword(input.password, {
      hash: String(row.password_hash),
      params: String(row.password_params),
    });

    if (!valid) {
      const failed = Number(row.failed_login_count ?? 0) + 1;
      const lock = failed >= MAX_FAILED_LOGINS ? this.now() + LOCKOUT_MS : null;
      this.db.$raw
        .prepare('UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?')
        .run(failed, lock, this.now(), row.id);
      this.audit.record({
        actorType: 'user',
        actorId: String(row.id),
        action: AUDIT_ACTIONS.userLoginFailed,
        targetType: 'user',
        targetId: String(row.id),
        result: 'failed',
        resultDetail: `attempt ${failed}`,
        ipAddress: input.ipAddress ?? null,
      });
      throw new AppError('unauthorized', 'Incorrect email or password.');
    }

    this.db.$raw
      .prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?')
      .run(this.now(), this.now(), row.id);

    const session = this.createSession(String(row.id), input.ipAddress, input.userAgent);
    const role = String(row.role) as UserRole;

    this.audit.record({
      actorType: 'user',
      actorId: String(row.id),
      actorLabel: String(row.display_name),
      action: AUDIT_ACTIONS.userLogin,
      targetType: 'user',
      targetId: String(row.id),
      ipAddress: input.ipAddress ?? null,
    });

    return {
      ...session,
      user: {
        id: String(row.id),
        email: String(row.email),
        displayName: String(row.display_name),
        role,
        permissions: ROLE_PERMISSIONS[role] ?? [],
      },
    };
  }

  private createSession(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): { token: string; csrfToken: string; expiresAt: number } {
    const token = newToken(32);
    const csrfToken = newToken(24);
    const expiresAt = this.now() + SESSION_TTL_MS;

    this.db.$raw
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, csrf_token, user_agent, ip_address, expires_at, created_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        newId('ses', this.now()),
        userId,
        sha256(token),
        csrfToken,
        userAgent?.slice(0, 300) ?? null,
        ipAddress ?? null,
        expiresAt,
        this.now(),
        this.now(),
      );

    return { token, csrfToken, expiresAt };
  }

  /** Resolve a session token to a user, refreshing its last-seen timestamp. */
  async authenticate(token: string): Promise<{ user: AuthenticatedUser; csrfToken: string } | null> {
    if (!token) return null;
    const row = this.db.$raw
      .prepare(
        `SELECT s.id AS session_id, s.csrf_token, s.expires_at, s.revoked_at,
                u.id, u.email, u.display_name, u.role, u.active
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`,
      )
      .get(sha256(token)) as Record<string, unknown> | undefined;

    if (!row) return null;
    if (row.revoked_at) return null;
    if (Number(row.expires_at) < this.now()) return null;
    if (!row.active) return null;

    // Throttle the write: updating on every request would turn a read-heavy
    // dashboard into a write-heavy one for no benefit.
    this.db.$raw
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?')
      .run(this.now(), row.session_id, this.now() - 60_000);

    const role = String(row.role) as UserRole;
    return {
      user: {
        id: String(row.id),
        email: String(row.email),
        displayName: String(row.display_name),
        role,
        permissions: ROLE_PERMISSIONS[role] ?? [],
      },
      csrfToken: String(row.csrf_token),
    };
  }

  async logout(token: string, actorId?: string): Promise<void> {
    this.db.$raw.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(this.now(), sha256(token));
    if (actorId) {
      this.audit.record({ actorType: 'user', actorId, action: AUDIT_ACTIONS.userLogout, targetType: 'user', targetId: actorId });
    }
  }

  async revokeAllSessions(userId: string): Promise<number> {
    return this.db.$raw
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(this.now(), userId).changes;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const row = this.db.$raw.prepare('SELECT password_hash, password_params FROM users WHERE id = ?').get(userId) as
      | { password_hash: string; password_params: string }
      | undefined;
    if (!row) throw new AppError('not_found', 'Account not found.');

    const valid = await verifyPassword(currentPassword, { hash: row.password_hash, params: row.password_params });
    if (!valid) throw new AppError('unauthorized', 'The current password is incorrect.');

    assertPasswordStrength(newPassword);
    const record = await hashPassword(newPassword);
    this.db.$raw
      .prepare('UPDATE users SET password_hash = ?, password_params = ?, updated_at = ? WHERE id = ?')
      .run(record.hash, record.params, this.now(), userId);

    // Changing a password invalidates every other session: if the change was
    // prompted by a suspected compromise, leaving old sessions live defeats it.
    await this.revokeAllSessions(userId);
  }

  async setRole(userId: string, role: UserRole, actorId: string): Promise<void> {
    const previous = this.db.$raw.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
    if (!previous) throw new AppError('not_found', 'Account not found.');

    // The last owner cannot be demoted, or the platform becomes unadministrable.
    if (previous.role === 'owner' && role !== 'owner') {
      const owners = this.db.$raw.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1`).get() as {
        n: number;
      };
      if (owners.n <= 1) throw new AppError('conflict', 'The last remaining owner cannot be demoted.');
    }

    this.db.$raw.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, this.now(), userId);
    this.audit.record({
      actorType: 'user',
      actorId,
      action: AUDIT_ACTIONS.userRoleChanged,
      targetType: 'user',
      targetId: userId,
      parameters: { from: previous.role, to: role },
    });
  }

  async listUsers(): Promise<Array<Omit<AuthenticatedUser, 'permissions'> & { active: boolean; lastLoginAt: number | null; createdAt: number }>> {
    const rows = this.db.$raw
      .prepare('SELECT id, email, display_name, role, active, last_login_at, created_at FROM users ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      email: String(r.email),
      displayName: String(r.display_name),
      role: String(r.role) as UserRole,
      active: Boolean(r.active),
      lastLoginAt: r.last_login_at !== null ? Number(r.last_login_at) : null,
      createdAt: Number(r.created_at),
    }));
  }

  userCount(): number {
    const row = this.db.$raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return row.n;
  }

  /** Remove expired and revoked sessions. */
  pruneSessions(): number {
    return this.db.$raw
      .prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)')
      .run(this.now(), this.now() - 7 * 24 * 3_600_000).changes;
  }

  static assertPermission(user: AuthenticatedUser, permission: Permission): void {
    if (!roleHasPermission(user.role, permission)) {
      throw new AppError('forbidden', `Your role (${user.role}) does not permit "${permission.replace(/_/g, ' ')}".`);
    }
  }

  static verifyCsrf(expected: string, provided: string | undefined): void {
    if (!provided || !safeEqual(expected, provided)) {
      throw new AppError('forbidden', 'The CSRF token is missing or invalid. Reload the page and try again.');
    }
  }
}

/**
 * Password requirements.
 *
 * Length over composition rules: a 12-character passphrase beats an
 * eight-character password with a symbol, and composition rules mostly produce
 * predictable substitutions.
 */
export function assertPasswordStrength(password: string): void {
  if (password.length < 12) {
    throw new AppError('validation_failed', 'Passwords must be at least 12 characters. Length matters more than symbols.');
  }
  if (password.length > 256) {
    throw new AppError('validation_failed', 'Passwords must be at most 256 characters.');
  }
  const common = ['password', '123456789', 'qwertyuiop', 'letmein', 'solana', 'solcoin', 'administrator'];
  const lower = password.toLowerCase();
  if (common.some((c) => lower.includes(c))) {
    throw new AppError('validation_failed', 'That password contains a very common phrase. Choose something less guessable.');
  }
}
