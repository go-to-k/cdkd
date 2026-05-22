import { describe, expect, it } from 'vite-plus/test';
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
        apiLogicalId: 'Api',
        apiStackName: 'S',
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

  it('classifies non-CORS MOCK integrations as kind="mock" (#457; pre-PR they were 501 unsupported)', () => {
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
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.method).toBe('GET');
    expect(routes[0]?.pathPattern).toBe('/');
    expect(routes[0]?.lambdaLogicalId).toBe('');
    expect(routes[0]?.restV1Integration?.kind).toBe('mock');
    expect(routes[0]?.mockCors).toBeUndefined();
    expect(routes[0]?.unsupported).toBeUndefined();
  });

  it('classifies REST v1 HTTP_PROXY integrations with the new restV1Integration config (#457)', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'POST',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: { Type: 'HTTP_PROXY', Uri: 'http://example.com' },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.unsupported).toBeUndefined();
    expect(routes[0]?.restV1Integration?.kind).toBe('http-proxy');
    expect(
      routes[0]?.restV1Integration?.kind === 'http-proxy' &&
        routes[0]?.restV1Integration.uri
    ).toBe('http://example.com');
  });

  it('flags Fn::Sub against an arbitrary (non-invoke-ARN) template as deferred-error unsupported', () => {
    // Pre-issue-#286-Gap-3 this was the bare-`${Handler.Arn}` example; the
    // resolver still cannot pin down a Lambda logical id without the
    // `:lambda:path/2015-03-31/functions/` invoke-ARN marker, so the
    // route lands as deferred-501 instead of throwing.
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
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.unsupported?.reason).toMatch(/Lambda Arn intrinsics/);
    expect(routes[0]?.lambdaLogicalId).toBe('');
  });

  // Issue #286 Gap 3: hand-written / non-canonical CDK constructs may
  // emit `Fn::Sub` instead of the `Fn::Join` invoke-ARN wrapper. Both
  // canonical shapes (1-arg + 2-arg) now resolve to the Lambda logical
  // ID.
  it("parses CDK Fn.sub(template) 1-arg invoke-ARN shape", () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'AWS_PROXY',
            Uri: {
              'Fn::Sub':
                'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MyHandler.Arn}/invocations',
            },
          },
        },
      },
    });
    expect(discoverRoutes([stack])[0]?.lambdaLogicalId).toBe('MyHandler');
  });

  it("parses CDK Fn.sub(template, vars) 2-arg invoke-ARN shape", () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'AWS_PROXY',
            Uri: {
              'Fn::Sub': [
                'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MyLambdaArn}/invocations',
                { MyLambdaArn: { 'Fn::GetAtt': ['MyHandler', 'Arn'] } },
              ],
            },
          },
        },
      },
    });
    expect(discoverRoutes([stack])[0]?.lambdaLogicalId).toBe('MyHandler');
  });
});

describe('discoverRoutes — REST v1 non-AWS_PROXY classification (#457)', () => {
  // Each test asserts that the new restV1Integration field is populated
  // with the right `kind` discriminator + per-kind config.

  it('classifies MOCK non-CORS as kind="mock" with requestTemplate + responses', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'MOCK',
            RequestTemplates: { 'application/json': '{"statusCode": 200}' },
            IntegrationResponses: [
              { StatusCode: '200', ResponseTemplates: { 'application/json': '{}' } },
            ],
          },
        },
      },
    });
    const route = discoverRoutes([stack])[0];
    expect(route?.restV1Integration?.kind).toBe('mock');
    if (route?.restV1Integration?.kind === 'mock') {
      expect(route.restV1Integration.requestTemplate).toBe('{"statusCode": 200}');
      expect(route.restV1Integration.responses).toHaveLength(1);
    }
  });

  it('classifies HTTP_PROXY with uri + responses', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'POST',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'HTTP_PROXY',
            Uri: 'https://example.com/api',
            IntegrationHttpMethod: 'POST',
          },
        },
      },
    });
    const route = discoverRoutes([stack])[0];
    expect(route?.restV1Integration?.kind).toBe('http-proxy');
    if (route?.restV1Integration?.kind === 'http-proxy') {
      expect(route.restV1Integration.uri).toBe('https://example.com/api');
      expect(route.restV1Integration.integrationHttpMethod).toBe('POST');
    }
  });

  it('classifies HTTP non-proxy with uri + requestTemplates + responses', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'POST',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'HTTP',
            Uri: 'https://upstream/api',
            RequestTemplates: { 'application/json': '{"wrapped":$input.body}' },
            IntegrationResponses: [
              {
                StatusCode: '200',
                ResponseTemplates: { 'application/json': '{"x":1}' },
              },
            ],
          },
        },
      },
    });
    const route = discoverRoutes([stack])[0];
    expect(route?.restV1Integration?.kind).toBe('http');
    if (route?.restV1Integration?.kind === 'http') {
      expect(route.restV1Integration.uri).toBe('https://upstream/api');
      expect(route.restV1Integration.requestTemplates).toEqual({
        'application/json': '{"wrapped":$input.body}',
      });
    }
  });

  it('classifies AWS integration targeting Lambda as kind="aws-lambda"', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Handler: {
        Type: 'AWS::Lambda::Function',
        Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
      },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'POST',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'AWS',
            Uri: {
              'Fn::Sub':
                'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${Handler.Arn}/invocations',
            },
            RequestTemplates: { 'application/json': '{"event":$input.body}' },
            IntegrationResponses: [
              {
                StatusCode: '200',
                ResponseTemplates: { 'application/json': 'value=$input.json("$")' },
              },
            ],
          },
        },
      },
    });
    const route = discoverRoutes([stack])[0];
    expect(route?.restV1Integration?.kind).toBe('aws-lambda');
    expect(route?.lambdaLogicalId).toBe('Handler');
    if (route?.restV1Integration?.kind === 'aws-lambda') {
      expect(route.restV1Integration.lambdaLogicalId).toBe('Handler');
      expect(route.restV1Integration.requestTemplates).toBeDefined();
      expect(route.restV1Integration.responses).toHaveLength(1);
    }
  });

  it('flags AWS integration targeting a non-Lambda service (e.g. S3) as deferred-error unsupported', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'AWS',
            Uri: 'arn:aws:apigateway:us-east-1:s3:path/my-bucket/{key}',
          },
        },
      },
    });
    const route = discoverRoutes([stack])[0];
    expect(route?.unsupported?.reason).toMatch(/non-Lambda service/);
    expect(route?.restV1Integration).toBeUndefined();
  });

  it('flags HTTP_PROXY with non-literal Uri as deferred-error unsupported', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: { Type: 'HTTP_PROXY', Uri: { Ref: 'SomeParam' } },
        },
      },
    });
    const route = discoverRoutes([stack])[0];
    expect(route?.unsupported?.reason).toMatch(/HTTP_PROXY/);
    expect(route?.restV1Integration).toBeUndefined();
  });

  it('flags unknown REST v1 integration type as deferred-error unsupported', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: { Type: 'NONSENSE' },
        },
      },
    });
    const route = discoverRoutes([stack])[0];
    expect(route?.unsupported?.reason).toMatch(/unknown REST v1 integration type/);
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
      apiLogicalId: 'Api',
      apiStackName: 'S',
      declaredAt: 'S/Route',
    });
  });

  it('flags WebSocket protocol APIs as deferred-error unsupported', () => {
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
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.unsupported?.reason).toMatch(/WebSocket APIs are not supported/);
    expect(routes[0]?.lambdaLogicalId).toBe('');
  });

  it('classifies AWS-recognized IntegrationSubtype routes as serviceIntegration (issue #458)', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'Api' },
          IntegrationType: 'AWS_PROXY',
          IntegrationSubtype: 'SQS-SendMessage',
          PayloadFormatVersion: '1.0',
          RequestParameters: {
            QueueUrl: '$request.querystring.url',
            MessageBody: '$request.body',
          },
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
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.unsupported).toBeUndefined();
    expect(routes[0]?.lambdaLogicalId).toBe('');
    expect(routes[0]?.serviceIntegration?.subtype).toBe('SQS-SendMessage');
    expect(routes[0]?.serviceIntegration?.requestParameters).toEqual({
      QueueUrl: '$request.querystring.url',
      MessageBody: '$request.body',
    });
  });

  it('preserves ResponseParameters on serviceIntegration routes', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'Api' },
          IntegrationType: 'AWS_PROXY',
          IntegrationSubtype: 'EventBridge-PutEvents',
          PayloadFormatVersion: '1.0',
          RequestParameters: { Detail: '{}', DetailType: 't', Source: 's' },
          ResponseParameters: {
            '200': { 'overwrite:statuscode': '202' },
          },
        },
      },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'Api' },
          RouteKey: 'POST /events',
          Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Integ' }]] },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes[0]?.serviceIntegration?.responseParameters).toEqual({
      '200': { 'overwrite:statuscode': '202' },
    });
  });

  it('falls back to deferred-501 on unrecognized IntegrationSubtype (e.g. typo or future-AWS)', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'Api' },
          IntegrationType: 'AWS_PROXY',
          IntegrationSubtype: 'DynamoDB-PutItem',
          PayloadFormatVersion: '1.0',
          RequestParameters: {},
        },
      },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'Api' },
          RouteKey: 'POST /ddb',
          Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Integ' }]] },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.serviceIntegration).toBeUndefined();
    expect(routes[0]?.unsupported?.reason).toMatch(/DynamoDB-PutItem/);
    expect(routes[0]?.unsupported?.reason).toMatch(/not supported/);
  });

  it('flags serviceIntegration with missing RequestParameters as deferred-501', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'Api' },
          IntegrationType: 'AWS_PROXY',
          IntegrationSubtype: 'SQS-SendMessage',
          PayloadFormatVersion: '1.0',
          // RequestParameters omitted on purpose
        },
      },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'Api' },
          RouteKey: 'POST /noparams',
          Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Integ' }]] },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes[0]?.serviceIntegration).toBeUndefined();
    expect(routes[0]?.unsupported?.reason).toMatch(/RequestParameters/);
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

  it("parses Fn::Sub 1-arg Target shape 'integrations/${Integ}' (AWS-docs canonical)", () => {
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
          Target: { 'Fn::Sub': 'integrations/${Integ}' },
        },
      },
    });
    expect(discoverRoutes([stack])[0]?.lambdaLogicalId).toBe('Handler');
  });

  it("parses Fn::Sub 2-arg Target shape ['integrations/${Var}', { Var: { Ref } }] (what cdk.Fn.sub emits)", () => {
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
          RouteKey: 'POST /items',
          Target: {
            'Fn::Sub': ['integrations/${IntId}', { IntId: { Ref: 'Integ' } }],
          },
        },
      },
    });
    expect(discoverRoutes([stack])[0]?.lambdaLogicalId).toBe('Handler');
  });

  it('rejects Fn::Sub Target whose template does not start with integrations/', () => {
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
          Target: { 'Fn::Sub': 'something-else/${Integ}' },
        },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(/Target must be/);
  });

  it('rejects Fn::Sub Target whose 2-arg binding is not a Ref', () => {
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
          Target: {
            'Fn::Sub': [
              'integrations/${IntId}',
              { IntId: { 'Fn::GetAtt': ['Integ', 'Arn'] } },
            ],
          },
        },
      },
    });
    expect(() => discoverRoutes([stack])).toThrow(/Target must be/);
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
      apiStackName: 'S',
      declaredAt: 'S/Url',
      invokeMode: 'BUFFERED',
    });
  });

  it('flags AuthType !== NONE as deferred-error unsupported (preserves lambdaLogicalId)', () => {
    const stack = buildStack('S', {
      Url: {
        Type: 'AWS::Lambda::Url',
        Properties: { AuthType: 'AWS_IAM', TargetFunctionArn: { Ref: 'Fn' } },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.unsupported?.reason).toMatch(/AWS_IAM/);
    // The Lambda IS known on Function URLs even when unsupported;
    // unlike REST v1 MOCK / unresolvable Arn cases, Function URLs always
    // identify their backing Lambda.
    expect(routes[0]?.lambdaLogicalId).toBe('Fn');
  });

  it('tags InvokeMode RESPONSE_STREAM as a normal streaming route (#467)', () => {
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
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.unsupported).toBeUndefined();
    expect(routes[0]?.invokeMode).toBe('RESPONSE_STREAM');
    expect(routes[0]?.lambdaLogicalId).toBe('Fn');
  });

  it('defaults InvokeMode to BUFFERED when the template omits the field', () => {
    const stack = buildStack('S', {
      Url: {
        Type: 'AWS::Lambda::Url',
        Properties: {
          AuthType: 'NONE',
          TargetFunctionArn: { Ref: 'Fn' },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.unsupported).toBeUndefined();
    expect(routes[0]?.invokeMode).toBe('BUFFERED');
  });

  it('preserves an explicit InvokeMode: BUFFERED value', () => {
    const stack = buildStack('S', {
      Url: {
        Type: 'AWS::Lambda::Url',
        Properties: {
          AuthType: 'NONE',
          InvokeMode: 'BUFFERED',
          TargetFunctionArn: { Ref: 'Fn' },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.invokeMode).toBe('BUFFERED');
  });

  it('flags unknown InvokeMode values as deferred-error unsupported', () => {
    const stack = buildStack('S', {
      Url: {
        Type: 'AWS::Lambda::Url',
        Properties: {
          AuthType: 'NONE',
          InvokeMode: 'WEIRD_NEW_MODE',
          TargetFunctionArn: { Ref: 'Fn' },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.unsupported?.reason).toMatch(/WEIRD_NEW_MODE/);
    expect(routes[0]?.lambdaLogicalId).toBe('Fn');
  });
});

describe('discoverRoutes — aws:cdk:path propagation', () => {
  // The discovery layer surfaces the parent API's (or the backing
  // Lambda's, for Function URLs) `aws:cdk:path` Metadata so the
  // `--api` filter in `filterRoutesByApiIdentifier` can accept the
  // CDK Construct path form — same UX rule the rest of `cdkd local *`
  // family uses.

  it('propagates RestApi aws:cdk:path to REST v1 routes', () => {
    const stack = buildStack('S', {
      Api: {
        Type: 'AWS::ApiGateway::RestApi',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'WebStack/MyRestApi/Resource' },
      },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'AWS_PROXY',
            Uri: { 'Fn::GetAtt': ['Handler', 'Arn'] },
          },
        },
      },
    });
    const route = discoverRoutes([stack])[0]!;
    expect(route.apiCdkPath).toBe('WebStack/MyRestApi/Resource');
    expect(route.apiStackName).toBe('S');
  });

  it('propagates HTTP API aws:cdk:path to v2 routes', () => {
    const stack = buildStack('S', {
      Api: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'HTTP' },
        Metadata: { 'aws:cdk:path': 'WebStack/MyHttpApi/Resource' },
      },
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
          Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Integ' }]] },
        },
      },
    });
    const route = discoverRoutes([stack])[0]!;
    expect(route.apiCdkPath).toBe('WebStack/MyHttpApi/Resource');
    expect(route.apiStackName).toBe('S');
  });

  it('propagates the BACKING LAMBDA aws:cdk:path to Function URLs (not the URL resource)', () => {
    // For Function URLs, the natural CDK Construct path is the
    // Function's path (the URL is an auto-generated child). Users
    // expect `--api MyStack/MyHandler` to match — so surface the
    // Lambda's cdk path, not the URL's own.
    const stack = buildStack('S', {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'BackendStack/GoHandler/Resource' },
      },
      Url: {
        Type: 'AWS::Lambda::Url',
        Properties: { AuthType: 'NONE', TargetFunctionArn: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
        Metadata: { 'aws:cdk:path': 'BackendStack/GoHandler/FunctionUrl' },
      },
    });
    const route = discoverRoutes([stack])[0]!;
    expect(route.source).toBe('function-url');
    expect(route.apiCdkPath).toBe('BackendStack/GoHandler/Resource');
    expect(route.apiStackName).toBe('S');
  });

  it('omits apiCdkPath when the parent resource has no aws:cdk:path metadata', () => {
    // Backward compat path — hand-rolled CFn resources or templates
    // without the metadata stay matchable by bare logical id (and
    // by stack-qualified logical id, since `apiStackName` is always
    // set from the StackInfo).
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'AWS_PROXY',
            Uri: { 'Fn::GetAtt': ['Handler', 'Arn'] },
          },
        },
      },
    });
    const route = discoverRoutes([stack])[0]!;
    expect(route.apiCdkPath).toBeUndefined();
    expect(route.apiStackName).toBe('S');
    expect(route.apiLogicalId).toBe('Api');
  });
});

describe('discoverRoutes — multi-error aggregation (template-structural)', () => {
  it('collects multiple template-structural failures into one message', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      // M1: missing Integration → template-structural failure.
      M1: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
        },
      },
      // M2: RestApiId not a Ref → template-structural failure.
      M2: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'POST',
          RestApiId: 'literal-not-a-ref',
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: { Type: 'AWS_PROXY', Uri: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
        },
      },
    });
    try {
      discoverRoutes([stack]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RouteDiscoveryError);
      expect((e as Error).message).toMatch(/2 malformed route/);
    }
  });
});

describe('discoverRoutes — deferred-error unsupported (multi-route)', () => {
  it('collects multiple per-integration unsupportedness as separate routes, no throw', () => {
    // Pre-refactor: this fixture would have thrown a RouteDiscoveryError
    // listing both routes. Post-refactor: discovery succeeds with two
    // routes carrying `unsupported`; boot proceeds; 501 fires at request
    // time.
    // Post-#457: MOCK is no longer unsupported (the dispatcher handles
    // it). The fixture uses an AWS-integration-to-S3 (non-Lambda service)
    // case, which remains unsupported in v1.
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      M1: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'GET',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'AWS',
            Uri: 'arn:aws:apigateway:us-east-1:s3:path/my-bucket/{key}',
          },
        },
      },
      U1: {
        Type: 'AWS::Lambda::Url',
        Properties: { AuthType: 'AWS_IAM', TargetFunctionArn: { Ref: 'Fn' } },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(2);
    for (const r of routes) {
      expect(r.unsupported).toBeDefined();
    }
  });
});

describe('discoverRoutes — REST v1 MOCK CORS preflight', () => {
  // CDK's `defaultCorsPreflightOptions` synthesizes an OPTIONS Method
  // backed by a MOCK integration whose IntegrationResponses[0].
  // ResponseParameters carry literal `method.response.header.<Name>:
  // "'<value>'"` pairs. We extract those literals and emit a synthetic
  // preflight route the HTTP server answers directly (204) without
  // invoking any Lambda.
  it('detects CDK-shape OPTIONS Method MOCK preflight and extracts headers', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'OPTIONS',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          AuthorizationType: 'NONE',
          Integration: {
            Type: 'MOCK',
            RequestTemplates: { 'application/json': '{ statusCode: 200 }' },
            IntegrationResponses: [
              {
                StatusCode: '204',
                ResponseParameters: {
                  'method.response.header.Access-Control-Allow-Headers':
                    "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
                  'method.response.header.Access-Control-Allow-Origin': "'*'",
                  'method.response.header.Access-Control-Allow-Methods':
                    "'OPTIONS,GET,PUT,POST,DELETE,PATCH,HEAD'",
                },
              },
            ],
          },
          MethodResponses: [
            {
              StatusCode: '204',
              ResponseParameters: {
                'method.response.header.Access-Control-Allow-Headers': true,
                'method.response.header.Access-Control-Allow-Origin': true,
                'method.response.header.Access-Control-Allow-Methods': true,
              },
            },
          ],
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.method).toBe('OPTIONS');
    expect(routes[0]?.pathPattern).toBe('/');
    expect(routes[0]?.unsupported).toBeUndefined();
    expect(routes[0]?.mockCors).toEqual({
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Headers':
          'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'OPTIONS,GET,PUT,POST,DELETE,PATCH,HEAD',
      },
    });
    expect(routes[0]?.lambdaLogicalId).toBe('');
  });

  it('defaults to 204 when StatusCode is missing on the IntegrationResponse', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'OPTIONS',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'MOCK',
            IntegrationResponses: [
              {
                ResponseParameters: {
                  'method.response.header.Access-Control-Allow-Origin': "'*'",
                },
              },
            ],
          },
        },
      },
    });
    expect(discoverRoutes([stack])[0]?.mockCors?.statusCode).toBe(204);
  });

  it('falls through to the MOCK dispatcher (kind="mock") when MOCK OPTIONS has no IntegrationResponses (#457)', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'OPTIONS',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: { Type: 'MOCK' },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes[0]?.mockCors).toBeUndefined();
    expect(routes[0]?.restV1Integration?.kind).toBe('mock');
  });

  it('falls through to the MOCK dispatcher when MOCK is non-OPTIONS (e.g. POST) (#457)', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'POST',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'MOCK',
            IntegrationResponses: [
              {
                StatusCode: '200',
                ResponseParameters: {
                  'method.response.header.X-Custom': "'value'",
                },
              },
            ],
          },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes[0]?.mockCors).toBeUndefined();
    expect(routes[0]?.restV1Integration?.kind).toBe('mock');
  });

  it('all-intrinsic ResponseParameters falls through to the MOCK dispatcher (no preflight shape match) (#457)', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'OPTIONS',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'MOCK',
            IntegrationResponses: [
              {
                StatusCode: '204',
                ResponseParameters: {
                  'method.response.header.X-Sub': { 'Fn::Sub': "'${SomeRef}'" },
                  'method.response.header.X-Unquoted': 'no-quotes-around-this',
                },
              },
            ],
          },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes[0]?.mockCors).toBeUndefined();
    expect(routes[0]?.restV1Integration?.kind).toBe('mock');
  });

  it('mixed-shape ResponseParameters (one literal + one intrinsic) falls through to MOCK dispatcher, all-or-nothing on preflight (#457)', () => {
    // Load-bearing: a partial preflight with some headers missing would
    // silently break CORS in the browser. The synthetic preflight path
    // is all-or-nothing; the MOCK dispatcher takes over and answers via
    // its IntegrationResponses[]/ResponseTemplates contract instead.
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      Method: {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: 'OPTIONS',
          RestApiId: { Ref: 'Api' },
          ResourceId: { 'Fn::GetAtt': ['Api', 'RootResourceId'] },
          Integration: {
            Type: 'MOCK',
            IntegrationResponses: [
              {
                StatusCode: '204',
                ResponseParameters: {
                  'method.response.header.Access-Control-Allow-Origin': "'*'",
                  'method.response.header.Access-Control-Allow-Headers': {
                    'Fn::Sub': "'${HeaderListVar}'",
                  },
                },
              },
            ],
          },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes[0]?.mockCors).toBeUndefined();
    expect(routes[0]?.restV1Integration?.kind).toBe('mock');
  });
});

describe('discoverRoutes — HTTP API v2 unresolvable Lambda Arn (deferred-error symmetry)', () => {
  // Symmetric with the REST v1 case (`flags Fn::Sub against an arbitrary
  // (non-invoke-ARN) template as deferred-error unsupported`). HTTP API
  // v2 routes whose IntegrationUri carries an unresolvable Lambda Arn
  // intrinsic (cross-stack reference, imported Lambda, hand-rolled
  // `Fn::Sub` outside the invoke-ARN wrapper) flow through the same
  // unsupported branch.
  it('flags HTTP API v2 IntegrationUri with non-invoke-ARN Fn::Sub as deferred-error unsupported', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'Api' },
          IntegrationType: 'AWS_PROXY',
          // Bare `${X.Arn}` lacks the `:lambda:path/2015-03-31/functions/`
          // invoke-ARN marker, so the resolver cannot pin a Lambda
          // logical id — same shape as the REST v1 unresolvable case.
          IntegrationUri: { 'Fn::Sub': '${ImportedHandler.Arn}' },
        },
      },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'Api' },
          RouteKey: 'GET /items',
          Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Integ' }]] },
        },
      },
    });
    const routes = discoverRoutes([stack]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.unsupported?.reason).toMatch(/Lambda Arn intrinsics/);
    expect(routes[0]?.lambdaLogicalId).toBe('');
    expect(routes[0]?.apiLogicalId).toBe('Api'); // route identity preserved for the route table
    expect(routes[0]?.method).toBe('GET');
    expect(routes[0]?.pathPattern).toBe('/items');
  });
});
