import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Mock the docker-cmd helpers used by buildDockerImage / isImageInLocalCache.
// `vi.mock` is hoisted ABOVE top-level `const`s, so the stub functions must
// be created via `vi.hoisted(...)` (the canonical vi.mock-factory-hoisting
// workaround).
const {
  mockRunDocker,
  mockSpawnStreaming,
  // Per-call selective failure on `runDockerStreaming` for the
  // `image inspect` (cache miss) flow.
  failureMatch,
} = vi.hoisted(() => ({
  mockRunDocker: vi.fn(),
  mockSpawnStreaming: vi.fn(),
  failureMatch: { match: undefined as ((args: string[]) => boolean) | undefined },
}));

vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return {
    ...actual,
    // The wrapper records every call AND honors per-test queue results
    // via `mockRunDocker.mockResolvedValueOnce` / `mockRejectedValueOnce`.
    // The `failureMatch` predicate is the per-args targeted failure path
    // for the `--no-build` cache-miss test (matches the args, fails only
    // for `image inspect`).
    runDockerStreaming: (args: string[], opts?: unknown) => {
      if (failureMatch.match && failureMatch.match(args)) {
        return Promise.reject(Object.assign(new Error('cache miss'), { stderr: 'No such image' }));
      }
      return mockRunDocker(args, opts);
    },
    spawnStreaming: mockSpawnStreaming,
  };
});

import {
  architectureToPlatform,
  buildContainerImage,
} from '../../../src/local/docker-image-builder.js';
import { LocalInvokeBuildError } from '../../../src/utils/error-handler.js';

beforeEach(() => {
  mockRunDocker.mockReset();
  mockRunDocker.mockResolvedValue({ stdout: '', stderr: '' });
  mockSpawnStreaming.mockReset();
  // Default: executable-mode `spawnStreaming` returns a tag matching the
  // executable's command so the re-tag branch sees `actualTag !== tag`
  // and computeLocalTag's executable-field branch is reachable. Tests
  // that need a specific stdout override per-call via mockResolvedValueOnce.
  mockSpawnStreaming.mockResolvedValue({ stdout: 'executable-output-tag\n', stderr: '' });
  failureMatch.match = undefined;
});

describe('architectureToPlatform', () => {
  it('maps x86_64 to linux/amd64', () => {
    expect(architectureToPlatform('x86_64')).toBe('linux/amd64');
  });
  it('maps arm64 to linux/arm64', () => {
    expect(architectureToPlatform('arm64')).toBe('linux/arm64');
  });
});

describe('buildContainerImage', () => {
  it('emits docker build with --platform from architecture (x86_64 → linux/amd64)', async () => {
    const tag = await buildContainerImage(
      { source: { directory: 'asset.x86' } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    expect(tag).toMatch(/^cdkd-local-invoke-/);
    // The first runDocker call is the `docker build` invocation.
    const args = mockRunDocker.mock.calls[0]![0] as string[];
    expect(args[0]).toBe('build');
    expect(args).toContain('--platform');
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/amd64');
  });

  it('emits docker build with --platform linux/arm64 for arm64', async () => {
    await buildContainerImage(
      { source: { directory: 'asset.arm' } },
      '/cdk.out',
      { architecture: 'arm64' }
    );
    const args = mockRunDocker.mock.calls[0]![0] as string[];
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/arm64');
  });

  it('sets BUILDX_NO_DEFAULT_ATTESTATIONS=1 in the build env (CDK CLI parity)', async () => {
    await buildContainerImage(
      { source: { directory: 'asset.attest' } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    const buildOpts = mockRunDocker.mock.calls[0]![1] as { env?: Record<string, string> };
    expect(buildOpts.env?.['BUILDX_NO_DEFAULT_ATTESTATIONS']).toBe('1');
  });

  it('returns a stable tag for the same source (cache reproducibility)', async () => {
    const a = await buildContainerImage(
      { source: { directory: 'asset.same' } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    const b = await buildContainerImage(
      { source: { directory: 'asset.same' } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    expect(a).toBe(b);
  });

  it('returns different tags for different build args', async () => {
    const a = await buildContainerImage(
      { source: { directory: 'asset.x', dockerBuildArgs: { FOO: 'bar' } } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    const b = await buildContainerImage(
      { source: { directory: 'asset.x', dockerBuildArgs: { FOO: 'baz' } } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    expect(a).not.toBe(b);
  });

  it('per-field fingerprint coverage: every documented source field individually busts the cache', async () => {
    // Catches a regression where a future refactor drops a `pushField` /
    // `pushMap` line from `computeLocalTag`. Walks every field of
    // `DockerImageAssetSource` and asserts the tag differs from a baseline.
    const baseline = await buildContainerImage(
      { source: { directory: 'asset.base' } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    const variants: Array<{ name: string; src: object }> = [
      { name: 'directory', src: { directory: 'asset.different' } },
      { name: 'executable', src: { directory: 'asset.base', executable: ['./build.sh'] } },
      { name: 'dockerFile', src: { directory: 'asset.base', dockerFile: 'Other.Dockerfile' } },
      {
        name: 'dockerBuildTarget',
        src: { directory: 'asset.base', dockerBuildTarget: 'prod' },
      },
      { name: 'networkMode', src: { directory: 'asset.base', networkMode: 'host' } },
      { name: 'platform', src: { directory: 'asset.base', platform: 'linux/amd64' } },
      { name: 'dockerBuildSsh', src: { directory: 'asset.base', dockerBuildSsh: 'default' } },
      {
        name: 'dockerBuildArgs',
        src: { directory: 'asset.base', dockerBuildArgs: { K: 'V' } },
      },
      {
        name: 'dockerBuildContexts',
        src: { directory: 'asset.base', dockerBuildContexts: { src: '../src' } },
      },
      {
        name: 'dockerBuildSecrets',
        src: { directory: 'asset.base', dockerBuildSecrets: { id: 'src=x' } },
      },
      {
        name: 'dockerOutputs',
        src: { directory: 'asset.base', dockerOutputs: ['type=docker'] },
      },
      {
        name: 'cacheFrom',
        src: { directory: 'asset.base', cacheFrom: [{ type: 'registry' }] },
      },
      { name: 'cacheTo', src: { directory: 'asset.base', cacheTo: { type: 'inline' } } },
      { name: 'cacheDisabled', src: { directory: 'asset.base', cacheDisabled: true } },
    ];
    const tagsByField = new Map<string, string>();
    for (const v of variants) {
      const tag = await buildContainerImage({ source: v.src }, '/cdk.out', {
        architecture: 'x86_64',
      });
      tagsByField.set(v.name, tag);
      expect(tag, `${v.name} change should produce a tag different from baseline`).not.toBe(
        baseline
      );
    }
    // Every variant produces a UNIQUE tag (no two fields collide on the same digest).
    const uniqueTags = new Set([baseline, ...tagsByField.values()]);
    expect(uniqueTags.size).toBe(variants.length + 1);
  });

  it('returns different tags for different BuildKit fields (secrets / contexts / cache)', async () => {
    const base = await buildContainerImage(
      { source: { directory: 'asset.x' } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    const withSecret = await buildContainerImage(
      { source: { directory: 'asset.x', dockerBuildSecrets: { npmrc: 'src=./.npmrc' } } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    const withContext = await buildContainerImage(
      { source: { directory: 'asset.x', dockerBuildContexts: { sources: '../sources' } } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    const noCache = await buildContainerImage(
      { source: { directory: 'asset.x', cacheDisabled: true } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    // Each variant must bust the cache key so a Dockerfile change to one
    // of these fields gets rebuilt.
    expect(new Set([base, withSecret, withContext, noCache]).size).toBe(4);
  });

  it('wraps docker build failures in LocalInvokeBuildError', async () => {
    mockRunDocker.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('failed'), { stderr: 'Dockerfile syntax error' }))
    );
    await expect(
      buildContainerImage(
        { source: { directory: 'asset.bad' } },
        '/cdk.out',
        { architecture: 'x86_64' }
      )
    ).rejects.toBeInstanceOf(LocalInvokeBuildError);
  });

  describe('noBuild=true (--no-build)', () => {
    it('skips docker build and returns the cached tag (happy path)', async () => {
      const tag = await buildContainerImage(
        { source: { directory: 'asset.cached' } },
        '/cdk.out',
        { architecture: 'x86_64', noBuild: true }
      );
      expect(tag).toMatch(/^cdkd-local-invoke-/);
      // Exactly one runDocker call: `image inspect <tag>`. NO `build`.
      expect(mockRunDocker).toHaveBeenCalledTimes(1);
      const args = mockRunDocker.mock.calls[0]![0] as string[];
      expect(args).toEqual(['image', 'inspect', tag]);
    });

    it('errors clearly when the cached tag is missing', async () => {
      failureMatch.match = (args) => args[0] === 'image' && args[1] === 'inspect';
      await expect(
        buildContainerImage(
          { source: { directory: 'asset.missing' } },
          '/cdk.out',
          { architecture: 'x86_64', noBuild: true }
        )
      ).rejects.toThrow(/not in local registry.*--no-build is set/);
    });

    it('reuses the same tag noBuild produces as a no-noBuild build', async () => {
      const built = await buildContainerImage(
        { source: { directory: 'asset.match' } },
        '/cdk.out',
        { architecture: 'x86_64' }
      );
      const verified = await buildContainerImage(
        { source: { directory: 'asset.match' } },
        '/cdk.out',
        { architecture: 'x86_64', noBuild: true }
      );
      expect(built).toBe(verified);
    });
  });
});
