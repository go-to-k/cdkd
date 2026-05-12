import { describe, expect, it, vi } from 'vite-plus/test';

const mockExecFile = vi.fn();
let mockExecFileFailure: { stderr?: string; message?: string } | undefined;
// Per-call selective failure: when the executed command's argv array
// matches the predicate, swap the success result for a failure on that
// invocation only. Used by the --no-build tests to fail
// `docker image inspect` (cache miss) while letting other docker
// commands succeed.
let mockExecFileFailureMatch:
  | { match: (args: string[]) => boolean; err: { stderr?: string; message?: string } }
  | undefined;
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    // Two callsites to handle: (a) `buildDockerImage` invokes
    // `execFile(cmd, args, opts, cb)` (4-arg form); (b) `isImageInLocalCache`
    // invokes `promisify(execFile)('docker', [...])` which adapts to the
    // 3-arg form `execFile(cmd, args, cb)`. Distinguish on the type of
    // the third positional.
    execFile: (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: (err: unknown) => void) => {
      const cb =
        typeof optsOrCb === 'function' ? (optsOrCb as (err: unknown) => void) : maybeCb!;
      const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb;
      mockExecFile(cmd, args, opts);
      if (mockExecFileFailureMatch && mockExecFileFailureMatch.match(args)) {
        const err = mockExecFileFailureMatch.err;
        cb(err);
        return;
      }
      if (mockExecFileFailure) {
        const err = mockExecFileFailure;
        mockExecFileFailure = undefined;
        cb(err);
        return;
      }
      cb(null);
    },
  };
});

import {
  architectureToPlatform,
  buildContainerImage,
} from '../../../src/local/docker-image-builder.js';
import { LocalInvokeBuildError } from '../../../src/utils/error-handler.js';

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
    mockExecFile.mockClear();
    const tag = await buildContainerImage(
      { source: { directory: 'asset.x86' } },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    expect(tag).toMatch(/^cdkd-local-invoke-/);
    const args = mockExecFile.mock.calls[0]![1];
    expect(args).toContain('--platform');
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/amd64');
  });

  it('emits docker build with --platform linux/arm64 for arm64', async () => {
    mockExecFile.mockClear();
    await buildContainerImage(
      { source: { directory: 'asset.arm' } },
      '/cdk.out',
      { architecture: 'arm64' }
    );
    const args = mockExecFile.mock.calls[0]![1];
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/arm64');
  });

  it('returns a stable tag for the same source (cache reproducibility)', async () => {
    mockExecFile.mockClear();
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
    mockExecFile.mockClear();
    const a = await buildContainerImage(
      {
        source: {
          directory: 'asset.x',
          dockerBuildArgs: { FOO: 'bar' },
        },
      },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    const b = await buildContainerImage(
      {
        source: {
          directory: 'asset.x',
          dockerBuildArgs: { FOO: 'baz' },
        },
      },
      '/cdk.out',
      { architecture: 'x86_64' }
    );
    expect(a).not.toBe(b);
  });

  it('wraps docker build failures in LocalInvokeBuildError', async () => {
    mockExecFile.mockClear();
    mockExecFileFailure = { stderr: 'Dockerfile syntax error' };
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
      mockExecFile.mockClear();
      mockExecFileFailureMatch = undefined;

      const tag = await buildContainerImage(
        { source: { directory: 'asset.cached' } },
        '/cdk.out',
        { architecture: 'x86_64', noBuild: true }
      );

      // Tag is returned (deterministic, derived from the source).
      expect(tag).toMatch(/^cdkd-local-invoke-/);
      // Exactly one docker call: `docker image inspect <tag>`. NO `docker
      // build` invocation.
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      const calledArgs = mockExecFile.mock.calls[0]![1];
      expect(calledArgs).toEqual(['image', 'inspect', tag]);
      expect(calledArgs).not.toContain('build');
    });

    it('errors clearly when the cached tag is missing', async () => {
      mockExecFile.mockClear();
      // Make `docker image inspect` fail on the very next call (cache miss).
      mockExecFileFailureMatch = {
        match: (args) => args[0] === 'image' && args[1] === 'inspect',
        err: { stderr: 'Error: No such image' },
      };

      await expect(
        buildContainerImage(
          { source: { directory: 'asset.missing' } },
          '/cdk.out',
          { architecture: 'x86_64', noBuild: true }
        )
      ).rejects.toThrow(/not in local registry.*--no-build is set/);
      mockExecFileFailureMatch = undefined;
    });

    it('reuses the same tag noBuild produces as a no-noBuild build', async () => {
      // Tag stability: --no-build's verifier and the actual build path
      // must agree on the deterministic tag (otherwise the user's prior
      // `cdkd local invoke` build would not be reachable from --no-build).
      mockExecFile.mockClear();
      mockExecFileFailureMatch = undefined;

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
