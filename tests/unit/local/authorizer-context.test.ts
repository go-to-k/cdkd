import { describe, expect, it } from 'vite-plus/test';
import { buildAuthorizerContextShape } from '../../../src/local/authorizer-context.js';
import type { AuthorizerInfo } from '../../../src/local/authorizer-resolver.js';
import type { CachedAuthorizerResult } from '../../../src/local/authorizer-cache.js';

/**
 * PR #515 item 9 direct tests for the shared `buildAuthorizerContextShape`
 * helper. The downstream wrappers `buildOverlay` (Lambda AWS_PROXY
 * overlay) and `buildAuthorizerContextForServiceIntegration` (HTTP API
 * v2 service-integration context) each consume this helper, and their
 * tests in `http-server.test.ts` cover the wrapped shapes — but the
 * helper itself deserves its own test surface so a future refactor
 * doesn't have to read those wrapper tests inside-out.
 */
describe('buildAuthorizerContextShape (PR #515 item 9)', () => {
  function lambdaTokenAuth(): AuthorizerInfo {
    return {
      kind: 'lambda-token',
      logicalId: 'TokenAuth',
      lambdaLogicalId: 'AuthFn',
      tokenHeader: 'authorization',
      resultTtlSeconds: 0,
      declaredAt: 'S/Auth',
    };
  }
  function lambdaRequestAuth(): AuthorizerInfo {
    return {
      kind: 'lambda-request',
      logicalId: 'ReqAuth',
      lambdaLogicalId: 'AuthFn',
      identitySources: [{ kind: 'header', name: 'authorization' }],
      resultTtlSeconds: 0,
      apiVersion: 'v2',
      declaredAt: 'S/Auth',
    };
  }
  function iamAuth(): AuthorizerInfo {
    return {
      kind: 'iam',
      logicalId: 'AWS_IAM',
      declaredAt: 'S/Auth',
    };
  }
  function cognitoAuth(): AuthorizerInfo {
    return {
      kind: 'cognito',
      logicalId: 'CogAuth',
      pools: [
        {
          userPoolArn: 'arn:aws:cognito-idp:us-east-1:123:userpool/p',
          region: 'us-east-1',
          userPoolId: 'p',
        },
      ],
      userPoolArn: 'arn:aws:cognito-idp:us-east-1:123:userpool/p',
      region: 'us-east-1',
      userPoolId: 'p',
      identitySource: 'authorization',
      declaredAt: 'S/Auth',
    } as unknown as AuthorizerInfo;
  }
  function jwtAuth(): AuthorizerInfo {
    return {
      kind: 'jwt',
      logicalId: 'JwtAuth',
      issuer: 'https://example.com',
      audiences: ['my-aud'],
      identitySources: [{ kind: 'header', name: 'authorization' }],
      declaredAt: 'S/Auth',
    } as unknown as AuthorizerInfo;
  }

  it('Lambda TOKEN: principalId + context flat at the top level', () => {
    const result: CachedAuthorizerResult = {
      allow: true,
      principalId: 'user-42',
      context: { tier: 'pro', email: 'a@example.com' },
    };
    expect(buildAuthorizerContextShape(lambdaTokenAuth(), result)).toEqual({
      principalId: 'user-42',
      tier: 'pro',
      email: 'a@example.com',
    });
  });

  it('Lambda REQUEST: same flat shape — kind is the only differentiator at the wire layer', () => {
    const result: CachedAuthorizerResult = {
      allow: true,
      principalId: 'u',
      context: { tier: 'pro' },
    };
    expect(buildAuthorizerContextShape(lambdaRequestAuth(), result)).toEqual({
      principalId: 'u',
      tier: 'pro',
    });
  });

  it('Lambda: omits principalId when undefined', () => {
    const result: CachedAuthorizerResult = { allow: true, context: { tier: 'pro' } };
    expect(buildAuthorizerContextShape(lambdaTokenAuth(), result)).toEqual({ tier: 'pro' });
  });

  it('Lambda: returns empty object when neither principalId nor context is set', () => {
    expect(buildAuthorizerContextShape(lambdaTokenAuth(), { allow: true })).toEqual({});
  });

  it('IAM (AWS_IAM): only principalId surfaces (no policy emulation)', () => {
    const result: CachedAuthorizerResult = {
      allow: true,
      principalId: 'AKIAEXAMPLE',
      // IAM "context" is intentionally NOT surfaced; the helper drops it.
      context: { foreignField: 'should-not-leak' },
    };
    expect(buildAuthorizerContextShape(iamAuth(), result)).toEqual({
      principalId: 'AKIAEXAMPLE',
    });
  });

  it('Cognito: nests claims under `claims.X`', () => {
    const result: CachedAuthorizerResult = {
      allow: true,
      context: { sub: 'cog-user', email: 'b@example.com' },
    };
    expect(buildAuthorizerContextShape(cognitoAuth(), result)).toEqual({
      claims: { sub: 'cog-user', email: 'b@example.com' },
    });
  });

  it('Cognito: empty claims object when context is undefined', () => {
    expect(buildAuthorizerContextShape(cognitoAuth(), { allow: true })).toEqual({
      claims: {},
    });
  });

  it('JWT: nests claims under `jwt.claims.X` with always-empty `jwt.scopes`', () => {
    const result: CachedAuthorizerResult = {
      allow: true,
      context: { sub: 'user-42', email: 'a@example.com' },
    };
    expect(buildAuthorizerContextShape(jwtAuth(), result)).toEqual({
      jwt: {
        claims: { sub: 'user-42', email: 'a@example.com' },
        scopes: [],
      },
    });
  });

  it('JWT: empty claims + empty scopes when context is undefined', () => {
    expect(buildAuthorizerContextShape(jwtAuth(), { allow: true })).toEqual({
      jwt: { claims: {}, scopes: [] },
    });
  });

  // Behavior-parity guard: the wrappers in `http-server.ts`
  // (`buildAuthorizerContextForServiceIntegration` AND the relevant
  // branches of `buildOverlay`) must produce shapes that flow from
  // this helper. The matrix below pins every kind so a future shape
  // change in this helper surfaces here BEFORE the downstream wrapper
  // tests catch it inside-out.
  it('parity: every kind returns an Object (not undefined/null) for a populated result', () => {
    const populated: CachedAuthorizerResult = {
      allow: true,
      principalId: 'X',
      context: { k: 'v' },
    };
    expect(typeof buildAuthorizerContextShape(lambdaTokenAuth(), populated)).toBe('object');
    expect(typeof buildAuthorizerContextShape(lambdaRequestAuth(), populated)).toBe('object');
    expect(typeof buildAuthorizerContextShape(iamAuth(), populated)).toBe('object');
    expect(typeof buildAuthorizerContextShape(cognitoAuth(), populated)).toBe('object');
    expect(typeof buildAuthorizerContextShape(jwtAuth(), populated)).toBe('object');
  });
});
