/**
 * go-to-k/cdkd#4690: `cdkd rollback` hands the delete-first guard the
 * segment's failed ops as they stood BEFORE its failed-op replay stripped the
 * handled ones, and keeps a handled delete-first replacement in the journal
 * while the segment's completed ops remain, so a re-run still sees it.
 *
 * X was recreated delete-first and its old properties name `y-old`; Y's
 * replacement deleted `y-old` first and then failed (its new resource is a
 * journaled orphan). X's reversal must keep the create-first order: its first
 * provider call is a create, never the delete of `x-new`. Driven through the
 * real command and the real executor.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import { readAtKeyRegion } from '../_state-read-double.js';

const logger = vi.hoisted(() => {
  const l: Record<string, unknown> = {};
  Object.assign(l, {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  });
  return l;
});
vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => logger }));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

const provider = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
const recorded = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({
    record: (e: Record<string, unknown>) => recorded.events.push(e),
    finalize: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({})),
}));
vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../../src/provisioning/resource-name.js', () => ({
  withStackName: (_name: string, fn: () => unknown) => fn(),
  withSkipPrefix: (_skip: boolean, fn: () => unknown) => fn(),
  getCurrentSkipPrefix: () => true,
  explicitNamePropertyFor: () => undefined,
}));

const setupMock = vi.fn();
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';

const REGION = 'us-east-1';
const STACK = 'S';
const TYPE = 'AWS::SNS::Topic';

const rec = (physicalId: string, properties: Record<string, unknown> = {}) => ({
  physicalId,
  resourceType: TYPE,
  properties,
  attributes: {},
  dependencies: [],
  provisionedBy: 'sdk' as const,
});

/** X: recreated delete-first; its old properties name Y's old resource. */
const X_OP = {
  logicalId: 'X',
  changeType: 'UPDATE',
  resourceType: TYPE,
  provisionedBy: 'sdk',
  physicalId: 'x-new',
  properties: { Ref: 'y-new' },
  previousState: rec('x-old', { Ref: 'y-old' }),
  oldResourceRetained: false,
  oldDeletedBeforeCreate: true,
};
/** Y: deleted `y-old` first, made `y-made`, then failed. */
const Y_UPDATE = {
  logicalId: 'Y',
  changeType: 'UPDATE',
  resourceType: TYPE,
  provisionedBy: 'sdk',
  physicalId: 'y-old',
  previousState: rec('y-old', { V: 1 }),
  replacementOrphaned: 'delete-first',
  oldDeletedBeforeCreate: true,
};
const Y_ORPHAN = {
  logicalId: 'Y',
  changeType: 'CREATE',
  resourceType: TYPE,
  provisionedBy: 'sdk',
  physicalId: 'y-made',
  physicalIdRecoveredFromError: true,
  deletionPolicy: 'Delete',
  replacedPhysicalId: 'y-old',
  replacedResourceType: TYPE,
  replacedResourceDeleted: true,
};

let backend: Record<string, ReturnType<typeof vi.fn>>;
let calls: string[];

function install(failedOperations: Record<string, unknown>[]): void {
  const record: StackState = {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: { X: rec('x-new', { Ref: 'y-new' }), Y: rec('y-old', { V: 1 }) },
    outputs: {},
    lastModified: 1,
  };
  backend = {
    listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue(readAtKeyRegion(record, REGION)),
    loadRollbackJournal: vi.fn().mockResolvedValue({
      journalVersion: 1,
      stackName: STACK,
      region: REGION,
      segments: [{ operations: [structuredClone(X_OP)], failedOperations: structuredClone(failedOperations) }],
    }),
    saveState: vi.fn().mockResolvedValue('etag-2'),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
  };
  setupMock.mockResolvedValue({
    stateBackend: backend,
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

const opts = (revertFailed?: boolean) =>
  ({
    yes: true,
    stateBucket: 'b',
    region: REGION,
    ...(revertFailed && { revertFailed: true }),
  }) as unknown as Parameters<typeof rollbackCommand>[1];

/** X's first provider call in the run. */
const firstOnX = (): string | undefined => calls.find((c) => / X( |$)/.test(c));

describe('cdkd rollback feeds the delete-first guard the failed ops it strips (go-to-k/cdkd#4690)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    provider.create.mockImplementation(async (logicalId: string) => {
      calls.push(`create ${logicalId}`);
      // The old X cannot come back while its reference is gone: the run fails
      // and keeps the segment, as a real re-create would.
      throw new Error(`create rejected: ${logicalId}`);
    });
    provider.delete.mockImplementation(async (logicalId: string, physicalId: string) => {
      calls.push(`delete ${logicalId} ${physicalId}`);
    });
    provider.update.mockResolvedValue({ physicalId: 'p', wasReplaced: false });
  });

  it('a plain rollback blocks the delete-first reversal', async () => {
    install([Y_UPDATE, Y_ORPHAN]);
    await rollbackCommand(STACK, opts()).catch(() => undefined);
    expect(firstOnX()).toBe('create X');
    expect(calls).not.toContain('delete X x-new');
  });

  it('--revert-failed blocks it too, although the replay strips the handled UPDATE', async () => {
    install([Y_UPDATE, Y_ORPHAN]);
    await rollbackCommand(STACK, opts(true)).catch(() => undefined);
    expect(firstOnX()).toBe('create X');
    expect(calls).not.toContain('delete X x-new');
  });

  it('keeps the handled delete-first UPDATE in the journal, so a re-run still blocks', async () => {
    install([Y_UPDATE, Y_ORPHAN]);
    await rollbackCommand(STACK, opts(true)).catch(() => undefined);
    const persisted = backend['setRollbackJournalFailedOperations']!.mock.calls.at(-1)?.[2] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(persisted?.some((o) => o['logicalId'] === 'Y' && o['changeType'] === 'UPDATE')).toBe(true);
    // The re-run reads what the strip persisted.
    install(persisted ?? []);
    calls = [];
    await rollbackCommand(STACK, opts(true)).catch(() => undefined);
    expect(firstOnX()).toBe('create X');
    expect(calls).not.toContain('delete X x-new');
  });

  it('control: with no failed sibling the reversal deletes the new X first', async () => {
    install([]);
    await rollbackCommand(STACK, opts()).catch(() => undefined);
    expect(firstOnX()).toBe('delete X x-new');
  });
});
