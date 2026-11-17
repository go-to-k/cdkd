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

/**
 * go-to-k/cdkd#6519: both revert arms (`replay-revert.ts`, the `--revert-failed`
 * arm in `replay-failed.ts`) hand the provider the `observedProperties` of the
 * record they RESTORE as `restoredObservedProperties` — never the snapshot of
 * the failed deploy's record — and nothing when that record has none.
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

const DIST = 'AWS::CloudFront::Distribution';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

const origin = (protocols?: string[]) => ({
  Id: 'web',
  DomainName: 'example.com',
  CustomOriginConfig: {
    OriginProtocolPolicy: 'https-only',
    ...(protocols && { OriginSSLProtocols: protocols }),
  },
});
const OLD = { DistributionConfig: { Enabled: false, Origins: [origin()] } };
const NEW = { DistributionConfig: { Enabled: false, Origins: [origin(['TLSv1'])] } };
const OLD_OBSERVED = { DistributionConfig: { Enabled: false, Origins: [origin(['TLSv1.2'])] } };
const NEW_OBSERVED = { DistributionConfig: { Enabled: false, Origins: [origin(['TLSv1'])] } };

function res(properties: Record<string, unknown>, observed?: Record<string, unknown>): ResourceState {
  return {
    physicalId: 'E123',
    resourceType: DIST,
    properties,
    attributes: {},
    dependencies: [],
    ...(observed && { observedProperties: observed }),
  };
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

function contextOf(update: ReturnType<typeof vi.fn>): UpdateContext {
  expect(update).toHaveBeenCalledTimes(1);
  return update.mock.calls[0]![5] as UpdateContext;
}

describe('restoredObservedProperties on the rollback revert arms (go-to-k/cdkd#6519)', () => {
  const completed = (previousObserved?: Record<string, unknown>): CompletedOperation => ({
    logicalId: 'Dist',
    changeType: 'UPDATE',
    resourceType: DIST,
    physicalId: 'E123',
    previousState: res(OLD, previousObserved),
    properties: NEW,
    oldResourceRetained: false,
  });
  const failed = (previousObserved?: Record<string, unknown>): FailedOperation => ({
    logicalId: 'Dist',
    changeType: 'UPDATE',
    resourceType: DIST,
    physicalId: 'E123',
    previousState: res(OLD, previousObserved),
    attemptedProperties: NEW,
  });

  it("a completed UPDATE revert hands the RESTORED record's snapshot, not the failed deploy's", async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'E123' });
    await replayRollback(
      [completed(OLD_OBSERVED)],
      { Dist: res(NEW, NEW_OBSERVED) },
      'S',
      ctxWith(update)
    );
    const context = contextOf(update);
    expect(context.replayingState).toBe(true);
    expect(update.mock.calls[0]![3]).toEqual(OLD);
    expect(context.restoredObservedProperties).toEqual(OLD_OBSERVED);
  });

  it('a completed UPDATE revert hands nothing when the restored record has no snapshot', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'E123' });
    await replayRollback([completed()], { Dist: res(NEW, NEW_OBSERVED) }, 'S', ctxWith(update));
    expect(contextOf(update).restoredObservedProperties).toBeUndefined();
  });

  it("a --revert-failed UPDATE revert hands the RESTORED record's snapshot", async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'E123' });
    await replayFailedOperations(
      [failed(OLD_OBSERVED)],
      { Dist: res(OLD, NEW_OBSERVED) },
      'S',
      ctxWith(update)
    );
    const context = contextOf(update);
    expect(context.replayingState).toBe(true);
    expect(context.restoredObservedProperties).toEqual(OLD_OBSERVED);
  });

  it('a --revert-failed UPDATE revert hands nothing when the restored record has no snapshot', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'E123' });
    await replayFailedOperations([failed()], { Dist: res(OLD, NEW_OBSERVED) }, 'S', ctxWith(update));
    expect(contextOf(update).restoredObservedProperties).toBeUndefined();
  });
});
