import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  approveLateReplacement,
  requireDeploymentApproval,
} from '../../../src/deployment/deployment-approval.js';
import type { DeploymentApprovalRequest } from '../../../src/deployment/deploy-engine/options.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

const NESTED = 'AWS::CloudFormation::Stack';
const rec = (resourceType = 'AWS::SQS::Queue'): ResourceState =>
  ({ physicalId: 'p', resourceType, properties: {} }) as ResourceState;
const change = (
  logicalId: string,
  changeType: ResourceChange['changeType'],
  resourceType = 'AWS::SQS::Queue'
): ResourceChange => ({ logicalId, changeType, resourceType, propertyChanges: [] });

function run(
  level: 'never' | 'any-change' | 'destructive',
  changes: ResourceChange[],
  approve: (r: DeploymentApprovalRequest) => Promise<boolean>,
  extra: { recreateTargetIds?: string[]; records?: Record<string, ResourceState> } = {}
): Promise<boolean> {
  return requireDeploymentApproval({
    options: { requireApproval: level, approveDeployment: approve },
    stackName: 'S',
    changes,
    records: extra.records ?? Object.fromEntries(changes.map((c) => [c.logicalId, rec(c.resourceType)])),
    template: { Resources: {} },
    recreateTargetIds: extra.recreateTargetIds,
  });
}

describe('requireDeploymentApproval', () => {
  let approve: ReturnType<typeof vi.fn<(r: DeploymentApprovalRequest) => Promise<boolean>>>;
  beforeEach(() => {
    approve = vi.fn(async () => true);
  });

  it('asks under destructive for a --recreate-via-* target, which the deploy replaces', async () => {
    await run('destructive', [change('Fn', 'UPDATE')], approve, { recreateTargetIds: ['Fn'] });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0].destructiveChanges).toEqual([
      { stackName: 'S', logicalId: 'Fn', resourceType: 'AWS::SQS::Queue', impact: 'WILL_REPLACE' },
    ]);
  });

  it('does not ask under destructive for a plain in-place update', async () => {
    await run('destructive', [change('Fn', 'UPDATE')], approve);
    expect(approve).not.toHaveBeenCalled();
  });

  it('under any-change, leaves nested-stack updates to the child engines', async () => {
    await run('any-change', [change('Child', 'UPDATE', NESTED), change('Q', 'NO_CHANGE')], approve);
    expect(approve).not.toHaveBeenCalled();
  });

  it.each([
    ['a nested-stack CREATE', [change('Child', 'CREATE', NESTED)]],
    ['a nested-stack DELETE', [change('Child', 'DELETE', NESTED)]],
    ['a nested update beside another change', [change('Child', 'UPDATE', NESTED), change('Q', 'UPDATE')]],
  ])('under any-change, asks for %s', async (_label, changes) => {
    await run('any-change', changes, approve);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('never asks under never, or with nothing to ask through', async () => {
    await run('never', [change('Q', 'DELETE')], approve);
    expect(approve).not.toHaveBeenCalled();
    await expect(
      requireDeploymentApproval({
        options: { requireApproval: 'destructive' },
        stackName: 'S',
        changes: [change('Q', 'DELETE')],
        records: { Q: rec() },
        template: { Resources: {} },
      })
    ).resolves.toBe(false);
  });

  it('marks a refusal to ask non-retryable, as it marks a decline', async () => {
    const refusal = new Error('stdin is not interactive');
    await expect(run('destructive', [change('Q', 'DELETE')], async () => Promise.reject(refusal))).rejects.toBe(refusal);
    expect(isMarkedNonRetryable(refusal)).toBe(true);
    const declined = await run('destructive', [change('Q', 'DELETE')], async () => false).catch((e: unknown) => e);
    expect(declined).toMatchObject({ code: 'DEPLOY_NOT_APPROVED' });
    expect(isMarkedNonRetryable(declined)).toBe(true);
  });

  describe('inside a nested-stack row', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("pauses the row's deadline while the question is open", async () => {
      let answer!: (v: boolean) => void;
      const onTimeout = vi.fn(() => new Error('row timed out'));
      const row = withResourceDeadline(
        () => run('destructive', [change('Q', 'DELETE')], () => new Promise((r) => (answer = r))),
        { warnAfterMs: 1_000, timeoutMs: 2_000, onTimeout }
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onTimeout).not.toHaveBeenCalled();
      answer(true);
      // go-to-k/cdkd#4705: `true` -- it asked, and was approved.
      await expect(row).resolves.toBe(true);
    });

    it('refuses without asking once the row already timed out', async () => {
      const asked = vi.fn(async () => true);
      let inner: Promise<boolean> | undefined;
      const row = withResourceDeadline(
        async () => {
          // The child's own diff outlived the row's deadline before it asked.
          await new Promise((r) => setTimeout(r, 5_000));
          inner = run('destructive', [change('Q', 'DELETE')], asked);
          return inner;
        },
        { warnAfterMs: 1_000, timeoutMs: 2_000, onTimeout: () => new Error('row timed out') }
      );
      const rowSettled = expect(row).rejects.toThrow('row timed out');
      await vi.advanceTimersByTimeAsync(5_000);
      await rowSettled;
      await expect(inner).rejects.toMatchObject({ code: 'DEPLOY_APPROVAL_AFTER_TIMEOUT' });
      expect(asked).not.toHaveBeenCalled();
    });
  });
});

describe('approveLateReplacement (go-to-k/cdkd#4656)', () => {
  const replacement: ResourceChange = {
    logicalId: 'Q',
    changeType: 'UPDATE',
    resourceType: 'AWS::SQS::Queue',
    propertyChanges: [
      { path: 'QueueName', oldValue: '***', newValue: '***', requiresReplacement: true },
    ],
  };
  const late = (
    level: 'never' | 'any-change' | 'destructive',
    approve?: (r: DeploymentApprovalRequest) => Promise<boolean>
  ): Promise<boolean> =>
    approveLateReplacement({
      options: { requireApproval: level, ...(approve && { approveDeployment: approve }) },
      stackName: 'S',
      change: replacement,
      records: { Q: rec('AWS::SQS::Queue') },
      template: { Resources: {} },
    });

  it('asks nothing under never or without an approver', async () => {
    const approve = vi.fn(async () => false);
    await expect(late('never', approve)).resolves.toBe(true);
    await expect(late('destructive')).resolves.toBe(true);
    expect(approve).not.toHaveBeenCalled();
  });

  it('names the replacement as a destructive change, and answers what the operator answered', async () => {
    const approve = vi.fn(async (_r: DeploymentApprovalRequest) => false);
    await expect(late('any-change', approve)).resolves.toBe(false);
    expect(approve.mock.calls[0]![0].destructiveChanges.map((c) => c.logicalId)).toEqual(['Q']);
    await expect(late('destructive', async () => true)).resolves.toBe(true);
  });

  it('turns a refusal to ask into false, never a throw', async () => {
    await expect(
      late('destructive', () => Promise.reject(new Error('stdin is not interactive')))
    ).resolves.toBe(false);
  });

  it('F-2 (go-to-k/cdkd#4705): onAsked runs after an answered question, and never when nothing asked', async () => {
    const run = (level: 'never' | 'destructive', approve?: () => Promise<boolean>) => {
      const onAsked = vi.fn();
      return approveLateReplacement({
        options: { requireApproval: level, ...(approve && { approveDeployment: approve }) },
        stackName: 'S',
        change: replacement,
        records: { Q: rec('AWS::SQS::Queue') },
        template: { Resources: {} },
        onAsked,
      }).then(() => onAsked);
    };
    await expect(run('destructive', async () => true)).resolves.toHaveBeenCalledTimes(1);
    await expect(run('destructive', async () => false)).resolves.toHaveBeenCalledTimes(1);
    await expect(run('never', async () => true)).resolves.not.toHaveBeenCalled();
    await expect(run('destructive', () => Promise.reject(new Error('no tty')))).resolves.not.toHaveBeenCalled();
  });

  describe('inside a resource deadline', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('pauses the deadline while the question is open', async () => {
      let answer!: (v: boolean) => void;
      const onTimeout = vi.fn(() => new Error('row timed out'));
      const row = withResourceDeadline(
        () => late('destructive', () => new Promise((r) => (answer = r))),
        { warnAfterMs: 1_000, timeoutMs: 2_000, onTimeout }
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onTimeout).not.toHaveBeenCalled();
      answer(true);
      await expect(row).resolves.toBe(true);
    });

    it('answers false without asking once the deadline already passed', async () => {
      const asked = vi.fn(async () => true);
      let inner: Promise<boolean> | undefined;
      const row = withResourceDeadline(
        async () => {
          await new Promise((r) => setTimeout(r, 5_000));
          inner = late('destructive', asked);
          return inner;
        },
        { warnAfterMs: 1_000, timeoutMs: 2_000, onTimeout: () => new Error('row timed out') }
      );
      const rowSettled = expect(row).rejects.toThrow('row timed out');
      await vi.advanceTimersByTimeAsync(5_000);
      await rowSettled;
      await expect(inner).resolves.toBe(false);
      expect(asked).not.toHaveBeenCalled();
    });
  });
});
