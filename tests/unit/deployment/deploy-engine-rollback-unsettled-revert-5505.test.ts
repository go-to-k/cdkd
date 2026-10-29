/**
 * go-to-k/cdkd#5505, through the real `DeployEngine`: the automatic rollback
 * also reverts what the failed UPDATE left unsettled, as CloudFormation rolls a
 * failed update back. It waits (bounded) for the keys to stop moving, reverts
 * through the `--revert-failed` arm with the RECORD as the previous side, and
 * clears a name only on the post-check's proof. A key still moving, or a
 * revert that fails, keeps the names and the journal entry. `--no-rollback`
 * is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const log = vi.hoisted(() => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): unknown => fns,
  };
  return fns;
});
vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => log }));
vi.mock('../../../src/utils/aws-clients.js', () => {
  const clients = (region: string): Record<string, unknown> => ({
    sts: { send: async () => ({ Account: '123456789012' }) },
    credentialConfig: {},
    config: { region: () => Promise.resolve(region) },
    withRegion: (target: string) => clients(target),
  });
  return { getAwsClients: () => clients('us-east-1') };
});
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { markNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { waitForUnsettledSettled } from '../../../src/deployment/unsettled-convergence.js';
import {
  revertUnsettledFailedUpdates,
  rollbackExecutorContext,
} from '../../../src/deployment/deploy-engine/rollback.js';
import { RollbackInlinePolicyWriters } from '../../../src/deployment/inline-policy-claims.js';
import type { FailedOperation } from '../../../src/deployment/rollback-executor.js';
import type { CloudFormationTemplate, UpdateContext } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const TYPE = 'AWS::KinesisFirehose::DeliveryStream';
const ENC = 'DeliveryStreamEncryptionConfigurationInput';

interface Call {
  props: Record<string, unknown>;
  prev: Record<string, unknown>;
  context: UpdateContext | undefined;
}

interface Run {
  thrown: unknown;
  calls: Call[];
  saved: StackState | undefined;
  /** Every journal segment appended, in order. */
  segments: Array<Record<string, unknown>>;
  transitionCalls: number;
}

/** A non-retryable failure, so the engine's retry backoff does not run. */
const failure = (message: string): Error => markNonRetryable(new Error(message));

async function deploy(opts: {
  record?: Partial<ResourceState>;
  template: CloudFormationTemplate;
  /** The deploy's update (call 0) and the rollback's revert (call 1). */
  update: (call: number, context: UpdateContext | undefined) => Promise<void>;
  /** `unsettledInTransition`'s answer per poll; absent = no hook. */
  moving?: (poll: number) => string[];
  /** What AWS holds now, per read (`readUnsettled`). */
  live?: (call: number) => Record<string, unknown>;
  options?: Record<string, unknown>;
  /** Set the user's Ctrl-C (`userInterrupted`) when this answers true for a poll. */
  interruptAt?: (poll: number) => boolean;
}): Promise<Run> {
  const calls: Call[] = [];
  const segments: Array<Record<string, unknown>> = [];
  let polls = 0;
  let engineRef: DeployEngine | undefined;
  const provider: Record<string, unknown> = {
    create: vi.fn(),
    update: vi.fn(
      async (
        _id: string,
        pid: string,
        _type: string,
        props: Record<string, unknown>,
        prev: Record<string, unknown>,
        context?: UpdateContext
      ) => {
        const call = calls.length;
        calls.push({ props, prev, context });
        await opts.update(call, context);
        return { physicalId: pid, attributes: {} };
      }
    ),
    delete: vi.fn(),
    getAttribute: vi.fn(),
  };
  if (opts.moving !== undefined) {
    const moving = opts.moving;
    provider['unsettledInTransition'] = vi.fn(async () => {
      const poll = polls++;
      if (opts.interruptAt?.(poll) === true && engineRef !== undefined) {
        (engineRef as { userInterrupted: boolean }).userInterrupted = true;
      }
      return new Set(moving(poll));
    });
  }
  if (opts.live !== undefined) {
    const live = opts.live;
    provider['readUnsettled'] = vi.fn(async () => live(calls.length));
  }
  const state: StackState = {
    version: 15,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      S: {
        physicalId: 'stream',
        resourceType: TYPE,
        properties: { DeliveryStreamName: 'stream' },
        attributes: {},
        dependencies: [],
        ...opts.record,
      } as ResourceState,
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const saves: StackState[] = [];
  const engine = new DeployEngine(
    {
      getState: vi.fn(async () => ({ state, etag: 'e0' })),
      saveState: vi.fn(async (_s: string, _r: string, saved: StackState) => {
        saves.push(JSON.parse(JSON.stringify(saved)) as StackState);
        return 'etag';
      }),
      getStateIfExists: vi.fn(async () => ({ state, etag: 'e0' })),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn(async (_s: string, _r: string, segment: unknown) => {
        segments.push(JSON.parse(JSON.stringify(segment)) as Record<string, unknown>);
      }),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['S']]),
      getDirectDependencies: vi.fn(() => []),
    } as never,
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    {
      dryRun: false,
      forceStatefulRecreation: true,
      unsettledRevertWait: { timeoutMs: 2_000, pollMs: 5 },
      ...opts.options,
    },
    'us-east-1'
  );
  engineRef = engine;
  let thrown: unknown;
  await engine.deploy('s', opts.template).catch((e: unknown) => {
    thrown = e;
  });
  return { thrown, calls, saved: saves.at(-1), segments, transitionCalls: polls };
}

const templateOf = (properties: Record<string, unknown>): CloudFormationTemplate =>
  ({ Resources: { S: { Type: TYPE, Properties: properties } } }) as CloudFormationTemplate;

const encrypted = templateOf({ DeliveryStreamName: 'stream', [ENC]: { KeyType: 'AWS_OWNED_CMK' } });

/** The deploy's update marks the key and fails; the revert does `revert`. */
const failsThen =
  (revert: () => Promise<void> = async () => undefined) =>
  async (call: number, context: UpdateContext | undefined): Promise<void> => {
    if (call === 0) {
      context?.markUnsettled?.(ENC);
      throw failure('ENABLING_FAILED');
    }
    await revert();
  };

const warned = (needle: string): boolean =>
  log.warn.mock.calls.some((args) => String(args[0]).includes(needle));

const infoed = (needle: string): boolean =>
  log.info.mock.calls.some((args) => String(args[0]).includes(needle));

/** Whether the last journal write keeps a failed op for `--revert-failed`. */
const keptForRevertFailed = (run: Run): boolean =>
  run.segments.some(
    (segment) =>
      segment['reason'] === 'auto-rollback-clean' &&
      JSON.stringify(segment['failedOperations'] ?? []).includes('"S"')
  );

beforeEach(() => {
  log.warn.mockClear();
  log.info.mockClear();
});

describe('the automatic rollback reverts what a failed update left unsettled (go-to-k/cdkd#5505)', () => {
  it('waits for the key to settle, reverts it to the record, and clears the name on proof', async () => {
    const run = await deploy({
      template: encrypted,
      update: failsThen(),
      moving: (poll) => (poll < 2 ? [ENC] : []),
      // AWS holds the attempted encryption until the revert lands, then none.
      live: (call) => (call < 2 ? { [ENC]: { KeyType: 'AWS_OWNED_CMK' } } : {}),
    });
    expect(run.thrown).toBeDefined();
    // Premise: it polled while the key moved, then reverted once.
    expect(run.transitionCalls).toBeGreaterThanOrEqual(3);
    expect(run.calls).toHaveLength(2);
    const revert = run.calls[1]!;
    expect(revert.props).toEqual({ DeliveryStreamName: 'stream' });
    // The previous side took the key from AWS.
    expect(revert.prev[ENC]).toEqual({ KeyType: 'AWS_OWNED_CMK' });
    expect(revert.context?.unsettledProperties).toEqual(new Set([ENC]));
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledProperties');
    // Handled: the journal keeps no failed op for `--revert-failed`.
    expect(keptForRevertFailed(run)).toBe(false);
  });

  it('keeps the name when the post-check cannot prove AWS settled', async () => {
    const run = await deploy({
      // The record declares a value, so the read is compared against it.
      record: {
        properties: { DeliveryStreamName: 'stream', [ENC]: { KeyType: 'CUSTOMER_MANAGED_CMK' } },
      },
      template: encrypted,
      update: failsThen(),
      moving: () => [],
      // AWS still reports the attempted encryption after the revert.
      live: () => ({ [ENC]: { KeyType: 'AWS_OWNED_CMK' } }),
    });
    expect(run.calls).toHaveLength(2);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
    expect(warned('AWS does not yet show the requested')).toBe(true);
  });

  it('keeps the name and warns when the key never settles within the bound', async () => {
    const run = await deploy({
      template: encrypted,
      update: failsThen(),
      moving: () => [ENC],
      options: { unsettledRevertWait: { timeoutMs: 40, pollMs: 5 } },
    });
    expect(run.thrown).toBeDefined();
    expect(run.calls).toHaveLength(1);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
    expect(warned('the automatic rollback did not revert it')).toBe(true);
    expect(keptForRevertFailed(run)).toBe(true);
  });

  it('keeps the name, the journal entry, and warns when the revert fails', async () => {
    const run = await deploy({
      template: encrypted,
      update: failsThen(async () => {
        throw failure('revert refused');
      }),
      moving: () => [],
    });
    expect(run.calls).toHaveLength(2);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
    expect(warned('could not revert what the failed update left unsettled')).toBe(true);
    // Not a rollback failure: the clean settle keeps it for `--revert-failed`.
    expect(keptForRevertFailed(run)).toBe(true);
  });

  it('reverts nothing for a failed update that marked nothing (still opt-in)', async () => {
    const run = await deploy({
      template: encrypted,
      update: async () => {
        throw failure('refused before sending');
      },
      moving: () => [],
    });
    expect(run.calls).toHaveLength(1);
    expect(run.transitionCalls).toBe(0);
  });

  it('--no-rollback keeps today\'s behaviour: no wait, no revert, the name kept', async () => {
    const run = await deploy({
      template: encrypted,
      update: failsThen(),
      moving: () => [],
      live: () => ({}),
      options: { noRollback: true },
    });
    expect(run.calls).toHaveLength(1);
    expect(run.transitionCalls).toBe(0);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
  });

  it('waits for the update call the deadline abandoned, and reverts its late marks too', async () => {
    const events: string[] = [];
    const run = await deploy({
      template: templateOf({
        DeliveryStreamName: 'stream',
        [ENC]: { KeyType: 'AWS_OWNED_CMK' },
        Note: 'attempted',
      }),
      update: async (call, context) => {
        if (call === 0) {
          context?.markUnsettled?.(ENC);
          // Past the 60 ms deadline: the engine has given up on this call.
          await new Promise((r) => setTimeout(r, 200));
          context?.markUnsettled?.('Note');
          events.push('abandoned call returned');
          throw failure('Note cut short');
        }
        events.push('revert');
      },
      moving: () => [],
      live: () => ({}),
      options: {
        resourceWarnAfterByType: { [TYPE]: 20 },
        resourceTimeoutByType: { [TYPE]: 60 },
      },
    });
    expect(run.thrown).toBeDefined();
    expect(events).toEqual(['abandoned call returned', 'revert']);
    expect(run.calls[1]!.context?.unsettledProperties).toEqual(new Set([ENC, 'Note']));
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledProperties');
  });

  it('an abandoned call that then completes is reverted whole, from the record it wrote', async () => {
    const run = await deploy({
      template: templateOf({
        DeliveryStreamName: 'stream',
        [ENC]: { KeyType: 'AWS_OWNED_CMK' },
        Note: 'attempted',
      }),
      update: async (call, context) => {
        if (call === 0) {
          context?.markUnsettled?.(ENC);
          await new Promise((r) => setTimeout(r, 200));
        }
      },
      moving: () => [],
      live: () => ({}),
      options: {
        resourceWarnAfterByType: { [TYPE]: 20 },
        resourceTimeoutByType: { [TYPE]: 60 },
      },
    });
    expect(run.thrown).toBeDefined();
    expect(run.calls).toHaveLength(2);
    // The late success wrote its record: the whole update is undone.
    expect(run.calls[1]!.prev).toHaveProperty('Note', 'attempted');
    expect(run.calls[1]!.props).toEqual({ DeliveryStreamName: 'stream' });
    expect(run.saved?.resources['S']?.properties).toEqual({ DeliveryStreamName: 'stream' });
    expect(infoed('whose call completed after the deploy gave up on it')).toBe(true);
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledProperties');
  });

  it('takes the record, not the attempted bag, as the previous side', async () => {
    const run = await deploy({
      template: templateOf({
        DeliveryStreamName: 'stream',
        [ENC]: { KeyType: 'AWS_OWNED_CMK' },
        Other: 'attempted',
      }),
      update: failsThen(),
      moving: () => [],
      live: (call) => (call < 2 ? { [ENC]: { KeyType: 'AWS_OWNED_CMK' } } : {}),
    });
    expect(run.calls).toHaveLength(2);
    // A key the attempt sent but did not leave unsettled is not reverted.
    expect(run.calls[1]!.prev).not.toHaveProperty('Other');
    expect(run.calls[1]!.prev).toHaveProperty('DeliveryStreamName', 'stream');
  });
});

describe('removing a tag the failed update added (go-to-k/cdkd#5505 on #5498)', () => {
  const tagged = (tags: Array<[string, string]>): Array<{ Key: string; Value: string }> =>
    tags.map(([Key, Value]) => ({ Key, Value }));

  it('removes only a tag that is attempted AND absent from the pre-failure record', async () => {
    const run = await deploy({
      record: {
        properties: { DeliveryStreamName: 'stream', Tags: tagged([['keep', '1']]) },
      },
      template: templateOf({
        DeliveryStreamName: 'stream',
        Tags: tagged([
          ['keep', '1'],
          ['added', '2'],
        ]),
      }),
      update: async (call, context) => {
        if (call === 0) {
          context?.markUnsettled?.('Tags');
          // `keep` is attempted too, but the record already declares it.
          context?.markAttempted?.('Tags', ['added', 'keep']);
          throw failure('tagging cut short');
        }
      },
      moving: () => [],
      // `foreign` is live but no call of the failed update added it.
      live: (call) => ({
        Tags:
          call < 2
            ? tagged([
                ['keep', '1'],
                ['added', '2'],
                ['foreign', '3'],
              ])
            : tagged([
                ['keep', '1'],
                ['foreign', '3'],
              ]),
      }),
    });
    expect(run.calls).toHaveLength(2);
    const revert = run.calls[1]!;
    expect(revert.props['Tags']).toEqual(tagged([['keep', '1']]));
    // The previous side gains exactly the attempted, unrecorded tag.
    expect(revert.prev['Tags']).toEqual(
      tagged([
        ['keep', '1'],
        ['added', '2'],
      ])
    );
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledProperties');
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledItems');
  });
});

describe('only THIS run\'s marks are reverted (go-to-k/cdkd#5505 review B1)', () => {
  it('a name an earlier failed deploy left is neither waited for nor reverted', async () => {
    const run = await deploy({
      // deploy1 failed under --no-rollback and left ENC; this deploy marks nothing.
      record: { unsettledProperties: [ENC] },
      template: encrypted,
      update: async () => {
        throw failure('refused before sending');
      },
      moving: () => [],
      live: () => ({}),
    });
    expect(run.calls).toHaveLength(1);
    expect(infoed('Rollback: waiting for')).toBe(false);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
  });

  it("reverts this run's name and keeps an earlier deploy's other name", async () => {
    const run = await deploy({
      record: {
        properties: { DeliveryStreamName: 'stream', Other: 'kept' },
        unsettledProperties: ['Other'],
      },
      template: templateOf({
        DeliveryStreamName: 'stream',
        Other: 'kept',
        [ENC]: { KeyType: 'AWS_OWNED_CMK' },
      }),
      update: failsThen(),
      moving: () => [],
      live: (call) => (call < 2 ? { [ENC]: { KeyType: 'AWS_OWNED_CMK' } } : {}),
    });
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]!.context?.unsettledProperties).toEqual(new Set([ENC]));
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual(['Other']);
    // Not a late success: the record-side revert never touches `Other`, so
    // there is nothing to leave out.
    expect(warned('left unsettled by an earlier failed deploy')).toBe(false);
  });

  it("a shared name removes only this run's attempted item and keeps the earlier one", async () => {
    const tagged = (tags: Array<[string, string]>): Array<{ Key: string; Value: string }> =>
      tags.map(([Key, Value]) => ({ Key, Value }));
    const run = await deploy({
      // deploy1 (--no-rollback) was accepted for adding `old` and failed.
      record: {
        properties: { DeliveryStreamName: 'stream', Tags: tagged([['keep', '1']]) },
        unsettledProperties: ['Tags'],
        unsettledItems: { Tags: ['old'] },
      },
      template: templateOf({
        DeliveryStreamName: 'stream',
        Tags: tagged([
          ['keep', '1'],
          ['added', '2'],
        ]),
      }),
      update: async (call, context) => {
        if (call === 0) {
          context?.markUnsettled?.('Tags');
          context?.markAttempted?.('Tags', ['added']);
          throw failure('tagging cut short');
        }
      },
      moving: () => [],
      live: (call) => ({
        Tags:
          call < 2
            ? tagged([
                ['keep', '1'],
                ['old', '0'],
                ['added', '2'],
              ])
            : tagged([
                ['keep', '1'],
                ['old', '0'],
              ]),
      }),
    });
    expect(run.calls).toHaveLength(2);
    // `old` is not on the previous side: this run never added it.
    expect(run.calls[1]!.prev['Tags']).toEqual(
      tagged([
        ['keep', '1'],
        ['added', '2'],
      ])
    );
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual(['Tags']);
    expect(run.saved?.resources['S']?.unsettledItems).toEqual({ Tags: ['old'] });
  });
});

describe('a call the deadline abandoned (go-to-k/cdkd#5505 review C1 / T3)', () => {
  const deadline = {
    resourceWarnAfterByType: { [TYPE]: 20 },
    resourceTimeoutByType: { [TYPE]: 60 },
  };

  it('is a candidate although the deadline fired before its first mark', async () => {
    const run = await deploy({
      template: encrypted,
      update: async (call, context) => {
        if (call === 0) {
          await new Promise((r) => setTimeout(r, 150));
          context?.markUnsettled?.(ENC);
          throw failure('ENABLING_FAILED');
        }
      },
      moving: () => [],
      live: () => ({}),
      options: deadline,
    });
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]!.context?.unsettledProperties).toEqual(new Set([ENC]));
    expect(run.saved?.resources['S']).not.toHaveProperty('unsettledProperties');
  });

  it('that then fails without marking is left alone, without a warning', async () => {
    const run = await deploy({
      template: encrypted,
      update: async () => {
        await new Promise((r) => setTimeout(r, 150));
        throw failure('refused late');
      },
      moving: () => [],
      options: deadline,
    });
    expect(run.calls).toHaveLength(1);
    expect(warned('the automatic rollback did not revert')).toBe(false);
  });

  it('that never returns within the bound is not reverted, with its own warning', async () => {
    const run = await deploy({
      template: encrypted,
      update: async (call, context) => {
        if (call === 0) {
          context?.markUnsettled?.(ENC);
          await new Promise(() => undefined);
        }
      },
      moving: () => [],
      options: { ...deadline, unsettledRevertWait: { timeoutMs: 150, pollMs: 5 } },
    });
    expect(run.calls).toHaveLength(1);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
    expect(warned("cdkd's own update call, abandoned at the per-resource deadline, had not returned")).toBe(
      true
    );
    expect(warned('AWS had not settled')).toBe(false);
  });
});

describe('a late success over an earlier deploy\'s unsettled key (go-to-k/cdkd#5505 review R1)', () => {
  it("leaves the earlier deploy's key out of the whole-update revert, and keeps its name", async () => {
    const run = await deploy({
      // deploy1 (--no-rollback) left `Other` unsettled.
      record: {
        properties: { DeliveryStreamName: 'stream', Other: 'pre' },
        unsettledProperties: ['Other'],
      },
      template: templateOf({
        DeliveryStreamName: 'stream',
        Other: 'late',
        [ENC]: { KeyType: 'AWS_OWNED_CMK' },
      }),
      update: async (call, context) => {
        if (call === 0) {
          context?.markUnsettled?.(ENC);
          // Completes after the 60 ms deadline, rewriting the record.
          await new Promise((r) => setTimeout(r, 200));
        }
      },
      moving: () => [],
      live: () => ({}),
      options: {
        resourceWarnAfterByType: { [TYPE]: 20 },
        resourceTimeoutByType: { [TYPE]: 60 },
      },
    });
    expect(run.calls).toHaveLength(2);
    const revert = run.calls[1]!;
    // `Other` is equal on both sides: not undone, nothing of it removed.
    expect(revert.prev['Other']).toEqual(revert.props['Other']);
    // A key the earlier deploy did not leave is reverted as before.
    expect(revert.prev[ENC]).toEqual({ KeyType: 'AWS_OWNED_CMK' });
    expect(revert.props).not.toHaveProperty(ENC);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual(['Other']);
    expect(warned('left unsettled by an earlier failed deploy')).toBe(true);
  });
});

describe('a Ctrl-C during the automatic rollback (go-to-k/cdkd#5505 review T1)', () => {
  it('during the wait: no revert, the name kept, the rollback reported interrupted', async () => {
    const run = await deploy({
      template: encrypted,
      update: failsThen(),
      moving: () => [ENC],
      // The deploy itself never polls (nothing was unsettled before it).
      interruptAt: () => true,
    });
    expect(run.calls).toHaveLength(1);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
    expect(warned('The automatic rollback was interrupted')).toBe(true);
    expect(warned('did not revert')).toBe(false);
  });

  it('after the wait settled: the replay stops, and no "could not revert" line', async () => {
    const run = await deploy({
      template: encrypted,
      update: failsThen(),
      // The poll that answers "settled" also brings the Ctrl-C.
      moving: () => [],
      interruptAt: () => true,
    });
    expect(run.calls).toHaveLength(1);
    expect(run.saved?.resources['S']?.unsettledProperties).toEqual([ENC]);
    expect(warned('could not revert')).toBe(false);
    expect(warned('The automatic rollback was interrupted')).toBe(true);
  });
});

describe('waitForUnsettledSettled (go-to-k/cdkd#5505)', () => {
  const identity = {
    logicalId: 'S',
    physicalId: 'stream',
    resourceType: TYPE,
    recordedProperties: {},
    names: new Set([ENC]),
    timeoutMs: 40,
    pollMs: 5,
  };

  it('is settled at once for a provider without the hook', async () => {
    const verdict = await waitForUnsettledSettled({
      ...identity,
      provider: {} as never,
      isInterrupted: () => false,
    });
    expect(verdict).toBe('settled');
  });

  it('counts a hook that throws as moving', async () => {
    const verdict = await waitForUnsettledSettled({
      ...identity,
      provider: {
        unsettledInTransition: async () => {
          throw new Error('DescribeDeliveryStream throttled');
        },
      } as never,
      isInterrupted: () => false,
    });
    expect(verdict).toBe('moving');
  });

  it('stops on an interrupt', async () => {
    let polls = 0;
    const verdict = await waitForUnsettledSettled({
      ...identity,
      timeoutMs: 60_000,
      provider: { unsettledInTransition: async () => new Set([ENC]) } as never,
      isInterrupted: () => polls++ > 2,
    });
    expect(verdict).toBe('interrupted');
  });

  it('an interrupt already set ends the wait before it reports settled', async () => {
    const hook = vi.fn(async () => new Set<string>());
    const verdict = await waitForUnsettledSettled({
      ...identity,
      provider: { unsettledInTransition: hook } as never,
      isInterrupted: () => true,
    });
    expect(verdict).toBe('interrupted');
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('revertUnsettledFailedUpdates, called directly (go-to-k/cdkd#5505 review C2 / C3 / T2)', () => {
  const record = (extra: Partial<ResourceState> = {}): ResourceState =>
    ({
      physicalId: 'stream',
      resourceType: TYPE,
      properties: { DeliveryStreamName: 'stream' },
      attributes: {},
      dependencies: [],
      unsettledProperties: [ENC],
      ...extra,
    }) as ResourceState;

  function harness(getProviderFor: () => unknown) {
    const registry = {
      getProvider: vi.fn(),
      getProviderFor: vi.fn(getProviderFor),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      new DiffCalculator(),
      registry as never,
      { dryRun: false, unsettledRevertWait: { timeoutMs: 40, pollMs: 5 } },
      'us-east-1'
    );
    const state = {
      version: 15,
      stackName: 's',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const deps = engine.rollbackDeps();
    return { deps, ctx: rollbackExecutorContext(deps, state, 's'), registry };
  }
  const hooks = {
    runMarks: () => ({ names: new Set([ENC]), items: new Map() }),
    stillRunning: () => undefined,
    recordMarks: vi.fn(),
    onReverted: vi.fn(),
  };
  const op = (extra: Partial<FailedOperation> = {}): FailedOperation =>
    ({
      changeType: 'UPDATE',
      logicalId: 'S',
      resourceType: TYPE,
      physicalId: 'stream',
      previousState: record({ unsettledProperties: undefined }),
      ...extra,
    }) as FailedOperation;

  it('a failed op --revert-failed would not force-revert is neither waited for nor reverted', async () => {
    const { deps, ctx, registry } = harness(() => {
      throw new Error('not reached');
    });
    const out = await revertUnsettledFailedUpdates(
      deps,
      ctx,
      's',
      { S: record() },
      // A replacement that made its new resource: `skip-failed-noop`.
      [op({ replacementOrphaned: 'create-first' } as Partial<FailedOperation>)],
      new Set(),
      { emitEnvelope: false, inlinePolicyWriters: new RollbackInlinePolicyWriters(), hooks }
    );
    expect(out).toEqual({ handled: [], warnings: 0, interrupted: false });
    expect(registry.getProviderFor).not.toHaveBeenCalled();
  });

  it('a provider it cannot reach says so, not that AWS is still moving', async () => {
    const { deps, ctx } = harness(() => {
      throw new Error('no provider');
    });
    const out = await revertUnsettledFailedUpdates(deps, ctx, 's', { S: record() }, [op()], new Set(), {
      emitEnvelope: false,
      inlinePolicyWriters: new RollbackInlinePolicyWriters(),
      hooks,
    });
    expect(out.handled).toEqual([]);
    expect(out.warnings).toBe(1);
    expect(warned('cdkd could not reach its provider')).toBe(true);
    expect(warned('AWS had not settled')).toBe(false);
  });

  it('a revert the arm skips is not handled: the journal keeps it, with a warning', async () => {
    const provider = { update: vi.fn(), unsettledInTransition: async () => new Set<string>() };
    const { deps, ctx } = harness(() => ({ provider, provisionedBy: 'sdk' }));
    // A pre-deploy record with no `properties`: the arm refuses to restore it.
    const failed = op({ previousState: { ...record(), properties: undefined } as never });
    const out = await revertUnsettledFailedUpdates(deps, ctx, 's', { S: record() }, [failed], new Set(), {
      emitEnvelope: false,
      inlinePolicyWriters: new RollbackInlinePolicyWriters(),
      hooks,
    });
    expect(provider.update).not.toHaveBeenCalled();
    expect(out.handled).toEqual([]);
    expect(out.warnings).toBeGreaterThanOrEqual(1);
    expect(warned('could not revert what the failed update left unsettled')).toBe(true);
    expect(hooks.onReverted).not.toHaveBeenCalled();
  });
});
