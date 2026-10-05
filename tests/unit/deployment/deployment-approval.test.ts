import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { requireDeploymentApproval } from '../../../src/deployment/deployment-approval.js';
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
): Promise<void> {
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
    ).resolves.toBeUndefined();
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
      await expect(row).resolves.toBeUndefined();
    });

    it('refuses without asking once the row already timed out', async () => {
      const asked = vi.fn(async () => true);
      let inner: Promise<void> | undefined;
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
