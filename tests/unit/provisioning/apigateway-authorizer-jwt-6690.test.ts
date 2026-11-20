// go-to-k/cdkd#6690: a JWT `AWS::ApiGateway::Authorizer`'s JwtConfiguration
// on the SDK route, in the shapes API Gateway accepted live (us-east-1).
import { describe, it, expect } from 'vite-plus/test';
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
