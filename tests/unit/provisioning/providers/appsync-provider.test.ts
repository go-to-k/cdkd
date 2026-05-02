import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('tag-based lookup: ListGraphqlApis matches the aws:cdk:path tag map', async () => {
    mockSend.mockResolvedValueOnce({
      graphqlApis: [
        {
          apiId: 'other123',
          tags: { 'aws:cdk:path': 'OtherStack/Api/Resource' },
        },
        {
          apiId: 'abc123',
          tags: { 'aws:cdk:path': 'MyStack/MyApi/Resource' },
        },
      ],
    });

    const result = await provider.import(makeInput());

    expect(result).toEqual({ physicalId: 'abc123', attributes: {} });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListGraphqlApisCommand);
  });

  it('returns null when no GraphQL API matches the cdkPath', async () => {
    mockSend.mockResolvedValueOnce({
      graphqlApis: [
        {
          apiId: 'unrelated',
          tags: { 'aws:cdk:path': 'OtherStack/Api/Resource' },
        },
      ],
    });

    const result = await provider.import(makeInput());

    expect(result).toBeNull();
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
