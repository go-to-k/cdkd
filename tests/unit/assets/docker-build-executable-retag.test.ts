import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Covers the `actualTag !== tag` re-tag branch in `docker-asset-publisher`
// (the cdkd ECR publish path). In `executable` source mode the user script
// returns its own image tag on stdout; the publisher then re-tags it to the
// deterministic `cdkd-asset-<hash>` so downstream push keeps working. Pre-fix
// this branch was untested — flagged by the pr-test-reviewer agent on PR 437.
// The `local-invoke (docker-image-builder)` re-tag cases that used to live here
// moved to cdk-local alongside the docker-image-builder shim (cdk-local owns the
// impl, owns the test).

const { mockBuildDockerImage, mockRunDocker } = vi.hoisted(() => ({
  mockBuildDockerImage: vi.fn(),
  mockRunDocker: vi.fn(),
}));

// Mock the build path so we can control `actualTag` per-test.
vi.mock('../../../src/assets/docker-build.js', () => ({
  buildDockerImage: mockBuildDockerImage,
}));

// Mock the docker-cmd helper so the re-tag `docker tag <actualTag> <tag>`
// call lands in a captured mock instead of real docker.
vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return {
    ...actual,
    runDockerStreaming: mockRunDocker,
  };
});

// Silence the logger so tests don't dump WARN lines.
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

beforeEach(() => {
  mockBuildDockerImage.mockReset();
  mockRunDocker.mockReset();
  mockRunDocker.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('publisher (docker-asset-publisher): executable source re-tag', () => {
  // The publisher mocks the ECR client + docker via runDockerStreaming.
  // To exercise just the re-tag branch without standing up the whole
  // publish() flow, we directly call build() (the public method used by
  // WorkGraph asset-build nodes) which calls buildImage internally.
  it('re-tags the executable-built image to the requested deterministic tag', async () => {
    mockBuildDockerImage.mockResolvedValueOnce('user-script-image:v1');
    const { DockerAssetPublisher } = await import(
      '../../../src/assets/docker-asset-publisher.js'
    );
    await new DockerAssetPublisher().build(
      {
        displayName: 'X',
        source: { executable: ['./build.sh'] },
        destinations: {},
      },
      '/cdk.out',
      'cdkd-asset-deadbeef'
    );
    const tagCall = mockRunDocker.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === 'tag'
    );
    expect(tagCall).toBeDefined();
    expect(tagCall![0]).toEqual(['tag', 'user-script-image:v1', 'cdkd-asset-deadbeef']);
  });

  it('wraps the docker tag failure as AssetError with actualTag + requested tag', async () => {
    mockBuildDockerImage.mockResolvedValueOnce('user-script-image:v2');
    mockRunDocker.mockImplementationOnce(async (args: string[]) => {
      if (args[0] === 'tag') {
        const err = Object.assign(new Error('tag failed'), { stderr: 'denied' });
        throw err;
      }
      return { stdout: '', stderr: '' };
    });
    const { DockerAssetPublisher } = await import(
      '../../../src/assets/docker-asset-publisher.js'
    );
    const { AssetError } = await import('../../../src/utils/error-handler.js');
    let caught: unknown;
    try {
      await new DockerAssetPublisher().build(
        {
          displayName: 'X',
          source: { executable: ['./build.sh'] },
          destinations: {},
        },
        '/cdk.out',
        'cdkd-asset-feedface'
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AssetError);
    expect((caught as Error).message).toMatch(
      /re-tagging 'user-script-image:v2' → 'cdkd-asset-feedface'/
    );
  });
});
