import { describe, expect, it } from 'vite-plus/test';
import {
  discoverWebSocketApis,
  discoverWebSocketApisOrThrow,
  parseSelectionExpressionPath,
} from '../../../src/local/websocket-route-discovery.js';
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

function buildLambda(): TemplateResource {
  return {
    Type: 'AWS::Lambda::Function',
    Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
  };
}

function buildIntegration(): TemplateResource {
  return {
    Type: 'AWS::ApiGatewayV2::Integration',
    Properties: {
      ApiId: { Ref: 'WsApi' },
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: { 'Fn::GetAtt': ['MyHandler', 'Arn'] },
    },
  };
}

describe('discoverWebSocketApis', () => {
  it('returns empty + no error for a stack with no WebSocket API', () => {
    const stack = buildStack('S', {
      Api: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
    });
    const { apis, errors } = discoverWebSocketApis([stack]);
    expect(apis).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('discovers a WebSocket API with $connect / $disconnect / $default routes', () => {
    const stack = buildStack('S', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: {
          ProtocolType: 'WEBSOCKET',
          Name: 'WsApi',
          RouteSelectionExpression: '$request.body.action',
        },
      },
      ConnectInteg: buildIntegration(),
      DisconnectInteg: buildIntegration(),
      DefaultInteg: buildIntegration(),
      ConnectRoute: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'ConnectInteg' }]] },
        },
      },
      DisconnectRoute: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$disconnect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'DisconnectInteg' }]] },
        },
      },
      DefaultRoute: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$default',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'DefaultInteg' }]] },
        },
      },
      Stage: {
        Type: 'AWS::ApiGatewayV2::Stage',
        Properties: { ApiId: { Ref: 'WsApi' }, StageName: 'prod' },
      },
    });
    const { apis, errors } = discoverWebSocketApis([stack]);
    expect(errors).toEqual([]);
    expect(apis).toHaveLength(1);
    const api = apis[0]!;
    expect(api.apiLogicalId).toBe('WsApi');
    expect(api.apiStackName).toBe('S');
    expect(api.routeSelectionExpression).toBe('$request.body.action');
    expect(api.stage).toBe('prod');
    expect(api.routes.map((r) => r.routeKey).sort()).toEqual(
      ['$connect', '$default', '$disconnect'].sort()
    );
    expect(api.routes.every((r) => r.targetLambdaLogicalId === 'MyHandler')).toBe(true);
  });

  it('defaults selection expression to $request.body.action when omitted', () => {
    const stack = buildStack('S', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'WEBSOCKET', Name: 'WsApi' },
      },
      Integ: buildIntegration(),
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integ' }]] },
        },
      },
    });
    const { apis, errors } = discoverWebSocketApis([stack]);
    expect(errors).toEqual([]);
    expect(apis[0]!.routeSelectionExpression).toBe('$request.body.action');
  });

  it('defaults stage to "local" when no AWS::ApiGatewayV2::Stage refers to the API', () => {
    const stack = buildStack('S', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'WEBSOCKET', Name: 'WsApi' },
      },
      Integ: buildIntegration(),
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integ' }]] },
        },
      },
    });
    const { apis } = discoverWebSocketApis([stack]);
    expect(apis[0]!.stage).toBe('local');
  });

  it('rejects an API with no routes', () => {
    const stack = buildStack('S', {
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'WEBSOCKET', Name: 'WsApi' },
      },
    });
    const { apis, errors } = discoverWebSocketApis([stack]);
    expect(apis).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('no AWS::ApiGatewayV2::Route children');
  });

  it('rejects unsupported selection expression shapes', () => {
    const stack = buildStack('S', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: {
          ProtocolType: 'WEBSOCKET',
          RouteSelectionExpression: '$request.header.X-Route',
        },
      },
      Integ: buildIntegration(),
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integ' }]] },
        },
      },
    });
    const { errors } = discoverWebSocketApis([stack]);
    expect(errors[0]).toContain("RouteSelectionExpression '$request.header.X-Route'");
  });

  it('accepts nested-dot selection expressions', () => {
    const stack = buildStack('S', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: {
          ProtocolType: 'WEBSOCKET',
          RouteSelectionExpression: '$request.body.v1.action',
        },
      },
      Integ: buildIntegration(),
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integ' }]] },
        },
      },
    });
    const { apis, errors } = discoverWebSocketApis([stack]);
    expect(errors).toEqual([]);
    expect(apis[0]!.routeSelectionExpression).toBe('$request.body.v1.action');
  });

  it('rejects non-AWS_PROXY integration types', () => {
    const stack = buildStack('S', {
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'WEBSOCKET' },
      },
      Integ: {
        Type: 'AWS::ApiGatewayV2::Integration',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          IntegrationType: 'MOCK',
        },
      },
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integ' }]] },
        },
      },
    });
    const { errors } = discoverWebSocketApis([stack]);
    expect(errors[0]).toContain("IntegrationType 'MOCK' is not supported");
  });

  it('rejects duplicate RouteKey within the same API', () => {
    const stack = buildStack('S', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'WEBSOCKET' },
      },
      Integ: buildIntegration(),
      Route1: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integ' }]] },
        },
      },
      Route2: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integ' }]] },
        },
      },
    });
    const { errors } = discoverWebSocketApis([stack]);
    expect(errors[0]).toContain("duplicate RouteKey '$connect'");
  });

  it('discovers two WebSocket APIs across two stacks', () => {
    const a = buildStack('A', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'WEBSOCKET' },
      },
      Integ: buildIntegration(),
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integ' }]] },
        },
      },
    });
    const b = buildStack('B', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'WEBSOCKET' },
      },
      Integ: buildIntegration(),
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integ' }]] },
        },
      },
    });
    const { apis } = discoverWebSocketApis([a, b]);
    expect(apis.map((api) => api.apiStackName).sort()).toEqual(['A', 'B']);
  });

  it('orThrow surface aggregates per-error into a RouteDiscoveryError', () => {
    const stack = buildStack('S', {
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'WEBSOCKET' },
      },
    });
    expect(() => discoverWebSocketApisOrThrow([stack])).toThrow(RouteDiscoveryError);
  });

  it('accepts Fn::Sub target shape (1-arg)', () => {
    const stack = buildStack('S', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: { ProtocolType: 'WEBSOCKET' },
      },
      Integ: buildIntegration(),
      Route: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: { 'Fn::Sub': 'integrations/${Integ}' },
        },
      },
    });
    const { apis, errors } = discoverWebSocketApis([stack]);
    expect(errors).toEqual([]);
    expect(apis[0]!.routes[0]!.targetLambdaLogicalId).toBe('MyHandler');
  });
});

describe('parseSelectionExpressionPath', () => {
  it('parses single-segment $request.body.action into [action]', () => {
    expect(parseSelectionExpressionPath('$request.body.action')).toEqual(['action']);
  });

  it('parses nested $request.body.v1.action into [v1, action]', () => {
    expect(parseSelectionExpressionPath('$request.body.v1.action')).toEqual(['v1', 'action']);
  });

  it('returns empty for shapes outside the supported grammar', () => {
    expect(parseSelectionExpressionPath('$request.body')).toEqual([]);
    expect(parseSelectionExpressionPath('$context.connectionId')).toEqual([]);
  });
});

// B2 (#526): non-NONE `AuthorizationType` on any Route belonging to a
// WebSocket API must tag the parent API as `unsupported`. cdkd v1 does
// not emulate WebSocket authorizers; silently admitting unauthenticated
// clients would be a security gap (mirrors the structural pre-empt fix
// PR #514 shipped for HTTP API v2 service integrations). The CLI's
// attach loop skips an `unsupported`-tagged API and surfaces the reason
// as a startup warn.
describe('discoverWebSocketApis B2 authorizer admission guard', () => {
  function buildAuthApi(authorizationType: string | undefined): StackInfo {
    return buildStack('AuthStack', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: {
          ProtocolType: 'WEBSOCKET',
          Name: 'WsApi',
          RouteSelectionExpression: '$request.body.action',
        },
      },
      ConnectIntegration: buildIntegration(),
      ConnectRoute: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: 'integrations/ConnectIntegration',
          ...(authorizationType !== undefined && { AuthorizationType: authorizationType }),
        },
      },
    });
  }

  it('tags API as unsupported when $connect Route has AuthorizationType: AWS_IAM', () => {
    const { apis, errors } = discoverWebSocketApis([buildAuthApi('AWS_IAM')]);
    expect(errors).toEqual([]);
    expect(apis).toHaveLength(1);
    expect(apis[0]!.unsupported).toBeDefined();
    expect(apis[0]!.unsupported!.reason).toContain('AWS_IAM');
    expect(apis[0]!.unsupported!.reason).toContain('$connect');
    expect(apis[0]!.unsupported!.reason).toContain('cdkd v1 does not emulate');
  });

  it('tags API as unsupported when $connect Route has AuthorizationType: CUSTOM', () => {
    const { apis } = discoverWebSocketApis([buildAuthApi('CUSTOM')]);
    expect(apis[0]!.unsupported).toBeDefined();
    expect(apis[0]!.unsupported!.reason).toContain('CUSTOM');
  });

  it('tags API as unsupported when $connect Route has AuthorizationType: JWT', () => {
    const { apis } = discoverWebSocketApis([buildAuthApi('JWT')]);
    expect(apis[0]!.unsupported).toBeDefined();
    expect(apis[0]!.unsupported!.reason).toContain('JWT');
  });

  it('does NOT tag API as unsupported when AuthorizationType is explicitly NONE', () => {
    const { apis } = discoverWebSocketApis([buildAuthApi('NONE')]);
    expect(apis[0]!.unsupported).toBeUndefined();
  });

  it('does NOT tag API as unsupported when AuthorizationType is omitted (AWS default = NONE)', () => {
    const { apis } = discoverWebSocketApis([buildAuthApi(undefined)]);
    expect(apis[0]!.unsupported).toBeUndefined();
  });

  it('lists every auth-tagged route in the reason when multiple routes have auth', () => {
    const stack = buildStack('MultiAuth', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: {
          ProtocolType: 'WEBSOCKET',
          Name: 'WsApi',
          RouteSelectionExpression: '$request.body.action',
        },
      },
      ConnectIntegration: buildIntegration(),
      ConnectRoute: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: 'integrations/ConnectIntegration',
          AuthorizationType: 'AWS_IAM',
        },
      },
      DefaultRoute: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$default',
          Target: 'integrations/ConnectIntegration',
          AuthorizationType: 'CUSTOM',
        },
      },
    });
    const { apis } = discoverWebSocketApis([stack]);
    expect(apis[0]!.unsupported).toBeDefined();
    const reason = apis[0]!.unsupported!.reason;
    expect(reason).toContain('$connect [AuthorizationType=AWS_IAM]');
    expect(reason).toContain('$default [AuthorizationType=CUSTOM]');
  });

  it('does NOT tag the API when only $disconnect / non-$connect routes have NONE auth', () => {
    const stack = buildStack('S', {
      MyHandler: buildLambda(),
      WsApi: {
        Type: 'AWS::ApiGatewayV2::Api',
        Properties: {
          ProtocolType: 'WEBSOCKET',
          Name: 'WsApi',
          RouteSelectionExpression: '$request.body.action',
        },
      },
      ConnectIntegration: buildIntegration(),
      ConnectRoute: {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
          ApiId: { Ref: 'WsApi' },
          RouteKey: '$connect',
          Target: 'integrations/ConnectIntegration',
          AuthorizationType: 'NONE',
        },
      },
    });
    const { apis } = discoverWebSocketApis([stack]);
    expect(apis[0]!.unsupported).toBeUndefined();
  });
});
