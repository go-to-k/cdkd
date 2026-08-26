import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

/**
 * Issue [#2029](https://github.com/go-to-k/cdkd/issues/2029) — `cdkd gc`
 * resolved its region as `options.region || AWS_REGION || 'us-east-1'` and
 * passed the result to `new AwsClients({ region })` unconditionally. A user who
 * names NO region — no `--region`, no `AWS_REGION`, but a configured
 * `~/.aws/config` region — got the literal pinned OVER their profile, so gc
 * evaluated (and could DELETE in) us-east-1 while doing nothing about the
 * region they actually work in. Silent in both directions, because us-east-1
 * is a perfectly valid region.
 *
 * gc's region is BOTH a client region and a VALUE (it keys the bootstrap
 * marker), so the assertions below pin them TOGETHER: a fix that resolved the
 * profile for the clients but left the marker key on the literal would read one
 * region's marker and delete against another region's endpoints, which is worse
 * than the bug.
 */
const { mockS3Send, mockStsSend, mockEcrSend, stateBackendMocks, loggerMocks, ambient } =
  vi.hoisted(() => ({
    mockS3Send: vi.fn(),
    mockStsSend: vi.fn(),
    mockEcrSend: vi.fn(),
    // `listRawObjects` / `deleteRawObjects`: issue #2052's response-placeholder
    // sweep runs on every gc, so the backend mock owes them even here, where
    // the subject is region resolution.
    stateBackendMocks: {
      getRawObject: vi.fn(),
      listRawKeys: vi.fn(),
      listRawObjects: vi.fn(),
      deleteRawObjects: vi.fn(),
    },
    loggerMocks: {
      setLevel: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    /**
     * What the AWS SDK's own resolution chain answers — i.e. the profile
     * region. `undefined` models a machine with no region configured anywhere,
     * where the real SDK provider REJECTS rather than resolving.
     */
    ambient: { region: undefined as string | undefined },
  }));

/** Every config an `AwsClients` bag was constructed with, in order. */
const awsClientsConfigs = vi.hoisted(() => [] as { region?: string; profile?: string }[]);
/** Every config an `S3Client` was constructed with, in order. */
const s3ClientConfigs = vi.hoisted(() => [] as { region?: string }[]);

/**
 * `resolveEffectiveRegion` builds its own `STSClient` to ask the AWS SDK's
 * chain which region the PROFILE resolves. Mocking it is not optional hygiene:
 * without it these tests read the developer's real `~/.aws/config`, so they
 * pass on a machine whose profile happens to be us-east-1 and fail on one whose
 * profile is not. Verified by running this file under
 * `AWS_CONFIG_FILE=<a config with region = ap-northeast-1>`.
 */
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      config: {
        region: async (): Promise<string> => {
          // A region-less client REJECTS when the chain answers nothing.
          if (!ambient.region) throw new Error('Region is missing');
          return ambient.region;
        },
      },
      destroy: vi.fn(),
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...loggerMocks, child: () => loggerMocks }),
}));

const applyRoleArnMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: applyRoleArnMock,
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation((config: { region?: string; profile?: string } = {}) => {
    awsClientsConfigs.push(config);
    // The SDK's contract, reproduced: a client CONSTRUCTED with a region
    // reports it; a region-less one resolves through the provider chain and
    // REJECTS when nothing answers. Modelling the rejection matters — the
    // refusal arm below is reachable only through it.
    const regionProvider = async (): Promise<string> => {
      if (config.region) return config.region;
      if (ambient.region) return ambient.region;
      throw new Error('Region is missing');
    };
    return {
      get s3() {
        return { send: mockS3Send, config: { region: regionProvider }, destroy: vi.fn() };
      },
      get sts() {
        return { send: mockStsSend, config: { region: regionProvider }, destroy: vi.fn() };
      },
      destroy: vi.fn(),
    };
  }),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => stateBackendMocks),
}));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation((config: { region?: string }) => {
      s3ClientConfigs.push(config);
      return { send: mockS3Send, destroy: vi.fn() };
    }),
  };
});

vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecr')>();
  return {
    ...actual,
    ECRClient: vi.fn().mockImplementation(() => ({ send: mockEcrSend, destroy: vi.fn() })),
  };
});

vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling: <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) => fn,
  };
});

const { createGcCommand } = await import('../../../src/cli/commands/gc.js');
const { CdkdError } = await import('../../../src/utils/error-handler.js');

const PROFILE_REGION = 'ap-northeast-1';
const MARKER_BODY = JSON.stringify({
  assetBucket: 'my-custom-asset-bucket',
  containerRepo: 'my-custom-container-repo',
  assetSupportVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const savedEnv = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };

/** The bootstrap-marker keys gc actually asked the state backend for. */
function markerKeysRead(): string[] {
  return stateBackendMocks.getRawObject.mock.calls.map((c) => c[0] as string);
}

async function runGc(args: string[]): Promise<void> {
  const cmd = createGcCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' });
}

beforeEach(() => {
  vi.clearAllMocks();
  awsClientsConfigs.length = 0;
  s3ClientConfigs.length = 0;
  ambient.region = undefined;
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
  mockStsSend.mockResolvedValue({ Account: '123456789012' });
  // No marker: gc reports "not opted in" and returns, which keeps every test
  // below focused on the region RESOLUTION rather than on the collection walk.
  stateBackendMocks.getRawObject.mockResolvedValue(null);
  stateBackendMocks.listRawKeys.mockResolvedValue([]);
  stateBackendMocks.listRawObjects.mockResolvedValue([]);
  stateBackendMocks.deleteRawObjects.mockResolvedValue(undefined);
});

afterEach(() => {
  if (savedEnv.region === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedEnv.region;
  if (savedEnv.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
  else process.env['AWS_DEFAULT_REGION'] = savedEnv.def;
});

describe('cdkd gc region resolution (issue #2029)', () => {
  it('keeps the client region and the marker key in AGREEMENT', async () => {
    // The two used to be resolved separately and could disagree, so gc could
    // read one region's marker and delete against another's endpoints.
    ambient.region = PROFILE_REGION;
    await runGc([]);

    const clientRegions = new Set([
      ...awsClientsConfigs.map((c) => c.region).filter(Boolean),
      ...s3ClientConfigs.map((c) => c.region),
    ]);
    expect(clientRegions.size).toBe(1);
    const [only] = [...clientRegions];
    expect(markerKeysRead().at(-1)).toBe(`cdkd-bootstrap/${only}.json`);
  });

  it('uses the PROFILE region when the user names none and nothing exists yet', async () => {
    // Issue #2029's actual fix. Pre-change this was us-east-1 regardless of the
    // profile, while gc's own pre-flight bag already resolved the profile.
    ambient.region = PROFILE_REGION;
    stateBackendMocks.getRawObject.mockResolvedValue(null); // no marker anywhere
    await runGc([]);
    expect(s3ClientConfigs.map((c) => c.region)).toEqual([PROFILE_REGION]);
  });

  it('HOLDS an existing us-east-1 opt-in instead of reporting it not opted in', async () => {
    // The safety half. `cdkd bootstrap` wrote `cdkd-bootstrap/us-east-1.json`
    // under the old default; moving the read side alone would report this
    // region as not opted in while the asset bucket and ECR repo stay alive and
    // billing - the failure a previous attempt at #2029 shipped and had to
    // revert.
    ambient.region = PROFILE_REGION;
    stateBackendMocks.getRawObject.mockImplementation(async (key: string) =>
      key === 'cdkd-bootstrap/us-east-1.json' ? MARKER_BODY : null
    );
    stateBackendMocks.listRawKeys.mockResolvedValue([]);
    mockS3Send.mockResolvedValue({ Contents: [], IsTruncated: false });
    mockEcrSend.mockResolvedValue({ imageDetails: [] });

    await runGc(['--yes']);

    // Assert the bag that does the ASSET work, not the marker client. gc lists
    // and deletes asset objects through `awsClients.s3` (`gc.ts` -
    // `listS3Candidates` / `deleteS3Candidates`), and that bag is built AFTER
    // the reconciliation. `markerS3Client` is deliberately allowed to keep the
    // pre-reconciliation region: it serves the STATE bucket, which is
    // account-scoped and whose real region the backend re-resolves itself.
    // The LAST bag is the operational one - the first is the throwaway the
    // account lookup runs on, before the reconciliation has an answer. Reading
    // the last one discriminates: without the hold there is only ONE bag and it
    // sits at the profile's region.
    expect(awsClientsConfigs.at(-1)?.region).toBe('us-east-1');
    // ...and the user is told, since this is the only place the changed default
    // is visible.
    const said = loggerMocks.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('us-east-1');
    expect(said).toContain(PROFILE_REGION);
    expect(said).toContain('--region');
  });

  it('names the region in the delete plan', async () => {
    // The plan must say which region it is about. It was inferrable only by
    // ACCIDENT before: the default storage name embeds the region, but a
    // bootstrap run with `--asset-bucket` / `--container-repo` prints custom
    // names with no region anywhere, and `-y` then deleted in an unnamed one.
    stateBackendMocks.getRawObject.mockResolvedValue(MARKER_BODY);
    stateBackendMocks.listRawKeys.mockResolvedValue([]);
    mockS3Send.mockImplementation(async (command: object) => {
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [{ Key: 'garbage.zip', Size: 2048, LastModified: new Date('2020-01-01') }],
          IsTruncated: false,
        };
      }
      return {};
    });
    mockEcrSend.mockResolvedValue({ imageDetails: [] });
    await runGc(['--region', 'eu-central-1', '--yes']);
    const planLines = loggerMocks.warn.mock.calls.map((c) => String(c[0]));
    expect(
      planLines.some((l) => l.includes('eu-central-1')),
      `no plan line named the region:\n${planLines.join('\n')}`
    ).toBe(true);
    // The CUSTOM storage name is what makes this load-bearing: it carries no
    // region, so without the added line the plan names none.
    expect(planLines.some((l) => l.includes('my-custom-asset-bucket'))).toBe(true);
  });

  it('folds the ENV half for the role-arn STS client', async () => {
    // gc deliberately skips `foldRegionOption` (so the raw spelling survives for
    // the marker's second probe), which used to leave `applyRoleArnIfSet`
    // reading `canonicalizeRegion(options.region)` - `undefined` when only
    // AWS_REGION names the region. It then built `new STSClient({})` and the SDK
    // read the raw env itself.
    process.env['AWS_REGION'] = 'US-EAST-1';
    await runGc(['--role-arn', 'arn:aws:iam::123456789012:role/R']);
    expect(applyRoleArnMock).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-east-1' })
    );
  });

  it('honors an explicitly named region', async () => {
    await runGc(['--region', 'us-west-2']);
    expect(s3ClientConfigs.map((c) => c.region)).toEqual(['us-west-2']);
    expect(markerKeysRead()).toEqual(['cdkd-bootstrap/us-west-2.json']);
  });

  it('honors AWS_REGION when no flag is given', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    await runGc([]);
    expect(s3ClientConfigs.map((c) => c.region)).toEqual(['eu-west-1']);
  });

  it('folds an upper-cased --region, and STILL probes the raw marker key', async () => {
    // The fold is issue #2065; the second probe is issue #1995 / #2021 and must
    // survive it, because `cdkd bootstrap` derives its own region verbatim
    // (issue #1820) and may have written a raw key.
    await runGc(['--region', 'US-EAST-1']);
    expect(s3ClientConfigs.map((c) => c.region)).toEqual(['us-east-1']);
    expect(markerKeysRead()).toEqual([
      'cdkd-bootstrap/us-east-1.json',
      'cdkd-bootstrap/US-EAST-1.json',
    ]);
  });

  it('reads ONE marker key for the resolved region when no raw spelling exists', async () => {
    // With no region NAMED there is no raw spelling to preserve, so the
    // canonical-then-raw probe collapses to a single read of the region the
    // reconciliation settled on.
    ambient.region = PROFILE_REGION;
    stateBackendMocks.getRawObject.mockResolvedValue(null);
    await runGc([]);
    expect(markerKeysRead().at(-1)).toBe(`cdkd-bootstrap/${PROFILE_REGION}.json`);
  });
});
