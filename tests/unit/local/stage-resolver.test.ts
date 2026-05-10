import { describe, expect, it } from 'vitest';
import {
  attachStageContext,
  buildStageMap,
  type ResolvedStage,
} from '../../../src/local/stage-resolver.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

function tpl(resources: Record<string, TemplateResource>): CloudFormationTemplate {
  return { Resources: resources };
}

describe('buildStageMap', () => {
  it('returns empty map when no Stage resources are present', () => {
    const m = buildStageMap(
      tpl({
        Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
      })
    );
    expect(m.size).toBe(0);
  });

  it('picks the first REST v1 Stage attached to a RestApi by default', () => {
    // Build the resources record explicitly via an entries array so the
    // test does not depend on the implementation reading object-literal
    // insertion order — though ES2015+ guarantees that string keys
    // iterate in insertion order, the dependence used to be implicit.
    // ProdStage appears FIRST in the entries below, so it must be
    // selected when no `--stage` override is set.
    const orderedEntries: Array<[string, TemplateResource]> = [
      ['Api', { Type: 'AWS::ApiGateway::RestApi', Properties: {} }],
      [
        'ProdStage',
        {
          Type: 'AWS::ApiGateway::Stage',
          Properties: {
            RestApiId: { Ref: 'Api' },
            StageName: 'prod',
            Variables: { region: 'us-east-1', dbHost: 'rds.example' },
          },
        },
      ],
      [
        'DevStage',
        {
          Type: 'AWS::ApiGateway::Stage',
          Properties: {
            RestApiId: { Ref: 'Api' },
            StageName: 'dev',
            Variables: { region: 'us-west-2' },
          },
        },
      ],
    ];
    const m = buildStageMap(tpl(Object.fromEntries(orderedEntries)));
    const stage = m.get('Api');
    expect(stage).toBeDefined();
    expect(stage!.stageName).toBe('prod');
    expect(stage!.apiVersion).toBe('v1');
    expect(stage!.variables).toEqual({ region: 'us-east-1', dbHost: 'rds.example' });
  });

  it('selects the matching Stage when --stage override is provided', () => {
    const m = buildStageMap(
      tpl({
        Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
        ProdStage: {
          Type: 'AWS::ApiGateway::Stage',
          Properties: {
            RestApiId: { Ref: 'Api' },
            StageName: 'prod',
            Variables: { stage: 'prod' },
          },
        },
        DevStage: {
          Type: 'AWS::ApiGateway::Stage',
          Properties: {
            RestApiId: { Ref: 'Api' },
            StageName: 'dev',
            Variables: { stage: 'dev' },
          },
        },
      }),
      'dev'
    );
    expect(m.get('Api')!.stageName).toBe('dev');
    expect(m.get('Api')!.variables).toEqual({ stage: 'dev' });
  });

  it('omits the API entry when --stage override does not match any Stage', () => {
    const m = buildStageMap(
      tpl({
        Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
        ProdStage: {
          Type: 'AWS::ApiGateway::Stage',
          Properties: { RestApiId: { Ref: 'Api' }, StageName: 'prod' },
        },
      }),
      'staging'
    );
    expect(m.has('Api')).toBe(false);
  });

  it('reads StageVariables from HTTP API v2 Stage', () => {
    const m = buildStageMap(
      tpl({
        Api: {
          Type: 'AWS::ApiGatewayV2::Api',
          Properties: { ProtocolType: 'HTTP' },
        },
        Stage: {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: {
            ApiId: { Ref: 'Api' },
            StageName: '$default',
            StageVariables: { theme: 'dark' },
          },
        },
      })
    );
    expect(m.get('Api')!.apiVersion).toBe('v2');
    expect(m.get('Api')!.variables).toEqual({ theme: 'dark' });
  });

  it('drops intrinsic-valued variables and emits null when nothing literal remains', () => {
    const m = buildStageMap(
      tpl({
        Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
        Stage: {
          Type: 'AWS::ApiGateway::Stage',
          Properties: {
            RestApiId: { Ref: 'Api' },
            StageName: 'prod',
            Variables: {
              dynamicHost: { 'Fn::GetAtt': ['Bucket', 'WebsiteURL'] },
            },
          },
        },
      })
    );
    expect(m.get('Api')!.variables).toBeNull();
  });

  it('keeps literal entries when only some variables are intrinsic', () => {
    const m = buildStageMap(
      tpl({
        Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
        Stage: {
          Type: 'AWS::ApiGateway::Stage',
          Properties: {
            RestApiId: { Ref: 'Api' },
            StageName: 'prod',
            Variables: {
              region: 'us-east-1',
              dynamicHost: { 'Fn::GetAtt': ['Bucket', 'WebsiteURL'] },
            },
          },
        },
      })
    );
    expect(m.get('Api')!.variables).toEqual({ region: 'us-east-1' });
  });

  it('treats a Stage with no Variables block as null variables', () => {
    const m = buildStageMap(
      tpl({
        Api: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
        Stage: {
          Type: 'AWS::ApiGateway::Stage',
          Properties: { RestApiId: { Ref: 'Api' }, StageName: 'prod' },
        },
      })
    );
    expect(m.get('Api')!.variables).toBeNull();
  });
});

describe('attachStageContext', () => {
  function route(over: Partial<DiscoveredRoute>): DiscoveredRoute {
    return {
      method: 'GET',
      pathPattern: '/x',
      lambdaLogicalId: 'L',
      source: 'rest-v1',
      apiVersion: 'v1',
      stage: '$default',
      declaredAt: 'S/M',
      ...over,
    };
  }

  it('overrides stage name + sets variables on REST v1 routes', () => {
    const routes = [route({ apiLogicalId: 'Api', source: 'rest-v1', apiVersion: 'v1' })];
    const stageMap = new Map<string, ResolvedStage>([
      [
        'Api',
        {
          stageLogicalId: 'Stage',
          stageName: 'prod',
          apiVersion: 'v1',
          variables: { foo: 'bar' },
        },
      ],
    ]);
    attachStageContext(routes, stageMap);
    expect(routes[0]!.stage).toBe('prod');
    expect(routes[0]!.stageVariables).toEqual({ foo: 'bar' });
  });

  it('overrides stage name + sets variables on HTTP API v2 routes too (named v2 stages are surfaced)', () => {
    // Pre-issue #241 item 4: v2 routes kept `stage: '$default'` even
    // when the template carried a named v2 Stage. AWS supports named
    // stages on HTTP API v2 (CreateStage accepts any name), so the
    // local event should mirror what the deployed endpoint would emit.
    const routes = [route({ apiLogicalId: 'Api', source: 'http-api', apiVersion: 'v2' })];
    const stageMap = new Map<string, ResolvedStage>([
      [
        'Api',
        {
          stageLogicalId: 'Stage',
          stageName: 'prod',
          apiVersion: 'v2',
          variables: { foo: 'bar' },
        },
      ],
    ]);
    attachStageContext(routes, stageMap);
    expect(routes[0]!.stage).toBe('prod');
    expect(routes[0]!.stageVariables).toEqual({ foo: 'bar' });
  });

  it('keeps stage at $default when the resolved v2 Stage is named $default', () => {
    const routes = [route({ apiLogicalId: 'Api', source: 'http-api', apiVersion: 'v2' })];
    const stageMap = new Map<string, ResolvedStage>([
      [
        'Api',
        {
          stageLogicalId: 'Stage',
          stageName: '$default',
          apiVersion: 'v2',
          variables: { theme: 'dark' },
        },
      ],
    ]);
    attachStageContext(routes, stageMap);
    expect(routes[0]!.stage).toBe('$default');
    expect(routes[0]!.stageVariables).toEqual({ theme: 'dark' });
  });

  it('sets stageVariables: null on Function URL routes (no apiLogicalId)', () => {
    const routes = [route({ source: 'function-url', apiVersion: 'v2' })];
    attachStageContext(routes, new Map());
    expect(routes[0]!.stageVariables).toBeNull();
  });

  it('sets stageVariables: null when apiLogicalId is absent from stageMap', () => {
    const routes = [route({ apiLogicalId: 'Api', source: 'http-api', apiVersion: 'v2' })];
    attachStageContext(routes, new Map());
    expect(routes[0]!.stageVariables).toBeNull();
    // stage stays at the discovery-time default
    expect(routes[0]!.stage).toBe('$default');
  });

  it('handles a per-API stage override mismatch (--stage prod matches API A only)', () => {
    // API A has a `prod` Stage; API B only has `dev`. With `--stage
    // prod`, A enters the stage map, B is left out. attachStageContext
    // sets variables on A's routes, leaves B's routes with
    // stageVariables: null + stage at the default placeholder.
    const m = buildStageMap(
      tpl({
        ApiA: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
        ApiAStage: {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: {
            ApiId: { Ref: 'ApiA' },
            StageName: 'prod',
            StageVariables: { region: 'us-east-1' },
          },
        },
        ApiB: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP' } },
        ApiBStage: {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: {
            ApiId: { Ref: 'ApiB' },
            StageName: 'dev',
            StageVariables: { region: 'us-west-2' },
          },
        },
      }),
      'prod'
    );
    expect(m.has('ApiA')).toBe(true);
    expect(m.has('ApiB')).toBe(false);
    const routes = [
      route({ apiLogicalId: 'ApiA', source: 'http-api', apiVersion: 'v2' }),
      route({
        apiLogicalId: 'ApiB',
        source: 'http-api',
        apiVersion: 'v2',
        pathPattern: '/b',
      }),
    ];
    attachStageContext(routes, m);
    expect(routes[0]!.stageVariables).toEqual({ region: 'us-east-1' });
    expect(routes[1]!.stageVariables).toBeNull();
    // ApiA matched the `prod` Stage, so its v2 route gets stage='prod'
    // (issue #241 item 4 — v2 named stages are now surfaced through
    // requestContext.stage, not silently flattened to $default). ApiB
    // has no matching Stage in the map, so the discovery-time
    // placeholder ($default for HTTP API v2) is preserved.
    expect(routes[0]!.stage).toBe('prod');
    expect(routes[1]!.stage).toBe('$default');
  });
});
