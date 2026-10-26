import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#5294: a Method an earlier attempt of the same resource left
// behind (its wiring failed and so did the cleanup delete) is replaced on the
// next deploy, but only when this stack's rollback journal names it.

const mockSend = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    apiGateway: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
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

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  };
  childLogger['child'] = () => childLogger;
  return { getLogger: () => childLogger };
});

import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import {
  priorAttemptLookup,
  withPriorAttempts,
} from '../../../src/deployment/prior-attempt-scope.js';

const METHOD = 'AWS::ApiGateway::Method';
const props = {
  RestApiId: 'api-id',
  ResourceId: 'resource-id',
  HttpMethod: 'POST',
  AuthorizationType: 'NONE',
  Integration: { Type: 'MOCK' },
};

const alreadyExists = () =>
  Object.assign(new Error('Method already exists for this resource'), {
    name: 'ConflictException',
  });

const commandNames = () =>
  mockSend.mock.calls.map((call) => (call[0] as object).constructor.name);

function createWith(attempts: () => Promise<ReadonlyArray<Record<string, unknown>>>) {
  const provider = new ApiGatewayProvider();
  return withPriorAttempts(priorAttemptLookup('MyMethod', attempts), () =>
    provider.create('MyMethod', METHOD, props)
  );
}

describe('ApiGatewayProvider Method left behind by an earlier attempt (go-to-k/cdkd#5294)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockWarn.mockReset();
  });

  it('replaces a method the journal shows an earlier attempt of this resource made', async () => {
    mockSend
      .mockRejectedValueOnce(alreadyExists()) // PutMethod
      .mockResolvedValueOnce({}) // DeleteMethod
      .mockResolvedValue({}); // PutMethod again, PutIntegration
    const result = await createWith(() => Promise.resolve([{ ...props }]));

    expect(result.physicalId).toBe('api-id|resource-id|POST');
    expect(commandNames()).toEqual([
      'PutMethodCommand',
      'DeleteMethodCommand',
      'PutMethodCommand',
      'PutIntegrationCommand',
    ]);
    expect(mockSend.mock.calls[1]?.[0].input).toEqual({
      restApiId: 'api-id',
      resourceId: 'resource-id',
      httpMethod: 'POST',
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('which an earlier failed deploy of it left behind')
    );
  });

  it("keeps AWS's refusal when no evidence is bound", async () => {
    mockSend.mockRejectedValueOnce(alreadyExists());
    const provider = new ApiGatewayProvider();
    await expect(provider.create('MyMethod', METHOD, props)).rejects.toThrow(
      'Method already exists for this resource'
    );
    expect(commandNames()).toEqual(['PutMethodCommand']);
  });

  it.each([
    ['another HTTP method', { HttpMethod: 'GET' }],
    ['another resource', { ResourceId: 'other-resource' }],
    ['another REST API', { RestApiId: 'other-api' }],
  ])('keeps the refusal when the journal names %s', async (_label, override) => {
    mockSend.mockRejectedValueOnce(alreadyExists());
    await expect(createWith(() => Promise.resolve([{ ...props, ...override }]))).rejects.toThrow(
      'Method already exists for this resource'
    );
    expect(commandNames()).toEqual(['PutMethodCommand']);
  });

  it('keeps the refusal when the journal cannot be read', async () => {
    mockSend.mockRejectedValueOnce(alreadyExists());
    await expect(createWith(() => Promise.reject(new Error('AccessDenied')))).rejects.toThrow(
      'Method already exists for this resource'
    );
    expect(commandNames()).toEqual(['PutMethodCommand']);
  });

  it('does not treat a concurrent-modification ConflictException as an existing method', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('Unable to complete operation due to concurrent modification'), {
        name: 'ConflictException',
      })
    );
    await expect(createWith(() => Promise.resolve([{ ...props }]))).rejects.toThrow(
      'concurrent modification'
    );
    expect(commandNames()).toEqual(['PutMethodCommand']);
  });

  it('does not put the method again when deleting the leftover fails', async () => {
    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockRejectedValueOnce(new Error('DeleteMethod boom'));
    await expect(createWith(() => Promise.resolve([{ ...props }]))).rejects.toThrow(
      'DeleteMethod boom'
    );
    expect(commandNames()).toEqual(['PutMethodCommand', 'DeleteMethodCommand']);
  });
});
