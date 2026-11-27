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
const ssmSend = vi.fn(async () => ({ Parameter: { Value: 'pubval6526', Type: 'String' } }));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: smSend }, ssm: { send: ssmSend } }),
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
import { RESOURCE_NOT_FOUND, type ResourceProvider } from '../../../src/types/resource.js';
import { getCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import { isSameGenerationBag } from '../../../src/deployment/secret-redaction.js';
import { withRefreshedObservedBaseline } from '../../../src/deployment/rollback-executor/replay-observed-refresh.js';
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

function ctxWith(stub: Stub, extra: Partial<RollbackExecutorContext> = {}): RollbackExecutorContext {
  return {
    ...extra,
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
  stub: Stub,
  extra: Partial<RollbackExecutorContext> = {}
): Promise<ResourceState | undefined> {
  const state: Record<string, ResourceState> = {
    // The failed deploy's record, which the replay holds until it restores.
    Bkt: res(V2, { BucketName: 'bkt-6526' }, { attributes: { Arn: 'arn-v2' } }),
    // A sibling, so the readback's state-built context has one to carry.
    Queue: { ...res({}, undefined), physicalId: 'q-url', resourceType: 'AWS::SQS::Queue' },
  };
  const result =
    arm === 'completed'
      ? await replayRollback([completed(previous)], state, 'S', ctxWith(stub, extra))
      : await replayFailedOperations([failed(previous)], state, 'S', ctxWith(stub, extra));
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
      let secretsBoundDuringRead = false;
      const readCurrentState = vi.fn(async (..._args: unknown[]) => {
        secretsBoundDuringRead = getCurrentResourceSecrets()?.has(SECRET) === true;
        return { ...RESTORED_LIVE, AnalyticsRole: SECRET };
      });
      const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526' });
      const record = await restore(arm, res(withSecret, { ...V1_OBSERVED, AnalyticsRole: SECRET_EXPR }), {
        update,
        readCurrentState,
      });
      // The revert really sent the plaintext, so the readback is a real echo,
      // and the read is handed that same resolved bag.
      expect(update.mock.calls[0]![3]).toMatchObject({ AnalyticsRole: SECRET });
      expect(readCurrentState.mock.calls[0]![3]).toMatchObject({ AnalyticsRole: SECRET });
      // The provider's own log lines are sink-masked with the op's bag.
      expect(secretsBoundDuringRead).toBe(true);
      // Installed UNMARKED, so a later scrub reads it as a prior generation.
      expect(isSameGenerationBag(record?.observedProperties)).toBe(false);
      expect(record?.observedProperties).toEqual({ ...RESTORED_LIVE, AnalyticsRole: SECRET_EXPR });
      expect(JSON.stringify(record)).not.toContain(SECRET);
    });

    it('positions a readback at a reference leaf as the reference, with no secret in the map', async () => {
      // A PUBLIC `ssm` parameter: the replay resolves it but records no secret,
      // so only this refresh's own scrub (the deploy capture's rules) keeps the
      // live value at the reference's position out of the baseline.
      const withRef = { ...V1, Description: '{{resolve:ssm:/p6526}}' };
      const readCurrentState = vi
        .fn()
        .mockResolvedValue({ ...RESTORED_LIVE, Description: 'pubval6526' });
      const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526' });
      const record = await restore(arm, res(withRef, { ...V1_OBSERVED, ...withRef }), {
        update,
        readCurrentState,
      });
      expect(update.mock.calls[0]![3]).toMatchObject({ Description: 'pubval6526' });
      expect(record?.observedProperties).toEqual({ ...RESTORED_LIVE, Description: '{{resolve:ssm:/p6526}}' });
    });

    it("hands the read the RESTORED record's own attributes, never the failed deploy's", async () => {
      const readCurrentState = vi.fn().mockResolvedValue(RESTORED_LIVE);
      const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526' });
      const previous = res(V1, V1_OBSERVED, { attributes: { Arn: 'arn-v1' } });
      await restore(arm, previous, { update, readCurrentState });
      const context = readCurrentState.mock.calls[0]![4];
      // The #4447 ownership evidence is the restored generation's, never the
      // failed deploy's record the replay held under the same id.
      expect(context.attributes).toEqual({ Arn: 'arn-v1' });
      expect(context.siblings['Queue']).toMatchObject({ physicalId: 'q-url' });
    });

    it('reads the id a revert that replaced the resource records', async () => {
      const readCurrentState = vi.fn().mockResolvedValue(RESTORED_LIVE);
      const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526-new', wasReplaced: true });
      const record = await restore(arm, res(V1, V1_OBSERVED), { update, readCurrentState });
      expect(readCurrentState.mock.calls[0]![0]).toBe('bkt-6526-new');
      expect(record?.physicalId).toBe('bkt-6526-new');
      expect(record?.observedProperties).toEqual(RESTORED_LIVE);
    });

    it('skips the read under --no-capture-observed-state', async () => {
      const readCurrentState = vi.fn().mockResolvedValue(RESTORED_LIVE);
      const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526' });
      const record = await restore(
        arm,
        res(V1, V1_OBSERVED),
        { update, readCurrentState },
        { captureObservedState: false }
      );
      expect(readCurrentState).not.toHaveBeenCalled();
      expect(record?.observedProperties).toEqual(V1_OBSERVED);
    });

    it('keeps the previous baseline when the read fails, masks the failure, and still succeeds', async () => {
      const withSecret = { ...V1, AnalyticsRole: SECRET_EXPR };
      const previousObserved = { ...V1_OBSERVED, AnalyticsRole: SECRET_EXPR };
      const readCurrentState = vi.fn().mockRejectedValue(new Error(`boom ${SECRET}`));
      const update = vi.fn().mockResolvedValue({ physicalId: 'bkt-6526' });
      const record = await restore(arm, res(withSecret, previousObserved), {
        update,
        readCurrentState,
      });
      expect(record?.observedProperties).toEqual(previousObserved);
      const debugLines = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
        String(c[0])
      );
      const line = debugLines.find((l) => l.includes('observedProperties refresh for Bkt'));
      expect(line).toContain('boom');
      expect(line).not.toContain(SECRET);
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
      ['a refused import baseline', res(V1, V1_OBSERVED, { observedBaselineRefused: true })],
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


describe('withRefreshedObservedBaseline (go-to-k/cdkd#6526)', () => {
  const args = (
    restored: ResourceState,
    readCurrentState: ReturnType<typeof vi.fn>,
    inScope: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()
  ) => ({
    provider: { readCurrentState } as unknown as ResourceProvider,
    op: { logicalId: 'Bkt', resourceType: BUCKET },
    desiredProps: V1,
    restored,
    stateResources: {},
    secrets: new Map(),
    noEcho: { substituted: [] },
    mask: (text: string) => text,
    logger: { debug: vi.fn() },
    inScope,
    capture: undefined,
  });

  it("reads inside the revert's own scope", async () => {
    let inside = false;
    let readInside: boolean | undefined;
    const readCurrentState = vi.fn(async () => {
      readInside = inside;
      return RESTORED_LIVE;
    });
    const restored = res(V1, V1_OBSERVED);
    const out = await withRefreshedObservedBaseline(
      restored,
      args(restored, readCurrentState, async (fn) => {
        inside = true;
        try {
          return await fn();
        } finally {
          inside = false;
        }
      })
    );
    expect(readInside).toBe(true);
    expect(out.observedProperties).toEqual(RESTORED_LIVE);
  });

  it("scrubs under the deploy capture's fail-closed rules: a reordered list masks what it cannot pair", async () => {
    // A reference inside an UNKEYED list AWS returned in another order: the
    // readback's position cannot be paired with the source, so the deploy's
    // drained-capture rules mask it rather than persist a value that may be a
    // resolved secret. A prior-generation rewrite would keep `val` in the clear.
    const restored = res({ L: ['{{resolve:ssm:/p6526}}', 'b'] }, { L: ['{{resolve:ssm:/p6526}}', 'b'] });
    const live = { L: ['b', 'val'] };
    const out = await withRefreshedObservedBaseline(
      restored,
      args(restored, vi.fn().mockResolvedValue(live))
    );
    expect(out.observedProperties).toEqual({ L: ['b', '***'] });
  });

  it('masks and names a secret reference plaintext the readback echoes under a key the template lacks (go-to-k/cdkd#7152)', async () => {
    // A reference inside a list no identity field pairs: the scrub cannot
    // learn the pair, so only the raw readback teaches the value.
    const restored = res(
      { Users: [{ Password: '{{resolve:ssm-secure:/p7152}}' }] },
      { Users: [{ Password: '{{resolve:ssm-secure:/p7152}}' }] }
    );
    const live = { Users: [{ Password: 'pw-rollback-7152' }], Login: 'user:pw-rollback-7152' };
    const out = await withRefreshedObservedBaseline(
      restored,
      args(restored, vi.fn().mockResolvedValue(live))
    );
    expect(JSON.stringify(out)).not.toContain('pw-rollback-7152');
    expect(out.observedProperties?.['Login']).toBe('***');
    expect(out.observedMaskedLeaves).toEqual([['Login']]);
  });

  it('never aliases the object the provider returned', async () => {
    const live = { ...RESTORED_LIVE };
    const restored = res(V1, V1_OBSERVED);
    const out = await withRefreshedObservedBaseline(
      restored,
      args(restored, vi.fn().mockResolvedValue(live))
    );
    expect(out.observedProperties).toEqual(RESTORED_LIVE);
    expect(out.observedProperties).not.toBe(live);
  });

  it('reads nothing for a record with no addressable physical id', async () => {
    const readCurrentState = vi.fn().mockResolvedValue(RESTORED_LIVE);
    const restored = { ...res(V1, V1_OBSERVED), physicalId: '' };
    const out = await withRefreshedObservedBaseline(restored, args(restored, readCurrentState));
    expect(readCurrentState).not.toHaveBeenCalled();
    expect(out).toBe(restored);
  });

  // Unreachable from the executor, which refuses a masked baseline before the
  // revert (`refuseMaskedReplayBaseline`): pinned on the helper, so the guard
  // still holds should that refusal ever move.
  it.each([
    ['whose properties hold a mask', res({ ...V1, Description: '***' }, V1_OBSERVED), []],
    // The executor substitutes only at a `noEchoLeaves` coordinate, so its
    // record is refused by that guard first.
    ['the revert substituted a NoEcho value into', res(V1, V1_OBSERVED), [{ coordinate: ['X'] }]],
  ])('reads nothing for a restored record %s', async (_label, restored, substituted) => {
    const readCurrentState = vi.fn().mockResolvedValue(RESTORED_LIVE);
    const out = await withRefreshedObservedBaseline(restored, {
      ...args(restored, readCurrentState),
      noEcho: { substituted },
    });
    expect(readCurrentState).not.toHaveBeenCalled();
    expect(out).toBe(restored);
  });
});
