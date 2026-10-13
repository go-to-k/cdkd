import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * go-to-k/cdkd#2100: `cdkd publish-assets` for an ENV-AGNOSTIC stack publishes
 * to the region `cdkd deploy` will deploy it in. That region now comes from
 * the AWS profile and is reconciled per stack, so a stack whose state the old
 * `us-east-1` default wrote keeps publishing to us-east-1; with no state
 * bucket to probe, the profile's region is used as-is.
 */

const synthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

const addAssetsToGraph = vi.hoisted(() => vi.fn());
vi.mock('../../../src/assets/asset-publisher.js', () => ({
  AssetPublisher: vi.fn().mockImplementation(() => ({
    addAssetsToGraph,
    executeNode: vi.fn(async () => undefined),
  })),
}));

const resolveStateBucketWithDefault = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.ts',
  resolveStateBucketWithDefault,
  resolveUseCdkBootstrapAssets: vi.fn((cliValue?: boolean) => cliValue === true),
}));

const profile = vi.hoisted(() => ({ region: 'ap-northeast-1' as string | undefined }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    config: {
      region: async (): Promise<string> => {
        if (!profile.region) throw new Error('Region is missing');
        return profile.region;
      },
    },
    send: vi.fn(async () => ({ Account: '111111111111' })),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

// No publishable manifest by default, so no marker read; a case that sets
// `manifest.value` exercises the marker read's region too.
const manifest = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../../src/assets/asset-redirect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/assets/asset-redirect.js')>()),
  loadPublishableAssetManifest: () => manifest.value,
}));
const modeRegions = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/assets/asset-storage.js', () => ({
  AssetModeResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async (region: string) => {
      modeRegions.push(region);
      return { mode: 'legacy' };
    }),
  })),
}));

/** Regions in which a state record for `MyStack` exists. */
const held = vi.hoisted(() => ({ regions: new Set<string>() }));
const stateExistsOwnedBy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({ stateExistsOwnedBy })),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  getAwsClients: vi.fn(() => ({})),
}));

const infoSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import { createPublishAssetsCommand } from '../../../src/cli/commands/publish-assets.js';

/** An env-agnostic stack (no `region`) WITH an asset manifest. */
function envAgnostic(stackName: string): StackInfo {
  return {
    stackName,
    artifactId: stackName,
    displayName: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    assetManifestPath: `/tmp/cdk.out/${stackName}.assets.json`,
  } as StackInfo;
}

async function runPublish(args: string[]): Promise<void> {
  const cmd = createPublishAssetsCommand();
  cmd.exitOverride();
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    writeSpy.mockRestore();
  }
}

/** The region each `addAssetsToGraph` call published `MyStack` to. */
const publishRegions = (): unknown[] =>
  addAssetsToGraph.mock.calls.map((c) => (c[2] as { region?: string }).region);

const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
  profile.region = 'ap-northeast-1';
  held.regions.clear();
  manifest.value = null;
  modeRegions.length = 0;
  stateExistsOwnedBy.mockImplementation(async (_stack: string, region: string) =>
    held.regions.has(region)
  );
  resolveStateBucketWithDefault.mockResolvedValue('cdkd-state-bucket');
  synthesize.mockResolvedValue({ manifest: {}, assemblyDir: '/tmp/cdk.out', stacks: [envAgnostic('MyStack')] });
  // No nodes: the run ends at "(no assets to publish)" without executing a graph.
  addAssetsToGraph.mockReturnValue([]);
});

afterEach(() => {
  if (saved.region === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = saved.region;
  if (saved.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
  else process.env['AWS_DEFAULT_REGION'] = saved.def;
});

describe('cdkd publish-assets for an env-agnostic stack, under a profile region (go-to-k/cdkd#2100)', () => {
  it('publishes to us-east-1 when the old default holds the stack', async () => {
    held.regions.add('us-east-1');
    await runPublish(['MyStack']);

    expect(publishRegions()).toEqual(['us-east-1']);
    expect(stateExistsOwnedBy).toHaveBeenCalledWith('MyStack', 'us-east-1', 'us-east-1');
    expect(resolveStateBucketWithDefault).toHaveBeenCalledWith(undefined, 'ap-northeast-1', 'us-east-1');
    expect(infoSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Continuing to use us-east-1 so the existing stack is not duplicated'
    );
  });

  it('the marker read asks the HELD region too, so the asset mode matches the publish', async () => {
    held.regions.add('us-east-1');
    manifest.value = { files: {}, dockerImages: {} };
    await runPublish(['MyStack']);
    expect(modeRegions).toEqual(['us-east-1']);
    expect(publishRegions()).toEqual(['us-east-1']);
  });

  it('THE OTHER POLARITY of the marker read: a fresh stack reads the profile region\'s marker', async () => {
    manifest.value = { files: {}, dockerImages: {} };
    await runPublish(['MyStack']);
    expect(modeRegions).toEqual(['ap-northeast-1']);
    expect(publishRegions()).toEqual(['ap-northeast-1']);
  });

  it('THE OTHER POLARITY: a fresh stack publishes to the profile region', async () => {
    await runPublish(['MyStack']);

    expect(publishRegions()).toEqual(['ap-northeast-1']);
    // Probed, and found nothing in either region.
    expect(stateExistsOwnedBy).toHaveBeenCalledWith('MyStack', 'us-east-1', 'us-east-1');
  });

  it('a NEW stack whose app siblings are held publishes to us-east-1, where deploy will put it', async () => {
    // Without the `siblings` wiring a standalone publish would send a new
    // stack's assets to the profile region while `cdkd deploy` holds that
    // stack in us-east-1 with its siblings.
    stateExistsOwnedBy.mockImplementation(
      async (stack: string, region: string) => stack === 'Vpc' && region === 'us-east-1'
    );
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [envAgnostic('MyStack'), envAgnostic('Vpc')],
    });
    await runPublish(['MyStack']);

    expect(publishRegions()).toEqual(['us-east-1']);
    expect(infoSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'so the app stays in one region'
    );
  });

  it('with no resolvable state bucket, publishes to the profile region without probing', async () => {
    held.regions.add('us-east-1');
    resolveStateBucketWithDefault.mockRejectedValue(new Error('no state bucket'));
    await runPublish(['MyStack']);

    expect(resolveStateBucketWithDefault).toHaveBeenCalledTimes(1);
    expect(stateExistsOwnedBy).not.toHaveBeenCalled();
    expect(publishRegions()).toEqual(['ap-northeast-1']);
  });

  it('copies an AWS_DEFAULT_REGION answer into AWS_REGION for the SDK (review L1)', async () => {
    process.env['AWS_DEFAULT_REGION'] = 'eu-west-1';
    await runPublish(['MyStack']);
    expect(process.env['AWS_REGION']).toBe('eu-west-1');
    expect(publishRegions()).toEqual(['eu-west-1']);
  });

  it('obeys AWS_REGION as named: no probe, and the assets go to that region', async () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    held.regions.add('us-east-1');
    await runPublish(['MyStack']);

    expect(stateExistsOwnedBy).not.toHaveBeenCalled();
    expect(publishRegions()).toEqual(['ap-northeast-1']);
  });
});
