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
