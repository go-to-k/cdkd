import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const {
  mockS3Send,
  mockStsSend,
  mockEcrSend,
  mockRebuildClient,
  mockQuestion,
  stateBackendMocks,
  callLog,
} = vi.hoisted(() => {
  const callLog: string[] = [];
  return {
    mockS3Send: vi.fn(),
    mockStsSend: vi.fn(),
    mockEcrSend: vi.fn(),
    mockRebuildClient: vi.fn(),
    mockQuestion: vi.fn(),
    stateBackendMocks: {
      getRawObject: vi.fn(),
      listRawKeys: vi.fn(),
      listStacks: vi.fn(),
      deleteRawObjects: vi.fn(),
    },
    callLog,
  };
});

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

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => stateBackendMocks),
}));

// Keep the real command classes (DeleteRepositoryCommand etc.) so
// constructor-name assertions work; only the client is replaced.
vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecr')>();
  return {
    ...actual,
    ECRClient: vi.fn().mockImplementation(() => ({ send: mockEcrSend, destroy: vi.fn() })),
  };
});

// Let action errors propagate to parseAsync instead of process.exit-ing, so
// the refusal paths are assertable. Every other export stays real (CdkdError,
// normalizeAwsError are consumed by the code under test).
vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling: <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) => fn,
  };
});

// The interactive y/N prompt (only reached without --yes on a TTY stdin).
vi.mock('node:readline/promises', () => ({
  default: {
    createInterface: () => ({ question: mockQuestion, close: vi.fn() }),
  },
}));

import {
  HeadBucketCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { DeleteRepositoryCommand } from '@aws-sdk/client-ecr';
import { createBootstrapCommand } from '../../../src/cli/commands/bootstrap.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const MARKER_KEY = `cdkd-bootstrap/${REGION}.json`;
// Deliberately NOT the `cdkd-assets-{acct}-{region}` naming convention: the
// teardown must take names from the marker, never recompute them (#1011
// custom-name compatibility).
const ASSET_BUCKET = 'my-custom-asset-bucket';
const CONTAINER_REPO = 'my-custom-container-repo';
const MARKER_BODY = JSON.stringify({
  assetBucket: ASSET_BUCKET,
  containerRepo: CONTAINER_REPO,
  assetSupportVersion: 1,
  createdAt: '2026-07-16T00:00:00.000Z',
});

async function runDestroy(extraArgs: string[] = []): Promise<void> {
  const cmd = createBootstrapCommand();
  cmd.exitOverride();
  await cmd.parseAsync(['--destroy', '--region', REGION, ...extraArgs], { from: 'user' });
}

function s3CommandNames(): string[] {
  return mockS3Send.mock.calls.map((c) => (c[0] as object).constructor.name);
}

function s3Inputs(commandName: string): Record<string, unknown>[] {
  return mockS3Send.mock.calls
    .filter((c) => (c[0] as object).constructor.name === commandName)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}

function expectNothingDeleted(): void {
  expect(s3CommandNames()).not.toContain(DeleteObjectsCommand.name);
  expect(s3CommandNames()).not.toContain(DeleteBucketCommand.name);
  expect(mockEcrSend).not.toHaveBeenCalled();
  expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  callLog.length = 0;
  mockStsSend.mockResolvedValue({ Account: ACCOUNT });
  mockRebuildClient.mockResolvedValue(null);

  // Default scripting: marker present, no stack state, no other regions,
  // asset bucket holds one (unversioned) object, ECR repo exists.
  stateBackendMocks.getRawObject.mockImplementation(async (key: string) =>
    key === MARKER_KEY ? MARKER_BODY : null
  );
  stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
    if (prefix === 'cdkd-bootstrap/') return [MARKER_KEY];
    return [];
  });
  stateBackendMocks.listStacks.mockResolvedValue([]);
  stateBackendMocks.deleteRawObjects.mockImplementation(async () => {
    callLog.push('state:deleteRawObjects');
  });
  mockS3Send.mockImplementation(async (command: object) => {
    callLog.push(`s3:${command.constructor.name}`);
    if (command instanceof ListObjectVersionsCommand) {
      return { Versions: [{ Key: 'asset.zip', VersionId: 'v1' }], IsTruncated: false };
    }
    return {};
  });
  mockEcrSend.mockImplementation(async (command: object) => {
    callLog.push(`ecr:${command.constructor.name}`);
    return {};
  });
});

describe('cdkd bootstrap --destroy', () => {
  it('deletes the asset bucket, then the ECR repo, then the marker LAST', async () => {
    await runDestroy(['--yes']);

    // Names come from the marker (custom names) — never from the
    // cdkd-assets-{acct}-{region} naming convention.
    const deleteBucketInputs = s3Inputs(DeleteBucketCommand.name);
    expect(deleteBucketInputs).toEqual([
      { Bucket: ASSET_BUCKET, ExpectedBucketOwner: ACCOUNT },
    ]);
    const ecrCall = mockEcrSend.mock.calls[0]![0] as {
      input: { repositoryName: string; force: boolean };
    };
    expect(ecrCall.input).toEqual({ repositoryName: CONTAINER_REPO, force: true });
    expect(stateBackendMocks.deleteRawObjects).toHaveBeenCalledWith([MARKER_KEY]);

    // Teardown order: bucket empty+delete → repo delete → marker delete.
    const bucketDeleteIdx = callLog.indexOf(`s3:${DeleteBucketCommand.name}`);
    const repoDeleteIdx = callLog.indexOf(`ecr:${DeleteRepositoryCommand.name}`);
    const markerDeleteIdx = callLog.indexOf('state:deleteRawObjects');
    expect(bucketDeleteIdx).toBeGreaterThanOrEqual(0);
    expect(repoDeleteIdx).toBeGreaterThan(bucketDeleteIdx);
    expect(markerDeleteIdx).toBeGreaterThan(repoDeleteIdx);

    // Create side must NOT have run.
    expect(s3CommandNames()).not.toContain(CreateBucketCommand.name);
  });

  it('passes ExpectedBucketOwner on every asset-bucket S3 call', async () => {
    await runDestroy(['--yes']);

    for (const name of [
      HeadBucketCommand.name,
      ListObjectVersionsCommand.name,
      DeleteObjectsCommand.name,
      DeleteBucketCommand.name,
    ]) {
      const inputs = s3Inputs(name);
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) {
        expect(input['ExpectedBucketOwner']).toBe(ACCOUNT);
      }
    }
  });

  it('empties versioned contents (versions + delete markers) before DeleteBucket', async () => {
    mockS3Send.mockImplementation(async (command: object) => {
      callLog.push(`s3:${command.constructor.name}`);
      if (command instanceof ListObjectVersionsCommand) {
        return {
          Versions: [{ Key: 'a', VersionId: 'v1' }],
          DeleteMarkers: [{ Key: 'b', VersionId: 'v2' }],
          IsTruncated: false,
        };
      }
      return {};
    });

    await runDestroy(['--yes']);

    const deleteInputs = s3Inputs(DeleteObjectsCommand.name);
    expect(deleteInputs).toHaveLength(1);
    expect(deleteInputs[0]!['Delete']).toEqual({
      Objects: [
        { Key: 'a', VersionId: 'v1' },
        { Key: 'b', VersionId: 'v2' },
      ],
      Quiet: true,
    });
    expect(callLog.indexOf(`s3:${DeleteObjectsCommand.name}`)).toBeLessThan(
      callLog.indexOf(`s3:${DeleteBucketCommand.name}`)
    );
  });

  it('refuses when a deployed stack still references the asset storage', async () => {
    stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
      if (prefix === 'cdkd/') return [`cdkd/MyStack/${REGION}/state.json`];
      return [MARKER_KEY];
    });
    stateBackendMocks.getRawObject.mockImplementation(async (key: string) => {
      if (key === MARKER_KEY) return MARKER_BODY;
      return JSON.stringify({ resources: { Fn: { properties: { Code: ASSET_BUCKET } } } });
    });

    await expect(runDestroy(['--yes'])).rejects.toThrow(/MyStack \(us-east-1\)/);
    await expect(runDestroy(['--yes'])).rejects.toThrow(/--force/);
    expectNothingDeleted();
  });

  it('--force overrides the deployed-stack reference scan', async () => {
    stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
      if (prefix === 'cdkd/') return [`cdkd/MyStack/${REGION}/state.json`];
      return [MARKER_KEY];
    });
    stateBackendMocks.getRawObject.mockImplementation(async (key: string) => {
      if (key === MARKER_KEY) return MARKER_BODY;
      return JSON.stringify({ resources: { Fn: { properties: { Code: ASSET_BUCKET } } } });
    });

    await runDestroy(['--yes', '--force']);

    // Deletion proceeded; the state scan was skipped entirely (no
    // `cdkd/`-prefixed listing).
    expect(s3CommandNames()).toContain(DeleteBucketCommand.name);
    expect(stateBackendMocks.deleteRawObjects).toHaveBeenCalledWith([MARKER_KEY]);
    expect(stateBackendMocks.listRawKeys).not.toHaveBeenCalledWith('cdkd/');
  });

  it('is a no-op with an info line when the region has no bootstrap marker', async () => {
    stateBackendMocks.getRawObject.mockResolvedValue(null);

    // No --yes on purpose: the early return must fire BEFORE any prompt.
    await runDestroy();

    expectNothingDeleted();
  });

  it('skips missing pieces idempotently but still deletes the marker', async () => {
    mockS3Send.mockImplementation(async (command: object) => {
      callLog.push(`s3:${command.constructor.name}`);
      if (command instanceof HeadBucketCommand) {
        throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
      }
      return {};
    });
    mockEcrSend.mockImplementation(async (command: object) => {
      callLog.push(`ecr:${command.constructor.name}`);
      throw Object.assign(new Error('RepositoryNotFoundException'), {
        name: 'RepositoryNotFoundException',
      });
    });

    await runDestroy(['--yes']);

    // Bucket empty/delete skipped, repo delete tolerated, marker deleted.
    expect(s3CommandNames()).not.toContain(DeleteBucketCommand.name);
    expect(s3CommandNames()).not.toContain(ListObjectVersionsCommand.name);
    expect(stateBackendMocks.deleteRawObjects).toHaveBeenCalledWith([MARKER_KEY]);
  });

  it('refuses to delete a foreign asset bucket (HeadBucket 403)', async () => {
    mockS3Send.mockImplementation(async (command: object) => {
      callLog.push(`s3:${command.constructor.name}`);
      if (command instanceof HeadBucketCommand) {
        throw Object.assign(new Error('Forbidden'), {
          name: 'Forbidden',
          $metadata: { httpStatusCode: 403 },
        });
      }
      return {};
    });

    await expect(runDestroy(['--yes'])).rejects.toThrow(/not owned by account/);
    // The marker must survive a failed bucket teardown (delete-last order).
    expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalled();
  });

  it('declined confirmation deletes nothing', async () => {
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    mockQuestion.mockResolvedValue('n');
    try {
      await runDestroy();
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    expect(mockQuestion).toHaveBeenCalled();
    expectNothingDeleted();
  });

  it('empty answer at the prompt defaults to NO', async () => {
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    mockQuestion.mockResolvedValue('');
    try {
      await runDestroy();
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    expectNothingDeleted();
  });

  it('non-TTY stdin without --yes is a hard error, not a hang or silent decline', async () => {
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      await expect(runDestroy()).rejects.toThrow(CdkdError);
      await expect(runDestroy()).rejects.toThrow(/--yes/);
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }

    expectNothingDeleted();
  });

  describe('--include-state-bucket', () => {
    it('refuses while any stack state exists (no --force override)', async () => {
      stateBackendMocks.listStacks.mockResolvedValue([
        { stackName: 'MyStack', region: REGION },
      ]);

      await expect(runDestroy(['--yes', '--force', '--include-state-bucket'])).rejects.toThrow(
        /still have state/
      );
      expectNothingDeleted();
    });

    it('refuses while another region is still opted in to asset storage', async () => {
      stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
        if (prefix === 'cdkd-bootstrap/')
          return [MARKER_KEY, 'cdkd-bootstrap/ap-northeast-1.json'];
        return [];
      });

      await expect(runDestroy(['--yes', '--include-state-bucket'])).rejects.toThrow(
        /ap-northeast-1/
      );
      expectNothingDeleted();
    });

    it('empties + deletes the state bucket after the asset teardown', async () => {
      const rebuiltSend = vi.fn().mockImplementation(async (command: object) => {
        callLog.push(`rebuilt:${command.constructor.name}`);
        if (command instanceof ListObjectVersionsCommand) {
          return { Versions: [{ Key: 'k', VersionId: 'v' }], IsTruncated: false };
        }
        return {};
      });
      const rebuiltDestroy = vi.fn();
      mockRebuildClient.mockResolvedValue({ send: rebuiltSend, destroy: rebuiltDestroy });

      await runDestroy(['--yes', '--include-state-bucket']);

      // Asset storage went first, marker included…
      expect(stateBackendMocks.deleteRawObjects).toHaveBeenCalledWith([MARKER_KEY]);
      // …then the state bucket via the bucket-region-resolved client.
      expect(mockRebuildClient).toHaveBeenCalledWith(
        expect.anything(),
        `cdkd-state-${ACCOUNT}`,
        expect.anything()
      );
      const rebuiltNames = rebuiltSend.mock.calls.map((c) => (c[0] as object).constructor.name);
      expect(rebuiltNames).toContain(DeleteBucketCommand.name);
      expect(callLog.indexOf('state:deleteRawObjects')).toBeLessThan(
        callLog.indexOf(`rebuilt:${DeleteBucketCommand.name}`)
      );
      expect(rebuiltDestroy).toHaveBeenCalled();
    });

    it('proceeds to the state bucket even when the region has no marker', async () => {
      stateBackendMocks.getRawObject.mockResolvedValue(null);
      stateBackendMocks.listRawKeys.mockResolvedValue([]);

      await runDestroy(['--yes', '--include-state-bucket']);

      // No asset storage to tear down…
      expect(mockEcrSend).not.toHaveBeenCalled();
      expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalled();
      // …but the state bucket is deleted.
      expect(s3CommandNames()).toContain(DeleteBucketCommand.name);
      expect(s3Inputs(DeleteBucketCommand.name)).toEqual([
        { Bucket: `cdkd-state-${ACCOUNT}`, ExpectedBucketOwner: ACCOUNT },
      ]);
    });
  });

  describe('flag validation', () => {
    it('rejects --include-state-bucket without --destroy', async () => {
      const cmd = createBootstrapCommand();
      cmd.exitOverride();
      await expect(
        cmd.parseAsync(['--region', REGION, '--include-state-bucket'], { from: 'user' })
      ).rejects.toThrow(/requires --destroy/);
    });

    it('rejects --no-assets combined with --destroy', async () => {
      await expect(runDestroy(['--yes', '--no-assets'])).rejects.toThrow(
        /--no-assets cannot be combined with --destroy/
      );
      expectNothingDeleted();
    });
  });
});
