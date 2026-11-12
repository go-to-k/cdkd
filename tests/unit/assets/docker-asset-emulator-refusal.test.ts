import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const mockEcrSend = vi.fn();
vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecr')>();
  return { ...actual, ECRClient: vi.fn(() => ({ send: mockEcrSend, destroy: vi.fn() })) };
});
const mockBuildImage = vi.fn();
vi.mock('../../../src/assets/docker-build.js', () => ({
  buildDockerImage: (...args: unknown[]) => mockBuildImage(...args),
}));

import { AssetPublisher } from '../../../src/assets/asset-publisher.js';
import { DockerAssetPublisher } from '../../../src/assets/docker-asset-publisher.js';
import { WorkGraph } from '../../../src/deployment/work-graph.js';
import { AssetError } from '../../../src/utils/error-handler.js';
import { setAwsEndpointOverrideSource } from '../../../src/utils/aws-client-defaults.js';
import type { DockerImageAsset } from '../../../src/types/assets.js';

/**
 * go-to-k/cdkd#6138: under `--aws-emulator`, a Docker image asset is refused
 * before anything is built or pushed — ECR on the emulator names the real
 * `amazonaws.com` registry, so a push would leave the machine for real AWS.
 */
const ASSET = {
  displayName: 'Fn/AssetImage',
  source: { directory: 'asset.def456' },
  destinations: { d: { repositoryName: 'repo', imageTag: 't' } },
} as unknown as DockerImageAsset;

afterEach(() => {
  setAwsEndpointOverrideSource(undefined);
  mockEcrSend.mockReset();
  mockBuildImage.mockReset();
});

const emulatorOn = (): void =>
  setAwsEndpointOverrideSource(() => ({ endpoint: 'https://127.0.0.1:9297' }));

function manifestWithDockerImage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-emu-docker-'));
  const path = join(dir, 'Stack.assets.json');
  writeFileSync(
    path,
    JSON.stringify({ version: '54.0.0', files: {}, dockerImages: { d1: ASSET } })
  );
  return path;
}

describe('Docker image assets under --aws-emulator', () => {
  it('the work graph refuses before adding a node', () => {
    emulatorOn();
    const graph = new WorkGraph();
    expect(() =>
      new AssetPublisher().addAssetsToGraph(graph, manifestWithDockerImage(), {
        accountId: '000000000000',
        region: 'us-east-1',
      })
    ).toThrow(AssetError);
    expect(() =>
      new AssetPublisher().addAssetsToGraph(new WorkGraph(), manifestWithDockerImage(), {
        accountId: '000000000000',
        region: 'us-east-1',
      })
    ).toThrow(/Fn\/AssetImage.*real amazonaws\.com registry/);
  });

  it('build, push and publish refuse with no docker or ECR call', async () => {
    emulatorOn();
    const p = new DockerAssetPublisher();
    await expect(p.build(ASSET, '/tmp/cdk.out', 'tag', '/tmp/cdk.out')).rejects.toThrow(
      AssetError
    );
    await expect(p.push(ASSET, '000000000000', 'us-east-1', 'tag')).rejects.toThrow(AssetError);
    await expect(
      p.publish('h', ASSET, '/tmp/cdk.out', '000000000000', 'us-east-1')
    ).rejects.toThrow(AssetError);
    expect(mockBuildImage).not.toHaveBeenCalled();
    expect(mockEcrSend).not.toHaveBeenCalled();
  });

  it('without the flag the graph takes the asset as before', () => {
    const graph = new WorkGraph();
    const ids = new AssetPublisher().addAssetsToGraph(graph, manifestWithDockerImage(), {
      accountId: '000000000000',
      region: 'us-east-1',
    });
    expect(ids).toEqual(['asset-publish:docker:d1']);
  });
});
