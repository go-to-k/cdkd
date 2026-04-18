import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:fs
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

// Mock FileAssetPublisher
const mockFilePublish = vi.fn();
vi.mock('../../../src/assets/file-asset-publisher.js', () => ({
  FileAssetPublisher: vi.fn().mockImplementation(() => ({
    publish: mockFilePublish,
  })),
}));

// Mock DockerAssetPublisher
const mockDockerPublish = vi.fn();
vi.mock('../../../src/assets/docker-asset-publisher.js', () => ({
  DockerAssetPublisher: vi.fn().mockImplementation(() => ({
    publish: mockDockerPublish,
  })),
}));

// Mock @aws-sdk/client-sts
const mockStsSend = vi.fn();
const mockStsDestroy = vi.fn();
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: mockStsDestroy,
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({
    ...input,
    _type: 'GetCallerIdentity',
  })),
}));

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { readFileSync } from 'node:fs';
import { AssetPublisher } from '../../../src/assets/asset-publisher.js';
import { AssetError } from '../../../src/utils/error-handler.js';
import type { AssetManifest } from '../../../src/types/assets.js';

describe('AssetPublisher', () => {
  let publisher: AssetPublisher;

  const makeManifest = (overrides: Partial<AssetManifest> = {}): AssetManifest => ({
    version: '36.0.0',
    files: {},
    dockerImages: {},
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    publisher = new AssetPublisher();
    mockFilePublish.mockResolvedValue(undefined);
    mockDockerPublish.mockResolvedValue(undefined);
  });

  it('should publish file assets from manifest', async () => {
    const manifest = makeManifest({
      files: {
        abc123: {
          displayName: 'LambdaCode',
          source: { path: 'asset.abc123/index.js', packaging: 'file' },
          destinations: {
            current: {
              bucketName: 'cdk-assets-bucket',
              objectKey: 'assets/abc123.js',
            },
          },
        },
      },
    });

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest));

    await publisher.publishFromManifest('/tmp/cdk.out/manifest.json', {
      accountId: '123456789012',
      region: 'us-east-1',
    });

    expect(mockFilePublish).toHaveBeenCalledWith(
      'abc123',
      manifest.files['abc123'],
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1',
      undefined
    );
  });

  it('should publish docker image assets from manifest', async () => {
    const manifest = makeManifest({
      dockerImages: {
        docker456: {
          displayName: 'MyImage',
          source: { directory: 'asset.docker456' },
          destinations: {
            current: {
              repositoryName: 'my-repo',
              imageTag: 'latest',
            },
          },
        },
      },
    });

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest));

    await publisher.publishFromManifest('/tmp/cdk.out/manifest.json', {
      accountId: '123456789012',
      region: 'us-east-1',
    });

    expect(mockDockerPublish).toHaveBeenCalledWith(
      'docker456',
      manifest.dockerImages['docker456'],
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1',
      undefined
    );
  });

  it('should skip CloudFormation template assets', async () => {
    const manifest = makeManifest({
      files: {
        'template-hash': {
          displayName: 'CFnTemplate',
          source: { path: 'MyStack.template.json', packaging: 'file' },
          destinations: {
            current: {
              bucketName: 'cdk-assets-bucket',
              objectKey: 'template.json',
            },
          },
        },
        'template-hash2': {
          displayName: 'CFnTemplate2',
          source: { path: 'output.json', packaging: 'file' },
          destinations: {
            current: {
              bucketName: 'cdk-assets-bucket',
              objectKey: 'output.json',
            },
          },
        },
        'lambda-hash': {
          displayName: 'LambdaCode',
          source: { path: 'asset.lambda/index.js', packaging: 'zip' },
          destinations: {
            current: {
              bucketName: 'cdk-assets-bucket',
              objectKey: 'assets/lambda.zip',
            },
          },
        },
      },
    });

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest));

    await publisher.publishFromManifest('/tmp/cdk.out/manifest.json', {
      accountId: '123456789012',
      region: 'us-east-1',
    });

    // Only the lambda asset should be published; .json and .template.json skipped
    expect(mockFilePublish).toHaveBeenCalledTimes(1);
    expect(mockFilePublish).toHaveBeenCalledWith(
      'lambda-hash',
      expect.objectContaining({ displayName: 'LambdaCode' }),
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1',
      undefined
    );
  });

  it('should resolve account ID from STS if not provided', async () => {
    mockStsSend.mockResolvedValue({ Account: '999888777666' });

    const manifest = makeManifest({
      files: {
        abc123: {
          displayName: 'Asset',
          source: { path: 'asset.abc123/handler.py', packaging: 'zip' },
          destinations: {
            current: {
              bucketName: 'bucket',
              objectKey: 'key',
            },
          },
        },
      },
    });

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest));

    await publisher.publishFromManifest('/tmp/cdk.out/manifest.json', {
      region: 'us-east-1',
      // accountId intentionally omitted
    });

    expect(mockStsSend).toHaveBeenCalled();
    expect(mockStsDestroy).toHaveBeenCalled();
    expect(mockFilePublish).toHaveBeenCalledWith(
      'abc123',
      expect.anything(),
      '/tmp/cdk.out',
      '999888777666',
      'us-east-1',
      undefined
    );
  });

  it('should report no assets when manifest is empty', async () => {
    const manifest = makeManifest({ files: {}, dockerImages: {} });

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest));

    await publisher.publishFromManifest('/tmp/cdk.out/manifest.json', {
      accountId: '123456789012',
      region: 'us-east-1',
    });

    expect(mockFilePublish).not.toHaveBeenCalled();
    expect(mockDockerPublish).not.toHaveBeenCalled();
  });

  it('should throw AssetError on failure', async () => {
    mockFilePublish.mockRejectedValue(new Error('Upload failed'));

    const manifest = makeManifest({
      files: {
        abc123: {
          displayName: 'FailAsset',
          source: { path: 'asset.abc123/index.js', packaging: 'file' },
          destinations: {
            current: {
              bucketName: 'bucket',
              objectKey: 'key',
            },
          },
        },
      },
    });

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest));

    await expect(
      publisher.publishFromManifest('/tmp/cdk.out/manifest.json', {
        accountId: '123456789012',
        region: 'us-east-1',
      })
    ).rejects.toThrow(AssetError);

    await expect(
      publisher.publishFromManifest('/tmp/cdk.out/manifest.json', {
        accountId: '123456789012',
        region: 'us-east-1',
      })
    ).rejects.toThrow(/Upload failed/);
  });

  describe('parallel publishing', () => {
    it('should publish multiple file assets in parallel', async () => {
      const callOrder: string[] = [];
      mockFilePublish.mockImplementation(async (hash: string) => {
        callOrder.push(`start-${hash}`);
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push(`end-${hash}`);
      });

      const files: Record<string, (typeof manifest.files)[string]> = {};
      for (let i = 0; i < 4; i++) {
        files[`hash${i}`] = {
          displayName: `Asset${i}`,
          source: { path: `asset.hash${i}/index.js`, packaging: 'zip' as const },
          destinations: { current: { bucketName: 'bucket', objectKey: `key${i}` } },
        };
      }
      const manifest = makeManifest({ files });

      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest));

      await publisher.publishFromManifest('/tmp/cdk.out/manifest.json', {
        accountId: '123456789012',
        region: 'us-east-1',
        assetPublishConcurrency: 4,
      });

      expect(mockFilePublish).toHaveBeenCalledTimes(4);
      // All should start before any finishes (parallel)
      const starts = callOrder.filter((e) => e.startsWith('start-'));
      const firstEnd = callOrder.indexOf(callOrder.find((e) => e.startsWith('end-'))!);
      expect(starts.length).toBeGreaterThanOrEqual(2);
      // At least 2 starts before first end indicates parallelism
      const startsBeforeFirstEnd = callOrder.slice(0, firstEnd).filter((e) => e.startsWith('start-'));
      expect(startsBeforeFirstEnd.length).toBeGreaterThanOrEqual(2);
    });

    it('should publish multiple docker assets in parallel', async () => {
      const callOrder: string[] = [];
      mockDockerPublish.mockImplementation(async (hash: string) => {
        callOrder.push(`start-${hash}`);
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push(`end-${hash}`);
      });

      const dockerImages: Record<string, (typeof manifest.dockerImages)[string]> = {};
      for (let i = 0; i < 3; i++) {
        dockerImages[`docker${i}`] = {
          displayName: `Image${i}`,
          source: { directory: `asset.docker${i}` },
          destinations: { current: { repositoryName: 'repo', imageTag: `tag${i}` } },
        };
      }
      const manifest = makeManifest({ dockerImages });

      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest));

      await publisher.publishFromManifest('/tmp/cdk.out/manifest.json', {
        accountId: '123456789012',
        region: 'us-east-1',
        assetPublishConcurrency: 3,
      });

      expect(mockDockerPublish).toHaveBeenCalledTimes(3);
      const startsBeforeFirstEnd = callOrder
        .slice(0, callOrder.indexOf(callOrder.find((e) => e.startsWith('end-'))!))
        .filter((e) => e.startsWith('start-'));
      expect(startsBeforeFirstEnd.length).toBeGreaterThanOrEqual(2);
    });

    it('should respect concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      mockFilePublish.mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
      });

      const files: Record<string, (typeof manifest.files)[string]> = {};
      for (let i = 0; i < 10; i++) {
        files[`hash${i}`] = {
          displayName: `Asset${i}`,
          source: { path: `asset.hash${i}/index.js`, packaging: 'zip' as const },
          destinations: { current: { bucketName: 'bucket', objectKey: `key${i}` } },
        };
      }
      const manifest = makeManifest({ files });

      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest));

      await publisher.publishFromManifest('/tmp/cdk.out/manifest.json', {
        accountId: '123456789012',
        region: 'us-east-1',
        assetPublishConcurrency: 3,
      });

      expect(mockFilePublish).toHaveBeenCalledTimes(10);
      expect(maxConcurrent).toBeLessThanOrEqual(3);
      expect(maxConcurrent).toBeGreaterThanOrEqual(2); // Should actually use parallelism
    });

    it('should collect all errors from parallel publishing', async () => {
      let callCount = 0;
      mockFilePublish.mockImplementation(async () => {
        callCount++;
        if (callCount === 1 || callCount === 3) {
          throw new Error(`Fail ${callCount}`);
        }
      });

      const files: Record<string, (typeof manifest.files)[string]> = {};
      for (let i = 0; i < 4; i++) {
        files[`hash${i}`] = {
          displayName: `Asset${i}`,
          source: { path: `asset.hash${i}/index.js`, packaging: 'zip' as const },
          destinations: { current: { bucketName: 'bucket', objectKey: `key${i}` } },
        };
      }
      const manifest = makeManifest({ files });

      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(manifest));

      await expect(
        publisher.publishFromManifest('/tmp/cdk.out/manifest.json', {
          accountId: '123456789012',
          region: 'us-east-1',
          assetPublishConcurrency: 2,
        })
      ).rejects.toThrow(/2 node\(s\) failed/);
    });
  });
});
