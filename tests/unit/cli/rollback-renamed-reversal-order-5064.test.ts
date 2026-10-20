/**
 * go-to-k/cdkd#5064 phase 2, through the real `cdkd rollback` command: the
 * generated-name-lifecycle integ's phase E1. `deploy --no-rollback` replaced
 * Role under a new generated name, moved a managed policy and an inline
 * policy onto it, then a sibling failed. The rollback reverted both policies
 * back to the OLD role name before re-creating that role ("The role with name
 * ... cannot be found", exit 2). It must re-create the old role first and
 * delete the new one last, and pop the segment.
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
  runWithStackAwsClients: (_c: unknown, fn: () => unknown) => fn(),
  getAwsClients: vi.fn(() => ({})),
}));
vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../../src/provisioning/resource-name.js', () => ({
  // go-to-k/cdkd#5064 phase 2: a replay binds the record's name generation.
  withNameGeneration: (_binding: unknown, fn: () => unknown) => fn(),
  isNameGeneration: (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  stackInstanceNameSuffix: () => '000000000000',
  withStackScope: (_name: string, fn: () => unknown) => fn(),
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
const STACK = 'App';
const ROLE = 'AWS::IAM::Role';
const OLD_ROLE = 'App-Role-7b29ef5fc296';
const NEW_ROLE = 'App-Role-gen2-0a1b2c3d4e5f';
const MANAGED_ARN = 'arn:aws:iam::111122223333:policy/App-Managed';
const DOC = { Version: '2012-10-17', Statement: [] };

const rec = (
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  dependencies: string[] = []
) => ({
  physicalId,
  resourceType,
  properties,
  attributes: {},
  dependencies,
  provisionedBy: 'sdk' as const,
});
const roleRec = (name: string) => rec(name, ROLE, { AssumeRolePolicyDocument: DOC });
const managedRec = (role: string) =>
  rec(MANAGED_ARN, 'AWS::IAM::ManagedPolicy', { PolicyDocument: DOC, Roles: [role] }, ['Role']);
const inlineRec = (role: string) =>
  rec(
    'App-Role-DefaultPolicy',
    'AWS::IAM::Policy',
    { PolicyName: 'RoleDefaultPolicy', PolicyDocument: DOC, Roles: [role] },
    ['Role']
  );

/** E1's segment in completion order, and its failed sibling. */
const OPERATIONS = [
  {
    logicalId: 'Role',
    changeType: 'UPDATE',
    resourceType: ROLE,
    provisionedBy: 'sdk',
    physicalId: NEW_ROLE,
    previousState: roleRec(OLD_ROLE),
    oldResourceRetained: false,
    nameGeneration: 2,
  },
  {
    logicalId: 'RoleDefaultPolicy',
    changeType: 'UPDATE',
    resourceType: 'AWS::IAM::Policy',
    provisionedBy: 'sdk',
    physicalId: 'App-Role-DefaultPolicy',
    previousState: inlineRec(OLD_ROLE),
  },
  {
    logicalId: 'Managed',
    changeType: 'UPDATE',
    resourceType: 'AWS::IAM::ManagedPolicy',
    provisionedBy: 'sdk',
    physicalId: MANAGED_ARN,
    previousState: managedRec(OLD_ROLE),
  },
];
const FAILED = [{ logicalId: 'Fail', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue' }];

let backend: Record<string, ReturnType<typeof vi.fn>>;
let calls: string[];
let roles: Set<string>;

function install(resources: Record<string, unknown>): void {
  const record: StackState = {
    version: 12,
    stackName: STACK,
    region: REGION,
    resources: resources as StackState['resources'],
    outputs: {},
    lastModified: 1,
  };
  backend = {
    getRegistryMarker: vi.fn().mockResolvedValue(null),
    claimRegistryMarker: vi.fn().mockResolvedValue('claimed'),
    lockUnderPrefix: vi.fn().mockResolvedValue(false),
    listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
    recordUnderPrefix: vi.fn().mockResolvedValue('absent'),
    listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue(readAtKeyRegion(record, REGION)),
    loadRollbackJournal: vi.fn().mockResolvedValue({
      journalVersion: 1,
      stackName: STACK,
      region: REGION,
      segments: [
        {
          reason: 'no-rollback-failure',
          operations: structuredClone(OPERATIONS),
          failedOperations: structuredClone(FAILED),
        },
      ],
    }),
    saveState: vi.fn().mockResolvedValue('etag-2'),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
  };
  setupMock.mockResolvedValue({
    stateBackend: { ...backend, prefix: 'cdkd' },
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

const opts = () =>
  ({ yes: true, stateBucket: 'b', region: REGION }) as unknown as Parameters<
    typeof rollbackCommand
  >[1];

describe('cdkd rollback re-creates a renamed replacement before its dependents revert (go-to-k/cdkd#5064)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    roles = new Set([NEW_ROLE]);
    provider.create.mockImplementation(async (logicalId: string) => {
      calls.push(`create ${logicalId}`);
      roles.add(OLD_ROLE);
      return { physicalId: OLD_ROLE, attributes: {} };
    });
    provider.update.mockImplementation(
      async (logicalId: string, physicalId: string, _t: string, props: Record<string, unknown>) => {
        const role = (props['Roles'] as string[])[0]!;
        calls.push(`update ${logicalId} -> ${role}`);
        if (!roles.has(role)) throw new Error(`The role with name ${role} cannot be found.`);
        return { physicalId, wasReplaced: false };
      }
    );
    provider.delete.mockImplementation(async (logicalId: string, physicalId: string) => {
      calls.push(`delete ${logicalId} ${physicalId}`);
      roles.delete(physicalId);
    });
  });

  it('E1: re-create old role, revert both policies onto it, delete the new role; the segment pops', async () => {
    install({
      Role: roleRec(NEW_ROLE),
      RoleDefaultPolicy: inlineRec(NEW_ROLE),
      Managed: managedRec(NEW_ROLE),
    });
    await rollbackCommand(STACK, opts());
    expect(calls).toEqual([
      'create Role',
      `update Managed -> ${OLD_ROLE}`,
      `update RoleDefaultPolicy -> ${OLD_ROLE}`,
      `delete Role ${NEW_ROLE}`,
    ]);
    expect(backend['popRollbackJournalSegment']).toHaveBeenCalled();
    const saved = backend['saveState']!.mock.calls.at(-1)?.[2] as StackState;
    expect(saved.resources['Role']!.physicalId).toBe(OLD_ROLE);
    expect(saved.resources['Managed']!.properties['Roles']).toEqual([OLD_ROLE]);
    expect(saved.resources['RoleDefaultPolicy']!.properties['Roles']).toEqual([OLD_ROLE]);
    // Every save between the re-create and the delete keeps the new role
    // tracked as superseded; the last one, after the delete, drops it.
    const saves = backend['saveState']!.mock.calls.map((c) => c[2] as StackState);
    const pending = saves.filter((st) =>
      (st.supersededResources ?? []).some((e) => e.state.physicalId === NEW_ROLE)
    );
    expect(pending.length).toBeGreaterThanOrEqual(3);
    expect(saved.supersededResources).toBeUndefined();
  });

  it("a second rollback over a partial run's leftovers completes and pops the segment", async () => {
    // What E1's failed run left: the old role back, both policies still
    // recorded on the deleted new one, the journal kept.
    roles = new Set([OLD_ROLE]);
    install({
      Role: roleRec(OLD_ROLE),
      RoleDefaultPolicy: inlineRec(NEW_ROLE),
      Managed: managedRec(NEW_ROLE),
    });
    await rollbackCommand(STACK, opts());
    expect(calls).toEqual([
      `update Managed -> ${OLD_ROLE}`,
      `update RoleDefaultPolicy -> ${OLD_ROLE}`,
    ]);
    expect(backend['popRollbackJournalSegment']).toHaveBeenCalled();
  });
});
