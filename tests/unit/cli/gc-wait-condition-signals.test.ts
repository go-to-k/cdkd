import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6699 — `cdkd gc` sweeps orphaned wait condition signal objects
 * (`wait-condition-signals/<logicalId>-<uuid>.json`) from the STATE bucket.
 *
 * Every positive asserts the key reached the store's delete; every keep case
 * runs beside a key that IS deleted, so a sweep that never fires cannot pass
 * it. The store's delete itself (key + noncurrent versions + delete marker) is
 * exercised unmocked in `wait-condition-signal-store.test.ts`.
 */

const { mockStsSend, mockS3Send, mockEcrSend, mockRemove, stateBackendMocks, loggerMocks } =
  vi.hoisted(() => ({
    mockStsSend: vi.fn(),
    mockS3Send: vi.fn(),
    mockEcrSend: vi.fn(),
    mockRemove: vi.fn(),
    stateBackendMocks: {
      getRawObject: vi.fn(),
      listRawKeys: vi.fn(),
      listRawObjects: vi.fn(),
      deleteRawObjects: vi.fn(),
      purgeNoncurrentVersions: vi.fn(),
    },
    loggerMocks: {
      setLevel: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...loggerMocks, child: () => loggerMocks }),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn(() => ({
    get s3() {
      return { send: mockS3Send, config: { region: async () => REGION }, destroy: vi.fn() };
    },
    get sts() {
      return { send: mockStsSend, config: { region: async () => REGION }, destroy: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => stateBackendMocks),
}));

// The store's classifier and key predicate stay REAL; only its S3 delete is
// replaced, so the referenced-set logic runs against the producer's own rules.
vi.mock('../../../src/provisioning/wait-condition-signal-store.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/wait-condition-signal-store.js')>();
  return {
    ...actual,
    WaitConditionSignalStore: vi.fn(() => ({
      setBucket: vi.fn(),
      removeSignalObjects: mockRemove,
    })),
  };
});

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn(() => ({ send: mockS3Send, destroy: vi.fn() })),
  };
});

vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecr')>();
  return {
    ...actual,
    ECRClient: vi.fn(() => ({ send: mockEcrSend, destroy: vi.fn() })),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn(() => ({
      send: mockStsSend,
      config: { region: async () => REGION },
      destroy: vi.fn(),
    })),
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
const { signalSweepPrefix, deleteWaitConditionSignalCandidates } = await import(
  '../../../src/cli/commands/gc/wait-condition-signals.js'
);
const { WAIT_CONDITION_SIGNAL_PREFIX } = await import('../../../src/state/state-prefix.js');

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const STATE_BUCKET = `cdkd-state-${ACCOUNT}`;
const MARKER_KEY = `cdkd-bootstrap/${REGION}.json`;
const MARKER_BODY = JSON.stringify({
  assetBucket: 'asset-bucket',
  containerRepo: 'container-repo',
  assetSupportVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const HANDLE = 'AWS::CloudFormation::WaitConditionHandle';

const OLD = new Date(Date.now() - 90 * 24 * 3600_000);
const RECENT = new Date(Date.now() - 60_000);

/** Producer-shaped keys (`signalKeyFor`): `<logicalId>-<uuid>.json`. */
const ORPHAN_KEY = `${WAIT_CONDITION_SIGNAL_PREFIX}/WaitHandleA1-0b6f3c1e-1f2a-4c3d-8e9f-0123456789ab.json`;
const LIVE_KEY = `${WAIT_CONDITION_SIGNAL_PREFIX}/WaitHandleB2-1c7a4d2f-2a3b-4d4e-9fa0-123456789abc.json`;

const STATE_KEY = `cdkd/App/${REGION}/state.json`;
const CHILD_KEY = `cdkd/App~Nested/${REGION}/state.json`;

function urlFor(key: string): string {
  return (
    `https://s3.${REGION}.amazonaws.com/${STATE_BUCKET}/${key}` +
    `?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc`
  );
}

function handleRecord(key: string): Record<string, unknown> {
  return { resourceType: HANDLE, physicalId: urlFor(key), properties: {} };
}

let stateFiles: Record<string, string>;
let lockKeysAfterScan: string[];

function signalObjects(objects: Array<{ key: string; lastModified: Date; size: number }>): void {
  stateBackendMocks.listRawObjects.mockImplementation(async (prefix: string) =>
    prefix === `${WAIT_CONDITION_SIGNAL_PREFIX}/` ? objects : []
  );
}

async function runGc(args: string[]): Promise<void> {
  const cmd = createGcCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' });
}

function removedKeys(): string[] {
  return mockRemove.mock.calls.map((c) => c[0] as string);
}

function infoText(): string {
  return loggerMocks.info.mock.calls.map((c) => String(c[0])).join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  stateFiles = {};
  lockKeysAfterScan = [];
  mockStsSend.mockResolvedValue({ Account: ACCOUNT });
  let stateScanned = false;
  stateBackendMocks.getRawObject.mockImplementation(async (key: string) => {
    if (key === MARKER_KEY) return MARKER_BODY;
    if (key in stateFiles) {
      stateScanned = true;
      return stateFiles[key];
    }
    return null;
  });
  stateBackendMocks.listRawKeys.mockImplementation(async () => [
    ...Object.keys(stateFiles),
    ...(stateScanned ? lockKeysAfterScan : []),
  ]);
  signalObjects([]);
  stateBackendMocks.deleteRawObjects.mockResolvedValue(undefined);
  stateBackendMocks.purgeNoncurrentVersions.mockResolvedValue(undefined);
  mockS3Send.mockResolvedValue({ Contents: [], IsTruncated: false });
  mockEcrSend.mockResolvedValue({ imageDetails: [] });
  mockRemove.mockResolvedValue(undefined);
});

function withOrphanAndLive(state: Record<string, unknown>, at = STATE_KEY): void {
  stateFiles[at] = JSON.stringify(state);
  signalObjects([
    { key: ORPHAN_KEY, lastModified: OLD, size: 40 },
    { key: LIVE_KEY, lastModified: OLD, size: 50 },
  ]);
}

describe('cdkd gc: orphaned wait condition signal objects (#6699)', () => {
  it('deletes an unreferenced old key and keeps one a state resource references', async () => {
    withOrphanAndLive({ stackName: 'App', resources: { Live: handleRecord(LIVE_KEY) } });
    await runGc(['--yes']);
    expect(removedKeys()).toEqual([ORPHAN_KEY]);
    expect(infoText()).toContain('Deleted 1 orphaned wait condition signal object(s)');
  });

  it('keeps a key referenced from orphans[].state', async () => {
    withOrphanAndLive({
      stackName: 'App',
      resources: {},
      orphans: [{ logicalId: 'Live', orphanedAt: 1, state: handleRecord(LIVE_KEY) }],
    });
    await runGc(['--yes']);
    expect(removedKeys()).toEqual([ORPHAN_KEY]);
  });

  it('keeps a key a wait condition still names after its handle record was orphaned', async () => {
    withOrphanAndLive({
      stackName: 'App',
      resources: {
        Wait: {
          resourceType: 'AWS::CloudFormation::WaitCondition',
          physicalId: 'cdkd-wait-condition-Wait-1',
          properties: { Handle: urlFor(LIVE_KEY), Count: 1 },
        },
      },
    });
    await runGc(['--yes']);
    expect(removedKeys()).toEqual([ORPHAN_KEY]);
  });

  it('keeps a key referenced from supersededResources[].state', async () => {
    withOrphanAndLive({
      stackName: 'App',
      resources: {},
      supersededResources: [{ logicalId: 'Live', supersededAt: 1, state: handleRecord(LIVE_KEY) }],
    });
    await runGc(['--yes']);
    expect(removedKeys()).toEqual([ORPHAN_KEY]);
  });

  it('keeps a key referenced from a nested child record', async () => {
    stateFiles[STATE_KEY] = JSON.stringify({ stackName: 'App', resources: {} });
    withOrphanAndLive(
      { stackName: 'App~Nested', parentStack: 'App', resources: { Live: handleRecord(LIVE_KEY) } },
      CHILD_KEY
    );
    await runGc(['--yes']);
    expect(removedKeys()).toEqual([ORPHAN_KEY]);
  });

  it('keeps a key referenced from a non-default --state-prefix record', async () => {
    withOrphanAndLive(
      { stackName: 'App', resources: { Live: handleRecord(LIVE_KEY) } },
      `team-a/App/${REGION}/state.json`
    );
    await runGc(['--yes']);
    expect(removedKeys()).toEqual([ORPHAN_KEY]);
  });

  it('keeps a key a retained.json handle references', async () => {
    withOrphanAndLive({ stackName: 'App', resources: {} });
    stateFiles[`cdkd/Gone/${REGION}/retained.json`] = JSON.stringify({
      retainedVersion: 1,
      resources: [{ logicalId: 'Live', ...handleRecord(LIVE_KEY), keptAt: 1 }],
    });
    await runGc(['--yes']);
    expect(removedKeys()).toEqual([ORPHAN_KEY]);
  });

  it('keeps a key a virtual-hosted handle URL references', async () => {
    withOrphanAndLive({
      stackName: 'App',
      resources: {
        Live: {
          resourceType: HANDLE,
          physicalId: `https://${STATE_BUCKET}.s3.${REGION}.amazonaws.com/${LIVE_KEY}?X-Amz-Signature=a`,
        },
      },
    });
    await runGc(['--yes']);
    expect(removedKeys()).toEqual([ORPHAN_KEY]);
  });

  it('keeps a key younger than --older-than', async () => {
    stateFiles[STATE_KEY] = JSON.stringify({ stackName: 'App', resources: {} });
    signalObjects([
      { key: ORPHAN_KEY, lastModified: OLD, size: 40 },
      { key: LIVE_KEY, lastModified: RECENT, size: 50 },
    ]);
    await runGc(['--yes']);
    expect(removedKeys()).toEqual([ORPHAN_KEY]);
  });

  it('keeps a key under the prefix that is not the minted key shape', async () => {
    const stray = [
      `${WAIT_CONDITION_SIGNAL_PREFIX}/App/${REGION}/state.json`,
      `${WAIT_CONDITION_SIGNAL_PREFIX}/Handle-not-a-uuid.json`,
      `${WAIT_CONDITION_SIGNAL_PREFIX}/Wait-Handle-0b6f3c1e-1f2a-4c3d-8e9f-0123456789ab.json`,
    ];
    signalObjects([
      { key: ORPHAN_KEY, lastModified: OLD, size: 40 },
      ...stray.map((key) => ({ key, lastModified: OLD, size: 1 })),
    ]);
    await runGc(['--yes']);
    expect(removedKeys()).toEqual([ORPHAN_KEY]);
  });

  it('lists only the producer prefix', async () => {
    await runGc(['--yes']);
    expect(stateBackendMocks.listRawObjects).toHaveBeenCalledWith(`${WAIT_CONDITION_SIGNAL_PREFIX}/`);
  });

  it('an unparseable state file aborts with nothing deleted', async () => {
    stateFiles[STATE_KEY] = '{not json';
    signalObjects([{ key: ORPHAN_KEY, lastModified: OLD, size: 40 }]);
    await expect(runGc(['--yes'])).rejects.toMatchObject({ code: 'GC_STATE_UNREADABLE' });
    expect(mockRemove).not.toHaveBeenCalled();
    expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalled();
  });

  it('a state file whose containers cannot be walked aborts with nothing deleted', async () => {
    for (const malformed of [
      { stackName: 'App', resources: [] },
      { stackName: 'App', resources: {}, orphans: {} },
      { stackName: 'App', resources: { H: { resourceType: HANDLE, physicalId: 7 } } },
    ]) {
      stateFiles[STATE_KEY] = JSON.stringify(malformed);
      signalObjects([{ key: ORPHAN_KEY, lastModified: OLD, size: 40 }]);
      await expect(runGc(['--yes'])).rejects.toMatchObject({ code: 'GC_STATE_UNREADABLE' });
    }
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('a malformed container does NOT abort a run with no aged signal object', async () => {
    // The asset arm keeps its parse-failure-only rule.
    stateFiles[STATE_KEY] = JSON.stringify({ stackName: 'App', resources: [] });
    await expect(runGc(['--yes'])).resolves.toBeUndefined();
  });

  it('--dry-run deletes nothing, but names the key in the plan', async () => {
    signalObjects([{ key: ORPHAN_KEY, lastModified: OLD, size: 40 }]);
    await runGc(['--dry-run']);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(infoText()).toContain(`s3://${STATE_BUCKET}/${ORPHAN_KEY}`);
    expect(infoText()).toContain('+ 1 wait condition signal object(s) (40 B, current versions)');
  });

  it('runs without a bootstrap marker', async () => {
    stateBackendMocks.getRawObject.mockImplementation(async () => null);
    signalObjects([{ key: ORPHAN_KEY, lastModified: OLD, size: 40 }]);
    await runGc(['--yes']);
    expect(removedKeys()).toEqual([ORPHAN_KEY]);
    expect(infoText()).toContain("state bucket's orphaned wait condition signal objects");
  });

  it('refuses when a lock appears during the reference scan', async () => {
    withOrphanAndLive({ stackName: 'App', resources: {} });
    lockKeysAfterScan = [`cdkd/App/${REGION}/lock.json`];
    await expect(runGc(['--yes'])).rejects.toMatchObject({ code: 'GC_LOCKED' });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('reports every failed delete as GC_DELETE_FAILED with the failure count', async () => {
    const keys = [ORPHAN_KEY, LIVE_KEY];
    mockRemove.mockImplementation(async (key: string) => {
      if (key === LIVE_KEY) throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
    });
    const err = await deleteWaitConditionSignalCandidates(
      keys.map((key) => ({ key, size: 1, lastModified: OLD })),
      mockRemove,
      STATE_BUCKET,
      1
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'GC_DELETE_FAILED' });
    expect(String((err as Error).message)).toContain('Failed to delete 1 wait condition signal');
    expect(removedKeys()).toEqual(keys);
  });

  it('refuses a widened listing prefix', () => {
    for (const prefix of ['', '/', 'a/b', '*']) {
      expect(() => signalSweepPrefix(prefix)).toThrow('Refusing to sweep');
    }
    expect(signalSweepPrefix()).toBe(`${WAIT_CONDITION_SIGNAL_PREFIX}/`);
  });
});
