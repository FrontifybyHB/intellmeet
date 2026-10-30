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

## Recording consent and recordings

Consent is per person, per meeting, and is owned by the **caller**: the
server binds `userId` from the verified session, so a participant can read
and write only their own row. The host has no privileged path to another
participant's row. AI-transfer permission is a **separate** field
(`aiTransfer`: `approved`/`declined`/`undecided`) and is never inferred
from the recording decision in either direction.

| Method & path | Auth | Success | Notable errors |
|---|---|---|---|
| `GET /api/meetings/:id/recording-consent` | required | `200 { noticeVersion, consent }` — `consent` is the caller's own row or `null` | `403 NOT_A_MEMBER`/`NOT_ADMITTED` |
| `POST /api/meetings/:id/recording-consent` | required + CSRF | `200 { consent }` | `400 VALIDATION_ERROR` (`decision` must be `approved`/`declined`), `409 NOTICE_VERSION_MISMATCH` |
| `POST /api/meetings/:id/recordings/start` | host only + CSRF | `200 { recording, resumed }` | `403 NOT_HOST`, `429 OVERLOADED`, `503 INTEGRATION_BLOCKER` |
| `POST /api/meetings/:id/recordings/:recordingId/stop` | host only + CSRF | `200 { recording, resumed }` | `403 NOT_HOST`, `404 RECORDING_NOT_FOUND` |
| `GET /api/meetings/:id/recordings?limit=` | required | `200 { recordings, hasMore }` — newest-first | `400 VALIDATION_ERROR` (bad `limit`) |
| `GET /api/meetings/:id/recordings/:recordingId` | required | `200 { recording }` | `404 RECORDING_NOT_FOUND` |
| `GET /api/meetings/:id/recordings/:recordingId/url` | required | `200 { url, expiresAt }` | `409 RECORDING_NOT_FOUND` (not ready), `503 INTEGRATION_BLOCKER` (storage unconfigured) |

`noticeVersion` must echo the version the server currently requires; a
stale version is rejected with `409 NOTICE_VERSION_MISMATCH` and the
caller has to read the notice again. Declining after approving triggers a
server-side quarantine of any in-flight attempt, so the output can never
become `ready`.

`limit` is the only window control: default `50`, capped at `100`. There
is **no cursor** — `hasMore: true` means older recordings exist that the
response cannot address, not that a second page can be fetched.

Recording states are durable and server-owned:
`requested → starting → active → stopping → verifying → ready`, with
`failed`, `aborted` and `unknown` as alternatives. Terminal states
(`ready`/`failed`/`aborted`) never regress; every transition is a
version-checked write, so a stale or reordered provider callback cannot
reopen a finished attempt. `unknown` means *unresolved*, not *absent*:
the provider did not answer and the attempt is being reconciled.

Start is idempotent per (meeting, session): a second start while an
attempt is in flight returns the existing attempt with `resumed: true`.
Stop is idempotent: stopping an already terminal or already-stopping
attempt returns it unchanged with `resumed: true`.

The server publishes `recording:status { meetingId, recording }` and
`recording:ready { meetingId, recordingId, state }` to the meeting room
(`meeting_<id>`), so a socket must have joined via `meeting:join` to
receive them. Exactly-once delivery is not promised, and a **failed**
start emits no status event — the authoritative state is recovered with
the `GET` endpoints above.

One response shape is worth calling out because it is unusual: when the
provider times out in a way the server cannot resolve
(`PROVIDER_TIMEOUT_UNKNOWN`), the request fails **and** the durable
attempt travels inside the error body as `{ recording, error }`. A caller
that discards the error body would conclude that nothing happened while
an attempt exists. Read the body before treating a failed start as
"no recording was created".

Client-side implementation and verification of this section:
[`docs/frontend-cleanup/08-c4a-recording-integration.md`](./frontend-cleanup/08-c4a-recording-integration.md).

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
# Meeting permissions and invite updates

Meeting ownership is the authenticated creator (`Meeting.hostId`), never a
client-supplied role or the first media arrival. The owner may end the meeting
and grant or revoke `canRecord` for an admitted participant through
`PATCH /api/meetings/:meetingId/members/:userId/recording-permission` with
`{ "canRecord": true|false }`. Recording start/stop checks the live meeting
capability on every request; ordinary participants default to `false`.

Invite URLs are stable opaque `/join/:code` links built from `CLIENT_URL`.
`GET /api/meeting-links/:code` exposes only safe meeting metadata. An explicit
`POST /api/meeting-links/:code/join` may use an account or a validated
`displayName` for a short-lived, meeting-scoped guest cookie (`im_gt`). Guest
credentials are not account sessions and cannot access account/history APIs.

The owner uses `POST /api/meetings/:meetingId/end`; participants use the room's
Leave action, which only disconnects their own media and socket.

An owner may then call `DELETE /api/meetings/:meetingId` with CSRF protection.
This is an idempotent soft deletion: it changes the meeting to `cancelled`,
removes it from normal history and detail reads, and blocks future join and
meeting-scoped access. It does not hard-delete retained recording/media data.
Deleting a live meeting returns `409 MEETING_ACTIVE`; the owner must explicitly
end it first. Non-owners receive `403 NOT_HOST`.
