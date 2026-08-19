import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const {
  mockS3Send,
  mockStsSend,
  mockEcrSend,
  mockRebuildClient,
  mockQuestion,
  stateBackendMocks,
  callLog,
  loggerMocks,
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
      deleteRawObjects: vi.fn(),
    },
    callLog,
    // Hoisted rather than per-`getLogger()` so what the command PRINTS is
    // assertable: with the two-probe marker read (issue #1995) the
    // nothing-to-delete message is the user's only signal about which keys
    // were looked at.
    loggerMocks: {
      setLevel: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: mockRebuildClient,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    ...loggerMocks,
    child: () => loggerMocks,
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

// Same treatment for the S3 client: the command classes stay real (the
// `instanceof` assertions depend on them), but the CLIENT is replaced so the
// region it is constructed with is assertable (issue #1995 — this client backs
// the bootstrap-marker read, and SDK endpoint resolution is case-sensitive).
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send, destroy: vi.fn() })),
  };
});

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
  S3Client,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { DeleteRepositoryCommand, ECRClient } from '@aws-sdk/client-ecr';
import { createBootstrapCommand } from '../../../src/cli/commands/bootstrap.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { AwsClients } from '../../../src/utils/aws-clients.js';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { applyRoleArnIfSet } from '../../../src/utils/role-arn.js';

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
  await runDestroyInRegion(REGION, extraArgs);
}

async function runDestroyInRegion(region: string, extraArgs: string[] = []): Promise<void> {
  const cmd = createBootstrapCommand();
  cmd.exitOverride();
  await cmd.parseAsync(['--destroy', '--region', region, ...extraArgs], { from: 'user' });
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
    // Whole-bucket listing ('' prefix): marker only, no state files.
    if (prefix === '') return [MARKER_KEY];
    return [];
  });
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
      if (prefix === '') return [`cdkd/MyStack/${REGION}/state.json`, MARKER_KEY];
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

  it('reference scan covers stacks deployed under a custom --state-prefix', async () => {
    // Live state under a NON-default prefix (other commands accept
    // --state-prefix) must still block the teardown — the scan lists the
    // whole bucket, never just `cdkd/`.
    stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
      if (prefix === '') return [`custom-prefix/PrefixedStack/${REGION}/state.json`, MARKER_KEY];
      return [MARKER_KEY];
    });
    stateBackendMocks.getRawObject.mockImplementation(async (key: string) => {
      if (key === MARKER_KEY) return MARKER_BODY;
      return JSON.stringify({ resources: { Fn: { properties: { Repo: CONTAINER_REPO } } } });
    });

    await expect(runDestroy(['--yes'])).rejects.toThrow(/PrefixedStack \(us-east-1\)/);
    expectNothingDeleted();
  });

  it('--force overrides the deployed-stack reference scan', async () => {
    stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
      if (prefix === '') return [`cdkd/MyStack/${REGION}/state.json`, MARKER_KEY];
      return [MARKER_KEY];
    });
    stateBackendMocks.getRawObject.mockImplementation(async (key: string) => {
      if (key === MARKER_KEY) return MARKER_BODY;
      return JSON.stringify({ resources: { Fn: { properties: { Code: ASSET_BUCKET } } } });
    });

    await runDestroy(['--yes', '--force']);

    // Deletion proceeded; the state scan was skipped entirely (no
    // whole-bucket listing).
    expect(s3CommandNames()).toContain(DeleteBucketCommand.name);
    expect(stateBackendMocks.deleteRawObjects).toHaveBeenCalledWith([MARKER_KEY]);
    expect(stateBackendMocks.listRawKeys).not.toHaveBeenCalledWith('');
  });

  it('threads pagination markers across ListObjectVersions pages when emptying', async () => {
    let listCall = 0;
    mockS3Send.mockImplementation(async (command: object) => {
      callLog.push(`s3:${command.constructor.name}`);
      if (command instanceof ListObjectVersionsCommand) {
        listCall += 1;
        if (listCall === 1) {
          return {
            Versions: [{ Key: 'a', VersionId: 'v1' }],
            IsTruncated: true,
            NextKeyMarker: 'a',
            NextVersionIdMarker: 'v1',
          };
        }
        return { Versions: [{ Key: 'b', VersionId: 'v2' }], IsTruncated: false };
      }
      return {};
    });

    await runDestroy(['--yes']);

    const listInputs = s3Inputs(ListObjectVersionsCommand.name);
    expect(listInputs).toHaveLength(2);
    expect(listInputs[0]).not.toHaveProperty('KeyMarker');
    expect(listInputs[1]).toMatchObject({ KeyMarker: 'a', VersionIdMarker: 'v1' });

    // One DeleteObjects per page, then the bucket delete.
    const deleteInputs = s3Inputs(DeleteObjectsCommand.name);
    expect(deleteInputs).toHaveLength(2);
    expect(deleteInputs[0]!['Delete']).toMatchObject({
      Objects: [{ Key: 'a', VersionId: 'v1' }],
    });
    expect(deleteInputs[1]!['Delete']).toMatchObject({
      Objects: [{ Key: 'b', VersionId: 'v2' }],
    });
    expect(s3CommandNames()).toContain(DeleteBucketCommand.name);
  });

  it('aborts before DeleteBucket and keeps the marker when DeleteObjects reports failures', async () => {
    mockS3Send.mockImplementation(async (command: object) => {
      callLog.push(`s3:${command.constructor.name}`);
      if (command instanceof ListObjectVersionsCommand) {
        return { Versions: [{ Key: 'a', VersionId: 'v1' }], IsTruncated: false };
      }
      if (command instanceof DeleteObjectsCommand) {
        return { Errors: [{ Key: 'a', Code: 'AccessDenied', Message: 'denied' }] };
      }
      return {};
    });

    await expect(runDestroy(['--yes'])).rejects.toThrow(/Failed to delete 1 object/);

    // Never report success while objects remain: no bucket delete, no ECR
    // delete, and the marker survives (delete-last ordering).
    expect(s3CommandNames()).not.toContain(DeleteBucketCommand.name);
    expect(mockEcrSend).not.toHaveBeenCalled();
    expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalled();
  });

  it('is a friendly no-op when the state bucket itself does not exist', async () => {
    stateBackendMocks.getRawObject.mockRejectedValue(
      Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' })
    );

    // No --yes on purpose: the early return must fire before any prompt.
    await runDestroy();

    expectNothingDeleted();
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
      // One stack under the default prefix AND one under a custom
      // --state-prefix: the guard lists the WHOLE bucket, so both must
      // block — a custom-prefix stack slipping past this check would mean
      // deleting its live state.
      stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
        if (prefix === '')
          return [
            `cdkd/MyStack/${REGION}/state.json`,
            'custom-prefix/PrefixedStack/eu-west-1/state.json',
            MARKER_KEY,
          ];
        return [MARKER_KEY];
      });

      const run = runDestroy(['--yes', '--force', '--include-state-bucket']);
      await expect(run).rejects.toThrow(/still have state/);
      await expect(
        runDestroy(['--yes', '--force', '--include-state-bucket'])
      ).rejects.toThrow(/PrefixedStack \(eu-west-1\)/);
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
  // Issue #1995, the second instance of one defect. `--region US-EAST-1` used
  // the raw spelling for BOTH the AWS clients and the marker key, so this
  // command found no marker and reported "nothing to delete" — while the asset
  // bucket and the ECR repository stayed alive and billable. That is strictly
  // worse than gc's version of the same bug, which merely collects nothing.
  describe('--region case (issue #1995)', () => {
    const REGION_UPPER = REGION.toUpperCase();
    const RAW_MARKER_KEY = `cdkd-bootstrap/${REGION_UPPER}.json`;

    /** Every bootstrap-marker key the command probed, in order. */
    function markerProbes(): string[] {
      return stateBackendMocks.getRawObject.mock.calls
        .map((c) => c[0] as string)
        .filter((key) => key.startsWith('cdkd-bootstrap/'));
    }

    function infoLine(needle: string): string | undefined {
      return loggerMocks.info.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes(needle));
    }

    it('uses fixture spellings that actually differ', () => {
      expect(REGION_UPPER).not.toBe(REGION);
      expect(RAW_MARKER_KEY).not.toBe(MARKER_KEY);
    });

    it('canonicalizes the region before building EVERY AWS client', async () => {
      await runDestroyInRegion(REGION_UPPER, ['--yes']);

      const awsClientRegions = vi.mocked(AwsClients).mock.calls.map((c) => c[0]?.region);
      expect(awsClientRegions.length).toBeGreaterThanOrEqual(1);
      for (const r of awsClientRegions) expect(r).toBe(REGION);

      const ecrRegions = vi.mocked(ECRClient).mock.calls.map((c) => c[0]?.region);
      expect(ecrRegions.length).toBeGreaterThanOrEqual(1);
      for (const r of ecrRegions) expect(r).toBe(REGION);

      // Happens before any client is built and takes its own region argument.
      expect(vi.mocked(applyRoleArnIfSet)).toHaveBeenCalledWith(
        expect.objectContaining({ region: REGION })
      );
      // The marker-read client and the state backend, the two the test name
      // was over-claiming until now. Both are separate constructions from the
      // same variable, which is exactly how one gets missed.
      const s3ClientRegions = vi.mocked(S3Client).mock.calls.map((c) => c[0]?.region);
      expect(s3ClientRegions.length).toBeGreaterThanOrEqual(1);
      for (const r of s3ClientRegions) expect(r).toBe(REGION);

      const backendRegions = vi.mocked(S3StateBackend).mock.calls.map((c) => c[2]?.region);
      expect(backendRegions.length).toBeGreaterThanOrEqual(1);
      for (const r of backendRegions) expect(r).toBe(REGION);
    });

    it('DESTROYS the storage a canonical marker names, from an UPPER-cased --region', async () => {
      // The load-bearing arm. Pre-fix this run printed "nothing to delete" and
      // left both resources alive; the assertion is therefore that the teardown
      // really happened, not merely that a marker was found.
      await runDestroyInRegion(REGION_UPPER, ['--yes']);

      expect(s3Inputs(DeleteBucketCommand.name)).toEqual([
        { Bucket: ASSET_BUCKET, ExpectedBucketOwner: ACCOUNT },
      ]);
      const ecrCall = mockEcrSend.mock.calls[0]![0] as {
        input: { repositoryName: string; force: boolean };
      };
      expect(ecrCall.input).toEqual({ repositoryName: CONTAINER_REPO, force: true });
      expect(stateBackendMocks.deleteRawObjects).toHaveBeenCalledWith([MARKER_KEY]);
    });

    it('destroys the storage a RAW upper-cased marker names, and deletes THAT key', async () => {
      // The pre-#1820 population: `AWS_REGION=US-EAST-1 cdkd bootstrap` wrote
      // the marker un-folded. Two properties matter here, and the second is the
      // one the two-probe read introduces: the marker must be FOUND at the raw
      // key, and the teardown must delete the key it was actually read from.
      // Deleting the canonical key instead is a silent no-op that leaves a
      // marker pointing at storage that no longer exists.
      stateBackendMocks.getRawObject.mockImplementation(async (key: string) =>
        key === RAW_MARKER_KEY ? MARKER_BODY : null
      );
      stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
        if (prefix === 'cdkd-bootstrap/') return [RAW_MARKER_KEY];
        if (prefix === '') return [RAW_MARKER_KEY];
        return [];
      });

      await runDestroyInRegion(REGION_UPPER, ['--yes']);

      expect(markerProbes()).toEqual([MARKER_KEY, RAW_MARKER_KEY]);
      expect(s3Inputs(DeleteBucketCommand.name)).toEqual([
        { Bucket: ASSET_BUCKET, ExpectedBucketOwner: ACCOUNT },
      ]);
      expect(stateBackendMocks.deleteRawObjects).toHaveBeenCalledWith([RAW_MARKER_KEY]);
      expect(infoLine('Deleted bootstrap marker')).toContain(RAW_MARKER_KEY);

      // The PLAN line too, not only the deletion. It is printed through
      // `logger.warn` even under `--yes`, and it is the user's one chance to
      // see WHICH marker is about to go — so if it drifts back to the
      // canonical key the user is told a different file than the one deleted,
      // silently. Pinning `deleteRawObjects` alone leaves that half unfenced.
      const planLine = loggerMocks.warn.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes('Bootstrap marker: s3://'));
      expect(planLine).toContain(RAW_MARKER_KEY);
      expect(planLine).not.toContain(MARKER_KEY);
    });

    it('does not probe a second key when the region is already canonical', async () => {
      stateBackendMocks.getRawObject.mockResolvedValue(null);

      await runDestroy(['--yes']);

      expect(markerProbes()).toEqual([MARKER_KEY]);
      expect(infoLine('No bootstrap marker for region')).toContain(`(${MARKER_KEY})`);
      expectNothingDeleted();
    });

    it('names BOTH probed keys when neither holds a marker', async () => {
      stateBackendMocks.getRawObject.mockResolvedValue(null);

      await runDestroyInRegion(REGION_UPPER, ['--yes']);

      expect(markerProbes()).toEqual([MARKER_KEY, RAW_MARKER_KEY]);
      expect(infoLine('No bootstrap marker for region')).toContain(
        `(${MARKER_KEY}, ${RAW_MARKER_KEY})`
      );
      expectNothingDeleted();
    });

    it('does not treat the SAME region under another spelling as an "other" region', async () => {
      // The regression the canonicalization itself introduced:
      // `listOtherBootstrapRegions` compared RAW key segments against the now
      // CANONICAL region, so `--include-state-bucket` refused with
      // STATE_BUCKET_HOLDS_MARKERS naming the very region being torn down and
      // telling the user to run the command they had just run. It aborts at
      // step 3, BEFORE the teardown, so the bucket and repo survived too —
      // which is why this asserts the deletions, not just the absence of a
      // throw.
      stateBackendMocks.getRawObject.mockImplementation(async (key: string) =>
        key === RAW_MARKER_KEY ? MARKER_BODY : null
      );
      stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
        // The marker is keyed by the RAW spelling, as `cdkd bootstrap` wrote it.
        if (prefix === 'cdkd-bootstrap/') return [RAW_MARKER_KEY];
        if (prefix === '') return [RAW_MARKER_KEY];
        return [];
      });

      await runDestroyInRegion(REGION_UPPER, ['--yes', '--include-state-bucket']);

      expect(s3Inputs(DeleteBucketCommand.name)).toEqual([
        { Bucket: ASSET_BUCKET, ExpectedBucketOwner: ACCOUNT },
        { Bucket: `cdkd-state-${ACCOUNT}`, ExpectedBucketOwner: ACCOUNT },
      ]);
      expect(stateBackendMocks.deleteRawObjects).toHaveBeenCalledWith([RAW_MARKER_KEY]);
    });

    it('still refuses --include-state-bucket for a genuinely DIFFERENT region', async () => {
      // The counter-case: the fold must not swallow real other regions. Without
      // it the arm above could pass by disabling the guard entirely.
      stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
        if (prefix === 'cdkd-bootstrap/') return [MARKER_KEY, 'cdkd-bootstrap/EU-WEST-1.json'];
        if (prefix === '') return [MARKER_KEY];
        return [];
      });

      await expect(
        runDestroyInRegion(REGION_UPPER, ['--yes', '--include-state-bucket'])
      ).rejects.toThrow(/EU-WEST-1/);
    });

    it('names the OTHER region by its RAW key spelling, not the folded one', async () => {
      // The error tells the user to run `--destroy --region <r>` for each name
      // it prints, and only the raw spelling reaches a raw-keyed marker:
      // `--region eu-west-1` against `cdkd-bootstrap/EU-WEST-1.json` probes the
      // canonical key, finds raw === canonical, skips the second probe and
      // reports "nothing to delete". Folding the printed name hands the user a
      // command that cannot work — which is what deduping by the folded value
      // and returning THAT would have done.
      stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
        if (prefix === 'cdkd-bootstrap/') {
          // The same other region under BOTH spellings: one entry out, raw.
          return [MARKER_KEY, 'cdkd-bootstrap/EU-WEST-1.json', 'cdkd-bootstrap/eu-west-1.json'];
        }
        if (prefix === '') return [MARKER_KEY];
        return [];
      });

      let err: Error | undefined;
      try {
        await runDestroyInRegion(REGION_UPPER, ['--yes', '--include-state-bucket']);
      } catch (e) {
        err = e as Error;
      }

      expect(err).toBeInstanceOf(CdkdError);
      // Reported once, and in the spelling that actually reaches the marker.
      expect(err!.message).toContain('region(s) EU-WEST-1 are still opted in');
      expect(err!.message).not.toContain('EU-WEST-1, eu-west-1');
    });

    it('warns about a surviving sibling marker instead of deleting it blind', async () => {
      // Both spellings exist. Probe 1 wins, so the raw sibling survives naming
      // storage this run did not destroy. Deleting it would orphan that bucket
      // and repo namelessly (the marker is the only record of custom names),
      // so the command warns and names the re-run.
      stateBackendMocks.getRawObject.mockImplementation(async (key: string) =>
        key === MARKER_KEY || key === RAW_MARKER_KEY ? MARKER_BODY : null
      );

      await runDestroyInRegion(REGION_UPPER, ['--yes']);

      // Only the key actually read is deleted.
      expect(stateBackendMocks.deleteRawObjects).toHaveBeenCalledWith([MARKER_KEY]);
      expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalledWith([RAW_MARKER_KEY]);
      const warning = loggerMocks.warn.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes('second bootstrap marker'));
      expect(warning).toContain(RAW_MARKER_KEY);
      expect(warning).toContain('--destroy');
    });

    it('makes no sibling probe when the region is canonical', async () => {
      // The extra read is scoped to the non-canonical path; the common path
      // must still touch the marker exactly once.
      await runDestroy(['--yes']);

      expect(markerProbes()).toEqual([MARKER_KEY]);
    });

    it('blames the key the marker was actually READ from when it is corrupt', async () => {
      stateBackendMocks.getRawObject.mockImplementation(async (key: string) =>
        key === RAW_MARKER_KEY ? '{ not json' : null
      );

      await expect(runDestroyInRegion(REGION_UPPER, ['--yes'])).rejects.toThrow(RAW_MARKER_KEY);
      expectNothingDeleted();
    });
  });
});
