/**
 * go-to-k/cdkd#4703: `cdkd rollback --remove-protection` reaches a protected
 * resource the failed deploy created inside an EXISTING nested stack. That
 * child is reverted by replaying its own journal (`revertNestedChildFromJournal`),
 * whose executor context is built here, so the flag must be forwarded into it
 * — from `destroyOptions`, which only `cdkd rollback` sets on that flag, and
 * never from a deploy's context, whose automatic rollback drives the same
 * replay. The foreign-holder scan travels with it, scoped to the child.
 *
 * The replay here is the REAL executor down to the provider's delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { RollbackJournalSegment } from '../../../src/types/rollback-journal.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => l };
  return { getLogger: () => l };
});

// A pass-through spy: the real replay runs, and the context it was handed is
// readable afterwards.
vi.mock('../../../src/deployment/rollback-executor.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/rollback-executor.js')>();
  return { ...actual, replayRollback: vi.fn(actual.replayRollback) };
});

import {
  revertNestedChildFromJournal,
  type NestedRevertRun,
} from '../../../src/deployment/nested-child-journal.js';
import {
  replayRollback,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { isTerminalDeleteFailure } from '../../../src/provisioning/providers/deletion-protection-compensation.js';

const REGION = 'us-east-1';
const PARENT = 'Parent';
const CHILD = 'Parent~Child';
const LB_TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/n/1';
const PROPS = {
  LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
};

const lbRecord = () => ({
  physicalId: LB_ARN,
  resourceType: LB_TYPE,
  provisionedBy: 'sdk',
  properties: PROPS,
  attributes: {},
  dependencies: [],
});

const stateOf = (stackName: string, resources: Record<string, unknown>) => ({
  version: 10,
  stackName,
  region: REGION,
  resources,
  outputs: {},
  lastModified: 1,
});

/** The child's segment for run `r`: the failed deploy CREATED the protected LB. */
const childSegment = (): RollbackJournalSegment =>
  ({
    runId: 'r',
    timestamp: 1,
    reason: 'nested-pending-parent',
    initialDeploy: false,
    operations: [
      {
        logicalId: 'NestedLb',
        changeType: 'CREATE',
        resourceType: LB_TYPE,
        physicalId: LB_ARN,
        provisionedBy: 'sdk',
        properties: PROPS,
      },
    ],
  }) as unknown as RollbackJournalSegment;

const seen: Array<{ logicalId: string; context: Record<string, unknown>; final: boolean }> = [];
const del = vi.fn(async (...args: unknown[]) => {
  seen.push({
    logicalId: String(args[0]),
    context: args[4] as Record<string, unknown>,
    // Whether a retryable refusal here would be the last attempt: true only
    // inside the single protection-removing attempt.
    final: isTerminalDeleteFailure(
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
    ),
  });
});

/** `others` are more stacks' records under the same prefix, for the scan. */
function harness(ctxExtra: Record<string, unknown>, others: Record<string, unknown> = {}) {
  const states: Record<string, unknown> = {
    [PARENT]: stateOf(PARENT, {}),
    [CHILD]: stateOf(CHILD, { NestedLb: lbRecord() }),
    ...others,
  };
  const stateBackend = {
    getState: vi.fn(async (name: string) =>
      states[name] === undefined ? null : { state: structuredClone(states[name]), etag: 'e0' }
    ),
    listStacks: vi.fn(async () =>
      Object.keys(states).map((stackName) => ({ stackName, region: REGION }))
    ),
    loadRollbackJournal: vi.fn().mockResolvedValue({ segments: [childSegment()] }),
    saveState: vi.fn().mockResolvedValue('e1'),
    loadCreateTokenLedger: vi.fn().mockResolvedValue(null),
    saveCreateTokenLedger: vi.fn().mockResolvedValue(undefined),
  };
  const ctx = {
    stateBackend,
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    },
    providerRegistry: {
      getProviderFor: () => ({ provider: { delete: del }, provisionedBy: 'sdk' }),
    },
    parentStackName: PARENT,
    parentRegion: REGION,
    accountId: '1',
    awsClients: {},
    stateBucket: 'b',
    ...ctxExtra,
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run: NestedRevertRun = { runId: 'r', settled: new Map(), warnings: 0 };
  const revert = () =>
    revertNestedChildFromJournal({
      ctx: ctx as never,
      logicalId: 'Child',
      childStackName: CHILD,
      region: REGION,
      run,
      logger: logger as never,
    });
  const execCtx = (): RollbackExecutorContext =>
    vi.mocked(replayRollback).mock.calls.at(-1)![3] as RollbackExecutorContext;
  return { stateBackend, revert, execCtx };
}

// What `cdkd rollback --remove-protection` hands the nested context.
const ROLLBACK_FLAGGED = { destroyOptions: { statePrefix: 'cdkd', removeProtection: true } };

beforeEach(() => {
  seen.length = 0;
  del.mockClear();
  vi.mocked(replayRollback).mockClear();
});

describe("a nested child's revert under cdkd rollback --remove-protection (go-to-k/cdkd#4703)", () => {
  it("deletes the child's protected completed CREATE with the flag, as its final attempt", async () => {
    const h = harness(ROLLBACK_FLAGGED);
    await expect(h.revert()).resolves.toEqual({ warnings: 0 });
    expect(seen.map((s) => s.logicalId)).toEqual(['NestedLb']);
    expect(del.mock.calls[0]![1]).toBe(LB_ARN);
    expect(seen[0]!.context['removeProtection']).toBe(true);
    expect(seen[0]!.final).toBe(true);
    // The child's saved record no longer holds it.
    const saved = h.stateBackend.saveState.mock.calls.at(-1)!;
    expect(saved[0]).toBe(CHILD);
    expect((saved[2] as { resources: object }).resources).not.toHaveProperty('NestedLb');
  });

  it('strips nothing without the flag, and builds no scan', async () => {
    const h = harness({ destroyOptions: { statePrefix: 'cdkd' } });
    await h.revert();
    expect(seen.map((s) => s.logicalId)).toEqual(['NestedLb']);
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(seen[0]!.final).toBe(false);
    expect(h.execCtx()).not.toHaveProperty('removeProtection');
    expect(h.execCtx()).not.toHaveProperty('foreignHolder');
    expect(h.stateBackend.listStacks).not.toHaveBeenCalled();
  });

  // The other driver of this replay is a deploy's automatic rollback: its
  // context carries the deploy's options and a `destroyOptions` deploy.ts
  // builds without the flag. Even a `removeProtection` on `options` (no
  // `DeployEngineOptions` field today) must not reach the child's delete.
  it("never takes the flag from a deploy's context", async () => {
    const h = harness({
      options: { removeProtection: true, skipFinalSnapshot: false },
      destroyOptions: { statePrefix: 'cdkd', profile: 'p' },
    });
    await h.revert();
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
    expect(seen[0]!.final).toBe(false);
    expect(h.execCtx()).not.toHaveProperty('removeProtection');
  });

  it('reads only `true`: a false flag strips nothing', async () => {
    const h = harness({ destroyOptions: { removeProtection: false } });
    await h.revert();
    expect(seen[0]!.context).not.toHaveProperty('removeProtection');
  });

  it('pairs the flag with a scan scoped to the CHILD: its own record is not another holder', async () => {
    const h = harness(ROLLBACK_FLAGGED, { Other: stateOf('Other', {}) });
    await h.revert();
    const scan = h.execCtx().foreignHolder;
    expect(scan).toBeTypeOf('function');
    // Only the child's record holds the LB: nothing else does.
    await expect(scan!(LB_TYPE, LB_ARN)).resolves.toBeUndefined();
  });

  it('the scan names any other stack holding it, the parent included', async () => {
    for (const [holder, holderState] of [
      ['Other', stateOf('Other', { Adopted: lbRecord() })],
      [PARENT, stateOf(PARENT, { Adopted: lbRecord() })],
    ] as const) {
      vi.mocked(replayRollback).mockClear();
      const h = harness(ROLLBACK_FLAGGED, { [holder]: holderState });
      await h.revert();
      await expect(h.execCtx().foreignHolder!(LB_TYPE, LB_ARN)).resolves.toEqual({
        kind: 'held',
        by: `the state record of stack ${holder} (${REGION})`,
      });
    }
  });

  it('carries the flag on into a grandchild replay through the child context', async () => {
    // The child context a grandchild row is reverted under spreads the
    // parent's, so its `destroyOptions` (and the flag) reach the next level.
    const { getCurrentNestedStackContext } =
      await import('../../../src/provisioning/nested-stack-context.js');
    let inner: unknown;
    vi.mocked(replayRollback).mockImplementationOnce(async () => {
      inner = getCurrentNestedStackContext()?.destroyOptions;
      return { failures: 0, warnings: 0, skipped: 0, interrupted: false, orphaned: [] };
    });
    await harness(ROLLBACK_FLAGGED).revert();
    expect(inner).toEqual({ statePrefix: 'cdkd', removeProtection: true });
  });
});
