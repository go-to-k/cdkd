import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockS3Send, mockStsSend, mockEnsureAssetStorage } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockStsSend: vi.fn(),
  mockEnsureAssetStorage: vi.fn(),
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

  it('honors --state-bucket for the marker-carrying bucket name', async () => {
    scriptStateBucket(false);

    await runBootstrap(['--region', 'us-east-1', '--state-bucket', 'my-custom-state']);

    const createCall = mockS3Send.mock.calls.find(
      (c) => (c[0] as object).constructor.name === CreateBucketCommand.name
    )![0] as { input: { Bucket: string } };
    expect(createCall.input.Bucket).toBe('my-custom-state');
    expect(mockEnsureAssetStorage).toHaveBeenCalledTimes(1);
  });
});
