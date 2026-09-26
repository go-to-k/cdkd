/**
 * Issue [#2668](https://github.com/go-to-k/cdkd/issues/2668), the rollback
 * half: reversing a replacement that changed the resource's `Type`.
 *
 * `CompletedOperation.resourceType` is the TEMPLATE's (new) type, so the replay
 * used to re-create the OLD resource through the NEW type's provider. The op
 * now carries `previousResourceType`, and a journal written before that field
 * falls back to `previousState.resourceType` — the same value, journaled all
 * along. Where neither names a type, or they disagree, or the pair involves a
 * nested stack, the op is REFUSED (a failure, so the segment is kept) rather
 * than guessed.
 *
 * The registry double hands out ONE PROVIDER PER TYPE: with a shared provider,
 * "create was called" is satisfied by the mis-route this fixes.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  classifyFailedOp,
  classifyRollbackOp,
  isReplacementOp,
  isTypeChangeOp,
  replayFailedOperations,
  replayRollback,
  resolveReplacementOldType,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { parseRollbackJournal } from '../../../src/types/rollback-journal.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  applyDefaultNameForFallback,
  withStackName,
} from '../../../src/provisioning/resource-name.js';
import { awsSdkError, ccAlreadyExistsError } from '../_aws-sdk-error.js';

/** The bag a Cloud Control create of `type` receives for a nameless record. */
function applyDefaultNameForFallbackUnderStack(
  logicalId: string,
  type: string
): Record<string, unknown> {
  return withStackName('MyStack', () => applyDefaultNameForFallback(logicalId, type, {}));
}

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const STACK = 'MyStack';
const OLD_TYPE = 'AWS::SSM::Parameter';
const NEW_TYPE = 'AWS::SNS::Topic';
const NESTED = 'AWS::CloudFormation::Stack';
const OLD_ID = '/app/old-param';
const NEW_ID = 'arn:aws:sns:us-east-1:111122223333:new-topic';
const RECREATED_OLD_ID = '/app/old-param-recreated';

const warn = vi.fn();
const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn,
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: OLD_TYPE,
    properties: { Value: 'v' },
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

/** A completed Type-change replacement, as THIS binary journals it. */
function typeChangeOp(overrides: Partial<CompletedOperation> = {}): CompletedOperation {
  return {
    logicalId: 'Thing',
    changeType: 'UPDATE',
    resourceType: NEW_TYPE,
    physicalId: NEW_ID,
    previousState: res({ physicalId: OLD_ID, resourceType: OLD_TYPE }),
    previousResourceType: OLD_TYPE,
    oldResourceRetained: false,
    ...overrides,
  };
}

/** The same op as a binary that predates `previousResourceType` wrote it. */
function legacyTypeChangeOp(): CompletedOperation {
  const { previousResourceType: _dropped, ...legacy } = typeChangeOp();
  return legacy;
}

type ProviderDouble = { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

function makeCtx(): {
  ctx: RollbackExecutorContext;
  providerFor: (type: string, layer?: 'sdk' | 'cc-api') => ProviderDouble;
  routingInputs: { resourceType: string; provisionedBy?: string }[];
} {
  const providers = new Map<string, ProviderDouble>();
  const routingInputs: { resourceType: string; provisionedBy?: string }[] = [];
  const providerFor = (type: string, layer: 'sdk' | 'cc-api' = 'sdk'): ProviderDouble => {
    const key = `${layer}:${type}`;
    let p = providers.get(key);
    if (!p) {
      p = {
        create: vi.fn().mockResolvedValue({ physicalId: RECREATED_OLD_ID, attributes: {} }),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      providers.set(key, p);
    }
    return p;
  };
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: (input: { resourceType: string; provisionedBy?: 'sdk' | 'cc-api' }) => {
        routingInputs.push(input);
        const layer = input.provisionedBy === 'cc-api' ? 'cc-api' : 'sdk';
        return { provider: providerFor(input.resourceType, layer), provisionedBy: layer };
      },
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
  return { ctx, providerFor, routingInputs };
}

const newRecord = (overrides: Partial<ResourceState> = {}): ResourceState =>
  res({ physicalId: NEW_ID, resourceType: NEW_TYPE, properties: { TopicName: 't' }, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveReplacementOldType', () => {
  it('reads the stamped field', () => {
    expect(resolveReplacementOldType(typeChangeOp())).toEqual({ ok: true, oldType: OLD_TYPE });
  });

  it('LEGACY journal: falls back to previousState.resourceType', () => {
    expect(resolveReplacementOldType(legacyTypeChangeOp())).toEqual({
      ok: true,
      oldType: OLD_TYPE,
    });
  });

  it('an ordinary same-type replacement resolves to that one type', () => {
    const op = typeChangeOp({
      resourceType: OLD_TYPE,
      previousResourceType: OLD_TYPE,
    });
    expect(resolveReplacementOldType(op)).toEqual({ ok: true, oldType: OLD_TYPE });
  });

  it('REFUSES when neither source names a type — never falls back to op.resourceType', () => {
    const op = legacyTypeChangeOp();
    delete (op.previousState as Partial<ResourceState>).resourceType;
    const verdict = resolveReplacementOldType(op);
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringMatching(/does not record/) });
  });

  it('REFUSES when the two sources disagree', () => {
    const verdict = resolveReplacementOldType(
      typeChangeOp({ previousResourceType: 'AWS::SQS::Queue' })
    );
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringMatching(/two different types/) });
  });

  for (const [label, oldType, newType] of [
    ['INTO a nested stack', OLD_TYPE, NESTED],
    ['OUT OF a nested stack', NESTED, NEW_TYPE],
  ] as const) {
    it(`REFUSES a Type change ${label}`, () => {
      const verdict = resolveReplacementOldType(
        typeChangeOp({
          resourceType: newType,
          previousResourceType: oldType,
          previousState: res({ physicalId: OLD_ID, resourceType: oldType }),
        })
      );
      expect(verdict.ok).toBe(false);
      expect(verdict).toMatchObject({ reason: expect.stringMatching(/nested stack/) });
    });
  }

  it('CONTROL: an ordinary nested-stack replacement (nested on BOTH sides) is routable', () => {
    expect(
      resolveReplacementOldType(
        typeChangeOp({
          resourceType: NESTED,
          previousResourceType: NESTED,
          previousState: res({ physicalId: OLD_ID, resourceType: NESTED }),
        })
      )
    ).toEqual({ ok: true, oldType: NESTED });
  });
});

describe('classification is type-aware', () => {
  it('a Type change that KEPT the physical id is a replacement, not an in-place revert', () => {
    // Overlapping namespaces: two types can share a bare-name id.
    const op = typeChangeOp({ physicalId: OLD_ID });
    expect(isTypeChangeOp(op)).toBe(true);
    expect(isReplacementOp(op)).toBe(true);
    const state = { Thing: newRecord({ physicalId: OLD_ID }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('reverse-replacement');
  });

  it('...and once reversed, the same op is already done (record is the OLD type again)', () => {
    const op = typeChangeOp({ physicalId: OLD_ID });
    const state = { Thing: res({ physicalId: OLD_ID, resourceType: OLD_TYPE }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('skip-already-done');
  });

  it('CONTROL: a same-type in-place update is still a plain revert', () => {
    const op = typeChangeOp({
      resourceType: OLD_TYPE,
      previousResourceType: OLD_TYPE,
      physicalId: OLD_ID,
    });
    expect(isReplacementOp(op)).toBe(false);
    const state = { Thing: res({ physicalId: OLD_ID, properties: { Value: 'changed' } }) };
    expect(classifyRollbackOp(op, state, new Set())).toBe('revert');
  });

  it('equal property bags do not read as "already reverted" while the record is the NEW type', () => {
    // The #3036 shape: two types, one identical bag. A later attempt moved the
    // id (matches neither), so only the bag comparison is left to decide.
    const op = typeChangeOp({ previousState: res({ physicalId: OLD_ID, properties: { t: 1 } }) });
    const moved = { Thing: newRecord({ physicalId: 'a-third-id', properties: { t: 1 } }) };
    expect(classifyRollbackOp(op, moved, new Set())).toBe('skip-mismatch');
    const movedOldType = {
      Thing: res({ physicalId: 'a-third-id', resourceType: OLD_TYPE, properties: { t: 1 } }),
    };
    expect(classifyRollbackOp(op, movedOldType, new Set())).toBe('skip-already-done');
  });

  it('an unroutable replacement is refused, but only AFTER the idempotent skips', () => {
    const op = typeChangeOp({ previousResourceType: 'AWS::SQS::Queue' });
    expect(classifyRollbackOp(op, { Thing: newRecord() }, new Set())).toBe(
      'refuse-replacement-routing'
    );
    // Already reverted → nothing to route, so nothing to refuse.
    expect(
      classifyRollbackOp(legacyTypeChangeOp(), { Thing: res({ physicalId: OLD_ID }) }, new Set())
    ).toBe('skip-already-done');
  });

  it('a Retain-ed Type change re-adopts (no create, so no old-type provider needed)', () => {
    expect(
      classifyRollbackOp(
        typeChangeOp({ oldResourceRetained: true }),
        { Thing: newRecord() },
        new Set()
      )
    ).toBe('reverse-replacement-readopt');
  });
});

describe('replayRollback reverses a Type-change replacement through BOTH types', () => {
  for (const [label, makeOp] of [
    ['stamped op', typeChangeOp],
    ['LEGACY op (previousState.resourceType only)', legacyTypeChangeOp],
  ] as const) {
    it(`${label}: re-creates through the OLD type, deletes the new one through the NEW type`, async () => {
      const { ctx, providerFor } = makeCtx();
      const state: Record<string, ResourceState> = { Thing: newRecord() };
      const result = await replayRollback([makeOp()], state, STACK, ctx);
      expect(result.failures).toBe(0);

      const oldProvider = providerFor(OLD_TYPE);
      const newProvider = providerFor(NEW_TYPE);
      // Re-create: old type's provider, told the old type, given the old bag.
      expect(oldProvider.create).toHaveBeenCalledTimes(1);
      const [, createType, createProps] = oldProvider.create.mock.calls[0]!;
      expect(createType).toBe(OLD_TYPE);
      expect(createProps).toEqual({ Value: 'v' });
      // The mis-route this replaces.
      expect(newProvider.create).not.toHaveBeenCalled();

      // Delete: the NEW resource, through the NEW type's provider.
      expect(newProvider.delete).toHaveBeenCalledTimes(1);
      const [, delId, delType] = newProvider.delete.mock.calls[0]!;
      expect(delId).toBe(NEW_ID);
      expect(delType).toBe(NEW_TYPE);
      expect(oldProvider.delete).not.toHaveBeenCalled();

      // State names the OLD type again, under the re-created id.
      expect(state['Thing']?.resourceType).toBe(OLD_TYPE);
      expect(state['Thing']?.physicalId).toBe(RECREATED_OLD_ID);
    });
  }

  it('routes the re-create on the OLD record layer and the delete on the NEW one', async () => {
    const { ctx, providerFor } = makeCtx();
    const op = typeChangeOp({
      provisionedBy: 'sdk',
      previousState: res({ physicalId: OLD_ID, resourceType: OLD_TYPE, provisionedBy: 'cc-api' }),
    });
    const state: Record<string, ResourceState> = { Thing: newRecord({ provisionedBy: 'sdk' }) };
    const result = await replayRollback([op], state, STACK, ctx);
    expect(result.failures).toBe(0);
    expect(providerFor(OLD_TYPE, 'cc-api').create).toHaveBeenCalledTimes(1);
    expect(providerFor(OLD_TYPE, 'sdk').create).not.toHaveBeenCalled();
    expect(providerFor(NEW_TYPE, 'sdk').delete).toHaveBeenCalledTimes(1);
  });

  it('an EQUAL id across the two types does not read as "adopted the live new resource"', async () => {
    // Same-type, that equality means a name-idempotent Create handed back the
    // live new resource, and the delete-new step is skipped. Across a Type
    // change it would strand the new type's resource, alive and untracked.
    const { ctx, providerFor } = makeCtx();
    providerFor(OLD_TYPE).create.mockResolvedValue({ physicalId: NEW_ID, attributes: {} });
    const state: Record<string, ResourceState> = { Thing: newRecord() };
    const result = await replayRollback([typeChangeOp()], state, STACK, ctx);
    expect(result.failures).toBe(0);
    expect(providerFor(NEW_TYPE).delete).toHaveBeenCalledTimes(1);
    expect(state['Thing']?.resourceType).toBe(OLD_TYPE);
  });

  describe('the custom-resource family is ONE id namespace; a shared provider instance is not', () => {
    // `Custom::Foo` -> `Custom::Bar`: a handler may return the same id for
    // both. The re-created "old" resource then IS the live one, and the
    // delete-new step would destroy what was restored. Keyed on the TYPES, not
    // on one provider instance serving both (IAM User / Group share one).
    const sharedCtx = (layer: 'sdk' | 'cc-api') => {
      const shared: ProviderDouble = {
        create: vi.fn().mockResolvedValue({ physicalId: NEW_ID, attributes: {} }),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      const ctx: RollbackExecutorContext = {
        region: 'us-east-1',
        logger: silentLogger,
        providerRegistry: {
          getProviderFor: () => ({ provider: shared, provisionedBy: layer }),
        } as unknown as RollbackExecutorContext['providerRegistry'],
      };
      return { ctx, shared };
    };
    const customOp = (): CompletedOperation =>
      typeChangeOp({
        resourceType: 'Custom::Bar',
        previousResourceType: 'Custom::Foo',
        previousState: res({ physicalId: OLD_ID, resourceType: 'Custom::Foo' }),
      });

    it('an equal id ADOPTS (warn) and deletes nothing', async () => {
      const { ctx, shared } = sharedCtx('sdk');
      const state: Record<string, ResourceState> = {
        Thing: newRecord({ resourceType: 'Custom::Bar' }),
      };
      const result = await replayRollback([customOp()], state, STACK, ctx);
      expect(result.failures).toBe(0);
      expect(result.warnings).toBe(1);
      expect(shared.delete).not.toHaveBeenCalled();
    });

    it('ONE instance serving two NON-custom types: the new resource IS deleted', async () => {
      const { ctx, shared } = sharedCtx('sdk');
      const op = typeChangeOp({
        resourceType: 'AWS::IAM::Group',
        previousResourceType: 'AWS::IAM::User',
        previousState: res({ physicalId: OLD_ID, resourceType: 'AWS::IAM::User' }),
      });
      const state: Record<string, ResourceState> = {
        Thing: newRecord({ resourceType: 'AWS::IAM::Group' }),
      };
      const result = await replayRollback([op], state, STACK, ctx);
      expect(result.failures).toBe(0);
      expect(result.warnings).toBe(0);
      expect(shared.delete).toHaveBeenCalledTimes(1);
      expect(shared.delete.mock.calls[0]![2]).toBe('AWS::IAM::Group');
      expect(state['Thing']?.resourceType).toBe('AWS::IAM::User');
    });

    it('custom types re-created through Cloud Control: the new resource is deleted', async () => {
      const { ctx, shared } = sharedCtx('cc-api');
      const state: Record<string, ResourceState> = {
        Thing: newRecord({ resourceType: 'Custom::Bar' }),
      };
      const result = await replayRollback([customOp()], state, STACK, ctx);
      expect(result.failures).toBe(0);
      expect(shared.delete).toHaveBeenCalledTimes(1);
      expect(shared.delete.mock.calls[0]![2]).toBe('Custom::Bar');
    });
  });

  it('warns about lost data when the OLD type is stateful, not when only the new one is', async () => {
    // OLD_TYPE (SSM parameter) is stateful; NEW_TYPE (topic) is not.
    const { ctx } = makeCtx();
    await replayRollback([typeChangeOp()], { Thing: newRecord() }, STACK, ctx);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`(${OLD_TYPE}) is a stateful type`));

    warn.mockClear();
    const reversed = typeChangeOp({
      resourceType: OLD_TYPE,
      previousResourceType: NEW_TYPE,
      previousState: res({ physicalId: NEW_ID, resourceType: NEW_TYPE }),
      physicalId: OLD_ID,
    });
    const { ctx: ctx2 } = makeCtx();
    await replayRollback(
      [reversed],
      { Thing: res({ physicalId: OLD_ID, resourceType: OLD_TYPE }) },
      STACK,
      ctx2
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is a stateful type'));
  });

  it('a Cloud Control re-create fills the generated name for the OLD type', async () => {
    // `AWS::SQS::Queue` has a fallback-name rule; the new type here does not.
    // Keyed on `op.resourceType` the replay would send a nameless create.
    const { ctx, providerFor } = makeCtx();
    const op = typeChangeOp({
      previousResourceType: 'AWS::SQS::Queue',
      previousState: res({
        physicalId: OLD_ID,
        resourceType: 'AWS::SQS::Queue',
        properties: {},
        provisionedBy: 'cc-api',
      }),
    });
    await withStackName(STACK, () =>
      replayRollback([op], { Thing: newRecord() }, STACK, ctx)
    );
    const create = providerFor('AWS::SQS::Queue', 'cc-api').create;
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![2]).toEqual(
      applyDefaultNameForFallbackUnderStack('Thing', 'AWS::SQS::Queue')
    );
    expect(Object.keys(create.mock.calls[0]![2] as object).length).toBeGreaterThan(0);
  });

  it('the delete-new-first fallback re-creates with the OLD type too', async () => {
    const { ctx, providerFor } = makeCtx();
    providerFor(OLD_TYPE)
      .create.mockRejectedValueOnce(
        ccAlreadyExistsError(`CREATE failed for Thing: Resource of type '${OLD_TYPE}' already exists.`)
      )
      .mockResolvedValue({ physicalId: RECREATED_OLD_ID, attributes: {} });
    const state: Record<string, ResourceState> = { Thing: newRecord() };
    const result = await replayRollback([typeChangeOp()], state, STACK, ctx);
    expect(result.failures).toBe(0);
    const create = providerFor(OLD_TYPE).create;
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![1]).toBe(OLD_TYPE);
    expect(providerFor(NEW_TYPE).delete).toHaveBeenCalledTimes(1);
  });

  it('re-adopt replay: deletes the new resource through the NEW type, restores the OLD record', async () => {
    const { ctx, providerFor } = makeCtx();
    const state: Record<string, ResourceState> = { Thing: newRecord() };
    const result = await replayRollback(
      [typeChangeOp({ oldResourceRetained: true })],
      state,
      STACK,
      ctx
    );
    expect(result.failures).toBe(0);
    expect(providerFor(NEW_TYPE).delete).toHaveBeenCalledTimes(1);
    expect(providerFor(NEW_TYPE).delete.mock.calls[0]![2]).toBe(NEW_TYPE);
    expect(providerFor(OLD_TYPE).create).not.toHaveBeenCalled();
    expect(state['Thing']?.resourceType).toBe(OLD_TYPE);
    expect(state['Thing']?.physicalId).toBe(OLD_ID);
  });

  it('REFUSES an unroutable op without touching AWS or state, and counts a FAILURE', async () => {
    const { ctx, providerFor, routingInputs } = makeCtx();
    const op = legacyTypeChangeOp();
    delete (op.previousState as Partial<ResourceState>).resourceType;
    const before = newRecord();
    const state: Record<string, ResourceState> = { Thing: before };
    const result = await replayRollback([op], state, STACK, ctx);
    // A failure, not a warning: a warning lets the segment pop and discards the
    // only record of this op.
    expect(result.failures).toBe(1);
    expect(routingInputs).toEqual([]);
    expect(providerFor(NEW_TYPE).create).not.toHaveBeenCalled();
    expect(providerFor(NEW_TYPE).delete).not.toHaveBeenCalled();
    expect(state['Thing']).toBe(before);
  });

  it('REFUSES a legacy into-nested-stack op rather than replaying it', async () => {
    const { ctx, routingInputs } = makeCtx();
    const op = legacyTypeChangeOp();
    op.resourceType = NESTED;
    op.physicalId = `${STACK}~Thing`;
    const state: Record<string, ResourceState> = {
      Thing: newRecord({ resourceType: NESTED, physicalId: `${STACK}~Thing` }),
    };
    const result = await replayRollback([op], state, STACK, ctx);
    expect(result.failures).toBe(1);
    expect(routingInputs).toEqual([]);
  });

  it('--orphan lets the rest of the rollback past a refused op', async () => {
    const { ctx, routingInputs } = makeCtx();
    const op = typeChangeOp({ previousResourceType: 'AWS::SQS::Queue' });
    const state: Record<string, ResourceState> = { Thing: newRecord() };
    const result = await replayRollback([op], state, STACK, ctx, {
      orphanLogicalIds: new Set(['Thing']),
    });
    expect(result.failures).toBe(0);
    expect(routingInputs).toEqual([]);
  });
});

describe('--revert-failed does not aim an in-place update across a Type change', () => {
  const failedOp = (): FailedOperation => ({
    logicalId: 'Thing',
    changeType: 'UPDATE',
    resourceType: NEW_TYPE,
    physicalId: OLD_ID,
    previousState: res({ physicalId: OLD_ID, resourceType: OLD_TYPE }),
    attemptedProperties: { TopicName: 't' },
  });

  it('classifies a failed Type change as a skip', () => {
    expect(classifyFailedOp(failedOp(), { Thing: res({ physicalId: OLD_ID }) })).toBe(
      'skip-failed-type-change'
    );
  });

  it('CONTROL: a failed same-type UPDATE is still force-reverted', () => {
    const op = { ...failedOp(), resourceType: OLD_TYPE };
    expect(classifyFailedOp(op, { Thing: res({ physicalId: OLD_ID }) })).toBe(
      'revert-failed-update'
    );
  });

  it('replays it as a warning with no provider lookup at all', async () => {
    const { ctx, routingInputs } = makeCtx();
    const state: Record<string, ResourceState> = { Thing: res({ physicalId: OLD_ID }) };
    const result = await replayFailedOperations([failedOp()], state, STACK, ctx);
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(1);
    expect(routingInputs).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Type change'));
  });
});

describe('the journal parser validates previousResourceType', () => {
  const journal = (previousResourceType: unknown): string =>
    JSON.stringify({
      journalVersion: 1,
      stackName: STACK,
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [{ ...typeChangeOp(), previousResourceType }],
        },
      ],
    });

  it('round-trips a string, with NO journalVersion bump', () => {
    const parsed = parseRollbackJournal(journal(OLD_TYPE), STACK);
    expect(parsed.journalVersion).toBe(1);
    expect(parsed.segments[0]!.operations[0]!.previousResourceType).toBe(OLD_TYPE);
  });

  it('reads a journal that has no such field (written before it existed)', () => {
    const parsed = parseRollbackJournal(journal(undefined), STACK);
    expect(parsed.segments[0]!.operations[0]!.previousResourceType).toBeUndefined();
  });

  it('refuses a non-string: the value picks a provider', () => {
    expect(() => parseRollbackJournal(journal(42), STACK)).toThrow(/previousResourceType/);
  });
});
