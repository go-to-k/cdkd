import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateIntegrationCommand,
  UpdateIntegrationCommand,
  GetIntegrationCommand,
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

/** Captures provider warnings so a "must not be silent" claim is assertable. */
const warnings: string[] = [];

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warnings.push(message);
    }),
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
const INTEGRATION_ID = 'int5678';
const INTEGRATION_TYPE = 'AWS::ApiGatewayV2::Integration';

/**
 * Issue #609 backfill for `AWS::ApiGatewayV2::Integration` (10 properties).
 *
 * Nine are exact-spelling pass-throughs, so their failure mode is not a crash
 * but a member that never reaches the API — the SDK serializer drops what it
 * does not know and the deploy still reports success. Each assertion therefore
 * pins the SDK member by name.
 *
 * `ResponseParameters` is the exception and the reason this file is not purely
 * mechanical: CFn and the SDK model it in DIFFERENT shapes, so forwarding it
 * verbatim would deliver an empty map per status code.
 */
describe('ApiGatewayV2 Integration config properties (#609)', () => {
  let provider: ApiGatewayV2Provider;

  /** CFn shape: a per-status-code list of {Destination, Source} pairs. */
  const cfnResponseParameters = {
    '404': {
      ResponseParameters: [
        { Destination: 'append:header.header1', Source: '$context.requestId' },
        { Destination: 'overwrite:statuscode', Source: '200' },
      ],
    },
  };
  /** SDK shape: the same data flattened into a map per status code. */
  const sdkResponseParameters = {
    '404': {
      'append:header.header1': '$context.requestId',
      'overwrite:statuscode': '200',
    },
  };

  const backfilled = {
    ConnectionId: 'vpclink-1',
    ConnectionType: 'VPC_LINK',
    ContentHandlingStrategy: 'CONVERT_TO_TEXT',
    CredentialsArn: 'arn:aws:iam::111122223333:role/apigw-invoke',
    IntegrationSubtype: 'EventBridge-PutEvents',
    PassthroughBehavior: 'WHEN_NO_TEMPLATES',
    RequestTemplates: { 'application/json': '{"statusCode":200}' },
    ResponseParameters: cfnResponseParameters,
    TemplateSelectionExpression: '$request.body.action',
    TlsConfig: { ServerNameToVerify: 'backend.example.com' },
  };

  beforeEach(() => {
    mockSend.mockReset();
    warnings.length = 0;
    provider = new ApiGatewayV2Provider();
  });

  describe('create', () => {
    it('wires all ten backfilled properties onto CreateIntegration', async () => {
      mockSend.mockResolvedValueOnce({ IntegrationId: INTEGRATION_ID });

      await provider.create('L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        IntegrationType: 'HTTP_PROXY',
        IntegrationUri: 'https://example.com',
        ...backfilled,
      });

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(CreateIntegrationCommand);
      expect(cmd.input).toMatchObject({
        ConnectionId: 'vpclink-1',
        ConnectionType: 'VPC_LINK',
        ContentHandlingStrategy: 'CONVERT_TO_TEXT',
        CredentialsArn: 'arn:aws:iam::111122223333:role/apigw-invoke',
        IntegrationSubtype: 'EventBridge-PutEvents',
        PassthroughBehavior: 'WHEN_NO_TEMPLATES',
        RequestTemplates: { 'application/json': '{"statusCode":200}' },
        TemplateSelectionExpression: '$request.body.action',
        TlsConfig: { ServerNameToVerify: 'backend.example.com' },
      });
    });

    it('folds the CFn ResponseParameters list-of-pairs into the SDK map', async () => {
      mockSend.mockResolvedValueOnce({ IntegrationId: INTEGRATION_ID });

      await provider.create('L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        IntegrationType: 'HTTP_PROXY',
        ResponseParameters: cfnResponseParameters,
      });

      // The whole point: forwarding the CFn shape verbatim would hand the
      // serializer a `{ ResponseParameters: [...] }` object it cannot model,
      // and every response parameter would vanish with the deploy reporting
      // success.
      expect(mockSend.mock.calls[0]?.[0].input.ResponseParameters).toEqual(sdkResponseParameters);
    });

    it('passes an already-flat ResponseParameters block through unchanged', async () => {
      mockSend.mockResolvedValueOnce({ IntegrationId: INTEGRATION_ID });

      await provider.create('L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        IntegrationType: 'HTTP_PROXY',
        ResponseParameters: sdkResponseParameters,
      });

      expect(mockSend.mock.calls[0]?.[0].input.ResponseParameters).toEqual(sdkResponseParameters);
    });

    it('coerces a numeric or boolean ResponseParameters Source instead of dropping it', async () => {
      mockSend.mockResolvedValueOnce({ IntegrationId: INTEGRATION_ID });

      // CFn types ResponseParameters as free-form `object` and coerces scalars;
      // cdkd does not. An UNQUOTED `Source: 403` under the canonical
      // `overwrite:statuscode` destination is a legal template — the exact
      // shape a YAML author writes — and skipping it would re-introduce the
      // silent drop this whole conversion exists to close.
      await provider.create('L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        IntegrationType: 'HTTP_PROXY',
        ResponseParameters: {
          '404': {
            ResponseParameters: [
              { Destination: 'overwrite:statuscode', Source: 403 },
              { Destination: 'overwrite:header.x-flag', Source: true },
            ],
          },
        },
      });

      expect(mockSend.mock.calls[0]?.[0].input.ResponseParameters).toEqual({
        '404': { 'overwrite:statuscode': '403', 'overwrite:header.x-flag': 'true' },
      });
    });

    it('skips — loudly — an entry whose Destination is not a string', async () => {
      mockSend.mockResolvedValueOnce({ IntegrationId: INTEGRATION_ID });

      // A Destination becomes the SDK map KEY, so a non-string one is a
      // malformed template rather than a scalar shorthand. It cannot be
      // delivered; what it must not be is silent.
      await provider.create('L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        IntegrationType: 'HTTP_PROXY',
        ResponseParameters: {
          '404': {
            ResponseParameters: [
              { Destination: { Ref: 'Unresolved' }, Source: 'x' },
              { Destination: 'overwrite:statuscode', Source: '200' },
            ],
          },
        },
      });

      // The usable sibling still ships...
      expect(mockSend.mock.calls[0]?.[0].input.ResponseParameters).toEqual({
        '404': { 'overwrite:statuscode': '200' },
      });
      // ...and the dropped one is announced.
      expect(warnings.some((m) => m.includes('cdkd cannot deliver'))).toBe(true);
    });

    it('leaves a non-object ResponseParameters untouched so AWS reports it', async () => {
      mockSend.mockResolvedValueOnce({ IntegrationId: INTEGRATION_ID });

      // An unresolved intrinsic must not be silently rewritten into `{}` —
      // that would turn an AWS validation error into a silent drop.
      await provider.create('L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        IntegrationType: 'HTTP_PROXY',
        ResponseParameters: 'not-an-object',
      });

      expect(mockSend.mock.calls[0]?.[0].input.ResponseParameters).toBe('not-an-object');
    });

    it('omits every backfilled member the template did not declare', async () => {
      mockSend.mockResolvedValueOnce({ IntegrationId: INTEGRATION_ID });

      await provider.create('L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        IntegrationType: 'MOCK',
      });

      const input = mockSend.mock.calls[0]?.[0].input as Record<string, unknown>;
      for (const key of Object.keys(backfilled)) {
        expect(input[key], key).toBeUndefined();
      }
    });
  });

  describe('update', () => {
    it('sends every changed backfilled property on UpdateIntegration', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        INTEGRATION_ID,
        INTEGRATION_TYPE,
        { ApiId: API_ID, ...backfilled },
        { ApiId: API_ID }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateIntegrationCommand);
      expect(cmd.input).toMatchObject({
        ApiId: API_ID,
        IntegrationId: INTEGRATION_ID,
        ConnectionId: 'vpclink-1',
        ConnectionType: 'VPC_LINK',
        ContentHandlingStrategy: 'CONVERT_TO_TEXT',
        CredentialsArn: 'arn:aws:iam::111122223333:role/apigw-invoke',
        IntegrationSubtype: 'EventBridge-PutEvents',
        PassthroughBehavior: 'WHEN_NO_TEMPLATES',
        RequestTemplates: { 'application/json': '{"statusCode":200}' },
        ResponseParameters: sdkResponseParameters,
        TemplateSelectionExpression: '$request.body.action',
        TlsConfig: { ServerNameToVerify: 'backend.example.com' },
      });
    });

    it.each(Object.keys(backfilled))('detects a change to %s alone', async (key) => {
      mockSend.mockResolvedValueOnce({});
      const changed: Record<string, unknown> = {
        ConnectionId: 'vpclink-2',
        ConnectionType: 'INTERNET',
        ContentHandlingStrategy: 'CONVERT_TO_BINARY',
        CredentialsArn: 'arn:aws:iam::111122223333:role/other',
        IntegrationSubtype: 'SQS-SendMessage',
        PassthroughBehavior: 'NEVER',
        RequestTemplates: { 'application/json': '{"statusCode":404}' },
        ResponseParameters: {
          '500': { ResponseParameters: [{ Destination: 'overwrite:statuscode', Source: '502' }] },
        },
        TemplateSelectionExpression: '$request.body.other',
        TlsConfig: { ServerNameToVerify: 'other.example.com' },
      };

      await provider.update(
        'L',
        INTEGRATION_ID,
        INTEGRATION_TYPE,
        { ApiId: API_ID, ...backfilled, [key]: changed[key] },
        { ApiId: API_ID, ...backfilled }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(UpdateIntegrationCommand);
      const sentKeys = Object.keys(mockSend.mock.calls[0]?.[0].input);
      expect(sentKeys).toContain(key);
      // ...and SELECTIVITY: an implementation that re-sent every defined member
      // on any diff would satisfy the line above for all ten keys. Over-sending
      // is not harmless here — AWS silently discards some of these depending on
      // the integration's connection type / protocol, so a resent member can
      // land in state without ever existing on AWS.
      const unchanged = Object.keys(backfilled).filter(
        (k) => k !== key && k !== 'IntegrationSubtype'
      );
      for (const other of unchanged) {
        expect(sentKeys, `${key} changed but ${other} was also sent`).not.toContain(other);
      }
    });

    it('re-sends the unchanged IntegrationSubtype on a service-integration update', async () => {
      mockSend.mockResolvedValueOnce({});

      // The shape a regression would emit: only the CHANGED member in the
      // patch. Live A/B (2026-08-11, us-east-1) shows AWS then re-validates
      // the integration as URI-based and rejects the call with
      // `Invalid integration URI specified` — so the discriminator has to ride
      // along even though it did not change. Found by the integ, not here: a
      // mocked client accepts either shape happily.
      await provider.update(
        'L',
        INTEGRATION_ID,
        INTEGRATION_TYPE,
        {
          ApiId: API_ID,
          IntegrationType: 'AWS_PROXY',
          IntegrationSubtype: 'EventBridge-PutEvents',
          RequestParameters: { Source: 'cdkd.integ', DetailType: 'updated' },
        },
        {
          ApiId: API_ID,
          IntegrationType: 'AWS_PROXY',
          IntegrationSubtype: 'EventBridge-PutEvents',
          RequestParameters: { Source: 'cdkd.integ', DetailType: 'before' },
        }
      );

      expect(mockSend.mock.calls[0]?.[0].input).toMatchObject({
        IntegrationSubtype: 'EventBridge-PutEvents',
        RequestParameters: { Source: 'cdkd.integ', DetailType: 'updated' },
      });
    });

    it('sources the re-sent IntegrationSubtype from the PREVIOUS side when the template drops it', async () => {
      mockSend.mockResolvedValueOnce({});

      // The constraint is about the LIVE integration, which stays a service
      // integration even when the desired template drops the subtype (removal
      // being out of scope). Reading the discriminator only from the desired
      // bag would send a subtype-less patch for exactly this template and fail
      // the deploy with `Invalid integration URI specified`.
      await provider.update(
        'L',
        INTEGRATION_ID,
        INTEGRATION_TYPE,
        { ApiId: API_ID, RequestParameters: { Source: 'cdkd.integ', DetailType: 'updated' } },
        {
          ApiId: API_ID,
          IntegrationSubtype: 'EventBridge-PutEvents',
          RequestParameters: { Source: 'cdkd.integ', DetailType: 'before' },
        }
      );

      expect(mockSend.mock.calls[0]?.[0].input).toMatchObject({
        IntegrationSubtype: 'EventBridge-PutEvents',
      });
    });

    it('treats an explicit null as absent rather than issuing an empty update', async () => {
      // `!== undefined` would let null through, deepEqual(null, undefined) is
      // false, and the result is a field-less UpdateIntegration on every single
      // deploy.
      await provider.update(
        'L',
        INTEGRATION_ID,
        INTEGRATION_TYPE,
        { ApiId: API_ID, ResponseParameters: null, TlsConfig: null, ConnectionId: null },
        { ApiId: API_ID }
      );

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not issue an update for a service integration whose fields all match', async () => {
      // The re-send must not itself count as a change, or every no-op deploy
      // would churn every service integration.
      await provider.update(
        'L',
        INTEGRATION_ID,
        INTEGRATION_TYPE,
        { ApiId: API_ID, IntegrationType: 'AWS_PROXY', IntegrationSubtype: 'EventBridge-PutEvents' },
        { ApiId: API_ID, IntegrationType: 'AWS_PROXY', IntegrationSubtype: 'EventBridge-PutEvents' }
      );

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('skips UpdateIntegration when no backfilled property changed', async () => {
      // structuredClone, NOT a second spread of `backfilled`: a shallow spread
      // leaves both sides sharing the SAME object references for the three
      // object-valued members, so a regression from deepEqual to `!==` would
      // still pass — while the real inputs (a freshly-synthesized template vs a
      // JSON-loaded state record) are never reference-equal. The clone is what
      // makes this test actually pin the structural comparison.
      await provider.update(
        'L',
        INTEGRATION_ID,
        INTEGRATION_TYPE,
        { ApiId: API_ID, ...structuredClone(backfilled) },
        { ApiId: API_ID, ...structuredClone(backfilled) }
      );

      // A per-deploy re-send would churn the integration on every no-op deploy.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does NOT reset a backfilled property the template dropped', async () => {
      // Deliberate scope decision, not an oversight: absent-field removal for
      // this group needs its own live CloudFormation A/B (issue #1160). Until
      // then a dropped field is a no-op, never a guessed reset value written
      // over a live integration. This pins the decision so a later change to
      // it is visible in the diff.
      await provider.update(
        'L',
        INTEGRATION_ID,
        INTEGRATION_TYPE,
        { ApiId: API_ID },
        { ApiId: API_ID, ...backfilled }
      );

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('readCurrentState', () => {
    it('reads every backfilled property back, converting ResponseParameters to the CFn shape', async () => {
      mockSend.mockResolvedValueOnce({
        IntegrationType: 'HTTP_PROXY',
        IntegrationUri: 'https://example.com',
        IntegrationMethod: 'ANY',
        PayloadFormatVersion: '1.0',
        ConnectionId: 'vpclink-1',
        ConnectionType: 'VPC_LINK',
        ContentHandlingStrategy: 'CONVERT_TO_TEXT',
        CredentialsArn: 'arn:aws:iam::111122223333:role/apigw-invoke',
        IntegrationSubtype: 'EventBridge-PutEvents',
        PassthroughBehavior: 'WHEN_NO_TEMPLATES',
        RequestTemplates: { 'application/json': '{"statusCode":200}' },
        ResponseParameters: sdkResponseParameters,
        TemplateSelectionExpression: '$request.body.action',
        TlsConfig: { ServerNameToVerify: 'backend.example.com' },
      });

      const state = await provider.readCurrentState!(INTEGRATION_ID, 'L', INTEGRATION_TYPE, {
        ApiId: API_ID,
      });

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetIntegrationCommand);
      expect(state).toMatchObject({
        ConnectionId: 'vpclink-1',
        ConnectionType: 'VPC_LINK',
        ContentHandlingStrategy: 'CONVERT_TO_TEXT',
        CredentialsArn: 'arn:aws:iam::111122223333:role/apigw-invoke',
        IntegrationSubtype: 'EventBridge-PutEvents',
        PassthroughBehavior: 'WHEN_NO_TEMPLATES',
        RequestTemplates: { 'application/json': '{"statusCode":200}' },
        TemplateSelectionExpression: '$request.body.action',
        TlsConfig: { ServerNameToVerify: 'backend.example.com' },
      });
      // Without the inverse fold the AWS-current side would carry the flat SDK
      // map while the cdkd baseline carries the CFn list-of-pairs, and every
      // `cdkd drift` run would report drift on an untouched integration.
      expect(state?.['ResponseParameters']).toEqual(cfnResponseParameters);
    });

    it('omits a backfilled key AWS did not return', async () => {
      mockSend.mockResolvedValueOnce({ IntegrationType: 'MOCK' });

      const state = await provider.readCurrentState!(INTEGRATION_ID, 'L', INTEGRATION_TYPE, {
        ApiId: API_ID,
      });

      for (const key of Object.keys(backfilled)) {
        expect(state, key).not.toHaveProperty(key);
      }
    });
  });

  it('reports no silent-drop property left for AWS::ApiGatewayV2::Integration', () => {
    const coverage = PROPERTY_COVERAGE_BY_TYPE.get(INTEGRATION_TYPE);
    expect([...(coverage?.silentDrop.keys() ?? [])]).toEqual([]);
    for (const property of Object.keys(backfilled)) {
      expect(coverage?.handled.has(property), property).toBe(true);
    }
  });
});

/**
 * Issue #1602 — the two pre-existing shapes the #609 Integration backfill made
 * reachable:
 *
 * 1. `TlsConfig` on a PUBLIC integration is silently discarded by AWS (absent
 *    from both the create echo and the `GetIntegration` read-back — direct
 *    A/B, 2026-08-11 us-east-1), so the provider scopes the drift-unknown
 *    declaration by `ConnectionType` and announces the discard on write.
 * 2. `toSdkResponseParameters` accepts the ALREADY-FLAT SDK spelling, which
 *    made the pair non-injective: the inverse always rebuilt the CFn list
 *    shape, so a flat-spelled baseline never compared equal to the read-back.
 *    The inverse now mirrors the DECLARED spelling per status code.
 */
describe('ApiGatewayV2 Integration TlsConfig visibility + flat ResponseParameters round-trip (#1602)', () => {
  let provider: ApiGatewayV2Provider;

  const flatResponseParameters = {
    '404': {
      'append:header.header1': '$context.requestId',
      'overwrite:statuscode': '200',
    },
  };
  const cfnListResponseParameters = {
    '404': {
      ResponseParameters: [
        { Destination: 'append:header.header1', Source: '$context.requestId' },
        { Destination: 'overwrite:statuscode', Source: '200' },
      ],
    },
  };

  beforeEach(() => {
    mockSend.mockReset();
    warnings.length = 0;
    provider = new ApiGatewayV2Provider();
  });

  describe('getDriftUnknownPaths', () => {
    it('declares TlsConfig drift-unknown for an explicit INTERNET integration', () => {
      expect(
        provider.getDriftUnknownPaths(INTEGRATION_TYPE, { ConnectionType: 'INTERNET' })
      ).toEqual(['TlsConfig']);
    });

    it('declares TlsConfig drift-unknown when ConnectionType is absent (INTERNET default)', () => {
      expect(provider.getDriftUnknownPaths(INTEGRATION_TYPE, { ApiId: API_ID })).toEqual([
        'TlsConfig',
      ]);
    });

    it('keeps TlsConfig compared for a VPC_LINK integration', () => {
      expect(
        provider.getDriftUnknownPaths(INTEGRATION_TYPE, { ConnectionType: 'VPC_LINK' })
      ).toEqual([]);
    });

    it('stays empty without a properties bag — never hide a private integration real drift', () => {
      expect(provider.getDriftUnknownPaths(INTEGRATION_TYPE)).toEqual([]);
    });

    it('stays empty for the sibling ApiGatewayV2 types', () => {
      expect(
        provider.getDriftUnknownPaths('AWS::ApiGatewayV2::Stage', { ConnectionType: 'INTERNET' })
      ).toEqual([]);
    });
  });

  describe('TlsConfig-ignored warning', () => {
    it('warns on create when TlsConfig is declared on a public integration', async () => {
      mockSend.mockResolvedValueOnce({ IntegrationId: INTEGRATION_ID });

      await provider.create('L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        IntegrationType: 'HTTP_PROXY',
        IntegrationUri: 'https://example.com',
        TlsConfig: { ServerNameToVerify: 'backend.example.com' },
      });

      expect(warnings.some((w) => w.includes('TlsConfig'))).toBe(true);
    });

    it('does not warn on create for a VPC_LINK integration', async () => {
      mockSend.mockResolvedValueOnce({ IntegrationId: INTEGRATION_ID });

      await provider.create('L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        IntegrationType: 'HTTP_PROXY',
        IntegrationUri: 'https://example.com',
        ConnectionId: 'vpclink-1',
        ConnectionType: 'VPC_LINK',
        TlsConfig: { ServerNameToVerify: 'backend.example.com' },
      });

      expect(warnings.filter((w) => w.includes('TlsConfig'))).toEqual([]);
    });

    it('warns on update when a changed TlsConfig is sent on a public integration', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        INTEGRATION_ID,
        INTEGRATION_TYPE,
        {
          ApiId: API_ID,
          IntegrationType: 'HTTP_PROXY',
          IntegrationUri: 'https://example.com',
          TlsConfig: { ServerNameToVerify: 'changed.example.com' },
        },
        {
          ApiId: API_ID,
          IntegrationType: 'HTTP_PROXY',
          IntegrationUri: 'https://example.com',
        }
      );

      expect(warnings.some((w) => w.includes('TlsConfig'))).toBe(true);
    });
  });

  describe('readCurrentState ResponseParameters spelling mirror', () => {
    it('keeps the flat SDK spelling when the template declared it flat', async () => {
      mockSend.mockResolvedValueOnce({
        IntegrationType: 'HTTP_PROXY',
        IntegrationUri: 'https://example.com',
        ResponseParameters: flatResponseParameters,
      });

      const state = await provider.readCurrentState!(INTEGRATION_ID, 'L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        ResponseParameters: flatResponseParameters,
      });

      // Baseline (flat) and read-back (flat) now compare equal — object
      // comparison is key-based, so no sort is needed on this arm.
      expect(state?.['ResponseParameters']).toEqual(flatResponseParameters);
    });

    it('rebuilds the CFn list shape when the template declared the CFn shape', async () => {
      mockSend.mockResolvedValueOnce({
        IntegrationType: 'HTTP_PROXY',
        IntegrationUri: 'https://example.com',
        ResponseParameters: flatResponseParameters,
      });

      const state = await provider.readCurrentState!(INTEGRATION_ID, 'L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        ResponseParameters: cfnListResponseParameters,
      });

      expect(state?.['ResponseParameters']).toEqual(cfnListResponseParameters);
    });

    it('mirrors the spelling PER STATUS CODE for a mixed template', async () => {
      mockSend.mockResolvedValueOnce({
        IntegrationType: 'HTTP_PROXY',
        IntegrationUri: 'https://example.com',
        ResponseParameters: {
          ...flatResponseParameters,
          '500': { 'overwrite:statuscode': '502' },
        },
      });

      const state = await provider.readCurrentState!(INTEGRATION_ID, 'L', INTEGRATION_TYPE, {
        ApiId: API_ID,
        ResponseParameters: {
          '404': flatResponseParameters['404'],
          '500': {
            ResponseParameters: [{ Destination: 'overwrite:statuscode', Source: '502' }],
          },
        },
      });

      expect(state?.['ResponseParameters']).toEqual({
        '404': flatResponseParameters['404'],
        '500': {
          ResponseParameters: [{ Destination: 'overwrite:statuscode', Source: '502' }],
        },
      });
    });

    it('rebuilds the CFn list shape when the state bag has no declared block', async () => {
      mockSend.mockResolvedValueOnce({
        IntegrationType: 'HTTP_PROXY',
        IntegrationUri: 'https://example.com',
        ResponseParameters: flatResponseParameters,
      });

      const state = await provider.readCurrentState!(INTEGRATION_ID, 'L', INTEGRATION_TYPE, {
        ApiId: API_ID,
      });

      expect(state?.['ResponseParameters']).toEqual(cfnListResponseParameters);
    });
  });
});
