/**
 * `cdkd rollback` settles a journaled abandoned Cloud Control CREATE under its
 * lock before it reads the journal (go-to-k/cdkd#3252).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3252: the takeover needs a UNIQUE identifier, judged from the
// type's registry schema; these tests pin it (a minted `Id`), as the deploy
// engine's equivalent suite does (`deploy-engine-rollback-journal.test.ts`).
const ccSchema = vi.hoisted(() => ({
  fields: ['Id'] as readonly string[] | undefined,
  readOnly: new Set(['Id']) as ReadonlySet<string> | undefined,
}));
vi.mock('../../../src/provisioning/cc-import-identifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/cc-import-identifier.js')>()),
  getPrimaryIdentifierFields: () => Promise.resolve(ccSchema.fields),
}));
vi.mock('../../../src/provisioning/read-only-properties.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/read-only-properties.js')>()),
  getTopLevelReadOnlyProperties: () => Promise.resolve(ccSchema.readOnly),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

const reader = vi.hoisted(() => ({
  resumeAbandonedRequest: vi.fn(),
  buildResumeCommand: vi.fn(async () => 'aws cloudcontrol get-resource-request-status'),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: { delete: vi.fn() } }),
    getCloudControlProvider: () => reader,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_c: unknown, fn: () => unknown) => fn(),
  getAwsClients: vi.fn(() => ({})),
}));

const setupMock = vi.fn();
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';
import { withStackScope, generateResourceName } from '../../../src/provisioning/resource-name.js';

const REGION = 'us-east-1';
const STACK = 'S';
/** A v13 stack instance id (go-to-k/cdkd#5064). */
const STACK_INSTANCE_ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const pendingJournal = () => ({
  journalVersion: 1,
  stackName: STACK,
  region: REGION,
  segments: [
    {
      timestamp: 1,
      reason: 'auto-rollback-clean',
      initialDeploy: false,
      operations: [],
      failedOperations: [
        {
          logicalId: 'Group',
          changeType: 'CREATE',
          resourceType: 'AWS::Logs::LogGroup',
          provisionedBy: 'cc-api',
          pendingCloudControlRequest: { requestToken: 'tok', abandonedAt: 1 },
        },
      ],
    },
  ],
});

function install(order: string[]) {
  const stateBackend = {
    listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
    getRegistryMarker: vi.fn().mockResolvedValue(null),
    claimRegistryMarker: vi.fn().mockResolvedValue('claimed'),
    listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue({ state: { resources: {}, outputs: {} }, etag: 'e' }),
    loadRollbackJournal: vi.fn(async () => {
      order.push('load');
      return pendingJournal();
    }),
    rewriteRollbackJournalFailedOperations: vi.fn(async (..._args: unknown[]) => {
      order.push('rewrite');
      return 1;
    }),
    purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
    rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
    warmConnections: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn().mockResolvedValue('etag-1'),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    readStackInstanceSibling: vi.fn().mockResolvedValue(undefined),
  };
  setupMock.mockResolvedValue({
    stateBackend,
    lockManager: {
      acquireLockWithRetry: vi.fn(async () => {
        order.push('lock');
      }),
      releaseLock: vi.fn(async () => {
        order.push('release');
      }),
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
  return stateBackend;
}

const opts = { statePrefix: 'cdkd', verbose: false, force: true };

describe('rollbackCommand: a journaled abandoned Cloud Control CREATE (#3252)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses while the request is still unknown, under its lock, and releases it', async () => {
    const order: string[] = [];
    const backend = install(order);
    reader.resumeAbandonedRequest.mockResolvedValue({
      status: 'unresolved',
      error: new Error('IN_PROGRESS'),
    });
    await expect(rollbackCommand(STACK, { ...opts })).rejects.toThrow(/cdkd rollback of .* refused/);
    expect(reader.resumeAbandonedRequest).toHaveBeenCalledWith('tok', 'Group', 'AWS::Logs::LogGroup');
    expect(order[0]).toBe('lock');
    expect(order.at(-1)).toBe('release');
    expect(backend.deleteRollbackJournal).not.toHaveBeenCalled();
  });

  it('settles a create that made its resource before the journal is read for the plan', async () => {
    const order: string[] = [];
    reader.resumeAbandonedRequest.mockResolvedValue({ status: 'succeeded', identifier: 'g' });
    const backend = install(order);
    order.length = 0;
    await rollbackCommand(STACK, { ...opts }).catch(() => undefined);
    // The command's own read is the peek; it re-reads only after the rewrite.
    expect(order.slice(0, 4)).toEqual(['lock', 'load', 'rewrite', 'load']);
    // What the rewrite does to the op: the proven-orphan shape.
    const rewrite = backend.rewriteRollbackJournalFailedOperations.mock.calls[0]![2] as unknown as (
      op: unknown
    ) => unknown;
    expect(rewrite(pendingJournal().segments[0]!.failedOperations[0])).toMatchObject({
      physicalId: 'g',
      physicalIdRecoveredFromError: true,
      provisionedBy: 'cc-api',
    });
  });

  // go-to-k/cdkd#5064: `rollback.ts` reads the record's OWN stack instance id
  // (`stackInstanceIdOf(stateData?.state, ...)`) and must forward that exact
  // id to `resolvePendingCloudControlRequests`, or a v13-suffixed identifier
  // is not recognised as cdkd's own and is wrongly recorded as a PROVEN-UNIQUE
  // orphan (`createdIdentifierUnique: true`) instead of a plain one.
  it("recognizes a suffixed identifier as the v13 record's own generated name", async () => {
    const order: string[] = [];
    const suffixedIdentifier = withStackScope(
      { stackName: STACK, stackInstanceId: STACK_INSTANCE_ID, nameGenerations: new Map() },
      () => generateResourceName('Group', { maxLength: 512 })
    );
    reader.resumeAbandonedRequest.mockResolvedValue({
      status: 'succeeded',
      identifier: suffixedIdentifier,
    });
    const backend = install(order);
    backend.getState.mockResolvedValue({
      state: { resources: {}, outputs: {}, stackInstanceId: STACK_INSTANCE_ID },
      etag: 'e',
    });
    const journalWithAttemptedProperties = () => {
      const j = pendingJournal();
      return {
        ...j,
        segments: [
          { ...j.segments[0]!, failedOperations: [{ ...j.segments[0]!.failedOperations[0]!, attemptedProperties: {} }] },
        ],
      };
    };
    backend.loadRollbackJournal.mockImplementation(async () => {
      order.push('load');
      return journalWithAttemptedProperties();
    });
    order.length = 0;
    await rollbackCommand(STACK, { ...opts }).catch(() => undefined);
    const rewrite = backend.rewriteRollbackJournalFailedOperations.mock.calls[0]![2] as unknown as (
      op: unknown
    ) => unknown;
    const op = journalWithAttemptedProperties().segments[0]!.failedOperations[0]!;
    const rewritten = rewrite(op) as Record<string, unknown>;
    expect(rewritten).toMatchObject({ physicalId: suffixedIdentifier, physicalIdRecoveredFromError: true });
    expect(rewritten).not.toHaveProperty('createdIdentifierUnique');
    // The record names the id: the sibling is never read.
    expect(backend.readStackInstanceSibling).not.toHaveBeenCalled();
  });

  // go-to-k/cdkd#5064: a first deploy that saved no record has its id only in
  // the write-ahead sibling; read without minting, it makes the suffixed
  // identifier read as a NAME, not a proven-unique id.
  const suffixedFirstDeploy = (backend: ReturnType<typeof install>, order: string[]) => {
    const suffixedIdentifier = withStackScope(
      { stackName: STACK, stackInstanceId: STACK_INSTANCE_ID, nameGenerations: new Map() },
      () => generateResourceName('Group', { maxLength: 512 })
    );
    reader.resumeAbandonedRequest.mockResolvedValue({
      status: 'succeeded',
      identifier: suffixedIdentifier,
    });
    backend.getState.mockResolvedValue(null);
    const journal = () => {
      const j = pendingJournal();
      return {
        ...j,
        segments: [
          {
            ...j.segments[0]!,
            failedOperations: [{ ...j.segments[0]!.failedOperations[0]!, attemptedProperties: {} }],
          },
        ],
      };
    };
    backend.loadRollbackJournal.mockImplementation(async () => {
      order.push('load');
      return journal();
    });
    return { suffixedIdentifier, op: journal().segments[0]!.failedOperations[0]! };
  };

  it('with no record, reads the write-ahead id (never minting) and recognizes the generated name', async () => {
    const order: string[] = [];
    const backend = install(order);
    const { suffixedIdentifier, op } = suffixedFirstDeploy(backend, order);
    backend.readStackInstanceSibling.mockResolvedValue(STACK_INSTANCE_ID);
    await rollbackCommand(STACK, { ...opts }).catch(() => undefined);
    expect(backend.readStackInstanceSibling).toHaveBeenCalledTimes(1);
    expect(backend.readStackInstanceSibling).toHaveBeenCalledWith(STACK, REGION);
    const rewrite = backend.rewriteRollbackJournalFailedOperations.mock.calls[0]![2] as unknown as (
      op: unknown
    ) => unknown;
    const rewritten = rewrite(op) as Record<string, unknown>;
    expect(rewritten).toMatchObject({ physicalId: suffixedIdentifier });
    expect(rewritten).not.toHaveProperty('createdIdentifierUnique');
  });

  it('with no record, a sibling it cannot read refuses before the journal is rewritten', async () => {
    const order: string[] = [];
    const backend = install(order);
    suffixedFirstDeploy(backend, order);
    backend.readStackInstanceSibling.mockRejectedValue(
      new Error('The write-ahead stack instance id of stack S is in a format this cdkd version cannot read')
    );
    await expect(rollbackCommand(STACK, { ...opts })).rejects.toThrow(/write-ahead stack instance id/);
    expect(backend.rewriteRollbackJournalFailedOperations).not.toHaveBeenCalled();
  });
});
