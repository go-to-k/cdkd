import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateRepositoryCommand,
  PutImageScanningConfigurationCommand,
} from '@aws-sdk/client-ecr';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ECRClient: vi.fn().mockImplementation(() => ({
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

import { ECRProvider } from '../../../src/provisioning/providers/ecr-provider.js';

/**
 * Regression: ECR CFn properties are PascalCase (`ImageScanningConfiguration:
 * { ScanOnPush: true }`, `EncryptionConfiguration: { EncryptionType, KmsKey }`)
 * but the AWS SDK input is camelCase. The provider used to forward the CFn-cased
 * object verbatim (cast `as ImageScanningConfiguration`), so the SDK ignored the
 * unknown `ScanOnPush` key and silently reset scanOnPush to false — `imageScanOnPush:
 * true` never reached AWS. Same trap silently dropped a KMS repo's KmsKey.
 */
describe('ECRProvider — CFn->SDK casing for scanning/encryption config', () => {
  let provider: ECRProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ECRProvider();
  });

  function createInput() {
    return mockSend.mock.calls.find((c) => c[0] instanceof CreateRepositoryCommand)?.[0]
      .input as Record<string, any>;
  }

  it('create maps ScanOnPush (Pascal) -> scanOnPush (camel) so it reaches AWS', async () => {
    mockSend.mockResolvedValue({ repository: { repositoryName: 'r', repositoryArn: 'a' } });
    await provider.create('Repo', 'AWS::ECR::Repository', {
      RepositoryName: 'r',
      ImageScanningConfiguration: { ScanOnPush: true },
    });
    const input = createInput();
    expect(input.imageScanningConfiguration).toEqual({ scanOnPush: true });
    // The CFn-cased key must NOT be forwarded verbatim.
    expect(input.imageScanningConfiguration.ScanOnPush).toBeUndefined();
  });

  it('create maps EncryptionConfiguration KMS (Pascal) -> camel incl. kmsKey', async () => {
    mockSend.mockResolvedValue({ repository: { repositoryName: 'r', repositoryArn: 'a' } });
    await provider.create('Repo', 'AWS::ECR::Repository', {
      RepositoryName: 'r',
      EncryptionConfiguration: { EncryptionType: 'KMS', KmsKey: 'arn:aws:kms:...:key/abc' },
    });
    const input = createInput();
    expect(input.encryptionConfiguration).toEqual({
      encryptionType: 'KMS',
      kmsKey: 'arn:aws:kms:...:key/abc',
    });
  });

  it('create with AES256 omits kmsKey', async () => {
    mockSend.mockResolvedValue({ repository: { repositoryName: 'r', repositoryArn: 'a' } });
    await provider.create('Repo', 'AWS::ECR::Repository', {
      RepositoryName: 'r',
      EncryptionConfiguration: { EncryptionType: 'AES256' },
    });
    const input = createInput();
    expect(input.encryptionConfiguration).toEqual({ encryptionType: 'AES256' });
  });

  it('create with AES256 + a stray KmsKey drops the kmsKey (KMS-only guard)', async () => {
    mockSend.mockResolvedValue({ repository: { repositoryName: 'r', repositoryArn: 'a' } });
    await provider.create('Repo', 'AWS::ECR::Repository', {
      RepositoryName: 'r',
      EncryptionConfiguration: { EncryptionType: 'AES256', KmsKey: 'arn:aws:kms:...:key/stray' },
    });
    const input = createInput();
    expect(input.encryptionConfiguration).toEqual({ encryptionType: 'AES256' });
  });

  it('create with ImageScanningConfiguration:{} (no ScanOnPush) sends scanOnPush:false', async () => {
    mockSend.mockResolvedValue({ repository: { repositoryName: 'r', repositoryArn: 'a' } });
    await provider.create('Repo', 'AWS::ECR::Repository', {
      RepositoryName: 'r',
      ImageScanningConfiguration: {},
    });
    const input = createInput();
    expect(input.imageScanningConfiguration).toEqual({ scanOnPush: false });
  });

  it('update maps ScanOnPush (Pascal) -> scanOnPush (camel) on PutImageScanningConfiguration', async () => {
    mockSend.mockResolvedValue({ repositories: [{ repositoryArn: 'a', repositoryUri: 'u' }] });
    await provider.update(
      'Repo',
      'r',
      'AWS::ECR::Repository',
      { ImageScanningConfiguration: { ScanOnPush: true } },
      { ImageScanningConfiguration: { ScanOnPush: false } }
    );
    const putCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutImageScanningConfigurationCommand
    );
    expect(putCall).toBeTruthy();
    expect((putCall![0].input as Record<string, any>).imageScanningConfiguration).toEqual({
      scanOnPush: true,
    });
  });
});
