import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEcrSend, mockEcrDestroy, mockExecFile } = vi.hoisted(() => ({
  mockEcrSend: vi.fn(),
  mockEcrDestroy: vi.fn(),
  mockExecFile: vi.fn(),
}));

// Mock @aws-sdk/client-ecr
vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: vi.fn().mockImplementation(() => ({
    send: mockEcrSend,
    destroy: mockEcrDestroy,
  })),
  GetAuthorizationTokenCommand: vi.fn().mockImplementation((input) => ({
    ...input,
    _type: 'GetAuthorizationToken',
  })),
  DescribeImagesCommand: vi.fn().mockImplementation((input) => ({
    ...input,
    _type: 'DescribeImages',
  })),
}));

// Mock node:child_process
vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

// Mock node:util
vi.mock('node:util', () => ({
  promisify: () => mockExecFile,
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

import { DescribeImagesCommand } from '@aws-sdk/client-ecr';
import { DockerAssetPublisher } from '../../../src/assets/docker-asset-publisher.js';
import { AssetError } from '../../../src/utils/error-handler.js';
import type { DockerImageAsset } from '../../../src/types/assets.js';

describe('DockerAssetPublisher', () => {
  let publisher: DockerAssetPublisher;

  const makeDockerAsset = (overrides: Partial<DockerImageAsset> = {}): DockerImageAsset => ({
    displayName: 'TestDockerAsset',
    source: {
      directory: 'asset.docker123',
    },
    destinations: {
      'current-account': {
        repositoryName: 'cdk-assets-${AWS::AccountId}-${AWS::Region}',
        imageTag: 'abc123',
      },
    },
    ...overrides,
  });

  const authToken = Buffer.from('AWS:mock-password').toString('base64');

  beforeEach(() => {
    vi.clearAllMocks();
    publisher = new DockerAssetPublisher();
    // Default: execFile succeeds
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('should build and push Docker image to ECR', async () => {
    // DescribeImages -> image not found
    mockEcrSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'DescribeImages') {
        const err = new Error('Image not found') as Error & { name: string };
        err.name = 'ImageNotFoundException';
        throw err;
      }
      if (cmd._type === 'GetAuthorizationToken') {
        return {
          authorizationData: [{
            authorizationToken: authToken,
            proxyEndpoint: 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com',
          }],
        };
      }
      return {};
    });

    await publisher.publish(
      'docker123',
      makeDockerAsset(),
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1'
    );

    // Verify docker build was called
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      ['build', '-t', 'cdkd-asset-docker123', '/tmp/cdk.out/asset.docker123'],
      expect.objectContaining({ maxBuffer: 50 * 1024 * 1024 })
    );

    // Verify docker login was called
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      ['login', '--username', 'AWS', '--password-stdin', 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com'],
      expect.objectContaining({ input: 'mock-password' })
    );

    // Verify docker tag was called
    const fullUri = '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdk-assets-123456789012-us-east-1:abc123';
    expect(mockExecFile).toHaveBeenCalledWith('docker', ['tag', 'cdkd-asset-docker123', fullUri]);

    // Verify docker push was called
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      ['push', fullUri],
      expect.objectContaining({ maxBuffer: 50 * 1024 * 1024 })
    );

    expect(mockEcrDestroy).toHaveBeenCalled();
  });

  it('should skip if image already exists', async () => {
    mockEcrSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'DescribeImages') {
        return { imageDetails: [{ imageDigest: 'sha256:abc' }] };
      }
      return {};
    });

    await publisher.publish(
      'docker123',
      makeDockerAsset(),
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1'
    );

    expect(DescribeImagesCommand).toHaveBeenCalledWith({
      repositoryName: 'cdk-assets-123456789012-us-east-1',
      imageIds: [{ imageTag: 'abc123' }],
    });

    // docker build should NOT have been called
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('should handle docker build with args, target, and dockerfile', async () => {
    mockEcrSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'DescribeImages') {
        const err = new Error('Image not found') as Error & { name: string };
        err.name = 'ImageNotFoundException';
        throw err;
      }
      if (cmd._type === 'GetAuthorizationToken') {
        return {
          authorizationData: [{
            authorizationToken: authToken,
            proxyEndpoint: 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com',
          }],
        };
      }
      return {};
    });

    const asset = makeDockerAsset({
      source: {
        directory: 'asset.custom',
        dockerFile: 'Dockerfile.custom',
        dockerBuildArgs: { NODE_VERSION: '20', ENV: 'prod' },
        dockerBuildTarget: 'production',
      },
    });

    await publisher.publish(
      'custom123',
      asset,
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1'
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      [
        'build', '-t', 'cdkd-asset-custom123',
        '-f', 'Dockerfile.custom',
        '--build-arg', 'NODE_VERSION=20',
        '--build-arg', 'ENV=prod',
        '--target', 'production',
        '/tmp/cdk.out/asset.custom',
      ],
      expect.objectContaining({ maxBuffer: 50 * 1024 * 1024 })
    );
  });

  it('should authenticate with ECR before push', async () => {
    const callOrder: string[] = [];

    mockEcrSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'DescribeImages') {
        const err = new Error('Image not found') as Error & { name: string };
        err.name = 'ImageNotFoundException';
        throw err;
      }
      if (cmd._type === 'GetAuthorizationToken') {
        callOrder.push('getAuthToken');
        return {
          authorizationData: [{
            authorizationToken: authToken,
            proxyEndpoint: 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com',
          }],
        };
      }
      return {};
    });

    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'build') callOrder.push('build');
      if (args[0] === 'login') callOrder.push('login');
      if (args[0] === 'tag') callOrder.push('tag');
      if (args[0] === 'push') callOrder.push('push');
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await publisher.publish(
      'docker123',
      makeDockerAsset(),
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1'
    );

    // Build first, then auth, then tag+push
    expect(callOrder).toEqual(['build', 'getAuthToken', 'login', 'tag', 'push']);
  });

  it('should resolve placeholders in repository name and tag', async () => {
    mockEcrSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'DescribeImages') {
        return { imageDetails: [{ imageDigest: 'sha256:exists' }] };
      }
      return {};
    });

    const asset = makeDockerAsset({
      destinations: {
        dest1: {
          repositoryName: 'repo-${AWS::AccountId}',
          imageTag: '${AWS::Region}-latest',
          region: '${AWS::Region}',
        },
      },
    });

    await publisher.publish(
      'hash1',
      asset,
      '/tmp/cdk.out',
      '999888777666',
      'eu-west-1'
    );

    expect(DescribeImagesCommand).toHaveBeenCalledWith({
      repositoryName: 'repo-999888777666',
      imageIds: [{ imageTag: 'eu-west-1-latest' }],
    });
  });

  it('should throw AssetError on docker build failure', async () => {
    mockEcrSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'DescribeImages') {
        const err = new Error('Image not found') as Error & { name: string };
        err.name = 'ImageNotFoundException';
        throw err;
      }
      return {};
    });

    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'build') {
        const err = new Error('build failed') as Error & { stderr: string };
        err.stderr = 'ERROR: failed to solve';
        return Promise.reject(err);
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(
      publisher.publish(
        'docker123',
        makeDockerAsset(),
        '/tmp/cdk.out',
        '123456789012',
        'us-east-1'
      )
    ).rejects.toThrow(AssetError);

    await expect(
      publisher.publish(
        'docker123',
        makeDockerAsset(),
        '/tmp/cdk.out',
        '123456789012',
        'us-east-1'
      )
    ).rejects.toThrow('Docker build failed: ERROR: failed to solve');
  });
});
