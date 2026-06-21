import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateSecurityConfigurationCommand,
  DeleteSecurityConfigurationCommand,
  GetSecurityConfigurationCommand,
} from '@aws-sdk/client-glue';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-glue', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-glue')>('@aws-sdk/client-glue');
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
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

import { GlueSecurityConfigurationProvider } from '../../../src/provisioning/providers/glue-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

describe('GlueSecurityConfigurationProvider', () => {
  let provider: GlueSecurityConfigurationProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueSecurityConfigurationProvider();
  });

  it('create() sends CreateSecurityConfiguration with full EncryptionConfiguration', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await provider.create('L', 'AWS::Glue::SecurityConfiguration', {
      Name: 'my-sec',
      EncryptionConfiguration: {
        // CFn property is `S3Encryptions` (plural); the SDK input below is
        // `S3Encryption` (singular).
        S3Encryptions: [
          { S3EncryptionMode: 'SSE-KMS', KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/abc' },
        ],
        CloudWatchEncryption: {
          CloudWatchEncryptionMode: 'SSE-KMS',
          KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/cw',
        },
        JobBookmarksEncryption: {
          JobBookmarksEncryptionMode: 'CSE-KMS',
          KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/jb',
        },
      },
    });

    expect(result).toEqual({ physicalId: 'my-sec', attributes: {} });
    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof CreateSecurityConfigurationCommand
    );
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      Name: 'my-sec',
      EncryptionConfiguration: {
        S3Encryption: [
          { S3EncryptionMode: 'SSE-KMS', KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/abc' },
        ],
        CloudWatchEncryption: {
          CloudWatchEncryptionMode: 'SSE-KMS',
          KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/cw',
        },
        JobBookmarksEncryption: {
          JobBookmarksEncryptionMode: 'CSE-KMS',
          KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/jb',
        },
      },
    });
  });

  it('create() requires Name', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::SecurityConfiguration', {
        EncryptionConfiguration: {},
      })
    ).rejects.toThrow(/Name is required/);
  });

  it('create() requires EncryptionConfiguration', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::SecurityConfiguration', { Name: 'my-sec' })
    ).rejects.toThrow(/EncryptionConfiguration is required/);
  });

  it('update() always rejects with ResourceUpdateNotSupportedError (immutable resource)', async () => {
    // SecurityConfiguration has no AWS UpdateApi — surfacing the error
    // makes `cdkd drift --revert` report a clean "could not revert"
    // outcome instead of silently no-op'ing.
    await expect(
      provider.update(
        'L',
        'my-sec',
        'AWS::Glue::SecurityConfiguration',
        { Name: 'my-sec', EncryptionConfiguration: {} },
        {}
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
  });

  it('update() rejection message names the resource type', async () => {
    let err: ResourceUpdateNotSupportedError | undefined;
    try {
      await provider.update(
        'L',
        'my-sec',
        'AWS::Glue::SecurityConfiguration',
        { Name: 'my-sec' },
        {}
      );
    } catch (e) {
      err = e as ResourceUpdateNotSupportedError;
    }
    expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(err!.resourceType).toBe('AWS::Glue::SecurityConfiguration');
    expect(err!.logicalId).toBe('L');
  });

  it('delete() calls DeleteSecurityConfiguration', async () => {
    mockSend.mockResolvedValueOnce({});
    await provider.delete('L', 'my-sec', 'AWS::Glue::SecurityConfiguration', undefined, {
      expectedRegion: 'us-east-1',
    });

    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof DeleteSecurityConfigurationCommand
    );
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({ Name: 'my-sec' });
  });

  it('delete() treats EntityNotFoundException as idempotent when region matches', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    await expect(
      provider.delete('L', 'my-sec', 'AWS::Glue::SecurityConfiguration', undefined, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
  });

  it('getAttribute() returns physicalId for Name / Id / Ref', async () => {
    expect(
      await provider.getAttribute('my-sec', 'AWS::Glue::SecurityConfiguration', 'Name')
    ).toBe('my-sec');
    expect(
      await provider.getAttribute('my-sec', 'AWS::Glue::SecurityConfiguration', 'Id')
    ).toBe('my-sec');
    expect(
      await provider.getAttribute('my-sec', 'AWS::Glue::SecurityConfiguration', 'Ref')
    ).toBe('my-sec');
  });

  it('readCurrentState() emits PR #145 placeholders for empty EncryptionConfiguration', async () => {
    // GetSecurityConfiguration returns no encryption sub-configs —
    // placeholders must surface so the v3 baseline catches console-side
    // encryption enables on a previously default config.
    mockSend.mockResolvedValueOnce({
      SecurityConfiguration: { Name: 'my-sec', EncryptionConfiguration: {} },
    });

    const result = await provider.readCurrentState(
      'my-sec',
      'L',
      'AWS::Glue::SecurityConfiguration'
    );
    expect(result).toEqual({
      Name: 'my-sec',
      EncryptionConfiguration: {
        S3Encryptions: [],
        CloudWatchEncryption: {},
        JobBookmarksEncryption: {},
      },
    });
  });

  it('readCurrentState() reverse-maps full EncryptionConfiguration shape', async () => {
    mockSend.mockResolvedValueOnce({
      SecurityConfiguration: {
        Name: 'my-sec',
        EncryptionConfiguration: {
          S3Encryption: [
            { S3EncryptionMode: 'SSE-KMS', KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/abc' },
          ],
          CloudWatchEncryption: {
            CloudWatchEncryptionMode: 'SSE-KMS',
            KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/cw',
          },
          JobBookmarksEncryption: {
            JobBookmarksEncryptionMode: 'CSE-KMS',
            KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/jb',
          },
        },
      },
    });

    const result = await provider.readCurrentState(
      'my-sec',
      'L',
      'AWS::Glue::SecurityConfiguration'
    );
    expect(result).toEqual({
      Name: 'my-sec',
      EncryptionConfiguration: {
        S3Encryptions: [
          { S3EncryptionMode: 'SSE-KMS', KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/abc' },
        ],
        CloudWatchEncryption: {
          CloudWatchEncryptionMode: 'SSE-KMS',
          KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/cw',
        },
        JobBookmarksEncryption: {
          JobBookmarksEncryptionMode: 'CSE-KMS',
          KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/jb',
        },
      },
    });
  });

  it('readCurrentState() drops AWS-only DataQualityEncryption (not modeled in CFn)', async () => {
    // SDK returns DataQualityEncryption but `AWS::Glue::SecurityConfiguration`
    // CFn schema does NOT model it. Surfacing it would fire false drift on
    // every clean run.
    mockSend.mockResolvedValueOnce({
      SecurityConfiguration: {
        Name: 'my-sec',
        EncryptionConfiguration: {
          DataQualityEncryption: {
            DataQualityEncryptionMode: 'SSE-KMS',
            KmsKeyArn: 'arn:aws:kms:us-east-1:1:key/dq',
          },
        },
      },
    });

    const result = await provider.readCurrentState(
      'my-sec',
      'L',
      'AWS::Glue::SecurityConfiguration'
    );
    expect((result as Record<string, unknown>)['EncryptionConfiguration']).toEqual({
      S3Encryptions: [],
      CloudWatchEncryption: {},
      JobBookmarksEncryption: {},
    });
  });

  it('readCurrentState() returns undefined when SecurityConfiguration does not exist', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'missing',
      'L',
      'AWS::Glue::SecurityConfiguration'
    );
    expect(result).toBeUndefined();
  });

  it('handledProperties declares Name + EncryptionConfiguration', () => {
    const set = provider.handledProperties.get('AWS::Glue::SecurityConfiguration');
    expect(set).toBeDefined();
    expect([...(set ?? new Set())].sort()).toEqual(['EncryptionConfiguration', 'Name']);
  });
});
