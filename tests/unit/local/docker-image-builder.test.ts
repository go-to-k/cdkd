import { describe, expect, it, vi } from 'vitest';

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
});
