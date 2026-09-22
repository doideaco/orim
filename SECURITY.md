# Orim security overview

Orim is designed to run entirely inside your perimeter. This document
describes the architecture, data flows, and controls so a security review
can be completed from the source you're deploying.

## Architecture & data flow

One process serves everything:

```
browser ── HTTPS/WSS (your reverse proxy) ──► orim server
                                              ├─ static web app (files)
                                              ├─ HTTP API (auth, boards, audit)
                                              ├─ WebSocket sync (Yjs CRDT)
                                              └─ SQLite (one file, /data)
```

**Nothing leaves the box.** The server makes no outbound network calls
except, when OIDC is configured, to your identity provider (discovery,
token exchange, JWKS). There is no telemetry, no update phone-home, no
CDN: fonts are system fonts, all JavaScript is bundled and served
locally. The application works in fully air-gapped environments.

Browsers additionally keep a local copy of boards a user has opened
(IndexedDB) for offline work — equivalent in sensitivity to a synced
file share or a git clone. See *Limitations*.

## Data at rest

Everything lives in a single SQLite file (`$ORIM_DATA_DIR/boards.db`):
board documents (CRDT state), users, sessions, share settings, roles,
and the audit log. Backup is a file copy; restore is a file copy.
Encrypt at rest via your volume/filesystem encryption (LUKS, EBS, etc.).

## Authentication

- **Local accounts**: passwords hashed with scrypt (per-user random
  salt); constant-time comparison. Sessions are 192-bit random bearer
  tokens with a configurable TTL (`ORIM_SESSION_TTL_HOURS`, default 720);
  expired sessions are pruned on use.
- **OIDC SSO** (recommended for organizations): authorization-code flow
  against your IdP (Keycloak, Azure AD, Okta…). ID tokens are verified
  against the issuer's JWKS (RS256/ES256) with issuer, audience and
  expiry checks; login state nonces are single-use and expire after 10
  minutes. Set `ORIM_OIDC_REQUIRED=1` to disable password auth entirely.
  The first user ever created becomes the admin. The complete flow —
  discovery, authorization redirect, token exchange, live JWKS signature
  verification, and audit logging — is verified end-to-end against
  Keycloak 26.
- **Rate limiting**: auth endpoints (login, signup, OIDC) are limited
  per client IP (default 30 attempts per 10 minutes,
  `ORIM_AUTH_RATE_LIMIT`); crossing the limit is recorded in the audit
  log. Behind a reverse proxy, set `ORIM_TRUST_PROXY=1` so the limit
  keys on `X-Forwarded-For` instead of the proxy's address.

## Authorization

Per-board access modes — *link-edit*, *link-view*, *private* — plus
per-user grants (editor/viewer), enforced **at the sync layer**: viewer
connections are read-only server-side (writes are dropped, not hidden),
and private boards reject unauthorized connections outright. Board
management (share, grant, rename, delete) is owner-only once a board is
claimed. Board listings only show boards the caller can access.

## Audit log

An append-only `audit` table records sign-ups, logins (including
failures), logouts, SSO sign-ins, board connections (user, board, role),
denied connection attempts, and share/grant/rename/delete operations
with timestamps. Admins can browse and filter it in the admin console at
`/admin` (which also manages users, roles and sessions), read it at
`GET /audit` (bearer auth), or ingest it into a SIEM directly from
SQLite.

## Deployment hardening checklist

- Terminate TLS at your reverse proxy; set `ORIM_PUBLIC_URL` to the
  HTTPS origin (SSO redirects depend on it).
- Set `ORIM_OIDC_REQUIRED=1` so all identity flows through your IdP.
- Shorten `ORIM_SESSION_TTL_HOURS` to your policy (e.g. 12).
- Cross-origin API access is denied by default in the container
  (same-origin only); if another origin legitimately needs the API,
  list it in `ORIM_CORS_ORIGINS`. Set `ORIM_TRUST_PROXY=1` behind your
  reverse proxy so rate limiting sees real client IPs.
- Run the container read-only except `/data`; it runs as a non-root
  user by default.
- Back up `/data` on your normal schedule; test restore (it's one file).
- Ship the `audit` table to your SIEM if required.

## Limitations (honest list)

- Local-first means revoked users retain their previously-synced local
  copy (clearly labelled read-only in the UI); revocation stops all
  future access and updates, like revoking a file share.
- MCP server connections authenticate as guest by default; set
  `ORIM_TOKEN` to a real session token to run agents as a user.

Report vulnerabilities to security@thedoidea.co.
