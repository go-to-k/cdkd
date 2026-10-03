import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeDBSubnetGroupsCommand } from '@aws-sdk/client-docdb';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-docdb', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    DocDBClient: vi.fn().mockImplementation(() => ({
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
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { DocDBSubnetGroupProvider } from '../../../src/provisioning/providers/docdb-subnet-group-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const TYPE = 'AWS::DocDB::DBSubnetGroup';

describe('DocDBSubnetGroupProvider.readCurrentState (go-to-k/cdkd#4283)', () => {
  let provider: DocDBSubnetGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DocDBSubnetGroupProvider();
  });

  it('returns RESOURCE_NOT_FOUND when DescribeDBSubnetGroups rejects with DBSubnetGroupNotFoundFault', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('DBSubnetGroup my-sg not found'), {
        name: 'DBSubnetGroupNotFoundFault',
      })
    );

    const result = await provider.readCurrentState('my-sg', 'Sg', TYPE);

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeDBSubnetGroupsCommand);
    expect(result).toBe(RESOURCE_NOT_FOUND);
  });

  it('returns RESOURCE_NOT_FOUND when DescribeDBSubnetGroups lists no group', async () => {
    mockSend.mockResolvedValueOnce({ DBSubnetGroups: [] });

    const result = await provider.readCurrentState('my-sg', 'Sg', TYPE);

    expect(result).toBe(RESOURCE_NOT_FOUND);
  });

  it('keeps undefined for a message-only "not found" under another fault name', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('DBParameterGroup default.x not found'), {
        name: 'DBParameterGroupNotFoundFault',
      })
    );

    const result = await provider.readCurrentState('my-sg', 'Sg', TYPE);

    expect(result).toBeUndefined();
  });

  it('rethrows an AccessDenied describe error rather than reporting the group gone', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('User is not authorized'), { name: 'AccessDenied' })
    );

    await expect(provider.readCurrentState('my-sg', 'Sg', TYPE)).rejects.toThrow(
      'User is not authorized'
    );
  });
});
