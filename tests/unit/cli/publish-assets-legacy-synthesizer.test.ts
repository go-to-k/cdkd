import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Issue #6421: `cdkd publish-assets` of a LegacyStackSynthesizer stack (no
 * asset manifest) publishes the plan its `aws:cdk:asset` metadata builds, to
 * the bucket `cdkd deploy` binds: cdkd asset storage in cdkd-assets mode,
 * the CDKToolkit stack's bucket otherwise.
 */

const synthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

const addAssetsToGraph = vi.hoisted(() => vi.fn());
const addManifestToGraph = vi.hoisted(() => vi.fn());
vi.mock('../../../src/assets/asset-publisher.js', () => ({
  AssetPublisher: vi.fn().mockImplementation(() => ({
    addAssetsToGraph,
    addManifestToGraph,
    executeNode: vi.fn(async () => undefined),
  })),
}));

const cfnSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: vi.fn().mockImplementation(() => ({ send: cfnSend, destroy: vi.fn() })),
  DescribeStacksCommand: vi.fn().mockImplementation((input) => ({ ...input })),
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
const mode = vi.hoisted(() => ({ value: { mode: 'legacy' } as unknown }));
vi.mock('../../../src/assets/asset-storage.js', () => ({
  AssetModeResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async () => mode.value),
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
import { resetLegacyToolkitBucketCache } from '../../../src/assets/legacy-synthesizer-assets.js';

const HASH = 'abc123';
function legacyStack(): StackInfo {
  return {
    stackName: 'Legacy',
    artifactId: 'Legacy',
    displayName: 'Legacy',
    region: 'us-east-1',
    template: { Parameters: { BucketP: { Type: 'String' } }, Resources: {} },
    dependencyNames: [],
    legacyAssets: {
      assemblyDir: '/tmp/cdk.out',
      entries: [
        {
          packaging: 'zip',
          id: HASH,
          path: `asset.${HASH}`,
          sourceHash: HASH,
          s3BucketParameter: 'BucketP',
          s3KeyParameter: 'KeyP',
          artifactHashParameter: 'HashP',
        },
      ],
    },
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

const publishedBuckets = (): unknown[] =>
  addManifestToGraph.mock.calls.map(
    (c) => Object.values((c[1] as { files: Record<string, { destinations: Record<string, { bucketName: string }> }> }).files[HASH]!.destinations)[0]!.bucketName
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetLegacyToolkitBucketCache();
  profile.region = 'us-east-1';
  manifest.value = null;
  mode.value = { mode: 'legacy' };
  stateExistsOwnedBy.mockResolvedValue(false);
  resolveStateBucketWithDefault.mockResolvedValue('cdkd-state-bucket');
  synthesize.mockResolvedValue({ manifest: {}, assemblyDir: '/tmp/cdk.out', stacks: [legacyStack()] });
  addManifestToGraph.mockReturnValue([]);
  cfnSend.mockResolvedValue({
    Stacks: [{ Outputs: [{ OutputKey: 'BucketName', OutputValue: 'cdk-toolkit-bucket' }] }],
  });
});

describe('cdkd publish-assets: LegacyStackSynthesizer stack (issue #6421)', () => {
  it('publishes to cdkd asset storage in cdkd-assets mode, from the assembly directory', async () => {
    mode.value = { mode: 'cdkd-assets', marker: { assetBucket: 'cdkd-asset-bucket' } };
    await runPublish(['Legacy']);
    expect(publishedBuckets()).toEqual(['cdkd-asset-bucket']);
    expect(addManifestToGraph.mock.calls[0]![2]).toMatchObject({
      cdkOutputDir: '/tmp/cdk.out',
      region: 'us-east-1',
      destinationsChosenByCdkd: true,
    });
    expect(cfnSend).not.toHaveBeenCalled();
    expect(addAssetsToGraph).not.toHaveBeenCalled();
  });

  it("publishes to the CDKToolkit stack's bucket in legacy mode", async () => {
    await runPublish(['Legacy']);
    expect(publishedBuckets()).toEqual(['cdk-toolkit-bucket']);
  });

  it('publishes to the CDKToolkit bucket under --use-cdk-bootstrap-assets, without a marker read', async () => {
    mode.value = { mode: 'cdkd-assets', marker: { assetBucket: 'cdkd-asset-bucket' } };
    await runPublish(['Legacy', '--use-cdk-bootstrap-assets']);
    expect(publishedBuckets()).toEqual(['cdk-toolkit-bucket']);
  });
});
