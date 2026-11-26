/**
 * go-to-k/cdkd#6638: the backstop in `applyRevertUpdate`. A provider whose
 * revert `update()` REPLACED the resource (`wasReplaced`, or a physical id
 * other than the recorded one) is counted FAILED and named on an error line,
 * never reported "reverted"; the record still takes the identity AWS now
 * holds, so the replacement is not orphaned. A provider refusing the
 * replacement (`revertReplacementRefusal`) is counted update-not-supported.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  applyRevertUpdate,
  revertReplacementOf,
} from '../../../src/cli/commands/drift/revert-apply.js';
import type { ApplyRevertUpdateArgs } from '../../../src/cli/commands/drift/revert-outcome.js';
import { revertReplacementRefusal } from '../../../src/provisioning/revert-no-replace.js';
import type { ResourceProvider, ResourceUpdateResult } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

const RECORDED_ID = 'arn:aws:sns:us-east-1:123456789012:orders:old-0001';
const NEW_ID = 'arn:aws:sns:us-east-1:123456789012:orders:new-0002';

function harness(update: ResourceProvider['update']) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const tally = { totalFailed: 0, totalUnsupported: 0, totalSucceeded: 0, totalUnresolvable: 0, reverted: [] };
  const reRecordedByLogicalId: ApplyRevertUpdateArgs['reRecordedByLogicalId'] = new Map();
  const stateResource = {
    physicalId: RECORDED_ID,
    resourceType: 'AWS::SNS::Subscription',
    properties: { RawMessageDelivery: 'true' },
    attributes: { Arn: RECORDED_ID },
    dependencies: [],
  } as unknown as ResourceState;
  const provider = { create: vi.fn(), update: vi.fn(update), delete: vi.fn() };
  const args = {
    logger,
    tally,
    report: { stackName: 'MyStack', region: 'us-east-1', state: { resources: {} } },
    narrowedByLogicalId: new Map(),
    reRecordedByLogicalId,
    settledByRevert: new Map(),
    outcome: {
      kind: 'drifted',
      logicalId: 'OrdersSub',
      resourceType: 'AWS::SNS::Subscription',
      changes: [],
      awsProperties: { RawMessageDelivery: 'false' },
      uncertifiedPaths: [],
    },
    stateResource,
    provider,
    secrets: new Map<string, string>(),
    revertBaseline: { RawMessageDelivery: 'true' },
    newProperties: { RawMessageDelivery: 'true' },
  } as unknown as ApplyRevertUpdateArgs;
  return { args, logger, tally, reRecordedByLogicalId, provider };
}

const lines = (fn: ReturnType<typeof vi.fn>): string[] => fn.mock.calls.map((c) => String(c[0]));

describe('revertReplacementOf', () => {
  it.each<[string, ResourceUpdateResult | undefined, boolean]>([
    ['no result', undefined, false],
    ['same id, in place', { physicalId: RECORDED_ID, wasReplaced: false }, false],
    ['a new id', { physicalId: NEW_ID, wasReplaced: true }, true],
    ['a new id without the flag', { physicalId: NEW_ID, wasReplaced: false }, true],
    ['the flag under the same id', { physicalId: RECORDED_ID, wasReplaced: true }, true],
    ['an empty id is no new id', { physicalId: '', wasReplaced: false }, false],
  ])('%s', (_l, result, replaced) => {
    expect(
      revertReplacementOf(RECORDED_ID, result, 'AWS::SNS::Subscription') !== undefined
    ).toBe(replaced);
  });
});

describe('applyRevertUpdate (#6638 backstop)', () => {
  it.each<[string, ResourceUpdateResult]>([
    ['a new physical id', { physicalId: NEW_ID, wasReplaced: true, attributes: { Arn: NEW_ID } }],
    [
      'wasReplaced under the same id',
      { physicalId: RECORDED_ID, wasReplaced: true, attributes: { Arn: RECORDED_ID } },
    ],
  ])('a provider answering %s is a named FAILURE, never "reverted"', async (_l, result) => {
    const h = harness(() => Promise.resolve(result));
    await applyRevertUpdate(h.args);

    expect(h.tally).toMatchObject({ totalFailed: 1, totalSucceeded: 0, totalUnsupported: 0 });
    const errors = lines(h.logger.error);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('MyStack/OrdersSub (AWS::SNS::Subscription)');
    expect(errors[0]).toContain('REPLACED the resource or changed its identity instead of reverting it in place');
    expect(lines(h.logger.info).some((l) => l.includes('reverted.'))).toBe(false);
  });

  it('wasReplaced under the recorded id is named as a replacement under the same physical id', async () => {
    const h = harness(() =>
      Promise.resolve({ physicalId: RECORDED_ID, wasReplaced: true, attributes: { Arn: RECORDED_ID } })
    );
    await applyRevertUpdate(h.args);
    expect(lines(h.logger.error)[0]).toContain(
      `reported a replacement under the same physical id ${RECORDED_ID}`
    );
  });

  it('the record still names what AWS now holds, so the replacement is not orphaned', async () => {
    const h = harness(() =>
      Promise.resolve({ physicalId: NEW_ID, wasReplaced: true, attributes: { Arn: NEW_ID } })
    );
    await applyRevertUpdate(h.args);
    expect(lines(h.logger.error)[0]).toContain(`physical id ${RECORDED_ID} became ${NEW_ID}`);
    expect(h.reRecordedByLogicalId.get('OrdersSub')).toEqual({
      physicalId: NEW_ID,
      attributes: { Arn: NEW_ID },
    });
  });

  it('a replacement whose attributes cannot be recorded says replaced, not reverted', async () => {
    const attributes = {};
    Object.defineProperty(attributes, 'Arn', {
      enumerable: true,
      get: () => {
        throw new Error('unreadable attribute');
      },
    });
    const h = harness(() => Promise.resolve({ physicalId: NEW_ID, wasReplaced: true, attributes }));
    await applyRevertUpdate(h.args);
    expect(h.tally).toMatchObject({ totalFailed: 1, totalSucceeded: 0 });
    const warns = lines(h.logger.warn);
    expect(warns.some((l) => l.includes('replaced, but the attributes the provider returned could not be recorded'))).toBe(true);
    expect(warns.some((l) => l.includes('reverted, but'))).toBe(false);
  });

  it('an in-place answer is still a success', async () => {
    const h = harness(() =>
      Promise.resolve({ physicalId: RECORDED_ID, wasReplaced: false, attributes: { Arn: RECORDED_ID } })
    );
    await applyRevertUpdate(h.args);
    expect(h.tally).toMatchObject({ totalFailed: 0, totalSucceeded: 1 });
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(lines(h.logger.info).some((l) => l.includes('OrdersSub (AWS::SNS::Subscription): reverted.'))).toBe(true);
    expect(h.reRecordedByLogicalId.size).toBe(0);
  });

  it("a provider's revert refusal is counted update-not-supported and records nothing", async () => {
    const h = harness(() =>
      Promise.reject(
        revertReplacementRefusal(
          'AWS::SNS::Subscription',
          'OrdersSub',
          'FilterPolicy and FilterPolicyScope change together'
        )
      )
    );
    await applyRevertUpdate(h.args);
    expect(h.tally).toMatchObject({ totalUnsupported: 1, totalFailed: 0, totalSucceeded: 0 });
    expect(h.provider.update).toHaveBeenCalledTimes(1);
    const warns = lines(h.logger.warn);
    expect(warns.some((l) => l.includes('⊘ MyStack/OrdersSub') && l.includes('could not revert'))).toBe(
      true
    );
    expect(h.reRecordedByLogicalId.size).toBe(0);
  });
});
