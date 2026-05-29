import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateApiCommand,
  CreateStageCommand,
  CreateIntegrationCommand,
  UpdateApiCommand,
  UpdateStageCommand,
  UpdateIntegrationCommand,
} from '@aws-sdk/client-apigatewayv2';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-apigatewayv2', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ApiGatewayV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { ApiGatewayV2Provider } from '../../../src/provisioning/providers/apigatewayv2-provider.js';

const API_ID = 'abcd1234';

/**
 * Property-coverage backfill tests (issue #609) for the config props that
 * ride on each sub-type's own CreateX/UpdateX call:
 *   - Api:         DisableExecuteApiEndpoint / Version /
 *                  RouteSelectionExpression / ApiKeySelectionExpression
 *   - Stage:       StageVariables / DefaultRouteSettings
 *   - Integration: TimeoutInMillis / RequestParameters / Description
 *
 * Each block covers create-send (field reaches the SDK input), update-send
 * (field rides the diffed UpdateX input), and readCurrentState emit/omit
 * (emit-when-present, omit-when-absent).
 */
describe('ApiGatewayV2Provider #609 backfill', () => {
  let provider: ApiGatewayV2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ApiGatewayV2Provider();
  });

  // ─── Api ──────────────────────────────────────────────────────────

  it('Api create(): DisableExecuteApiEndpoint / Version / selection expressions reach CreateApi', async () => {
    mockSend.mockResolvedValueOnce({ ApiId: API_ID, ApiEndpoint: 'https://x' });

    await provider.create('ApiLogical', 'AWS::ApiGatewayV2::Api', {
      Name: 'my-api',
      ProtocolType: 'WEBSOCKET',
      DisableExecuteApiEndpoint: true,
      Version: 'v1',
      RouteSelectionExpression: '$request.body.action',
      ApiKeySelectionExpression: '$request.header.x-api-key',
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateApiCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input['DisableExecuteApiEndpoint']).toBe(true);
    expect(input['Version']).toBe('v1');
    expect(input['RouteSelectionExpression']).toBe('$request.body.action');
    expect(input['ApiKeySelectionExpression']).toBe('$request.header.x-api-key');
  });

  it('Api update(): DisableExecuteApiEndpoint / Version change emits UpdateApi with only diffed fields', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { ProtocolType: 'HTTP', DisableExecuteApiEndpoint: true, Version: 'v2' },
      { ProtocolType: 'HTTP', DisableExecuteApiEndpoint: false, Version: 'v1' }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateApiCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input).toEqual({
      ApiId: API_ID,
      DisableExecuteApiEndpoint: true,
      Version: 'v2',
    });
  });

  it('Api update(): DisableExecuteApiEndpoint=false reaches AWS (not-truthy gate)', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { ProtocolType: 'HTTP', DisableExecuteApiEndpoint: false },
      { ProtocolType: 'HTTP', DisableExecuteApiEndpoint: true }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateApiCommand);
    const input = call![0].input as Record<string, unknown>;
    expect(input['DisableExecuteApiEndpoint']).toBe(false);
  });

  it('Api update(): RouteSelectionExpression change (WEBSOCKET) rides UpdateApi', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { ProtocolType: 'WEBSOCKET', RouteSelectionExpression: '$request.body.newAction' },
      { ProtocolType: 'WEBSOCKET', RouteSelectionExpression: '$request.body.action' }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateApiCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input).toEqual({
      ApiId: API_ID,
      RouteSelectionExpression: '$request.body.newAction',
    });
  });

  it('Api update(): ApiKeySelectionExpression change (WEBSOCKET) rides UpdateApi', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'ApiLogical',
      API_ID,
      'AWS::ApiGatewayV2::Api',
      { ProtocolType: 'WEBSOCKET', ApiKeySelectionExpression: '$request.header.x-new-key' },
      { ProtocolType: 'WEBSOCKET', ApiKeySelectionExpression: '$request.header.x-api-key' }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateApiCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input).toEqual({
      ApiId: API_ID,
      ApiKeySelectionExpression: '$request.header.x-new-key',
    });
  });

  it('Api update(): unchanged selection expressions produce zero SDK calls', async () => {
    const same = {
      ProtocolType: 'WEBSOCKET',
      RouteSelectionExpression: '$request.body.action',
      ApiKeySelectionExpression: '$request.header.x-api-key',
    };
    await provider.update('ApiLogical', API_ID, 'AWS::ApiGatewayV2::Api', same, same);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Api readCurrentState: emits DisableExecuteApiEndpoint / Version when present (HTTP)', async () => {
    mockSend.mockResolvedValueOnce({
      ApiId: API_ID,
      Name: 'my-api',
      ProtocolType: 'HTTP',
      DisableExecuteApiEndpoint: true,
      Version: 'v3',
    });

    const observed = await provider.readCurrentState(API_ID, 'ApiLogical', 'AWS::ApiGatewayV2::Api');

    expect(observed!['DisableExecuteApiEndpoint']).toBe(true);
    expect(observed!['Version']).toBe('v3');
  });

  it('Api readCurrentState: emits DisableExecuteApiEndpoint=false (emit-when-present, not truthy)', async () => {
    mockSend.mockResolvedValueOnce({
      ApiId: API_ID,
      Name: 'my-api',
      ProtocolType: 'HTTP',
      DisableExecuteApiEndpoint: false,
    });

    const observed = await provider.readCurrentState(API_ID, 'ApiLogical', 'AWS::ApiGatewayV2::Api');

    expect(observed!).toHaveProperty('DisableExecuteApiEndpoint');
    expect(observed!['DisableExecuteApiEndpoint']).toBe(false);
  });

  it('Api readCurrentState: omits DisableExecuteApiEndpoint / Version when AWS does not return them', async () => {
    mockSend.mockResolvedValueOnce({
      ApiId: API_ID,
      Name: 'my-api',
      ProtocolType: 'HTTP',
    });

    const observed = await provider.readCurrentState(API_ID, 'ApiLogical', 'AWS::ApiGatewayV2::Api');

    expect(observed!).not.toHaveProperty('DisableExecuteApiEndpoint');
    expect(observed!).not.toHaveProperty('Version');
  });

  it('Api readCurrentState: ApiKeySelectionExpression emitted on WEBSOCKET, omitted on HTTP (discriminator guard)', async () => {
    mockSend.mockResolvedValueOnce({
      ApiId: API_ID,
      Name: 'ws-api',
      ProtocolType: 'WEBSOCKET',
      ApiKeySelectionExpression: '$request.header.x-api-key',
    });
    const ws = await provider.readCurrentState(API_ID, 'ApiLogical', 'AWS::ApiGatewayV2::Api');
    expect(ws!['ApiKeySelectionExpression']).toBe('$request.header.x-api-key');

    mockSend.mockResolvedValueOnce({
      ApiId: API_ID,
      Name: 'http-api',
      ProtocolType: 'HTTP',
      // AWS may echo a server-side default; it must NOT surface on HTTP.
      ApiKeySelectionExpression: '$request.header.x-api-key',
    });
    const http = await provider.readCurrentState(API_ID, 'ApiLogical', 'AWS::ApiGatewayV2::Api');
    expect(http!).not.toHaveProperty('ApiKeySelectionExpression');
  });

  // ─── Stage ────────────────────────────────────────────────────────

  it('Stage create(): StageVariables / DefaultRouteSettings reach CreateStage', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.create('StageLogical', 'AWS::ApiGatewayV2::Stage', {
      ApiId: API_ID,
      StageName: '$default',
      StageVariables: { env: 'prod' },
      DefaultRouteSettings: {
        DetailedMetricsEnabled: true,
        ThrottlingBurstLimit: 100,
        ThrottlingRateLimit: 50,
      },
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateStageCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input['StageVariables']).toEqual({ env: 'prod' });
    expect(input['DefaultRouteSettings']).toEqual({
      DetailedMetricsEnabled: true,
      ThrottlingBurstLimit: 100,
      ThrottlingRateLimit: 50,
    });
  });

  it('Stage update(): StageVariables / DefaultRouteSettings change emits UpdateStage', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'StageLogical',
      '$default',
      'AWS::ApiGatewayV2::Stage',
      {
        ApiId: API_ID,
        StageName: '$default',
        StageVariables: { env: 'prod' },
        DefaultRouteSettings: { ThrottlingRateLimit: 100 },
      },
      {
        ApiId: API_ID,
        StageName: '$default',
        StageVariables: { env: 'dev' },
        DefaultRouteSettings: { ThrottlingRateLimit: 10 },
      }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateStageCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input).toEqual({
      ApiId: API_ID,
      StageName: '$default',
      StageVariables: { env: 'prod' },
      DefaultRouteSettings: { ThrottlingRateLimit: 100 },
    });
  });

  it('Stage update(): unchanged StageVariables / DefaultRouteSettings produce zero SDK calls', async () => {
    const same = {
      ApiId: API_ID,
      StageName: '$default',
      StageVariables: { env: 'prod' },
      DefaultRouteSettings: { ThrottlingRateLimit: 100 },
    };
    await provider.update('StageLogical', '$default', 'AWS::ApiGatewayV2::Stage', same, same);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Stage readCurrentState: emits StageVariables / DefaultRouteSettings when present, omits when absent', async () => {
    mockSend.mockResolvedValueOnce({
      StageName: '$default',
      AutoDeploy: true,
      StageVariables: { env: 'prod' },
      DefaultRouteSettings: { DetailedMetricsEnabled: true },
    });
    const withVars = await provider.readCurrentState(
      '$default',
      'StageLogical',
      'AWS::ApiGatewayV2::Stage',
      { ApiId: API_ID }
    );
    expect(withVars!['StageVariables']).toEqual({ env: 'prod' });
    expect(withVars!['DefaultRouteSettings']).toEqual({ DetailedMetricsEnabled: true });

    mockSend.mockResolvedValueOnce({ StageName: '$default', AutoDeploy: true });
    const without = await provider.readCurrentState(
      '$default',
      'StageLogical',
      'AWS::ApiGatewayV2::Stage',
      { ApiId: API_ID }
    );
    expect(without!).not.toHaveProperty('StageVariables');
    expect(without!).not.toHaveProperty('DefaultRouteSettings');
  });

  // ─── Integration ──────────────────────────────────────────────────

  it('Integration create(): TimeoutInMillis / RequestParameters / Description reach CreateIntegration', async () => {
    mockSend.mockResolvedValueOnce({ IntegrationId: 'int-1' });

    await provider.create('IntLogical', 'AWS::ApiGatewayV2::Integration', {
      ApiId: API_ID,
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:::function:f',
      TimeoutInMillis: 15000,
      RequestParameters: { 'append:header.x-from': "'cdkd'" },
      Description: 'lambda proxy integration',
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateIntegrationCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input['TimeoutInMillis']).toBe(15000);
    expect(input['RequestParameters']).toEqual({ 'append:header.x-from': "'cdkd'" });
    expect(input['Description']).toBe('lambda proxy integration');
  });

  it('Integration update(): TimeoutInMillis / RequestParameters / Description change emits UpdateIntegration', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'IntLogical',
      'int-1',
      'AWS::ApiGatewayV2::Integration',
      {
        ApiId: API_ID,
        IntegrationType: 'AWS_PROXY',
        TimeoutInMillis: 20000,
        RequestParameters: { 'append:header.x-from': "'new'" },
        Description: 'new-desc',
      },
      {
        ApiId: API_ID,
        IntegrationType: 'AWS_PROXY',
        TimeoutInMillis: 10000,
        RequestParameters: { 'append:header.x-from': "'old'" },
        Description: 'old-desc',
      }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateIntegrationCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input).toEqual({
      ApiId: API_ID,
      IntegrationId: 'int-1',
      TimeoutInMillis: 20000,
      RequestParameters: { 'append:header.x-from': "'new'" },
      Description: 'new-desc',
    });
  });

  it('Integration update(): unchanged backfilled fields produce zero SDK calls', async () => {
    const same = {
      ApiId: API_ID,
      IntegrationType: 'AWS_PROXY',
      TimeoutInMillis: 15000,
      RequestParameters: { 'append:header.x-from': "'cdkd'" },
      Description: 'd',
    };
    await provider.update('IntLogical', 'int-1', 'AWS::ApiGatewayV2::Integration', same, same);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Integration readCurrentState: emits TimeoutInMillis / RequestParameters / Description when present, omits when absent', async () => {
    mockSend.mockResolvedValueOnce({
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:::function:f',
      TimeoutInMillis: 15000,
      RequestParameters: { 'append:header.x-from': "'cdkd'" },
      Description: 'a description',
    });
    const withFields = await provider.readCurrentState(
      'int-1',
      'IntLogical',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: API_ID }
    );
    expect(withFields!['TimeoutInMillis']).toBe(15000);
    expect(withFields!['RequestParameters']).toEqual({ 'append:header.x-from': "'cdkd'" });
    expect(withFields!['Description']).toBe('a description');

    mockSend.mockResolvedValueOnce({
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: 'arn:aws:lambda:::function:f',
    });
    const without = await provider.readCurrentState(
      'int-1',
      'IntLogical',
      'AWS::ApiGatewayV2::Integration',
      { ApiId: API_ID }
    );
    expect(without!).not.toHaveProperty('TimeoutInMillis');
    expect(without!).not.toHaveProperty('RequestParameters');
    expect(without!).not.toHaveProperty('Description');
  });
});
