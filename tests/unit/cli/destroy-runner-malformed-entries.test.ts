/**
 * Issue go-to-k/cdkd#3202: `runDestroyForStack` reads `resource.resourceType`
 * on every ROW of a readable `resources` map — the template it builds for the
 * dependency graph, the type index behind the implicit delete order, and that
 * order's walk — and none of those reads is guarded. The BAG guard
 * (go-to-k/cdkd#3161, `destroy-runner-malformed-resources.test.ts`) says
 * nothing about a row: `{"resources": {"R": null}}` is a readable map holding
 * one unreadable record.
 *
 * What an unguarded run did with such a row, MEASURED through this file's own
 * cases with the refusal removed (2026-09-25), is recorded in
 * `malformedDestroyResourceEntriesRefusalMessage`'s JSDoc rather than
 * re-asserted here — a probe result written into a test comment is a claim
 * nothing re-checks.
 *
 * REFUSE rather than skip: the map is the list of what to delete, and a row
 * that names no resource type cannot be routed to a provider, so skipping it
 * would end a destroy that reports success with the row's resource still live
 * in AWS and its record gone. The cases are DOMINANCE cases as much as verdict
 * ones: the refusal has to fire before the confirmation prompt, before the
 * lock, and before any provider is chosen.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, getLogger: () => quiet };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({ getProviderFor: vi.fn() })),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => {
  const renderer = {
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  };
  return { getLiveRenderer: () => renderer };
});

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const REGION = 'us-east-1';
const STACK = 'TestStack';

const HEALTHY = { physicalId: 'p-good', resourceType: 'AWS::SSM::Parameter', properties: {} };

function stateWith(resources: unknown): StackState {
  return {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: resources as StackState['resources'],
    outputs: {},
    lastModified: 1,
  };
}

function makeCtx() {
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const acquireLock = vi.fn().mockResolvedValue(true);
  const releaseLock = vi.fn().mockResolvedValue(undefined);
  const getProviderFor = vi.fn();
  return {
    deleteState,
    acquireLock,
    releaseLock,
    getProviderFor,
    ctx: {
      stateBackend: {
        getState: vi.fn().mockResolvedValue(null),
        deleteState,
        saveState: vi.fn(),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock,
        releaseLock,
        getLockInfo: vi.fn().mockResolvedValue(null),
      } as unknown as LockManager,
      providerRegistry: { getProviderFor } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

const refusal = async (state: StackState, h = makeCtx()): Promise<CdkdError> => {
  const thrown = await runDestroyForStack(STACK, state, h.ctx).catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(CdkdError);
  return thrown as CdkdError;
};

describe('runDestroyForStack refuses an unreadable resource ROW (go-to-k/cdkd#3202)', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * Every shape `isReadableResourceEntry` rejects, each planted BESIDE a
   * healthy row so the case cannot pass by the bag being empty, and so the
   * message's naming can be checked in both directions.
   */
  const UNREADABLE: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'abc'],
    ['a number', 5],
    ['a boolean', true],
    // The FALSY shapes take a route of their own without the guard: the delete
    // loop's `if (!resource)` warns `not found in state, skipping`, and the run
    // then removes the record with the row's resource still live (measured).
    ['false', false],
    ['zero', 0],
    ['an empty string', ''],
    ['a list', [{ physicalId: 'p', resourceType: 'T' }]],
    ['an object with no resourceType', { physicalId: 'p-bad', properties: {} }],
    ['an object whose resourceType is not a string', { physicalId: 'p-bad', resourceType: 7 }],
  ];

  for (const [label, row] of UNREADABLE) {
    it(`refuses a row that is ${label}, naming it, and touches nothing`, async () => {
      const h = makeCtx();
      const err = await refusal(stateWith({ Good: HEALTHY, Bad: row }), h);
      expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
      expect(err.message).toContain('Bad');
      expect(err.message, 'the healthy row was named as unreadable').not.toContain('Good');
      // DOMINANCE: a pre-flight. No lock, no record removed, no provider chosen.
      expect(h.acquireLock).not.toHaveBeenCalled();
      expect(h.deleteState).not.toHaveBeenCalled();
      expect(h.getProviderFor).not.toHaveBeenCalled();
    });
  }

  it('marks the refusal non-retryable — a nested child reaches this inside its parent`s withRetry', async () => {
    const err = await refusal(stateWith({ Bad: null }));
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('names the DESTROY consequence, not the rebuilt-map save', async () => {
    const err = await refusal(stateWith({ Bad: null }));
    // The row text, not the bag one: the map itself was readable.
    expect(err.message).toContain('cannot be read as resources');
    expect(err.message).not.toContain("no readable 'resources' map");
    expect(err.message).toContain('cdkd destroy');
    // BOTH measured arms, the null one first: it is the shape that never
    // reaches a provider at all.
    expect(err.message).toContain(
      'a null row stops the run on a bare TypeError in the listing above the prompt'
    );
    expect(err.message).toContain("SKIPPED as 'not found in state'");
    expect(err.message).toContain('routed to a provider on whatever its type field holds');
    // `refuseMalformedResourceEntries`'s text describes saving a REBUILT map
    // back over the record; a destroy's saves are the snapshots of what is left.
    expect(err.message).not.toContain('saving over the record');
    // And it ends on the read command, so a line-select paste carries nothing
    // after it.
    expect(err.message).toMatch(/cdkd state show TestStack --stack-region us-east-1 --json$/);
  });

  it('names EVERY unreadable row in one refusal', async () => {
    const err = await refusal(stateWith({ A: null, Good: HEALTHY, B: 'x', C: { physicalId: 'p' } }));
    for (const id of ['A', 'B', 'C']) expect(err.message).toContain(id);
    expect(err.message).not.toContain('Good');
  });

  /**
   * PRECEDENCE with the bag guard. An unreadable BAG has no rows to name, and
   * `unreadableResourceEntries` returns `[]` for one by design, so the two
   * cannot both fire — but a reorder that put the row guard first would make
   * that hold by accident. Pin that the bag text wins.
   */
  it('names the BAG when the map itself is unreadable, not a row', async () => {
    const err = await refusal(stateWith('abc'));
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(err.message).toContain("no readable 'resources' map");
    expect(err.message).not.toContain('cannot be read as resources');
  });

  /**
   * The SECOND record the runner counts: the fast path re-reads under the lock
   * and acts on THAT object. A row cannot make the re-read count 0, so this
   * guard does not protect `deleteState` — what it buys is WHICH refusal the
   * operator gets, exactly as the orphan-row guard at the same site does: without
   * it the run stops at the "not empty" branch, which says the record holds
   * resources and nothing about the row it could not read.
   */
  it('refuses a re-read record that gained an unreadable row under the lock, and releases the lock', async () => {
    const h = makeCtx();
    (h.ctx.stateBackend.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: stateWith({ Late: null }),
      etag: 'e',
    });
    const err = await refusal(stateWith({}), h);
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(err.message).toContain('Late');
    expect(h.deleteState).not.toHaveBeenCalled();
    expect(h.acquireLock).toHaveBeenCalled();
    expect(h.releaseLock).toHaveBeenCalledWith(STACK, REGION);
  });

  // THE OTHER DIRECTION.
  it('lets a map of readable rows through to the delete path', async () => {
    const h = makeCtx();
    await runDestroyForStack(STACK, stateWith({ Good: HEALTHY }), h.ctx).catch(() => undefined);
    expect(h.getProviderFor, 'a healthy record no longer reaches the delete path').toHaveBeenCalled();
  });

  it('does not ask for a physicalId — a typed row with none fails per-resource, in its own terms', async () => {
    // `isReadableResourceEntry` stops at `resourceType` by a recorded decision:
    // a row that names its type CAN be routed, and what its missing id costs is
    // reported by the delete itself. Widening the predicate here would refuse
    // records the deploy accepts.
    const h = makeCtx();
    await runDestroyForStack(
      STACK,
      stateWith({ Typed: { resourceType: 'AWS::SSM::Parameter', properties: {} } }),
      h.ctx
    ).catch(() => undefined);
    expect(h.getProviderFor).toHaveBeenCalled();
  });
});
