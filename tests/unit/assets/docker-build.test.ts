import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Mock the streaming spawn helpers from docker-cmd. The `vi.mock` factory
// runs at module-load time BEFORE top-level `const` declarations, so the
// stub functions must be created via `vi.hoisted(...)` (the canonical
// vi.mock-factory-hoisting workaround). Each test sets the queued result
// via `mockRunDocker.mockResolvedValue` / `mockRejectedValue` before
// invoking the helper-under-test.
const { mockRunDocker, mockSpawn } = vi.hoisted(() => ({
  mockRunDocker: vi.fn(),
  mockSpawn: vi.fn(),
}));
vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return {
    ...actual,
    runDockerStreaming: mockRunDocker,
    spawnStreaming: mockSpawn,
    getDockerCmd: actual.getDockerCmd,
  };
});

import { buildDockerImage, buildDockerBuildCommand } from '../../../src/assets/docker-build.js';
import type { DockerImageAssetSource } from '../../../src/types/assets.js';

const baseSource: DockerImageAssetSource = {
  directory: 'asset.abc123',
};

const wrapError = (stderr: string): Error => new Error(`wrapped: ${stderr}`);

beforeEach(() => {
  mockRunDocker.mockReset();
  mockSpawn.mockReset();
  mockRunDocker.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('buildDockerBuildCommand', () => {
  it('emits build -t <tag>', () => {
    const args = buildDockerBuildCommand(baseSource, 'cdkd-asset-tag');
    expect(args[0]).toBe('build');
    expect(args).toContain('-t');
    expect(args[args.indexOf('-t') + 1]).toBe('cdkd-asset-tag');
  });

  it('threads --platform when provided as override', () => {
    const args = buildDockerBuildCommand(baseSource, 'tag', 'linux/arm64');
    expect(args).toContain('--platform');
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/arm64');
  });

  it('uses source.platform when override is absent', () => {
    const args = buildDockerBuildCommand({ ...baseSource, platform: 'linux/amd64' }, 'tag');
    expect(args).toContain('--platform');
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/amd64');
  });

  it('override platform wins over source.platform', () => {
    const args = buildDockerBuildCommand(
      { ...baseSource, platform: 'linux/amd64' },
      'tag',
      'linux/arm64'
    );
    expect(args.filter((a) => a === '--platform')).toHaveLength(1);
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/arm64');
  });

  it('omits --platform when neither set', () => {
    const args = buildDockerBuildCommand(baseSource, 'tag');
    expect(args).not.toContain('--platform');
  });

  it('passes -f, build args, target, outputs (--output= single arg form)', () => {
    const args = buildDockerBuildCommand(
      {
        directory: 'asset.x',
        dockerFile: 'Custom.Dockerfile',
        dockerBuildArgs: { FOO: 'bar', BAZ: 'qux' },
        dockerBuildTarget: 'runtime',
        dockerOutputs: ['type=docker', 'type=local,dest=./out'],
      },
      'tag'
    );
    expect(args[args.indexOf('-f') + 1]).toBe('Custom.Dockerfile');
    expect(args).toContain('--build-arg');
    expect(args).toContain('FOO=bar');
    expect(args).toContain('BAZ=qux');
    expect(args[args.indexOf('--target') + 1]).toBe('runtime');
    // --output uses the single-arg `--output=<value>` form to match CDK CLI.
    expect(args).toContain('--output=type=docker');
    expect(args).toContain('--output=type=local,dest=./out');
  });

  it('preserves Object.entries order for build args (cache stability)', () => {
    const args = buildDockerBuildCommand(
      { directory: 'asset.x', dockerBuildArgs: { Z: '1', A: '2', M: '3' } },
      'tag'
    );
    const buildArgValues: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--build-arg') buildArgValues.push(args[i + 1] as string);
    }
    expect(buildArgValues).toEqual(['Z=1', 'A=2', 'M=3']);
  });

  it('emits --build-context for each entry (BuildKit 1.4+)', () => {
    const args = buildDockerBuildCommand(
      {
        directory: 'asset.x',
        dockerBuildContexts: { sources: '../sources', mod: 'oci-layout:///path' },
      },
      'tag'
    );
    expect(args.filter((a) => a === '--build-context')).toHaveLength(2);
    expect(args).toContain('sources=../sources');
    expect(args).toContain('mod=oci-layout:///path');
  });

  it('emits --secret for each entry (BuildKit)', () => {
    const args = buildDockerBuildCommand(
      { directory: 'asset.x', dockerBuildSecrets: { npmrc: 'src=./.npmrc' } },
      'tag'
    );
    expect(args[args.indexOf('--secret') + 1]).toBe('id=npmrc,src=./.npmrc');
  });

  it('emits --ssh when dockerBuildSsh is set', () => {
    const args = buildDockerBuildCommand(
      { directory: 'asset.x', dockerBuildSsh: 'default' },
      'tag'
    );
    expect(args[args.indexOf('--ssh') + 1]).toBe('default');
  });

  it('emits --network when networkMode is set', () => {
    const args = buildDockerBuildCommand(
      { directory: 'asset.x', networkMode: 'host' },
      'tag'
    );
    expect(args[args.indexOf('--network') + 1]).toBe('host');
  });

  it('emits --cache-from / --cache-to with type + params', () => {
    const args = buildDockerBuildCommand(
      {
        directory: 'asset.x',
        cacheFrom: [
          { type: 'registry', params: { ref: 'example.com/cache:latest' } },
          { type: 'gha' },
        ],
        cacheTo: { type: 'inline' },
      },
      'tag'
    );
    const cacheFromArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--cache-from') cacheFromArgs.push(args[i + 1] as string);
    }
    expect(cacheFromArgs).toEqual([
      'type=registry,ref=example.com/cache:latest',
      'type=gha',
    ]);
    expect(args[args.indexOf('--cache-to') + 1]).toBe('type=inline');
  });

  it('emits --no-cache when cacheDisabled is true', () => {
    const args = buildDockerBuildCommand(
      { directory: 'asset.x', cacheDisabled: true },
      'tag'
    );
    expect(args).toContain('--no-cache');
  });

  it('omits --no-cache when cacheDisabled is false / undefined', () => {
    expect(buildDockerBuildCommand({ directory: 'asset.x' }, 'tag')).not.toContain('--no-cache');
    expect(
      buildDockerBuildCommand({ directory: 'asset.x', cacheDisabled: false }, 'tag')
    ).not.toContain('--no-cache');
  });
});

describe('buildDockerImage (directory source)', () => {
  it('issues runDockerStreaming with BUILDX_NO_DEFAULT_ATTESTATIONS=1 in env', async () => {
    await buildDockerImage({ source: baseSource }, '/cdk.out', {
      tag: 'cdkd-asset-tag',
      wrapError,
    });
    expect(mockRunDocker).toHaveBeenCalledOnce();
    const [, opts] = mockRunDocker.mock.calls[0] as [string[], Record<string, unknown>];
    expect((opts.env as Record<string, string>).BUILDX_NO_DEFAULT_ATTESTATIONS).toBe('1');
  });

  it('appends the context directory as the last arg', async () => {
    await buildDockerImage({ source: baseSource }, '/cdk.out', {
      tag: 'tag',
      wrapError,
    });
    const args = mockRunDocker.mock.calls[0]![0] as string[];
    expect(args[args.length - 1]).toBe('/cdk.out/asset.abc123');
  });

  it('returns the provided tag (directory mode)', async () => {
    const tag = await buildDockerImage({ source: baseSource }, '/cdk.out', {
      tag: 'expected-tag',
      wrapError,
    });
    expect(tag).toBe('expected-tag');
  });

  it('rejects directory mode without options.tag', async () => {
    await expect(
      buildDockerImage({ source: baseSource }, '/cdk.out', { wrapError })
    ).rejects.toThrow(/requires options.tag/);
  });

  it('rejects sources with neither directory nor executable', async () => {
    await expect(
      buildDockerImage({ source: {} as DockerImageAssetSource }, '/cdk.out', {
        tag: 'tag',
        wrapError,
      })
    ).rejects.toThrow(/either 'directory' or 'executable'/);
  });

  it('wraps stderr via wrapError on docker failure', async () => {
    mockRunDocker.mockRejectedValueOnce(
      Object.assign(new Error('docker build exited 1'), { stderr: 'BOOM' })
    );
    await expect(
      buildDockerImage({ source: baseSource }, '/cdk.out', {
        tag: 'tag',
        wrapError: (stderr) => new Error(`wrapped: ${stderr}`),
      })
    ).rejects.toThrow(/wrapped: BOOM/);
  });

  it('falls back to err.message when stderr is empty', async () => {
    mockRunDocker.mockRejectedValueOnce(
      Object.assign(new Error('daemon unreachable'), { stderr: '' })
    );
    await expect(
      buildDockerImage({ source: baseSource }, '/cdk.out', {
        tag: 'tag',
        wrapError: (stderr) => new Error(`wrapped: ${stderr}`),
      })
    ).rejects.toThrow(/wrapped: daemon unreachable/);
  });
});

describe('buildDockerImage (executable source)', () => {
  it('runs the executable and returns its trimmed stdout as the tag', async () => {
    mockSpawn.mockResolvedValueOnce({ stdout: '  my-custom-image:v1  \n', stderr: '' });
    const tag = await buildDockerImage(
      { source: { executable: ['./build.sh', 'arg1'] } },
      '/cdk.out',
      { wrapError }
    );
    expect(tag).toBe('my-custom-image:v1');
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('./build.sh');
    expect(args).toEqual(['arg1']);
    expect(opts.cwd).toBe('/cdk.out');
  });

  it('runs cwd in the asset directory when both directory + executable are set', async () => {
    mockSpawn.mockResolvedValueOnce({ stdout: 'tag-from-script\n', stderr: '' });
    await buildDockerImage(
      { source: { directory: 'asset.x', executable: ['./build.sh'] } },
      '/cdk.out',
      { wrapError }
    );
    const opts = mockSpawn.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.cwd).toBe('/cdk.out/asset.x');
  });

  it('rejects when the executable produces empty stdout', async () => {
    mockSpawn.mockResolvedValueOnce({ stdout: '   \n', stderr: '' });
    await expect(
      buildDockerImage({ source: { executable: ['./build.sh'] } }, '/cdk.out', {
        wrapError: (stderr) => new Error(`wrapped: ${stderr}`),
      })
    ).rejects.toThrow(/no output/);
  });

  it('does NOT call runDockerStreaming when executable mode is used', async () => {
    mockSpawn.mockResolvedValueOnce({ stdout: 'tag\n', stderr: '' });
    await buildDockerImage({ source: { executable: ['./build.sh'] } }, '/cdk.out', { wrapError });
    expect(mockRunDocker).not.toHaveBeenCalled();
  });

  it('wraps spawn failures via wrapError', async () => {
    mockSpawn.mockRejectedValueOnce(
      Object.assign(new Error('script crashed'), { stderr: 'oh no' })
    );
    await expect(
      buildDockerImage({ source: { executable: ['./build.sh'] } }, '/cdk.out', {
        wrapError: (stderr) => new Error(`wrapped: ${stderr}`),
      })
    ).rejects.toThrow(/wrapped: oh no/);
  });
});

