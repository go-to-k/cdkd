import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import {
  UNADDRESSABLE_JOURNAL_SKIP_CAUSE,
  UNADDRESSABLE_SKIP_CAUSE,
} from '../../../src/deployment/rollback-executor/messages.js';
import type { ResourceState } from '../../../src/types/state.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';

type DeploymentEventInput = Omit<DeploymentEvent, 'timestamp'>;

/**
 * go-to-k/cdkd#4628: every replay arm that addresses AWS by a record's (or the
 * journaled op's) `physicalId` declines one `hasAddressablePhysicalId` rejects
 * — absent, empty, whitespace-only, or not a string — as a rollback SKIP: no
 * provider call, the state record left as it is, a warning, and a
 * `ROLLBACK_RESOURCE_SKIPPED` event. A nested-stack record is exempt (its
 * provider finds the child by name) unless it, or the arm's route, is Cloud
 * Control.
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

const QUEUE = 'AWS::SQS::Queue';
const STACK = 'AWS::CloudFormation::Stack';

/** The four shapes the predicate rejects; `absent` drops the key. */
const SHAPES: ReadonlyArray<[string, unknown]> = [
  ['absent', undefined],
  ['empty', ''],
  ['whitespace-only', ' \t '],
  ['not a string', 42],
];
/** The two shapes the arms' older falsy checks never reached. */
const TRUTHY_SHAPES = SHAPES.filter(([, id]) => Boolean(id));

const warnLines: string[] = [];
const infoLines: string[] = [];
const events: DeploymentEventInput[] = [];
const logger = {
  debug: vi.fn(),
  info: vi.fn((line: unknown) => {
    infoLines.push(String(line));
  }),
  warn: vi.fn((line: unknown) => {
    warnLines.push(String(line));
  }),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

function res(physicalId: unknown, overrides: Partial<ResourceState> = {}): ResourceState {
  const record: Record<string, unknown> = {
    resourceType: QUEUE,
    properties: { DelaySeconds: '30' },
    attributes: {},
    dependencies: [],
    ...overrides,
  };
  if (physicalId !== undefined) record['physicalId'] = physicalId;
  return record as unknown as ResourceState;
}

/** A journaled id, typed as the journal declares it whatever it holds. */
function id(physicalId: unknown): string | undefined {
  return physicalId as string | undefined;
}

interface Provider {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeProvider(): Provider {
  return {
    create: vi.fn().mockResolvedValue({ physicalId: 'phys-old-2', attributes: {} }),
    update: vi.fn().mockResolvedValue({ physicalId: 'phys', wasReplaced: false, attributes: {} }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCtx(provider: Provider): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: ({ provisionedBy }: { provisionedBy?: string }) => ({
        provider,
        provisionedBy,
      }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (event: DeploymentEventInput) => {
      events.push(event);
    },
  };
}

/**
 * A `pre-delete-snapshot` type: its preparation CALLS AWS (a snapshot of the
 * id), so a guard placed below it is visible on these clients.
 */
const VOLUME = 'AWS::EC2::Volume';
function withSnapshotClients(ctx: RollbackExecutorContext): ReturnType<typeof vi.fn> {
  const send = vi.fn().mockResolvedValue({});
  ctx.finalSnapshotClients = {
    ec2: { send },
    redshift: { send },
    elastiCache: { send },
  } as unknown as NonNullable<RollbackExecutorContext['finalSnapshotClients']>;
  return send;
}

beforeEach(() => {
  warnLines.length = 0;
  infoLines.length = 0;
  events.length = 0;
});

/** What every declined op leaves behind. */
function expectSkipped(
  result: { failures: number; warnings: number; skipped: number },
  what: string
): void {
  expect(result.failures).toBe(0);
  expect(result.warnings).toBe(1);
  expect(result.skipped).toBe(1);
  const warn = warnLines.join('\n');
  expect(warn).toContain(`Cannot ${what} Q (${QUEUE})`);
  expect(warn).toContain("no non-empty string 'physicalId'");
  expect(warn).toContain('`cdkd state show`');
  const skipped = events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_SKIPPED');
  expect(skipped).toHaveLength(1);
  expect(skipped[0]).toMatchObject({ logicalId: 'Q', reason: UNADDRESSABLE_SKIP_CAUSE });
  expect(events.some((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED')).toBe(false);
}

function revertOp(physicalId: unknown, overrides: Partial<CompletedOperation> = {}) {
  const resourceType = overrides.resourceType ?? QUEUE;
  return {
    logicalId: 'Q',
    changeType: 'UPDATE',
    resourceType,
    physicalId: id(physicalId),
    // The op's own type: another one would make it a Type change.
    previousState: res(physicalId, { resourceType, properties: { DelaySeconds: '0' } }),
    ...overrides,
  } as CompletedOperation;
}

describe('revert (completed UPDATE)', () => {
  it.each(SHAPES)('an id that is %s is skipped with no provider call', async (_label, physicalId) => {
    const provider = makeProvider();
    const record = res(physicalId);
    const state = { Q: record };

    const result = await replayRollback([revertOp(physicalId)], state, 'S', makeCtx(provider));

    expect(provider.update).not.toHaveBeenCalled();
    expect(state.Q).toBe(record);
    expectSkipped(result, 'restore');
    // Declined above the announcement, never after it.
    expect(infoLines.join('\n')).not.toContain('Restoring Q');
  });

  it('a usable id is restored (control)', async () => {
    const provider = makeProvider();
    const state = { Q: res('phys') };

    const result = await replayRollback([revertOp('phys')], state, 'S', makeCtx(provider));

    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(provider.update.mock.calls[0]![1]).toBe('phys');
    expect(result.warnings).toBe(0);
  });

  it('a nested-stack record is exempt: its provider finds the child by name', async () => {
    const provider = makeProvider();
    const state = { Q: res('', { resourceType: STACK, provisionedBy: 'sdk' }) };

    const result = await replayRollback(
      [revertOp('', { resourceType: STACK, provisionedBy: 'sdk' })],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(0);
  });

  it('a nested-stack record on Cloud Control is not exempt', async () => {
    const provider = makeProvider();
    const state = { Q: res('', { resourceType: STACK, provisionedBy: 'cc-api' }) };

    const result = await replayRollback(
      [revertOp('', { resourceType: STACK })],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.update).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('a nested-stack record the arm ROUTES to Cloud Control is not exempt', async () => {
    const provider = makeProvider();
    const state = { Q: res('', { resourceType: STACK }) };

    const result = await replayRollback(
      [revertOp('', { resourceType: STACK, provisionedBy: 'cc-api' })],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.update).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("the exemption reads the RECORD's type, not the op's", async () => {
    const provider = makeProvider();
    const state = { Q: res('') };

    const result = await replayRollback(
      [revertOp('', { resourceType: STACK })],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.update).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});

function failedUpdate(physicalId: unknown): FailedOperation {
  return {
    logicalId: 'Q',
    changeType: 'UPDATE',
    resourceType: QUEUE,
    physicalId: id(physicalId),
    previousState: res(physicalId, { properties: { DelaySeconds: '0' } }),
    attemptedProperties: { DelaySeconds: '30' },
  };
}

describe('--revert-failed (failed UPDATE)', () => {
  it.each(SHAPES)('an id that is %s is skipped with no provider call', async (_label, physicalId) => {
    const provider = makeProvider();
    const record = res(physicalId);
    const state = { Q: record };

    const result = await replayFailedOperations(
      [failedUpdate(physicalId)],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.update).not.toHaveBeenCalled();
    expect(state.Q).toBe(record);
    expectSkipped(result, 'force-revert failed UPDATE of');
    // A skip leaves the journal, as every declined op does.
    expect(result.remainingFailedOps).toEqual([]);
    expect(infoLines.join('\n')).not.toContain('force-reverting');
  });

  it('a usable id is force-reverted (control)', async () => {
    const provider = makeProvider();
    const state = { Q: res('phys') };

    const result = await replayFailedOperations(
      [failedUpdate('phys')],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(provider.update.mock.calls[0]![1]).toBe('phys');
    expect(result.skipped).toBe(0);
  });

  it('a nested-stack record is exempt', async () => {
    const provider = makeProvider();
    const state = { Q: res(' ', { resourceType: STACK }) };

    await replayFailedOperations(
      [
        {
          ...failedUpdate(' '),
          resourceType: STACK,
          previousState: res(' ', { resourceType: STACK, properties: { DelaySeconds: '0' } }),
        },
      ],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.update).toHaveBeenCalledTimes(1);
  });
});

function createOp(physicalId: unknown): CompletedOperation {
  return {
    logicalId: 'Q',
    changeType: 'CREATE',
    resourceType: QUEUE,
    physicalId: id(physicalId),
    properties: {},
  } as CompletedOperation;
}

describe('delete of a created resource (completed CREATE)', () => {
  it.each(TRUTHY_SHAPES)('an id that is %s is skipped with no provider call', async (_label, physicalId) => {
    const provider = makeProvider();
    const record = res(physicalId);
    const state = { Q: record };

    const result = await replayRollback([createOp(physicalId)], state, 'S', makeCtx(provider));

    expect(provider.delete).not.toHaveBeenCalled();
    expect(state.Q).toBe(record);
    expectSkipped(result, 'delete created resource');
  });

  it('a usable id is deleted (control)', async () => {
    const provider = makeProvider();
    const state: Record<string, ResourceState> = { Q: res('phys') };

    await replayRollback([createOp('phys')], state, 'S', makeCtx(provider));

    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(state['Q']).toBeUndefined();
  });

  it('a Snapshot-policy record takes no final snapshot of it', async () => {
    const provider = makeProvider();
    const ctx = makeCtx(provider);
    const snapshotSend = withSnapshotClients(ctx);
    const state = { Q: res(' ', { resourceType: VOLUME, deletionPolicy: 'Snapshot' }) };

    const result = await replayRollback(
      [{ ...createOp(' '), resourceType: VOLUME }],
      state,
      'S',
      ctx
    );

    expect(snapshotSend).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('the exemption needs the OP to be a nested stack too: its type picks the provider', async () => {
    const provider = makeProvider();
    const state = { Q: res(' ', { resourceType: STACK }) };

    const result = await replayRollback([createOp(' ')], state, 'S', makeCtx(provider));

    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('a nested-stack record is exempt', async () => {
    const provider = makeProvider();
    const state = { Q: res(' ', { resourceType: STACK }) };

    await replayRollback(
      [{ ...createOp(' '), resourceType: STACK }],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.delete).toHaveBeenCalledTimes(1);
  });
});

function failedCreate(physicalId: unknown): FailedOperation {
  return {
    logicalId: 'Q',
    changeType: 'CREATE',
    resourceType: QUEUE,
    physicalId: id(physicalId),
    attemptedProperties: {},
  };
}

describe('delete of a partially-created resource (failed CREATE)', () => {
  it.each(TRUTHY_SHAPES)('an id that is %s is skipped with no provider call', async (_label, physicalId) => {
    const provider = makeProvider();
    const record = res(physicalId);
    const state = { Q: record };

    const result = await replayFailedOperations(
      [failedCreate(physicalId)],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.delete).not.toHaveBeenCalled();
    expect(state.Q).toBe(record);
    expectSkipped(result, 'delete partially-created resource');
  });

  it('a proven orphan (no record) is skipped with the journal-only wording', async () => {
    const provider = makeProvider();
    const state: Record<string, ResourceState> = {};

    const result = await replayFailedOperations(
      [{ ...failedCreate(' '), physicalIdRecoveredFromError: true }],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(result.skipped).toBe(1);
    // No state record to repair: the remedy is a manual check, as on
    // `skip-failed-unknown`.
    const warn = warnLines.join('\n');
    expect(warn).toContain('Cannot delete partially-created resource Q');
    expect(warn).toContain('no state record holds it');
    expect(warn).toContain('delete it manually');
    expect(warn).not.toContain('cdkd state show');
    const skipped = events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ reason: UNADDRESSABLE_JOURNAL_SKIP_CAUSE });
  });

  it('a Snapshot-policy record takes no final snapshot of it', async () => {
    const provider = makeProvider();
    const ctx = makeCtx(provider);
    const snapshotSend = withSnapshotClients(ctx);
    const state = { Q: res(' ', { resourceType: VOLUME, deletionPolicy: 'Snapshot' }) };

    const result = await replayFailedOperations(
      [{ ...failedCreate(' '), resourceType: VOLUME }],
      state,
      'S',
      ctx
    );

    expect(snapshotSend).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('a usable id is deleted (control)', async () => {
    const provider = makeProvider();
    const state: Record<string, ResourceState> = { Q: res('phys') };

    await replayFailedOperations([failedCreate('phys')], state, 'S', makeCtx(provider));

    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(state['Q']).toBeUndefined();
  });

  it('a nested-stack record is exempt', async () => {
    const provider = makeProvider();
    const state = { Q: res(' ', { resourceType: STACK }) };

    await replayFailedOperations(
      [{ ...failedCreate(' '), resourceType: STACK }],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.delete).toHaveBeenCalledTimes(1);
  });
});

/** A replacement of `phys-old` whose NEW record holds `physicalId`. */
function replacementOp(physicalId: unknown, oldResourceRetained?: boolean): CompletedOperation {
  return {
    logicalId: 'Q',
    changeType: 'UPDATE',
    resourceType: QUEUE,
    physicalId: id(physicalId),
    previousState: res('phys-old', { properties: { DelaySeconds: '0' } }),
    ...(oldResourceRetained !== undefined && { oldResourceRetained }),
  } as CompletedOperation;
}

describe('reverse replacement (re-create the old, delete the new)', () => {
  it.each(SHAPES)(
    'a new record whose id is %s is skipped before any AWS call',
    async (_label, physicalId) => {
      const provider = makeProvider();
      const record = res(physicalId);
      const state = { Q: record };

      const result = await replayRollback(
        [replacementOp(physicalId)],
        state,
        'S',
        makeCtx(provider)
      );

      // Not the re-create either: it would leave two live resources once the
      // delete of the new one could not be sent.
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
      expect(state.Q).toBe(record);
      expectSkipped(result, 'reverse the replacement of');
    }
  );

  it('a retained new copy is never deleted, so it is not guarded', async () => {
    const provider = makeProvider();
    const state: Record<string, ResourceState> = {
      Q: res(' ', { updateReplacePolicy: 'Retain' }),
    };

    await replayRollback([replacementOp(' ')], state, 'S', makeCtx(provider));

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(state['Q']!.physicalId).toBe('phys-old-2');
  });

  it('a usable id is reversed (control)', async () => {
    const provider = makeProvider();
    const state = { Q: res('phys-new') };

    await replayRollback([replacementOp('phys-new')], state, 'S', makeCtx(provider));

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.delete.mock.calls[0]![1]).toBe('phys-new');
  });
});

describe('re-adopt the retained old resource (delete the new)', () => {
  it.each(SHAPES)(
    'a new record whose id is %s is REFUSED, keeping the journal',
    async (_label, physicalId) => {
      const provider = makeProvider();
      const record = res(physicalId);
      const state = { Q: record };

      const result = await replayRollback(
        [replacementOp(physicalId, true)],
        state,
        'S',
        makeCtx(provider)
      );

      expect(provider.delete).not.toHaveBeenCalled();
      // Not re-pointed at the old resource while the new one may be alive.
      expect(state.Q).toBe(record);
      // A FAILURE, not a skip: the retained old resource is named only by
      // this journal op, which a skip would pop.
      expect(result.failures).toBe(1);
      expect(result.skipped).toBe(0);
      const warn = warnLines.join('\n');
      expect(warn).toContain('Cannot reverse the replacement of Q');
      expect(warn).toContain("non-empty string 'physicalId'");
      // The only trace of the retained old resource reaches the reader.
      expect(warn).toContain('phys-old');
      expect(warn).toContain('JOURNAL is kept');
      expect(events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED')).toHaveLength(1);
      expect(infoLines.join('\n')).not.toContain('Reversing replacement');
      // The op's id is the same damaged value (absent aside): no repair can
      // prove which resource is the new copy, so the remedy is the manual
      // check, never "repair and re-run".
      if (physicalId === undefined) {
        expect(warn).toContain("Repair the record's 'physicalId'");
      } else {
        expect(warn).toContain('Check both resources by hand');
        expect(warn).toContain('To orphan it: cdkd rollback --orphan Q');
        expect(warn).not.toContain("Repair the record's 'physicalId'");
      }
    }
  );

  it('readopt, two rounds: the first refusal predicts the second when both ids are damaged (M2)', async () => {
    const provider = makeProvider();
    const op = replacementOp(' ', true);
    const state: Record<string, ResourceState> = { Q: res(' ') };

    const first = await replayRollback([op], state, 'S', makeCtx(provider));
    expect(first.failures).toBe(1);
    const firstWarn = warnLines.join('\n');
    expect(firstWarn).toContain('Check both resources by hand');
    expect(firstWarn).not.toContain("Repair the record's 'physicalId'");

    // A user repairs the record anyway.
    warnLines.length = 0;
    state['Q'] = res('phys-new');
    const second = await replayRollback([op], state, 'S', makeCtx(provider));

    expect(provider.delete).not.toHaveBeenCalled();
    expect(second.failures).toBe(1);
    const secondWarn = warnLines.join('\n');
    // The outcome the first refusal described: the same manual-check remedy.
    expect(secondWarn).toContain('Check both resources by hand');
    expect(secondWarn).toContain('To orphan it: cdkd rollback --orphan Q');
  });

  it('readopt: a usable op id over a damaged record keeps "repair and re-run"', async () => {
    const provider = makeProvider();
    const result = await replayRollback(
      [replacementOp('phys-new', true)],
      { Q: res(' ') },
      'S',
      makeCtx(provider)
    );
    expect(result.failures).toBe(1);
    const warn = warnLines.join('\n');
    expect(warn).toContain("Repair the record's 'physicalId' to phys-new");
    expect(warn).toContain(
      "Any other id stops the revert and drops the journal's only record of the retained old resource (phys-old)"
    );
    expect(warn).not.toContain('To orphan it');
  });

  it('readopt: an absent op id over a damaged record says the re-run deletes what the repair names', async () => {
    const provider = makeProvider();
    const result = await replayRollback(
      [replacementOp(undefined, true)],
      { Q: res(' ') },
      'S',
      makeCtx(provider)
    );
    expect(result.failures).toBe(1);
    const warn = warnLines.join('\n');
    expect(warn).toContain("to the id of the replacement's NEW resource");
    expect(warn).toContain('the re-run DELETES the resource the repaired record names');
    expect(warn).not.toContain('Any other id stops the revert');
  });

  it('readopt: a usable op id that is not a plain identifier is described, with a pointer', async () => {
    const provider = makeProvider();
    await replayRollback(
      [replacementOp('phys new$(x)', true)],
      { Q: res(' ') },
      'S',
      makeCtx(provider)
    );
    const warn = warnLines.join('\n');
    expect(warn).not.toContain('phys new$(x)');
    expect(warn).toContain('a physical id that is not a plain identifier');
    expect(warn).toContain('read it from the rollback journal.');
    expect(warn).not.toContain('or from the state record of the stack');
  });

  it('readopt: a masked repair target points at the rollback journal', async () => {
    const provider = makeProvider();
    await replayRollback([replacementOp('phys-***', true)], { Q: res(' ') }, 'S', makeCtx(provider));
    const warn = warnLines.join('\n');
    expect(warn).toContain('phys-***');
    expect(warn).toContain('That id is shown masked — read the full value from the rollback journal.');
  });

  it('a retained new copy is never deleted, so it is not guarded', async () => {
    const provider = makeProvider();
    const state: Record<string, ResourceState> = {
      Q: res(' ', { updateReplacePolicy: 'Retain' }),
    };

    await replayRollback([replacementOp(' ', true)], state, 'S', makeCtx(provider));

    expect(provider.delete).not.toHaveBeenCalled();
    expect(state['Q']!.physicalId).toBe('phys-old');
  });

  it('a usable id is re-adopted (control)', async () => {
    const provider = makeProvider();
    const state: Record<string, ResourceState> = { Q: res('phys-new') };

    await replayRollback([replacementOp('phys-new', true)], state, 'S', makeCtx(provider));

    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(state['Q']!.physicalId).toBe('phys-old');
  });
});

/**
 * The classification half (parent review M1): an op's id is compared with the
 * record's BEFORE either replacement arm runs, and a mismatch is
 * `skip-mismatch`, a warning that pops the segment. So an unaddressable record
 * under a good op id, or a repaired record under a bad op id, must still reach
 * the reverse arms.
 */
describe('classification routes an unaddressable replacement to its reverse arm', () => {
  /** Op `phys-new` journaled; the record's id damaged by hand. */
  function goodOp(retained: boolean): CompletedOperation {
    return { ...replacementOp('phys-new', retained) };
  }

  it.each(SHAPES)(
    'readopt: a record whose id is %s under a good op id is REFUSED, keeping the journal',
    async (_label, physicalId) => {
      const provider = makeProvider();
      const record = res(physicalId);
      const state = { Q: record };

      const result = await replayRollback([goodOp(true)], state, 'S', makeCtx(provider));

      expect(provider.delete).not.toHaveBeenCalled();
      expect(state.Q).toBe(record);
      expect(result.failures).toBe(1);
      expect(result.skipped).toBe(0);
      expect(warnLines.join('\n')).toContain('phys-old');
    }
  );

  it.each(SHAPES)(
    're-create: a record whose id is %s under a good op id sends nothing, with the unaddressable wording',
    async (_label, physicalId) => {
      const provider = makeProvider();
      const record = res(physicalId);
      const state = { Q: record };

      const result = await replayRollback([goodOp(false)], state, 'S', makeCtx(provider));

      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
      expect(state.Q).toBe(record);
      expectSkipped(result, 'reverse the replacement of');
      expect(warnLines.join('\n')).not.toContain('replaced by a later attempt');
    }
  );

  it('readopt: an absent op id, after the record is repaired, re-adopts on the re-run', async () => {
    const provider = makeProvider();
    const state: Record<string, ResourceState> = { Q: res(' ') };
    const op = replacementOp(undefined, true);

    const first = await replayRollback([op], state, 'S', makeCtx(provider));
    expect(first.failures).toBe(1);
    expect(provider.delete).not.toHaveBeenCalled();

    // The repair the refusal names.
    state['Q'] = res('phys-new');
    const second = await replayRollback([op], state, 'S', makeCtx(provider));

    expect(second.failures).toBe(0);
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.delete.mock.calls[0]![1]).toBe('phys-new');
    expect(state['Q']!.physicalId).toBe('phys-old');
  });

  it.each(TRUTHY_SHAPES.concat([['empty', '']]))(
    'readopt: an op id that is %s over a usable record is REFUSED, never deleting it (S7)',
    async (_label, physicalId) => {
      // Nothing proves the record's resource is the replacement's new copy:
      // it may be a later attempt's. Main's `skip-mismatch` sent nothing but
      // popped the only record of the retained old resource.
      const provider = makeProvider();
      const record = res('phys-other');
      const state = { Q: record };
      const op = replacementOp(physicalId, true);

      const result = await replayRollback([op], state, 'S', makeCtx(provider));

      expect(provider.delete).not.toHaveBeenCalled();
      expect(state.Q).toBe(record);
      expect(result.failures).toBe(1);
      expect(result.skipped).toBe(0);
      const warn = warnLines.join('\n');
      expect(warn).toContain("its rollback journal entry has no non-empty string 'physicalId'");
      expect(warn).toContain('To orphan it: cdkd rollback --orphan Q');
      expect(warn).toContain('phys-old');
      // `--orphan` pops the segment: the reader must keep the old id first.
      expect(warn).toContain('(phys-old), so note that id first');
      expect(warn).toContain('JOURNAL is kept');
    }
  );

  it('readopt: an unusable op id over a record whose new copy is retained proceeds, deleting nothing', async () => {
    const provider = makeProvider();
    const state: Record<string, ResourceState> = {
      Q: res('phys-other', { updateReplacePolicy: 'Retain' }),
    };

    const result = await replayRollback([replacementOp(' ', true)], state, 'S', makeCtx(provider));

    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(state['Q']!.physicalId).toBe('phys-old');
    // The record's id names the survivor.
    expect(warnLines.join('\n')).toContain('(phys-other) is RETAINED');
  });

  it.each(['', '  '])('an old id of %j is described, never printed raw', async (oldId) => {
    const provider = makeProvider();
    const op = replacementOp('phys-new', true);
    // An absent one is no replacement at all (`isReplacementOp`); empty is.
    const state = { Q: res(' ') };

    const result = await replayRollback(
      [{ ...op, previousState: res(oldId, { properties: { DelaySeconds: '0' } }) }],
      state,
      'S',
      makeCtx(provider)
    );

    expect(result.failures).toBe(1);
    const warn = warnLines.join('\n');
    expect(warn).toContain('(no recorded id)');
    expect(warn).not.toMatch(/\(\s*\)/);
  });

  it.each(TRUTHY_SHAPES)(
    'a CREATE whose journaled id is %s over a usable nested-stack record is a mismatch: no delete',
    async (_label, physicalId) => {
      // Read as unrecorded it would reach `replayDelete`, where the nested
      // record is exempt and the provider deletes the child stack by NAME.
      const provider = makeProvider();
      const record = res('arn:child', { resourceType: STACK, provisionedBy: 'sdk' });
      const state = { Q: record };

      const result = await replayRollback(
        [{ ...createOp(physicalId), resourceType: STACK }],
        state,
        'S',
        makeCtx(provider)
      );

      expect(provider.delete).not.toHaveBeenCalled();
      expect(state.Q).toBe(record);
      expect(result.skipped).toBe(1);
    }
  );

  it.each([
    ['re-create', false],
    ['readopt', true],
  ] as const)(
    '%s: a retained new copy over a blank record is named by the op id',
    async (_label, oldRetained) => {
      const provider = makeProvider();
      const state: Record<string, ResourceState> = {
        Q: res(' ', { updateReplacePolicy: 'Retain' }),
      };

      const result = await replayRollback(
        [replacementOp('phys-new', oldRetained)],
        state,
        'S',
        makeCtx(provider)
      );

      expect(provider.delete).not.toHaveBeenCalled();
      expect(result.failures).toBe(0);
      // The segment pops after this op: the warning and the durable event are
      // the new copy's only trace, so they carry the journaled id.
      expect(warnLines.join('\n')).toContain('(phys-new) is RETAINED');
      const succeeded = events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
      expect(succeeded).toHaveLength(1);
      expect(succeeded[0]).toMatchObject({ physicalId: 'phys-new' });
      expect(String(succeeded[0]!.reason)).toContain('phys-new');
    }
  );

  it('a retained new copy with no usable id anywhere is described, and the event carries none', async () => {
    const provider = makeProvider();
    const state: Record<string, ResourceState> = {
      Q: res(' ', { updateReplacePolicy: 'Retain' }),
    };

    await replayRollback([replacementOp('', true)], state, 'S', makeCtx(provider));

    expect(warnLines.join('\n')).toContain('(no recorded id) is RETAINED');
    const succeeded = events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(succeeded[0]).not.toHaveProperty('physicalId');
  });
});

describe('the guards read the RECORD id, not the op id (parent review T-M3)', () => {
  it('revert: good op id, blank record', async () => {
    const provider = makeProvider();
    const state = { Q: res('') };
    const result = await replayRollback(
      // The previous record keeps the op's id, so this is no replacement.
      [revertOp('phys')],
      state,
      'S',
      makeCtx(provider)
    );
    expect(provider.update).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('--revert-failed: good op id, blank record', async () => {
    const provider = makeProvider();
    const state = { Q: res(' ') };
    const result = await replayFailedOperations(
      [{ ...failedUpdate('phys'), previousState: res(' ', { properties: { DelaySeconds: '0' } }) }],
      state,
      'S',
      makeCtx(provider)
    );
    expect(provider.update).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});

/**
 * Parent review T-M1: a nested-stack record with no route of its own, under an
 * op routed to Cloud Control, is not exempt -- on every arm, each reading the
 * route its own provider lookup takes. And the exemption itself on both
 * replacement arms.
 */
describe('nested-stack exemption by route, on every arm', () => {
  const stackRecord = (physicalId: unknown) => res(physicalId, { resourceType: STACK });

  it('revert-failed: record STACK without a route, op on cc-api', async () => {
    const provider = makeProvider();
    const result = await replayFailedOperations(
      [
        {
          ...failedUpdate(' '),
          resourceType: STACK,
          provisionedBy: 'cc-api',
          previousState: res(' ', { resourceType: STACK, properties: { DelaySeconds: '0' } }),
        },
      ],
      { Q: stackRecord(' ') },
      'S',
      makeCtx(provider)
    );
    expect(provider.update).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('failed CREATE delete: record STACK without a route, op on cc-api', async () => {
    const provider = makeProvider();
    const result = await replayFailedOperations(
      [{ ...failedCreate(' '), resourceType: STACK, provisionedBy: 'cc-api' }],
      { Q: stackRecord(' ') },
      'S',
      makeCtx(provider)
    );
    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('completed CREATE delete: record STACK without a route, op on cc-api', async () => {
    const provider = makeProvider();
    const result = await replayRollback(
      [{ ...createOp(' '), resourceType: STACK, provisionedBy: 'cc-api' }],
      { Q: stackRecord(' ') },
      'S',
      makeCtx(provider)
    );
    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  function stackReplacement(retained: boolean, provisionedBy?: 'cc-api'): CompletedOperation {
    return {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: STACK,
      physicalId: ' ',
      previousState: res('phys-old', { resourceType: STACK, properties: { DelaySeconds: '0' } }),
      oldResourceRetained: retained,
      ...(provisionedBy && { provisionedBy }),
    } as CompletedOperation;
  }

  it('reverse-replacement: record STACK without a route, op on cc-api', async () => {
    const provider = makeProvider();
    const result = await replayRollback(
      [stackReplacement(false, 'cc-api')],
      { Q: stackRecord(' ') },
      'S',
      makeCtx(provider)
    );
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('readopt: record STACK without a route, op on cc-api', async () => {
    const provider = makeProvider();
    const result = await replayRollback(
      [stackReplacement(true, 'cc-api')],
      { Q: stackRecord(' ') },
      'S',
      makeCtx(provider)
    );
    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
  });

  it('reverse-replacement: a nested-stack record is exempt', async () => {
    const provider = makeProvider();
    const result = await replayRollback(
      [stackReplacement(false)],
      { Q: stackRecord(' ') },
      'S',
      makeCtx(provider)
    );
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(0);
  });

  it('readopt: a nested-stack record is exempt', async () => {
    const provider = makeProvider();
    const state: Record<string, ResourceState> = { Q: stackRecord(' ') };
    const result = await replayRollback([stackReplacement(true)], state, 'S', makeCtx(provider));
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(result.failures).toBe(0);
    expect(state['Q']!.physicalId).toBe('phys-old');
  });

  it('a recovered orphan (no record) of a nested-stack op is not exempt (T-M2)', async () => {
    const provider = makeProvider();
    const result = await replayFailedOperations(
      [{ ...failedCreate(' '), resourceType: STACK, physicalIdRecoveredFromError: true }],
      {},
      'S',
      makeCtx(provider)
    );
    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});

/**
 * Parent re-review (C-N2, T-N1..T-N6): the classifier's unaddressable-record
 * branch, pinned per argument, and the raw op-id comparison off the retained
 * arm.
 */
describe('classifier: unaddressable-record branch, argument by argument', () => {
  const MISMATCH = 'its physical id changed since the failed deploy';

  /** A nested-stack replacement whose op holds the GOOD new id. */
  function goodStackReplacement(
    retained: boolean | undefined,
    provisionedBy?: 'cc-api'
  ): CompletedOperation {
    return {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: STACK,
      physicalId: 'phys-new',
      previousState: res('phys-old', { resourceType: STACK, properties: { DelaySeconds: '0' } }),
      ...(retained !== undefined && { oldResourceRetained: retained }),
      ...(provisionedBy && { provisionedBy }),
    } as CompletedOperation;
  }

  it('C-N2: a torn op id over a DIFFERENT usable record is a mismatch on the re-create arm', async () => {
    const provider = makeProvider();
    const record = res('phys-other');
    const state = { Q: record };

    const result = await replayRollback([replacementOp(' ', false)], state, 'S', makeCtx(provider));

    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(state.Q).toBe(record);
    expect(result.failures).toBe(0);
    expect(warnLines.join('\n')).toContain(MISMATCH);
  });

  it('T-N1: a route-only Cloud Control nested record under a good op id: readopt refuses', async () => {
    const provider = makeProvider();
    const state = { Q: res(' ', { resourceType: STACK }) };

    const result = await replayRollback(
      [goodStackReplacement(true, 'cc-api')],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(warnLines.join('\n')).toContain('Cannot reverse the replacement of Q');
  });

  it('T-N1: the same on the re-create arm skips with the unaddressable wording', async () => {
    const provider = makeProvider();
    const state = { Q: res(' ', { resourceType: STACK }) };

    const result = await replayRollback(
      [goodStackReplacement(false, 'cc-api')],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(warnLines.join('\n')).toContain("no non-empty string 'physicalId'");
  });

  it("T-N2: the record's own route wins over the op's (as the arms' lookup reads it)", async () => {
    // Record on SDK, op on Cloud Control: the arms route by the record, so the
    // record is exempt and the good op id then makes it a mismatch.
    const provider = makeProvider();
    const state = { Q: res(' ', { resourceType: STACK, provisionedBy: 'sdk' }) };

    const result = await replayRollback(
      [goodStackReplacement(true, 'cc-api')],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(warnLines.join('\n')).toContain(MISMATCH);
  });

  it('T-N3: an exempt nested record with a blank id under a good op id is a mismatch, no AWS call', async () => {
    const provider = makeProvider();
    const record = res(' ', { resourceType: STACK });
    const state = { Q: record };

    const result = await replayRollback(
      [goodStackReplacement(false)],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(state.Q).toBe(record);
    expect(result.failures).toBe(0);
    expect(warnLines.join('\n')).toContain(MISMATCH);
  });

  it('T-N4: an unroutable Type change over an unaddressable record is refused for its routing', async () => {
    const provider = makeProvider();
    const state = { Q: res(' ') };

    const result = await replayRollback(
      [
        {
          ...replacementOp('phys-new', true),
          // The two old-type sources disagree: the replay cannot name the old type.
          previousResourceType: 'AWS::SNS::Topic',
        } as CompletedOperation,
      ],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    const warn = warnLines.join('\n');
    expect(warn).toContain('two different types');
    expect(warn).not.toContain("no non-empty string 'physicalId'");
  });

  it("T-N5: no retained verdict on the op falls back to the previous record's UpdateReplacePolicy", async () => {
    const provider = makeProvider();
    const state = { Q: res(' ') };
    const op = replacementOp('phys-new');
    const result = await replayRollback(
      [
        {
          ...op,
          previousState: { ...op.previousState!, updateReplacePolicy: 'Retain' },
        },
      ],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    // The readopt refusal, not the re-create arm's skip.
    expect(result.failures).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('T-N6: re-create arm, a retained copy with no usable id anywhere: the event carries none', async () => {
    const provider = makeProvider();
    const state: Record<string, ResourceState> = {
      Q: res(' ', { updateReplacePolicy: 'Retain' }),
    };

    await replayRollback([replacementOp('', false)], state, 'S', makeCtx(provider));

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(warnLines.join('\n')).toContain('(no recorded id) is RETAINED');
    const succeeded = events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]).not.toHaveProperty('physicalId');
  });
});

describe('S7 branch keeps the routing refusal (parent review G1)', () => {
  it('an unroutable retained replacement with an unusable op id over a usable record is refused for its routing', async () => {
    const provider = makeProvider();
    const record = res('phys-other', { updateReplacePolicy: 'Retain' });
    const state = { Q: record };

    const result = await replayRollback(
      [
        {
          logicalId: 'Q',
          changeType: 'UPDATE',
          resourceType: QUEUE,
          physicalId: ' ',
          oldResourceRetained: true,
          // No stamped old type; the previous record's type differs from the
          // op's across the nested-stack boundary, which cannot be routed.
          previousState: res('phys-old', {
            resourceType: STACK,
            properties: { DelaySeconds: '0' },
          }),
        } as CompletedOperation,
      ],
      state,
      'S',
      makeCtx(provider)
    );

    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(state.Q).toBe(record);
    expect(result.failures).toBe(1);
    expect(warnLines.join('\n')).toContain('does not replace a nested stack');
  });
});

describe('unproven-copy refusal inside a nested child revert (parent review N3)', () => {
  it('says no state repair makes the op succeed, and prints no --orphan line', async () => {
    const provider = makeProvider();
    const ctx = { ...makeCtx(provider), nestedChildRevert: true };

    const result = await replayRollback([replacementOp(' ', true)], { Q: res(' ') }, 'S', ctx);

    expect(result.failures).toBe(1);
    const warn = warnLines.join('\n');
    expect(warn).toContain('No repair of the state record makes this op succeed on a re-run.');
    expect(warn).not.toContain('To orphan it');
  });
});
