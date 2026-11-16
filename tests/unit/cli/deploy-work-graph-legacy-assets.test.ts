import { describe, it, expect, vi } from 'vite-plus/test';
import { addStacksToWorkGraph } from '../../../src/cli/commands/deploy/work-graph.js';
import { AssetPublisher } from '../../../src/assets/asset-publisher.js';
import { WorkGraph } from '../../../src/deployment/work-graph.js';
import type { AssetModeResolver } from '../../../src/assets/asset-storage.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DeployCommandOptions } from '../../../src/cli/commands/deploy/types.js';
import type { ConsoleLogger } from '../../../src/utils/logger.js';

// Issue #6421: `cdkd deploy` of a LegacyStackSynthesizer stack — no asset
// manifest, assets only as `aws:cdk:asset` metadata — publishes those assets
// and binds the template parameters the synthesizer declares.

const HASH = '8618294e4c15b42a6a1cccef1d013fd30bdcebc8d171446f2714ef647b698efa';
const BUCKET_PARAM = `AssetParameters${HASH}S3BucketE1DD80B4`;
const KEY_PARAM = `AssetParameters${HASH}S3VersionKey51687BDC`;
const HASH_PARAM = `AssetParameters${HASH}ArtifactHashA9EAD8FD`;

function legacyStack(): StackInfo {
  return {
    stackName: 'Legacy',
    displayName: 'Legacy',
    artifactId: 'Legacy',
    region: 'us-east-1',
    dependencyNames: [],
    assetOutdir: '/cdk.out',
    template: {
      Parameters: {
        [BUCKET_PARAM]: { Type: 'String' },
        [KEY_PARAM]: { Type: 'String' },
        [HASH_PARAM]: { Type: 'String' },
      },
      Resources: {},
    },
    legacyAssets: {
      assemblyDir: '/cdk.out',
      entries: [
        {
          packaging: 'zip',
          id: HASH,
          path: `asset.${HASH}`,
          sourceHash: HASH,
          s3BucketParameter: BUCKET_PARAM,
          s3KeyParameter: KEY_PARAM,
          artifactHashParameter: HASH_PARAM,
        },
        {
          packaging: 'container-image',
          id: 'img',
          path: 'asset.img',
          sourceHash: 'img',
          repositoryName: 'aws-cdk/assets',
          imageTag: 'img',
        },
      ],
    },
  } as StackInfo;
}

async function run(stack: StackInfo, options: Partial<DeployCommandOptions>) {
  const workGraph = new WorkGraph();
  const assetModeResolver = {
    resolve: vi.fn().mockResolvedValue({
      mode: 'cdkd-assets',
      marker: { assetBucket: 'cdkd-assets-bucket', containerRepo: 'cdkd-container-assets' },
    }),
  } as unknown as AssetModeResolver;
  await addStacksToWorkGraph({
    targetStacks: [stack],
    graphKey: (s) => s.stackName,
    stackRegions: new Map(),
    baseRegion: 'us-east-1',
    assetModeResolver,
    rawNamedRegion: undefined,
    logger: { debug: vi.fn() } as unknown as ConsoleLogger,
    accountId: '123456789012',
    stackRedirects: new Map(),
    options: options as DeployCommandOptions,
    assetPublisher: new AssetPublisher(),
    workGraph,
    dependencyStacks: () => new Set(),
    inferredCrossStackDeps: new Map(),
  });
  return workGraph;
}

const nodesOf = (graph: WorkGraph) =>
  (graph as unknown as { nodes: Map<string, { dependencies: Set<string>; data: unknown }> }).nodes;
const nodeIds = (graph: WorkGraph): string[] => [...nodesOf(graph).keys()];

describe('addStacksToWorkGraph: LegacyStackSynthesizer assets', () => {
  it('adds publish nodes the stack waits on and binds the parameters to the final bucket', async () => {
    const stack = legacyStack();
    const graph = await run(stack, {});

    const ids = nodeIds(graph);
    expect(ids).toEqual(
      expect.arrayContaining([
        `asset-publish:Legacy:file:${HASH}`,
        'asset-build:Legacy:docker:img',
        'asset-publish:Legacy:docker:img',
        'stack:Legacy',
      ])
    );
    const nodes = nodesOf(graph);
    expect([...nodes.get('stack:Legacy')!.dependencies].sort()).toEqual(
      [`asset-publish:Legacy:file:${HASH}`, 'asset-publish:Legacy:docker:img'].sort()
    );
    expect(nodes.get(`asset-publish:Legacy:file:${HASH}`)!.data).toMatchObject({
      kind: 'file',
      cdkOutputDir: '/cdk.out',
      asset: {
        destinations: {
          '123456789012-us-east-1': {
            bucketName: 'cdkd-assets-bucket',
            objectKey: `assets/${HASH}.zip`,
          },
        },
      },
    });
    expect(nodes.get('asset-publish:Legacy:docker:img')!.data).toMatchObject({
      kind: 'docker-publish',
      ensureRepository: true,
    });

    const params = stack.template.Parameters!;
    expect(params[BUCKET_PARAM]!.Default).toBe('cdkd-assets-bucket');
    expect(params[KEY_PARAM]!.Default).toBe(`assets/||${HASH}.zip`);
    expect(params[HASH_PARAM]!.Default).toBe(HASH);
  });

  it('still binds the parameters under --skip-assets, adding no publish node', async () => {
    const stack = legacyStack();
    const graph = await run(stack, { skipAssets: true });
    expect(nodeIds(graph)).toEqual(['stack:Legacy']);
    expect(stack.template.Parameters![BUCKET_PARAM]!.Default).toBe('cdkd-assets-bucket');
  });

  it('forwards ensureRepository from the publish node to the docker push', async () => {
    const graph = await run(legacyStack(), {});
    const publisher = new AssetPublisher();
    const push = vi.fn().mockResolvedValue(undefined);
    (publisher as unknown as { dockerPublisher: { push: typeof push } }).dockerPublisher.push = push;
    const node = nodesOf(graph).get('asset-publish:Legacy:docker:img')!;
    await publisher.executeNode(node as never);
    expect(push).toHaveBeenCalledWith(
      expect.anything(),
      '123456789012',
      'us-east-1',
      'cdkd-asset-img',
      true
    );
  });
});
