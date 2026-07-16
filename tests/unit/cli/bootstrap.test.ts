import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockS3Send, mockStsSend, mockEnsureAssetStorage, mockRebuildClient } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockStsSend: vi.fn(),
  mockEnsureAssetStorage: vi.fn(),
  mockRebuildClient: vi.fn(),
}));

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

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return { send: mockS3Send, destroy: vi.fn() };
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
// wires it correctly (called / skipped / force flag / identity args).
vi.mock('../../../src/assets/asset-storage.js', () => ({
  ensureAssetStorage: mockEnsureAssetStorage,
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    putRawObject: vi.fn(),
  })),
}));

vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: vi.fn().mockImplementation(() => ({ send: vi.fn(), destroy: vi.fn() })),
}));

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
    mockRebuildClient.mockResolvedValue({ send: mockRebuiltSend, destroy: mockRebuiltDestroy });

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
});
