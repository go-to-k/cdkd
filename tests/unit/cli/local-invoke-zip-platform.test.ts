import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedZipLambda } from '../../../src/local/lambda-resolver.js';

// Issue #768 — the ZIP container plan must pin `--platform` to the
// function's declared `Architectures`, just like the IMAGE plan does.
// Without it, a `provided.*` `bootstrap` compiled for the other arch hits
// `exec format error` / `Runtime.InvalidEntrypoint` on an arch-mismatched
// host. This test mocks the docker / runtime-image seams so it exercises
// only the plan-building logic (no real `docker pull` / `docker run`).
const mocks = vi.hoisted(() => ({
  pullImageMock: vi.fn(),
  resolveRuntimeImageMock: vi.fn(),
  resolveRuntimeCodeMountPathMock: vi.fn(),
  resolveRuntimeFileExtensionMock: vi.fn(),
  architectureToPlatformMock: vi.fn(),
}));

vi.mock('../../../src/local/docker-runner.js', () => ({
  pullImage: mocks.pullImageMock,
  // Other named exports the module surfaces — unused here but must exist
  // so the import doesn't throw on a missing binding.
  ensureDockerAvailable: vi.fn(),
  pickFreePort: vi.fn(),
  removeContainer: vi.fn(),
  runDetached: vi.fn(),
  streamLogs: vi.fn(),
}));
vi.mock('../../../src/local/runtime-image.js', () => ({
  resolveRuntimeImage: mocks.resolveRuntimeImageMock,
  resolveRuntimeCodeMountPath: mocks.resolveRuntimeCodeMountPathMock,
  resolveRuntimeFileExtension: mocks.resolveRuntimeFileExtensionMock,
}));
vi.mock('../../../src/local/docker-image-builder.js', () => ({
  architectureToPlatform: mocks.architectureToPlatformMock,
  buildContainerImage: vi.fn(),
}));

import { resolveZipImagePlan } from '../../../src/cli/commands/local-invoke.js';

function makeZipLambda(overrides: Partial<ResolvedZipLambda> = {}): ResolvedZipLambda {
  return {
    kind: 'zip',
    stack: {
      stackName: 'TestStack',
      displayName: 'TestStack',
      assetManifestPath: '/tmp/cdk.out/TestStack.assets.json',
    } as ResolvedZipLambda['stack'],
    logicalId: 'MyFn',
    resource: { Type: 'AWS::Lambda::Function', Properties: {} } as ResolvedZipLambda['resource'],
    runtime: 'provided.al2023',
    handler: 'bootstrap',
    memoryMb: 128,
    timeoutSec: 3,
    codePath: '/tmp/code',
    layers: [],
    architecture: 'x86_64',
    ...overrides,
  };
}

describe('resolveZipImagePlan — issue #768 --platform threading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pullImageMock.mockResolvedValue(undefined);
    mocks.resolveRuntimeImageMock.mockReturnValue('public.ecr.aws/lambda/provided:al2023');
    mocks.resolveRuntimeCodeMountPathMock.mockReturnValue('/var/runtime');
    mocks.resolveRuntimeFileExtensionMock.mockReturnValue('');
    mocks.architectureToPlatformMock.mockImplementation((arch: string) =>
      arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
    );
  });

  it('pins platform from an arm64 ZIP Lambda architecture', async () => {
    const plan = await resolveZipImagePlan(makeZipLambda({ architecture: 'arm64' }), {
      pull: true,
    } as Parameters<typeof resolveZipImagePlan>[1]);

    expect(plan.platform).toBe('linux/arm64');
    expect(mocks.architectureToPlatformMock).toHaveBeenCalledWith('arm64');
  });

  it('pins platform from an x86_64 ZIP Lambda architecture', async () => {
    const plan = await resolveZipImagePlan(makeZipLambda({ architecture: 'x86_64' }), {
      pull: true,
    } as Parameters<typeof resolveZipImagePlan>[1]);

    expect(plan.platform).toBe('linux/amd64');
    expect(mocks.architectureToPlatformMock).toHaveBeenCalledWith('x86_64');
  });
});
