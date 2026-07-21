import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-appsync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-appsync')>();
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
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

import { AppSyncProvider } from '../../../../src/provisioning/providers/appsync-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../../src/utils/error-handler.js';
import {
  GetGraphqlApiCommand,
  ListGraphqlApisCommand,
  NotFoundException,
} from '@aws-sdk/client-appsync';

describe('AppSyncProvider import', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AppSyncProvider();
  });

  function makeInput(
    overrides: Partial<{
      knownPhysicalId: string;
      cdkPath: string;
      resourceType: string;
      properties: Record<string, unknown>;
    }> = {}
  ) {
    return {
      logicalId: 'MyApi',
      resourceType: 'AWS::AppSync::GraphQLApi',
      cdkPath: 'MyStack/MyApi/Resource',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('explicit override: verifies via GetGraphqlApi and returns the physicalId', async () => {
    mockSend.mockResolvedValueOnce({
      graphqlApi: {
        apiId: 'abc123',
        name: 'my-api',
      },
    });

    const result = await provider.import(makeInput({ knownPhysicalId: 'abc123' }));

    expect(result).toEqual({ physicalId: 'abc123', attributes: {} });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetGraphqlApiCommand);
    expect(mockSend.mock.calls[0][0].input).toEqual({ apiId: 'abc123' });
  });

  // No `aws:cdk:path` tag walk (issue #1134): AWS rejects `aws:`-prefixed
  // tag writes, so the tag never exists on a real resource. Without an
  // explicit override the provider returns null without any AWS call.
  it('returns null without any AWS call when no explicit override is supplied', async () => {
    const result = await provider.import(makeInput());

    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sub-resource override-only: returns the knownPhysicalId without API calls', async () => {
    const result = await provider.import(
      makeInput({
        resourceType: 'AWS::AppSync::DataSource',
        knownPhysicalId: 'abc123/MyDataSource',
      })
    );

    expect(result).toEqual({ physicalId: 'abc123/MyDataSource', attributes: {} });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('GetGraphqlApi NotFoundException on explicit override returns null', async () => {
    mockSend.mockRejectedValueOnce(
      new NotFoundException({ $metadata: {}, message: 'not found' })
    );

    const result = await provider.import(makeInput({ knownPhysicalId: 'missing' }));

    expect(result).toBeNull();
  });
});

describe('AppSyncProvider update dispatch', () => {
  // Detailed update-path tests live in
  // tests/unit/provisioning/appsync-provider-roundtrip.test.ts.
  // This block keeps a minimal cross-check: the dispatch routes the
  // five supported AppSync resource types to a per-type update method
  // (no rejection at the dispatch layer) and rejects unknown types.
  let provider: AppSyncProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AppSyncProvider();
  });

  it('no-op on identical state (no SDK call) for every supported type', async () => {
    // Identity-only same-shape input → update path detects no diff and
    // returns without issuing any SDK call.
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['AWS::AppSync::GraphQLApi', 'api-1', { Name: 'A', AuthenticationType: 'API_KEY' }],
      ['AWS::AppSync::GraphQLSchema', 'api-1', { ApiId: 'api-1', Definition: 'type Q {x:String}' }],
      ['AWS::AppSync::DataSource', 'api-1|ds', { ApiId: 'api-1', Name: 'ds', Type: 'NONE' }],
      [
        'AWS::AppSync::Resolver',
        'api-1|Q|f',
        { ApiId: 'api-1', TypeName: 'Q', FieldName: 'f' },
      ],
      ['AWS::AppSync::ApiKey', 'api-1|k', { ApiId: 'api-1' }],
    ];
    for (const [resourceType, physicalId, props] of cases) {
      const result = await provider.update('MyId', physicalId, resourceType, props, props);
      expect(result.physicalId).toBe(physicalId);
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects unknown AppSync resource type at dispatch (defense-in-depth)', async () => {
    await expect(
      provider.update('MyId', 'phys-id', 'AWS::AppSync::Bogus', {}, {})
    ).rejects.toThrow(/Unsupported resource type/);
  });

  it('still surfaces ResourceUpdateNotSupportedError on immutable identity-field diffs', async () => {
    // The immutable-field rejections moved into per-type handlers; verify
    // that contract via a representative case (DataSource.Type) so the
    // dispatch layer's "no blanket rejection" change does not silently
    // remove the structural defense-in-depth.
    await expect(
      provider.update(
        'MyId',
        'api-1|ds',
        'AWS::AppSync::DataSource',
        { ApiId: 'api-1', Name: 'ds', Type: 'AWS_LAMBDA' },
        { ApiId: 'api-1', Name: 'ds', Type: 'AMAZON_DYNAMODB' }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
  });
});
