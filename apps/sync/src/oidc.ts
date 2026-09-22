/**
 * OIDC single sign-on (authorization code flow), dependency-free.
 * ID tokens are verified against the issuer's JWKS (RS256/ES256) with
 * issuer, audience and expiry checks. Configured entirely by env:
 *
 *   ORIM_OIDC_ISSUER        e.g. https://login.example.com/realms/main
 *   ORIM_OIDC_CLIENT_ID
 *   ORIM_OIDC_CLIENT_SECRET
 *   ORIM_PUBLIC_URL         where Orim is reachable, e.g. https://orim.internal
 *   ORIM_OIDC_REQUIRED=1    disable password auth entirely (SSO only)
 */
import { createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  required: boolean;
}

export function oidcConfig(): OidcConfig | null {
  const issuer = process.env.ORIM_OIDC_ISSUER;
  const clientId = process.env.ORIM_OIDC_CLIENT_ID;
  const clientSecret = process.env.ORIM_OIDC_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) return null;
  return {
    issuer: issuer.replace(/\/$/, ""),
    clientId,
    clientSecret,
    publicUrl: (process.env.ORIM_PUBLIC_URL ?? "http://localhost:1234").replace(/\/$/, ""),
    required: process.env.ORIM_OIDC_REQUIRED === "1",
  };
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

let discovered: Discovery | null = null;
async function discover(cfg: OidcConfig): Promise<Discovery> {
  if (discovered) return discovered;
  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
  discovered = (await res.json()) as Discovery;
  return discovered;
}

const b64url = (s: string): Buffer => Buffer.from(s, "base64url");

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  [k: string]: unknown;
}

let jwksCache: { keys: Jwk[]; at: number } | null = null;
async function jwks(uri: string): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys: body.keys, at: Date.now() };
  return body.keys;
}

async function verifyIdToken(
  idToken: string,
  cfg: OidcConfig,
  disc: Discovery,
): Promise<Record<string, unknown>> {
  const [h, p, sig] = idToken.split(".");
  if (!h || !p || !sig) throw new Error("Malformed id_token");
  const header = JSON.parse(b64url(h).toString()) as { alg: string; kid?: string };
  const keys = await jwks(disc.jwks_uri);
  const key =
    keys.find((k) => k.kid === header.kid) ??
    keys.find((k) => (header.alg.startsWith("RS") ? k.kty === "RSA" : k.kty === "EC"));
  if (!key) throw new Error("No matching JWKS key for id_token");
  const publicKey = createPublicKey({ key: key as never, format: "jwk" });
  const data = Buffer.from(`${h}.${p}`);
  let ok = false;
  if (header.alg === "RS256") {
    ok = cryptoVerify("RSA-SHA256", data, publicKey, b64url(sig));
  } else if (header.alg === "ES256") {
    ok = cryptoVerify(
      "sha256",
      data,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      b64url(sig),
    );
  } else {
    throw new Error(`Unsupported id_token alg ${header.alg}`);
  }
  if (!ok) throw new Error("id_token signature verification failed");

  const claims = JSON.parse(b64url(p).toString()) as Record<string, unknown>;
  if (claims.iss !== disc.issuer && claims.iss !== cfg.issuer) {
    throw new Error("id_token issuer mismatch");
  }
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(cfg.clientId) : aud === cfg.clientId;
  if (!audOk) throw new Error("id_token audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) {
    throw new Error("id_token expired");
  }
  return claims;
}

const redirectUri = (cfg: OidcConfig): string => `${cfg.publicUrl}/auth/oidc/callback`;

/** Build the authorization redirect and persist the state nonce. */
export async function beginLogin(db: DatabaseSync, cfg: OidcConfig): Promise<string> {
  const disc = await discover(cfg);
  const state = randomBytes(24).toString("hex");
  db.prepare("INSERT INTO oidc_state (state, created_at) VALUES (?, ?)").run(state, Date.now());
  db.prepare("DELETE FROM oidc_state WHERE created_at < ?").run(Date.now() - 10 * 60_000);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri(cfg),
    scope: "openid profile email",
    state,
  });
  return `${disc.authorization_endpoint}?${params}`;
}

/** Exchange the code, verify the id_token, return a display name. */
export async function handleCallback(
  db: DatabaseSync,
  cfg: OidcConfig,
  code: string,
  state: string,
): Promise<string> {
  const known = db.prepare("SELECT state FROM oidc_state WHERE state = ?").get(state);
  if (!known) throw new Error("Unknown or expired OIDC state");
  db.prepare("DELETE FROM oidc_state WHERE state = ?").run(state);

  const disc = await discover(cfg);
  const res = await fetch(disc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(cfg),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`OIDC token exchange failed: HTTP ${res.status}`);
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("OIDC response had no id_token");
  const claims = await verifyIdToken(tokens.id_token, cfg, disc);

  const name =
    (claims.preferred_username as string) ??
    (claims.email as string) ??
    (claims.name as string) ??
    (claims.sub as string);
  if (!name) throw new Error("id_token carried no usable identity claim");
  return String(name).slice(0, 64);
}
