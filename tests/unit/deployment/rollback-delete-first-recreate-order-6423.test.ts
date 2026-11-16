/**
 * go-to-k/cdkd#6423: a delete-first reversal (`oldDeletedBeforeCreate`) is
 * re-created after the reverts of the ops its old record depends on. Reverse
 * completion order alone re-created a schedule before the role it targets was
 * reverted, and AWS refused it against the role's NEW trust policy.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import {
  orderDeleteFirstAfterDependencies,
  planRollback,
} from '../../../src/deployment/rollback-executor/plan.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const ROLE = 'AWS::IAM::Role';
const SCHEDULE = 'AWS::Scheduler::Schedule';

function rec(
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  dependencies: string[] = []
): ResourceState {
  return { physicalId, resourceType, properties, attributes: {}, dependencies, provisionedBy: 'sdk' };
}

// The forward deploy: the role's trust moved to the new group first, then the
// schedule was replaced delete-first under the same name.
const roleOp = (): CompletedOperation => ({
  logicalId: 'Role',
  changeType: 'UPDATE',
  resourceType: ROLE,
  provisionedBy: 'sdk',
  physicalId: 'role',
  previousState: rec('role', ROLE, { Trust: 'g1' }),
  oldResourceRetained: false,
});
const scheduleOp = (extra: Partial<CompletedOperation> = {}): CompletedOperation => ({
  logicalId: 'Schedule',
  changeType: 'UPDATE',
  resourceType: SCHEDULE,
  provisionedBy: 'sdk',
  physicalId: 'sched',
  previousState: rec('sched', SCHEDULE, { GroupName: 'g1', RoleArn: 'role' }, ['Role']),
  oldResourceRetained: false,
  oldDeletedBeforeCreate: true,
  // The forward's properties, journaled as a real deploy does.
  properties: { GroupName: 'g2', RoleArn: 'role' },
  ...extra,
});

describe('a delete-first reversal re-creates after its dependencies revert (#6423)', () => {
  let calls: string[];
  let roleTrust: string;
  let ctx: RollbackExecutorContext;

  beforeEach(() => {
    calls = [];
    roleTrust = 'g2';
    const provider = {
      create: vi.fn(async (logicalId: string, _t: string, props: Record<string, unknown>) => {
        calls.push(`create ${logicalId}`);
        // AWS refuses a schedule whose role does not trust its group.
        if (logicalId === 'Schedule' && roleTrust !== props['GroupName']) {
          throw new Error('ValidationException: The execution role you provide must allow AWS EventBridge Scheduler to assume the role.');
        }
        return { physicalId: 'sched', attributes: {} };
      }),
      update: vi.fn(async (logicalId: string, physicalId: string, _t: string, props: Record<string, unknown>) => {
        calls.push(`update ${logicalId}`);
        if (logicalId === 'Role') roleTrust = String(props['Trust']);
        return { physicalId, wasReplaced: false, attributes: {} };
      }),
      delete: vi.fn(async (logicalId: string) => {
        calls.push(`delete ${logicalId}`);
      }),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLevel: vi.fn(),
      child: () => logger,
    } as unknown as RollbackExecutorContext['logger'];
    ctx = {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
        getProvider: () => provider,
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
  });

  const state = (): Record<string, ResourceState> => ({
    Role: rec('role', ROLE, { Trust: 'g2' }),
    Schedule: rec('sched', SCHEDULE, { GroupName: 'g2', RoleArn: 'role' }, ['Role']),
  });

  it('reverts the role before re-creating the schedule, so the re-create succeeds', async () => {
    const s = state();
    const result = await replayRollback([roleOp(), scheduleOp()], s, 'S', ctx);

    expect(result.failures).toBe(0);
    expect(calls.indexOf('update Role')).toBeGreaterThan(-1);
    expect(calls.indexOf('update Role')).toBeLessThan(calls.indexOf('create Schedule'));
    expect(s['Schedule']!.properties).toEqual({ GroupName: 'g1', RoleArn: 'role' });
  });

  it('the plan lists the same order', () => {
    const order = planRollback([roleOp(), scheduleOp()], state()).map((i) => i.op.logicalId);
    expect(order).toEqual(['Role', 'Schedule']);
  });

  it('keeps reverse completion order for a reversal that did not delete first', () => {
    const ops = [roleOp(), scheduleOp({ oldDeletedBeforeCreate: undefined })];
    expect(orderDeleteFirstAfterDependencies([...ops].reverse()).map((o) => o.logicalId)).toEqual([
      'Schedule',
      'Role',
    ]);
  });

  it('moves only past ops it depends on, keeping the rest in place', () => {
    const other: CompletedOperation = { ...roleOp(), logicalId: 'Other', physicalId: 'other' };
    // Reverse completion: Schedule, Role, Other. Schedule needs only Role.
    const reversed = [scheduleOp(), roleOp(), other];
    expect(orderDeleteFirstAfterDependencies(reversed).map((o) => o.logicalId)).toEqual([
      'Role',
      'Schedule',
      'Other',
    ]);
  });

  it('leaves a delete-first reversal whose dependencies already reverted before it', () => {
    const reversed = [roleOp(), scheduleOp()];
    expect(orderDeleteFirstAfterDependencies(reversed)).toEqual(reversed);
  });
});
