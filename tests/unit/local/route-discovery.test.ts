import { describe, expect, it } from 'vitest';
import { discoverRoutes } from '../../../src/local/route-discovery.js';
import { RouteDiscoveryError } from '../../../src/utils/error-handler.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

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

describe('discoverRoutes — REST v1', () => {
  it('builds path by walking ParentId chain to RestApi root', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: 'A' } },
      RootProxyResource: {
        Type: 'AWS::ApiGateway::Resource',
        Properties: {
          RestApiId: { Ref: 'Api' },
          ParentId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          PathPart: 'items',
        },
      },
      ItemIdResource: {
        Type: 'AWS::ApiGateway::Resource',
        Properties: {
          RestApiId: { Ref: 'Api' },
          ParentId: { Ref: 'RootProxyResource' },
          PathPart: '{id}',
        },
      },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { Ref: 'ItemIdResource' },
          Integration: {
            Type: 'AWS_PROXY',
            Uri: { 'Fn::GetAtt': ['MyHandler', 'Arn'] },
          },
        },
      },
      Stage: {
        Type: 'AWS::ApiGateway::Stage',
        Properties: { RestApiId: { Ref: 'Api' }, StageName: 'prod' },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes).toEqual([
      {
        method: 'GET',
        pathPattern: '/items/{id}',
        lambdaLogicalId: 'MyHandler',
        source: 'rest-v1',
        apiVersion: 'v1',
        stage: 'prod',
        declaredAt: 'S/Method',
      },
    ]);
  });

  it("parses CDK's REST v1 invoke-ARN Fn::Join wrapper", () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'ANY',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'AWS_PROXY',
            Uri: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  { Ref: 'AWS::Partition' },
                  ':apigateway:',
                  { Ref: 'AWS::Region' },
                  ':lambda:path/2015-03-31/functions/',
                  { 'Fn::GetAtt': ['MyHandler', 'Arn'] },
                  '/invocations',
                ],
              ],
            },
          },
        },
      },
    });
    expect(discoverRoutes([stack])[0]?.lambdaLogicalId).toBe('MyHandler');
  });

  it('treats { Ref: lambda } as the Lambda logical ID', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: { Type: 'AWS_PROXY', Uri: { Ref: 'MyHandler' } },
        },
      },
    });
    expect(discoverRoutes([stack])[0]?.lambdaLogicalId).toBe('MyHandler');
  });

  it("falls back to '$default' when no Stage is attached", () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'POST',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: { Type: 'AWS_PROXY', Uri: { 'Fn::GetAtt': ['Handler', 'Arn'] } },
        },
      },
    });
    expect(discoverRoutes([stack])[0]?.stage).toBe('$default');
  });

  it('rejects non-AWS_PROXY integrations', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: { Type: 'MOCK' },
        },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(RouteDiscoveryError);
    try {
      discoverRoutes([stack]);
    } catch (e) {
      expect((e as Error).message).toMatch(/MOCK.*not supported/);
    }
  });

  it('rejects unsupported intrinsics in IntegrationUri', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: { Type: 'AWS_PROXY', Uri: { 'Fn::Sub': '${Handler.Arn}' } },
        },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(RouteDiscoveryError);
  });
});

describe('discoverRoutes — REST v1 buildRestV1Path error branches', () => {
  // Each test fixtures a malformed template stub and asserts the
  // specific error message thrown by `buildRestV1Path` so a regression
  // in the wording / class can't slip through unnoticed.

  it('throws on cycle in ParentId chain', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      A: {
        Type: 'AWS::ApiGateway::Resource',
        Properties: {
          RestApiId: { Ref: 'Api' },
          ParentId: { Ref: 'B' },
          PathPart: 'a',
        },
      },
      B: {
        Type: 'AWS::ApiGateway::Resource',
        Properties: {
          RestApiId: { Ref: 'Api' },
          ParentId: { Ref: 'A' },
          PathPart: 'b',
        },
      },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { Ref: 'A' },
          Integration: { Type: 'AWS_PROXY', Uri: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
        },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(/cycle detected in AWS::ApiGateway::Resource ParentId chain/);
  });

  it('throws on missing parent resource', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Orphan: {
        Type: 'AWS::ApiGateway::Resource',
        Properties: {
          RestApiId: { Ref: 'Api' },
          ParentId: { Ref: 'DoesNotExist' },
          PathPart: 'orphan',
        },
      },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { Ref: 'Orphan' },
          Integration: { Type: 'AWS_PROXY', Uri: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
        },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(/ParentId chain references missing resource 'DoesNotExist'/);
  });

  it('throws when ParentId chain hits a non-Resource type', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Strange: {
        // Wrong type; pretends to be a parent.
        Type: 'AWS::S3::Bucket',
        Properties: {},
      },
      Child: {
        Type: 'AWS::ApiGateway::Resource',
        Properties: {
          RestApiId: { Ref: 'Api' },
          ParentId: { Ref: 'Strange' },
          PathPart: 'child',
        },
      },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { Ref: 'Child' },
          Integration: { Type: 'AWS_PROXY', Uri: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
        },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(
      /ParentId chain hit AWS::S3::Bucket \(expected AWS::ApiGateway::Resource or RestApi root\)/
    );
  });

  it('throws on Resource missing PathPart', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      MissingPathPart: {
        Type: 'AWS::ApiGateway::Resource',
        Properties: {
          RestApiId: { Ref: 'Api' },
          ParentId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          // PathPart missing.
        },
      },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { Ref: 'MissingPathPart' },
          Integration: { Type: 'AWS_PROXY', Uri: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
        },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(
      /AWS::ApiGateway::Resource 'MissingPathPart' missing PathPart/
    );
  });
});

describe('discoverRoutes — HTTP API v2', () => {
  it('parses RouteKey and resolves Target integration', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'Api' },
          IntegrationType: 'AWS_PROXY',
          IntegrationUri: { 'Fn::GetAtt': ['Handler', 'Arn'] },
        },
      },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'Api' },
          RouteKey: 'GET /items/{id}',
          Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Integ' }]] },
        },
      },
    });
    expect(discoverRoutes([stack])[0]).toEqual({
      method: 'GET',
      pathPattern: '/items/{id}',
      lambdaLogicalId: 'Handler',
      source: 'http-api',
      apiVersion: 'v2',
      stage: '$default',
      declaredAt: 'S/Route',
    });
  });

  it('rejects WebSocket protocol APIs', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'WEBSOCKET' } },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'Api' },
          IntegrationType: 'AWS_PROXY',
          IntegrationUri: { 'Fn::GetAtt': ['Handler', 'Arn'] },
        },
      },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'Api' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Integ' }]] },
        },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(RouteDiscoveryError);
  });

  it('rejects integrations with IntegrationSubtype set (service integrations)', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'Api' },
          IntegrationType: 'AWS_PROXY',
          IntegrationSubtype: 'SQS-SendMessage',
        },
      },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'Api' },
          RouteKey: 'POST /enqueue',
          Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Integ' }]] },
        },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(RouteDiscoveryError);
  });

  it("parses CDK's actual Target shape Fn::Join ['', ['integrations/', { Ref }]]", () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'Api' },
          IntegrationType: 'AWS_PROXY',
          IntegrationUri: { 'Fn::GetAtt': ['Handler', 'Arn'] },
        },
      },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'Api' },
          RouteKey: 'GET /items',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integ' }]] },
        },
      },
    });
    expect(discoverRoutes([stack])[0]?.lambdaLogicalId).toBe('Handler');
  });

  it('parses $default RouteKey', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'Api' },
          IntegrationType: 'AWS_PROXY',
          IntegrationUri: { 'Fn::GetAtt': ['Handler', 'Arn'] },
        },
      },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'Api' },
          RouteKey: '$default',
          Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Integ' }]] },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes[0]?.pathPattern).toBe('$default');
    expect(routes[0]?.method).toBe('ANY');
  });
});

describe('discoverRoutes — Function URL', () => {
  it('synthesizes ANY /{proxy+} for a NONE-auth Function URL', () => {
    const stack = buildStack('S', {
      Url: {
        Type: 'AWS::Lambda::Url',
        Properties: { AuthType: 'NONE', TargetFunctionArn: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
      },
    });
    expect(discoverRoutes([stack])[0]).toEqual({
      method: 'ANY',
      pathPattern: '/{proxy+}',
      lambdaLogicalId: 'Fn',
      source: 'function-url',
      apiVersion: 'v2',
      stage: '$default',
      declaredAt: 'S/Url',
    });
  });

  it('rejects AuthType !== NONE', () => {
    const stack = buildStack('S', {
      Url: {
        Type: 'AWS::Lambda::Url',
        Properties: { AuthType: 'AWS_IAM', TargetFunctionArn: { Ref: 'Fn' } },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(RouteDiscoveryError);
  });

  it('rejects InvokeMode RESPONSE_STREAM', () => {
    const stack = buildStack('S', {
      Url: {
        Type: 'AWS::Lambda::Url',
        Properties: {
          AuthType: 'NONE',
          InvokeMode: 'RESPONSE_STREAM',
          TargetFunctionArn: { Ref: 'Fn' },
        },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(RouteDiscoveryError);
  });
});

describe('discoverRoutes — multi-error aggregation', () => {
  it('collects all errors into one message', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      M1: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: { Type: 'MOCK' },
        },
      },
      U1: {
        Type: 'AWS::Lambda::Url',
        Properties: { AuthType: 'AWS_IAM', TargetFunctionArn: { Ref: 'Fn' } },
      },
    });
    try {
      discoverRoutes([stack]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RouteDiscoveryError);
      expect((e as Error).message).toMatch(/2 unsupported route/);
    }
  });
});
