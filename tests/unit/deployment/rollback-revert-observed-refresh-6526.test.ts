import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6526: a SUCCESSFUL in-place revert (`replay-revert.ts`, and the
 * `--revert-failed` arm in `replay-failed.ts`) re-reads the restored resource's
 * drift baseline from AWS, as a deploy's update does. Without it the restored
 * record kept the PRE-deploy `observedProperties` verbatim, so a value AWS
 * regenerated on the revert's write (an S3 lifecycle rule's generated `Id`)
 * reported as drift on every later `cdkd drift`.
 *
 * Drives the REAL `replayRollback` / `replayFailedOperations` (shared by the
 * automatic rollback and `cdkd rollback`) with a stub provider.
 */

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

const SECRET = 'hunter2-plaintext-6526';
const SECRET_EXPR = '{{resolve:secretsmanager:s6526:SecretString}}';
const smSend = vi.fn(async () => ({ SecretString: SECRET }));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: smSend }, ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

import {
  replayFailedOperations,
  replayRollback,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

const BUCKET = 'AWS::S3::Bucket';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

const rule = (id?: string) => ({
  ...(id !== undefined && { Id: id }),
  Status: 'Enabled',
  Prefix: 'tmp/',
  ExpirationInDays: 30,
});
/** v1: the bucket with an id-less lifecycle rule (CDK `lifecycleRules`, no `id`). */
const V1 = { BucketName: 'bkt-6526', LifecycleConfiguration: { Rules: [rule()] } };
/** v2: the failed deploy removed it. */
const V2 = { BucketName: 'bkt-6526' };
/** What AWS generated on v1's own create. */
const V1_OBSERVED = { BucketName: 'bkt-6526', LifecycleConfiguration: { Rules: [rule('OLD-ID')] } };
/** What AWS generated on the revert's re-PUT. */
const RESTORED_LIVE = {
  BucketName: 'bkt-6526',
  LifecycleConfiguration: { Rules: [rule('NEW-ID')] },
};

function res(
  properties: Record<string, unknown>,
  observed?: Record<string, unknown>,
  extra: Partial<ResourceState> = {}
): ResourceState {
  return {
    physicalId: 'bkt-6526',
    resourceType: BUCKET,
    properties,
    attributes: {},
    dependencies: [],
    ...(observed && { observedProperties: observed }),
    ...extra,
  };
}

interface Stub {
  update: ReturnType<typeof vi.fn>;
  readCurrentState?: ReturnType<typeof vi.fn>;
}

function ctxWith(stub: Stub): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({
        provider: { create: vi.fn(), delete: vi.fn(), ...stub },
      }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  };
}

const completed = (previous: ResourceState): CompletedOperation => ({
  logicalId: 'Bkt',
  changeType: 'UPDATE',
  resourceType: BUCKET,
  physicalId: 'bkt-6526',
  previousState: previous,
  properties: V2,
  oldResourceRetained: false,
});
const failed = (previous: ResourceState): FailedOperation => ({
  logicalId: 'Bkt',
  changeType: 'UPDATE',
  resourceType: BUCKET,
  physicalId: 'bkt-6526',
  previousState: previous,
  attemptedProperties: V2,
});

/** Run one arm over the restored record `previous`, returning the recorded `Bkt`. */
async function restore(
  arm: 'completed' | 'failed',
  previous: ResourceState,
  stub: Stub
): Promise<ResourceState | undefined> {
  const state: Record<string, ResourceState> = {
    Bkt: res(V2, { BucketName: 'bkt-6526' }),
    // A sibling, so the readback's state-built context has one to carry.
    Queue: { ...res({}, undefined), physicalId: 'q-url', resourceType: 'AWS::SQS::Queue' },
  };
  const result =
    arm === 'completed'
      ? await replayRollback([completed(previous)], state, 'S', ctxWith(stub))
      : await replayFailedOperations([failed(previous)], state, 'S', ctxWith(stub));
  expect(result.failures).toBe(0);
  expect(stub.update).toHaveBeenCalledTimes(1);
  return state['Bkt'];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountInfoCache();
});

describe.each(['completed', 'failed'] as const)(
  'the %s-op in-place revert refreshes the restored drift baseline (go-to-k/cdkd#6526)',
  (arm) => {
    it('records what AWS holds after the revert, not the pre-deploy snapshot', async () => {
      const readCurrentState = vi.fn().mockResolvedValue(RESTORED_LIVE);
      const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526' });
      const record = await restore(arm, res(V1, V1_OBSERVED), { update, readCurrentState });
      expect(record?.properties).toEqual(V1);
      expect(record?.observedProperties).toEqual(RESTORED_LIVE);
      expect(readCurrentState).toHaveBeenCalledTimes(1);
      const [physicalId, logicalId, resourceType, props, context] =
        readCurrentState.mock.calls[0]!;
      expect([physicalId, logicalId, resourceType]).toEqual(['bkt-6526', 'Bkt', BUCKET]);
      // The bag the revert sent, read after cdkd's own write, with the
      // state-built sibling context `cdkd drift` reads with too.
      expect(props).toEqual(V1);
      expect(context.afterOwnWrite).toBe(true);
      expect(Object.keys(context.siblings)).toEqual(['Queue']);
      // Only after the write landed.
      expect(update.mock.invocationCallOrder[0]!).toBeLessThan(
        readCurrentState.mock.invocationCallOrder[0]!
      );
    });

    it('persists a resolved secret the readback echoes as its reference, never the plaintext', async () => {
      const withSecret = { ...V1, AnalyticsRole: SECRET_EXPR };
      const readCurrentState = vi
        .fn()
        .mockResolvedValue({ ...RESTORED_LIVE, AnalyticsRole: SECRET });
      const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526' });
      const record = await restore(arm, res(withSecret, { ...V1_OBSERVED, AnalyticsRole: SECRET_EXPR }), {
        update,
        readCurrentState,
      });
      // The revert really sent the plaintext, so the readback is a real echo.
      expect(update.mock.calls[0]![3]).toMatchObject({ AnalyticsRole: SECRET });
      expect(record?.observedProperties).toEqual({ ...RESTORED_LIVE, AnalyticsRole: SECRET_EXPR });
      expect(JSON.stringify(record)).not.toContain(SECRET);
    });

    it('keeps the previous baseline when the read fails, and the rollback still succeeds', async () => {
      const readCurrentState = vi.fn().mockRejectedValue(new Error(`boom ${SECRET}`));
      const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526' });
      const record = await restore(arm, res(V1, V1_OBSERVED), { update, readCurrentState });
      expect(record?.observedProperties).toEqual(V1_OBSERVED);
      const debugLines = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(debugLines.some((l) => String(l).includes('observedProperties refresh for Bkt'))).toBe(
        true
      );
    });

    it('keeps the previous baseline when AWS answers nothing or reports the resource gone', async () => {
      for (const answer of [undefined, RESOURCE_NOT_FOUND]) {
        const readCurrentState = vi.fn().mockResolvedValue(answer);
        const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526' });
        const record = await restore(arm, res(V1, V1_OBSERVED), { update, readCurrentState });
        expect(readCurrentState).toHaveBeenCalledTimes(1);
        expect(record?.observedProperties).toEqual(V1_OBSERVED);
      }
    });

    it('keeps the previous baseline for a provider without readCurrentState', async () => {
      const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526' });
      const record = await restore(arm, res(V1, V1_OBSERVED), { update });
      expect(record?.observedProperties).toEqual(V1_OBSERVED);
    });

    it.each([
      ['no baseline at all', res(V1)],
      ['a refused import baseline', res(V1, undefined, { observedBaselineRefused: true })],
      ['a NoEcho-marked record', res(V1, V1_OBSERVED, { noEchoLeaves: [['BucketName']] })],
      [
        'a record declaring NoEcho attributes',
        res(V1, V1_OBSERVED, { noEchoAttributeNames: ['Arn'] } as Partial<ResourceState>),
      ],
      ['a fail-closed masked baseline', res(V1, { ...V1_OBSERVED, BucketName: '***' })],
    ])('reads nothing and keeps the record as it was for %s', async (_label, previous) => {
      const readCurrentState = vi.fn().mockResolvedValue(RESTORED_LIVE);
      const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526' });
      const record = await restore(arm, previous, { update, readCurrentState });
      expect(readCurrentState).not.toHaveBeenCalled();
      expect(record?.observedProperties).toEqual(previous.observedProperties);
    });
  }
);
