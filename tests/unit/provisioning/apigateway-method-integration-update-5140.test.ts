import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeleteIntegrationResponseCommand,
  NotFoundException,
  PutIntegrationCommand,
  UpdateMethodCommand,
} from '@aws-sdk/client-api-gateway';

// go-to-k/cdkd#5140: a Method update applies its Integration and responses,
// in the order API Gateway accepts (measured live: PutIntegration drops every
// integration response; PutIntegrationResponse overwrites; PutMethodResponse
// refuses an existing status code).
const mockSend = vi.fn();
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    apiGateway: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));
vi.mock('@aws-sdk/client-api-gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-api-gateway')>();
  return {
    ...actual,
    APIGatewayClient: vi.fn().mockImplementation(() => ({
      send: (command: unknown) => mockSend(command),
      config: { retryStrategy: () => Promise.resolve(undefined) },
    })),
  };
});

import {
  ApiGatewayProvider,
  methodChildCalls,
} from '../../../src/provisioning/providers/apigateway-provider.js';

const IDS = { restApiId: 'api', resourceId: 'res', httpMethod: 'GET' };
const OLD_URI = 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:old/invocations';
const NEW_URI = OLD_URI.replace('function:old', 'function:new');
const IR200 = { StatusCode: '200', ResponseTemplates: { 'application/json': '{"v":1}' } };
const MR200 = { StatusCode: '200', ResponseParameters: { 'method.response.header.X-A': false } };
const integration = (uri: string, responses?: unknown[]): Record<string, unknown> => ({
  Type: 'AWS_PROXY',
  IntegrationHttpMethod: 'POST',
  Uri: uri,
  ...(responses !== undefined && { IntegrationResponses: responses }),
});

/** Each call as `<Command name> <statusCode?> <uri?>`, in order. */
function shape(calls: ReturnType<typeof methodChildCalls>): string[] {
  return calls.map(({ command }) => {
    const input = command.input as { statusCode?: string; uri?: string };
    return [command.constructor.name, input.statusCode, input.uri].filter(Boolean).join(' ');
  });
}

describe('methodChildCalls (go-to-k/cdkd#5140)', () => {
  it('calls nothing when neither side changed', () => {
    const props = { Integration: integration(OLD_URI, [IR200]), MethodResponses: [MR200] };
    expect(methodChildCalls(IDS, props, structuredClone(props))).toEqual([]);
  });

  it('puts a changed integration, then every integration response it dropped', () => {
    const calls = methodChildCalls(
      IDS,
      { Integration: integration(NEW_URI, [IR200]), MethodResponses: [MR200] },
      { Integration: integration(OLD_URI, [IR200]), MethodResponses: [MR200] }
    );
    expect(shape(calls)).toEqual([
      `PutIntegrationCommand ${NEW_URI}`,
      'PutIntegrationResponseCommand 200',
    ]);
  });

  it('overwrites only a changed integration response', () => {
    const changed = { ...IR200, ResponseTemplates: { 'application/json': '{"v":2}' } };
    expect(
      shape(
        methodChildCalls(
          IDS,
          { Integration: integration(OLD_URI, [changed]) },
          { Integration: integration(OLD_URI, [IR200]) }
        )
      )
    ).toEqual(['PutIntegrationResponseCommand 200']);
  });

  it('deletes a removed integration response', () => {
    expect(
      shape(
        methodChildCalls(
          IDS,
          { Integration: integration(OLD_URI, []) },
          { Integration: integration(OLD_URI, [IR200]) }
        )
      )
    ).toEqual(['DeleteIntegrationResponseCommand 200']);
  });

  it('deletes then puts a changed method response, its integration response around it', () => {
    const changedMr = { ...MR200, ResponseParameters: { 'method.response.header.X-B': false } };
    expect(
      shape(
        methodChildCalls(
          IDS,
          { Integration: integration(OLD_URI, [IR200]), MethodResponses: [changedMr] },
          { Integration: integration(OLD_URI, [IR200]), MethodResponses: [MR200] }
        )
      )
    ).toEqual([
      'DeleteIntegrationResponseCommand 200',
      'DeleteMethodResponseCommand 200',
      'PutMethodResponseCommand 200',
      'PutIntegrationResponseCommand 200',
    ]);
  });

  it('puts a new method response before the integration response mapping onto it', () => {
    expect(
      shape(
        methodChildCalls(
          IDS,
          { Integration: integration(OLD_URI, [IR200]), MethodResponses: [MR200] },
          { Integration: integration(OLD_URI) }
        )
      )
    ).toEqual(['PutMethodResponseCommand 200', 'PutIntegrationResponseCommand 200']);
  });

  it('deletes a removed integration and puts an added one', () => {
    expect(shape(methodChildCalls(IDS, {}, { Integration: integration(OLD_URI, [IR200]) }))).toEqual([
      'DeleteIntegrationCommand',
    ]);
    expect(shape(methodChildCalls(IDS, { Integration: integration(NEW_URI, [IR200]) }, {}))).toEqual([
      `PutIntegrationCommand ${NEW_URI}`,
      'PutIntegrationResponseCommand 200',
    ]);
  });

  it('reads an empty Integration as none, never putting an integration with no type', () => {
    expect(methodChildCalls(IDS, { Integration: {} }, {})).toEqual([]);
    expect(methodChildCalls(IDS, {}, { Integration: {} })).toEqual([]);
  });
});

describe('methodChildCalls leaves a read-back side alone (go-to-k/cdkd#5140 review)', () => {
  // What `readCurrentState` emits for a method: the SDK's camelCase
  // integration and a status-code-keyed map of method responses, as
  // `cdkd drift --revert` passes it on either side.
  const readBack = {
    Integration: {
      type: 'AWS_PROXY',
      httpMethod: 'POST',
      uri: OLD_URI,
      integrationResponses: { '200': { statusCode: '200' } },
    },
    MethodResponses: { '200': { statusCode: '200' } },
  };
  const template = { Integration: integration(NEW_URI, [IR200]), MethodResponses: [MR200] };

  it('plans nothing when either side is the read-back shape', () => {
    expect(methodChildCalls(IDS, template, readBack)).toEqual([]);
    expect(methodChildCalls(IDS, readBack, template)).toEqual([]);
    expect(methodChildCalls(IDS, readBack, structuredClone(readBack))).toEqual([]);
  });

  it('never sends a PutIntegration with no type or a PutMethodResponse onto a read-back', () => {
    const calls = [
      ...methodChildCalls(IDS, template, readBack),
      ...methodChildCalls(IDS, readBack, template),
    ];
    expect(calls.filter((c) => c.kind === 'put')).toEqual([]);
  });
});

describe('ApiGatewayProvider.update Method applies the integration (go-to-k/cdkd#5140)', () => {
  beforeEach(() => mockSend.mockReset());

  const base = {
    RestApiId: 'api',
    ResourceId: 'res',
    HttpMethod: 'GET',
    AuthorizationType: 'NONE',
  };

  it('sends the new Uri to AWS without an UpdateMethod when only the integration changed', async () => {
    mockSend.mockResolvedValue({});
    const provider = new ApiGatewayProvider();
    await provider.update(
      'M',
      'api|res|GET',
      'AWS::ApiGateway::Method',
      { ...base, Integration: integration(NEW_URI) },
      { ...base, Integration: integration(OLD_URI) }
    );
    const sent = mockSend.mock.calls.map(([c]) => c as { constructor: { name: string }; input: { uri?: string } });
    expect(sent.some((c) => c instanceof UpdateMethodCommand)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(PutIntegrationCommand);
    expect(sent[0]!.input.uri).toBe(NEW_URI);
  });

  it('treats a delete of an already-gone sub-resource as done, but not a failed put', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DeleteIntegrationResponseCommand) {
        throw new NotFoundException({ message: 'Invalid Response status code specified', $metadata: {} });
      }
      return {};
    });
    const provider = new ApiGatewayProvider();
    await expect(
      provider.update(
        'M',
        'api|res|GET',
        'AWS::ApiGateway::Method',
        { ...base, Integration: integration(OLD_URI, []) },
        { ...base, Integration: integration(OLD_URI, [IR200]) }
      )
    ).resolves.toMatchObject({ wasReplaced: false });

    mockSend.mockReset();
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof PutIntegrationCommand) {
        throw new NotFoundException({ message: 'Invalid Method identifier specified', $metadata: {} });
      }
      return {};
    });
    await expect(
      provider.update(
        'M',
        'api|res|GET',
        'AWS::ApiGateway::Method',
        { ...base, Integration: integration(NEW_URI) },
        { ...base, Integration: integration(OLD_URI) }
      )
    ).rejects.toThrow(/Failed to update API Gateway Method M/);
  });
});
