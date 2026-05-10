import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedImageLambda } from '../../../src/local/lambda-resolver.js';

// vi.mock factories are hoisted to the top of the file BEFORE top-level
// `const` declarations, so we cannot reference plain `const buildContainerImageMock = vi.fn()`
// from inside the factory. Wrap the captures in vi.hoisted() — that block
// also gets hoisted, and exposes the same `vi.fn()` instances to both the
// factories and the test bodies.
// (See feedback_vi_mock_hoisting.md.)
const mocks = vi.hoisted(() => ({
  buildContainerImageMock: vi.fn(),
  architectureToPlatformMock: vi.fn(),
  pullEcrImageMock: vi.fn(),
  parseEcrUriMock: vi.fn(),
  loadManifestMock: vi.fn(),
  getDockerImageBySourceHashMock: vi.fn(),
}));
const {
  buildContainerImageMock,
  architectureToPlatformMock,
  pullEcrImageMock,
  parseEcrUriMock,
  loadManifestMock,
  getDockerImageBySourceHashMock,
} = mocks;

vi.mock('../../../src/local/docker-image-builder.js', () => ({
  buildContainerImage: mocks.buildContainerImageMock,
  architectureToPlatform: mocks.architectureToPlatformMock,
}));
vi.mock('../../../src/local/ecr-puller.js', () => ({
  pullEcrImage: mocks.pullEcrImageMock,
  parseEcrUri: mocks.parseEcrUriMock,
}));
vi.mock('../../../src/assets/asset-manifest-loader.js', () => ({
  AssetManifestLoader: vi.fn().mockImplementation(() => ({
    loadManifest: mocks.loadManifestMock,
  })),
  getDockerImageBySourceHash: mocks.getDockerImageBySourceHashMock,
}));

import { resolveContainerImagePlan } from '../../../src/cli/commands/local-invoke.js';

function makeImageLambda(overrides: Partial<ResolvedImageLambda> = {}): ResolvedImageLambda {
  return {
    kind: 'image',
    stack: {
      stackName: 'TestStack',
      displayName: 'TestStack',
      assetManifestPath: '/tmp/cdk.out/TestStack.assets.json',
    } as ResolvedImageLambda['stack'],
    logicalId: 'MyImageFn',
    resource: { Type: 'AWS::Lambda::Function', Properties: {} } as ResolvedImageLambda['resource'],
    memoryMb: 128,
    timeoutSec: 3,
    imageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef',
    imageConfig: {},
    architecture: 'x86_64',
    ...overrides,
  };
}

describe('resolveContainerImagePlan', () => {
  beforeEach(() => {
    buildContainerImageMock.mockReset();
    architectureToPlatformMock.mockReset();
    pullEcrImageMock.mockReset();
    parseEcrUriMock.mockReset();
    loadManifestMock.mockReset();
    getDockerImageBySourceHashMock.mockReset();
    architectureToPlatformMock.mockReturnValue('linux/amd64');
  });

  it('asset hit returns kind=local-build (image is the locally-built tag)', async () => {
    // Manifest lookup hits — buildContainerImage is invoked.
    loadManifestMock.mockResolvedValue({ dockerImages: { abc: { source: { directory: '.' } } } });
    getDockerImageBySourceHashMock.mockReturnValue({
      hash: 'abc',
      asset: { source: { directory: '.' } },
    });
    buildContainerImageMock.mockResolvedValue('cdkd-local/MyImageFn:abc');

    const plan = await resolveContainerImagePlan(makeImageLambda(), {
      pull: true,
    } as Parameters<typeof resolveContainerImagePlan>[1]);

    expect(plan.image).toBe('cdkd-local/MyImageFn:abc');
    expect(plan.platform).toBe('linux/amd64');
    expect(buildContainerImageMock).toHaveBeenCalledTimes(1);
    expect(pullEcrImageMock).not.toHaveBeenCalled();
  });

  it('asset miss + valid ECR URI falls back to ECR pull', async () => {
    // Manifest exists but the lookup misses (e.g. multiple images with no
    // hash match).
    loadManifestMock.mockResolvedValue({ dockerImages: { foo: {}, bar: {} } });
    getDockerImageBySourceHashMock.mockReturnValue(undefined);
    parseEcrUriMock.mockReturnValue({
      accountId: '111111111111',
      region: 'us-east-1',
      repository: 'repo',
      tag: 'abcdef',
    });
    pullEcrImageMock.mockResolvedValue('111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef');

    const plan = await resolveContainerImagePlan(makeImageLambda(), {
      pull: true,
      region: 'us-east-1',
    } as Parameters<typeof resolveContainerImagePlan>[1]);

    expect(plan.image).toBe('111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef');
    expect(pullEcrImageMock).toHaveBeenCalledTimes(1);
    // --region plumbs through to pullEcrImage so the cross-region check
    // honors the explicit flag (regression guard for fix #6).
    expect(pullEcrImageMock).toHaveBeenCalledWith(
      '111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef',
      expect.objectContaining({ region: 'us-east-1', skipPull: false })
    );
    expect(buildContainerImageMock).not.toHaveBeenCalled();
  });

  it('asset miss + non-ECR URI throws a clear LocalInvokeBuildError-style error', async () => {
    loadManifestMock.mockResolvedValue({ dockerImages: {} });
    getDockerImageBySourceHashMock.mockReturnValue(undefined);
    parseEcrUriMock.mockReturnValue(undefined);

    await expect(
      resolveContainerImagePlan(makeImageLambda({ imageUri: 'public.ecr.aws/lambda/nodejs:20' }), {
        pull: true,
      } as Parameters<typeof resolveContainerImagePlan>[1])
    ).rejects.toThrow(/no matching asset.*not an ECR URI/i);
    expect(pullEcrImageMock).not.toHaveBeenCalled();
    expect(buildContainerImageMock).not.toHaveBeenCalled();
  });

  it('--no-pull threads through to pullEcrImage skipPull=true on the ECR fallback path', async () => {
    loadManifestMock.mockResolvedValue({ dockerImages: {} });
    getDockerImageBySourceHashMock.mockReturnValue(undefined);
    parseEcrUriMock.mockReturnValue({
      accountId: '111111111111',
      region: 'us-east-1',
      repository: 'repo',
      tag: 'abcdef',
    });
    pullEcrImageMock.mockResolvedValue('111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef');

    await resolveContainerImagePlan(makeImageLambda(), {
      pull: false,
    } as Parameters<typeof resolveContainerImagePlan>[1]);

    expect(pullEcrImageMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipPull: true })
    );
  });

  it('emits ImageConfig.command and entryPoint and workingDirectory in the plan', async () => {
    loadManifestMock.mockResolvedValue({ dockerImages: { abc: {} } });
    getDockerImageBySourceHashMock.mockReturnValue({ hash: 'abc', asset: {} });
    buildContainerImageMock.mockResolvedValue('local:abc');

    const plan = await resolveContainerImagePlan(
      makeImageLambda({
        imageConfig: {
          command: ['handler'],
          entryPoint: ['custom-ep', 'tail-arg'],
          workingDirectory: '/var/custom',
        },
      }),
      { pull: true } as Parameters<typeof resolveContainerImagePlan>[1]
    );

    expect(plan.cmd).toEqual(['handler']);
    expect(plan.entryPoint).toEqual(['custom-ep', 'tail-arg']);
    expect(plan.workingDir).toBe('/var/custom');
  });
});
