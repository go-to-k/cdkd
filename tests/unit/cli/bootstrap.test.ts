import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const {
  mockS3Send,
  mockStsSend,
  mockEnsureAssetStorage,
  mockRebuildClient,
  sdkChain,
  existingMarkers,
} = vi.hoisted(
  () => ({
    mockS3Send: vi.fn(),
    mockStsSend: vi.fn(),
    mockEnsureAssetStorage: vi.fn(),
    mockRebuildClient: vi.fn(),
    // What the AWS SDK's own region chain resolves to (the profile's
    // `region =` line / AWS_DEFAULT_REGION) when `--region` is NOT passed.
    // Mutable so a test can model a non-commercial profile.
    sdkChain: { region: 'us-east-1' },
    /** Marker key -> body, for the issue-#2029 reconciliation probe. */
    existingMarkers: new Map<string, string>(),
  })
);

// The command resolves the state bucket's ACTUAL region before any
// state-bucket S3 call (the bucket may live in a different region than
// --region — see the cross-region test below). Default: `null` = "already in
// the right region, keep the original client".
vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: mockRebuildClient,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

// `region` is threaded through the client the way the real `AwsClients` does:
// present only when `--region` was passed, otherwise resolved by the SDK chain
// (modelled here by `sdkChainRegion`, which stands in for the profile's region).
// The bucket-policy partition is derived from `s3.config.region()`, so this
// distinction is load-bearing — see the issue #1794 regression test below.
// Issue #2029: `resolveEffectiveRegion` builds its OWN `STSClient` to ask the
// SDK chain what the profile resolves — it does not go through `AwsClients`. So
// `sdkChain` has to drive BOTH mocks, or a test that names no region reads the
// developer's real `~/.aws/config`: green on a us-east-1 machine, red on any
// other. That is the third suite in this change to need this, which is why it
// is spelled out rather than left as a one-line mock.
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation((opts?: { region?: string }) => ({
      send: mockStsSend,
      config: { region: async () => opts?.region ?? sdkChain.region },
      destroy: vi.fn(),
    })),
  };
});

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation((opts?: { region?: string }) => ({
    get s3() {
      return {
        send: mockS3Send,
        destroy: vi.fn(),
        config: { region: async () => opts?.region ?? sdkChain.region },
      };
    },
    get sts() {
      return { send: mockStsSend, destroy: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

// The asset-storage creation leg is unit-tested in
// tests/unit/assets/asset-storage.test.ts — here we only assert the command
// wires it correctly (called / skipped / force flag / identity args). The
// name validators stay real so the pre-AWS rejection paths are exercised.
vi.mock('../../../src/assets/asset-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/assets/asset-storage.js')>();
  return {
    ...actual,
    ensureAssetStorage: mockEnsureAssetStorage,
  };
});

// Let action errors propagate to parseAsync instead of process.exit-ing, so
// the flag-combination / validation refusal paths are assertable. Every
// other export stays real (CdkdError, normalizeAwsError are consumed by the
// code under test).
vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling: <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) => fn,
  };
});

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    putRawObject: vi.fn(),
    // Load-bearing since issue #2029: the region reconciliation probes for an
    // existing bootstrap marker through this. Without it the call is
    // `undefined(...)`, which the reconciliation's catch arm reads as "no
    // marker" — so every test would pass through the ERROR path rather than
    // the real one, and the hold could never be exercised.
    getRawObject: vi.fn(async (key: string) => existingMarkers.get(key) ?? null),
    // The probe backend releases its client through the backend, not through
    // its own reference: the backend OWNS the client and may replace it.
    destroyClient: vi.fn(),
  })),
}));

// Keep the command classes real — the (partially real) asset-storage module
// imports them at load time.
vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecr')>();
  return {
    ...actual,
    ECRClient: vi.fn().mockImplementation(() => ({ send: vi.fn(), destroy: vi.fn() })),
  };
});

import {
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { createBootstrapCommand } from '../../../src/cli/commands/bootstrap.js';

const ACCOUNT = '123456789012';

async function runBootstrap(args: string[]): Promise<void> {
  const cmd = createBootstrapCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' });
}

function s3CommandNames(): string[] {
  return mockS3Send.mock.calls.map((c) => (c[0] as object).constructor.name);
}

/** Script the state-bucket HeadBucket probe: exists (200) or missing (404). */
function scriptStateBucket(exists: boolean): void {
  mockS3Send.mockImplementation(async (command: object) => {
    if (command instanceof HeadBucketCommand && !exists) {
      throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
    }
    return {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStsSend.mockResolvedValue({ Account: ACCOUNT });
  mockRebuildClient.mockResolvedValue(null);
  sdkChain.region = 'us-east-1';
  existingMarkers.clear();
  mockEnsureAssetStorage.mockResolvedValue({
    assetBucket: `cdkd-assets-${ACCOUNT}-us-east-1`,
    containerRepo: `cdkd-container-assets-${ACCOUNT}-us-east-1`,
  });
});

describe('cdkd bootstrap', () => {
  it('creates + configures the state bucket and sets up asset storage on a fresh account', async () => {
    scriptStateBucket(false);

    await runBootstrap(['--region', 'us-east-1']);

    const names = s3CommandNames();
    expect(names).toContain(CreateBucketCommand.name);
    expect(names).toContain(PutBucketVersioningCommand.name);
    expect(names).toContain(PutBucketEncryptionCommand.name);
    expect(names).toContain(PutBucketPolicyCommand.name);
    // Squatting hardening (PR 1015): every state-bucket call carries the
    // caller account as ExpectedBucketOwner (CreateBucket takes no such
    // parameter — creating is owner-safe by nature).
    for (const c of mockS3Send.mock.calls) {
      const cmd = c[0] as { constructor: { name: string }; input: Record<string, unknown> };
      if (cmd.constructor.name === CreateBucketCommand.name) {
        expect(cmd.input).not.toHaveProperty('ExpectedBucketOwner');
      } else {
        expect(cmd.input.ExpectedBucketOwner).toBe(ACCOUNT);
      }
    }

    expect(mockEnsureAssetStorage).toHaveBeenCalledTimes(1);
    expect(mockEnsureAssetStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT,
        region: 'us-east-1',
        force: false,
      })
    );
  });

  it('skips asset storage under --no-assets', async () => {
    scriptStateBucket(false);

    await runBootstrap(['--region', 'us-east-1', '--no-assets']);

    expect(mockEnsureAssetStorage).not.toHaveBeenCalled();
    // State bucket setup still ran.
    expect(s3CommandNames()).toContain(CreateBucketCommand.name);
  });

  it('opts an existing account into asset storage WITHOUT --force (upgrade path)', async () => {
    scriptStateBucket(true);

    await runBootstrap(['--region', 'us-east-1']);

    // State bucket reconfiguration skipped (no versioning/encryption/policy PUTs)...
    const names = s3CommandNames();
    expect(names).not.toContain(CreateBucketCommand.name);
    expect(names).not.toContain(PutBucketVersioningCommand.name);
    expect(names).not.toContain(PutBucketEncryptionCommand.name);
    expect(names).not.toContain(PutBucketPolicyCommand.name);
    // ...but the asset storage leg still runs — this is the documented way
    // for an existing user to opt a region in.
    expect(mockEnsureAssetStorage).toHaveBeenCalledTimes(1);
  });

  it('keeps the pre-#1002 early return for an existing bucket under --no-assets', async () => {
    scriptStateBucket(true);

    await runBootstrap(['--region', 'us-east-1', '--no-assets']);

    expect(s3CommandNames()).toEqual([HeadBucketCommand.name]);
    expect(mockEnsureAssetStorage).not.toHaveBeenCalled();
  });

  it('reconfigures the existing state bucket and forces asset reconfig under --force', async () => {
    scriptStateBucket(true);

    await runBootstrap(['--region', 'us-east-1', '--force']);

    const names = s3CommandNames();
    expect(names).toContain(PutBucketVersioningCommand.name);
    expect(names).toContain(PutBucketEncryptionCommand.name);
    expect(names).toContain(PutBucketPolicyCommand.name);
    expect(mockEnsureAssetStorage).toHaveBeenCalledWith(
      expect.objectContaining({ force: true })
    );
  });

  it('routes state-bucket calls through the bucket-region client when --region differs from the bucket region (upgrade path)', async () => {
    // Existing state bucket in us-east-1; user opts ap-northeast-1 into
    // asset storage. Without the bucket-region rebuild, HeadBucket against
    // the ap-northeast-1 client 301s and bootstrap dies before the asset
    // storage leg (seen live, 2026-07-16).
    const mockRebuiltSend = vi.fn().mockResolvedValue({});
    const mockRebuiltDestroy = vi.fn();
    mockRebuildClient.mockResolvedValue({
      send: mockRebuiltSend,
      destroy: mockRebuiltDestroy,
      // The rebuilt client reports the BUCKET's region, not `--region` — that
      // is the whole point of the rebuild, and it is what the bucket policy's
      // partition is derived from.
      config: { region: async () => 'us-east-1' },
    });

    await runBootstrap(['--region', 'ap-northeast-1', '--profile', 'dev']);

    expect(mockRebuildClient).toHaveBeenCalledWith(
      expect.anything(),
      `cdkd-state-${ACCOUNT}`,
      expect.objectContaining({ profile: 'dev' })
    );
    // Every STATE-bucket call went through the rebuilt (bucket-region)
    // client — the --region client made no state-bucket S3 call.
    expect(mockRebuiltSend.mock.calls.map((c) => (c[0] as object).constructor.name)).toContain(
      HeadBucketCommand.name
    );
    expect(mockS3Send).not.toHaveBeenCalled();
    // The asset-storage leg still runs against --region.
    expect(mockEnsureAssetStorage).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'ap-northeast-1' })
    );
    // The command owns the rebuilt client and must destroy it on the way out.
    expect(mockRebuiltDestroy).toHaveBeenCalled();
  });

  it('threads --asset-bucket / --container-repo into ensureAssetStorage (issue #1011)', async () => {
    scriptStateBucket(false);

    await runBootstrap([
      '--region',
      'us-east-1',
      '--asset-bucket',
      'my-org-cdkd-assets',
      '--container-repo',
      'my-org/cdkd-assets',
    ]);

    expect(mockEnsureAssetStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        assetBucketName: 'my-org-cdkd-assets',
        containerRepoName: 'my-org/cdkd-assets',
      })
    );
  });

  it('passes NO custom-name fields to ensureAssetStorage when the flags are absent', async () => {
    scriptStateBucket(false);

    await runBootstrap(['--region', 'us-east-1']);

    const call = mockEnsureAssetStorage.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('assetBucketName');
    expect(call).not.toHaveProperty('containerRepoName');
  });

  it('bootstraps the PROFILE region when the user names none (issue #2029)', async () => {
    // The WRITE side of the marker pair. `cdkd gc` and `cdkd bootstrap
    // --destroy` READ the key this command writes, so all three resolve through
    // one function — a previous attempt moved only the readers and had to be
    // reverted. Pre-change this wrote `cdkd-bootstrap/us-east-1.json` no matter
    // what the profile said.
    scriptStateBucket(false);
    sdkChain.region = 'ap-northeast-1';

    await runBootstrap([]);

    expect(mockEnsureAssetStorage).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'ap-northeast-1' })
    );
  });

  it('HOLDS an existing us-east-1 opt-in rather than creating a second one', async () => {
    // Without the hold, a user with a non-us-east-1 profile who bootstrapped
    // under the old default would get a SECOND marker and a second set of
    // storage on their next `cdkd bootstrap`, while the first set kept billing.
    scriptStateBucket(true);
    sdkChain.region = 'ap-northeast-1';
    existingMarkers.set(
      'cdkd-bootstrap/us-east-1.json',
      JSON.stringify({
        assetBucket: 'cdkd-assets-123456789012-us-east-1',
        containerRepo: 'cdkd-container-assets-123456789012-us-east-1',
        assetSupportVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    );

    await runBootstrap([]);

    expect(mockEnsureAssetStorage).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-east-1' })
    );
  });

  it('counter-case: a NAMED region is obeyed even when a legacy marker exists', async () => {
    // `--region X` means bootstrap X, never "guess what I meant".
    scriptStateBucket(true);
    sdkChain.region = 'ap-northeast-1';
    existingMarkers.set('cdkd-bootstrap/us-east-1.json', '{"assetSupportVersion":1}');

    await runBootstrap(['--region', 'eu-west-1']);

    expect(mockEnsureAssetStorage).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'eu-west-1' })
    );
  });

  it('sends the RAW spelling to ensureAssetStorage and the FOLDED one everywhere else', async () => {
    // Issue #2065's one deliberate exception, and the place a first cut of it
    // over-applied. `ensureAssetStorage`'s existing-marker READ is paired with
    // its marker WRITE (`src/assets/asset-storage.ts`), so that ONE argument
    // keeps the user's exact spelling until issue #1820 aligns the write side.
    //
    // Every OTHER reader wants it canonical, and two fail loudly otherwise: the
    // `CreateBucket` guard compares `region !== 'us-east-1'`, so a raw
    // `US-EAST-1` would send a `LocationConstraint` for the one region S3
    // forbids it in (issue #1888's defect), and the ECR / S3 / state-backend
    // clients would sign for a region SigV4 rejects.
    scriptStateBucket(false);

    await runBootstrap(['--region', 'US-EAST-1']);

    expect(mockEnsureAssetStorage).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'US-EAST-1' })
    );
    const createBucket = mockS3Send.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
      .find((c) => c.constructor.name === 'CreateBucketCommand');
    expect(createBucket, 'no CreateBucket issued - anchor drifted?').toBeDefined();
    // us-east-1 is the API default and passing it explicitly is an error, so
    // the CANONICAL comparison must win: no constraint at all.
    expect(createBucket!.input).not.toHaveProperty('CreateBucketConfiguration');
  });

  it('counter-case: an already-canonical region sends no constraint either', async () => {
    scriptStateBucket(false);
    await runBootstrap(['--region', 'us-east-1']);
    expect(mockEnsureAssetStorage).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-east-1' })
    );
    const createBucket = mockS3Send.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
      .find((c) => c.constructor.name === 'CreateBucketCommand');
    expect(createBucket!.input).not.toHaveProperty('CreateBucketConfiguration');
  });

  it('rejects --asset-bucket / --container-repo with --no-assets before any AWS call', async () => {
    await expect(
      runBootstrap(['--region', 'us-east-1', '--no-assets', '--asset-bucket', 'my-bucket'])
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(
      runBootstrap(['--region', 'us-east-1', '--no-assets', '--container-repo', 'my-repo'])
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockEnsureAssetStorage).not.toHaveBeenCalled();
  });

  it('rejects --asset-bucket / --container-repo with --destroy (teardown reads names from the marker)', async () => {
    await expect(
      runBootstrap(['--region', 'us-east-1', '--destroy', '--asset-bucket', 'my-bucket'])
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(
      runBootstrap(['--region', 'us-east-1', '--destroy', '--container-repo', 'my-repo'])
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('rejects an invalid --asset-bucket name before any AWS call', async () => {
    await expect(
      runBootstrap(['--region', 'us-east-1', '--asset-bucket', 'Bad_Bucket_Name'])
    ).rejects.toMatchObject({ code: 'INVALID_ASSET_STORAGE_NAME' });

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockEnsureAssetStorage).not.toHaveBeenCalled();
  });

  it('rejects an invalid --container-repo name before any AWS call', async () => {
    await expect(
      runBootstrap(['--region', 'us-east-1', '--container-repo', 'Bad//Repo'])
    ).rejects.toMatchObject({ code: 'INVALID_ASSET_STORAGE_NAME' });

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockEnsureAssetStorage).not.toHaveBeenCalled();
  });

  it('rejects an explicit empty value (--asset-bucket "") instead of treating it as flag-absent', async () => {
    await expect(
      runBootstrap(['--region', 'us-east-1', '--asset-bucket', ''])
    ).rejects.toMatchObject({ code: 'INVALID_ASSET_STORAGE_NAME' });

    expect(mockEnsureAssetStorage).not.toHaveBeenCalled();
  });

  it('honors --state-bucket for the marker-carrying bucket name', async () => {
    scriptStateBucket(false);

    await runBootstrap(['--region', 'us-east-1', '--state-bucket', 'my-custom-state']);

    const createCall = mockS3Send.mock.calls.find(
      (c) => (c[0] as object).constructor.name === CreateBucketCommand.name
    )![0] as { input: { Bucket: string } };
    expect(createCall.input.Bucket).toBe('my-custom-state');
    expect(mockEnsureAssetStorage).toHaveBeenCalledTimes(1);
    // The marker-carrying state backend must target the SAME custom bucket.
    expect(vi.mocked(S3StateBackend)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bucket: 'my-custom-state' }),
      expect.anything()
    );
  });

  // Issue #1794: the state-bucket policy hardcoded `arn:aws:s3:::` regardless
  // of partition. In `aws-cn` the bucket is `arn:aws-cn:s3:::…`, so the Deny
  // statement matched NO resource — PutBucketPolicy still succeeded and
  // bootstrap still printed its checkmark, over a bucket with no effective
  // deny at all.
  it('derives the state-bucket policy ARN partition from --region', async () => {
    scriptStateBucket(false);

    await runBootstrap(['--region', 'cn-north-1']);

    const policyCall = mockS3Send.mock.calls.find(
      (c) => (c[0] as object).constructor.name === PutBucketPolicyCommand.name
    )![0] as { input: { Policy: string } };
    const bucket = `cdkd-state-${ACCOUNT}`;

    expect(JSON.parse(policyCall.input.Policy).Statement[0].Resource).toEqual([
      `arn:aws-cn:s3:::${bucket}`,
      `arn:aws-cn:s3:::${bucket}/*`,
    ]);
    expect(policyCall.input.Policy).not.toContain('arn:aws:s3:::');
  });

  // The counter-case BOTH PR reviewers independently found: the first cut of
  // the #1794 fix derived the partition from the command's `region` variable,
  // which is `options.region || AWS_REGION || 'us-east-1'` — a HARDCODED
  // commercial fallback. `AwsClients` meanwhile omits `region` entirely when
  // `--region` is absent, letting the SDK chain read the profile's region. So a
  // GovCloud user with `region = us-gov-west-1` in ~/.aws/config, no
  // AWS_REGION and no --region reproduced #1794 exactly: an `arn:aws:` deny on
  // an `aws-us-gov` bucket, on the fix's own path. Deriving from the client
  // that writes the policy is what closes it.
  it('derives the partition from the profile region when --region is absent', async () => {
    sdkChain.region = 'us-gov-west-1';
    scriptStateBucket(false);

    await runBootstrap([]);

    const policyCall = mockS3Send.mock.calls.find(
      (c) => (c[0] as object).constructor.name === PutBucketPolicyCommand.name
    )![0] as { input: { Policy: string } };
    const bucket = `cdkd-state-${ACCOUNT}`;

    expect(JSON.parse(policyCall.input.Policy).Statement[0].Resource).toEqual([
      `arn:aws-us-gov:s3:::${bucket}`,
      `arn:aws-us-gov:s3:::${bucket}/*`,
    ]);
    expect(policyCall.input.Policy).not.toContain('arn:aws:s3:::');
  });

  it('keeps the commercial state-bucket policy ARNs unchanged', async () => {
    scriptStateBucket(false);

    await runBootstrap(['--region', 'us-east-1']);

    const policyCall = mockS3Send.mock.calls.find(
      (c) => (c[0] as object).constructor.name === PutBucketPolicyCommand.name
    )![0] as { input: { Policy: string } };
    const bucket = `cdkd-state-${ACCOUNT}`;

    expect(JSON.parse(policyCall.input.Policy).Statement[0].Resource).toEqual([
      `arn:aws:s3:::${bucket}`,
      `arn:aws:s3:::${bucket}/*`,
    ]);
  });
});
