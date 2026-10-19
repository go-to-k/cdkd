/**
 * go-to-k/cdkd#5064 x go-to-k/cdkd#5096: the same-id reversal arm reads a
 * replacement as "re-created under the same physical id" by comparing the
 * op's physical id with the previous record's. On a stack with an instance id
 * a replacement of an UN-NAMED resource moves to the next name generation, so
 * its physical id changes and the arm must NOT fire: the old resource is
 * re-created at its own generation and no same-id refusal blocks it. On a
 * legacy stack, and for a DECLARED name on either, the name does not move, so
 * the arm still fires.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { isReplacementOp, sameIdRecreated } from '../../../src/deployment/rollback-executor/plan.js';
import {
  currentNameGeneration,
  stackInstanceNameSuffix,
  withStackScope,
} from '../../../src/provisioning/resource-name.js';
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

const TYPE = 'AWS::Lambda::Function';
const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const v13 = () => ({
  stackName: 'App',
  stackInstanceId: ID,
  nameGenerations: new Map<string, number>([['Fn', 1]]),
});
const legacy = () => ({ stackName: 'App', stackInstanceId: undefined, nameGenerations: undefined });
/** The name a v13 stack generates for the un-named `Fn` at generation `g`. */
const gen = (g: number) => `App-Fn-${stackInstanceNameSuffix(ID, 'Fn', g)}`;

const props = (runtime: string, name?: string) => ({
  Runtime: runtime,
  Handler: 'index.handler',
  ...(name !== undefined && { FunctionName: name }),
});
const record = (physicalId: string, runtime: string, extra: Partial<ResourceState> = {}) =>
  ({
    physicalId,
    resourceType: TYPE,
    properties: props(runtime),
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
    ...extra,
  }) as ResourceState;
/** A permission AWS stores on the function: a same-id reversal would take it. */
const permission = (): ResourceState => ({
  physicalId: 'perm-1',
  resourceType: 'AWS::Lambda::Permission',
  properties: { FunctionName: 'x', Action: 'lambda:InvokeFunction' },
  attributes: {},
  dependencies: ['Fn'],
  provisionedBy: 'sdk',
});

/** A provider whose create names an un-named function at the bound generation. */
function model() {
  const calls: string[] = [];
  const provider = {
    create: vi.fn(async (logicalId: string, _t: string, p: Record<string, unknown>) => {
      const generation = currentNameGeneration(logicalId);
      const physicalId =
        typeof p['FunctionName'] === 'string' ? p['FunctionName'] : gen(generation ?? -1);
      calls.push(`create ${physicalId}`);
      return { physicalId, attributes: {} };
    }),
    delete: vi.fn(async (_l: string, physicalId: string) => {
      calls.push(`delete ${physicalId}`);
    }),
    update: vi.fn(async (_l: string, physicalId: string) => {
      calls.push(`update ${physicalId}`);
      return { physicalId, wasReplaced: false };
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
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
  const warned = () => vi.mocked(logger.warn).mock.calls.flat().join('\n');
  return { ctx, calls, warned };
}

describe('same-id reversal x name generations (go-to-k/cdkd#5064, #5096)', () => {
  /** An un-named function replaced on a v13 stack: gen 0 -> gen 1. */
  const movedOp = (extra: Partial<CompletedOperation> = {}): CompletedOperation => ({
    logicalId: 'Fn',
    changeType: 'UPDATE',
    resourceType: TYPE,
    provisionedBy: 'sdk',
    physicalId: gen(1),
    properties: props('nodejs22.x'),
    previousState: record(gen(0), 'nodejs20.x'),
    oldResourceRetained: false,
    nameGeneration: 1,
    ...extra,
  });

  it.each([
    ['created first', {}],
    ['deleted first', { oldDeletedBeforeCreate: true }],
  ] as const)(
    'a v13 un-named replacement (%s) is no same-id re-create: the old one comes back at its own generation',
    async (_label, extra) => {
      const op = movedOp(extra);
      expect(isReplacementOp(op)).toBe(true);
      expect(sameIdRecreated(op)).toBe(false);
      const m = model();
      const state: Record<string, ResourceState> = {
        Fn: record(gen(1), 'nodejs22.x', { nameGeneration: 1 }),
        Perm: permission(),
      };
      const result = await withStackScope(v13(), () => replayRollback([op], state, 'App', m.ctx));
      expect(m.warned()).not.toMatch(/same physical id/);
      expect(result.failures).toBe(0);
      expect(m.calls).toContain(`create ${gen(0)}`);
      expect(m.calls).toContain(`delete ${gen(1)}`);
      expect(m.calls).not.toContain(`create ${gen(1)}`);
      expect(state['Fn']!.physicalId).toBe(gen(0));
    }
  );

  /** The name did not move: same physical id before and after, deleted first. */
  const sameIdOp = (name: string, declared: boolean): CompletedOperation => ({
    logicalId: 'Fn',
    changeType: 'UPDATE',
    resourceType: TYPE,
    provisionedBy: 'sdk',
    physicalId: name,
    properties: props('nodejs22.x', declared ? name : undefined),
    previousState: {
      ...record(name, 'nodejs20.x'),
      properties: props('nodejs20.x', declared ? name : undefined),
    },
    oldResourceRetained: false,
    oldDeletedBeforeCreate: true,
  });

  it.each([
    ['a legacy stack', legacy, sameIdOp('App-Fn-LEGACY', false)],
    ['a declared name on a v13 stack', v13, sameIdOp('my-fn', true)],
  ] as const)('on %s the same-id arm still fires and refuses over a stored child', async (_l, scope, op) => {
    expect(sameIdRecreated(op)).toBe(true);
    const m = model();
    const before = { ...record(op.physicalId!, 'nodejs22.x'), properties: op.properties! };
    const state: Record<string, ResourceState> = { Fn: before, Perm: permission() };
    const result = await withStackScope(scope(), () => replayRollback([op], state, 'App', m.ctx));
    expect(result.failures).toBe(1);
    expect(m.calls).toEqual([]);
    expect(m.warned()).toMatch(/re-created it under the same physical id/);
    expect(m.warned()).toContain('Perm');
  });
});
