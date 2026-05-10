import { generateKeyPairSync, createSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildCognitoJwksUrl,
  buildJwksUrlFromIssuer,
  createJwksCache,
  verifyCognitoJwt,
  verifyJwtAuthorizer,
} from '../../../src/local/cognito-jwt.js';
import type {
  CognitoUserPoolAuthorizer,
  JwtAuthorizer,
} from '../../../src/local/authorizer-resolver.js';

/**
 * Test helper: produce an RSA keypair, an RFC 7518 JWK for the public
 * half, and a sign() that mints an RS256-signed JWT for the given header
 * + payload. We use this fixture for end-to-end JWT-verify tests.
 */
function makeJwtFixture(): {
  jwk: { kid: string; kty: string; n: string; e: string };
  sign: (header: Record<string, unknown>, payload: Record<string, unknown>) => string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const fullJwk = {
    kid: 'test-kid',
    kty: jwk['kty']!,
    n: jwk['n']!,
    e: jwk['e']!,
  };
  return {
    jwk: fullJwk,
    sign(header, payload) {
      const headerB64 = base64Url(Buffer.from(JSON.stringify({ ...header, kid: 'test-kid', alg: 'RS256' })));
      const payloadB64 = base64Url(Buffer.from(JSON.stringify(payload)));
      const signingInput = `${headerB64}.${payloadB64}`;
      const signer = createSign('RSA-SHA256');
      signer.update(signingInput);
      signer.end();
      const sigB64 = base64Url(signer.sign(privateKey));
      return `${signingInput}.${sigB64}`;
    },
  };
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const COGNITO_AUTH: CognitoUserPoolAuthorizer = {
  kind: 'cognito',
  logicalId: 'Auth',
  userPoolArn: 'arn:aws:cognito-idp:us-east-1:111:userpool/us-east-1_x',
  region: 'us-east-1',
  userPoolId: 'us-east-1_x',
  declaredAt: 'S/Method',
};

const JWT_AUTH: JwtAuthorizer = {
  kind: 'jwt',
  logicalId: 'Auth',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x',
  audience: ['test-audience'],
  region: 'us-east-1',
  userPoolId: 'us-east-1_x',
  declaredAt: 'S/Route',
};

describe('JWKS URL builders', () => {
  it('buildCognitoJwksUrl', () => {
    expect(buildCognitoJwksUrl('us-east-1', 'us-east-1_xyz')).toBe(
      'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xyz/.well-known/jwks.json'
    );
  });
  it('buildJwksUrlFromIssuer strips trailing slash', () => {
    expect(buildJwksUrlFromIssuer('https://issuer.example.com/')).toBe(
      'https://issuer.example.com/.well-known/jwks.json'
    );
    expect(buildJwksUrlFromIssuer('https://issuer.example.com')).toBe(
      'https://issuer.example.com/.well-known/jwks.json'
    );
  });
});

describe('createJwksCache — JWKS fetch failure → pass-through', () => {
  it('warns and falls back to pass-through when fetch throws', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const entry = await cache.fetchAndCache('https://no.example/jwks.json');
    expect(entry.passThrough).toBe(true);
    expect(entry.byKid.size).toBe(0);
  });

  it('caches successful fetches by URL', async () => {
    const fetchImpl = async (): Promise<{
      ok: boolean;
      status: number;
      text: () => Promise<string>;
    }> => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          keys: [{ kid: 'k1', kty: 'RSA', n: 'n', e: 'AQAB' }],
        }),
    });
    let now = 0;
    const cache = createJwksCache({ fetchImpl, now: () => now });
    const e1 = await cache.fetchAndCache('https://issuer/.well-known/jwks.json');
    expect(e1.byKid.has('k1')).toBe(true);
    expect(e1.passThrough).toBe(false);
    // Second call within TTL returns the same entry (no new fetch).
    const e2 = await cache.fetchAndCache('https://issuer/.well-known/jwks.json');
    expect(e2).toBe(e1);
  });
});

describe('verifyCognitoJwt — pass-through', () => {
  it('allows every JWT when JWKS is unreachable', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    const fixture = makeJwtFixture();
    const token = fixture.sign(
      {},
      {
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x',
      }
    );
    const result = await verifyCognitoJwt(COGNITO_AUTH, `Bearer ${token}`, cache);
    expect(result.allow).toBe(true);
  });

  it('rejects a missing Authorization header', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    const result = await verifyCognitoJwt(COGNITO_AUTH, undefined, cache);
    expect(result.allow).toBe(false);
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    const result = await verifyCognitoJwt(COGNITO_AUTH, 'Basic xyz', cache);
    expect(result.allow).toBe(false);
  });
});

describe('verifyCognitoJwt — happy path with real JWKS', () => {
  it('verifies an RS256-signed token against the user pool JWKS', async () => {
    const fixture = makeJwtFixture();
    const cache = createJwksCache({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ keys: [fixture.jwk] }),
      }),
    });
    const token = fixture.sign(
      {},
      {
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x',
      }
    );
    const result = await verifyCognitoJwt(COGNITO_AUTH, `Bearer ${token}`, cache);
    expect(result.allow).toBe(true);
    expect(result.principalId).toBe('user-1');
    expect((result.context as Record<string, unknown>)['sub']).toBe('user-1');
  });

  it('rejects an expired token', async () => {
    const fixture = makeJwtFixture();
    const cache = createJwksCache({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ keys: [fixture.jwk] }),
      }),
    });
    const token = fixture.sign(
      {},
      {
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) - 60,
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x',
      }
    );
    const result = await verifyCognitoJwt(COGNITO_AUTH, `Bearer ${token}`, cache);
    expect(result.allow).toBe(false);
  });

  it('rejects a wrong issuer', async () => {
    const fixture = makeJwtFixture();
    const cache = createJwksCache({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ keys: [fixture.jwk] }),
      }),
    });
    const token = fixture.sign(
      {},
      {
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'https://attacker.example.com/x',
      }
    );
    const result = await verifyCognitoJwt(COGNITO_AUTH, `Bearer ${token}`, cache);
    expect(result.allow).toBe(false);
  });
});

describe('verifyJwtAuthorizer — audience check', () => {
  it('accepts a token whose aud matches the configured audience', async () => {
    const fixture = makeJwtFixture();
    const cache = createJwksCache({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ keys: [fixture.jwk] }),
      }),
    });
    const token = fixture.sign(
      {},
      {
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x',
        aud: 'test-audience',
      }
    );
    const result = await verifyJwtAuthorizer(JWT_AUTH, `Bearer ${token}`, cache);
    expect(result.allow).toBe(true);
  });

  it('rejects a token whose aud does not match', async () => {
    const fixture = makeJwtFixture();
    const cache = createJwksCache({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ keys: [fixture.jwk] }),
      }),
    });
    const token = fixture.sign(
      {},
      {
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x',
        aud: 'wrong-audience',
      }
    );
    const result = await verifyJwtAuthorizer(JWT_AUTH, `Bearer ${token}`, cache);
    expect(result.allow).toBe(false);
  });

  it('accepts client_id when aud is absent (Cognito access tokens)', async () => {
    const fixture = makeJwtFixture();
    const cache = createJwksCache({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ keys: [fixture.jwk] }),
      }),
    });
    const token = fixture.sign(
      {},
      {
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x',
        client_id: 'test-audience',
      }
    );
    const result = await verifyJwtAuthorizer(JWT_AUTH, `Bearer ${token}`, cache);
    expect(result.allow).toBe(true);
  });
});

describe('verifyCognitoJwt — malformed token', () => {
  it('rejects a non-3-part token', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ keys: [] }),
      }),
    });
    const result = await verifyCognitoJwt(COGNITO_AUTH, 'Bearer abc.def', cache);
    expect(result.allow).toBe(false);
  });

  it('rejects a token whose kid is not in the JWKS', async () => {
    const fixture = makeJwtFixture();
    const cache = createJwksCache({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ keys: [{ kid: 'other-kid', kty: 'RSA', n: 'n', e: 'AQAB' }] }),
      }),
    });
    const token = fixture.sign(
      {},
      {
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x',
      }
    );
    const result = await verifyCognitoJwt(COGNITO_AUTH, `Bearer ${token}`, cache);
    expect(result.allow).toBe(false);
  });
});

/**
 * Should-fix #5: pass-through must accept every JWT including malformed
 * tokens (design says "every JWT accepted as if valid" → "every Bearer
 * token accepted"). Pre-fix the parseJwt check above the JWKS fetch
 * denied malformed tokens even in pass-through mode.
 */
describe('verifyCognitoJwt — pass-through accepts malformed tokens', () => {
  it('allows a non-JWT garbage token in pass-through mode', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    const result = await verifyCognitoJwt(COGNITO_AUTH, 'Bearer not-a-jwt', cache);
    expect(result.allow).toBe(true);
    expect(result.principalId).toBe('unknown');
    expect(result.context).toEqual({});
  });

  it('allows a 2-part malformed token in pass-through mode', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    const result = await verifyCognitoJwt(COGNITO_AUTH, 'Bearer abc.def', cache);
    expect(result.allow).toBe(true);
  });
});

/**
 * Should-fix #7: a transient JWKS-fetch failure should NOT lock
 * pass-through for a full 1hr — short failure TTL (~60s default) means
 * the next minute's request retries the fetch.
 */
describe('createJwksCache — failure TTL is shorter than success TTL', () => {
  it('failure entry expires after the failure TTL, allowing a retry', async () => {
    let now = 0;
    let attempts = 0;
    const cache = createJwksCache({
      now: () => now,
      ttlMs: 60 * 60 * 1000, // 1hr success TTL
      failureTtlMs: 60 * 1000, // 60s failure TTL
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('blip');
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ keys: [{ kid: 'k1', kty: 'RSA', n: 'n', e: 'AQAB' }] }),
        };
      },
    });
    const e1 = await cache.fetchAndCache('https://issuer/.well-known/jwks.json');
    expect(e1.passThrough).toBe(true);

    // 30s later: still in pass-through (within failure TTL).
    now = 30 * 1000;
    const e2 = await cache.fetchAndCache('https://issuer/.well-known/jwks.json');
    expect(e2).toBe(e1);
    expect(attempts).toBe(1);

    // 90s later: failure TTL expired, retry succeeds.
    now = 90 * 1000;
    const e3 = await cache.fetchAndCache('https://issuer/.well-known/jwks.json');
    expect(e3.passThrough).toBe(false);
    expect(e3.byKid.has('k1')).toBe(true);
    expect(attempts).toBe(2);
  });

  it('success TTL refreshes after the configured ttlMs (covers the existing-but-untested branch)', async () => {
    let now = 0;
    let fetchCalls = 0;
    const cache = createJwksCache({
      now: () => now,
      ttlMs: 1000, // 1s for fast test
      fetchImpl: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              keys: [{ kid: `k${fetchCalls}`, kty: 'RSA', n: 'n', e: 'AQAB' }],
            }),
        };
      },
    });
    await cache.fetchAndCache('https://issuer/.well-known/jwks.json');
    expect(fetchCalls).toBe(1);

    // Advance now() past TTL — next fetchAndCache must re-fetch.
    now = 2000;
    const e2 = await cache.fetchAndCache('https://issuer/.well-known/jwks.json');
    expect(fetchCalls).toBe(2);
    expect(e2.byKid.has('k2')).toBe(true);
  });
});

/**
 * The existing test suite covered fetch THROW (network exception). This
 * pins the OTHER failure-mode branch: the response arrives but is HTTP
 * non-2xx (e.g. 500 from the JWKS endpoint).
 */
describe('createJwksCache — JWKS HTTP-error path', () => {
  it('falls through to pass-through when response.ok is false', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      }),
    });
    const entry = await cache.fetchAndCache('https://issuer/.well-known/jwks.json');
    expect(entry.passThrough).toBe(true);
    expect(entry.byKid.size).toBe(0);
  });
});

/**
 * Pin extractBearer's whitespace / case tolerance via verifyCognitoJwt:
 * the helper itself is private but every JWT path goes through it, so
 * verifying via the public surface is enough.
 */
describe('verifyCognitoJwt — extractBearer edge cases', () => {
  it('accepts a lowercase bearer scheme (case-insensitive)', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    // Pass-through mode allows the "valid Bearer token" path; we only
    // care that extractBearer didn't reject the lowercase scheme.
    const result = await verifyCognitoJwt(COGNITO_AUTH, 'bearer xyz', cache);
    expect(result.allow).toBe(true);
  });

  it('accepts a Bearer scheme with double space before the token', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    const result = await verifyCognitoJwt(COGNITO_AUTH, 'Bearer  xyz', cache);
    expect(result.allow).toBe(true);
  });

  it('rejects a Bearer scheme with no token (just whitespace)', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    const result = await verifyCognitoJwt(COGNITO_AUTH, 'Bearer ', cache);
    expect(result.allow).toBe(false);
  });

  /**
   * Bearer regex tightened to `[A-Za-z0-9._\-]+` (JWT character class).
   * Pre-fix the regex was `(.+)`, so embedded whitespace in the header
   * (`Bearer foo bar`) captured `foo bar` as the token — the JWT parser
   * then quietly failed on the embedded space. Reject early at the
   * extract layer instead, which gives a cleaner 401.
   */
  it('rejects a Bearer header with embedded whitespace inside the token', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    const result = await verifyCognitoJwt(COGNITO_AUTH, 'Bearer foo bar', cache);
    expect(result.allow).toBe(false);
  });

  it('accepts a real-looking JWT token (base64url + dots)', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    // JWT character class: A-Z a-z 0-9 . _ -
    const result = await verifyCognitoJwt(
      COGNITO_AUTH,
      'Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6ImtpZC0xIn0.eyJzdWIiOiJ1Iiwib2suaWdub3JlIjp0cnVlfQ.sig-abc_def',
      cache
    );
    expect(result.allow).toBe(true);
  });

  it('rejects a Bearer header containing non-JWT characters in the token', async () => {
    const cache = createJwksCache({
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    // Quote chars / spaces / `=` / `+` / `/` are all outside the JWT class.
    expect((await verifyCognitoJwt(COGNITO_AUTH, 'Bearer "abc"', cache)).allow).toBe(false);
    expect((await verifyCognitoJwt(COGNITO_AUTH, 'Bearer abc=def', cache)).allow).toBe(false);
    expect((await verifyCognitoJwt(COGNITO_AUTH, 'Bearer a+b/c', cache)).allow).toBe(false);
  });
});
