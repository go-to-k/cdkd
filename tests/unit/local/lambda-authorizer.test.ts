import { describe, expect, it, vi } from 'vitest';
import {
  buildMethodArn,
  invokeRequestAuthorizer,
  invokeTokenAuthorizer,
  parseLambdaAuthorizerResponse,
} from '../../../src/local/lambda-authorizer.js';
import type {
  LambdaRequestAuthorizer,
  LambdaTokenAuthorizer,
} from '../../../src/local/authorizer-resolver.js';

vi.mock('../../../src/local/rie-client.js', () => ({
  invokeRie: vi.fn(),
}));
import * as rieClient from '../../../src/local/rie-client.js';
const invokeRieMock = rieClient.invokeRie as unknown as ReturnType<typeof vi.fn>;

function makePool(): { pool: unknown; acquire: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
  const acquire = vi.fn(async () => ({ containerHost: '127.0.0.1', hostPort: 1234 }));
  const release = vi.fn();
  const pool = {
    acquire,
    release,
    dispose: vi.fn(async () => undefined),
  };
  return { pool, acquire, release };
}

const baseRequest = {
  method: 'GET',
  headers: { authorization: 'Bearer xyz123', 'user-agent': 'test' },
  queryStringParameters: { token: 'qtok' },
  pathParameters: {},
  sourceIp: '127.0.0.1',
  matchedPath: '/items/42',
  stage: 'prod',
};

describe('buildMethodArn', () => {
  it('strips the leading slash from the path', () => {
    expect(
      buildMethodArn({
        apiId: 'a',
        accountId: '111',
        stage: 'prod',
        method: 'get',
        path: '/items/42',
      })
    ).toBe('arn:aws:execute-api:local:111:a/prod/GET/items/42');
  });
});

describe('parseLambdaAuthorizerResponse', () => {
  const methodArn = 'arn:aws:execute-api:local:123456789012:local/prod/GET/items/42';

  it("returns allow=false for missing policyDocument", () => {
    const result = parseLambdaAuthorizerResponse({ principalId: 'u' }, methodArn, 'h');
    expect(result.allow).toBe(false);
    expect(result.principalId).toBe('u');
  });

  it('returns allow=true for matching Allow Resource (literal)', () => {
    const result = parseLambdaAuthorizerResponse(
      {
        principalId: 'u',
        policyDocument: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Action: 'execute-api:Invoke', Resource: methodArn }],
        },
        context: { foo: 'bar' },
      },
      methodArn,
      'h'
    );
    expect(result.allow).toBe(true);
    expect(result.context).toEqual({ foo: 'bar' });
  });

  it('returns allow=true for wildcard Resource', () => {
    const result = parseLambdaAuthorizerResponse(
      {
        principalId: 'u',
        policyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Resource: 'arn:aws:execute-api:local:123456789012:local/prod/*/*',
            },
          ],
        },
      },
      methodArn,
      'h'
    );
    expect(result.allow).toBe(true);
  });

  it('returns allow=false for Deny statements', () => {
    const result = parseLambdaAuthorizerResponse(
      {
        principalId: 'u',
        policyDocument: {
          Statement: [{ Effect: 'Deny', Resource: methodArn }],
        },
      },
      methodArn,
      'h'
    );
    expect(result.allow).toBe(false);
  });

  it('returns allow=false for non-matching Resource', () => {
    const result = parseLambdaAuthorizerResponse(
      {
        policyDocument: {
          Statement: [{ Effect: 'Allow', Resource: 'arn:aws:execute-api:local:111:other/x/y/z' }],
        },
      },
      methodArn,
      'h'
    );
    expect(result.allow).toBe(false);
  });
});

describe('invokeTokenAuthorizer', () => {
  const auth: LambdaTokenAuthorizer = {
    kind: 'lambda-token',
    logicalId: 'Auth',
    lambdaLogicalId: 'AuthFn',
    tokenHeader: 'authorization',
    resultTtlSeconds: 300,
    declaredAt: 'S/Method',
  };

  it('builds a TOKEN event and parses an Allow response', async () => {
    const { pool, acquire, release } = makePool();
    invokeRieMock.mockResolvedValueOnce({
      raw: '',
      payload: {
        principalId: 'u1',
        policyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Resource: 'arn:aws:execute-api:local:123456789012:local/prod/GET/items/42',
            },
          ],
        },
        context: { user: 'u1' },
      },
    });
    const result = await invokeTokenAuthorizer(auth, baseRequest, {
      pool: pool as never,
      rieTimeoutMs: 1000,
      methodArn: 'arn:aws:execute-api:local:123456789012:local/prod/GET/items/42',
      mockAccountId: '123456789012',
      mockApiId: 'local',
    });
    expect(result.allow).toBe(true);
    expect(result.principalId).toBe('u1');
    expect(result.context).toEqual({ user: 'u1' });
    expect(acquire).toHaveBeenCalledWith('AuthFn');
    expect(release).toHaveBeenCalledOnce();
    const event = invokeRieMock.mock.calls[0]![2];
    expect(event).toMatchObject({
      type: 'TOKEN',
      authorizationToken: 'Bearer xyz123',
      methodArn: 'arn:aws:execute-api:local:123456789012:local/prod/GET/items/42',
    });
  });

  it("returns allow=false without invoking the Lambda when the token header is missing", async () => {
    const { pool, acquire } = makePool();
    invokeRieMock.mockClear();
    const result = await invokeTokenAuthorizer(
      auth,
      { ...baseRequest, headers: { 'user-agent': 'test' } },
      {
        pool: pool as never,
        rieTimeoutMs: 1000,
        methodArn: 'm',
        mockAccountId: '1',
        mockApiId: 'local',
      }
    );
    expect(result.allow).toBe(false);
    expect(acquire).not.toHaveBeenCalled();
    expect(invokeRieMock).not.toHaveBeenCalled();
  });
});

describe('invokeRequestAuthorizer (HTTP v2 simple shape)', () => {
  const auth: LambdaRequestAuthorizer = {
    kind: 'lambda-request',
    logicalId: 'Auth',
    lambdaLogicalId: 'AuthFn',
    identitySources: [{ kind: 'header', name: 'authorization' }],
    resultTtlSeconds: 60,
    apiVersion: 'v2',
    declaredAt: 'S/Route',
  };

  it('parses the v2 simple {isAuthorized,context} shape', async () => {
    const { pool } = makePool();
    invokeRieMock.mockResolvedValueOnce({
      raw: '',
      payload: { isAuthorized: true, context: { tier: 'pro' } },
    });
    const result = await invokeRequestAuthorizer(auth, baseRequest, {
      pool: pool as never,
      rieTimeoutMs: 1000,
      methodArn: 'arn:aws:execute-api:local:123456789012:local/prod/GET/items/42',
      mockAccountId: '123456789012',
      mockApiId: 'local',
    });
    expect(result.allow).toBe(true);
    expect(result.context).toEqual({ tier: 'pro' });
  });

  it('falls back to IAM-policy parse when isAuthorized is missing', async () => {
    const { pool } = makePool();
    invokeRieMock.mockResolvedValueOnce({
      raw: '',
      payload: {
        principalId: 'u',
        policyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Resource: 'arn:aws:execute-api:local:123456789012:local/prod/GET/items/42',
            },
          ],
        },
      },
    });
    const result = await invokeRequestAuthorizer(auth, baseRequest, {
      pool: pool as never,
      rieTimeoutMs: 1000,
      methodArn: 'arn:aws:execute-api:local:123456789012:local/prod/GET/items/42',
      mockAccountId: '123456789012',
      mockApiId: 'local',
    });
    expect(result.allow).toBe(true);
  });
});

describe('invokeRequestAuthorizer (REST v1 missing identity)', () => {
  it('returns allow=false (401) when every identity source is empty', async () => {
    const auth: LambdaRequestAuthorizer = {
      kind: 'lambda-request',
      logicalId: 'Auth',
      lambdaLogicalId: 'AuthFn',
      identitySources: [{ kind: 'header', name: 'authorization' }],
      resultTtlSeconds: 60,
      apiVersion: 'v1',
      declaredAt: 'S/Method',
    };
    const { pool, acquire } = makePool();
    invokeRieMock.mockClear();
    const result = await invokeRequestAuthorizer(
      auth,
      { ...baseRequest, headers: { 'user-agent': 'test' } },
      {
        pool: pool as never,
        rieTimeoutMs: 1000,
        methodArn: 'm',
        mockAccountId: '1',
        mockApiId: 'local',
      }
    );
    expect(result.allow).toBe(false);
    expect(acquire).not.toHaveBeenCalled();
    expect(invokeRieMock).not.toHaveBeenCalled();
  });
});
