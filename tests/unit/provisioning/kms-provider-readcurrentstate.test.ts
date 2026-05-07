import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeKeyCommand,
  ListAliasesCommand,
  ListResourceTagsCommand,
  NotFoundException,
} from '@aws-sdk/client-kms';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    KMSClient: vi.fn().mockImplementation(() => ({
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

import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';

describe('KMSProvider.readCurrentState', () => {
  let provider: KMSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new KMSProvider();
  });

  it('returns CFn-shaped Key fields from DescribeKey (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      KeyMetadata: {
        KeyId: 'abcd-1234',
        Description: 'my key',
        KeySpec: 'SYMMETRIC_DEFAULT',
        KeyUsage: 'ENCRYPT_DECRYPT',
        Enabled: true,
        MultiRegion: false,
        Origin: 'AWS_KMS',
      },
    });

    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState('abcd-1234', 'KeyLogical', 'AWS::KMS::Key');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeKeyCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListResourceTagsCommand);
    expect(result).toEqual({
      Description: 'my key',
      KeySpec: 'SYMMETRIC_DEFAULT',
      KeyUsage: 'ENCRYPT_DECRYPT',
      Enabled: true,
      MultiRegion: false,
      Origin: 'AWS_KMS',
      Tags: [],
    });
  });

  it('returns CFn-shaped Alias fields from ListAliases', async () => {
    mockSend.mockResolvedValueOnce({
      Aliases: [
        { AliasName: 'alias/other', TargetKeyId: 'other-key' },
        { AliasName: 'alias/my-key', TargetKeyId: 'abcd-1234' },
      ],
    });

    const result = await provider.readCurrentState(
      'alias/my-key',
      'AliasLogical',
      'AWS::KMS::Alias'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(ListAliasesCommand);
    expect(result).toEqual({
      AliasName: 'alias/my-key',
      TargetKeyId: 'abcd-1234',
    });
  });

  it('returns undefined when key is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new NotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('gone', 'KeyLogical', 'AWS::KMS::Key');

    expect(result).toBeUndefined();
  });

  it('returns undefined when alias not in any page', async () => {
    mockSend.mockResolvedValueOnce({
      Aliases: [{ AliasName: 'alias/other', TargetKeyId: 'other-key' }],
    });

    const result = await provider.readCurrentState(
      'alias/missing',
      'AliasLogical',
      'AWS::KMS::Alias'
    );

    expect(result).toBeUndefined();
  });

  it('surfaces Key Tags from ListResourceTags with aws:* filtered out (KMS TagKey/TagValue shape)', async () => {
    mockSend.mockResolvedValueOnce({
      KeyMetadata: { KeyId: 'abcd-1234', Enabled: true },
    });
    mockSend.mockResolvedValueOnce({
      Tags: [
        { TagKey: 'Foo', TagValue: 'Bar' },
        { TagKey: 'aws:cdk:path', TagValue: 'MyStack/MyKey/Resource' },
      ],
    });

    const result = await provider.readCurrentState('abcd-1234', 'KeyLogical', 'AWS::KMS::Key');

    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Key Tags when ListResourceTags returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      KeyMetadata: { KeyId: 'abcd-1234', Enabled: true },
    });
    mockSend.mockResolvedValueOnce({
      Tags: [{ TagKey: 'aws:cdk:path', TagValue: 'MyStack/MyKey/Resource' }],
    });

    const result = await provider.readCurrentState('abcd-1234', 'KeyLogical', 'AWS::KMS::Key');

    expect(result?.Tags).toEqual([]);
  });
});
