/**
 * `ApiGatewayV2Provider` keeps a delegating method for each method moved to
 * `src/provisioning/providers/apigatewayv2/` (`return fn.call(this, ...)`),
 * and each argument a delegator hands on is a hand-off the split introduced. A
 * mutation probe that replaced one argument with `undefined` (or swapped two
 * same-typed ones, or called a sibling resource's function) left the suites
 * green for the hand-offs below, so each is pinned here by what it reaches: the
 * error's `resourceType` / `physicalId`, the request the provider sends, the
 * attribute it returns, or the warning it logs.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeleteApiCommand,
  DeleteAuthorizerCommand,
  DeleteIntegrationCommand,
  DeleteRouteCommand,
  DeleteRouteRequestParameterCommand,
  DeleteStageCommand,
  GetApiCommand,
  GetAuthorizerCommand,
  GetIntegrationCommand,
  GetRouteCommand,
  GetStageCommand,
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

import {
  ApiGatewayV2Provider,
  resetApiGatewayV2CreateRetryStateForTests,
} from '../../../src/provisioning/providers/apigatewayv2-provider.js';
import type { MaskedLogSinks } from '../../../src/provisioning/masked-retry-logger.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

const API = 'AWS::ApiGatewayV2::Api';
const STAGE = 'AWS::ApiGatewayV2::Stage';
const INTEGRATION = 'AWS::ApiGatewayV2::Integration';
const ROUTE = 'AWS::ApiGatewayV2::Route';
const AUTHORIZER = 'AWS::ApiGatewayV2::Authorizer';

async function rejection(promise: Promise<unknown>): Promise<ProvisioningError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisioningError);
    return error as ProvisioningError;
  }
  throw new Error('expected a rejection');
}

function sinks(): MaskedLogSinks & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    mask: (text: string) => text,
    value: (raw: unknown) => String(raw),
  } as unknown as MaskedLogSinks & { warn: ReturnType<typeof vi.fn> };
}

describe('ApiGatewayV2Provider delegators hand every argument on', () => {
  let provider: ApiGatewayV2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    resetApiGatewayV2CreateRetryStateForTests();
    provider = new ApiGatewayV2Provider();
  });

  describe('delete() reaches the request and the error with physicalId and resourceType', () => {
    const cases = [
      { type: API, command: DeleteApiCommand, input: { ApiId: 'phys-1' } },
      { type: STAGE, command: DeleteStageCommand, input: { ApiId: 'api-1', StageName: 'phys-1' } },
      {
        type: INTEGRATION,
        command: DeleteIntegrationCommand,
        input: { ApiId: 'api-1', IntegrationId: 'phys-1' },
      },
      { type: ROUTE, command: DeleteRouteCommand, input: { ApiId: 'api-1', RouteId: 'phys-1' } },
      {
        type: AUTHORIZER,
        command: DeleteAuthorizerCommand,
        input: { ApiId: 'api-1', AuthorizerId: 'phys-1' },
      },
    ] as const;
    for (const { type, command, input } of cases) {
      it(type, async () => {
        mockSend.mockRejectedValue(
          Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
        );
        const error = await rejection(
          provider.delete('Logical', 'phys-1', type, { ApiId: 'api-1' })
        );
        expect(error.resourceType).toBe(type);
        expect(error.logicalId).toBe('Logical');
        expect(error.physicalId).toBe('phys-1');
        const sent = mockSend.mock.calls[0]![0] as { input: unknown };
        expect(sent).toBeInstanceOf(command);
        expect(sent.input).toEqual(input);
      });
    }
  });

  describe('getAttribute() returns the physical id for each type’s own id attribute', () => {
    const cases = [
      [API, 'ApiId'],
      [STAGE, 'StageName'],
      [INTEGRATION, 'IntegrationId'],
      [ROUTE, 'RouteId'],
      [AUTHORIZER, 'AuthorizerId'],
    ] as const;
    for (const [type, attribute] of cases) {
      it(`${type}.${attribute}`, async () => {
        await expect(provider.getAttribute('phys-1', type, attribute)).resolves.toBe('phys-1');
        await expect(provider.getAttribute('phys-1', type, 'NoSuchAttribute')).resolves.toBe(
          undefined
        );
      });
    }
  });

  describe('readCurrentState() sends the physical id', () => {
    const cases = [
      { type: API, command: GetApiCommand, input: { ApiId: 'phys-1' } },
      { type: STAGE, command: GetStageCommand, input: { ApiId: 'api-1', StageName: 'phys-1' } },
      {
        type: INTEGRATION,
        command: GetIntegrationCommand,
        input: { ApiId: 'api-1', IntegrationId: 'phys-1' },
      },
      { type: ROUTE, command: GetRouteCommand, input: { ApiId: 'api-1', RouteId: 'phys-1' } },
      {
        type: AUTHORIZER,
        command: GetAuthorizerCommand,
        input: { ApiId: 'api-1', AuthorizerId: 'phys-1' },
      },
    ] as const;
    for (const { type, command, input } of cases) {
      it(type, async () => {
        mockSend.mockResolvedValue({});
        await provider.readCurrentState('phys-1', 'Logical', type, { ApiId: 'api-1' });
        const sent = mockSend.mock.calls[0]![0] as { input: unknown };
        expect(sent).toBeInstanceOf(command);
        expect(sent.input).toEqual(input);
      });
    }
  });

  describe('create() hands resourceType to its refusal', () => {
    for (const type of [INTEGRATION, ROUTE, AUTHORIZER]) {
      it(type, async () => {
        const error = await rejection(provider.create('Logical', type, {}));
        expect(error.resourceType).toBe(type);
        expect(error.logicalId).toBe('Logical');
        expect(mockSend).not.toHaveBeenCalled();
      });
    }
  });

  describe('update() hands resourceType and physicalId to its refusal', () => {
    for (const type of [INTEGRATION, ROUTE, AUTHORIZER]) {
      it(type, async () => {
        const error = await rejection(provider.update('Logical', 'phys-1', type, {}, {}));
        expect(error.resourceType).toBe(type);
        expect(error.physicalId).toBe('phys-1');
        expect(mockSend).not.toHaveBeenCalled();
      });
    }
  });

  it('serviceIntegrationParameters() names logicalId, physicalId and resourceType in its refusal', () => {
    let thrown: unknown;
    try {
      provider.serviceIntegrationParameters('Logical', 'phys-1', INTEGRATION, {
        Detail: SECRET_MASK,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProvisioningError);
    const error = thrown as ProvisioningError;
    expect(error.logicalId).toBe('Logical');
    expect(error.physicalId).toBe('phys-1');
    expect(error.resourceType).toBe(INTEGRATION);
    expect(error.message).toContain(`Logical (${INTEGRATION})`);
  });

  it('deleteRouteRequestParameters() sends the API id and the route id', async () => {
    mockSend.mockResolvedValue({});
    await provider.deleteRouteRequestParameters('api-1', 'route-1', ['route.request.header.x']);
    const sent = mockSend.mock.calls[0]![0] as { input: unknown };
    expect(sent).toBeInstanceOf(DeleteRouteRequestParameterCommand);
    expect(sent.input).toEqual({
      ApiId: 'api-1',
      RouteId: 'route-1',
      RequestParameterKey: 'route.request.header.x',
    });
  });

  it('warnTlsConfigIgnoredIfPublic() names the logical id', () => {
    const log = sinks();
    provider.warnTlsConfigIgnoredIfPublic('Logical', { TlsConfig: {} }, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toContain('AWS::ApiGatewayV2::Integration Logical:');
  });
});
