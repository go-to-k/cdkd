import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeKeyCommand,
  GetKeyPolicyCommand,
  GetKeyRotationStatusCommand,
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

  it('returns CFn-shaped Key fields from DescribeKey + GetKeyPolicy + GetKeyRotationStatus + ListResourceTags', async () => {
    const policyDoc = {
      Version: '2012-10-17',
      Statement: [
        { Sid: 'Enable IAM', Effect: 'Allow', Principal: { AWS: '*' }, Action: 'kms:*', Resource: '*' },
      ],
    };
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
    // GetKeyPolicy
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policyDoc) });
    // GetKeyRotationStatus (symmetric only)
    mockSend.mockResolvedValueOnce({ KeyRotationEnabled: true, RotationPeriodInDays: 365 });
    // ListResourceTags
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState('abcd-1234', 'KeyLogical', 'AWS::KMS::Key');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeKeyCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(GetKeyPolicyCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(GetKeyRotationStatusCommand);
    expect(mockSend.mock.calls[3]?.[0]).toBeInstanceOf(ListResourceTagsCommand);
    expect(result).toEqual({
      Description: 'my key',
      KeySpec: 'SYMMETRIC_DEFAULT',
      KeyUsage: 'ENCRYPT_DECRYPT',
      Enabled: true,
      MultiRegion: false,
      Origin: 'AWS_KMS',
      KeyPolicy: policyDoc,
      EnableKeyRotation: true,
      RotationPeriodInDays: 365,
      Tags: [],
    });
  });

  it('skips GetKeyRotationStatus on asymmetric keys (Class 1 discriminator)', async () => {
    mockSend.mockResolvedValueOnce({
      KeyMetadata: {
        KeyId: 'asym-key',
        KeySpec: 'RSA_2048',
        KeyUsage: 'ENCRYPT_DECRYPT',
        Enabled: true,
      },
    });
    // GetKeyPolicy still fires.
    mockSend.mockResolvedValueOnce({ Policy: '{"Version":"2012-10-17"}' });
    // GetKeyRotationStatus is NOT called for asymmetric — next call should be ListResourceTags.
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState('asym-key', 'KeyLogical', 'AWS::KMS::Key');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeKeyCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(GetKeyPolicyCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListResourceTagsCommand);
    // Critically: no GetKeyRotationStatus.
    expect(
      mockSend.mock.calls.some((c) => c[0] instanceof GetKeyRotationStatusCommand)
    ).toBe(false);
    expect(result).toEqual({
      KeySpec: 'RSA_2048',
      KeyUsage: 'ENCRYPT_DECRYPT',
      Enabled: true,
      Description: '',
      KeyPolicy: { Version: '2012-10-17' },
      Tags: [],
    });
  });

  it('emits EnableKeyRotation: false when rotation is disabled (always-emit on symmetric)', async () => {
    mockSend.mockResolvedValueOnce({
      KeyMetadata: { KeyId: 'k', KeySpec: 'SYMMETRIC_DEFAULT', Enabled: true },
    });
    mockSend.mockResolvedValueOnce({ Policy: '{"Version":"2012-10-17"}' });
    mockSend.mockResolvedValueOnce({ KeyRotationEnabled: false });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState('k', 'KeyLogical', 'AWS::KMS::Key');
    expect(result?.EnableKeyRotation).toBe(false);
    // RotationPeriodInDays is omitted when AWS doesn't report it (rotation disabled).
    expect(result).not.toHaveProperty('RotationPeriodInDays');
  });

  it('omits KeyPolicy when GetKeyPolicy fails with permission error (defensive)', async () => {
    mockSend.mockResolvedValueOnce({
      KeyMetadata: { KeyId: 'k', KeySpec: 'SYMMETRIC_DEFAULT', Enabled: true },
    });
    // Simulate permission error — neither NotFoundException nor a parse error.
    mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
    mockSend.mockResolvedValueOnce({ KeyRotationEnabled: false });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState('k', 'KeyLogical', 'AWS::KMS::Key');

    // KeyPolicy key is NOT emitted; the comparator's state-keys-only top-
    // level walk treats absence as "drift unknown" rather than firing on
    // a transient permission blip.
    expect(result).not.toHaveProperty('KeyPolicy');
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
      KeyMetadata: { KeyId: 'abcd-1234', KeySpec: 'SYMMETRIC_DEFAULT', Enabled: true },
    });
    mockSend.mockResolvedValueOnce({ Policy: '{}' });
    mockSend.mockResolvedValueOnce({ KeyRotationEnabled: false });
    mockSend.mockResolvedValueOnce({
      Tags: [
        { TagKey: 'Foo', TagValue: 'Bar' },
        { TagKey: 'aws:cdk:path', TagValue: 'MyStack/MyKey/Resource' },
      ],
    });

    const result = await provider.readCurrentState('abcd-1234', 'KeyLogical', 'AWS::KMS::Key');

    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('emits empty Tags array when ListResourceTags returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      KeyMetadata: { KeyId: 'abcd-1234', KeySpec: 'SYMMETRIC_DEFAULT', Enabled: true },
    });
    mockSend.mockResolvedValueOnce({ Policy: '{}' });
    mockSend.mockResolvedValueOnce({ KeyRotationEnabled: false });
    mockSend.mockResolvedValueOnce({
      Tags: [{ TagKey: 'aws:cdk:path', TagValue: 'MyStack/MyKey/Resource' }],
    });

    const result = await provider.readCurrentState('abcd-1234', 'KeyLogical', 'AWS::KMS::Key');

    expect(result?.Tags).toEqual([]);
  });
});
