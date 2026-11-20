// go-to-k/cdkd#6690: a JWT `AWS::ApiGateway::Authorizer`'s JwtConfiguration
// on the SDK route, in the shapes API Gateway accepted live (us-east-1).
import { describe, it, expect, vi } from 'vite-plus/test';
import type { UpdateAuthorizerCommand } from '@aws-sdk/client-api-gateway';
import { updateAuthorizer } from '../../../src/provisioning/providers/apigateway/authorizer.js';
import {
  fromSdkJwtConfiguration,
  toSdkJwtConfiguration,
} from '../../../src/provisioning/providers/apigateway/jwt-configuration.js';

const CFN = {
  Issuers: [
    {
      Issuer: 'https://issuer.example.com',
      Audiences: ['aud-1'],
      AdditionalClaims: [
        { ClaimName: 'tenant', Format: 'SINGLE_STRING', Required: true, ExpectedValues: ['t-1'] },
      ],
    },
    { Issuer: 'https://other.example.com', Audiences: ['aud-2'] },
  ],
  DefaultAlgorithms: ['RS256', 'ES256'],
};

const SDK = {
  issuers: [
    {
      issuer: 'https://issuer.example.com',
      audiences: ['aud-1'],
      additionalClaims: [
        { claimName: 'tenant', format: 'SINGLE_STRING', required: true, expectedValues: ['t-1'] },
      ],
    },
    { issuer: 'https://other.example.com', audiences: ['aud-2'] },
  ],
  defaultAlgorithms: ['RS256', 'ES256'],
};

describe('updateAuthorizer and JwtConfiguration', () => {
  const BASE = {
    RestApiId: 'api-1',
    Name: 'jwt',
    Type: 'JWT',
    IdentitySource: 'method.request.header.Authorization',
  };

  async function update(desired: Record<string, unknown>, previous: Record<string, unknown>) {
    const send = vi.fn().mockResolvedValue({});
    const fake = { apiGatewayClient: { send }, wrapMaskedError: (_m: unknown, e: unknown) => e };
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), mask: (t: string) => t };
    await updateAuthorizer.call(
      fake as never,
      'Auth',
      'auth-1',
      'AWS::ApiGateway::Authorizer',
      desired,
      previous,
      log as never
    );
    return send.mock.calls.map(
      (c) => (c[0] as UpdateAuthorizerCommand).input.patchOperations ?? []
    );
  }

  it('replaces the block whole with its SDK JSON when it changed', async () => {
    const next = { ...CFN, DefaultAlgorithms: ['RS512'] };
    expect(await update({ ...BASE, JwtConfiguration: next }, { ...BASE, JwtConfiguration: CFN })).toEqual(
      [[{ op: 'replace', path: '/jwtConfiguration', value: JSON.stringify({ ...SDK, defaultAlgorithms: ['RS512'] }) }]]
    );
  });

  it('sends nothing for an unchanged block', async () => {
    expect(
      await update({ ...BASE, JwtConfiguration: CFN }, { ...BASE, JwtConfiguration: structuredClone(CFN) })
    ).toEqual([]);
  });

  it('refuses a JWT authorizer dropping the block before any call', async () => {
    await expect(update({ ...BASE }, { ...BASE, JwtConfiguration: CFN })).rejects.toThrow(
      /needs JwtConfiguration: API Gateway cannot remove it/
    );
  });

  it('sends nothing for the block when Type leaves JWT, which drops it', async () => {
    const token = { ...BASE, Type: 'TOKEN', AuthorizerUri: 'arn:uri' };
    const ops = (await update(token, { ...BASE, JwtConfiguration: CFN })).flat();
    expect(ops.map((o) => o.path)).not.toContain('/jwtConfiguration');
    expect(ops).toContainEqual({ op: 'replace', path: '/type', value: 'TOKEN' });
  });
});

describe('JwtConfiguration spellings', () => {
  it('maps every CFn member to the SDK one, omitting what the template omits', () => {
    expect(toSdkJwtConfiguration(CFN)).toEqual(SDK);
    expect(toSdkJwtConfiguration(undefined)).toBeUndefined();
  });

  it('reads back to the template spelling, dropping the read-only jwksUri', () => {
    const live = {
      ...SDK,
      issuers: SDK.issuers.map((i) => ({ ...i, jwksUri: 'https://issuer.example.com/jwks' })),
    };
    expect(fromSdkJwtConfiguration(live as never)).toEqual(CFN);
  });
});
