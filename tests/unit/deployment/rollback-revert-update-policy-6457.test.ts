import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayFailedOperations,
  replayRollback,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { UpdateContext } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';
import { revertUpdatePolicy } from '../../../src/deployment/deploy-engine/update-policy.js';

/**
 * go-to-k/cdkd#6457: both revert arms (`replay-revert.ts`, the `--revert-failed`
 * arm in `replay-failed.ts`) hand the provider the `UpdatePolicy` the forward
 * UPDATE journaled, minus `AutoScalingScheduledAction` ("This property is
 * ignored during a stack rollback"), and nothing for a journal without one.
 */

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: vi.fn() }, ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const ASG = 'AWS::AutoScaling::AutoScalingGroup';
const SCHEDULED = { AutoScalingScheduledAction: { IgnoreUnmodifiedGroupSizeProperties: true } };
const ROLLING = { AutoScalingRollingUpdate: { MaxBatchSize: 1 } };

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

function res(properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'asg', resourceType: ASG, properties, attributes: {}, dependencies: [] };
}

function ctxWith(update: ReturnType<typeof vi.fn>): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider: { update, create: vi.fn(), delete: vi.fn() } }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  };
}

const OLD = { MinSize: '1', MaxSize: '2', LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: '1' } };
const NEW = { ...OLD, LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: '2' } };

describe('revertUpdatePolicy', () => {
  it.each([
    [{ ...SCHEDULED, ...ROLLING }, ROLLING],
    [SCHEDULED, undefined],
    [ROLLING, ROLLING],
    [undefined, undefined],
    ['junk', undefined],
    [['AutoScalingRollingUpdate'], undefined],
    [null, undefined],
  ])('%j -> %j', (journaled, expected) => {
    expect(revertUpdatePolicy(journaled)).toEqual(expected);
  });
});

describe('the rollback revert arms (go-to-k/cdkd#6457)', () => {
  const completed = (updatePolicy?: Record<string, unknown>): CompletedOperation => ({
    logicalId: 'Group',
    changeType: 'UPDATE',
    resourceType: ASG,
    physicalId: 'asg',
    previousState: res(OLD),
    properties: NEW,
    oldResourceRetained: false,
    ...(updatePolicy && { updatePolicy }),
  });

  it.each([
    ['the journaled policy minus AutoScalingScheduledAction', { ...SCHEDULED, ...ROLLING }, ROLLING],
    ['nothing for a journal without one', undefined, undefined],
    ['nothing for a policy that was only AutoScalingScheduledAction', SCHEDULED, undefined],
  ])('a completed UPDATE revert hands %s', async (_label, journaled, expected) => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'asg' });
    await replayRollback([completed(journaled)], { Group: res(NEW) }, 'S', ctxWith(update));
    expect(update).toHaveBeenCalledTimes(1);
    const context = update.mock.calls[0]![5] as UpdateContext;
    expect(context.replayingState).toBe(true);
    expect(update.mock.calls[0]![3]).toEqual(OLD);
    if (expected === undefined) expect(context).not.toHaveProperty('updatePolicy');
    else expect(context.updatePolicy).toEqual(expected);
  });

  it.each([
    ['the journaled policy minus AutoScalingScheduledAction', { ...SCHEDULED, ...ROLLING }, ROLLING],
    ['nothing for a journal without one', undefined, undefined],
  ])('a --revert-failed UPDATE revert hands %s', async (_label, journaled, expected) => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'asg' });
    const failed: FailedOperation = {
      logicalId: 'Group',
      changeType: 'UPDATE',
      resourceType: ASG,
      physicalId: 'asg',
      previousState: res(OLD),
      attemptedProperties: NEW,
      ...(journaled && { updatePolicy: journaled }),
    };
    await replayFailedOperations([failed], { Group: res(OLD) }, 'S', ctxWith(update));
    expect(update).toHaveBeenCalledTimes(1);
    const context = update.mock.calls[0]![5] as UpdateContext;
    expect(context.replayingState).toBe(true);
    if (expected === undefined) expect(context).not.toHaveProperty('updatePolicy');
    else expect(context.updatePolicy).toEqual(expected);
  });
});
