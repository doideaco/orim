# Deploying Orim

One container, one port, one data volume.

## Quick start

```bash
docker compose up -d
# → http://localhost:1234
```

Behind a reverse proxy (recommended), forward HTTP **and WebSocket**
traffic to port 1234 and set `ORIM_PUBLIC_URL` to your public origin.

## Without Docker

Requires Node ≥ 22.5.

```bash
pnpm install
pnpm --dir apps/web build
pnpm --dir apps/sync build
ORIM_WEB_DIST=$PWD/apps/web/dist ORIM_DATA_DIR=/var/lib/orim \
  node apps/sync/dist/server.mjs
```

## Environment reference

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `1234` | Listen port |
| `ORIM_DATA_DIR` | `/data` (container) | SQLite + persistence directory |
| `ORIM_WEB_DIST` | set in container | Built web app to serve; unset = API/sync only |
| `ORIM_PUBLIC_URL` | `http://localhost:1234` | Public origin (needed for SSO redirects) |
| `ORIM_SESSION_TTL_HOURS` | `720` | Session lifetime |
| `ORIM_CORS_ORIGINS` | same-origin¹ | CORS allow-list: `*` or comma-separated origins |
| `ORIM_AUTH_RATE_LIMIT` | `30` | Max auth attempts per IP per 10 minutes |
| `ORIM_HISTORY_INTERVAL_MIN` | `10` | Minutes between automatic board version snapshots |
| `ORIM_HISTORY_KEEP` | `200` | Automatic snapshots kept per board (labelled ones always kept) |
| `ORIM_TRUST_PROXY` | – | `1` reads client IP from `X-Forwarded-For` (set behind a proxy) |
| `ORIM_OIDC_ISSUER` | – | OIDC issuer URL (enables SSO) |
| `ORIM_OIDC_CLIENT_ID` | – | OIDC client id |
| `ORIM_OIDC_CLIENT_SECRET` | – | OIDC client secret |
| `ORIM_OIDC_REQUIRED` | – | `1` disables password auth (SSO only) |

¹ When `ORIM_WEB_DIST` is set (the container default) no cross-origin
requests are allowed unless you list origins; when running API-only (dev)
the default is `*`.

Register the OIDC client with redirect URI
`{ORIM_PUBLIC_URL}/auth/oidc/callback` (authorization code flow).

## Backup & restore

All state is `$ORIM_DATA_DIR/boards.db`. Back it up with any file-level
tool (stop-free backups: `sqlite3 boards.db ".backup backup.db"`).
Restore by putting the file back and restarting.

## Upgrades

Pull the new image, `docker compose up -d`. The database migrates
additively on boot; the board format is versioned and documented in
[`docs/`](docs/index.html).

## Sizing

A single modest container serves workshop-scale teams comfortably: the
sync server relays compact CRDT updates and SQLite handles thousands of
boards in one file. Scale up before out; multi-node coordination is not
yet supported.
