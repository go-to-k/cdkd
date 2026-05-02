import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGlueSend = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-glue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-glue')>();
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockGlueSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
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

import { GlueProvider } from '../../../../src/provisioning/providers/glue-provider.js';

describe('GlueProvider import', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    provider = new GlueProvider();
  });

  function makeDatabaseInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyDB',
      resourceType: 'AWS::Glue::Database',
      cdkPath: 'MyStack/MyDB',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('Database explicit override (knownPhysicalId): GetDatabase verifies', async () => {
    mockGlueSend.mockResolvedValueOnce({ Database: { Name: 'adopted_db' } });

    const result = await provider.import(makeDatabaseInput({ knownPhysicalId: 'adopted_db' }));

    expect(result).toEqual({ physicalId: 'adopted_db', attributes: {} });
    const call = mockGlueSend.mock.calls[0][0];
    expect(call.constructor.name).toBe('GetDatabaseCommand');
    expect(call.input).toEqual({ Name: 'adopted_db' });
  });

  it('Database tag-based lookup: matches aws:cdk:path via GetTags map', async () => {
    // GetDatabases
    mockGlueSend.mockResolvedValueOnce({
      DatabaseList: [{ Name: 'other_db' }, { Name: 'target_db' }],
    });
    // GetTags(other_db)
    mockGlueSend.mockResolvedValueOnce({
      Tags: { 'aws:cdk:path': 'OtherStack/Other' },
    });
    // GetTags(target_db)
    mockGlueSend.mockResolvedValueOnce({
      Tags: { 'aws:cdk:path': 'MyStack/MyDB' },
    });

    const result = await provider.import(makeDatabaseInput());
    expect(result).toEqual({ physicalId: 'target_db', attributes: {} });
  });

  it('Database returns null when nothing matches', async () => {
    mockGlueSend.mockResolvedValueOnce({ DatabaseList: [{ Name: 'only_db' }] });
    mockGlueSend.mockResolvedValueOnce({ Tags: { 'aws:cdk:path': 'OtherStack/Other' } });

    const result = await provider.import(makeDatabaseInput());
    expect(result).toBeNull();
  });

  it('Table tag-based lookup: matches via GetTables + GetTags', async () => {
    // GetTables
    mockGlueSend.mockResolvedValueOnce({
      TableList: [{ Name: 'target_table' }],
    });
    // GetTags
    mockGlueSend.mockResolvedValueOnce({
      Tags: { 'aws:cdk:path': 'MyStack/MyTable' },
    });

    const result = await provider.import({
      logicalId: 'MyTable',
      resourceType: 'AWS::Glue::Table',
      cdkPath: 'MyStack/MyTable',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { DatabaseName: 'mydb' },
    });

    expect(result).toEqual({ physicalId: 'mydb|target_table', attributes: {} });
  });
});
