import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateStageCommand,
  CreateRouteCommand,
  UpdateStageCommand,
  UpdateRouteCommand,
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
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';

const API_ID = 'abcd1234';
const STAGE_TYPE = 'AWS::ApiGatewayV2::Stage';
const ROUTE_TYPE = 'AWS::ApiGatewayV2::Route';

/**
 * Issue #609 backfill for `AWS::ApiGatewayV2::Stage` (4) and `::Route` (5).
 *
 * Every property here is an exact-spelling pass-through to the SDK, so the
 * failure mode is not a crash but a member that never reaches the API — the
 * serializer drops what it does not know and the deploy still reports success.
 * Each assertion therefore pins the SDK member by name.
 */
describe('ApiGatewayV2 Stage / Route config properties (#609)', () => {
  let provider: ApiGatewayV2Provider;

  const accessLogSettings = {
    DestinationArn: 'arn:aws:logs:us-east-1:1:log-group:cdkd-http-api-access',
    Format: '$context.requestId $context.status',
  };
  const routeSettings = {
    'GET /items': { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5, DetailedMetricsEnabled: true },
  };

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ApiGatewayV2Provider();
  });

  describe('Stage', () => {
    it('wires all four backfilled properties onto CreateStage', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', STAGE_TYPE, {
        ApiId: API_ID,
        StageName: 'test',
        AccessLogSettings: accessLogSettings,
        ClientCertificateId: 'cert-1',
        DeploymentId: 'dep-1',
        RouteSettings: routeSettings,
      });

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(CreateStageCommand);
      expect(cmd.input).toMatchObject({
        ApiId: API_ID,
        StageName: 'test',
        AccessLogSettings: accessLogSettings,
        ClientCertificateId: 'cert-1',
        DeploymentId: 'dep-1',
        RouteSettings: routeSettings,
      });
    });

    it.each([
      ['AccessLogSettings', accessLogSettings, { Format: '$context.requestId' }],
      ['ClientCertificateId', 'cert-2', 'cert-1'],
      ['DeploymentId', 'dep-2', 'dep-1'],
      [
        'RouteSettings',
        { 'GET /items': { ThrottlingRateLimit: 9 } },
        { 'GET /items': { ThrottlingRateLimit: 5 } },
      ],
    ])('fires UpdateStage carrying %s when only it changes', async (property, next, previous) => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'test',
        STAGE_TYPE,
        { ApiId: API_ID, StageName: 'test', [property]: next },
        { ApiId: API_ID, StageName: 'test', [property]: previous }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd, `${property} did not fire UpdateStage`).toBeInstanceOf(UpdateStageCommand);
      expect(cmd.input[property]).toEqual(next);
    });

    it('clears ClientCertificateId with the empty-string sentinel when it is removed', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'test',
        STAGE_TYPE,
        { ApiId: API_ID, StageName: 'test' },
        { ApiId: API_ID, StageName: 'test', ClientCertificateId: 'cert-1' }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateStageCommand);
      // UpdateStage MERGES, so omitting the member would keep the certificate
      // attached — the #1160 absent-field class.
      expect(cmd.input.ClientCertificateId).toBe('');
    });

    it.each(['AccessLogSettings', 'RouteSettings', 'DeploymentId'])(
      'does not invent a reset for %s (merge-semantics member with no documented sentinel)',
      async (property) => {
        await provider.update(
          'L',
          'test',
          STAGE_TYPE,
          { ApiId: API_ID, StageName: 'test' },
          { ApiId: API_ID, StageName: 'test', [property]: 'x' }
        );
        // No call at all: the removal is a documented pass-through, matching
        // the DefaultRouteSettings / Description precedent in this provider.
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it('skips UpdateStage when nothing changed', async () => {
      const props = {
        ApiId: API_ID,
        StageName: 'test',
        AccessLogSettings: accessLogSettings,
        RouteSettings: routeSettings,
      };
      await provider.update('L', 'test', STAGE_TYPE, props, { ...props });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('Route', () => {
    const requestModels = { 'application/json': 'MyModel' };
    const requestParameters = { 'route.request.header.X-Api': { Required: true } };

    it('wires all five backfilled properties onto CreateRoute', async () => {
      mockSend.mockResolvedValueOnce({ RouteId: 'r-1' });

      await provider.create('L', ROUTE_TYPE, {
        ApiId: API_ID,
        RouteKey: 'GET /items',
        ApiKeyRequired: true,
        ModelSelectionExpression: '$request.body.action',
        RequestModels: requestModels,
        RequestParameters: requestParameters,
        RouteResponseSelectionExpression: '$default',
      });

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(CreateRouteCommand);
      expect(cmd.input).toMatchObject({
        ApiId: API_ID,
        RouteKey: 'GET /items',
        ApiKeyRequired: true,
        ModelSelectionExpression: '$request.body.action',
        RequestModels: requestModels,
        RequestParameters: requestParameters,
        RouteResponseSelectionExpression: '$default',
      });
    });

    it.each([
      ['ApiKeyRequired', true, false],
      ['ModelSelectionExpression', '$request.body.b', '$request.body.a'],
      ['RequestModels', { 'application/json': 'B' }, { 'application/json': 'A' }],
      [
        'RequestParameters',
        { 'route.request.header.X-Api': { Required: false } },
        { 'route.request.header.X-Api': { Required: true } },
      ],
      ['RouteResponseSelectionExpression', '$other', '$default'],
    ])('fires UpdateRoute carrying %s when only it changes', async (property, next, previous) => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'r-1',
        ROUTE_TYPE,
        { ApiId: API_ID, RouteKey: 'GET /items', [property]: next },
        { ApiId: API_ID, RouteKey: 'GET /items', [property]: previous }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd, `${property} did not fire UpdateRoute`).toBeInstanceOf(UpdateRouteCommand);
      expect(cmd.input[property]).toEqual(next);
    });

    it('resets ApiKeyRequired to the CFn default when it is removed', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'r-1',
        ROUTE_TYPE,
        { ApiId: API_ID, RouteKey: 'GET /items' },
        { ApiId: API_ID, RouteKey: 'GET /items', ApiKeyRequired: true }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateRouteCommand);
      expect(cmd.input.ApiKeyRequired).toBe(false);
    });

    it('clears a dropped RequestModels key with the empty-string value AWS requires', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'r-1',
        ROUTE_TYPE,
        { ApiId: API_ID, RouteKey: 'GET /items', RequestModels: { 'application/json': 'Kept' } },
        {
          ApiId: API_ID,
          RouteKey: 'GET /items',
          RequestModels: { 'application/json': 'Kept', 'text/plain': 'Dropped' },
        }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      // The map MERGES on the AWS side (live-probed for the sibling
      // StageVariables / Integration RequestParameters maps), so a dropped key
      // is only cleared by sending it with an empty-string value.
      expect(cmd.input.RequestModels).toEqual({
        'application/json': 'Kept',
        'text/plain': '',
      });
    });

    it('skips UpdateRoute when nothing changed', async () => {
      const props = {
        ApiId: API_ID,
        RouteKey: 'GET /items',
        ApiKeyRequired: true,
        RequestParameters: requestParameters,
      };
      await provider.update('L', 'r-1', ROUTE_TYPE, props, { ...props });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('readCurrentState', () => {
    it('maps the Stage properties back', async () => {
      mockSend.mockResolvedValueOnce({
        StageName: 'test',
        AutoDeploy: true,
        AccessLogSettings: accessLogSettings,
        ClientCertificateId: 'cert-1',
        DeploymentId: 'dep-1',
        RouteSettings: routeSettings,
      });

      const state = (await provider.readCurrentState!('test', 'L', STAGE_TYPE, {
        ApiId: API_ID,
      })) as Record<string, unknown>;

      expect(state).toMatchObject({
        AccessLogSettings: accessLogSettings,
        ClientCertificateId: 'cert-1',
        DeploymentId: 'dep-1',
        RouteSettings: routeSettings,
      });
    });

    it('maps the Route properties back', async () => {
      mockSend.mockResolvedValueOnce({
        RouteKey: 'GET /items',
        ApiKeyRequired: true,
        ModelSelectionExpression: '$request.body.action',
        RequestModels: { 'application/json': 'MyModel' },
        RequestParameters: { 'route.request.header.X-Api': { Required: true } },
        RouteResponseSelectionExpression: '$default',
      });

      const state = (await provider.readCurrentState!('r-1', 'L', ROUTE_TYPE, {
        ApiId: API_ID,
      })) as Record<string, unknown>;

      expect(state).toMatchObject({
        ApiKeyRequired: true,
        ModelSelectionExpression: '$request.body.action',
        RequestModels: { 'application/json': 'MyModel' },
        RequestParameters: { 'route.request.header.X-Api': { Required: true } },
        RouteResponseSelectionExpression: '$default',
      });
    });

    it('omits a Stage property AWS did not return, so an unset one cannot drift', async () => {
      mockSend.mockResolvedValueOnce({ StageName: 'test', AutoDeploy: false });

      const state = (await provider.readCurrentState!('test', 'L', STAGE_TYPE, {
        ApiId: API_ID,
      })) as Record<string, unknown>;

      for (const key of ['AccessLogSettings', 'ClientCertificateId', 'DeploymentId', 'RouteSettings']) {
        expect(state, `${key} must stay absent`).not.toHaveProperty(key);
      }
    });
  });

  describe('declarations', () => {
    it.each([
      [STAGE_TYPE, ['AccessLogSettings', 'ClientCertificateId', 'DeploymentId', 'RouteSettings']],
      [
        ROUTE_TYPE,
        [
          'ApiKeyRequired',
          'ModelSelectionExpression',
          'RequestModels',
          'RequestParameters',
          'RouteResponseSelectionExpression',
        ],
      ],
    ])('reports no silent-drop property left for %s', (type, properties) => {
      const coverage = PROPERTY_COVERAGE_BY_TYPE.get(type);
      expect([...(coverage?.silentDrop.keys() ?? [])]).toEqual([]);
      for (const property of properties) {
        expect(coverage?.handled.has(property), property).toBe(true);
      }
    });
  });
});
