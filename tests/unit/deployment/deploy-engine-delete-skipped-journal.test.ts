/**
 * `DeployEngine.deploy()`-level coverage of the skipped-DELETE branch (issue
 * https://github.com/go-to-k/cdkd/issues/1862) — the residual of the (#1762)
 * review that its sibling file structurally cannot reach.
 *
 * `deploy-engine-delete-skipped.test.ts` drives `provisionResource` DIRECTLY,
 * so it can only assert that method's RETURN value (`{ deleteSkipped }`) — the
 * INPUT to the two consumers this file covers:
 *
 *  1. **The journal suppression.** The DELETE executor's `if (deleteOutcome)
 *     return;` keeps a skipped delete out of `completedOperations`, and its
 *     stated hazard is concrete: journaling a delete that never happened makes
 *     `cdkd rollback` re-CREATE a resource that is still alive — a name
 *     collision at best, a second live copy at worst. Only the segment written
 *     on a failed deploy shows whether the op was suppressed, and only
 *     `deploy()` writes one.
 *  2. **The `DeployResult.deleteSkipped` field.** The counter every existing
 *     case asserts is the `counts` bag the engine MUTATES; the field is a
 *     separate spread on the success return path (`actualCounts.deleteSkipped`),
 *     so a regression that stopped threading it would leave those assertions
 *     green.
 *
 * The failing deploy here fails at OUTPUT RESOLUTION rather than at a resource
 * op, which is what makes the journal assertion deterministic: every DELETE has
 * already run, so a missing op is a suppression and never a race.
 *
 * Both cases carry a control that is NOT skipped (`Kept`), so neither can pass
 * vacuously — "no DELETE op for the skipped resource" is only meaningful next
 * to a DELETE op that IS journaled, and `deleteSkipped: 1` only next to
 * `deleted: 1`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceDeleteResult } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

/** A provider skip carries a REQUIRED reason — the line always names a cause. */
const SKIP: ResourceDeleteResult = {
  outcome: 'skipped',
  reason: 'malformed physicalId in state — no delete issued',
};

// A COMPOSITE-physicalId type (the delete arms that report a skip today) that
// is NOT in `STATEFUL_TYPES`, matching the sibling file's choice.
const TYPE = 'AWS::AppSync::Resolver';

const STACK = 'delete-skipped-journal-test';

/** The resource whose provider reports the skip. */
const SKIPPED = 'SkippedDelete';
/** The control: an ordinary DELETE that succeeds in the SAME deploy. */
const KEPT = 'Kept';
/** A CREATE, so the journal segment is non-empty even with both deletes gone. */
const CREATED = 'Created';

type JournalMocks = {
  appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  deleteRollbackJournal: ReturnType<typeof vi.fn>;
  loadRollbackJournal: ReturnType<typeof vi.fn>;
  popRollbackJournalSegment: ReturnType<typeof vi.fn>;
};

describe('DeployEngine.deploy() — skipped DELETE (issue #1862)', () => {
  let journal: JournalMocks;
  let saveState: ReturnType<typeof vi.fn>;
  let deleteCalls: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    deleteCalls = [];
  });

  function deleteChange(logicalId: string): ResourceChange {
    return {
      logicalId,
      changeType: 'DELETE',
      resourceType: TYPE,
      propertyChanges: [],
    } as unknown as ResourceChange;
  }

  function createChange(logicalId: string): ResourceChange {
    return {
      logicalId,
      changeType: 'CREATE',
      resourceType: TYPE,
      desiredProperties: {},
      propertyChanges: [],
    } as unknown as ResourceChange;
  }

  function stateRecord(logicalId: string): ResourceState {
    return {
      physicalId: `phys-${logicalId}`,
      resourceType: TYPE,
      properties: {},
      attributes: {},
      dependencies: [],
    };
  }

  /**
   * One CREATE plus two DELETEs — one whose provider reports a skip, one that
   * deletes normally. Both delete records are in the pre-deploy state, so the
   * DELETE executor dispatches both.
   */
  function buildEngine() {
    const provider = {
      create: vi.fn().mockImplementation((logicalId: string) =>
        Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} })
      ),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys-x', wasReplaced: false }),
      delete: vi.fn().mockImplementation((logicalId: string) => {
        deleteCalls.push(logicalId);
        return Promise.resolve(logicalId === SKIPPED ? SKIP : undefined);
      }),
    };

    const currentState: StackState = {
      version: 8,
      stackName: STACK,
      region: 'us-east-1',
      resources: {
        [SKIPPED]: stateRecord(SKIPPED),
        [KEPT]: stateRecord(KEPT),
      },
      outputs: {},
      lastModified: Date.now(),
    };

    journal = {
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    };
    saveState = vi.fn().mockResolvedValue('etag-1');

    const changes = new Map<string, ResourceChange>([
      [CREATED, createChange(CREATED)],
      [SKIPPED, deleteChange(SKIPPED)],
      [KEPT, deleteChange(KEPT)],
    ]);

    const mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'e0' }),
      saveState,
      ...journal,
    };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([[CREATED]]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((all: Map<string, ResourceChange>, type: string) =>
          [...all.values()].filter((c) => c.changeType === type)
        ),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { concurrency: 4, noRollback: false, roleArn: 'arn:aws:iam::1:role/r' },
      'us-east-1'
    );
  }

  const template: CloudFormationTemplate = {
    Resources: { [CREATED]: { Type: TYPE, Properties: {} } },
  };

  /**
   * Make output resolution throw (only reachable under `--strict-getatt`).
   * Every resource op has already completed at that point, so the journal
   * segment records exactly what the provisioning phases decided to journal —
   * which is the property under test, with no dependence on op ordering.
   */
  function failAtOutputResolution(engine: DeployEngine): CloudFormationTemplate {
    (engine as unknown as { options: { strictGetAtt: boolean } }).options.strictGetAtt = true;
    const outputSentinel = { 'Fn::GetAtt': ['Missing', 'Arn'] };
    const resolver = (engine as unknown as { resolver: { resolve: ReturnType<typeof vi.fn> } })
      .resolver;
    resolver.resolve.mockImplementation((value: unknown) =>
      value === outputSentinel
        ? Promise.reject(new Error('unresolvable output'))
        : Promise.resolve(value)
    );
    return {
      Resources: template.Resources,
      Outputs: { Bad: { Value: outputSentinel } },
    };
  }

  it('keeps a skipped DELETE out of the rollback journal while journaling a real one', async () => {
    const engine = buildEngine();
    const templateWithOutput = failAtOutputResolution(engine);

    await expect(engine.deploy(STACK, templateWithOutput)).rejects.toThrow(
      /unresolvable output|Missing/
    );

    // Both deletes were attempted — the suppression below is about what was
    // RECORDED, not about a delete that never ran.
    expect(deleteCalls.sort()).toEqual([KEPT, SKIPPED]);

    expect(journal.appendRollbackJournalSegment).toHaveBeenCalledOnce();
    const segment = journal.appendRollbackJournalSegment.mock.calls[0]![2];
    expect(segment.reason).toBe('no-rollback-failure');

    const ops = segment.operations as Array<{ logicalId: string; changeType: string }>;
    // The control proves DELETEs reach the journal at all, so the absence
    // asserted next is a suppression rather than a silent whole-phase gap.
    expect(ops.find((o) => o.logicalId === KEPT)).toMatchObject({ changeType: 'DELETE' });
    expect(ops.find((o) => o.logicalId === CREATED)).toMatchObject({ changeType: 'CREATE' });
    // The op that never happened. Journaling it would make `cdkd rollback`
    // re-CREATE a resource that is still alive.
    expect(ops.find((o) => o.logicalId === SKIPPED)).toBeUndefined();
    expect(ops).toHaveLength(2);
  });

  it('reports the skip on DeployResult.deleteSkipped instead of DeployResult.deleted', async () => {
    const engine = buildEngine();

    const result = await engine.deploy(STACK, template);

    expect(result.deleteSkipped).toBe(1);
    // The control: the skip is not merely uncounted, it is counted ELSEWHERE.
    // A regression that folded it into `deleted` would still satisfy a lone
    // `deleteSkipped >= 0`.
    expect(result.deleted).toBe(1);
    expect(result.created).toBe(1);
  });

  it('keeps the skipped resource in the persisted state and drops the deleted one', async () => {
    const engine = buildEngine();

    await engine.deploy(STACK, template);

    const lastSave = saveState.mock.calls.at(-1)!;
    const persisted = lastSave[2] as StackState;
    // Dropping the record is the data-loss half of the branch: the user would
    // have neither the AWS resource gone nor a cdkd record pointing at it.
    expect(persisted.resources[SKIPPED]).toMatchObject({ physicalId: `phys-${SKIPPED}` });
    expect(persisted.resources[KEPT]).toBeUndefined();
  });
});
