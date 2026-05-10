import { describe, expect, it, vi } from 'vitest';

// Capture every execFile invocation + let individual tests opt into a
// failing-cb mode. The top-level closure variable is read INSIDE the
// vi.mock factory so each `it()` can flip the flag before calling the
// helper-under-test.
const mockExecFile = vi.fn();
let mockExecFileFailure: { stderr?: string; message?: string } | undefined;
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (cmd: string, args: string[], opts: unknown, cb: (err: unknown) => void) => {
      mockExecFile(cmd, args, opts);
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

import { buildDockerImage } from '../../../src/assets/docker-build.js';
import type { DockerImageAssetSource } from '../../../src/types/assets.js';

const baseSource: DockerImageAssetSource = {
  directory: 'asset.abc123',
};

const wrapError = (stderr: string): Error => new Error(`wrapped: ${stderr}`);

describe('buildDockerImage', () => {
  it('emits docker build with -t <tag> and the context dir', async () => {
    mockExecFile.mockClear();
    await buildDockerImage(
      { source: baseSource },
      '/cdk.out',
      'cdkd-asset-tag',
      { wrapError }
    );
    expect(mockExecFile).toHaveBeenCalledOnce();
    const args = mockExecFile.mock.calls[0]![1];
    expect(args[0]).toBe('build');
    expect(args).toContain('-t');
    expect(args).toContain('cdkd-asset-tag');
    expect(args[args.length - 1]).toBe('/cdk.out/asset.abc123');
  });

  it('threads --platform when provided', async () => {
    mockExecFile.mockClear();
    await buildDockerImage(
      { source: baseSource },
      '/cdk.out',
      'tag',
      { platform: 'linux/arm64', wrapError }
    );
    const args = mockExecFile.mock.calls[0]![1];
    expect(args).toContain('--platform');
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/arm64');
  });

  it('omits --platform when not provided (host default arch)', async () => {
    mockExecFile.mockClear();
    await buildDockerImage({ source: baseSource }, '/cdk.out', 'tag', { wrapError });
    const args = mockExecFile.mock.calls[0]![1];
    expect(args).not.toContain('--platform');
  });

  it('passes -f, build args, target, outputs', async () => {
    mockExecFile.mockClear();
    await buildDockerImage(
      {
        source: {
          directory: 'asset.x',
          dockerFile: 'Custom.Dockerfile',
          dockerBuildArgs: { FOO: 'bar', BAZ: 'qux' },
          dockerBuildTarget: 'runtime',
          dockerOutputs: ['type=docker'],
        },
      },
      '/cdk.out',
      'tag',
      { wrapError }
    );
    const args = mockExecFile.mock.calls[0]![1];
    expect(args).toContain('-f');
    expect(args[args.indexOf('-f') + 1]).toBe('Custom.Dockerfile');
    expect(args).toContain('--build-arg');
    expect(args).toContain('FOO=bar');
    expect(args).toContain('BAZ=qux');
    expect(args).toContain('--target');
    expect(args[args.indexOf('--target') + 1]).toBe('runtime');
    expect(args).toContain('--output');
  });

  it('preserves Object.entries order for build args (cache stability)', async () => {
    mockExecFile.mockClear();
    await buildDockerImage(
      {
        source: {
          directory: 'asset.x',
          dockerBuildArgs: { Z: '1', A: '2', M: '3' },
        },
      },
      '/cdk.out',
      'tag',
      { wrapError }
    );
    const args = mockExecFile.mock.calls[0]![1];
    // Insertion order is preserved by Object.entries — the build args
    // appear in Z / A / M order, NOT alphabetic.
    const buildArgValues: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--build-arg') buildArgValues.push(args[i + 1] as string);
    }
    expect(buildArgValues).toEqual(['Z=1', 'A=2', 'M=3']);
  });
});

describe('buildDockerImage error wrapping', () => {
  it('wraps stderr via the caller-supplied wrapError when execFile fails', async () => {
    mockExecFile.mockClear();
    mockExecFileFailure = { stderr: 'BOOM', message: 'docker build exited 1' };
    await expect(
      buildDockerImage({ source: { directory: 'x' } }, '/cdk.out', 'tag', {
        wrapError: (stderr) => new Error(`wrapped: ${stderr}`),
      })
    ).rejects.toThrow(/wrapped: BOOM/);
  });

  it('falls through to err.message when stderr is missing', async () => {
    mockExecFile.mockClear();
    mockExecFileFailure = { message: 'docker daemon not reachable' };
    await expect(
      buildDockerImage({ source: { directory: 'x' } }, '/cdk.out', 'tag', {
        wrapError: (stderr) => new Error(`wrapped: ${stderr}`),
      })
    ).rejects.toThrow(/wrapped: docker daemon not reachable/);
  });
});
