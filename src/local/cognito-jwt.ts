import { createPublicKey, createVerify } from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import type { CachedAuthorizerResult } from './authorizer-cache.js';
import type { CognitoUserPoolAuthorizer, JwtAuthorizer } from './authorizer-resolver.js';
import { buildIdentityHash } from './authorizer-resolver.js';

/**
 * Cognito User Pool / JWT authorizer support for `cdkd local start-api`
 * (PR 8b).
 *
 * cdkd verifies JWTs locally against the user pool's published JWKS so
 * the developer can exercise authorizer-protected routes with real-ish
 * tokens (e.g. ones minted by `aws cognito-idp admin-initiate-auth`).
 *
 * **JWKS-fetch failure handling** (locked design decision): when the
 * JWKS endpoint is unreachable at startup, we warn and fall back to a
 * pass-through mode where every JWT is accepted as if valid. Surprising
 * deny is worse than warn+allow for a dev tool. The warn line names the
 * unreachable URL so users can investigate (proxy, network, missing
 * pool) and is repeated on first request to the affected authorizer.
 *
 * Spec references:
 *   - Cognito JWT structure:
 *     https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-with-identity-providers.html
 *   - JWKS:
 *     https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html
 */

interface JwksKey {
  /** Key id; matches the `kid` claim in the JWT header. */
  kid: string;
  /** RSA modulus, base64url-encoded. */
  n: string;
  /** RSA exponent, base64url-encoded (typically `AQAB`). */
  e: string;
  /** Algorithm — always `RS256` for Cognito. */
  alg?: string;
  /** Key type — `RSA`. */
  kty: string;
  /** Key use — `sig` for signing keys. */
  use?: string;
}

interface JwksCacheEntry {
  /** All keys keyed by `kid` for O(1) lookup. */
  byKid: Map<string, JwksKey>;
  /** When this entry expires (unix ms). 1hr from fetch by default. */
  expiresAt: number;
  /** True when the fetch failed and we're in pass-through mode. */
  passThrough: boolean;
}

/**
 * Cache of JWKS responses, keyed by the JWKS URL. cdkd refreshes the
 * cache lazily on miss; entries live for 1hr by default (Cognito rotates
 * keys infrequently, so this is conservative).
 */
export interface JwksCache {
  fetchAndCache(jwksUrl: string): Promise<JwksCacheEntry>;
  /** Get the cached entry without refreshing — returns undefined on miss. */
  peek(jwksUrl: string): JwksCacheEntry | undefined;
  clear(): void;
}

const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000;
/**
 * Failure-mode TTL for JWKS-unreachable entries. Pre-fix the failure
 * entry inherited the 1hr success TTL, so a single transient blip
 * locked pass-through mode for a full hour. 60s is short enough that
 * the next minute's request triggers a real refetch while still
 * suppressing the per-request fetch storm a 0s TTL would cause.
 */
const FAILURE_JWKS_TTL_MS = 60 * 1000;

export function createJwksCache(
  opts: {
    fetchImpl?: (
      url: string
    ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
    now?: () => number;
    ttlMs?: number;
    /** Failure-mode TTL override (defaults to {@link FAILURE_JWKS_TTL_MS}). */
    failureTtlMs?: number;
  } = {}
): JwksCache {
  const fetchImpl = opts.fetchImpl ?? (async (url) => globalThis.fetch(url));
  const now = opts.now ?? ((): number => Date.now());
  const ttlMs = opts.ttlMs ?? DEFAULT_JWKS_TTL_MS;
  const failureTtlMs = opts.failureTtlMs ?? FAILURE_JWKS_TTL_MS;
  const map = new Map<string, JwksCacheEntry>();

  return {
    async fetchAndCache(jwksUrl) {
      const cached = map.get(jwksUrl);
      if (cached && cached.expiresAt > now()) return cached;
      const logger = getLogger().child('cognito-jwt');
      try {
        const response = await fetchImpl(jwksUrl);
        if (!response.ok) {
          throw new Error(`JWKS fetch returned HTTP ${response.status}`);
        }
        const body = await response.text();
        const parsed = JSON.parse(body) as { keys?: unknown };
        const keys = Array.isArray(parsed.keys) ? parsed.keys : [];
        const byKid = new Map<string, JwksKey>();
        for (const k of keys) {
          if (!k || typeof k !== 'object' || Array.isArray(k)) continue;
          const obj = k as Record<string, unknown>;
          if (
            typeof obj['kid'] === 'string' &&
            typeof obj['n'] === 'string' &&
            typeof obj['e'] === 'string' &&
            typeof obj['kty'] === 'string'
          ) {
            byKid.set(obj['kid'], {
              kid: obj['kid'],
              n: obj['n'],
              e: obj['e'],
              kty: obj['kty'],
              ...(typeof obj['alg'] === 'string' && { alg: obj['alg'] }),
              ...(typeof obj['use'] === 'string' && { use: obj['use'] }),
            });
          }
        }
        const entry: JwksCacheEntry = {
          byKid,
          expiresAt: now() + ttlMs,
          passThrough: false,
        };
        map.set(jwksUrl, entry);
        return entry;
      } catch (err) {
        logger.warn(
          `JWKS unreachable at ${jwksUrl}: ${err instanceof Error ? err.message : String(err)}. ` +
            `JWT validation will allow all tokens — local dev fallback. Configure network access to the JWKS URL ` +
            `to enable real signature verification.`
        );
        // Short-TTL failure entry so a transient blip doesn't lock
        // pass-through mode for a full hour. The next minute's request
        // re-attempts the fetch.
        const entry: JwksCacheEntry = {
          byKid: new Map(),
          expiresAt: now() + failureTtlMs,
          passThrough: true,
        };
        map.set(jwksUrl, entry);
        return entry;
      }
    },
    peek(jwksUrl) {
      return map.get(jwksUrl);
    },
    clear() {
      map.clear();
    },
  };
}

/**
 * Build the JWKS URL for a Cognito User Pool.
 *
 * Format: `https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/jwks.json`
 */
export function buildCognitoJwksUrl(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
}

/**
 * Build the JWKS URL for a generic OIDC issuer (HTTP v2 JWT authorizers).
 * Trailing slash is normalized.
 */
export function buildJwksUrlFromIssuer(issuer: string): string {
  const stripped = issuer.replace(/\/+$/, '');
  return `${stripped}/.well-known/jwks.json`;
}

/**
 * Verify a Bearer JWT against the Cognito user pool referenced by the
 * authorizer. Returns a {@link CachedAuthorizerResult} the http-server
 * can both cache (briefly — JWT exp itself is the cache deadline) and
 * propagate into the route event.
 *
 * Returns `{ allow: false }` on:
 *   - missing / malformed Authorization header (caller surfaces 401);
 *   - signature verification failure;
 *   - expired token (`exp` in the past);
 *   - issuer mismatch (token's `iss` doesn't match the pool's URL);
 *   - audience mismatch (token's `aud` not in the configured allowlist).
 *
 * Returns `{ allow: true, principalId, context }` on:
 *   - successful verification;
 *   - JWKS-unreachable pass-through mode (with a warn line on first hit).
 */
export async function verifyCognitoJwt(
  authorizer: CognitoUserPoolAuthorizer,
  authorizationHeader: string | undefined,
  jwksCache: JwksCache,
  opts: { now?: () => number; warned?: Set<string> } = {}
): Promise<CachedAuthorizerResult & { identityHash: string | undefined; ttlSeconds: number }> {
  const now = opts.now ?? ((): number => Date.now());
  const token = extractBearer(authorizationHeader);
  if (!token) {
    return { allow: false, identityHash: undefined, ttlSeconds: 0 };
  }
  const jwksUrl = buildCognitoJwksUrl(authorizer.region, authorizer.userPoolId);
  const expectedIssuer = `https://cognito-idp.${authorizer.region}.amazonaws.com/${authorizer.userPoolId}`;
  return verifyAndShape(token, jwksUrl, expectedIssuer, undefined, jwksCache, opts.warned, now);
}

/**
 * Verify a Bearer JWT against an HTTP v2 JWT authorizer's `JwtConfiguration`.
 */
export async function verifyJwtAuthorizer(
  authorizer: JwtAuthorizer,
  authorizationHeader: string | undefined,
  jwksCache: JwksCache,
  opts: { now?: () => number; warned?: Set<string> } = {}
): Promise<CachedAuthorizerResult & { identityHash: string | undefined; ttlSeconds: number }> {
  const now = opts.now ?? ((): number => Date.now());
  const token = extractBearer(authorizationHeader);
  if (!token) {
    return { allow: false, identityHash: undefined, ttlSeconds: 0 };
  }
  // Cognito-issued JWTs let us hit the canonical JWKS URL directly. Other
  // issuers use OIDC discovery convention (`<issuer>/.well-known/jwks.json`).
  const jwksUrl =
    authorizer.region && authorizer.userPoolId
      ? buildCognitoJwksUrl(authorizer.region, authorizer.userPoolId)
      : buildJwksUrlFromIssuer(authorizer.issuer);
  return verifyAndShape(
    token,
    jwksUrl,
    authorizer.issuer.replace(/\/+$/, ''),
    authorizer.audience,
    jwksCache,
    opts.warned,
    now
  );
}

async function verifyAndShape(
  token: string,
  jwksUrl: string,
  expectedIssuer: string,
  expectedAudience: ReadonlyArray<string> | undefined,
  jwksCache: JwksCache,
  warned: Set<string> | undefined,
  now: () => number
): Promise<CachedAuthorizerResult & { identityHash: string | undefined; ttlSeconds: number }> {
  const identityHash = buildIdentityHash([token]);

  // Fetch JWKS first so the pass-through mode (JWKS unreachable) can
  // accept every Bearer token — including malformed / non-JWT garbage —
  // without needing to first parse the token. Pre-fix the parseJwt
  // check above the JWKS fetch denied malformed tokens even in
  // pass-through mode, contradicting the design intent ("every JWT
  // accepted as if valid" → "every Bearer token accepted").
  const jwks = await jwksCache.fetchAndCache(jwksUrl);

  if (jwks.passThrough) {
    if (warned && !warned.has(jwksUrl)) {
      warned.add(jwksUrl);
      getLogger()
        .child('cognito-jwt')
        .warn(
          `JWKS pass-through mode for ${jwksUrl}: token accepted without signature verification.`
        );
    }
    // Best-effort parse: a real JWT lets us still surface claims to the
    // handler. A malformed token gets a synthetic `unknown` principal
    // and an empty claims map. Either way the request is allowed.
    const parsed = parseJwt(token);
    if (parsed) {
      return shapeAllowResult(parsed, identityHash, now);
    }
    return {
      allow: true,
      principalId: 'unknown',
      context: {},
      identityHash,
      ttlSeconds: 0,
    };
  }

  const parsed = parseJwt(token);
  if (!parsed) {
    return { allow: false, identityHash, ttlSeconds: 0 };
  }

  const kid = parsed.header['kid'];
  if (typeof kid !== 'string') {
    return { allow: false, identityHash, ttlSeconds: 0 };
  }
  const key = jwks.byKid.get(kid);
  if (!key) {
    return { allow: false, identityHash, ttlSeconds: 0 };
  }

  if (!verifyRs256(token, key)) {
    return { allow: false, identityHash, ttlSeconds: 0 };
  }

  // Validate `exp`.
  const claims = parsed.payload;
  if (typeof claims['exp'] !== 'number' || claims['exp'] * 1000 <= now()) {
    return { allow: false, identityHash, ttlSeconds: 0 };
  }
  // Validate `iss` (best-effort — strip any trailing slash on either side).
  if (typeof claims['iss'] !== 'string' || claims['iss'].replace(/\/+$/, '') !== expectedIssuer) {
    return { allow: false, identityHash, ttlSeconds: 0 };
  }
  // Validate `aud` / `client_id`. Cognito access tokens use `client_id`,
  // ID tokens use `aud`. We accept whichever matches the allowlist.
  if (expectedAudience && expectedAudience.length > 0) {
    const aud = claims['aud'];
    const clientId = claims['client_id'];
    const audValues = Array.isArray(aud) ? aud : aud !== undefined ? [aud] : [];
    const matches =
      audValues.some((v) => typeof v === 'string' && expectedAudience.includes(v)) ||
      (typeof clientId === 'string' && expectedAudience.includes(clientId));
    if (!matches) {
      return { allow: false, identityHash, ttlSeconds: 0 };
    }
  }

  return shapeAllowResult(parsed, identityHash, now);
}

/**
 * Construct the Allow result for a verified JWT. The handler-side context
 * is the parsed claim map; principalId mirrors Cognito's deployed
 * behavior (the `sub` claim, falling back to `username` then `cognito:username`).
 */
function shapeAllowResult(
  parsed: ParsedJwt,
  identityHash: string,
  now: () => number
): CachedAuthorizerResult & { identityHash: string; ttlSeconds: number } {
  const claims = parsed.payload;
  const principalId =
    pickStringClaim(claims, 'sub') ??
    pickStringClaim(claims, 'cognito:username') ??
    pickStringClaim(claims, 'username') ??
    'unknown';
  // Cap TTL at min(remaining-exp, 300s). The local server shouldn't
  // outlive a real JWT; cdkd caches modestly to avoid spamming the
  // signature verifier on every request.
  const expMs = typeof claims['exp'] === 'number' ? claims['exp'] * 1000 : 0;
  const remainingSeconds = Math.max(0, Math.floor((expMs - now()) / 1000));
  const ttlSeconds = Math.min(300, remainingSeconds);
  return {
    allow: true,
    principalId,
    context: claims,
    identityHash,
    ttlSeconds,
  };
}

function pickStringClaim(claims: Record<string, unknown>, key: string): string | undefined {
  const v = claims[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Parse `Authorization: Bearer <token>` into the bare token. Whitespace
 * around `Bearer` is tolerated; case is matched leniently. Returns
 * `undefined` when the header is missing or doesn't look like a Bearer
 * scheme.
 */
function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^\s*Bearer\s+(.+)\s*$/i.exec(header);
  if (!m) return undefined;
  return m[1]!.trim();
}

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string; // `<headerB64>.<payloadB64>`
  signatureB64: string;
}

/**
 * Parse a JWT into `(header, payload, signingInput, signatureB64)`.
 * Returns undefined on malformed input — the caller maps that to deny.
 */
function parseJwt(token: string): ParsedJwt | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const headerJson = base64UrlDecodeToString(parts[0]!);
    const payloadJson = base64UrlDecodeToString(parts[1]!);
    const header = JSON.parse(headerJson) as Record<string, unknown>;
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signatureB64: parts[2]!,
    };
  } catch {
    return undefined;
  }
}

/**
 * Verify an RS256 JWT signature against an RSA public key derived from
 * the JWKS entry. Uses Node's `crypto.createPublicKey({key, format: 'jwk'})`
 * — Node 16+ understands the JWK format directly.
 */
function verifyRs256(token: string, key: JwksKey): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = base64UrlDecodeToBuffer(parts[2]!);
  try {
    // Node 16+ accepts the JWK shape via `format: 'jwk'`. Cast the
    // input through `unknown` so we don't need the DOM-side `JsonWebKey`
    // type at compile time.
    const publicKey = createPublicKey({
      key: { kty: key.kty, n: key.n, e: key.e },
      format: 'jwk',
    } as unknown as Parameters<typeof createPublicKey>[0]);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    verifier.end();
    return verifier.verify(publicKey, signature);
  } catch {
    return false;
  }
}

function base64UrlDecodeToString(input: string): string {
  return base64UrlDecodeToBuffer(input).toString('utf-8');
}

function base64UrlDecodeToBuffer(input: string): Buffer {
  // Add padding back: base64url strips `=` padding.
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, 'base64');
}
