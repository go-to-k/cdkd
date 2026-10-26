import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#5294: a Method an earlier attempt of the same resource left
// behind (its wiring failed and so did the cleanup delete) is replaced, but
// only on the stack's own proof that it left THAT method: a proven-orphan id
// in the rollback journal, or an earlier attempt of the same dispatch. A bare
// attempted bag is not enough.

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

import { NotFoundException } from '@aws-sdk/client-api-gateway';
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

const OWN_ID = 'api-id|resource-id|POST';

type Evidence = {
  bags?: () => Promise<ReadonlyArray<Record<string, unknown>>>;
  orphans?: () => Promise<readonly string[]>;
};

function lookup({ bags = () => Promise.resolve([]), orphans }: Evidence) {
  return priorAttemptLookup('MyMethod', bags, orphans);
}

function createWith(evidence: Evidence) {
  const provider = new ApiGatewayProvider();
  return withPriorAttempts(lookup(evidence), () => provider.create('MyMethod', METHOD, props));
}

describe('ApiGatewayProvider Method left behind by an earlier attempt (go-to-k/cdkd#5294)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockWarn.mockReset();
  });

  it('replaces a method the journal proves an earlier attempt of this resource left behind', async () => {
    mockSend
      .mockRejectedValueOnce(alreadyExists()) // PutMethod
      .mockResolvedValueOnce({}) // DeleteMethod
      .mockResolvedValue({}); // PutMethod again, PutIntegration
    const result = await createWith({ orphans: () => Promise.resolve([OWN_ID]) });

    expect(result.physicalId).toBe(OWN_ID);
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
      expect.stringContaining('which an earlier failed attempt of it left behind')
    );
  });

  // Both reviewers' repro: deploy 1 is refused by ANOTHER owner's method on
  // the same keys (or its cleanup succeeded), so it journals a matching bag
  // but no proven-orphan id. Deploy 2 must not delete that method.
  it('keeps the refusal when the journal holds a matching bag but proves no orphan', async () => {
    mockSend.mockRejectedValueOnce(alreadyExists());
    await expect(
      createWith({ bags: () => Promise.resolve([{ ...props }]), orphans: () => Promise.resolve([]) })
    ).rejects.toThrow('Method already exists for this resource');
    expect(commandNames()).toEqual(['PutMethodCommand']);
  });

  it("keeps AWS's refusal when no evidence is bound", async () => {
    mockSend.mockRejectedValueOnce(alreadyExists());
    const provider = new ApiGatewayProvider();
    await expect(provider.create('MyMethod', METHOD, props)).rejects.toThrow(
      'Method already exists for this resource'
    );
    expect(commandNames()).toEqual(['PutMethodCommand']);
  });

  it('keeps the refusal when the binder supplies no proven-orphan source', async () => {
    mockSend.mockRejectedValueOnce(alreadyExists());
    await expect(createWith({ bags: () => Promise.resolve([{ ...props }]) })).rejects.toThrow(
      'Method already exists for this resource'
    );
    expect(commandNames()).toEqual(['PutMethodCommand']);
  });

  it.each([
    ['another HTTP method', 'api-id|resource-id|GET'],
    ['another resource', 'api-id|other-resource|POST'],
    ['another REST API', 'other-api|resource-id|POST'],
  ])('keeps the refusal when the proven orphan is %s', async (_label, id) => {
    mockSend.mockRejectedValueOnce(alreadyExists());
    await expect(createWith({ orphans: () => Promise.resolve([id]) })).rejects.toThrow(
      'Method already exists for this resource'
    );
    expect(commandNames()).toEqual(['PutMethodCommand']);
  });

  it('keeps the refusal when the journal cannot be read', async () => {
    mockSend.mockRejectedValueOnce(alreadyExists());
    await expect(
      createWith({ orphans: () => Promise.reject(new Error('AccessDenied')) })
    ).rejects.toThrow('Method already exists for this resource');
    expect(commandNames()).toEqual(['PutMethodCommand']);
  });

  it('does not treat a concurrent-modification ConflictException as an existing method', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('Unable to complete operation due to concurrent modification'), {
        name: 'ConflictException',
      })
    );
    await expect(createWith({ orphans: () => Promise.resolve([OWN_ID]) })).rejects.toThrow(
      'concurrent modification'
    );
    expect(commandNames()).toEqual(['PutMethodCommand']);
  });

  it('does not put the method again when deleting the leftover fails', async () => {
    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockRejectedValueOnce(new Error('DeleteMethod boom'));
    await expect(createWith({ orphans: () => Promise.resolve([OWN_ID]) })).rejects.toThrow(
      'DeleteMethod boom'
    );
    expect(commandNames()).toEqual(['PutMethodCommand', 'DeleteMethodCommand']);
  });

  it('puts the method again when the leftover is already gone at the delete', async () => {
    mockSend
      .mockRejectedValueOnce(alreadyExists())
      .mockRejectedValueOnce(new NotFoundException({ message: 'Invalid Method identifier', $metadata: {} }))
      .mockResolvedValue({});
    await expect(createWith({ orphans: () => Promise.resolve([OWN_ID]) })).resolves.toMatchObject({
      physicalId: OWN_ID,
    });
    expect(commandNames()).toEqual([
      'PutMethodCommand',
      'DeleteMethodCommand',
      'PutMethodCommand',
      'PutIntegrationCommand',
    ]);
  });

  it("replaces the method an earlier attempt of the SAME dispatch left behind (the engine's retry)", async () => {
    const provider = new ApiGatewayProvider();
    const bound = lookup({ orphans: () => Promise.resolve([]) });
    mockSend
      .mockResolvedValueOnce({}) // attempt 1: PutMethod
      .mockRejectedValueOnce(new Error('PutIntegration boom'))
      .mockRejectedValueOnce(new Error('DeleteMethod boom')) // cleanup fails: left behind
      .mockRejectedValueOnce(alreadyExists()) // attempt 2: PutMethod
      .mockResolvedValue({}); // DeleteMethod, PutMethod, PutIntegration
    await withPriorAttempts(bound, async () => {
      await expect(provider.create('MyMethod', METHOD, props)).rejects.toThrow('PutIntegration boom');
      expect(bound.possiblyLanded()).toBe(true);
      await expect(provider.create('MyMethod', METHOD, props)).resolves.toMatchObject({
        physicalId: OWN_ID,
      });
    });
    expect(commandNames().slice(3)).toEqual([
      'PutMethodCommand',
      'DeleteMethodCommand',
      'PutMethodCommand',
      'PutIntegrationCommand',
    ]);
  });

  it('does not note a leftover when the cleanup delete succeeded', async () => {
    const bound = lookup({});
    mockSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('PutIntegration boom'))
      .mockResolvedValueOnce({});
    await withPriorAttempts(bound, () =>
      expect(new ApiGatewayProvider().create('MyMethod', METHOD, props)).rejects.toThrow(
        'PutIntegration boom'
      )
    );
    expect(bound.possiblyLanded()).toBe(false);
  });
});
