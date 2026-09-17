/**
 * Issue go-to-k/cdkd#3161: `runDestroyForStack` routes on
 * `Object.keys(state.resources).length`, and that COUNT is the list of what to
 * delete. A hand-edited or truncated record splits into three outcomes there,
 * which is why each shape gets its own case below rather than one table row:
 *
 * - `[]` / a number / a boolean enumerate NO keys, so the count is 0 and — with
 *   no orphans — the run takes the empty-stack FAST PATH, which deletes
 *   `state.json`. The destroy reports success having deleted nothing and every
 *   resource the record named is left live in AWS, unreferenced. This is the
 *   silent-orphaning outcome the issue is about.
 * - a string enumerates one fabricated logical id per character, so the run
 *   proceeds against resources that do not exist.
 * - `null` / absent throw a bare `TypeError` out of `Object.keys` — unhelpful,
 *   but loud.
 *
 * REPAIRING is not the safe half here, and the case below marked as the
 * MEASUREMENT says why: the repaired shape is `{}`, which is byte-identical to
 * a legitimately empty stack, which takes the fast path and deletes the record.
 * So a repair reproduces the damaging outcome rather than avoiding it — the
 * same measurement go-to-k/cdkd#3191 recorded one container down.
 *
 * The cases are DOMINANCE cases as much as verdict ones: the fast path sits
 * immediately below the count, so a guard written anywhere below it refuses a
 * record it has already deleted. `deleteState` not being called is what
 * discriminates.
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
import {
  STATE_RESOURCES_MALFORMED,
  repairMalformedResourcesForReadOnly,
} from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const REGION = 'us-east-1';
const STACK = 'TestStack';

function stateWithResources(resources: unknown): StackState {
  return {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: resources as StackState['resources'],
    outputs: {},
    lastModified: 1,
  };
}

/** A record whose `resources` key is genuinely absent — a defect, unlike `outputs`. */
function stateWithoutResources(): StackState {
  const state = stateWithResources({});
  delete (state as Partial<StackState>).resources;
  return state;
}

function makeCtx() {
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const acquireLock = vi.fn().mockResolvedValue(true);
  const releaseLock = vi.fn().mockResolvedValue(undefined);
  const listStacks = vi.fn().mockResolvedValue([]);
  const getProviderFor = vi.fn();
  return {
    deleteState,
    acquireLock,
    releaseLock,
    listStacks,
    getProviderFor,
    ctx: {
      stateBackend: {
        getState: vi.fn().mockResolvedValue(null),
        deleteState,
        saveState: vi.fn(),
        listStacks,
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

describe('runDestroyForStack refuses a malformed `resources` bag (go-to-k/cdkd#3161)', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * One entry per OUTCOME the unguarded count produces, not one per JavaScript
   * type — the three groups behave differently and a fence covering only one
   * of them leaves the other two open. The `emptyEnumerating` group is the
   * damaging one: it is the shape that reaches the fast path.
   */
  const MALFORMED: Array<[string, unknown]> = [
    // Enumerate NO keys -> count 0 -> empty-stack fast path -> state deleted,
    // success reported, every live resource orphaned.
    ['a list bag', []],
    ['a populated list bag', [{ physicalId: 'p' }]],
    ['a number bag', 5],
    ['a boolean bag', true],
    // Enumerates one fabricated logical id per character.
    ['a string bag', 'ab'],
    // Throws a bare TypeError out of `Object.keys`.
    ['a null bag', null],
  ];

  for (const [label, bag] of MALFORMED) {
    it(`refuses ${label} with the shared code, and deletes nothing`, async () => {
      const h = makeCtx();
      let thrown: unknown;
      try {
        await runDestroyForStack(STACK, stateWithResources(bag), h.ctx);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      // DOMINANCE. The empty-stack fast path sits immediately below the count
      // this guard must precede, and that path DELETES the record — so a guard
      // one line too low refuses a record that is already gone.
      expect(
        h.deleteState,
        'the destroy deleted the state record before refusing, so the damaged record is gone ' +
          'and the live resources it named are now untraceable'
      ).not.toHaveBeenCalled();
      // ...and it refuses without taking the lock: the refusal is a pre-flight,
      // and a lock taken here is one more thing to strand.
      expect(h.acquireLock).not.toHaveBeenCalled();
      // Nor did it start deleting anything down the ordinary path — the shape
      // the string bag would have taken with two fabricated logical ids.
      expect(h.getProviderFor).not.toHaveBeenCalled();
    });
  }

  it('refuses an ABSENT resources bag — unlike `outputs`, absence is a defect here', async () => {
    const h = makeCtx();
    const thrown = await runDestroyForStack(STACK, stateWithoutResources(), h.ctx).catch(
      (e: unknown) => e
    );
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
    expect(h.deleteState).not.toHaveBeenCalled();
  });

  it('marks the refusal non-retryable — a retry cannot change a persisted record', async () => {
    const h = makeCtx();
    const thrown = await runDestroyForStack(STACK, stateWithResources([]), h.ctx).catch(
      (e: unknown) => e
    );
    expect(isMarkedNonRetryable(thrown)).toBe(true);
  });

  it('names the DESTROY consequence, not the deploy or the save one', async () => {
    const h = makeCtx();
    const err = await runDestroyForStack(STACK, stateWithResources([]), h.ctx).catch(
      (e: unknown) => e
    );
    const message = (err as Error).message;
    expect(message).toContain('DELETES state');
    expect(message).toContain('empty-stack fast path');
    // It must not borrow `malformedStateRefusalMessage`, whose harm is the SAVE
    // — a destroy never saves over the record, it removes it.
    expect(
      message,
      'the destroy refusal borrowed the generic write-capable text, which describes a save ' +
        'that never happens here'
    ).not.toContain('saving over a record');
    // And it must offer the supported way to drop the record deliberately,
    // which is the objection go-to-k/cdkd#3161 raises against refusing at all.
    expect(message).toContain('cdkd state orphan');
  });

  /**
   * THE MEASUREMENT the contract rests on, driven rather than asserted in
   * prose: `{}` IS what a repair would produce, and it takes the fast path and
   * deletes the record. So repairing `[]` / `5` / `true` — every shape that
   * enumerates no keys — reproduces the damaging outcome instead of avoiding
   * it, and only a refusal closes the class.
   *
   * It doubles as the OTHER-DIRECTION case: a guard that refused every record
   * would satisfy every case above while making `cdkd destroy` unusable on a
   * stack that is genuinely empty.
   */
  it('lets a LEGITIMATELY EMPTY `{}` bag through to the fast path — which is also why repairing is not the safe half', async () => {
    const h = makeCtx();
    const result = await runDestroyForStack(STACK, stateWithResources({}), h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(h.deleteState).toHaveBeenCalledWith(STACK, REGION);
  });

  /**
   * The SECOND record this function counts. The fast path re-reads state under
   * the lock, because emptiness has to be established under the lock rather
   * than inherited from the caller's snapshot — so the entry guard has cleared
   * a DIFFERENT object from the one that decides. A concurrent writer, or a
   * hand edit landing between the two reads, leaves the re-read unreadable, its
   * count 0, `stillEmpty` true, and `deleteState` running on the very line the
   * re-read exists to protect.
   */
  it('refuses a re-read record whose bag went unreadable under the lock', async () => {
    const h = makeCtx();
    (h.ctx.stateBackend.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: stateWithResources([]),
      etag: 'e',
    });
    const thrown = await runDestroyForStack(STACK, stateWithResources({}), h.ctx).catch(
      (e: unknown) => e
    );
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
    expect(
      h.deleteState,
      'the re-read record counted 0 through an unreadable bag and the state was deleted anyway'
    ).not.toHaveBeenCalled();
    // This refusal fires with the lock HELD — unlike the entry guard, which is
    // a pre-flight. Moving it a few lines up, outside the `try` whose `finally`
    // releases, strands the lock for its full TTL with every other assertion
    // here still green.
    expect(
      h.releaseLock,
      'the re-read refusal escaped the try/finally, so it strands the stack lock'
    ).toHaveBeenCalledWith(STACK, REGION);
    // ...and it really did take the lock, so the assertion above is not
    // satisfied by a path that never acquired one.
    expect(h.acquireLock).toHaveBeenCalled();
  });

  it('still deletes when the re-read record is genuinely empty — the control for the case above', async () => {
    const h = makeCtx();
    (h.ctx.stateBackend.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: stateWithResources({}),
      etag: 'e',
    });
    const result = await runDestroyForStack(STACK, stateWithResources({}), h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(h.deleteState).toHaveBeenCalledWith(STACK, REGION);
  });

  /**
   * The two halves of the measurement, JOINED — the case above deploys a
   * literal `{}` and could be read as merely restating the control. This one
   * takes an actually-malformed `[]` record, applies the READ-ONLY REPAIR the
   * class offers elsewhere, and drives the RESULT through the runner. That is
   * what a "just repair it" implementation would have done, and it reaches
   * `deleteState`.
   */
  it('MEASUREMENT: a `[]` record put through the read-only repair reaches deleteState', async () => {
    const h = makeCtx();
    const repaired = stateWithResources([]);
    expect(
      repairMalformedResourcesForReadOnly(repaired),
      'the repair declined this record, so the measurement below is about something else'
    ).toBe(true);
    expect(repaired.resources).toEqual({});
    const result = await runDestroyForStack(STACK, repaired, h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(
      h.deleteState,
      'repairing a `[]` record no longer reaches the fast path, so the refuse-not-repair ' +
        'contract rests on nothing measured'
    ).toHaveBeenCalledWith(STACK, REGION);
  });

  /**
   * PRECEDENCE. A record can be malformed in BOTH containers, both refusals
   * carry the same code, and only the TEXT tells them apart — so a reorder of
   * the two guards is invisible without this. `resources` wins here because
   * it is the container the fast path acts on.
   */
  it('names `resources` when BOTH containers are malformed', async () => {
    const h = makeCtx();
    const state = stateWithResources([]);
    state.outputs = 'abcdef' as unknown as StackState['outputs'];
    const err = (await runDestroyForStack(STACK, state, h.ctx).catch(
      (e: unknown) => e
    )) as CdkdError;
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(err.message).toContain(`'resources'`);
    expect(
      err.message,
      'the outputs guard now runs first, so a record broken in both reports the wrong container'
    ).not.toContain('SKIPS the check');
    expect(h.deleteState).not.toHaveBeenCalled();
  });

  it('still names `outputs` when only that container is malformed', async () => {
    // The control for the case above: without it, a guard that always reported
    // `resources` would satisfy the precedence assertion.
    const h = makeCtx();
    const state = stateWithResources({});
    state.outputs = 'abcdef' as unknown as StackState['outputs'];
    const err = (await runDestroyForStack(STACK, state, h.ctx).catch(
      (e: unknown) => e
    )) as CdkdError;
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(err.message).toContain('SKIPS the check');
  });

  /**
   * A legacy `version: 1` record records no region, so the hoisted
   * `regionForState` falls back to the caller's `baseRegion` — and that value
   * is what the refusal NAMES. Without this case the fallback arm is unread.
   */
  it('names the caller`s baseRegion for a legacy record that carries none', async () => {
    const h = makeCtx();
    const state = stateWithResources([]);
    delete (state as Partial<StackState>).region;
    const err = (await runDestroyForStack(STACK, state, h.ctx).catch(
      (e: unknown) => e
    )) as CdkdError;
    expect(err.message).toContain(REGION);
  });

  it('lets a POPULATED bag through to the ordinary delete path', async () => {
    const h = makeCtx();
    const state = stateWithResources({
      Param: { physicalId: 'p', resourceType: 'AWS::SSM::Parameter', properties: {} },
    });
    await runDestroyForStack(STACK, state, h.ctx).catch(() => undefined);
    expect(
      h.getProviderFor,
      'a healthy record no longer reaches the delete path at all'
    ).toHaveBeenCalled();
  });

  /**
   * The discriminator is the container's SHAPE, never its size. `{}` and `[]`
   * both count 0, so a guard written as a count test cannot tell them apart —
   * this pins that the two reach OPPOSITE verdicts through the same count.
   */
  it('separates the unreadable from the empty although both count zero', async () => {
    const readable = makeCtx();
    await runDestroyForStack(STACK, stateWithResources({}), readable.ctx);
    expect(Object.keys({} as Record<string, unknown>)).toHaveLength(0);
    expect(Object.keys([] as unknown as Record<string, unknown>)).toHaveLength(0);
    expect(readable.deleteState).toHaveBeenCalled();

    const unreadable = makeCtx();
    await runDestroyForStack(STACK, stateWithResources([]), unreadable.ctx).catch(
      () => undefined
    );
    expect(unreadable.deleteState).not.toHaveBeenCalled();
  });
});
