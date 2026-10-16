# API Contracts

The API is served from the backend origin, with application endpoints under
`/api`.

## Health check

`GET /api/health`

Returns HTTP `200` when the API process is available:

```json
{
  "status": "ok"
}
```

This endpoint reports API availability; it does not verify database health.
Additional endpoint contracts will be documented here as routes are added.

## Password auth (`/api/auth`)

Stateless cookie-JWT design: NO server-side session/token store. Short
access JWT (10 min, bounded by the remaining absolute login lifetime)
plus refresh JWT (absolute login deadline 7 days from password login,
never extended). Claims: `sub`/`purpose`(`access`|`refresh`)/
`ver`(User authVersion)/`jti`(login context)/`lb`(absolute deadline)
with `iss=intellmeet`, `aud=intellmeet-app`, HS256 (separate derived
key for refresh). Every use checks the signature + purpose + expiry +
current User row (active status, `authVersion` match); legacy
sub-only/sid/opaque tokens are rejected — cutover needs a fresh login.
Auth-DB outage fails closed (`503 DB_ERROR`).

Transport: HttpOnly cookies ONLY — `im_at` (access, `Path=/`) +
`im_rt` (refresh, `Path=/api/auth`), host-only, `Secure` in
production. `Authorization` headers, handshake `auth.token` values and
JSON bodies are never credential paths (ignored → 401). Socket.IO
likewise reads only the handshake cookie; server Socket.IO CORS sets
the exact frontend origin with `credentials: true` (verified by
handshake-header tests; a scripted-browser run remains unrun).
Login/register/refresh JSON carries NO tokens (only `{ user }` plus a
readable CSRF value for memory use). Cookie state changes need
`x-csrf-token` (signed double-submit bound to the login context;
bootstrap `GET /api/auth/csrf`, including the anonymous pre-login
bootstrap required on login/register); there is no Bearer exemption.
`POST /logout` with no credentials at all is a trivial 200.

SameSite topology: `COOKIE_SAMESITE=lax` (default) for same-site
deployments; `none` is an explicit production-only cross-site mode
(startup fails otherwise) forcing `Secure`. Cross-site deployments
remain subject to browser third-party-cookie blocking.

| Method & path | Auth | Success | Notable errors |
|---|---|---|---|
| `POST /api/auth/register` | Origin-checked, rate-limited | `201 { user }` | `400 VALIDATION_ERROR`/`WEAK_PASSWORD`, `409 DUPLICATE_EMAIL` |
| `POST /api/auth/login` | Origin-checked, rate-limited | `200 { user, csrfToken }` + cookies | `401 INVALID_CREDENTIALS` (generic incl. unknown/disabled) |
| `GET /api/auth/me` | required | `200 { user }` (User row, never JWT payload) | `401 UNAUTHORIZED`/`STALE_CREDENTIALS` |
| `POST /api/auth/refresh` | refresh JWT + CSRF | `200 { user }` + new access cookie (deadline preserved) | `401 INVALID_REFRESH`/`LOGIN_EXPIRED`/`STALE_CREDENTIALS` |
| `POST /api/auth/logout` | optional + CSRF (skipped when anonymous) | `200 { ok: true }`, idempotent | never 401 for missing session |
| `POST /api/auth/logout-all` | required + CSRF | `200 { ok: true }` (atomic `authVersion` bump) | `401` |
| `PATCH /api/auth/change-password` | required + CSRF, rate-limited | `200 { ok, requireRelogin: true }` (conditional hash+version swap) | `401 INVALID_CURRENT_PASSWORD`, `400 WEAK_PASSWORD`, `409 VERSION_CONFLICT` |
| `GET /api/auth/csrf` | none | `200 { csrfToken }` + readable cookie | — |

No per-device session listing/revocation endpoints exist (no registry).
User DTO: `{ id, name, email, role }` only. Registration always creates
`role: "user"`, `status: "active"`; unknown body fields rejected.
Passwords: Argon2id (m=19456 KiB,t=2,p=1) for new hashes with bcrypt +
previous-scrypt verify compat and conditional rehash; 15–128 chars,
512-byte ceiling, no transforms. Duplicate registration: `409
DUPLICATE_EMAIL` (explicit; never auto-logs-in).

Stated limits: clearing cookies stops normal submission, but a copied
unexpired JWT stays usable until expiry or a User `authVersion` change;
copied refresh JWTs mint access until their absolute deadline (no
rotation/consumption possible statelessly). Ordinary logout does NOT
bump the version (would log out other devices). Password
change/logout-all invalidate ALL old-version tokens on subsequent
checks. In-flight checks completed before a version bump are a stated
race boundary. LiveKit/media tokens already issued are provider-side
and unaffected by cookie clearing.

## Meeting writes: CSRF

All unsafe meeting routes (`POST/PATCH/DELETE` under `/api/meetings`)
run `requireAuth` then `csrfProtect`. Cookie-authenticated browsers
must send the double-submit `x-csrf-token` header (bootstrapped from
`GET /api/auth/csrf` or the login response); missing/invalid tokens
fail with `403 CSRF_REQUIRED`/`CSRF_INVALID`. Requests carrying an
`Authorization: Bearer` header are exempt (custom header is not
forgeable cross-origin). `GET` reads need no CSRF token.

## Action items → Tasks

`POST /api/meetings/:id/action-items/:itemId/task` (host only,
rate-limited, CSRF-protected) materializes exactly one `Task` per
**approved** suggestion, idempotent on the suggestion's stable
`taskIdempotencyKey`:

- `409 TASK_NOT_APPROVED` until the item is approved.
- `201 { task, item, resumed: false }` on first creation.
- `200 { task, item, resumed: true }` on duplicate POSTs and
  timeout-after-success replays (same `task.id`, same
  `idempotencyKey`; `Task.countDocuments({ actionItemId }) === 1`).
