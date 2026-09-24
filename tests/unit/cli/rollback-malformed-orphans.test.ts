/**
 * Issue go-to-k/cdkd#3379, rollback half — the PERSISTENCE case, and the reason
 * the issue is severity high.
 *
 * `orphansAfterRollback` walks the `orphans` container with `for...of`. Over
 * the string `"abc"` that yields one record per character and returns a
 * container holding `"c"`, and `cdkd rollback` SAVES the record after each
 * replayed segment — so a damaged container is rewritten into a differently
 * damaged one, by a writer, with no warning. `null` reads as no orphans at all
 * through the helper's `?? []`, so the rollback saves a record whose orphan
 * evidence it silently dropped; the remaining shapes are not iterable and throw
 * a bare `TypeError` out of the same walk, in a command that may by then have
 * run AWS replay operations.
 *
 * So the assertions are: refuse, name the container, and save NOTHING. The
 * save is what discriminates — a guard placed after the first replay would
 * still refuse, and the record would already be rewritten.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import { orphansAfterRollback } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

const replayProvider = {
  delete: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue({ physicalId: 'p' }),
  create: vi.fn().mockResolvedValue({ physicalId: 'p' }),
};
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: replayProvider }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({})),
}));
vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../../src/provisioning/resource-name.js', () => ({
  withStackName: (_name: string, fn: () => unknown) => fn(),
}));

const setupMock = vi.fn();
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

const REGION = 'us-east-1';
const STACK = 'S';

/**
 * One genuinely REPLAYABLE segment, built FRESH per install: the command
 * drains `journal.segments` in memory, so a shared object leaves the second
 * case of a loop reading "nothing to roll back" — a vacuous pass.
 *
 * A CREATE whose resource is still in the
 * record with the same physicalId, which the executor rolls back by deleting.
 * A shape it would SKIP (no matching record, or a mismatched physicalId) makes
 * the control vacuous — the run then saves nothing for a reason that has
 * nothing to do with this guard.
 */
const makeJournal = () => ({
  journalVersion: 1,
  stackName: STACK,
  region: REGION,
  segments: [
    {
      operations: [
        {
          logicalId: 'A',
          changeType: 'CREATE',
          resourceType: 'AWS::SSM::Parameter',
          physicalId: 'p',
        },
      ],
    },
  ],
});

function install(orphans: unknown) {
  const saveState = vi.fn().mockResolvedValue('etag-1');
  const state: StackState = {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: {
      A: { physicalId: 'p', resourceType: 'AWS::SSM::Parameter', properties: {} },
    },
    outputs: {},
    orphans: orphans as StackState['orphans'],
    lastModified: 1,
  };
  setupMock.mockResolvedValue({
    stateBackend: {
      listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({ state, etag: 'e' }),
      loadRollbackJournal: vi.fn().mockResolvedValue(makeJournal()),
      saveState,
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
      deleteState: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
  return { saveState };
}

const BASE_OPTS = { yes: true, stateBucket: 'b', region: REGION } as unknown as Parameters<
  typeof rollbackCommand
>[1];

describe('rollbackCommand refuses a malformed `orphans` container (go-to-k/cdkd#3379)', () => {
  beforeEach(() => vi.clearAllMocks());

  const MALFORMED: Array<[string, unknown]> = [
    // The reshaping shape: `for...of` walks it and the result is SAVED.
    ['a string container', 'abc'],
    ['a number container', 5],
    ['a plain object container', {}],
    ['an object carrying length', { length: 1 }],
    ['a null container', null],
  ];

  for (const [label, orphans] of MALFORMED) {
    it(`refuses ${label} before any replay, saving nothing`, async () => {
      const h = install(orphans);
      const thrown = await rollbackCommand(STACK, BASE_OPTS).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      expect((thrown as CdkdError).message).toContain("'orphans'");
      // THE assertion this file exists for: a guard below the replay would
      // still refuse, having already written the reshaped container.
      expect(
        h.saveState,
        'rollback saved the record before refusing, so the damaged container was rewritten'
      ).not.toHaveBeenCalled();
      // And no AWS replay ran either.
      expect(replayProvider.delete).not.toHaveBeenCalled();
      expect(replayProvider.update).not.toHaveBeenCalled();
      expect(replayProvider.create).not.toHaveBeenCalled();
    });
  }

  it('CONTROL: a readable container replays and SAVES', async () => {
    // DRIVEN: the control has to reach the replay and the save, or it passes on
    // any early failure and proves nothing about this guard.
    for (const orphans of [[], undefined]) {
      vi.clearAllMocks();
      const h = install(orphans);
      const thrown = await rollbackCommand(STACK, BASE_OPTS).catch((e: unknown) => e);
      const message = thrown instanceof Error ? thrown.message : '';
      expect(message).not.toContain("'orphans'");
      expect(
        h.saveState,
        'the control never saved, so it proves nothing about the guard'
      ).toHaveBeenCalled();
      expect(replayProvider.delete, 'the control never replayed anything').toHaveBeenCalled();
    }
  });
});

/**
 * Issue go-to-k/cdkd#3500, rollback half — a READABLE list holding a row no
 * reader can use. The container guard above cannot see this: the field IS a
 * list.
 *
 * This command is where the loss is observable rather than merely possible.
 * `orphansAfterRollback` merges by `byLogicalId.set(entry.logicalId, entry)`, so
 * two rows MISSING a `logicalId` write the SAME `undefined` key and the record
 * `cdkd rollback` saves keeps one of them — silently, with no error and nothing
 * in the output. The surviving row is the evidence that a resource is still live
 * in AWS; the other one is gone. Two rows carrying DISTINCT non-string ids do
 * not collide: the map keys on the raw value, so `5` and `7` are two entries.
 */
describe('rollbackCommand refuses an unusable orphan ROW (go-to-k/cdkd#3500)', () => {
  beforeEach(() => vi.clearAllMocks());

  /** A row that IS usable, so a fixture can hold both kinds at once. */
  const healthy = (logicalId: string) => ({
    logicalId,
    orphanedAt: 1,
    state: { physicalId: `p-${logicalId}`, resourceType: 'AWS::SQS::Queue', properties: {} },
  });

  const UNUSABLE: Array<[string, unknown]> = [
    ['a null row', null],
    ['a number row', 5],
    ['a string row', 'abc'],
    ['a row with no `state`', { logicalId: 'Gone', orphanedAt: 1 }],
    ['a row whose `logicalId` is not a string', { logicalId: 5, orphanedAt: 1, state: healthy('X').state }],
    ['an empty-object row', {}],
    [
      'a row whose `state.attributes` is not an object',
      {
        logicalId: 'Gone',
        orphanedAt: 1,
        state: {
          physicalId: 'p',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          attributes: 5,
        },
      },
    ],
    [
      'a row whose `state` names no resource type',
      { logicalId: 'Gone', orphanedAt: 1, state: { physicalId: 'p', properties: {} } },
    ],
    [
      'a row whose `state.properties` is not an object',
      {
        logicalId: 'Gone',
        orphanedAt: 1,
        state: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: 'abcdef' },
      },
    ],
  ];

  for (const [label, row] of UNUSABLE) {
    it(`refuses ${label} before any replay, saving nothing`, async () => {
      // Beside a HEALTHY row, so the case cannot pass because the list was
      // uniformly broken: the guard has to refuse a list it could partly read.
      const h = install([healthy('Keep'), row]);
      const thrown = await rollbackCommand(STACK, BASE_OPTS).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      // The ROW text, not the container's: the field here IS a list, so a
      // refusal saying it has none would send the operator to rewrite a field
      // that is already the right shape.
      expect((thrown as CdkdError).message).toContain('rollback-orphan record(s)');
      expect((thrown as CdkdError).message).not.toContain("has no readable 'orphans' list");
      expect(
        h.saveState,
        'rollback saved the record before refusing, so the merge already dropped a row'
      ).not.toHaveBeenCalled();
      expect(replayProvider.delete).not.toHaveBeenCalled();
    });
  }

  it('THE LOSS: two rows MISSING `logicalId` would collapse into one saved row', async () => {
    // The case the issue exists for, and the one a count-only assertion passes
    // vacuously. Both rows carry DISTINCT physical ids, so the survivor is
    // identifiable: without the guard the saved record holds exactly one of
    // them, which is why "the rollback did not throw" is not the property to
    // assert — "nothing was saved" is.
    const rowA = { orphanedAt: 1, state: { physicalId: 'live-A', resourceType: 'AWS::SQS::Queue', properties: {} } };
    const rowB = { orphanedAt: 2, state: { physicalId: 'live-B', resourceType: 'AWS::SQS::Queue', properties: {} } };
    const h = install([rowA, rowB]);
    const thrown = await rollbackCommand(STACK, BASE_OPTS).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
    // BOTH are named, so the operator can see it is not one damaged row.
    expect((thrown as CdkdError).message).toContain('2 rollback-orphan record(s)');
    expect(h.saveState).not.toHaveBeenCalled();

    // THE PREMISE, asserted rather than named in the title: the loss is a
    // property of `orphansAfterRollback`'s merge map, and with the guard in
    // place no rollback run can exhibit it any more. So call the merge directly
    // on the same two rows — one survivor is what this case exists to refuse,
    // and if the merge ever stops keying on `logicalId` this assertion is what
    // says the title now credits a mechanism that is gone.
    const merged = orphansAfterRollback(
      { orphans: [rowA, rowB] } as unknown as StackState,
      []
    ).orphans;
    expect(merged, 'the merge no longer collapses two id-less rows').toHaveLength(1);
  });

  it('CONTROL: a list whose every row is usable replays and SAVES', async () => {
    const h = install([healthy('Keep'), healthy('AlsoKeep')]);
    const thrown = await rollbackCommand(STACK, BASE_OPTS).catch((e: unknown) => e);
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).not.toContain('rollback-orphan record(s)');
    expect(
      h.saveState,
      'the control never saved, so it proves nothing about the row guard'
    ).toHaveBeenCalled();
    expect(replayProvider.delete, 'the control never replayed anything').toHaveBeenCalled();
  });
});
