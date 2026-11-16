import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const warnDestination = vi.hoisted(() => vi.fn());
vi.mock('../../../src/assets/manifest-passthrough-warnings.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../src/assets/manifest-passthrough-warnings.js')
  >()),
  warnUnrecognizedAssetDestination: warnDestination,
}));
import {
  addStacksToWorkGraph,
  dryRunPredictsAutoCreatedStorage,
} from '../../../src/cli/commands/deploy/work-graph.js';
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

const CDKD_MODE = {
  mode: 'cdkd-assets',
  marker: { assetBucket: 'cdkd-assets-bucket', containerRepo: 'cdkd-container-assets' },
};
let resolve = vi.fn();
beforeEach(() => {
  resolve = vi.fn().mockResolvedValue(CDKD_MODE);
  warnDestination.mockClear();
});

async function run(
  stack: StackInfo,
  options: Partial<DeployCommandOptions>,
  extra: { dryRunPredictsAutoCreatedStorage?: boolean } = {}
) {
  const workGraph = new WorkGraph();
  const assetModeResolver = { resolve } as unknown as AssetModeResolver;
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
    ...extra,
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
          'legacy-synthesizer': {
            bucketName: 'cdkd-assets-bucket',
            objectKey: `${HASH}.zip`,
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
    // cdkd's content-addressed root key, which `cdkd gc` recognises.
    expect(params[KEY_PARAM]!.Default).toBe(`||${HASH}.zip`);
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

  it('warns about no bucket cdkd chose, and judges an image repository by name', async () => {
    const stack = legacyStack();
    stack.legacyAssets!.entries.push({
      packaging: 'container-image',
      id: 'custom',
      path: 'asset.custom',
      sourceHash: 'custom',
      repositoryName: 'prod/app',
      imageTag: 'v2',
    });
    await run(stack, {});
    const calls = warnDestination.mock.calls.map(([arg]) => arg as { kind: string; name: string; recognized: boolean });
    expect(calls.filter((c) => c.kind === 'bucket')).toEqual([]);
    expect(calls.filter((c) => c.kind === 'repository')).toEqual([
      { kind: 'repository', name: 'aws-cdk/assets', recognized: true },
      { kind: 'repository', name: 'prod/app', recognized: false },
    ]);
  });

  it('under --dry-run where storage would be auto-created, binds the default cdkd bucket', async () => {
    resolve.mockResolvedValue({ mode: 'legacy' });
    const stack = legacyStack();
    await run(stack, { dryRun: true }, { dryRunPredictsAutoCreatedStorage: true });
    expect(stack.template.Parameters![BUCKET_PARAM]!.Default).toBe(
      'cdkd-assets-123456789012-us-east-1'
    );
  });

  it('resolves no asset mode for an image-only legacy stack', async () => {
    const stack = legacyStack();
    stack.legacyAssets!.entries.splice(0, 1);
    await run(stack, {});
    expect(resolve).not.toHaveBeenCalled();
  });

  it('warns about aws-cdk/assets under a tag other than the source hash', async () => {
    const stack = legacyStack();
    stack.legacyAssets!.entries.push({
      packaging: 'container-image',
      id: 'retagged',
      path: 'asset.retagged',
      sourceHash: 'retagged',
      repositoryName: 'aws-cdk/assets',
      imageTag: 'latest',
    });
    await run(stack, {});
    const repoCalls = warnDestination.mock.calls
      .map(([arg]) => arg as { kind: string; name: string; recognized: boolean })
      .filter((c) => c.kind === 'repository');
    expect(repoCalls).toEqual([
      { kind: 'repository', name: 'aws-cdk/assets', recognized: true },
      { kind: 'repository', name: 'aws-cdk/assets', recognized: false },
    ]);
  });
});

describe('dryRunPredictsAutoCreatedStorage', () => {
  const on = { dryRun: true, autoAssetStorage: true, skipAssets: false, useCdkBootstrapAssets: false };
  it('holds only when the real deploy would auto-create storage', () => {
    expect(dryRunPredictsAutoCreatedStorage(on)).toBe(true);
    expect(dryRunPredictsAutoCreatedStorage({ ...on, dryRun: undefined })).toBe(false);
    expect(dryRunPredictsAutoCreatedStorage({ ...on, autoAssetStorage: false })).toBe(false);
    expect(dryRunPredictsAutoCreatedStorage({ ...on, skipAssets: true })).toBe(false);
    expect(dryRunPredictsAutoCreatedStorage({ ...on, useCdkBootstrapAssets: true })).toBe(false);
  });
});
