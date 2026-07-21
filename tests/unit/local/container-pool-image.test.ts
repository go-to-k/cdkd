import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createContainerPool,
  type ContainerSpec,
  type ImageContainerSpec,
  type ZipContainerSpec,
} from '../../../src/local/container-pool.js';
import type { ResolvedImageLambda, ResolvedZipLambda } from '../../../src/local/lambda-resolver.js';

/**
 * Coverage for the IMAGE branch of the `ContainerSpec` discriminated
 * union (issue #453). Mirrors the structural shape of
 * `tests/unit/local/container-pool.test.ts` but exercises
 * `kind: 'image'` specs end-to-end through the warm pool.
 *
 * Mocks:
 *   - `docker-runner.runDetached` returns a fake container id and
 *     captures the options object so each assertion can inspect the
 *     emitted `docker run` shape.
 *   - `rie-client.waitForRieReady` resolves immediately so the pool's
 *     post-start wait is a no-op.
 *   - `runtime-image.resolveRuntimeImage` is mocked so accidental
 *     calls on the IMAGE branch surface in `vi.fn` counters — the test
 *     `runtime-image is never consulted` asserts the mock stays
 *     untouched.
 */

vi.mock('../../../src/local/docker-runner.js', () => {
  let counter = 0;
  return {
    pickFreePort: vi.fn(async () => {
      counter += 1;
      return 30000 + counter;
    }),
    runDetached: vi.fn(async (opts: { name?: string }) => `container-${opts.name}`),
    streamLogs: vi.fn(() => () => undefined),
    removeContainer: vi.fn(async () => undefined),
  };
});

vi.mock('../../../src/local/rie-client.js', () => ({
  waitForRieReady: vi.fn(async () => undefined),
}));

vi.mock('../../../src/local/runtime-image.js', () => ({
  resolveRuntimeImage: vi.fn(() => 'public.ecr.aws/lambda/nodejs:20'),
  resolveRuntimeCodeMountPath: vi.fn(() => '/var/task'),
}));

import { runDetached } from '../../../src/local/docker-runner.js';
import { resolveRuntimeImage } from '../../../src/local/runtime-image.js';

function makeImageSpec(
  logicalId: string,
  overrides: Partial<ImageContainerSpec> = {}
): ContainerSpec {
  const lambda: ResolvedImageLambda = {
    kind: 'image',
    stack: {
      stackName: 'S',
      displayName: 'S',
      artifactId: 'S',
      template: { Resources: {} },
      dependencyNames: [],
    } as never,
    logicalId,
    resource: { Type: 'AWS::Lambda::Function', Properties: {} } as never,
    memoryMb: 128,
    timeoutSec: 3,
    imageUri: 'cdkd-local-start-api-abcdef0123456789',
    imageConfig: {},
    architecture: 'x86_64',
    layers: [],
  };
  return {
    kind: 'image',
    lambda,
    image: 'cdkd-local-start-api-abcdef0123456789',
    platform: 'linux/amd64',
    command: [],
    env: {},
    containerHost: '127.0.0.1',
    ...overrides,
  };
}

function makeZipSpec(logicalId: string): ContainerSpec {
  const lambda = {
    kind: 'zip',
    stack: {
      stackName: 'S',
      displayName: 'S',
      artifactId: 'S',
      template: { Resources: {} },
      dependencyNames: [],
    },
    logicalId,
    resource: { Type: 'AWS::Lambda::Function', Properties: {} },
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    memoryMb: 128,
    timeoutSec: 3,
    codePath: '/tmp/code',
    layers: [],
  } as unknown as ResolvedZipLambda;
  const spec: ZipContainerSpec = {
    kind: 'zip',
    lambda,
    codeDir: '/tmp/code',
    platform: 'linux/amd64',
    env: {},
    containerHost: '127.0.0.1',
  };
  return spec;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('container-pool — IMAGE branch (issue #453)', () => {
  it('passes spec.image verbatim to docker run, with no code bind-mount', async () => {
    const specs = new Map([['Fn', makeImageSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    expect(runDetached).toHaveBeenCalledTimes(1);
    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      image: string;
      mounts: unknown[];
      platform?: string;
      cmd: string[];
    };
    expect(callArg.image).toBe('cdkd-local-start-api-abcdef0123456789');
    expect(callArg.mounts).toEqual([]); // no /var/task bind-mount on IMAGE branch
    expect(callArg.platform).toBe('linux/amd64');
    expect(callArg.cmd).toEqual([]);
    // resolveRuntimeImage is the ZIP-branch base-image picker — it must
    // never fire on the IMAGE branch.
    expect(resolveRuntimeImage).not.toHaveBeenCalled();
    pool.release(h);
    await pool.dispose();
  });

  it('threads --platform linux/arm64 through for arm64 architectures', async () => {
    const arm = makeImageSpec('Arm', { platform: 'linux/arm64' });
    const specs = new Map([['Arm', arm]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Arm');
    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      platform?: string;
    };
    expect(callArg.platform).toBe('linux/arm64');
    pool.release(h);
    await pool.dispose();
  });

  it('forwards ImageConfig.Command as docker run CMD', async () => {
    const spec = makeImageSpec('Fn', { command: ['app.handler', '--debug'] });
    const specs = new Map([['Fn', spec]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      cmd: string[];
    };
    expect(callArg.cmd).toEqual(['app.handler', '--debug']);
    pool.release(h);
    await pool.dispose();
  });

  it('forwards ImageConfig.EntryPoint + WorkingDirectory', async () => {
    const spec = makeImageSpec('Fn', {
      entryPoint: ['/usr/bin/python3', '-u'],
      workingDir: '/opt/app',
      command: ['handler.py'],
    });
    const specs = new Map([['Fn', spec]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      entryPoint?: string[];
      workingDir?: string;
      cmd: string[];
    };
    expect(callArg.entryPoint).toEqual(['/usr/bin/python3', '-u']);
    expect(callArg.workingDir).toBe('/opt/app');
    expect(callArg.cmd).toEqual(['handler.py']);
    pool.release(h);
    await pool.dispose();
  });

  it('omits entryPoint / workingDir / debugPort fields when unset', async () => {
    const specs = new Map([['Fn', makeImageSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(callArg.entryPoint).toBeUndefined();
    expect(callArg.workingDir).toBeUndefined();
    expect(callArg.debugPort).toBeUndefined();
    pool.release(h);
    await pool.dispose();
  });

  it('does NOT emit a /opt layer mount even when (hypothetically) optDir-like info is on the lambda', async () => {
    // Defense-in-depth: container Lambdas reject `Layers` at deploy
    // time on the AWS side. The resolver normalizes `lambda.layers` to
    // [] for the IMAGE branch. The container-pool's IMAGE branch
    // ignores layer info entirely; this test asserts no `/opt` mount
    // is emitted even if the ZIP-side `optDir` field accidentally got
    // populated.
    const specs = new Map([['Fn', makeImageSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      extraMounts?: unknown[];
    };
    expect(callArg.extraMounts ?? []).toEqual([]);
    pool.release(h);
    await pool.dispose();
  });

  it('coexists with ZIP specs in the same pool — each routes through the right branch', async () => {
    const specs = new Map<string, ContainerSpec>([
      ['ImageFn', makeImageSpec('ImageFn')],
      ['ZipFn', makeZipSpec('ZipFn')],
    ]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });

    const imageHandle = await pool.acquire('ImageFn');
    const zipHandle = await pool.acquire('ZipFn');
    expect(runDetached).toHaveBeenCalledTimes(2);
    const calls = (runDetached as ReturnType<typeof vi.fn>).mock.calls;
    const imageCall = calls[0]![0] as { image: string; mounts: unknown[] };
    const zipCall = calls[1]![0] as {
      image: string;
      mounts: { hostPath: string; containerPath: string }[];
    };
    // The image-branch call uses the pre-built local tag and NO mounts.
    expect(imageCall.image).toBe('cdkd-local-start-api-abcdef0123456789');
    expect(imageCall.mounts).toEqual([]);
    // The zip-branch call uses the runtime base image AND a /var/task
    // bind-mount sourced from spec.codeDir.
    expect(zipCall.image).toBe('public.ecr.aws/lambda/nodejs:20');
    expect(zipCall.mounts).toEqual([
      { hostPath: '/tmp/code', containerPath: '/var/task', readOnly: true },
    ]);

    pool.release(imageHandle);
    pool.release(zipHandle);
    await pool.dispose();
  });

  it('passes spec.debugPort through to docker run on the IMAGE branch', async () => {
    const spec = makeImageSpec('Fn', { debugPort: 9229 });
    const specs = new Map([['Fn', spec]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      debugPort?: number;
    };
    expect(callArg.debugPort).toBe(9229);
    pool.release(h);
    await pool.dispose();
  });

  // PR #493 review G2: tmpfs IMAGE branch propagation (issue #440 —
  // Lambda Properties.EphemeralStorage.Size). The ZIP branch is
  // covered by tests/unit/local/container-pool.test.ts; the parallel
  // assertion for the IMAGE branch was missing. Docker `--tmpfs`
  // overlays inside any container image just like on the public base
  // images, so spec.tmpfs MUST thread into runDetached(tmpfs) on
  // BOTH branches.
  it('IMAGE branch: threads ContainerSpec.tmpfs into runDetached(tmpfs)', async () => {
    const spec = makeImageSpec('Fn', { tmpfs: { target: '/tmp', sizeMb: 2048 } });
    const specs = new Map([['Fn', spec]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      tmpfs?: { target: string; sizeMb: number };
    };
    expect(callArg.tmpfs).toEqual({ target: '/tmp', sizeMb: 2048 });
    pool.release(h);
    await pool.dispose();
  });

  it('IMAGE branch: omits runDetached(tmpfs) when ContainerSpec.tmpfs is undefined', async () => {
    // The IMAGE-branch parallel of the ZIP-branch absence guard. A
    // container Lambda without `EphemeralStorage` MUST NOT emit a
    // `--tmpfs` flag — runDetached's args are checked verbatim by
    // the docker-runner unit tests.
    const spec = makeImageSpec('Fn');
    const specs = new Map([['Fn', spec]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      tmpfs?: { target: string; sizeMb: number };
    };
    expect(callArg.tmpfs).toBeUndefined();
    pool.release(h);
    await pool.dispose();
  });
});
