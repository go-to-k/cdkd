/**
 * go-to-k/cdkd#4225: `cdkd rollback` replays a segment's failed ops, then its
 * completed ops, then each older segment, all over ONE state bag. An inline
 * policy name one of those replays puts back must be kept by a removal in a
 * later one, so the command hands every replay ONE record of completed writes
 * (`RollbackInlinePolicyWriters`). Driven through the real command and the
 * real executor, against a fake IAM holding one role's inline policies.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { InlinePolicyClaimed } from '../../../src/types/resource.js';
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

/** The role's inline policies: name -> the document of whoever put it last. */
const iam = vi.hoisted(() => ({ held: new Map<string, string>() }));
type PolicyProps = { PolicyName: string; PolicyDocument: string; Roles: string[] };
const asked = (ctx: unknown): InlinePolicyClaimed | undefined =>
  (ctx as { inlinePolicyClaimed?: InlinePolicyClaimed } | undefined)?.inlinePolicyClaimed;
const policyProvider = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: policyProvider, provisionedBy: 'sdk' }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
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
const POLICY = 'AWS::IAM::Policy';
const ROLE_PHYS = 'role-phys';

const policyRecord = (name: string, doc: string, roles = [ROLE_PHYS]) => ({
  physicalId: name,
  resourceType: POLICY,
  properties: { PolicyName: name, PolicyDocument: doc, Roles: roles },
  attributes: {},
  provisionedBy: 'sdk' as const,
});

function install(resources: StackState['resources'], segments: Record<string, unknown>[]): void {
  const record: StackState = {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: structuredClone(resources),
    outputs: {},
    lastModified: 1,
  };
  setupMock.mockResolvedValue({
    stateBackend: {
      listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
      getRegistryMarker: vi.fn().mockResolvedValue(null),
      claimRegistryMarker: vi.fn().mockResolvedValue('claimed'),
      listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue(readAtKeyRegion(record, REGION)),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: STACK,
        region: REGION,
        segments: structuredClone(segments),
      }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
      deleteState: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    },
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

const holding = (): Record<string, string> => Object.fromEntries([...iam.held].sort());

describe('cdkd rollback shares one record of completed writes across its replays (go-to-k/cdkd#4225)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    iam.held.clear();
    policyProvider.create.mockImplementation(async (_l: string, _t: string, props: PolicyProps) => {
      iam.held.set(props.PolicyName, props.PolicyDocument);
      return { physicalId: props.PolicyName, attributes: {} };
    });
    policyProvider.update.mockImplementation(
      async (_l: string, _p: string, _t: string, props: PolicyProps, prev: PolicyProps, ctx: unknown) => {
        if (props.Roles.length > 0) iam.held.set(props.PolicyName, props.PolicyDocument);
        for (const r of prev.Roles) {
          if (props.Roles.includes(r) && prev.PolicyName === props.PolicyName) continue;
          if (asked(ctx)?.('role', r, prev.PolicyName) === true) continue;
          iam.held.delete(prev.PolicyName);
        }
        return { physicalId: props.PolicyName, wasReplaced: false };
      }
    );
    policyProvider.delete.mockImplementation(
      async (_l: string, physicalId: string, _t: string, props: PolicyProps, ctx: unknown) => {
        for (const r of props.Roles) {
          if (asked(ctx)?.('role', r, physicalId) === true) continue;
          iam.held.delete(physicalId);
        }
      }
    );
  });

  it('--revert-failed: a completed op reversed after a failed op keeps the name the failed op put back', async () => {
    // A's rename x -> y FAILED after putting `y`; B's rename y -> x completed.
    // The failed op reverts first (put `x`, remove `y`), then B reverses
    // (re-create `y`, delete `x`), which must leave `x` to A.
    iam.held.set('x', 'docB');
    iam.held.set('y', 'docA');
    install({ A: policyRecord('x', 'docA'), B: policyRecord('x', 'docB') }, [
      {
        failedOperations: [
          {
            logicalId: 'A',
            changeType: 'UPDATE',
            resourceType: POLICY,
            physicalId: 'x',
            attemptedProperties: policyRecord('y', 'docA').properties,
            previousState: policyRecord('x', 'docA'),
            provisionedBy: 'sdk',
          },
        ],
        operations: [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: POLICY,
            physicalId: 'x',
            properties: policyRecord('x', 'docB').properties,
            previousResourceType: POLICY,
            oldResourceRetained: false,
            previousState: policyRecord('y', 'docB'),
            provisionedBy: 'sdk',
          },
        ],
      },
    ]);

    const thrown = await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(holding()).toEqual({ x: 'docA', y: 'docB' });
  });

  it('an OLDER segment\'s delete keeps the name a newer segment\'s revert put back', async () => {
    // Run 1 (older) created New with name `n`; run 2 (newer) detached P's
    // `n` from the role. Reverting run 2 re-attaches `n` (P's document), so
    // reverting run 1 must not remove it with New's delete.
    install({ P: policyRecord('n', 'docP', []), New: policyRecord('n', 'docNew') }, [
      {
        operations: [
          {
            logicalId: 'New',
            changeType: 'CREATE',
            resourceType: POLICY,
            physicalId: 'n',
            properties: policyRecord('n', 'docNew').properties,
            provisionedBy: 'sdk',
          },
        ],
      },
      {
        operations: [
          {
            logicalId: 'P',
            changeType: 'UPDATE',
            resourceType: POLICY,
            physicalId: 'n',
            properties: policyRecord('n', 'docP', []).properties,
            previousState: policyRecord('n', 'docP'),
            provisionedBy: 'sdk',
          },
        ],
      },
    ]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(policyProvider.update).toHaveBeenCalledTimes(1);
    expect(policyProvider.delete).toHaveBeenCalledTimes(1);
    expect(holding()).toEqual({ n: 'docP' });
  });
});
