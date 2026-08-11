import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateStageCommand,
  CreateRouteCommand,
  UpdateStageCommand,
  UpdateRouteCommand,
  DeleteAccessLogSettingsCommand,
  DeleteRouteSettingsCommand,
  DeleteRouteRequestParameterCommand,
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

import { NotFoundException } from '@aws-sdk/client-apigatewayv2';
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

    it('clears AccessLogSettings through its dedicated delete API when removed', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'L',
        'test',
        STAGE_TYPE,
        { ApiId: API_ID, StageName: 'test' },
        { ApiId: API_ID, StageName: 'test', AccessLogSettings: accessLogSettings }
      );

      // UpdateStage MERGES — live-probed 2026-08-11: a stage keeps its
      // AccessLogSettings through an UpdateStage that omits the member, so
      // omitting it is the silent no-op #1160 tracks and access logging (with
      // its billing) keeps running.
      const deleted = mockSend.mock.calls.find(
        (c) => c[0] instanceof DeleteAccessLogSettingsCommand
      );
      expect(deleted, 'AccessLogSettings removal issued no delete').toBeDefined();
      expect(deleted![0].input).toEqual({ ApiId: API_ID, StageName: 'test' });
    });

    it('deletes only the DROPPED RouteSettings keys, keeping the retained one', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'L',
        'test',
        STAGE_TYPE,
        { ApiId: API_ID, StageName: 'test', RouteSettings: { 'GET /kept': { ThrottlingRateLimit: 5 } } },
        {
          ApiId: API_ID,
          StageName: 'test',
          RouteSettings: {
            'GET /kept': { ThrottlingRateLimit: 5 },
            'GET /dropped': { ThrottlingRateLimit: 9 },
          },
        }
      );

      const deletes = mockSend.mock.calls
        .filter((c) => c[0] instanceof DeleteRouteSettingsCommand)
        .map((c) => c[0].input.RouteKey);
      expect(deletes).toEqual(['GET /dropped']);
    });

    it('deletes every RouteSettings key when the whole block is removed', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'L',
        'test',
        STAGE_TYPE,
        { ApiId: API_ID, StageName: 'test' },
        { ApiId: API_ID, StageName: 'test', RouteSettings: routeSettings }
      );

      const deletes = mockSend.mock.calls
        .filter((c) => c[0] instanceof DeleteRouteSettingsCommand)
        .map((c) => c[0].input.RouteKey);
      expect(deletes).toEqual(['GET /items']);
    });

    it('issues the removal deletes even when no UpdateStage-able field changed', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'L',
        'test',
        STAGE_TYPE,
        { ApiId: API_ID, StageName: 'test' },
        { ApiId: API_ID, StageName: 'test', AccessLogSettings: accessLogSettings }
      );

      // The delete is its own API call, so the `!changed` early return must
      // not skip it.
      expect(
        mockSend.mock.calls.some((c) => c[0] instanceof DeleteAccessLogSettingsCommand)
      ).toBe(true);
      expect(mockSend.mock.calls.some((c) => c[0] instanceof UpdateStageCommand)).toBe(false);
    });

    it('does not invent a reset for DeploymentId (no delete API, no sentinel)', async () => {
      await provider.update(
        'L',
        'test',
        STAGE_TYPE,
        { ApiId: API_ID, StageName: 'test' },
        { ApiId: API_ID, StageName: 'test', DeploymentId: 'dep-1' }
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

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

    it('deletes only the DROPPED RequestParameters keys, keeping the retained one', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'L',
        'r-1',
        ROUTE_TYPE,
        {
          ApiId: API_ID,
          RouteKey: '$connect',
          RequestParameters: { 'route.request.header.Kept': { Required: true } },
        },
        {
          ApiId: API_ID,
          RouteKey: '$connect',
          RequestParameters: {
            'route.request.header.Kept': { Required: true },
            'route.request.header.Dropped': { Required: true },
          },
        }
      );

      // The map MERGES and its values are objects, so the empty-string per-key
      // clear does not apply — AWS ships a per-key delete instead
      // (live-probed 2026-08-11).
      const deletes = mockSend.mock.calls
        .filter((c) => c[0] instanceof DeleteRouteRequestParameterCommand)
        .map((c) => c[0].input.RequestParameterKey);
      expect(deletes).toEqual(['route.request.header.Dropped']);
    });

    it('deletes every RequestParameters key when the whole block is removed', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'L',
        'r-1',
        ROUTE_TYPE,
        { ApiId: API_ID, RouteKey: '$connect' },
        { ApiId: API_ID, RouteKey: '$connect', RequestParameters: requestParameters }
      );

      const deletes = mockSend.mock.calls
        .filter((c) => c[0] instanceof DeleteRouteRequestParameterCommand)
        .map((c) => c[0].input.RequestParameterKey);
      expect(deletes).toEqual(['route.request.header.X-Api']);
      // ...and it must happen even though no UpdateRoute-able field changed.
      expect(mockSend.mock.calls.some((c) => c[0] instanceof UpdateRouteCommand)).toBe(false);
    });

    it('clears every RequestModels key when the whole block is removed', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'r-1',
        ROUTE_TYPE,
        { ApiId: API_ID, RouteKey: '$default' },
        {
          ApiId: API_ID,
          RouteKey: '$default',
          RequestModels: { 'application/json': 'A', 'text/plain': 'B' },
        }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateRouteCommand);
      // Live-probed 2026-08-11: UpdateRoute accepts an empty-string value and
      // the model is cleared, so the string-map helper's sentinel holds here.
      expect(cmd.input.RequestModels).toEqual({ 'application/json': '', 'text/plain': '' });
    });

    it.each(['ModelSelectionExpression', 'RouteResponseSelectionExpression'])(
      'does not invent a reset for %s (no delete API, no documented sentinel)',
      async (property) => {
        await provider.update(
          'L',
          'r-1',
          ROUTE_TYPE,
          { ApiId: API_ID, RouteKey: '$default' },
          { ApiId: API_ID, RouteKey: '$default', [property]: '$request.body.action' }
        );
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

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
        DeploymentId: 'dep-0',
      })) as Record<string, unknown>;

      expect(state).toMatchObject({
        AccessLogSettings: accessLogSettings,
        ClientCertificateId: 'cert-1',
        DeploymentId: 'dep-1',
        RouteSettings: routeSettings,
      });
    });

    it('omits DeploymentId when the template never declared it', async () => {
      // Under `AutoDeploy: true` AWS mints a NEW deployment id on every route /
      // integration change. Capturing it into the observed-properties baseline
      // reports permanent phantom drift on an untouched stack, and `--revert`
      // then pushes the stale id back through UpdateStage. The value is a
      // non-empty string, so `undeclaredEmptyObservedKeys` cannot skip it —
      // the read side has to.
      mockSend.mockResolvedValueOnce({
        StageName: 'test',
        AutoDeploy: true,
        DeploymentId: 'dep-minted-by-aws',
      });

      const state = (await provider.readCurrentState!('test', 'L', STAGE_TYPE, {
        ApiId: API_ID,
      })) as Record<string, unknown>;

      expect(state).not.toHaveProperty('DeploymentId');
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

  describe('removal deletes are idempotent', () => {
    // The deletes run AFTER the merge-Update in the same update, so a partial
    // failure leaves state unsaved and the next deploy recomputes the SAME
    // dropped-key set. Without NotFound tolerance that is a permanent failure
    // loop; a console-side removal produces the same shape.
    it('treats a NotFound on the Stage removals as already-applied', async () => {
      mockSend.mockImplementation(() =>
        Promise.reject(
          new NotFoundException({ message: 'not found', $metadata: {} })
        )
      );

      await expect(
        provider.update(
          'L',
          'test',
          STAGE_TYPE,
          { ApiId: API_ID, StageName: 'test' },
          { ApiId: API_ID, StageName: 'test', AccessLogSettings: accessLogSettings }
        )
      ).resolves.toMatchObject({ physicalId: 'test' });
    });

    it('treats a NotFound on the Route parameter delete as already-applied', async () => {
      mockSend.mockImplementation(() =>
        Promise.reject(
          new NotFoundException({ message: 'not found', $metadata: {} })
        )
      );

      await expect(
        provider.update(
          'L',
          'r-1',
          ROUTE_TYPE,
          { ApiId: API_ID, RouteKey: '$connect' },
          {
            ApiId: API_ID,
            RouteKey: '$connect',
            RequestParameters: { 'route.request.header.X-Api': { Required: true } },
          }
        )
      ).resolves.toMatchObject({ physicalId: 'r-1' });
    });

    it('still surfaces a NON-NotFound delete failure', async () => {
      mockSend.mockImplementation(() => Promise.reject(new Error('ThrottlingException')));

      await expect(
        provider.update(
          'L',
          'test',
          STAGE_TYPE,
          { ApiId: API_ID, StageName: 'test' },
          { ApiId: API_ID, StageName: 'test', AccessLogSettings: accessLogSettings }
        )
      ).rejects.toThrow(/Throttling/);
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
