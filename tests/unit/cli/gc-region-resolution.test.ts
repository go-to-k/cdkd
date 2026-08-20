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
    stateBackendMocks: { getRawObject: vi.fn(), listRawKeys: vi.fn() },
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
});

afterEach(() => {
  if (savedEnv.region === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedEnv.region;
  if (savedEnv.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
  else process.env['AWS_DEFAULT_REGION'] = savedEnv.def;
});

describe('cdkd gc region resolution (issue #2029)', () => {
  it('uses the PROFILE region when the user named none — not the us-east-1 literal', async () => {
    ambient.region = PROFILE_REGION;
    await runGc([]);

    // The discriminator: pre-fix, every one of these was `us-east-1` while the
    // user's profile said ap-northeast-1.
    const configured = awsClientsConfigs.map((c) => c.region).filter(Boolean);
    expect(configured).not.toContain('us-east-1');
    expect(configured).toContain(PROFILE_REGION);
    expect(s3ClientConfigs.map((c) => c.region)).toEqual([PROFILE_REGION]);
    expect(markerKeysRead()).toEqual([`cdkd-bootstrap/${PROFILE_REGION}.json`]);
  });

  it('keeps the client region and the marker key in AGREEMENT', async () => {
    // Fixing only the client half would read one region's marker and delete
    // against another region's endpoints. Pin the pair, not each side.
    ambient.region = 'eu-central-1';
    await runGc([]);

    const clientRegions = new Set([
      ...awsClientsConfigs.map((c) => c.region).filter(Boolean),
      ...s3ClientConfigs.map((c) => c.region),
    ]);
    expect([...clientRegions]).toEqual(['eu-central-1']);
    expect(markerKeysRead()).toEqual(['cdkd-bootstrap/eu-central-1.json']);
  });

  it('builds NO region-less bag for gc to use — a region-less bag\'s members can disagree', async () => {
    // `aws-clients.ts` is explicit that an unconfigured bag's lazy members
    // resolve independently and need not agree. The one region-less bag gc may
    // build is the throwaway PROBE; every bag it keeps must carry a region.
    ambient.region = PROFILE_REGION;
    await runGc([]);
    const regionless = awsClientsConfigs.filter((c) => !c.region);
    expect(regionless).toHaveLength(1);
  });

  it('names the resolved region in the delete plan', async () => {
    // The region can now come from `~/.aws/config`, a source the user never
    // typed on this command line, so the plan has to say which one it is about.
    // It was inferrable only by ACCIDENT before: the default storage name
    // embeds the region, but a bootstrap run with `--asset-bucket` /
    // `--container-repo` prints custom names with no region anywhere, and `-y`
    // then deleted in a region the user was never shown.
    ambient.region = PROFILE_REGION;
    stateBackendMocks.getRawObject.mockResolvedValue(MARKER_BODY);
    stateBackendMocks.listRawKeys.mockResolvedValue([]);
    // One unreferenced, old-enough object, so gc reaches the confirmation
    // plan instead of short-circuiting on "nothing to garbage-collect".
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
    await runGc(['--yes']);
    const planLines = loggerMocks.warn.mock.calls.map((c) => String(c[0]));
    expect(
      planLines.some((l) => l.includes(PROFILE_REGION)),
      `no plan line named the region:\n${planLines.join('\n')}`
    ).toBe(true);
    // ...and the CUSTOM storage name is what makes this load-bearing: it
    // carries no region, so without the added line the plan names none.
    expect(planLines.some((l) => l.includes('my-custom-asset-bucket'))).toBe(true);
  });

  it('folds the ENV half for the role-arn STS client', async () => {
    // gc deliberately skips `foldRegionOption` (so the raw spelling survives
    // for the marker's second probe), which used to leave `applyRoleArnIfSet`
    // reading `canonicalizeRegion(options.region)` — `undefined` when only
    // AWS_REGION names the region. `applyRoleArnIfSet` then built
    // `new STSClient({})` and the SDK read the raw env itself.
    ambient.region = PROFILE_REGION;
    process.env['AWS_REGION'] = 'US-EAST-1';
    await runGc(['--role-arn', 'arn:aws:iam::123456789012:role/R']);
    expect(applyRoleArnMock).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-east-1' })
    );
  });

  /**
   * Counter-cases: the NAMED-region paths, which this change must leave
   * byte-identical.
   *
   * Stated plainly because a review round caught them presented as if they
   * proved the fix: they do NOT discriminate. Pre-fix `gc.ts` already folded
   * (`canonicalizeRegion(rawRegion)`) and already probed both marker keys, so
   * every assertion below passes against the broken code too. They earn their
   * place as the other POLARITY — the half of the repo's both-polarities bar
   * that pins "nothing else moved" — not as evidence.
   */
  it('counter-case: an explicitly named region still wins over the profile', async () => {
    ambient.region = PROFILE_REGION;
    await runGc(['--region', 'us-west-2']);
    expect(s3ClientConfigs.map((c) => c.region)).toEqual(['us-west-2']);
    expect(markerKeysRead()).toEqual(['cdkd-bootstrap/us-west-2.json']);
  });

  it('counter-case: AWS_REGION still wins over the profile when no flag is given', async () => {
    ambient.region = PROFILE_REGION;
    process.env['AWS_REGION'] = 'eu-west-1';
    await runGc([]);
    expect(s3ClientConfigs.map((c) => c.region)).toEqual(['eu-west-1']);
  });

  it('counter-case: an upper-cased --region folds and STILL probes the raw marker key', async () => {
    // The fold is issue #2065; the second probe is issue #1995 / #2021 and must
    // survive it, because `cdkd bootstrap` derives its own region verbatim
    // (issue #1820) and may have written a raw key.
    ambient.region = PROFILE_REGION;
    await runGc(['--region', 'US-EAST-1']);
    expect(s3ClientConfigs.map((c) => c.region)).toEqual(['us-east-1']);
    expect(markerKeysRead()).toEqual([
      'cdkd-bootstrap/us-east-1.json',
      'cdkd-bootstrap/US-EAST-1.json',
    ]);
  });

  it('reads ONE marker key when no region was named — there is no raw spelling', async () => {
    ambient.region = PROFILE_REGION;
    await runGc([]);
    expect(markerKeysRead()).toEqual([`cdkd-bootstrap/${PROFILE_REGION}.json`]);
  });

  it('REFUSES rather than guessing when nothing resolves a region', async () => {
    // gc deletes. A user with no region configured anywhere has not said where,
    // and inventing us-east-1 for them is the defect, not a safe fallback.
    ambient.region = undefined;
    await expect(runGc([])).rejects.toThrow(CdkdError);
    await expect(runGc([])).rejects.toThrow(/will not guess one/);
    // ...and it refuses BEFORE touching anything.
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockEcrSend).not.toHaveBeenCalled();
    expect(stateBackendMocks.getRawObject).not.toHaveBeenCalled();
  });
});
