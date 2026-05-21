/**
 * SigV4 signature verification for REST v1 `AuthorizationType: 'AWS_IAM'`
 * authorizers (closes #447).
 *
 * # Scope
 *
 * cdkd's `cdkd local start-api` runs API Gateway routes locally. When a
 * route declares `AuthorizationType: 'AWS_IAM'`, AWS-deployed API Gateway
 * validates the request's SigV4 signature against the calling identity's
 * IAM permissions. We can't fully reproduce that locally — IAM policy
 * evaluation requires the deployed IAM data plane — so the local server
 * does the **signature-verification** half only:
 *
 *   1. Parse the `Authorization: AWS4-HMAC-SHA256 ...` header into the
 *      `(credential, signedHeaders, signature)` triple.
 *   2. Reconstruct the canonical request per
 *      <https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html>.
 *   3. Derive the signing key from the dev's **local** secret access key
 *      (via the standard AWS SDK credential chain) + the request's date /
 *      region / service scope.
 *   4. Compare the recomputed signature against the header's `signature`
 *      value (constant-time compare).
 *
 * # Local-vs-deployed semantics (per `feedback_match_aws_default_over_opinionated.md`)
 *
 * Verification can only succeed when the request was signed with the
 * **same** credentials the local server can read. When the request's
 * `Credential=AKID/...` scope names a different access-key-id than the
 * one the dev has locally, cdkd cannot reproduce the signing key — we
 * **warn-and-pass** in that case (allow + log a one-line warn), matching
 * AWS's "verify locally what we can; defer real authorization to deploy
 * time" model. Refusing would force every dev with a SigV4-signed client
 * to use the exact same credential the local server sees, which is rarely
 * what they want.
 *
 * Genuinely missing / malformed signatures **are** rejected — those would
 * never reach the deployed API either.
 *
 * # NOT IN SCOPE
 *
 * - IAM resource / action / condition policy evaluation. The local server
 *   has no IAM data plane. Signature-verified callers reach the handler
 *   under their own identity; downstream authorization is the dev's
 *   responsibility.
 * - STS temporary credentials' session-token validation against AWS
 *   (we accept whatever session-token the dev provides locally).
 * - Multi-account / cross-account signing — we verify against the local
 *   default chain only.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import { buildIdentityHash } from './authorizer-resolver.js';
import type { CachedAuthorizerResult } from './authorizer-cache.js';

/**
 * The dev's resolved AWS credentials. Loaded lazily on first IAM-verify
 * call via the SDK default credential chain.
 */
export interface ResolvedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

/**
 * Loader for the dev's local credentials. Wrapped in a function so tests
 * can inject a stub; the production loader uses the AWS SDK default
 * credential chain (env vars → ~/.aws/config → IMDS → ...).
 */
export type CredentialsLoader = () => Promise<ResolvedCredentials>;

/**
 * Default credential loader: instantiates an `STSClient` (a direct cdkd
 * dependency) and asks its built-in credential provider for the dev's
 * local credentials. STSClient uses the same Node default credential
 * chain (env vars → ~/.aws/config → IMDS → ...) every other AWS SDK call
 * in cdkd uses, so this matches the deploy-time credential resolution
 * without adding a new dependency.
 */
export function defaultCredentialsLoader(): CredentialsLoader {
  let cached: Promise<ResolvedCredentials> | undefined;
  return () => {
    if (cached) return cached;
    cached = (async (): Promise<ResolvedCredentials> => {
      const { STSClient } = await import('@aws-sdk/client-sts');
      const client = new STSClient({});
      // STSClient typings (AWS SDK v3) expose `config.credentials` as a
      // memoized provider function; invoke it to resolve the dev's local
      // credentials via the default chain (env vars → ~/.aws/config →
      // IMDS → ...). The provider is cached internally by the SDK so
      // calling it multiple times is cheap.
      const creds = await client.config.credentials();
      client.destroy();
      return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      };
    })();
    return cached;
  };
}

/**
 * Snapshot of the inbound HTTP request needed to reconstruct the
 * canonical request. Matches the shape `runAuthorizerPass` already
 * builds for the other authorizer kinds.
 */
export interface SigV4VerifyRequest {
  /** HTTP method (uppercase). */
  method: string;
  /** Raw URL (path + optional query string). */
  rawUrl: string;
  /** Request headers as a single-value map (last value wins on duplicates). */
  headers: Record<string, string>;
  /** Body bytes (empty Buffer when GET / no body). */
  body: Buffer;
}

/**
 * Parsed Authorization header.
 *
 * Example header:
 *   `AWS4-HMAC-SHA256 Credential=AKID/20260101/us-east-1/execute-api/aws4_request,
 *    SignedHeaders=host;x-amz-date, Signature=abc...`
 */
interface ParsedAuthorization {
  algorithm: string;
  credentialAccessKeyId: string;
  credentialDate: string;
  credentialRegion: string;
  credentialService: string;
  credentialTerminator: string;
  signedHeaders: string[];
  signature: string;
}

/**
 * Outcome of {@link verifySigV4}. Matches the shape `runAuthorizerPass`
 * already produces for the other authorizer kinds so the http-server
 * cache + overlay paths reuse one record.
 */
export interface SigV4VerifyResult extends CachedAuthorizerResult {
  /** Hash for the per-`(authorizer, identity)` result cache. */
  identityHash: string | undefined;
}

/**
 * Verify the inbound request's `Authorization: AWS4-HMAC-SHA256 ...`
 * signature against the dev's local credentials.
 *
 * Outcomes:
 *   - **No / malformed Authorization header** → `{allow: false}`. The
 *     http-server maps this to 401 (REST v1 `missing-identity`).
 *   - **Signature mismatch** under the dev's own credentials → `{allow: false}`.
 *     The http-server maps this to 403 (REST v1 `policy-deny`).
 *   - **Different `Credential` access-key-id than the dev has** →
 *     `{allow: true}` plus a one-line warn (warn-and-pass; we can't
 *     reproduce a signing key we don't have).
 *   - **Valid signature with the dev's credentials** → `{allow: true}`.
 *     The principal id surfaced to the handler is the parsed
 *     `Credential` access-key-id.
 */
export async function verifySigV4(
  req: SigV4VerifyRequest,
  loadCredentials: CredentialsLoader,
  opts: {
    warnedForeignIds?: Set<string>;
    now?: () => Date;
    /**
     * Opt-in: when true, allow unverifiable SigV4 requests (foreign
     * access-key-id, or local-credentials-load failure) to pass through
     * with a warn instead of being denied. DEFAULT: false (fail-closed)
     * so a dev with no AWS credentials configured does not get
     * silently-unauthenticated IAM-protected routes. Reviewers asked us
     * to make this explicit because the previous fail-open default
     * exposed `event.requestContext.identity.accessKey`-trusting handler
     * code to spoofing in local dev.
     */
    allowUnverified?: boolean;
  } = {}
): Promise<SigV4VerifyResult> {
  const logger = getLogger();
  const authHeader = pickHeader(req.headers, 'authorization');
  if (!authHeader) {
    return { allow: false, identityHash: undefined };
  }

  let parsed: ParsedAuthorization;
  try {
    parsed = parseAuthorizationHeader(authHeader);
  } catch (err) {
    logger.debug(
      `AWS_IAM authorizer: malformed Authorization header — ${err instanceof Error ? err.message : String(err)}`
    );
    return { allow: false, identityHash: undefined };
  }

  if (parsed.algorithm !== 'AWS4-HMAC-SHA256') {
    logger.debug(`AWS_IAM authorizer: unsupported algorithm '${parsed.algorithm}'`);
    return { allow: false, identityHash: undefined };
  }
  if (parsed.credentialTerminator !== 'aws4_request') {
    logger.debug(
      `AWS_IAM authorizer: invalid credential scope terminator '${parsed.credentialTerminator}'`
    );
    return { allow: false, identityHash: undefined };
  }

  // The `x-amz-date` (or `date`) header must match the credential scope
  // date. We use `x-amz-date` when present (AWS SDK default), fall back
  // to `date` for compatibility with curl --aws-sigv4 etc.
  const amzDate = pickHeader(req.headers, 'x-amz-date') ?? pickHeader(req.headers, 'date');
  if (!amzDate) {
    logger.debug('AWS_IAM authorizer: missing x-amz-date / date header');
    return { allow: false, identityHash: undefined };
  }
  if (!validateAmzDateMatchesCredentialDate(amzDate, parsed.credentialDate)) {
    logger.debug(
      `AWS_IAM authorizer: x-amz-date '${amzDate}' does not match credential scope date '${parsed.credentialDate}'`
    );
    return { allow: false, identityHash: undefined };
  }

  // Optional clock-skew check: if the timestamp is more than 15 minutes
  // off the local clock, AWS rejects the request as expired. We mirror
  // that here — a missing `now` defaults to real time.
  const now = (opts.now ?? ((): Date => new Date()))();
  if (amzDateOutsideSkew(amzDate, now)) {
    logger.debug(`AWS_IAM authorizer: x-amz-date '${amzDate}' outside 15-min clock skew`);
    return { allow: false, identityHash: undefined };
  }

  // Load the dev's local credentials. Loader is cached so we hit the
  // credential chain at most once per server lifecycle.
  let local: ResolvedCredentials;
  try {
    local = await loadCredentials();
  } catch (err) {
    // Security: fail-closed by default. A dev with no AWS credentials
    // configured used to get unauthenticated-bypass on every IAM-protected
    // route — handler code that trusts `event.requestContext.identity.*`
    // was trivially spoofable in local dev. Opt-in
    // `--allow-unverified-sigv4` is the explicit escape hatch for dev
    // loops where signature verification is impractical.
    const reason = err instanceof Error ? err.message : String(err);
    if (!opts.allowUnverified) {
      logger.warn(
        `AWS_IAM authorizer: failed to resolve local AWS credentials (${reason}). Denying request; configure AWS credentials or pass --allow-unverified-sigv4 to opt into the warn-and-pass dev behavior.`
      );
      return { allow: false, identityHash: undefined };
    }
    logger.warn(
      `AWS_IAM authorizer: failed to resolve local AWS credentials (${reason}). --allow-unverified-sigv4 is set; passing through with unverified principalId 'unverified-no-creds'. Do NOT trust event.requestContext.identity.accessKey in handler code.`
    );
    return {
      allow: true,
      // Surface an obviously-fake principalId so handlers cannot be
      // fooled into trusting the unverified access-key-id.
      principalId: 'unverified-no-creds',
      identityHash: buildIdentityHash([parsed.signature]),
    };
  }

  // Foreign-identity request: the signer used an access key id we don't
  // have. We can't reproduce the signing key, so signature verification
  // is impossible. SECURITY: fail-closed by default — a fail-open here
  // lets anyone forge an `Authorization: AWS4-HMAC-SHA256 Credential=AKID-X/...`
  // header and be admitted as principal `AKID-X` against ANY handler
  // that trusts `event.requestContext.identity.accessKey`. The
  // `--allow-unverified-sigv4` flag is the explicit opt-in for dev
  // loops where calls from foreign identities are expected (e.g.
  // testing federated assume-role flows locally). Use case-insensitive
  // compare on the access key id — AWS docs are silent and a
  // lowercased AKID is a trivial bypass vector otherwise.
  if (local.accessKeyId.toLowerCase() !== parsed.credentialAccessKeyId.toLowerCase()) {
    const warned = opts.warnedForeignIds;
    // The dedup key MUST be normalized to match the case-insensitive
    // AKID compare above — otherwise an attacker probing variants
    // (AKIDFOREIGN, akidforeign, AkIdFOREIGN) would trigger a fresh
    // warn line per case. Case-insensitive compare → case-insensitive
    // dedup. (PR #484 review MINOR.)
    const dedupKey = parsed.credentialAccessKeyId.toLowerCase();
    if (!opts.allowUnverified) {
      if (!warned || !warned.has(dedupKey)) {
        logger.warn(
          `AWS_IAM authorizer: request signed with foreign access-key-id '${parsed.credentialAccessKeyId}'. ` +
            `Denying; pass --allow-unverified-sigv4 to opt into ` +
            `the warn-and-pass dev behavior, or call with credentials whose access-key-id matches your local one.`
        );
        warned?.add(dedupKey);
      }
      return { allow: false, identityHash: undefined };
    }
    if (!warned || !warned.has(dedupKey)) {
      logger.warn(
        `AWS_IAM authorizer: request signed with foreign access-key-id '${parsed.credentialAccessKeyId}'. ` +
          `--allow-unverified-sigv4 is set; passing through with unverified principalId 'unverified-foreign-identity'. ` +
          `Do NOT trust event.requestContext.authorizer.principalId in handler code.`
      );
      warned?.add(dedupKey);
    }
    return {
      allow: true,
      // Surface an obviously-fake principalId so handler code cannot
      // be fooled into trusting the unverified access-key-id.
      principalId: 'unverified-foreign-identity',
      identityHash: buildIdentityHash([parsed.signature]),
    };
  }

  // Same identity — reproduce the canonical request, derive the signing
  // key, recompute the signature, compare.
  const recomputed = computeSignature(req, parsed, local.secretAccessKey, amzDate);
  if (!constantTimeEqual(recomputed, parsed.signature)) {
    logger.debug(
      `AWS_IAM authorizer: signature mismatch (expected '${recomputed}', got '${parsed.signature}')`
    );
    return { allow: false, identityHash: undefined };
  }

  return {
    allow: true,
    principalId: parsed.credentialAccessKeyId,
    identityHash: buildIdentityHash([parsed.signature]),
  };
}

/**
 * Parse `AWS4-HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...`.
 * Rejects every other shape (including legacy `AWS4-HMAC-SHA256-...`
 * variants and HTTP/1.0-style multi-line values).
 */
export function parseAuthorizationHeader(value: string): ParsedAuthorization {
  const spaceIdx = value.indexOf(' ');
  if (spaceIdx < 0) {
    throw new Error('expected algorithm followed by parameters');
  }
  const algorithm = value.slice(0, spaceIdx).trim();
  const rest = value.slice(spaceIdx + 1).trim();

  // Split by commas; each piece is `Key=Value`. Whitespace around commas
  // is permitted by the AWS spec.
  const parts = rest.split(',').map((s) => s.trim());
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new Error(`malformed parameter '${part}'`);
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    fields[key] = val;
  }

  const credential = fields['Credential'];
  const signedHeaders = fields['SignedHeaders'];
  const signature = fields['Signature'];
  if (!credential) throw new Error('missing Credential');
  if (!signedHeaders) throw new Error('missing SignedHeaders');
  if (!signature) throw new Error('missing Signature');

  // Credential format: AKID/YYYYMMDD/region/service/aws4_request
  const credParts = credential.split('/');
  if (credParts.length !== 5) {
    throw new Error(`malformed Credential '${credential}' (expected 5 slash-separated segments)`);
  }
  const [accessKeyId, date, region, service, terminator] = credParts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (!/^[0-9]{8}$/.test(date)) {
    throw new Error(`malformed credential date '${date}' (expected YYYYMMDD)`);
  }

  return {
    algorithm,
    credentialAccessKeyId: accessKeyId,
    credentialDate: date,
    credentialRegion: region,
    credentialService: service,
    credentialTerminator: terminator,
    signedHeaders: signedHeaders.split(';').map((h) => h.trim().toLowerCase()),
    signature: signature.toLowerCase(),
  };
}

/**
 * AWS SigV4 canonical-request computation. Per
 * <https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html>:
 *
 *   CanonicalRequest =
 *     HTTPRequestMethod + '\n' +
 *     CanonicalURI + '\n' +
 *     CanonicalQueryString + '\n' +
 *     CanonicalHeaders + '\n' +
 *     SignedHeaders + '\n' +
 *     HexEncode(Hash(RequestPayload))
 *
 * Then:
 *   StringToSign = "AWS4-HMAC-SHA256\n" + AmzDate + "\n" +
 *                  CredentialScope + "\n" +
 *                  HexEncode(Hash(CanonicalRequest))
 *
 *   SigningKey = HMAC(HMAC(HMAC(HMAC("AWS4"+Secret, Date), Region), Service), "aws4_request")
 *   Signature  = HexEncode(HMAC(SigningKey, StringToSign))
 */
function computeSignature(
  req: SigV4VerifyRequest,
  parsed: ParsedAuthorization,
  secretAccessKey: string,
  amzDate: string
): string {
  const { path, query } = splitRawUrl(req.rawUrl);
  const canonicalUri = canonicalizePath(path);
  const canonicalQuery = canonicalizeQueryString(query);

  // Build canonical headers from the signedHeaders list — every named
  // header MUST be present (we reject early when missing). Values are
  // trimmed of leading/trailing whitespace and internal runs of spaces
  // collapsed to a single space (per the AWS spec).
  const headerLines: string[] = [];
  for (const name of parsed.signedHeaders) {
    const raw = pickHeader(req.headers, name);
    if (raw === undefined) {
      // Missing signed header → recompute will fail and the compare
      // returns false. We still produce a sentinel string so the caller
      // gets a deterministic "no match" rather than a thrown error.
      return 'missing-signed-header';
    }
    headerLines.push(`${name}:${normalizeHeaderValue(raw)}\n`);
  }
  const canonicalHeaders = headerLines.join('');
  const signedHeadersStr = parsed.signedHeaders.join(';');

  // Payload hash: AWS SigV4 supports an UNSIGNED-PAYLOAD marker (used by
  // streaming uploads); the inbound request's `x-amz-content-sha256`
  // header carries it. Fall back to hashing the actual body.
  const xAmzContentSha = pickHeader(req.headers, 'x-amz-content-sha256');
  const payloadHash =
    xAmzContentSha &&
    (xAmzContentSha === 'UNSIGNED-PAYLOAD' || /^[0-9a-f]{64}$/i.test(xAmzContentSha))
      ? xAmzContentSha.toLowerCase()
      : sha256Hex(req.body);

  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join('\n');

  const credentialScope = `${parsed.credentialDate}/${parsed.credentialRegion}/${parsed.credentialService}/${parsed.credentialTerminator}`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, parsed.credentialDate);
  const kRegion = hmac(kDate, parsed.credentialRegion);
  const kService = hmac(kRegion, parsed.credentialService);
  const kSigning = hmac(kService, 'aws4_request');
  return hmac(kSigning, stringToSign).toString('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Split a raw URL into (decoded path, raw query string).
 *
 * Important: keep the path RAW for canonicalization — the canonicalizer
 * does its own URI-encoding so we do NOT decode here.
 */
function splitRawUrl(rawUrl: string): { path: string; query: string } {
  const q = rawUrl.indexOf('?');
  if (q < 0) return { path: rawUrl, query: '' };
  return { path: rawUrl.slice(0, q), query: rawUrl.slice(q + 1) };
}

/**
 * Canonicalize the request path per the AWS SigV4 spec:
 *
 *   - URI-encode each path segment (reserved chars are percent-encoded
 *     EXCEPT `-_.~` which stay literal).
 *   - Encode `/` between segments unchanged.
 *   - Empty path → `/`.
 *
 * This matches the `execute-api` service's signing rules (no double-
 * encoding).
 */
export function canonicalizePath(path: string): string {
  if (!path || path === '') return '/';
  // The request path may already be percent-encoded from the wire. The
  // AWS SDK's signer normalizes by SINGLE-encoding the decoded path —
  // we mirror that.
  const decoded = path
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
  return decoded
    .split('/')
    .map((seg) => sigV4EncodePathSegment(seg))
    .join('/');
}

/**
 * Encode a single path segment per the SigV4 unreserved-set rules:
 * `A-Za-z0-9-_.~` stay literal; everything else is percent-encoded.
 */
function sigV4EncodePathSegment(seg: string): string {
  return seg.replace(/[^A-Za-z0-9\-_.~]/g, (ch) => {
    // Use encodeURIComponent and then upper-case the hex digits (AWS
    // canonical form uses upper-case hex).
    const enc = encodeURIComponent(ch);
    return enc.replace(/%[0-9a-f]{2}/g, (s) => s.toUpperCase());
  });
}

/**
 * Canonicalize the query string per SigV4: parse `key=value` pairs,
 * SORT by key (then by value on collisions), URI-encode each side
 * with upper-case hex, join with `&`.
 */
export function canonicalizeQueryString(query: string): string {
  if (!query) return '';
  const pairs: Array<[string, string]> = [];
  for (const raw of query.split('&')) {
    if (!raw) continue;
    const eq = raw.indexOf('=');
    const [k, v] = eq < 0 ? [raw, ''] : [raw.slice(0, eq), raw.slice(eq + 1)];
    let dk: string;
    let dv: string;
    try {
      dk = decodeURIComponent(k.replace(/\+/g, ' '));
    } catch {
      dk = k;
    }
    try {
      dv = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      dv = v;
    }
    pairs.push([sigV4EncodeQuery(dk), sigV4EncodeQuery(dv)]);
  }
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function sigV4EncodeQuery(s: string): string {
  return s.replace(/[^A-Za-z0-9\-_.~]/g, (ch) => {
    const enc = encodeURIComponent(ch);
    return enc.replace(/%[0-9a-f]{2}/g, (m) => m.toUpperCase());
  });
}

/**
 * Trim leading/trailing whitespace and collapse internal runs of
 * whitespace to a single space, per the SigV4 spec.
 */
function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function pickHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Compare two hex-encoded signatures in constant time. Returns false
 * when the lengths differ (the standard short-circuit, since timing
 * leaks on length are inherent to comparing values of different sizes).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  // Buffer.from('zz', 'hex') silently returns an empty buffer; guard
  // against that by checking the expected length matches what we got.
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * AWS SigV4 expects `x-amz-date` in ISO8601 basic form `YYYYMMDDTHHMMSSZ`.
 * The credential scope encodes only the date portion. We accept both
 * `x-amz-date` and the legacy `date` header (RFC 7231) for compat.
 */
export function validateAmzDateMatchesCredentialDate(
  amzDate: string,
  credentialDate: string
): boolean {
  // ISO8601 basic: YYYYMMDDTHHMMSSZ
  const isoMatch = /^(\d{8})T\d{6}Z$/.exec(amzDate);
  if (isoMatch) {
    return isoMatch[1] === credentialDate;
  }
  // RFC 7231: Mon, 02 Jan 2006 15:04:05 GMT
  try {
    const parsed = new Date(amzDate);
    if (Number.isNaN(parsed.getTime())) return false;
    const yyyy = parsed.getUTCFullYear().toString().padStart(4, '0');
    const mm = (parsed.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = parsed.getUTCDate().toString().padStart(2, '0');
    return `${yyyy}${mm}${dd}` === credentialDate;
  } catch {
    return false;
  }
}

/**
 * Reject SigV4 timestamps more than 15 minutes off the local clock —
 * matches AWS-deployed behavior (the `RequestTimeTooSkewed` error).
 */
export function amzDateOutsideSkew(amzDate: string, now: Date): boolean {
  const iso = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  let ts: Date;
  if (iso) {
    ts = new Date(
      Date.UTC(
        Number(iso[1]),
        Number(iso[2]) - 1,
        Number(iso[3]),
        Number(iso[4]),
        Number(iso[5]),
        Number(iso[6])
      )
    );
  } else {
    ts = new Date(amzDate);
  }
  if (Number.isNaN(ts.getTime())) return true;
  const deltaMs = Math.abs(ts.getTime() - now.getTime());
  return deltaMs > 15 * 60 * 1000;
}
