import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockEcrSend, mockEcrDestroy, mockRunDocker } = vi.hoisted(() => ({
  mockEcrSend: vi.fn(),
  mockEcrDestroy: vi.fn(),
  // One mock for the whole docker surface — the publisher now routes ALL
  // docker subprocess calls (build / login / tag / push) through
  // `runDockerStreaming`, so a single capture is sufficient.
  mockRunDocker: vi.fn(),
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

// Mock the docker-cmd helpers used by buildDockerImage AND the publisher's
// login / tag / push paths.
vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return {
    ...actual,
    runDockerStreaming: mockRunDocker,
  };
});

// Mock logger (the docker-cmd helper consults `getLogger().getLevel()` for
// live-streaming, so we need a `getLevel` method on the mock).
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getLevel: () => 'info',
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      getLevel: () => 'info',
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
    mockEcrSend.mockReset();
    mockEcrDestroy.mockReset();
    mockRunDocker.mockReset();
    mockRunDocker.mockResolvedValue({ stdout: '', stderr: '' });
    publisher = new DockerAssetPublisher();
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

    // Verify docker build was called (with BUILDX_NO_DEFAULT_ATTESTATIONS=1).
    const buildCall = mockRunDocker.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === 'build'
    );
    expect(buildCall).toBeDefined();
    const [buildArgs, buildOpts] = buildCall as [string[], { env?: Record<string, string> }];
    expect(buildArgs).toEqual(['build', '-t', 'cdkd-asset-docker123', '.']);
    expect(buildOpts.env?.['BUILDX_NO_DEFAULT_ATTESTATIONS']).toBe('1');
    // cwd is set to the asset directory so relative paths in BuildKit
    // flags (--secret src=foo.txt, --build-context name=./path) resolve.
    expect((buildCall![1] as { cwd?: string }).cwd).toBe('/tmp/cdk.out/asset.docker123');

    // Verify docker login was called via runDockerStreaming (input carries password).
    const loginCall = mockRunDocker.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === 'login'
    );
    expect(loginCall).toBeDefined();
    expect(loginCall![0]).toEqual([
      'login',
      '--username',
      'AWS',
      '--password-stdin',
      'https://123456789012.dkr.ecr.us-east-1.amazonaws.com',
    ]);
    expect((loginCall![1] as { input?: string }).input).toBe('mock-password');

    // Verify docker tag was called
    const fullUri = '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdk-assets-123456789012-us-east-1:abc123';
    const tagCall = mockRunDocker.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === 'tag'
    );
    expect(tagCall?.[0]).toEqual(['tag', 'cdkd-asset-docker123', fullUri]);

    // Verify docker push was called
    const pushCall = mockRunDocker.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === 'push'
    );
    expect(pushCall?.[0]).toEqual(['push', fullUri]);

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

    // docker subprocess should NOT have been called
    expect(mockRunDocker).not.toHaveBeenCalled();
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

    const buildCall = mockRunDocker.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === 'build'
    );
    expect(buildCall![0]).toEqual([
      'build', '-t', 'cdkd-asset-custom123',
      '--build-arg', 'NODE_VERSION=20',
      '--build-arg', 'ENV=prod',
      '--target', 'production',
      '-f', 'Dockerfile.custom',
      '.',
    ]);
    expect((buildCall![1] as { cwd?: string }).cwd).toBe('/tmp/cdk.out/asset.custom');
  });

  it('forwards BuildKit fields (--build-context, --secret, --ssh, --cache-from/to, --no-cache, --network, --platform)', async () => {
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
        directory: 'asset.bk',
        dockerBuildContexts: { sources: '../sources' },
        dockerBuildSecrets: { npmrc: 'src=./.npmrc' },
        dockerBuildSsh: 'default',
        networkMode: 'host',
        platform: 'linux/arm64',
        cacheFrom: [{ type: 'registry', params: { ref: 'example.com/c:l' } }],
        cacheTo: { type: 'inline' },
        cacheDisabled: true,
      },
    });

    await publisher.publish(
      'bk123',
      asset,
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1'
    );

    const buildCall = mockRunDocker.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === 'build'
    );
    const args = buildCall![0] as string[];
    expect(args).toContain('--build-context');
    expect(args).toContain('sources=../sources');
    expect(args).toContain('--secret');
    expect(args).toContain('id=npmrc,src=./.npmrc');
    expect(args[args.indexOf('--ssh') + 1]).toBe('default');
    expect(args[args.indexOf('--network') + 1]).toBe('host');
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/arm64');
    expect(args[args.indexOf('--cache-from') + 1]).toBe('type=registry,ref=example.com/c:l');
    expect(args[args.indexOf('--cache-to') + 1]).toBe('type=inline');
    expect(args).toContain('--no-cache');
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

    mockRunDocker.mockImplementation((args: string[]) => {
      callOrder.push(args[0]!);
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await publisher.publish(
      'docker123',
      makeDockerAsset(),
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1'
    );

    // Build first, then auth, then login, then tag+push
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

    mockRunDocker.mockImplementation((args: string[]) => {
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
