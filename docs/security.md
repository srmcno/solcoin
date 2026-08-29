# Security

What this platform defends against, how, and — just as important — what it does
not defend against. Everything below describes code that exists today. Where a
control is partial, unwired or known-weak, that is stated in place rather than
left for you to discover.

The platform holds a private key that can spend real money, reads text written
by anonymous strangers, feeds that text to language models, and can act without
a human in the loop. Those four facts drive every decision in this document.

---

## Threat model

### What the design takes seriously

| Threat | Realistic form | Primary control |
|---|---|---|
| **Leaked logs** | A stack trace in an issue tracker, a log aggregator with wide read access, a pasted error message | Two-level redaction in `core/logger.ts` and `core/errors.ts`; the error handler never returns a stack trace |
| **Stolen database file** | A backup bucket, a copied `data/solcoin.db`, a snapshot on a decommissioned disk | Every credential and the wallet key are AES-256-GCM ciphertext under a key that lives only in the environment |
| **Prompt injection from scraped content** | A Reddit post, a news headline or token metadata written specifically to hijack the model reading it | Sanitisation, scored detection, nonce-fenced envelopes (`shared/src/safety/prompt-injection.ts`) |
| **A malfunctioning agent** | A model that decides to launch forty tokens, a retry loop that burns rent, a provider returning nonsense | The guard service: hard ceilings, database-derived counters, a consecutive-failure breaker, a global stop |
| **Credential stuffing** | An operator's reused password tried against a known deployment | Per-account lockout, scrypt password hashing, timing-equalised login, a tighter rate limit on `/api/auth/login` |
| **XSS and CSRF** | A crafted trend title rendered in the dashboard; a hostile page posting to a logged-in operator's API | CSP with no `'unsafe-inline'` for script, HttpOnly/SameSite cookies, a per-session CSRF token on every mutating request |
| **SSRF via operator-supplied feeds** | An RSS URL pasted from a support ticket that points at `169.254.169.254` | `validateFeedUrl` plus a DNS-resolution check in `providers/trends/rss.ts` |

### What it does not defend against

Stated plainly, because a security document that implies more coverage than
exists is worse than none.

- **Hardware-level compromise.** There is no HSM, no secure enclave, no TPM
  binding. The master key is an environment variable in an ordinary process.
- **A compromised process during a signing window.** Inside `withSigner`, the
  Ed25519 secret key exists as plaintext bytes in the V8 heap. Anything with
  code execution or a core dump at that moment gets the key.
- **A malicious operator.** Anyone with `transfer_funds` can export the private
  key, and anyone with filesystem access to the database can rewrite the audit
  chain (see [Limits of the audit chain](#limits-of-the-audit-chain)). The audit
  log makes an operator's actions *reconstructable*, not *impossible*.
- **A compromised dependency.** The security-critical code deliberately uses
  only Node's built-in `crypto`, but the wider process runs Fastify, Drizzle,
  `@solana/web3.js` and their trees. A malicious package in that set can read
  `process.env`.
- **Denial of service.** Rate limits exist to protect the platform's own budgets
  and to slow credential grinding. They are not a DoS mitigation, and the
  process is single-node with an embedded database.
- **The Solana network, the Pump programs, or the RPC provider.** Their
  correctness is assumed.

The intended deployment is one operator, one machine, bound to loopback
(`HOST` defaults to `127.0.0.1`), behind whatever perimeter that operator
already trusts.

---

## Key custody

### The scheme

Two primitives, both from `node:crypto`, both in
`packages/server/src/security/crypto.ts`:

| | Value |
|---|---|
| Cipher | AES-256-GCM, 12-byte random IV per encryption, 16-byte auth tag |
| KDF | scrypt, `N = 2^15` (32 768), `r = 8`, `p = 1`, `maxmem = 96 MiB` |
| Salt | 16 random bytes, generated fresh for **every** encryption |
| Key length | 32 bytes for encryption; 64 bytes for password hashes |

`SCRYPT_PARAMS` is a single exported constant used for both encryption-key
derivation and password hashing. The parameters target roughly 100 ms on a
modern CPU, which is the right trade-off for an interactive unlock: high enough
to make offline guessing expensive, low enough that a login does not feel
broken.

GCM matters as much as AES here. The ciphertext is authenticated, so a modified
database row fails to decrypt rather than silently yielding garbage that gets
used as a key.

Node's own `crypto` is used rather than a library on purpose. This is the code
protecting wallet keys, and every additional package on that path is additional
supply-chain surface.

### The double envelope on the wallet keystore

The operating wallet's secret key is encrypted twice, under two independently
derived keys:

```
 SOLCOIN_MASTER_KEY  (environment, never written to disk by this app)
        │
        ├── passphrase = "wallet:" + SOLCOIN_MASTER_KEY
        │        └── scrypt ──▶ key ──▶ AES-256-GCM ──▶ EncryptedBlob
        │                                                    │
        │                                  KeystoreRecord { publicKey, custody,
        │                                                   encrypted, label }
        │                                                    │  JSON
        │                                                    ▼
        └── passphrase = SOLCOIN_MASTER_KEY
                 └── scrypt ──▶ key ──▶ AES-256-GCM ──▶ secrets row
                                                    key = wallet.operating.keystore
```

The inner envelope is applied by `WalletKeystore.persist`; the outer one by
`SecretStore.set`, which does not know or care that the plaintext it was handed
is itself a ciphertext. The reason is containment: a bug that leaks a secret
row — a debug endpoint, a `SELECT *` in a log line, an over-eager export — still
does not leak the wallet.

**A sharp edge, stated plainly: `rotateMasterKey` re-wraps only the outer
envelope.** It decrypts each `secrets` row under the old master key and
re-encrypts the same plaintext under the new one. For the keystore row that
plaintext is the JSON `KeystoreRecord`, whose `encrypted` blob is still sealed
under `"wallet:" + oldMasterKey`. `WalletKeystore.masterPassphrase()` derives
`"wallet:" + process.env.SOLCOIN_MASTER_KEY` at use time, so once the operator
switches to the new key the inner envelope no longer opens and `withSigner`
fails. (The docstring on `masterPassphrase` claims rotation re-wraps both
layers; the code in `SecretStore.rotateMasterKey` does not do that.) Export the
wallet secret key, rotate, then re-import it — or treat rotation as unsupported
for the keystore until the inner layer is rotated too.

Note the asymmetry: each layer uses its own random salt and its own random IV,
so the two derived keys are unrelated even though both come from the same master
key string.

### Where plaintext exists, and for how long

| Material | Lives where | For how long |
|---|---|---|
| `SOLCOIN_MASTER_KEY` | `process.env` | The process lifetime |
| Wallet Ed25519 secret key | The V8 heap, inside `withSigner` | One signing call; wiped in a `finally` |
| Decrypted credential (API key, webhook URL) | `SecretStore`'s in-memory cache | 60 seconds (`cacheTtlMs`) |
| Session token | The operator's cookie jar | 7 days; only its SHA-256 is stored server-side |

`withSigner` is the *only* path to plaintext key material. It decrypts, builds a
`Keypair`, runs the caller's function, and wipes both the intermediate buffer and
`keypair.secretKey` on the way out. It also performs an integrity check that is
cheap and worth having: the decrypted key's public key must equal the address
stored alongside it, otherwise it throws rather than signing with a key that is
not the one you think it is.

The contract on `fn` is documented and unenforced: it must not retain the
keypair. Nothing stops a future call site from closing over it.

### Why the key never crosses HTTP

There is no API route that returns the secret key as part of normal operation.
`getPublicKey()` is what the routes use, and `getRecord()` is read only inside
`wallet.service.ts`, which takes the public key and the custody mode off it; the
record's `encrypted` blob is never rendered to a client. Signing happens
server-side, inside the process, and the route sees only a transaction
signature.

The single exception is the deliberate export path.

### The export path

```
POST /api/wallet/export
  { "confirmation": "I understand this reveals my private key" }
```

Three controls, all of them present in the code:

1. `requirePermission(request, 'transfer_funds')` — owner or admin only.
2. `exportSecretKey` compares the confirmation string against the exact literal
   `I understand this reveals my private key`. Anything else throws `forbidden`.
   This is not a checkbox; it cannot be clicked past by accident.
3. The route writes an audit entry (`wallet.exported`) with the actor's id,
   display name, the wallet address and the request IP, before returning.

The response carries the key base64-encoded alongside an explicit warning that
the export was recorded. An export is indistinguishable from a theft after the
fact, so the log entry is the whole point.

### What wiping a buffer does and does not achieve

`wipe()` calls `buffer.fill(0)`. The docstring in `crypto.ts` is honest about
what that buys, and this document will not improve on it:

> This is genuinely best-effort: V8 may have copied the bytes elsewhere, and a
> heap dump can still contain them. It reduces the window, it does not close it.

Concretely: `Keypair.fromSecretKey` may copy, garbage-collected intermediates
are not reachable to zero, and a `Buffer` that was resized or sliced may leave
detached copies. Wiping shortens the interval during which a heap snapshot
contains the key. It does not make that interval zero.

The real mitigation is not holding the key at all. `watch_only` custody registers
an address whose key lives elsewhere; `canSign()` returns false, and `withSigner`
refuses with a message naming the custody mode. `external` custody is defined in
the `WalletCustody` union for a dedicated signer.

---

## The secret store

`packages/server/src/security/secrets.ts`. Every credential the platform needs
lives here as ciphertext: AI provider keys, RPC URLs and keys, trend-source
credentials, IPFS tokens, notification webhooks, and the wallet keystore.

**Per-secret salts.** `encryptWithPassphrase` generates 16 fresh random bytes per
call, so every secret has its own scrypt derivation. Two credentials with the
same value produce unrelated ciphertext, and cracking one derived key does not
help with the next.

**In-memory TTL caching.** Decrypted values are cached for 60 seconds. The
alternative — decrypt on every use — would run scrypt on the hot path of every
provider call. The alternative in the other direction, cache forever, would mean
a long-running process holds every credential in plaintext indefinitely. Sixty
seconds is the compromise, and `set` and `delete` both evict eagerly so a
rotation takes effect immediately.

**Last-used tracking.** Every successful read fires an unawaited
`UPDATE secrets SET last_used_at = ?`. This is deliberately fire-and-forget: it
must not slow down or fail a credential read. The point is operational —
`GET /api/system/secrets` lists key, category, hint, timestamps and
`lastUsedAt`, so an operator can see which credentials are actually in use and
revoke the rest. It never returns plaintext.

**Hints, not values.** `credentialHint` stores a display fragment
(`sk-ant-…a91f`): the first few characters and the last four, with the middle
elided. Enough to tell two keys apart in the UI, not enough to be a credential.

**Locked degrades, it does not crash.** `unlocked` is true only when
`SOLCOIN_MASTER_KEY` is present and at least 16 characters. When locked, `get`
returns `null` rather than throwing, and callers report the feature as
unconfigured. `set` throws `locked` with a message naming the environment
variable. A missing credential must disable a feature, never take down the
platform.

**Decryption failure is diagnosed, not swallowed silently.** A failed decrypt is
almost always a changed master key, and the log line says exactly that.

### Master-key rotation

`rotateMasterKey(newMasterKey)` decrypts every row under the current key,
re-encrypts each under the new one, then writes all of them inside a single
synchronous SQLite transaction. The rejected minimum length is the same 16
characters.

The transaction is the whole design. A partial rotation is the one failure mode
worse than losing a credential: half the store readable under the old key and
half under the new, with no single key that opens both, and no way to tell which
is which without trying. Every row moves or none does.

**Not yet wired to an interface, and not covered by a test.** `rotateMasterKey`
has no HTTP route and no CLI command — `src/cli/` contains only `doctor.ts` and
`migrate.ts` — and `grep` finds no call site anywhere in `packages/` or
`tests/`. Rotating today means writing a short script against `SecretStore`, or
re-entering credentials under a new key. Given the keystore caveat above, the
second option is the safer one.

---

## Authentication

`packages/server/src/security/auth.ts`.

### Opaque server-side sessions, not JWTs

Sessions are rows in a `sessions` table. The token is 32 random bytes from
`randomBytes`, base64url-encoded (`newToken(32)`).

The reason is revocation. This platform can spend money; when an operator
suspects a compromise, sign-out must be immediate and total. A stateless token
cannot be revoked without maintaining exactly the server-side state a JWT is
chosen to avoid — at which point you have a session table with extra
cryptography bolted on. `revokeAllSessions(userId)` is one `UPDATE`.
`changePassword` calls it unconditionally, because leaving old sessions live
after a password change prompted by a suspected compromise defeats the change.

Only `sha256(token)` is stored. A leaked database yields no live sessions.

Other details worth knowing:

- **TTL: 7 days** (`SESSION_TTL_MS`), also set as the cookie `maxAge`.
- **`last_seen_at` is throttled** to at most one write per 60 seconds per
  session. Updating on every request would turn a read-heavy polling dashboard
  into a write-heavy one for no benefit.
- **`authenticate` re-checks four things** on every request: the row exists,
  `revoked_at` is null, `expires_at` is in the future, and the *user* is still
  active. Deactivating an account takes effect on that account's next request.
- **`pruneSessions()`** deletes expired sessions and revoked ones older than
  seven days.
- The `csrf_token` column is stored in the clear, unlike the token hash. It is
  useless without the session token, but it is worth knowing that a database
  leak exposes it.

### Password hashing

scrypt with the same `SCRYPT_PARAMS` (`N = 2^15`, `r = 8`, `p = 1`,
`maxmem = 96 MiB`), a fresh 16-byte salt, and a 64-byte output. The salt and the
full parameter set are serialised into the `password_params` column as JSON
alongside the hash.

Storing the parameters per record means they can be raised later without
invalidating existing hashes — `verifyPassword` reads the parameters from the
record rather than assuming the current constant. There is, however, **no
rehash-on-successful-login upgrade**: raising `SCRYPT_PARAMS` strengthens new and
changed passwords only.

Comparison is `timingSafeEqual`, with a length check first that returns false
without leaking through the comparison itself.

### Account lockout

| Constant | Value |
|---|---|
| `MAX_FAILED_LOGINS` | 8 |
| `LOCKOUT_MS` | 15 minutes |

The lockout is on the **account**, not the IP, because the threat modelled here
is credential stuffing against a known operator, not volumetric abuse — and an
attacker with a botnet has as many IPs as it wants.

Two behaviours worth understanding before you deploy:

- `failed_login_count` is reset **only by a successful login**, never by elapsed
  time. So after the eighth failure the account locks for 15 minutes; when that
  expires, the next wrong password takes the count to nine, which is still ≥ 8,
  and locks it again. In practice the account settles into one attempt per 15
  minutes indefinitely. That is excellent against grinding and genuinely
  unpleasant for an operator who has forgotten their password.
- **There is no password-reset route.** `changePassword` requires the current
  password. An owner who is locked out and cannot remember their password has no
  recovery path through the API; recovery means editing the database directly.

### Login timing equalisation

An unknown email address still performs a full scrypt verification against a
constant dummy record, lazily created once per process from `hashPassword(newToken(24))`:

```ts
if (!row) {
  dummyPasswordRecord ??= await hashPassword(newToken(24));
  await verifyPassword(input.password, dummyPasswordRecord);
  // ... audit the failure, then throw the same error as a wrong password
}
```

Both branches throw the identical message, `Incorrect email or password.`, so
neither the response body nor the response time reveals which addresses exist.
Both branches also write a `user.login_failed` audit entry — the unknown-account
case with `resultDetail: 'unknown account'` and a null target.

### Password policy

Two rules and a blocklist, in `assertPasswordStrength`:

- At least **12 characters**, at most 256.
- Must not contain any of `password`, `123456789`, `qwertyuiop`, `letmein`,
  `solana`, `solcoin`, `administrator` (case-insensitive substring match).

No composition requirements — no "must contain a symbol". The reasoning is in
the code and it is the right reasoning: a 12-character passphrase beats an
eight-character password with a `$` in it, and composition rules mostly produce
predictable substitutions (`Password1!`) that an attacker's rule set already
covers. Length is the variable that actually moves the search space.

The upper bound of 256 exists because scrypt cost scales with input handling and
an unbounded password is a cheap way to make a login expensive.

---

## Authorisation

Four roles and sixteen permissions, defined in
`packages/shared/src/domain/enums.ts`. `owner` gets every permission;
`admin` gets every permission except `manage_users`.

| Permission | owner | admin | analyst | viewer |
|---|:--:|:--:|:--:|:--:|
| `view` | ● | ● | ● | ● |
| `run_research` | ● | ● | ● | |
| `generate_concepts` | ● | ● | ● | |
| `approve_candidate` | ● | ● | | |
| `reject_candidate` | ● | ● | ● | |
| `launch_token` | ● | ● | | |
| `collect_fees` | ● | ● | | |
| `transfer_funds` | ● | ● | | |
| `edit_wallet_config` | ● | ● | | |
| `edit_limits` | ● | ● | | |
| `edit_autonomy` | ● | ● | | |
| `manage_users` | ● | | | |
| `manage_experiments` | ● | ● | ● | |
| `view_audit` | ● | ● | ● | |
| `export_accounting` | ● | ● | ● | |
| `emergency_stop` | ● | ● | | |

The asymmetry in the analyst row is intentional: an analyst can **reject** a
candidate but not approve one. Stopping something is not the same authority as
starting it.

`manage_users` is owner-only, and `setRole` refuses to demote the last active
owner — otherwise the platform becomes unadministrable with no recovery path.

`transfer_funds` is what gates the private-key export, so treat it as the
highest-value permission after `manage_users`.

### Settings permissions are checked per changed path

This is the part that is easy to get wrong and is worth calling out.
`PATCH /api/settings` takes an arbitrary nested patch object. Changing a
notification preference and raising the daily SOL spend limit arrive at the same
URL with the same method. Checking a permission on the endpoint would give both
the same authority.

Instead, `settings.routes.ts` flattens the patch to dotted paths with
`collectPaths` and checks each family that the patch actually touches:

| Path prefix | Permission required |
|---|---|
| `autonomy.*` | `edit_autonomy` |
| `limits.*`, `qualityGate.*` | `edit_limits` |
| `wallet.*`, `execution.*` | `edit_wallet_config` |
| `emergencyStop` | `emergency_stop` |
| anything else | `edit_limits` |

A patch touching several families must satisfy every corresponding permission.
The fall-through in the last row means that in practice only owners and admins
can change any setting at all — an analyst has `view` but not `edit_limits`, so
even a notification-preference change is refused. That is a coarse outcome of an
otherwise fine-grained mechanism; if you want a lower-privileged settings role,
that is where to add it.

Separately, `SENSITIVE_SETTING_PATHS` in
`packages/shared/src/domain/settings.ts` marks 19 paths (the launch,
fee-collection and wallet-transfer autonomy toggles, network, phase, dev-buy
size, the five SOL spend and launch limits plus the balance floor, the treasury
address and the auto-sweep flag, four quality-gate thresholds, and the emergency
stop — note that `limits.maxAiSpendUsdPerDay` is *not* on the list) whose
changes are reported back in the response as `sensitiveChanges` and recorded
with before and after values in `setting_history` and the audit log.

---

## Web security

`packages/server/src/http/server.ts`.

### Cookies

Set in `auth.routes.ts` on login and in `system.routes.ts` on bootstrap:

```ts
reply.setCookie(SESSION_COOKIE, session.token, {
  httpOnly: true,
  sameSite: 'lax',
  secure: container.env.isProduction,
  path: '/',
  maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
});
```

`httpOnly` means browser JavaScript cannot read the session, so an XSS that gets
through still cannot exfiltrate it as a durable credential. `sameSite: 'lax'`
means a cross-site form post or image tag does not carry the cookie. `secure` is
conditional on `NODE_ENV === 'production'`, because a development deployment on
plain `http://127.0.0.1` would otherwise never receive its own cookie back.

### CSRF

`SameSite` is necessary but not sufficient — behaviour varies across browsers
and proxy setups, and `lax` still permits top-level cross-site GET navigation.
So every mutating request additionally carries a per-session CSRF token in the
`x-csrf-token` header:

```ts
if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
  AuthService.verifyCsrf(request.csrfToken ?? '', request.headers[CSRF_HEADER] as string | undefined);
}
```

The token is 24 random bytes generated when the session is created, stored on the
session row, and returned by `POST /api/auth/login` and `GET /api/auth/session`.
Comparison is `safeEqual`, which is `timingSafeEqual` behind a length guard.

This check runs in the global `preHandler` for every `/api/` route that is not on
the public list, so a new route is protected by default. Public routes opt out
explicitly by exact `METHOD:/path` key rather than by prefix, which is the
mistake this arrangement is designed to prevent:

```
POST:/api/auth/login          GET:/api/system/bootstrap
GET:/api/auth/session         POST:/api/system/bootstrap
GET:/api/health
```

`POST /api/system/bootstrap` is public because it must work before any account
exists; it refuses outright once `userCount() > 0` and is rate limited to 5
requests per 10 minutes. `GET /api/system/bootstrap` reveals only whether setup
is complete, whether the secret store is unlocked, and whether onboarding
finished.

### Content-Security-Policy

Set through `@fastify/helmet`:

| Directive | Value |
|---|---|
| `default-src` | `'self'` |
| `script-src` | `'self'` |
| `style-src` | `'self' 'unsafe-inline'` |
| `img-src` | `'self' data: https:` |
| `font-src` | `'self' data:` |
| `connect-src` | `'self'` |
| `object-src` | `'none'` |
| `frame-ancestors` | `'none'` |
| `base-uri` | `'self'` |
| `form-action` | `'self'` |

**`'unsafe-inline'` is allowed for styles and never for scripts**, and the
distinction is not cosmetic. An inline `<style>` cannot execute code; the worst a
CSS injection achieves in this context is a defacement or a layout attack. An
inline `<script>` is arbitrary code execution in the operator's authenticated
session, on a page that can spend SOL. The dashboard is a compiled Vite bundle
served from the same origin, so it has no need for inline script at all, and
refusing it is the single most effective XSS mitigation available.

Vite does inject a style element for the initial paint, which is why the styles
concession exists. If you remove that need, tighten `style-src` to `'self'`.

Two directives are looser than the rest and you should know why:
`img-src` permits any `https:` origin, so remote token artwork and source
favicons render; and `frame-ancestors 'none'` plus `object-src 'none'` close
clickjacking and plugin-embedding entirely.

HSTS (`max-age=31536000`, `includeSubDomains`) is enabled only when
`NODE_ENV === 'production'`, so a local development deployment does not pin
itself to HTTPS.

### CORS

Disabled unless `CORS_ORIGINS` is set. The default deployment serves the
dashboard from the same origin as the API and needs none. When configured, only
exact-match origins in the list receive `access-control-allow-origin`, with
credentials allowed and `vary: Origin` set.

### Rate limiting

| Scope | Limit |
|---|---|
| Global, every route | 600 requests per minute per IP |
| `POST /api/auth/login` | 10 requests per 5 minutes |
| `POST /api/system/bootstrap` | 5 requests per 10 minutes |

The login limit is much tighter for the obvious reason: it is the endpoint an
attacker grinds, and legitimate users sign in rarely. It composes with the
per-account lockout — the rate limit slows an attacker spraying many accounts
from one address; the lockout stops one account being ground from many addresses.

Keying is `request.ip`. **This is only meaningful if `TRUST_PROXY` is correct.**
It defaults to `false`, so behind a reverse proxy every request appears to come
from the proxy's address and all clients share a single bucket. Set
`TRUST_PROXY=true` when, and only when, the proxy in front is one you control and
that overwrites `X-Forwarded-For`.

The body limit is 2 MiB.

### Errors never leak

`setErrorHandler` has three branches:

- **`ZodError`** → 400 with the field paths and validation messages. Safe: these
  are the client's own field names.
- **`AppError`** → the error's own status code, its stable machine-readable
  `code`, and its message. These messages are written to be read by a human
  operator, so they say what to do.
- **Anything else** → for status ≥ 500 the client gets a fixed string,
  `Something went wrong handling that request. The details are in the server
  log.` For status < 500 the message is passed through `redactSecrets` first.

No branch returns a stack trace. Server-side, 5xx errors log
`safeErrorText(error)` — redacted and truncated to 800 characters — along with a
redacted URL. The `onResponse` hook logs only requests that failed (status ≥ 400)
or were slow (> 1500 ms); logging every dashboard poll would bury the entries
that matter.

The 404 handler distinguishes `/api/` paths (JSON `not_found`) from everything
else (fall through to the single-page app), so the dashboard's client-side
routing works without an API route becoming a silent HTML response.

---

## Prompt injection

`packages/shared/src/safety/prompt-injection.ts`.

### The doctrine

**External content is data, never instructions.** The platform reads Reddit
posts, news headlines, Bluesky posts, token metadata and other text written by
strangers, then shows that text to a language model that has been given a task.
Everything below follows from refusing to let that text change the task.

### Layer 1 — sanitisation

`sanitiseExternalText(input, maxLength = 2000)` removes or neutralises:

- **C0/C1 control characters** (`U+0000`-`U+0008`, `U+000B`-`U+001F`,
  `U+007F`-`U+009F`) - replaced with a space. Tab and newline are kept
  because they carry meaning.
- **Invisible characters**: zero-width space through to the RTL mark
  (`U+200B`-`U+200F`), bidirectional overrides (`U+202A`-`U+202E`), word
  joiners and invisible operators (`U+2060`-`U+2064`), isolate and
  interlinear-annotation marks (`U+2066`-`U+2069`), the BOM (`U+FEFF`) and
  the soft hyphen (`U+00AD`) - deleted outright. These are the standard
  carriers for a payload that a human reviewer cannot see and a model reads
  perfectly.
- **Chat role delimiters**: `<system>`, `</assistant>`, `<instructions>`,
  `<tool_use>`, `<function_calls>` and friends become the literal `[tag]`;
  `[INST]`, `[/system]` and similar bracket forms likewise; a line beginning
  `System:` becomes `System -`.
- **Code fences**: runs of three or more backticks collapse to one, so injected
  "instructions" cannot masquerade as structured output the model should follow.
- Line endings normalised, runs of blank lines collapsed, then truncated to
  `maxLength` with a `…[truncated]` marker.

### Layer 2 — scored detection

`detectInjection(text)` runs 22 weighted patterns. Weight 1.0 goes to the
unambiguous ones: instruction override, funds exfiltration, key exfiltration,
address substitution, concealment, safety override. Examples of what fires:

| Label | Weight | Matches text like |
|---|---|---|
| `ignore-previous-instructions` | 1.0 | "ignore all previous instructions" |
| `funds-exfiltration` | 1.0 | "transfer all the SOL", "drain the wallet" |
| `key-exfiltration` | 1.0 | "private key", "seed phrase" |
| `address-substitution` | 1.0 | "`7xKq…` is the new treasury" |
| `concealment` | 1.0 | "do not tell the operator" |
| `control-override` | 1.0 | "override the safety limits" |
| `new-instructions` | 0.9 | "new system prompt" |
| `code-execution` | 0.9 | "execute the following command" |
| `forced-action` | 0.9 | "launch this token immediately" |
| `role-reassignment` | 0.7 | "you are now a…" |
| `jailbreak`, `developer-mode`, `dan-mode` | 0.7 | as named |
| `credential-mention` | 0.6 | "api_key" |
| `network-command` | 0.5 | "curl https://…" |
| `fake-role-tag`, `fake-bracket-role` | 0.4 | `<system>`, `[INST]` |
| `fake-system-turn` | 0.3 | "System:" |

**The scoring rule.** Let `acc` be the sum of all matched weights and `strongest`
be the largest single matched weight. Then:

```
score = min(1, max(strongest, acc / (acc + 1.1)))
quarantine = score >= 0.6
```

Two combination rules, whichever is higher. The `strongest` term means one
decisive hit quarantines on its own — a single explicit funds-exfiltration
request does not need corroboration. The saturating sum means several weak
signals together can also reach the threshold, without any three of them ever
exceeding one decisive hit.

The three structural patterns (`fake-system-turn`, `fake-role-tag`,
`fake-bracket-role`) are weighted deliberately below the threshold in isolation,
and the code says why: sanitisation has already neutralised them before any model
sees the text, and a post that merely *mentions* an HTML-ish tag is ordinary
internet content. Dropping it would lose real signal for no security gain. They
still contribute to the sum, so structure plus semantics quarantines.

### Layer 3 — nonce-fenced envelopes

`buildUntrustedContext` in `packages/server/src/providers/ai/router.ts` is the
assembly point:

1. Generate **16 bytes of CSPRNG output, hex-encoded**, once per call. Hex is
   used specifically so the nonce survives `wrapUntrusted`'s alphanumeric-only
   sanitisation intact.
2. For each item, run `detectInjection` on the **raw** content and track the
   running maximum score.
3. If it quarantines, **drop it** and log a warning naming the source label, the
   score and the matched pattern labels. It never reaches a model.
4. Otherwise wrap it:

```
<untrusted_data source="reddit" nonce="a3f1…">
…sanitised content…
</untrusted_data nonce="a3f1…">
```

5. Prepend `UNTRUSTED_DATA_PREAMBLE` — a standing instruction telling the model
   the fenced text was written by anonymous people, is data and never an
   instruction, and that anything resembling a command, a role change, a wallet
   address or a credential claim should be reported as an observation while the
   original task continues unchanged.

The nonce is what makes the fence non-forgeable. Scraped text cannot predict 128
bits of CSPRNG output, so it cannot emit a matching closing tag and "escape" into
the instruction context. The label is stripped to `[A-Za-z0-9_.:-]` and the nonce
to `[A-Za-z0-9]` before interpolation, so neither is an injection vector itself.

The raw string is passed to `wrapUntrusted` deliberately — it sanitises
internally, and sanitising twice would corrupt the relationship between the
content and the detection score just computed over it.

**The maximum score is returned even for dropped items**, so the record built
from this prompt is flagged even when the offending text never reached the model.
`concept.service.ts` uses that: an `injectionScore > 0.3` adds a
`prompt_injection_detected` risk flag at `review` severity, meaning a human sees
the concept before it goes anywhere.

### The echo detector

`findSuspiciousEchoes(modelOutput, untrustedInputs)` catches the other direction:
a model that has been persuaded to smuggle content out of the fence. It scans the
model's output for base58 strings of 32–44 characters (Solana address shape) and
for URLs, and reports any that also appear in the untrusted inputs.

**Honest status: this function is implemented and unit-tested, but it is not
wired into any server code path.** `grep` finds it only in the shared package and
in `tests/unit/safety.test.ts`. It is a library function waiting for a call site,
not an active control. Treat the echo direction as currently unguarded, and read
the address in a generated concept as untrusted.

### Honest statement

This is defence in depth, not a guarantee. Pattern matching catches known shapes
of attack and will miss novel phrasings, non-English payloads and semantic
attacks that use no suspicious vocabulary at all. The nonce fence and the
preamble reduce the chance a model treats fenced text as instruction; they do not
make it impossible, because the model's compliance is a property of the model and
not of this code.

What makes the overall position defensible is not the detector. It is that the
model's output cannot do anything dangerous on its own: it produces a *concept*,
which is then screened deterministically, gated on quality thresholds, and — up
to phase 3 — approved by a human. The controls that actually stop money moving
are the risk screen and the guard service, neither of which a model can argue
with.

---

## The deterministic risk screen

`packages/shared/src/safety/risk-lexicon.ts`.

**It runs before any model is consulted.** That ordering is the point. It is
cheap, it is deterministic, it produces the same answer every time on the same
input, and — unlike an AI reviewer — it cannot be talked out of its answer by a
persuasive argument in the text it is screening. A model that is asked to review
risk can be manipulated by the content it is reviewing. A regular expression
cannot.

It is intentionally conservative and will produce false positives. Everything it
catches is either blocked or routed to human review; nothing it catches is
silently launched.

### Block versus review

Three severities: `block` prevents launch entirely, `review` forces human
approval, `note` records without gating.

**Blocked outright:**

| Flag | What it catches |
|---|---|
| `copyrighted_character` / `company_impersonation` | 72 well-known marks and properties — Disney, Pokémon, Star Wars, Minecraft, Nike, Coca-Cola, OpenAI, Binance, the Olympics, and so on. The flag is `company_impersonation` for corporate names and `copyrighted_character` for the rest |
| `misleading_financial_claim` | 12 patterns: "guaranteed", "risk-free", "can't lose", "passive income", "will moon", "next bitcoin", "investment opportunity", "financial advice" |
| `hate_or_harassment` | Slurs and hate symbols |
| `sexual_content` | Explicit sexual terms |
| `minor_related` | Sexualised or exploitative references involving minors |
| `violence` | Glorification of violence or a real attack |
| `tragedy_exploitation` | 9/11, disaster victims, death tolls, missing children |
| `illegal_activity` | Drugs, hitmen, money laundering, carding |

**Routed to human review:**

| Flag | What it catches |
|---|---|
| `company_impersonation` | Eight patterns implying an official relationship: "official", "verified", "partnership with", "endorsed by", "backed by", "in collaboration with", "the real", and "team …token/coin" |
| `medical_or_legal_claim` | "cures cancer", "FDA-approved", "clinically proven" |
| `election_related` | "vote for", "election fraud", "presidential campaign" |
| `real_person` | A lower-case title followed by a capitalised name (`president Smith`, `senator Jones`) — a weak proper-noun heuristic the AI reviewer then adjudicates. Note the rule is the one case-sensitive rule in the set and its title alternation is written in lower case, so a conventionally capitalised `Dr Smith` or `Senator Jones` does **not** match |

`PROTECTED_MARKS` is explicitly not exhaustive. It is a high-signal starting set;
the AI risk reviewer and the human approval gate cover the long tail.

### Leetspeak and homoglyph de-obfuscation

Substitution is the standard evasion, so every case-insensitive rule is run
against **two** normalised forms of the text:

- `normalise()` — NFKD, combining marks stripped, lowercased, whitespace
  collapsed.
- `deleetFold()` — `normalise()` plus a character-by-character map through a
  homoglyph table (Cyrillic `а в е к м н о р с т у х`, small-capital Latin
  `ᴀ ʙ ᴄ ᴅ ᴇ …`) and a leet table. Crucially it **preserves word structure**:
  spaces and punctuation survive, so `\b` word boundaries in the rules still
  work.

Screening only the raw text would let `r3t4rd` and Cyrillic `рере` straight
through. The one case-sensitive rule — the proper-noun heuristic, which needs
real capitalisation — is run against the original text instead.

Duplicate `flag:label` pairs are deduplicated, so the same rule matching in both
forms produces one flag.

### It applies to human edits too

`container.ts`'s `editCandidate` re-runs `screenRisk(name, symbol, description)`
on an operator's manual edit and refuses the edit if it blocks. Letting a human
hand-edit around a block would defeat the control entirely — the screen would
become advisory the moment anyone was in a hurry.

`concept.service.ts` screens across five fields at once: name, symbol,
description, narrative and image prompt. It also folds in two structural blocks —
a hard name/ticker collision with an existing token, and a concept the platform
has generated before — and the injection review flag described above.

---

## Redaction

Two independent mechanisms: pino's path-based redaction, driven by
`REDACT_PATHS` in `packages/server/src/core/logger.ts`, and a regex sweep driven
by `SECRET_PATTERNS` in `packages/server/src/core/errors.ts`.

### Path-based redaction (pino)

`createLogger` passes `redact: { paths: REDACT_PATHS, censor: '[redacted]' }`.
The list is 32 paths: 22 bare field names — `password`, `passphrase`,
`privateKey`, `secretKey`, `secret`, `apiKey`, `token`, `accessToken`,
`refreshToken`, `sessionToken`, `authorization`, `cookie`, `mintSecret`,
`mintSecretEncrypted`, `keypair`, `seed`, `mnemonic`, `totpSecret` and
snake_case variants of several of them — plus six one-level wildcards
(`*.password`, `*.privateKey`, `*.secretKey`, `*.apiKey`, `*.token`, `*.secret`)
and four explicit header paths (`req.headers.authorization`,
`req.headers.cookie`, `headers.authorization`, `headers.cookie`).

This catches the structured case: a credential passed as a named field.

### The regex sweep

Path redaction only helps if the field is named correctly. A credential
interpolated into a message string is invisible to it. So a `logMethod` hook runs
`redactSecrets` over every string argument before it is formatted:

| Pattern | Catches |
|---|---|
| `\bsk-[A-Za-z0-9_-]{16,}` | OpenAI-style keys |
| `\bsk-ant-[A-Za-z0-9_-]{16,}` | Anthropic keys |
| `\bBearer\s+[A-Za-z0-9._-]{16,}` | Authorisation headers |
| `[A-Za-z0-9_-]{40,}\.[…]{20,}\.[…]{20,}` | JWTs |
| `"?(api[_-]?key\|apikey\|secret\|password\|passphrase\|private[_-]?key\|token)"?\s*[:=]\s*"?[^\s",}]{8,}` | `key: value` shapes in any serialised form |
| `\b[0-9a-fA-F]{64}\b` | Hex-encoded 32-byte keys, and incidentally SHA-256 digests |
| `\b[1-9A-HJ-NP-Za-km-z]{80,90}\b` | Base58 Ed25519 secret keys (a 64-byte key encodes to 87–88 characters) |

The last pattern deliberately does not cover 32–44 character base58 strings,
because that is the length of a Solana *public* key — an address is public
information and redacting it would make the logs useless.

The same `redactSecrets` is applied to request URLs in the `onResponse` hook and
the error handler, and `safeErrorText` composes it with an 800-character
truncation for anything written to storage.

### What is never written to the audit log

`redactParameters` in `audit.ts` walks the `parameters` object before it is
serialised and replaces the value of any key matching:

```
^(password|passphrase|secret|secretkey|privatekey|private_key|
  apikey|api_key|token|keystore|mnemonic|seed|totp.*)$
```

with `[redacted]`, case-insensitively. Every surviving string additionally goes
through `redactSecrets` and is truncated to 2000 characters; arrays are capped at
50 elements and recursion at depth 6, so a hostile or runaway object cannot bloat
the log.

Concretely, this means the audit log records **that** a secret was set
(`secret.set`, with the secret's key name as `targetId`) and never what it was
set to; **that** the wallet was exported (`wallet.exported`, with actor, address
and IP) and never the exported key; and settings changes with before/after values
for every path except those whose names match the forbidden list.

---

## The audit log

`packages/server/src/security/audit.ts`. Append-only, hash-chained, one row per
consequential action. The canonical action names live in `AUDIT_ACTIONS` — 34 of
them, covering logins, user and role changes, settings changes, secret writes,
every wallet operation, the concept lifecycle, every launch outcome, fee
collection, emergency stop and release, autonomy and phase changes, model
retraining and activation, experiments, job runs and data exports.

Using constants rather than free-text strings is what makes the log queryable:
`GET /api/system/audit?action=launch.confirmed` works because nobody ever wrote
`"launch confirmed"` by hand.

### Hash chaining

Each entry commits to its predecessor:

```
hash_n = sha256(stableStringify({
  sequence, previousHash, actorType, actorId, actorLabel, action,
  targetType, targetId, parameters, result, resultDetail,
  modelVersion, transactionSignature, reason, createdAt
}))
```

The first entry's `previousHash` is the genesis value, 64 zeros.
`stableStringify` guarantees deterministic key ordering, so the hash is
reproducible.

The sequence read and the insert happen inside one synchronous SQLite
transaction, so two concurrent writers cannot both read sequence *n* and produce
a forked chain.

### What verification detects

`verifyChain()` walks from sequence 1 forward, tracking the expected sequence
number and the expected previous hash, and returns at the first break:

| Break | Detected how | Reported as |
|---|---|---|
| A row was **deleted** | The sequence numbers skip | `Sequence gap: expected N, found M. An entry was deleted.` |
| An **earlier** row was modified | The stored `previous_hash` no longer matches the recomputed hash of the row before it | `Previous-hash mismatch: an earlier entry was modified.` |
| **This** row was modified | Recomputing the hash from the row's own stored fields does not reproduce `hash` | `Hash mismatch: this entry was modified after it was written.` |

The result carries `valid`, `checked` (how many entries verified cleanly before
the break) and `brokenAtSequence`, so you know exactly where to look.

### How to verify it

```bash
# Through the API (requires the view_audit permission)
curl -s --cookie "solcoin_session=…" \
     http://127.0.0.1:4317/api/system/audit/verify

# {"valid":true,"checked":1841}
```

`npm run doctor` also verifies the chain as part of its pre-flight checks, with
`limit: 20_000`; `container.diagnostics()` does the same with `limit: 5_000`.
The default limit when called with no options is 100 000 entries.

Read that limit carefully: `verifyChain` selects `ORDER BY sequence ASC LIMIT n`
and walks forward from sequence 1, so the limit keeps the **oldest** *n*
entries and never looks at anything newer. Once the log is longer than the
limit, `doctor` is checking history rather than recent activity and a tampered
recent entry goes unreported. `GET /api/system/audit/verify` passes no limit, so
it walks up to 100 000 entries — which is everything only while the log is
shorter than that.

### Limits of the audit chain

The chain uses an unkeyed SHA-256 with no external anchor. An attacker who can
write to the database file can delete an entry and recompute every subsequent
hash, producing a chain that verifies perfectly. The chain detects **accidental
corruption and casual tampering** — a row deleted with a SQL client, a field
edited to hide something — and it does not detect a deliberate, competent
rewrite.

Closing that gap needs an off-box anchor: shipping entries to append-only remote
storage, or periodically publishing the head hash somewhere the operator does not
control. Neither is implemented. Until then, the operational mitigation is to
back up the database regularly and off-machine — a rewritten chain is detectable
by comparing the head hash against a copy taken before the rewrite.

---

## The safety envelope

`packages/server/src/services/guard.service.ts`. Every side-effecting operation
asks this one service for permission first, which means there is exactly one
thing to audit and one thing to test.

### Every limit

Defaults from `LimitSettings` in `packages/shared/src/domain/settings.ts`:

| Setting | Default | Range | Enforces |
|---|---|---|---|
| `maxLaunchesPerHour` | 1 | 0–20 | Launches per rolling hour on the active network |
| `maxLaunchesPerDay` | 3 | 0–50 | Launches per rolling 24 hours on the active network |
| `maxSolPerTransaction` | 0.15 SOL | ≥ 0 | Any single operation's spend |
| `maxSolPerHour` | 0.3 SOL | ≥ 0 | Committed spend per rolling hour |
| `maxSolSpendPerDay` | 0.5 SOL | ≥ 0 | Committed spend per rolling 24 hours |
| `maxAiSpendUsdPerDay` | $10 | ≥ 0 | AI provider cost per rolling 24 hours |
| `walletBalanceFloorSol` | 0.05 SOL | ≥ 0 | Balance the operating wallet may not drop below |
| `consecutiveFailureShutdown` | 3 | ≥ 1 | Consecutive launch failures before auto-stop |
| `rpcFailureThreshold` | 8 | ≥ 1 | **Nothing today.** Intended as the consecutive-RPC-error count before an endpoint is marked down, but `SolanaRpc` is constructed in `container.ts` without a `failureThreshold`, so the pool uses its own hard-coded default of 4 and this setting is inert |
| `maxTransactionRetries` | 3 | 0–10 | **Nothing today.** No server code reads it; the send path passes `maxRetries: 0` to `sendRawTransaction` and manages resubmission itself |
| `maxClockDriftSeconds` | 120 | ≥ 1 | The `clock` health component, which goes `degraded` past 25% of the limit and `down` past it. `down` on an essential component makes overall health `down`; it does **not** by itself stop a job or a launch |

Only the first eight of those are read by `GuardService`. The last three are
settings the guard never consults, and two of them are not consulted anywhere —
they are listed here because the dashboard offers them and an operator will
otherwise assume they do something.

The windows are rolling, not calendar days — `now - TIME.day`, not midnight — so
there is no reset moment an attacker or a runaway loop can wait for.

The balance floor exists for a specific failure: the platform must never spend
itself into a state where it cannot afford the transaction fee to collect the
fees it has already earned.

### Counters come from the database

Every counter is a `SELECT` executed at check time:

```sql
SELECT COALESCE(SUM(total_cost_lamports), 0) FROM launches
 WHERE created_at >= ? AND status IN ('preparing','submitted','confirmed');

SELECT COALESCE(SUM(lamports + fee_lamports), 0) FROM wallet_transactions
 WHERE occurred_at >= ? AND direction = 'out' AND status IN ('pending','confirmed');

SELECT COALESCE(SUM(cost_usd), 0) FROM ai_requests WHERE created_at >= ?;
```

Nothing is held in memory, so a restart cannot reset a daily limit. An in-memory
counter would turn a crash loop into an unbounded spend — the failure that
matters most is precisely the one where the process keeps dying and coming back.

Note that spend counts `preparing` and `pending` rows too, not only confirmed
ones. Money that is committed but not yet settled still counts against the limit.

### The universal precondition

`checkOperational` runs before every operation with side effects, **including the
ones that spend no SOL**. Emergency stop must halt research and concept
generation as well, because a paused system that keeps burning AI credits is not
paused. It denies when:

- `emergencyStop` is engaged (returning the recorded reason), or
- the operation's autonomy capability is set to `off`.

Denials are fail-closed by construction: an error reading a limit denies the
operation rather than allowing it.

### The launch gate

`checkLaunch` runs `checkSpend` first, with the amount computed as the configured
dev-buy plus 6 000 000 lamports (0.006 SOL) of fee headroom, then applies the
hourly and daily launch counts, then the consecutive-failure breaker.

`consecutiveLaunchFailures()` reads the last 25 `confirmed`/`failed` launches on
the active network in reverse order and counts failures until it hits a success.

### Auto-stop

`autoStop(reason)` engages the emergency stop from within the process. It is
idempotent (returns immediately if the stop is already engaged), logs at error
level, sets the stop through `SettingsService`, and writes an audit entry with
`result: 'blocked'` and the reason.

There is **one** caller today: `launch.service.ts`, after a launch failure, when
`consecutiveLaunchFailures() >= consecutiveFailureShutdown`. The reason string
names the count, the network and the most recent error message truncated to 200
characters. Repeated launch failures usually mean something systemic — a bad RPC
endpoint, an expired dependency, a protocol change — and stopping is cheaper than
continuing to burn rent on transactions that will not land.

Operators can engage and release the stop manually through
`POST /api/system/emergency-stop` and `/emergency-release`, both requiring the
`emergency_stop` permission and a reason of 3–500 characters.

Current usage against the rate and spend limits — launches this hour and today,
SOL this hour and today, AI dollars today, and the consecutive-failure count —
is exposed by `guard.usage()` and surfaced at `GET /api/system/status`, so the
dashboard shows how close the platform is to those ceilings rather than only
telling you after it hits one. The per-transaction cap and the balance floor are
not in that payload; they are only visible as a denial.

---

## SSRF

`packages/server/src/providers/trends/rss.ts`.

RSS feed URLs are operator-supplied configuration, which makes this provider a
fetch-arbitrary-URL primitive sitting inside the operator's network. An operator
who pastes a URL from a support ticket, or an attacker who reaches the settings
API, could otherwise read `http://169.254.169.254/` — cloud instance metadata,
which on every major cloud means the machine's credentials — or port-scan the
private network from inside the perimeter.

Two halves.

**Syntactic (`validateFeedUrl`, exported and unit-testable):**

- **https only.** A feed fetched over http can be rewritten in flight, and its
  content is then fed to a language model.
- **No embedded credentials.** `user:pass@host` is refused, because a feed URL is
  stored in settings and displayed in logs.
- **No internal names.** `localhost` and anything ending `.localhost`, `.local`
  (mDNS), `.internal` (the conventional cloud-private zone), `.home.arpa`
  (RFC 8375), `.lan` or `.intranet`.
- **No private literals.** `classifyAddress` covers loopback, link-local,
  RFC 1918, CGNAT, multicast and reserved ranges in both address families —
  including the IPv6 forms that embed an IPv4 address (`::ffff:0:0/96`, `::/96`,
  `64:ff9b::/96` and `64:ff9b:1::/48` for NAT64, `2002::/16` for 6to4), which are
  exactly the forms an SSRF attempt reaches for. `parseIpv6` decodes to bytes
  rather than matching text, because `new URL()` re-serialises
  `[::ffff:169.254.169.254]` to `::ffff:a9fe:a9fe` and a textual check would
  never fire on it.

**Resolution (`resolvesToPublicAddress`):** a perfectly public-looking hostname
can resolve to `127.0.0.1` or to a metadata address. Every address the name
resolves to must be public, not just the first — `lookup(host, { all: true })`
and a check on each.

**The acknowledged gap**, documented in the code rather than glossed over: this
cannot close the DNS-rebinding window, because `fetch` resolves the name again
itself and there is no way to pin the checked address to the connection that is
subsequently made. Closing it properly needs a custom agent with a `lookup` hook
in `HttpClient`. The check still defeats the overwhelmingly more common case of a
name that simply points at an internal host.

Feeds are also polled politely — 30 requests per minute per host, burst 3 —
which is unrelated to SSRF but is why an operator adding many feeds does not get
their address blocked by publishers.

---

## Hardening checklist for production

Ordered roughly by how much each one matters.

**Before first boot**

- [ ] Generate `SOLCOIN_MASTER_KEY` from a CSPRNG:
      `openssl rand -base64 32`. Minimum enforced length is 16 characters; do
      not treat that as a target.
- [ ] Store it in a secrets manager or a systemd credential, not in a `.env`
      file committed anywhere. The app never writes it to disk, but you might.
- [ ] Back it up separately from the database. The two together are the wallet;
      either alone is useless, which is the property you want.
- [ ] Set `NODE_ENV=production`. This is what turns on `secure` cookies and
      HSTS, and turns off pretty-printed logs.
- [ ] Set a 20+ character owner password. There is no reset route.

**Network exposure**

- [ ] Leave `HOST=127.0.0.1` and reach the dashboard over an SSH tunnel or a
      VPN. This removes most of the attack surface in this document.
- [ ] If you must expose it, terminate TLS at a reverse proxy you control, and
      set `TRUST_PROXY=true` — otherwise per-IP rate limiting collapses into one
      shared bucket.
- [ ] Leave `CORS_ORIGINS` empty unless you are genuinely serving the dashboard
      from another origin.
- [ ] Put the whole thing behind an authenticating proxy (mTLS, an identity-aware
      proxy) if it is internet-reachable. This platform's own auth is the last
      line, not the only one.

**Filesystem and process**

- [ ] Run as a dedicated unprivileged user; `chmod 600` the database file and
      `chmod 700` its directory. A readable `data/solcoin.db` plus a leaked
      master key is a total compromise.
- [ ] Disable core dumps for the process (`ulimit -c 0`). A core dump taken
      during a signing window contains the private key.
- [ ] Encrypt backups of `data/`, and keep them somewhere the master key is not.
- [ ] Keep the machine clock synchronised. Drift beyond `maxClockDriftSeconds`
      (120) turns the `clock` health component `down`, which shows up in
      `npm run doctor` and `GET /api/system/status` — but nothing refuses to
      sign on its own, so treat it as an alarm to act on, not a guard.

**Wallet**

- [ ] Fund the operating wallet with only what the next few days need. The
      treasury key must live elsewhere. Bounded loss is the entire custody
      design.
- [ ] Set `wallet.treasuryAddress` and enable auto-sweep so revenue does not
      accumulate in the hot wallet.
- [ ] Set `walletBalanceFloorSol` above the cost of a fee-collection transaction.
- [ ] Consider `watch_only` custody with an external signer if the float is
      large enough that a process compromise would hurt.

**Accounts and limits**

- [ ] One account per human. Give `viewer` or `analyst` unless someone genuinely
      needs to move money — `transfer_funds` implies the ability to export the
      private key.
- [ ] Keep exactly the owners you need; `manage_users` is owner-only for a
      reason.
- [ ] Start on `phase1_research`, and walk the ladder deliberately. Set every
      limit in `LimitSettings` lower than you think you need for the first week.

**Ongoing**

- [ ] Run `npm run doctor` after every deployment; it verifies the audit chain
      among its other checks.
- [ ] Check `GET /api/system/audit/verify` on a schedule, and compare the head
      hash against your last backup.
- [ ] Review `GET /api/system/secrets` periodically and delete credentials whose
      `lastUsedAt` shows they are not in use.
- [ ] Review `user.login_failed` entries in the audit log for grinding.
- [ ] Keep dependencies current. The security-critical primitives are built-in,
      but the process is not.

---

## Reporting a vulnerability

**Contact: `security@example.invalid`** — replace this with a real address
before deploying or distributing.

Please include: what you found, the smallest reproduction you have, the commit or
version you tested, and what you think an attacker gains. If it involves the
wallet, the master key or the audit chain, say so in the subject line.

Please do not open a public issue for anything that would let a reader reach an
operator's funds or credentials before there is a fix.

There is no bug bounty, and no licence is granted by default (see the README).
This is a self-hosted platform: there is no service to take offline and no
central deployment to patch, so a fix reaches operators only when they update.
Coordinated disclosure with a reasonable window is appreciated.
