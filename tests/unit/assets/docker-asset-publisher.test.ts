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
import { DockerAssetPublisher, isDockerAuthFailure } from '../../../src/assets/docker-asset-publisher.js';
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

  // Wire the ECR client so DescribeImages reports "not found" (build + push
  // path runs) and GetAuthorizationToken returns a valid token.
  const wireEcrMocks = (proxyEndpoint?: string) => {
    mockEcrSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'DescribeImages') {
        const err = new Error('Image not found') as Error & { name: string };
        err.name = 'ImageNotFoundException';
        throw err;
      }
      if (cmd._type === 'GetAuthorizationToken') {
        return {
          authorizationData: [
            {
              authorizationToken: authToken,
              ...(proxyEndpoint ? { proxyEndpoint } : {}),
            },
          ],
        };
      }
      return {};
    });
  };

  // A `docker push` reject shaped like an ECR auth failure.
  const authFailurePush = (stderr = 'no basic auth credentials') => (args: string[]) => {
    if (args[0] === 'push') {
      const err = new Error('push failed') as Error & { stderr: string };
      err.stderr = stderr;
      return Promise.reject(err);
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };

  const countAuthTokenCalls = () =>
    mockEcrSend.mock.calls.filter(
      ([cmd]) => (cmd as { _type?: string })?._type === 'GetAuthorizationToken'
    ).length;

  const countLoginExecs = () =>
    mockRunDocker.mock.calls.filter(([args]) => Array.isArray(args) && args[0] === 'login').length;

  // The `docker login` endpoint of every login, in order (the last argv item).
  const loginEndpoints = () =>
    mockRunDocker.mock.calls
      .map(([args]) => args as string[])
      .filter((args) => Array.isArray(args) && args[0] === 'login')
      .map((args) => args[args.length - 1]);

  const countPushExecs = () =>
    mockRunDocker.mock.calls.filter(([args]) => Array.isArray(args) && args[0] === 'push').length;

  beforeEach(() => {
    mockEcrSend.mockReset();
    mockEcrDestroy.mockReset();
    mockRunDocker.mockReset();
    mockRunDocker.mockResolvedValue({ stdout: '', stderr: '' });
    publisher = new DockerAssetPublisher();
  });

  it('should build and push Docker image to ECR (no login when the push succeeds)', async () => {
    wireEcrMocks('https://123456789012.dkr.ecr.us-east-1.amazonaws.com');

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
    expect(buildArgs).toEqual(['build', '--tag', 'cdkd-asset-docker123', '.']);
    expect(buildOpts.env?.['BUILDX_NO_DEFAULT_ATTESTATIONS']).toBe('1');
    // cwd is set to the asset directory so relative paths in BuildKit
    // flags (--secret src=foo.txt, --build-context name=./path) resolve.
    expect((buildCall![1] as { cwd?: string }).cwd).toBe('/tmp/cdk.out/asset.docker123');

    // Lazy login: with a successful push there is NO docker login and NO
    // GetAuthorizationToken call (inv 3 — the ~3.3s saving on a valid cred).
    expect(countLoginExecs()).toBe(0);
    expect(countAuthTokenCalls()).toBe(0);

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
    wireEcrMocks('https://123456789012.dkr.ecr.us-east-1.amazonaws.com');

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
      'build', '--tag', 'cdkd-asset-custom123',
      '--build-arg', 'NODE_VERSION=20',
      '--build-arg', 'ENV=prod',
      '--target', 'production',
      '--file', 'Dockerfile.custom',
      '.',
    ]);
    expect((buildCall![1] as { cwd?: string }).cwd).toBe('/tmp/cdk.out/asset.custom');
  });

  it('forwards BuildKit fields (--build-context, --secret, --ssh, --cache-from/to, --no-cache, --network, --platform)', async () => {
    wireEcrMocks('https://123456789012.dkr.ecr.us-east-1.amazonaws.com');

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

  describe('isDockerAuthFailure', () => {
    it('matches the ECR auth-failure signatures (case-insensitive)', () => {
      for (const s of [
        'no basic auth credentials',
        'NO BASIC AUTH CREDENTIALS',
        'unauthorized: authentication required',
        'authentication required',
        'denied: requested access to the resource is denied',
        'received unexpected HTTP status: 401 Unauthorized',
        'received unexpected HTTP status: 403 Forbidden',
      ]) {
        expect(isDockerAuthFailure(s)).toBe(true);
      }
    });

    it('does NOT match non-auth failures', () => {
      for (const s of [
        'net/http: TLS handshake timeout',
        'name unknown: The repository does not exist',
        'connection refused',
        'manifest blob unknown',
        '',
      ]) {
        expect(isDockerAuthFailure(s)).toBe(false);
      }
    });
  });

  describe('composed docker failure texts (issue #2623)', () => {
    // The login / tag / push catches were rewritten from a hand-composed
    // `e.stderr?.trim() || e.message || String(err)` to
    // `describeDockerFailure(err, args)`. Two things are behaviour, not
    // wording: the push text FEEDS `isDockerAuthFailure`, which decides
    // whether cdkd logs in and retries at all, and the argv these calls carry
    // must reach the redactor so a future value-bearing flag cannot leak.
    it('a push failure still classifies as an auth failure through the composer', async () => {
      wireEcrMocks();
      mockRunDocker.mockImplementation((args: string[]) => {
        if (args[0] === 'push') {
          const err = new Error('push failed') as Error & { stderr: string };
          // Whitespace-padded on purpose: the composer trims, the old
          // hand-composed push site trimmed, and the old LOGIN site did not.
          err.stderr = '  denied: requested access to the resource is denied\n';
          return Promise.reject(err);
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      await expect(
        publisher.publish('h1', makeDockerAsset(), '/tmp/cdk.out', '123456789012', 'us-east-1')
      ).rejects.toThrow(AssetError);

      // The retry fired, which is what the classification decides — a
      // composition that stopped matching would silently skip the login.
      expect(countAuthTokenCalls()).toBe(1);
      expect(countLoginExecs()).toBe(1);
      // And the classifier agrees with the text the composer produces.
      expect(
        isDockerAuthFailure('denied: requested access to the resource is denied')
      ).toBe(true);
    });

    it('a tag failure surfaces the docker stderr, trimmed', async () => {
      wireEcrMocks();
      mockRunDocker.mockImplementation((args: string[]) => {
        if (args[0] === 'tag') {
          const err = new Error('tag exited 1') as Error & { stderr: string };
          err.stderr = '  Error response from daemon: No such image: cdkd-asset-h1\n';
          return Promise.reject(err);
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      await expect(
        publisher.publish('h1', makeDockerAsset(), '/tmp/cdk.out', '123456789012', 'us-east-1')
      ).rejects.toThrow('Docker tag failed: Error response from daemon: No such image');
    });

    it('a login failure surfaces the docker stderr and never the password', async () => {
      wireEcrMocks('https://123456789012.dkr.ecr.us-east-1.amazonaws.com');
      mockRunDocker.mockImplementation((args: string[]) => {
        if (args[0] === 'push') {
          const err = new Error('push failed') as Error & { stderr: string };
          err.stderr = 'no basic auth credentials';
          return Promise.reject(err);
        }
        if (args[0] === 'login') {
          const err = new Error('login exited 1') as Error & { stderr: string };
          err.stderr = 'Error response from daemon: login attempt failed';
          return Promise.reject(err);
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const message = await publisher
        .publish('h1', makeDockerAsset(), '/tmp/cdk.out', '123456789012', 'us-east-1')
        .then(
          () => '',
          (e: Error) => e.message
        );
      expect(message).toContain('ECR login failed');
      expect(message).toContain('login attempt failed');
      // The password rides stdin, never argv, so the composer cannot reach it.
      expect(message).not.toContain('mock-password');
    });
  });

  describe('lazy ECR login (push-first, login-on-auth-failure)', () => {
    it('skips login entirely when the push succeeds with a valid cred (inv 3)', async () => {
      wireEcrMocks();

      await publisher.publish('h1', makeDockerAsset(), '/tmp/cdk.out', '123456789012', 'us-east-1');

      // No login, no auth-token call, exactly one successful push.
      expect(countLoginExecs()).toBe(0);
      expect(countAuthTokenCalls()).toBe(0);
      expect(countPushExecs()).toBe(1);
    });

    it('logs in and retries when there is NO pre-existing cred (inv 1)', async () => {
      wireEcrMocks('https://123456789012.dkr.ecr.us-east-1.amazonaws.com');
      // First push fails auth ("no basic auth credentials"), the post-login
      // retry succeeds.
      let pushAttempts = 0;
      mockRunDocker.mockImplementation((args: string[]) => {
        if (args[0] === 'push') {
          pushAttempts += 1;
          if (pushAttempts === 1) {
            const err = new Error('push failed') as Error & { stderr: string };
            err.stderr = 'no basic auth credentials';
            return Promise.reject(err);
          }
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      await publisher.publish('h1', makeDockerAsset(), '/tmp/cdk.out', '123456789012', 'us-east-1');

      expect(countAuthTokenCalls()).toBe(1);
      expect(countLoginExecs()).toBe(1);
      // push tried twice: the failing optimistic push + the successful retry.
      expect(countPushExecs()).toBe(2);

      // The login used the token's username/password over --password-stdin.
      const loginCall = mockRunDocker.mock.calls.find(
        ([args]) => Array.isArray(args) && args[0] === 'login'
      );
      expect(loginCall![0]).toEqual([
        'login',
        '--username',
        'AWS',
        '--password-stdin',
        'https://123456789012.dkr.ecr.us-east-1.amazonaws.com',
      ]);
      expect((loginCall![1] as { input?: string }).input).toBe('mock-password');
    });

    it('self-heals a STALE / expired cred via the `unauthorized` branch (inv 2)', async () => {
      wireEcrMocks('https://123456789012.dkr.ecr.us-east-1.amazonaws.com');
      let pushAttempts = 0;
      mockRunDocker.mockImplementation((args: string[]) => {
        if (args[0] === 'push') {
          pushAttempts += 1;
          if (pushAttempts === 1) {
            const err = new Error('push failed') as Error & { stderr: string };
            // A stale token surfaces as `unauthorized` rather than "no basic
            // auth credentials" — must take the SAME re-login branch.
            err.stderr = 'unauthorized: authentication required';
            return Promise.reject(err);
          }
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      await publisher.publish('h1', makeDockerAsset(), '/tmp/cdk.out', '123456789012', 'us-east-1');

      expect(countAuthTokenCalls()).toBe(1);
      expect(countLoginExecs()).toBe(1);
      expect(countPushExecs()).toBe(2);
    });

    it('a repeat push to the same registry after a lazy login does not log in again', async () => {
      wireEcrMocks();
      // First publish: build + tag succeed, the optimistic push fails auth ->
      // login -> retry push succeeds, and docker's credential store now holds
      // the registry. Remaining calls succeed via the default mock.
      mockRunDocker.mockImplementationOnce(() => Promise.resolve({ stdout: '', stderr: '' })); // build
      mockRunDocker.mockImplementationOnce(() => Promise.resolve({ stdout: '', stderr: '' })); // tag
      mockRunDocker.mockImplementationOnce(authFailurePush()); // push (auth fail)

      await publisher.publish('h1', makeDockerAsset(), '/tmp/cdk.out', '123456789012', 'us-east-1');
      expect(countLoginExecs()).toBe(1);

      // Second publish to the SAME registry: the push succeeds on docker's
      // stored credential, so cdkd does NOT log in again.
      const second = new DockerAssetPublisher();
      await second.push(makeDockerAsset(), '123456789012', 'us-east-1', 'local-tag');

      // Still exactly one login across BOTH publishes.
      expect(countLoginExecs()).toBe(1);
      expect(countPushExecs()).toBe(3); // fail + retry (publish 1) + direct (publish 2)
    });

    it('a DIFFERENT region logs in again, to that region\'s registry host', async () => {
      // `proxyEndpoint` is the CALLER's us-east-1 registry for both logins, as
      // AWS reports it; the eu-west-1 login must still target eu-west-1.
      wireEcrMocks('https://123456789012.dkr.ecr.us-east-1.amazonaws.com');
      // Fail the FIRST push to each of the two registries so each forces its
      // own login (attempts 1 & 3); the post-login retries (2 & 4) succeed.
      let pushCount = 0;
      mockRunDocker.mockImplementation((args: string[]) => {
        if (args[0] === 'push') {
          pushCount += 1;
          if (pushCount === 1 || pushCount === 3) {
            const err = new Error('push failed') as Error & { stderr: string };
            err.stderr = 'no basic auth credentials';
            return Promise.reject(err);
          }
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const asset = (region: string): DockerImageAsset =>
        makeDockerAsset({
          destinations: {
            d: { repositoryName: 'repo-${AWS::AccountId}', imageTag: 'tag', region },
          },
        });

      await publisher.publish('h1', asset('us-east-1'), '/tmp/cdk.out', '123456789012', 'us-east-1');
      await publisher.publish('h2', asset('eu-west-1'), '/tmp/cdk.out', '123456789012', 'us-east-1');

      // Two distinct registries -> two logins, each to its own push host.
      expect(countAuthTokenCalls()).toBe(2);
      expect(loginEndpoints()).toEqual([
        'https://123456789012.dkr.ecr.us-east-1.amazonaws.com',
        'https://123456789012.dkr.ecr.eu-west-1.amazonaws.com',
      ]);
    });

    it('a DIFFERENT account logs in again, to that account\'s registry host', async () => {
      // The caller is 111111111111, so AWS names ITS registry in `proxyEndpoint`
      // for both logins; the 222222222222 login must target 222222222222.
      wireEcrMocks('https://111111111111.dkr.ecr.us-east-1.amazonaws.com');
      let pushCount = 0;
      mockRunDocker.mockImplementation((args: string[]) => {
        if (args[0] === 'push') {
          pushCount += 1;
          if (pushCount === 1 || pushCount === 3) {
            const err = new Error('push failed') as Error & { stderr: string };
            err.stderr = 'no basic auth credentials';
            return Promise.reject(err);
          }
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const asset: DockerImageAsset = makeDockerAsset({
        destinations: {
          d: { repositoryName: 'repo-${AWS::AccountId}', imageTag: 'tag' },
        },
      });

      await publisher.publish('h1', asset, '/tmp/cdk.out', '111111111111', 'us-east-1');
      await publisher.publish('h2', asset, '/tmp/cdk.out', '222222222222', 'us-east-1');

      // Two distinct accounts -> two logins, each to its own push host.
      expect(countAuthTokenCalls()).toBe(2);
      expect(loginEndpoints()).toEqual([
        'https://111111111111.dkr.ecr.us-east-1.amazonaws.com',
        'https://222222222222.dkr.ecr.us-east-1.amazonaws.com',
      ]);
    });

    it('does NOT retry a NON-auth push failure (surfaces the AssetError)', async () => {
      wireEcrMocks();
      mockRunDocker.mockImplementation((args: string[]) => {
        if (args[0] === 'push') {
          const err = new Error('push failed') as Error & { stderr: string };
          err.stderr = 'name unknown: The repository does not exist';
          return Promise.reject(err);
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      await expect(
        publisher.publish('h1', makeDockerAsset(), '/tmp/cdk.out', '123456789012', 'us-east-1')
      ).rejects.toThrow(AssetError);

      // No login attempted, push tried exactly once.
      expect(countLoginExecs()).toBe(0);
      expect(countAuthTokenCalls()).toBe(0);
      expect(countPushExecs()).toBe(1);
    });

    it('surfaces an AssetError when the forced login DURING the retry fails', async () => {
      wireEcrMocks();
      mockRunDocker.mockImplementation((args: string[]) => {
        if (args[0] === 'push') {
          const err = new Error('push failed') as Error & { stderr: string };
          err.stderr = 'no basic auth credentials';
          return Promise.reject(err);
        }
        if (args[0] === 'login') {
          const err = new Error('login failed') as Error & { stderr: string };
          err.stderr = 'denied';
          return Promise.reject(err);
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      await expect(
        publisher.publish('h1', makeDockerAsset(), '/tmp/cdk.out', '123456789012', 'us-east-1')
      ).rejects.toThrow(AssetError);

      // The failed login is NOT cached, so a follow-up publish tries again.
      expect(countAuthTokenCalls()).toBe(1);
      expect(countLoginExecs()).toBe(1);
    });

    // Issue #3681: `GetAuthorizationToken({})`'s `proxyEndpoint` names the
    // CALLER's default registry, never the push target's, so the login must
    // ignore it and target the push host.
    it.each([
      ['another account', 'https://999999999999.dkr.ecr.us-east-1.amazonaws.com'],
      ['another region', 'https://123456789012.dkr.ecr.eu-west-1.amazonaws.com'],
      [
        'a VPC-endpoint host',
        'https://vpce-0a1b2c3d4e5f60718-abcdefgh.dkr.ecr.us-east-1.vpce.amazonaws.com',
      ],
    ])('ignores a proxyEndpoint naming %s and logs in to the push host', async (_label, proxy) => {
      wireEcrMocks(proxy);
      mockRunDocker.mockImplementationOnce(() => Promise.resolve({ stdout: '', stderr: '' })); // tag
      mockRunDocker.mockImplementationOnce(authFailurePush()); // push (auth fail)

      await publisher.push(makeDockerAsset(), '123456789012', 'us-east-1', 'local-tag');

      const pushHost = '123456789012.dkr.ecr.us-east-1.amazonaws.com';
      expect(loginEndpoints()).toEqual([`https://${pushHost}`]);
      const pushTargets = mockRunDocker.mock.calls
        .map(([args]) => args as string[])
        .filter((args) => args[0] === 'push')
        .map((args) => args[1]);
      // The retried push goes to the SAME host the login targeted.
      expect(pushTargets).toEqual([
        `${pushHost}/cdk-assets-123456789012-us-east-1:abc123`,
        `${pushHost}/cdk-assets-123456789012-us-east-1:abc123`,
      ]);
    });

    it('names the push host, not proxyEndpoint, in a login failure', async () => {
      wireEcrMocks('https://999999999999.dkr.ecr.us-east-1.amazonaws.com');
      mockRunDocker.mockImplementation((args: string[]) => {
        if (args[0] === 'push') return authFailurePush()(args);
        if (args[0] === 'login') {
          const err = new Error('login failed') as Error & { stderr: string };
          // The credential-helper branch of `formatDockerLoginError` quotes the
          // endpoint in its `docker logout <endpoint>` advice.
          err.stderr = 'Error saving credentials: already exists in the keychain';
          return Promise.reject(err);
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const message = await publisher
        .push(makeDockerAsset(), '123456789012', 'us-east-1', 'local-tag')
        .then(
          () => '',
          (e: Error) => e.message
        );

      expect(message).toContain('docker logout https://123456789012.dkr.ecr.us-east-1.amazonaws.com');
      expect(message).not.toContain('999999999999');
    });

    // The ECR password goes to the host built from the account id and the
    // manifest's destination region, so a value that would name a host AWS
    // does not own is refused before ANY AWS or docker call.
    it.each([
      ['a dotted host', 'x.example.com'],
      ['a path', 'us-east-1/x'],
      ['a port', 'x:443'],
      ['userinfo', 'a@example.com'],
      ['a query', 'x?y'],
      ['a leading hyphen', '-us-east-1'],
    ])('refuses a destination region that is %s', async (_label, region) => {
      wireEcrMocks();
      const asset = makeDockerAsset({
        destinations: { d: { repositoryName: 'repo', imageTag: 'tag', region } },
      });

      await expect(
        publisher.push(asset, '123456789012', 'us-east-1', 'local-tag')
      ).rejects.toThrow(/destination region .* is not a valid AWS region id/);
      expect(mockEcrSend).not.toHaveBeenCalled();
      expect(mockRunDocker).not.toHaveBeenCalled();
    });

    it('refuses an account id that is not 12 digits', async () => {
      wireEcrMocks();

      await expect(
        publisher.push(makeDockerAsset(), 'evil.example.com', 'us-east-1', 'local-tag')
      ).rejects.toThrow(/is not a 12-digit AWS account id/);
      expect(mockEcrSend).not.toHaveBeenCalled();
      expect(mockRunDocker).not.toHaveBeenCalled();
    });

    it('still publishes to a region cdkd has no partition entry for yet', async () => {
      wireEcrMocks('https://123456789012.dkr.ecr.nz-north-9.amazonaws.com');
      mockRunDocker.mockImplementationOnce(() => Promise.resolve({ stdout: '', stderr: '' })); // tag
      mockRunDocker.mockImplementationOnce(authFailurePush()); // push (auth fail)
      const asset = makeDockerAsset({
        destinations: { d: { repositoryName: 'repo', imageTag: 'tag', region: 'nz-north-9' } },
      });

      await publisher.push(asset, '123456789012', 'us-east-1', 'local-tag');

      expect(loginEndpoints()).toEqual(['https://123456789012.dkr.ecr.nz-north-9.amazonaws.com']);
    });

    it('push() (WorkGraph asset-publish path) uses the lazy-login path too', async () => {
      wireEcrMocks('https://123456789012.dkr.ecr.us-east-1.amazonaws.com');
      let pushAttempts = 0;
      mockRunDocker.mockImplementation((args: string[]) => {
        if (args[0] === 'push') {
          pushAttempts += 1;
          if (pushAttempts === 1) {
            const err = new Error('push failed') as Error & { stderr: string };
            err.stderr = 'no basic auth credentials';
            return Promise.reject(err);
          }
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      await publisher.push(makeDockerAsset(), '123456789012', 'us-east-1', 'local-tag');

      expect(countAuthTokenCalls()).toBe(1);
      expect(countLoginExecs()).toBe(1);
      expect(countPushExecs()).toBe(2);
    });
  });
});
