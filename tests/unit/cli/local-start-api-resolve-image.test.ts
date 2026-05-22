import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedStartApiImageLambda } from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Coverage for `resolveContainerImageForStartApi` (PR #493 review G4).
 *
 * The `cdkd local start-api` IMAGE branch routes through this helper
 * to turn a container Lambda's `Code.ImageUri` into a locally-runnable
 * docker tag. Tests cover the three code paths:
 *
 *   1. Local-build path (asset hash match in `cdk.out`):
 *      `buildContainerImage` is invoked with the correct architecture
 *      and the resulting deterministic tag is returned verbatim.
 *
 *   2. ECR-pull fallback (asset lookup misses + URI matches the ECR
 *      shape): `pullEcrImage` is invoked with the URI and the
 *      `--no-pull` flag's value, returning the pulled image ref.
 *
 *   3. Error path: asset lookup misses AND the URI is NOT an ECR
 *      shape → clear error pointing the user at re-synth or
 *      pre-deploying to ECR.
 *
 * The cross-account / cross-region ECR boundary is enforced inside
 * `pullEcrImage` itself (covered by `tests/unit/local/ecr-puller.test.ts`);
 * this test asserts the helper PROPAGATES that error rather than
 * swallowing it.
 */

const mocks = vi.hoisted(() => ({
  buildContainerImageMock: vi.fn(),
  pullEcrImageMock: vi.fn(),
  parseEcrUriMock: vi.fn(),
  loadManifestMock: vi.fn(),
  getDockerImageBySourceHashMock: vi.fn(),
}));

vi.mock('../../../src/local/docker-image-builder.js', () => ({
  buildContainerImage: mocks.buildContainerImageMock,
  architectureToPlatform: vi.fn(() => 'linux/amd64'),
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

import { resolveContainerImageForStartApi } from '../../../src/cli/commands/local-start-api.js';

function makeImageLambda(
  overrides: Partial<ResolvedStartApiImageLambda> = {}
): ResolvedStartApiImageLambda {
  const stack: StackInfo = {
    stackName: 'TestStack',
    displayName: 'TestStack',
    assetManifestPath: '/tmp/cdk.out/TestStack.assets.json',
  } as unknown as StackInfo;
  return {
    kind: 'image',
    stack,
    logicalId: 'MyImageFn',
    resource: { Type: 'AWS::Lambda::Function', Properties: {} } as never,
    memoryMb: 128,
    timeoutSec: 3,
    layers: [],
    imageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef',
    imageConfig: {},
    architecture: 'x86_64',
    ...overrides,
  };
}

describe('resolveContainerImageForStartApi (PR #493 review G4)', () => {
  beforeEach(() => {
    mocks.buildContainerImageMock.mockReset();
    mocks.pullEcrImageMock.mockReset();
    mocks.parseEcrUriMock.mockReset();
    mocks.loadManifestMock.mockReset();
    mocks.getDockerImageBySourceHashMock.mockReset();
  });

  it('asset hit: routes through buildContainerImage with the correct architecture', async () => {
    // Manifest lookup hits — buildContainerImage is invoked.
    mocks.loadManifestMock.mockResolvedValue({
      dockerImages: { abc: { source: { directory: '.' } } },
    });
    mocks.getDockerImageBySourceHashMock.mockReturnValue({
      hash: 'abc',
      asset: { source: { directory: '.' } },
    });
    mocks.buildContainerImageMock.mockResolvedValue('cdkd-local-start-api-abcdef0123456789');

    const result = await resolveContainerImageForStartApi(makeImageLambda(), false);

    expect(result.imageRef).toBe('cdkd-local-start-api-abcdef0123456789');
    expect(mocks.buildContainerImageMock).toHaveBeenCalledTimes(1);
    expect(mocks.buildContainerImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.any(Object) }),
      expect.any(String),
      expect.objectContaining({ architecture: 'x86_64' })
    );
    expect(mocks.pullEcrImageMock).not.toHaveBeenCalled();
  });

  it('asset hit: arm64 architecture threads through to buildContainerImage', async () => {
    mocks.loadManifestMock.mockResolvedValue({
      dockerImages: { abc: { source: { directory: '.' } } },
    });
    mocks.getDockerImageBySourceHashMock.mockReturnValue({
      hash: 'abc',
      asset: { source: { directory: '.' } },
    });
    mocks.buildContainerImageMock.mockResolvedValue('cdkd-local-start-api-arm0000000000000');

    await resolveContainerImageForStartApi(makeImageLambda({ architecture: 'arm64' }), false);

    expect(mocks.buildContainerImageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ architecture: 'arm64' })
    );
  });

  it('asset miss + ECR URI: falls back to pullEcrImage with skipPull=false', async () => {
    // Manifest exists but the lookup misses — fall through to ECR pull.
    mocks.loadManifestMock.mockResolvedValue({ dockerImages: { foo: {} } });
    mocks.getDockerImageBySourceHashMock.mockReturnValue(undefined);
    mocks.parseEcrUriMock.mockReturnValue({
      accountId: '111111111111',
      region: 'us-east-1',
      repository: 'repo',
      tag: 'abcdef',
    });
    mocks.pullEcrImageMock.mockResolvedValue(
      '111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef'
    );

    const result = await resolveContainerImageForStartApi(makeImageLambda(), false);

    expect(result.imageRef).toBe('111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef');
    expect(mocks.pullEcrImageMock).toHaveBeenCalledTimes(1);
    expect(mocks.pullEcrImageMock).toHaveBeenCalledWith(
      '111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef',
      expect.objectContaining({ skipPull: false })
    );
    expect(mocks.buildContainerImageMock).not.toHaveBeenCalled();
  });

  it('asset miss + ECR URI: --no-pull threads through as skipPull=true', async () => {
    mocks.loadManifestMock.mockResolvedValue({ dockerImages: {} });
    mocks.getDockerImageBySourceHashMock.mockReturnValue(undefined);
    mocks.parseEcrUriMock.mockReturnValue({
      accountId: '111111111111',
      region: 'us-east-1',
      repository: 'repo',
      tag: 'abcdef',
    });
    mocks.pullEcrImageMock.mockResolvedValue(
      '111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef'
    );

    await resolveContainerImageForStartApi(makeImageLambda(), true);

    expect(mocks.pullEcrImageMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipPull: true })
    );
  });

  it('asset miss + non-ECR URI: throws a clear error pointing at re-synth / pre-deploy', async () => {
    mocks.loadManifestMock.mockResolvedValue({ dockerImages: {} });
    mocks.getDockerImageBySourceHashMock.mockReturnValue(undefined);
    mocks.parseEcrUriMock.mockReturnValue(undefined);

    await expect(
      resolveContainerImageForStartApi(
        makeImageLambda({ imageUri: 'public.ecr.aws/lambda/nodejs:20' }),
        false
      )
    ).rejects.toThrow(/no matching asset.*not an ECR URI/i);
    expect(mocks.pullEcrImageMock).not.toHaveBeenCalled();
    expect(mocks.buildContainerImageMock).not.toHaveBeenCalled();
  });

  it('asset miss + no assetManifestPath: still falls through to ECR-pull path', async () => {
    // Edge case: the stack carries no assetManifestPath (a synth artifact
    // without a docker assets manifest). resolveLocalBuildPlan returns
    // undefined immediately; the helper proceeds to the ECR-shape check.
    mocks.parseEcrUriMock.mockReturnValue({
      accountId: '111111111111',
      region: 'us-east-1',
      repository: 'repo',
      tag: 'abcdef',
    });
    mocks.pullEcrImageMock.mockResolvedValue(
      '111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef'
    );

    const lambda = makeImageLambda();
    // Override the assetManifestPath to undefined.
    (lambda as { stack: { assetManifestPath?: string | undefined } }).stack = {
      ...lambda.stack,
      assetManifestPath: undefined,
    } as unknown as StackInfo;

    const result = await resolveContainerImageForStartApi(lambda, false);

    expect(result.imageRef).toBe('111111111111.dkr.ecr.us-east-1.amazonaws.com/repo:abcdef');
    // The local-build path was short-circuited (no manifest path = no
    // load attempt).
    expect(mocks.loadManifestMock).not.toHaveBeenCalled();
    expect(mocks.buildContainerImageMock).not.toHaveBeenCalled();
  });

  it('propagates pullEcrImage rejections (e.g. cross-account boundary error)', async () => {
    // Cross-account / cross-region ECR pull is rejected inside
    // pullEcrImage itself. This test asserts the resolver propagates
    // that error rather than swallowing it — the user must see the
    // original "deferred follow-up" message.
    mocks.loadManifestMock.mockResolvedValue({ dockerImages: {} });
    mocks.getDockerImageBySourceHashMock.mockReturnValue(undefined);
    mocks.parseEcrUriMock.mockReturnValue({
      accountId: '999999999999', // different account
      region: 'us-east-1',
      repository: 'repo',
      tag: 'abcdef',
    });
    mocks.pullEcrImageMock.mockRejectedValue(
      new Error('Cross-account ECR pull is not supported in cdkd local start-api v1')
    );

    await expect(resolveContainerImageForStartApi(makeImageLambda(), false)).rejects.toThrow(
      /Cross-account ECR pull is not supported/
    );
  });

  it('propagates buildContainerImage rejections (asset-build failure)', async () => {
    mocks.loadManifestMock.mockResolvedValue({
      dockerImages: { abc: { source: { directory: '.' } } },
    });
    mocks.getDockerImageBySourceHashMock.mockReturnValue({
      hash: 'abc',
      asset: { source: { directory: '.' } },
    });
    mocks.buildContainerImageMock.mockRejectedValue(new Error('docker build failed: syntax error'));

    await expect(resolveContainerImageForStartApi(makeImageLambda(), false)).rejects.toThrow(
      /docker build failed: syntax error/
    );
  });
});
