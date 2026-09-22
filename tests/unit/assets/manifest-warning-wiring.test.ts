/**
 * The CALL SITES of go-to-k/cdkd#3497's warnings, not the warnings themselves.
 *
 * `manifest-passthrough-warnings.test.ts` fences the callees; a probe deleting
 * either of the calls below reddened NOTHING before this file existed, which is
 * the repo's own rule about a probed callee saying nothing about its wiring.
 * Both are load-bearing for a claim made to users: the shim call is what
 * `docs/cli-deploy-safety.md` rests on when it says `cdkd local invoke` and its
 * siblings announce a manifest-chosen command, and the destination loop is the
 * only reader of the bootstrap-shape check, the cross-region fix and the
 * redirect-target disjunct.
 */
import { describe, it, expect, vi, afterEach } from 'vite-plus/test';

const warns: string[] = [];
// Spread the real module: `src/utils/docker-cmd.ts` holds a live binding to
// `isStdoutReservedForPayload`, reached from here through
// `redactDockerArgvValues`. Nothing in this file calls it today, but a
// getLogger-only mock makes the first extension toward a spawn path fail with
// "No export is defined on the mock", pointing at the logger instead of at the
// change.
vi.mock('../../../src/utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
    child: () => ({
      debug: () => {},
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    }),
  }),
}));

const buildContainerImageImpl = vi.fn().mockResolvedValue('img:tag');
vi.mock('cdk-local/internal', () => ({
  architectureToPlatform: (a: string) => a,
  buildContainerImage: (...args: unknown[]) => buildContainerImageImpl(...args),
  LocalInvokeBuildError: class extends Error {},
}));

afterEach(() => {
  warns.length = 0;
  vi.clearAllMocks();
});

describe("the local container-Lambda shim's executable warning", () => {
  it('announces a manifest-chosen command BEFORE delegating to the bundled builder', async () => {
    const { buildContainerImage } = await import('../../../src/local/docker-image-builder.js');

    await buildContainerImage(
      { source: { executable: ['./build.sh', '--tag', 'x'] } } as never,
      '/tmp/cdk.out',
      { architecture: 'x86_64' } as never
    );

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('./build.sh');
    expect(warns[0]).toContain('DOES execute code from it');
    // ...and it really did delegate, so the warning is not instead of the build.
    expect(buildContainerImageImpl).toHaveBeenCalledTimes(1);
  });

  it('stays SILENT for an ordinary directory asset', async () => {
    const { buildContainerImage } = await import('../../../src/local/docker-image-builder.js');

    await buildContainerImage(
      { source: { directory: 'asset.abc123' } } as never,
      '/tmp/cdk.out',
      { architecture: 'x86_64' } as never
    );

    expect(warns).toEqual([]);
  });
});

describe("AssetPublisher's destination warning", () => {
  const manifest = (bucketName: string, region?: string, repositoryName?: string): string =>
    JSON.stringify({
      version: '54.0.0',
      files: {
        h1: {
          source: { path: 'asset.abc123', packaging: 'zip' },
          destinations: { d: { bucketName, objectKey: 'x.zip', ...(region && { region }) } },
        },
      },
      dockerImages: repositoryName
        ? {
            d1: {
              source: { directory: 'asset.def456' },
              destinations: { d: { repositoryName, imageTag: 't' } },
            },
          }
        : {},
    });

  async function addAssets(
    bucketName: string,
    region?: string,
    repositoryName?: string
  ): Promise<void> {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-destwire-'));
    const manifestPath = join(dir, 'Stack.assets.json');
    writeFileSync(manifestPath, manifest(bucketName, region, repositoryName));

    const { AssetPublisher } = await import('../../../src/assets/asset-publisher.js');
    const { WorkGraph } = await import('../../../src/deployment/work-graph.js');
    const { resetDestinationWarnings } = await import(
      '../../../src/assets/manifest-passthrough-warnings.js'
    );
    resetDestinationWarnings();
    new AssetPublisher().addAssetsToGraph(new WorkGraph(), manifestPath, {
      accountId: '123456789012',
      region: 'us-east-1',
    });
  }

  it('names a bucket that is neither bootstrap-shaped nor cdkd-managed', async () => {
    await addAssets('attacker-named-bucket');

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('attacker-named-bucket');
    expect(warns[0]).toContain('with your credentials');
  });

  it('stays SILENT for a bootstrap-shaped bucket', async () => {
    await addAssets('cdk-hnb659fds-assets-123456789012-us-east-1');

    expect(warns).toEqual([]);
  });

  it('names an ECR repository that is not bootstrap-shaped — the DOCKER arm', async () => {
    // Separately written code with its own predicate (`isDefaultBootstrapRepoName`)
    // and its own redirect map (`redirect.repos`), and the two arms have
    // already drifted once in this PR. A fixture with no `dockerImages` never
    // executes it, so deleting the whole loop reddened nothing.
    await addAssets(
      'cdk-hnb659fds-assets-123456789012-us-east-1',
      undefined,
      'attacker-named-repo'
    );

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('attacker-named-repo');
    expect(warns[0]).toContain('repository');
  });

  it('stays SILENT for a bootstrap-shaped ECR repository', async () => {
    await addAssets(
      'cdk-hnb659fds-assets-123456789012-us-east-1',
      undefined,
      'cdk-hnb659fds-container-assets-123456789012-us-east-1'
    );

    expect(warns).toEqual([]);
  });

  it('FLATTENS the destination name against the destination region', async () => {
    // The placeholder spelling is what pins `flattenAssetPlaceholders`'s third
    // argument, and only the placeholder spelling can: a literal name renders
    // identically under either region. The comment at the call site claims a
    // `${AWS::Region}` destination "agrees with itself" — this is that claim.
    await addAssets(
      'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}',
      '${AWS::Region}'
    );

    expect(warns).toEqual([]);
  });

  it("judges a cross-region destination against ITS OWN region", async () => {
    // `buildAssetRedirectMap` skips a cross-region destination, so it arrives
    // here unrewritten. Judged against the DEPLOY region this ordinary
    // bootstrap bucket reads as unrecognized.
    await addAssets('cdk-hnb659fds-assets-123456789012-eu-west-1', 'eu-west-1');

    expect(warns).toEqual([]);
  });
});
