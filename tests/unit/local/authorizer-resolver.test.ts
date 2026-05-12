import { describe, expect, it } from 'vite-plus/test';
import {
  attachAuthorizers,
  resolveHttpApiAuthorizer,
  resolveRestV1Authorizer,
} from '../../../src/local/authorizer-resolver.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';
import { RouteDiscoveryError } from '../../../src/utils/error-handler.js';

function buildStack(stackName: string, resources: Record<string, TemplateResource>): StackInfo {
  const template: CloudFormationTemplate = { Resources: resources };
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template,
    dependencyNames: [],
  };
}

describe('resolveRestV1Authorizer — TOKEN', () => {
  it('parses default IdentitySource header', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGateway::Authorizer',
        Properties: {
          Type: 'TOKEN',
          AuthorizerUri: { 'Fn::GetAtt': ['MyAuthFn', 'Arn'] },
        },
      },
    });
    const info = resolveRestV1Authorizer('Auth', stack.template, 'S', 'S/Method');
    expect(info).toEqual({
      kind: 'lambda-token',
      logicalId: 'Auth',
      lambdaLogicalId: 'MyAuthFn',
      tokenHeader: 'authorization',
      resultTtlSeconds: 300,
      declaredAt: 'S/Method',
    });
  });

  it('honors custom IdentitySource header', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGateway::Authorizer',
        Properties: {
          Type: 'TOKEN',
          AuthorizerUri: { 'Fn::GetAtt': ['Fn', 'Arn'] },
          IdentitySource: 'method.request.header.X-Api-Key',
        },
      },
    });
    const info = resolveRestV1Authorizer('Auth', stack.template, 'S', 'S/Method');
    expect((info as { tokenHeader: string }).tokenHeader).toBe('x-api-key');
  });

  it('clamps TTL to the 3600s REST v1 max', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGateway::Authorizer',
        Properties: {
          Type: 'TOKEN',
          AuthorizerUri: { 'Fn::GetAtt': ['Fn', 'Arn'] },
          AuthorizerResultTtlInSeconds: 9999,
        },
      },
    });
    const info = resolveRestV1Authorizer('Auth', stack.template, 'S', 'S/Method');
    expect((info as { resultTtlSeconds: number }).resultTtlSeconds).toBe(3600);
  });

  it('rejects malformed IdentitySource', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGateway::Authorizer',
        Properties: {
          Type: 'TOKEN',
          AuthorizerUri: { 'Fn::GetAtt': ['Fn', 'Arn'] },
          IdentitySource: 'not-a-method-request-header',
        },
      },
    });
    expect(() => resolveRestV1Authorizer('Auth', stack.template, 'S', 'S/Method')).toThrow(
      RouteDiscoveryError
    );
  });
});

describe('resolveRestV1Authorizer — REQUEST', () => {
  it('parses comma-separated identity sources', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGateway::Authorizer',
        Properties: {
          Type: 'REQUEST',
          AuthorizerUri: { 'Fn::GetAtt': ['Fn', 'Arn'] },
          IdentitySource:
            'method.request.header.Authorization, method.request.querystring.token',
        },
      },
    });
    const info = resolveRestV1Authorizer('Auth', stack.template, 'S', 'S/Method');
    expect((info as { identitySources: unknown }).identitySources).toEqual([
      { kind: 'header', name: 'authorization' },
      { kind: 'query', name: 'token' },
    ]);
  });
});

describe('resolveRestV1Authorizer — COGNITO_USER_POOLS', () => {
  it('extracts region + userPoolId from ProviderARNs', () => {
    const arn = 'arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_abc123';
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGateway::Authorizer',
        Properties: {
          Type: 'COGNITO_USER_POOLS',
          ProviderARNs: [arn],
        },
      },
    });
    const info = resolveRestV1Authorizer('Auth', stack.template, 'S', 'S/Method');
    expect(info).toEqual({
      kind: 'cognito',
      logicalId: 'Auth',
      userPoolArn: arn,
      region: 'us-west-2',
      userPoolId: 'us-west-2_abc123',
      declaredAt: 'S/Method',
    });
  });

  it('rejects empty ProviderARNs', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGateway::Authorizer',
        Properties: { Type: 'COGNITO_USER_POOLS', ProviderARNs: [] },
      },
    });
    expect(() => resolveRestV1Authorizer('Auth', stack.template, 'S', 'S/Method')).toThrow(
      /missing ProviderARNs/
    );
  });

  it('rejects Fn::GetAtt-shaped ProviderARNs (literal required for JWKS URL)', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGateway::Authorizer',
        Properties: {
          Type: 'COGNITO_USER_POOLS',
          ProviderARNs: [{ 'Fn::GetAtt': ['UserPool', 'Arn'] }],
        },
      },
    });
    expect(() => resolveRestV1Authorizer('Auth', stack.template, 'S', 'S/Method')).toThrow(
      /literal ARN string|Fn::GetAtt/
    );
  });
});

describe('resolveRestV1Authorizer — unsupported', () => {
  it('rejects unknown Type', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGateway::Authorizer',
        Properties: { Type: 'AWS_IAM' },
      },
    });
    expect(() => resolveRestV1Authorizer('Auth', stack.template, 'S', 'S/Method')).toThrow(
      /not supported/
    );
  });
});

describe('resolveHttpApiAuthorizer', () => {
  it('parses REQUEST authorizer with v2 identity sources', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGatewayV2::Authorizer',
        Properties: {
          AuthorizerType: 'REQUEST',
          AuthorizerUri: { 'Fn::GetAtt': ['Fn', 'Arn'] },
          IdentitySource: ['$request.header.Authorization', '$request.querystring.token'],
        },
      },
    });
    const info = resolveHttpApiAuthorizer('Auth', undefined, stack.template, 'S', 'S/Route');
    expect(info).toMatchObject({
      kind: 'lambda-request',
      lambdaLogicalId: 'Fn',
      apiVersion: 'v2',
      identitySources: [
        { kind: 'header', name: 'authorization' },
        { kind: 'query', name: 'token' },
      ],
    });
  });

  // Issue #286 Gap 4: CDK 2.x `HttpLambdaAuthorizer` synthesizes the
  // same REST v1 invoke-ARN Fn::Join wrapper for AuthorizerUri that
  // route-discovery already accepts for IntegrationUri (verified via
  // real `cdk synth` 2026-05-12). The shared resolver now handles it.
  it('parses REQUEST authorizer with the CDK Fn::Join invoke-ARN AuthorizerUri shape', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGatewayV2::Authorizer',
        Properties: {
          AuthorizerType: 'REQUEST',
          AuthorizerUri: {
            'Fn::Join': [
              '',
              [
                'arn:',
                { Ref: 'AWS::Partition' },
                ':apigateway:',
                { Ref: 'AWS::Region' },
                ':lambda:path/2015-03-31/functions/',
                { 'Fn::GetAtt': ['MyAuthHandler', 'Arn'] },
                '/invocations',
              ],
            ],
          },
          IdentitySource: ['$request.header.Authorization'],
        },
      },
    });
    const info = resolveHttpApiAuthorizer('Auth', undefined, stack.template, 'S', 'S/Route');
    expect(info).toMatchObject({
      kind: 'lambda-request',
      lambdaLogicalId: 'MyAuthHandler',
      apiVersion: 'v2',
    });
  });

  it('parses REQUEST authorizer with Fn::Sub AuthorizerUri (1-arg invoke-ARN)', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGatewayV2::Authorizer',
        Properties: {
          AuthorizerType: 'REQUEST',
          AuthorizerUri: {
            'Fn::Sub':
              'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MyAuthHandler.Arn}/invocations',
          },
          IdentitySource: ['$request.header.Authorization'],
        },
      },
    });
    const info = resolveHttpApiAuthorizer('Auth', undefined, stack.template, 'S', 'S/Route');
    expect((info as { lambdaLogicalId: string }).lambdaLogicalId).toBe('MyAuthHandler');
  });

  it('rejects AuthorizerUri Fn::Join that is not an invoke-ARN wrapper', () => {
    // Same Fn::Join shape but the parts don't contain the
    // `:lambda:path/2015-03-31/functions/` marker — the resolver must
    // not silently pick a random GetAtt out of a structurally similar
    // but unrelated Fn::Join.
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGatewayV2::Authorizer',
        Properties: {
          AuthorizerType: 'REQUEST',
          AuthorizerUri: {
            'Fn::Join': [
              '/',
              ['prefix', { 'Fn::GetAtt': ['SomeOther', 'Arn'] }, 'suffix'],
            ],
          },
          IdentitySource: ['$request.header.Authorization'],
        },
      },
    });
    expect(() =>
      resolveHttpApiAuthorizer('Auth', undefined, stack.template, 'S', 'S/Route')
    ).toThrow(RouteDiscoveryError);
  });

  it('parses JWT authorizer + extracts Cognito region/userPoolId from issuer', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGatewayV2::Authorizer',
        Properties: {
          AuthorizerType: 'JWT',
          JwtConfiguration: {
            Issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_xyz999',
            Audience: ['app-client-id-1', 'app-client-id-2'],
          },
        },
      },
    });
    const info = resolveHttpApiAuthorizer('Auth', undefined, stack.template, 'S', 'S/Route');
    expect(info).toEqual({
      kind: 'jwt',
      logicalId: 'Auth',
      issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_xyz999',
      audience: ['app-client-id-1', 'app-client-id-2'],
      region: 'eu-west-1',
      userPoolId: 'eu-west-1_xyz999',
      declaredAt: 'S/Route',
    });
  });

  it('rejects unknown AuthorizerType', () => {
    const stack = buildStack('S', {
      Auth: {
        Type: 'AWS::ApiGatewayV2::Authorizer',
        Properties: { AuthorizerType: 'AWS_IAM' },
      },
    });
    expect(() =>
      resolveHttpApiAuthorizer('Auth', undefined, stack.template, 'S', 'S/Route')
    ).toThrow(/not supported/);
  });

  it('rejects JWT without JwtConfiguration', () => {
    const stack = buildStack('S', {
      Auth: { Type: 'AWS::ApiGatewayV2::Authorizer', Properties: { AuthorizerType: 'JWT' } },
    });
    expect(() =>
      resolveHttpApiAuthorizer('Auth', undefined, stack.template, 'S', 'S/Route')
    ).toThrow(/JwtConfiguration is required/);
  });
});

describe('attachAuthorizers', () => {
  it("attaches a TOKEN authorizer to a REST v1 method that names it", () => {
    const stack = buildStack('S', {
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          AuthorizationType: 'CUSTOM',
          AuthorizerId: { Ref: 'Auth' },
          HttpMethod: 'GET',
        },
      },
      Auth: {
        Type: 'AWS::ApiGateway::Authorizer',
        Properties: {
          Type: 'TOKEN',
          AuthorizerUri: { 'Fn::GetAtt': ['Fn', 'Arn'] },
        },
      },
    });
    const route: DiscoveredRoute = {
      method: 'GET',
      pathPattern: '/items',
      lambdaLogicalId: 'ItemHandler',
      source: 'rest-v1',
      apiVersion: 'v1',
      stage: 'prod',
      declaredAt: 'S/Method',
    };
    const out = attachAuthorizers([stack], [route]);
    expect(out).toHaveLength(1);
    expect(out[0]?.authorizer).toMatchObject({ kind: 'lambda-token', lambdaLogicalId: 'Fn' });
  });

  it('passes through routes without authorizers', () => {
    const stack = buildStack('S', {
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: { AuthorizationType: 'NONE', HttpMethod: 'GET' },
      },
    });
    const route: DiscoveredRoute = {
      method: 'GET',
      pathPattern: '/p',
      lambdaLogicalId: 'F',
      source: 'rest-v1',
      apiVersion: 'v1',
      stage: 'prod',
      declaredAt: 'S/Method',
    };
    const out = attachAuthorizers([stack], [route]);
    expect(out[0]?.authorizer).toBeUndefined();
  });

  it('hard-errors on AWS_IAM REST v1 (deferred)', () => {
    const stack = buildStack('S', {
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: { AuthorizationType: 'AWS_IAM', HttpMethod: 'GET' },
      },
    });
    const route: DiscoveredRoute = {
      method: 'GET',
      pathPattern: '/p',
      lambdaLogicalId: 'F',
      source: 'rest-v1',
      apiVersion: 'v1',
      stage: 'prod',
      declaredAt: 'S/Method',
    };
    expect(() => attachAuthorizers([stack], [route])).toThrow(RouteDiscoveryError);
  });
});
