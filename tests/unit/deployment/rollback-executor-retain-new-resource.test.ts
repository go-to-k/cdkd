/**
 * Issue [#2598](https://github.com/go-to-k/cdkd/issues/2598): the three
 * replacement-rollback arms that DELETE the resource the replacement created
 * consulted no retain policy at all, while the two CREATE-rollback arms next
 * to them consulted `DeletionPolicy`. So a resource the template marked to
 * survive was destroyed or orphaned depending on which OP SHAPE produced it.
 *
 * Which attribute governs the new copy is measured, not reasoned — a live
 * four-variant CloudFormation A/B (recorded on
 * `rollbackRetainsNewResource`'s doc comment) showed `UpdateReplacePolicy`
 * decides it and `DeletionPolicy` has no effect. The `DeletionPolicy: Retain`
 * negative below is that A/B's row 2 in unit form: it is what stops a later
 * "make it consistent with the CREATE arms" edit from silently reversing the
 * verdict.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  planRollback,
  replayRollback,
  rollbackRetainsNewResource,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

// Single-attempt pass-through so the collision arm does not sleep through the
// real 2-10s name-release schedule.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: 'AWS::SQS::Queue',
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function makeCtx(provider: { create?: unknown; delete?: unknown; update?: unknown }): {
  ctx: RollbackExecutorContext;
  warns: string[];
} {
  const warns: string[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((m: string) => warns.push(m)),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  return {
    ctx: {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
    },
    warns,
  };
}

/** The op shape every case below shares: `phys-old` was replaced by `phys-new`. */
function replacementOp(oldResourceRetained?: boolean): CompletedOperation {
  return {
    logicalId: 'B',
    changeType: 'UPDATE',
    resourceType: 'AWS::SQS::Queue',
    physicalId: 'phys-new',
    previousState: res({ physicalId: 'phys-old', properties: { a: 1 } }),
    ...(oldResourceRetained !== undefined && { oldResourceRetained }),
  };
}

describe('rollbackRetainsNewResource', () => {
  it('reads UpdateReplacePolicy and ignores DeletionPolicy', () => {
    expect(rollbackRetainsNewResource(res({ updateReplacePolicy: 'Retain' }))).toBe(true);
    // The A/B's row 2 in one line: `DeletionPolicy: Retain` alone does NOT
    // save the new copy, however natural the analogy with the CREATE-rollback
    // arms feels.
    expect(rollbackRetainsNewResource(res({ deletionPolicy: 'Retain' }))).toBe(false);
    expect(rollbackRetainsNewResource(res({ updateReplacePolicy: 'Snapshot' }))).toBe(false);
    expect(rollbackRetainsNewResource(res())).toBe(false);
    expect(rollbackRetainsNewResource(undefined)).toBe(false);
  });
});

describe('a replacement rollback honours UpdateReplacePolicy: Retain on the NEW copy (issue #2598)', () => {
  describe('reverse-replacement (re-create the old, then dispose of the new)', () => {
    it('retains the new resource, still re-creates the old, and counts a warning', async () => {
      const create = vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' });
      const del = vi.fn().mockResolvedValue(undefined);
      const { ctx, warns } = makeCtx({ create, delete: del });
      const state: Record<string, ResourceState> = {
        B: res({ physicalId: 'phys-new', properties: { a: 2 }, updateReplacePolicy: 'Retain' }),
      };

      const result = await replayRollback([replacementOp()], state, 'S', ctx);

      expect(create).toHaveBeenCalledTimes(1);
      expect(del).not.toHaveBeenCalled();
      // The revert still COMPLETES — state names the re-created old resource,
      // and nothing names the survivor. The A/B measured that CloudFormation
      // orphans a retained new copy OUT of the stack (deleting the stack
      // afterwards left it alive), so a record naming it would be wrong.
      expect(state.B!.physicalId).toBe('phys-old-2');
      expect(result.failures).toBe(0);
      // Exit code 2: a live resource cdkd no longer tracks is exactly what
      // the warnings counter is for.
      expect(result.warnings).toBe(1);
      const warnText = warns.join('\n');
      expect(warnText).toContain('phys-new');
      expect(warnText).toContain('UpdateReplacePolicy: Retain');
      // The warn also has to name where state ENDED UP, or the user cannot
      // tell which of the two live resources cdkd is now tracking. Unfenced
      // until review: replacing the id token with a wrong value stayed green.
      expect(warnText).toContain('phys-old-2');
    });

    it('DeletionPolicy: Retain on the new copy does NOT save it', async () => {
      // The measured negative. Without this the codebase reads as if the
      // CREATE-rollback arms' `deletionPolicy` check should apply here too.
      const create = vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' });
      const del = vi.fn().mockResolvedValue(undefined);
      const { ctx } = makeCtx({ create, delete: del });
      const state: Record<string, ResourceState> = {
        B: res({ physicalId: 'phys-new', properties: { a: 2 }, deletionPolicy: 'Retain' }),
      };

      const result = await replayRollback([replacementOp()], state, 'S', ctx);

      expect(del).toHaveBeenCalledWith('B', 'phys-new', 'AWS::SQS::Queue', { a: 2 }, {
        expectedRegion: 'us-east-1',
      });
      expect(result.warnings).toBe(0);
    });

    it('issues no delete-provider lookup on the Retain warn path', async () => {
      // The readopt arm's fix, applied to its `reverse-replacement` sibling
      // (delta review): `newDeleteProvider` was resolved EAGERLY, before the
      // create, while two paths here never delete — the `Retain` warn arm and
      // the collision REFUSAL. `getProviderFor` throws for a type this
      // registry cannot route, so either could fail on a lookup it never
      // needed, before the re-create was even attempted.
      const create = vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' });
      const lookups: Array<'create' | 'delete'> = [];
      const state: Record<string, ResourceState> = {
        B: res({ physicalId: 'phys-new', properties: { a: 2 }, updateReplacePolicy: 'Retain' }),
      };
      const warns: string[] = [];
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn((m: string) => warns.push(m)),
        error: vi.fn(),
        setLevel: vi.fn(),
        child() {
          return this;
        },
      } as unknown as RollbackExecutorContext['logger'];
      const ctx: RollbackExecutorContext = {
        region: 'us-east-1',
        logger,
        providerRegistry: {
          // The CREATE lookup (keyed on the PREVIOUS record's layer) must
          // still work; the DELETE lookup must never be attempted.
          getProviderFor: (input: { provisionedBy?: 'sdk' | 'cc-api' }) => {
            if (input.provisionedBy === 'cc-api') {
              lookups.push('create');
              return { provider: { create, delete: vi.fn(), update: vi.fn() } };
            }
            lookups.push('delete');
            throw new Error('No provider available for resource type: AWS::Weird::Thing');
          },
        } as unknown as RollbackExecutorContext['providerRegistry'],
      };
      const op = replacementOp();
      op.previousState = res({
        physicalId: 'phys-old',
        properties: { a: 1 },
        provisionedBy: 'cc-api',
      });

      const result = await replayRollback([op], state, 'S', ctx);

      expect(lookups).toEqual(['create']);
      expect(result.failures).toBe(0);
      expect(result.warnings).toBe(1);
      expect(state.B!.physicalId).toBe('phys-old-2');
    });

    it('issues no delete-provider lookup on the collision REFUSAL path either', async () => {
      // The second non-deleting path the lazy-lookup comment names. Split out
      // after the round-4 review pointed out that the case above drives only
      // the warn arm while its NAME claimed both — re-hoisting the lookup to
      // just above the refusal would have kept it green.
      const lookups: Array<'create' | 'delete'> = [];
      const warns: string[] = [];
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn((m: string) => warns.push(m)),
        error: vi.fn(),
        setLevel: vi.fn(),
        child() {
          return this;
        },
      } as unknown as RollbackExecutorContext['logger'];
      const ctx: RollbackExecutorContext = {
        region: 'us-east-1',
        logger,
        providerRegistry: {
          getProviderFor: (input: { provisionedBy?: 'sdk' | 'cc-api' }) => {
            if (input.provisionedBy === 'cc-api') {
              lookups.push('create');
              return {
                provider: {
                  create: async () => {
                    throw new Error('Queue already exists');
                  },
                  delete: vi.fn(),
                  update: vi.fn(),
                },
              };
            }
            lookups.push('delete');
            throw new Error('No provider available for resource type: AWS::Weird::Thing');
          },
        } as unknown as RollbackExecutorContext['providerRegistry'],
      };
      const state: Record<string, ResourceState> = {
        B: res({ physicalId: 'phys-new', properties: { a: 2 }, updateReplacePolicy: 'Retain' }),
      };
      const op = replacementOp();
      op.previousState = res({
        physicalId: 'phys-old',
        properties: { a: 1 },
        provisionedBy: 'cc-api',
      });

      const result = await replayRollback([op], state, 'S', ctx, { isInterrupted: () => false });

      // The refusal is what failed the op — NOT the delete-route lookup.
      expect(lookups).toEqual(['create']);
      expect(result.failures).toBe(1);
      expect(state.B!.physicalId).toBe('phys-new');
    });

    it('an unroutable delete layer AFTER a successful re-create degrades to warn-and-count', async () => {
      // The documented severity change of making the lookup lazy, which had no
      // test (code review). Eagerly, an unroutable type threw at the top of the
      // arm and FAILED the op (exit 1). Lazily the throw lands inside the
      // `deleteNewAfterRecreate` try, whose catch warns and counts (exit 2).
      // That matches the site's existing treatment of a delete it cannot
      // perform -- the old resource is already re-created and state already
      // points at it -- but it IS a user-visible exit-code change, so it is
      // pinned rather than left to the comment.
      //
      // No `Retain` here: this is the ORDINARY delete path, reached only when
      // the new copy is not pinned.
      const lookups: Array<'create' | 'delete'> = [];
      const warns: string[] = [];
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn((m: string) => warns.push(m)),
        error: vi.fn(),
        setLevel: vi.fn(),
        child() {
          return this;
        },
      } as unknown as RollbackExecutorContext['logger'];
      const ctx: RollbackExecutorContext = {
        region: 'us-east-1',
        logger,
        providerRegistry: {
          getProviderFor: (input: { provisionedBy?: 'sdk' | 'cc-api' }) => {
            if (input.provisionedBy === 'cc-api') {
              lookups.push('create');
              return {
                provider: {
                  create: async () => ({ physicalId: 'phys-old-2' }),
                  delete: vi.fn(),
                  update: vi.fn(),
                },
              };
            }
            lookups.push('delete');
            throw new Error('No provider available for resource type: AWS::Weird::Thing');
          },
        } as unknown as RollbackExecutorContext['providerRegistry'],
      };
      const state: Record<string, ResourceState> = {
        B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
      };
      const op = replacementOp();
      op.previousState = res({
        physicalId: 'phys-old',
        properties: { a: 1 },
        provisionedBy: 'cc-api',
      });

      const result = await replayRollback([op], state, 'S', ctx);

      // The re-create ran and the delete lookup was reached and threw.
      expect(lookups).toEqual(['create', 'delete']);
      // Exit 2, not exit 1 -- the whole point of the assertion.
      expect(result.failures).toBe(0);
      expect(result.warnings).toBe(1);
      // State already names the re-created old resource, which is why
      // degrading is safe.
      expect(state.B!.physicalId).toBe('phys-old-2');
      // The warn is the ONLY thing telling the user a live resource was left
      // behind, so it has to name it -- the same id-token fence the two retain
      // warns carry. It was collected but unasserted until review.
      const degradeWarn = warns.join('\n');
      expect(degradeWarn).toContain('phys-new');
      expect(degradeWarn).toContain('no longer tracked');
    });

    it('a name collision under Retain REFUSES rather than deleting the pinned holder', async () => {
      // The one arm where the two goals conflict: this delete exists solely to
      // free the name the re-create collided on, so Retain makes the op
      // impossible. Failing loudly beats destroying a resource marked to
      // survive — and beats a silent, repeated collision.
      const create = vi.fn().mockRejectedValue(new Error('Queue already exists'));
      const del = vi.fn().mockResolvedValue(undefined);
      const { ctx } = makeCtx({ create, delete: del });
      const refusals: string[] = [];
      ctx.recordEvent = (e) => {
        if (e.error?.message) refusals.push(e.error.message);
      };
      const state: Record<string, ResourceState> = {
        B: res({ physicalId: 'phys-new', properties: { a: 2 }, updateReplacePolicy: 'Retain' }),
      };

      const result = await replayRollback([replacementOp()], state, 'S', ctx, {
        isInterrupted: () => false,
      });

      expect(del).not.toHaveBeenCalled();
      // Counted as a FAILURE, which is what keeps the journal segment for a
      // re-run once the user has resolved the conflict.
      expect(result.failures).toBe(1);
      // The record must still name the new resource: dropping it here would
      // strand a live resource with nothing pointing at it.
      expect(state.B!.physicalId).toBe('phys-new');
      // DISCRIMINATOR, and the reason this case does not stand on the two
      // assertions above: a raw rethrow of the create error — the arm taken
      // when `isNameCollisionError` does NOT match — produces exactly the same
      // "no delete, one failure, record untouched" shape. Only the refusal's
      // own text proves the Retain branch was entered rather than skipped.
      expect(refusals.join('\n')).toContain('Cannot reverse the replacement of B');
    });

    it('the collision refusal names the pinning policy and the recovery path', async () => {
      // Separated from the case above because the refusal is caught per-op:
      // the replay never rethrows it, so the assertion has to reach the error
      // through the recorded event rather than through `rejects`.
      const errors: Array<{ message?: string }> = [];
      const create = vi.fn().mockRejectedValue(new Error('Queue already exists'));
      const { ctx } = makeCtx({ create, delete: vi.fn() });
      ctx.recordEvent = (e) => {
        if (e.error) errors.push(e.error);
      };
      const state: Record<string, ResourceState> = {
        B: res({ physicalId: 'phys-new', properties: { a: 2 }, updateReplacePolicy: 'Retain' }),
      };

      await replayRollback([replacementOp()], state, 'S', ctx, { isInterrupted: () => false });

      const text = errors.map((e) => e.message ?? '').join('\n');
      expect(text).toContain('UpdateReplacePolicy: Retain pins that new resource in place');
      expect(text).toContain('phys-new');
      // The remedy has to be actionable, and the journal survival is the part
      // a user cannot infer.
      // Shortened from 'rollback journal is kept' when the sentence was
      // reworded; the case gained the `--orphan` needle below, so net stronger.
      expect(text).toContain('journal is kept');
      // The remedy that lets the REST of the rollback finish — one op failure
      // breaks the segment loop, so without `--orphan` a single pinned
      // resource halts every older segment too.
      expect(text).toContain('cdkd rollback --orphan B');
    });
  });

  describe('reverse-replacement-readopt (the old resource is still alive)', () => {
    it('retains the new resource and still re-points state at the old one', async () => {
      const del = vi.fn().mockResolvedValue(undefined);
      const create = vi.fn();
      const { ctx, warns } = makeCtx({ create, delete: del });
      const state: Record<string, ResourceState> = {
        B: res({ physicalId: 'phys-new', properties: { a: 2 }, updateReplacePolicy: 'Retain' }),
      };

      // `oldResourceRetained: true` is what selects the readopt arm (issue
      // #2603) — a DIFFERENT retention question from the one under test here,
      // and the case exists partly to prove the two do not collapse into one.
      const result = await replayRollback([replacementOp(true)], state, 'S', ctx);

      expect(del).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(state.B!.physicalId).toBe('phys-old');
      expect(result.failures).toBe(0);
      expect(result.warnings).toBe(1);
      const readoptWarn = warns.join('\n');
      expect(readoptWarn).toContain('phys-new');
      // Same fence on the readopt arm: the survivor AND the resource state is
      // restored to must both be named.
      expect(readoptWarn).toContain('phys-old');
    });

    it('issues no provider lookup at all when the new copy is retained', async () => {
      // The lookup used to be hoisted above the retain check. `getProviderFor`
      // THROWS for a type the rollback command's registry cannot route (an
      // `--allow-unsupported-types` type, say), so a readopt that makes no AWS
      // call could fail on a lookup it never needed. Found by the code
      // reviewer; a `void`-the-variable probe cannot show it, only a registry
      // that actually throws can.
      const warns: string[] = [];
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn((m: string) => warns.push(m)),
        error: vi.fn(),
        setLevel: vi.fn(),
        child() {
          return this;
        },
      } as unknown as RollbackExecutorContext['logger'];
      const ctx: RollbackExecutorContext = {
        region: 'us-east-1',
        logger,
        providerRegistry: {
          getProviderFor: () => {
            throw new Error('No provider available for resource type: AWS::Weird::Thing');
          },
        } as unknown as RollbackExecutorContext['providerRegistry'],
      };
      const state: Record<string, ResourceState> = {
        B: res({ physicalId: 'phys-new', properties: { a: 2 }, updateReplacePolicy: 'Retain' }),
      };

      const result = await replayRollback([replacementOp(true)], state, 'S', ctx);

      expect(result.failures).toBe(0);
      expect(state.B!.physicalId).toBe('phys-old');
      expect(warns.join('\n')).toContain('phys-new');
    });

    it('without the policy the new resource is still deleted (a record the ENGINE cannot produce)', async () => {
      // For any journal a cdkd binary wrote this arm is UNREACHABLE:
      // `oldResourceRetained: true` requires the template to declare
      // `UpdateReplacePolicy: Retain`, and the SAME template read populates the
      // new record through `extractTemplateAttributes` — so reaching readopt
      // implies the current record carries `Retain` too. The state below is
      // therefore hand-edited or externally produced. The case guards the
      // classifier/executor decoupling: the two are separately reachable, and
      // if that pairing ever changes this is what says the delete path still
      // works.
      //
      // Round 3 of the review split this comment onto an `it` of its own and
      // left that one with NO body — a case that passed unconditionally under
      // a name claiming behaviour. Both delta reviewers caught it; the comment
      // now lives on the case that actually asserts.
      const del = vi.fn().mockResolvedValue(undefined);
      const { ctx } = makeCtx({ create: vi.fn(), delete: del });
      const state: Record<string, ResourceState> = {
        B: res({ physicalId: 'phys-new', properties: { a: 2 } }),
      };

      const result = await replayRollback([replacementOp(true)], state, 'S', ctx);

      expect(del).toHaveBeenCalledTimes(1);
      expect(state.B!.physicalId).toBe('phys-old');
      expect(result.warnings).toBe(0);
    });
  });

  describe('the survivor reaches the DURABLE record, not just the terminal', () => {
    // Security review of issue #2598. Both retain arms deliberately orphan a
    // live resource and announced it ONLY via `logger.warn`. A rollback runs
    // during an already-failing deploy -- typically non-TTY, log truncated or
    // discarded -- so exit 2 told the user something survived while nothing
    // anywhere named WHAT: `cdkd events` showed a clean success and state
    // named only the old resource. `Retain` is the marker users put on
    // data-bearing resources, so that is the worst population to lose an id
    // for.
    //
    // The `physicalId` FIELD is the assertion that matters: a `--json`
    // consumer should not have to parse prose out of `reason`.
    type CapturedEvent = {
      eventType: string;
      logicalId?: string;
      physicalId?: string;
      reason?: string;
      provisionedBy?: 'sdk' | 'cc-api';
    };

    /**
     * Every case below makes the SURVIVOR's layer differ from the OP's --
     * survivor `cc-api`, op `sdk`. A fixture where both are the same layer
     * cannot tell a threaded value from a defaulted one, which is the repo's
     * "an explicit arm must differ from the default" rule. The survivor's
     * layer is the one that says which API manages the id this event now
     * carries, so a consumer reading the pair would otherwise be handed the
     * wrong provider for a live, untracked resource.
     */
    const SURVIVOR_LAYER = 'cc-api' as const;
    const OP_LAYER = 'sdk' as const;

    function opWithLayer(oldResourceRetained?: boolean): CompletedOperation {
      return { ...replacementOp(oldResourceRetained), provisionedBy: OP_LAYER };
    }

    function captureEvents(ctx: RollbackExecutorContext): CapturedEvent[] {
      const seen: CapturedEvent[] = [];
      ctx.recordEvent = (e) => {
        seen.push(e as CapturedEvent);
      };
      return seen;
    }

    it('readopt: the success event carries the survivor id and a reason', async () => {
      const { ctx } = makeCtx({ create: vi.fn(), delete: vi.fn() });
      const events = captureEvents(ctx);
      const state: Record<string, ResourceState> = {
        B: res({
          physicalId: 'phys-new',
          properties: { a: 2 },
          updateReplacePolicy: 'Retain',
          provisionedBy: SURVIVOR_LAYER,
        }),
      };

      const result = await replayRollback([opWithLayer(true)], state, 'S', ctx);

      expect(result.warnings).toBe(1);
      const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
      expect(ok).toBeDefined();
      expect(ok!.physicalId).toBe('phys-new');
      expect(ok!.reason).toContain('UpdateReplacePolicy: Retain');
      expect(ok!.reason).toContain('phys-new');
      // And it says where state ended up, so the two ids are not ambiguous.
      // The CLAUSE, not just the id: `retainedSurvivorMessages` takes the two
      // arms' only difference as a parameter, so swapping the arms' prose
      // while keeping each id expression stayed green until this asserted the
      // wording. This arm RESTORES an old resource; its twin RECORDS a
      // re-created one, and telling a user the wrong one is the whole risk.
      expect(ok!.reason).toContain('State is restored to the old resource (phys-old)');
      expect(ok!.reason).not.toContain('re-created');
      // The SURVIVOR's layer, not the op's -- the two differ here on purpose.
      expect(ok!.provisionedBy).toBe(SURVIVOR_LAYER);
      expect(ok!.provisionedBy).not.toBe(OP_LAYER);
    });

    it('reverse-replacement: the success event carries the survivor id and a reason', async () => {
      const { ctx } = makeCtx({
        create: vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' }),
        delete: vi.fn(),
      });
      const events = captureEvents(ctx);
      const state: Record<string, ResourceState> = {
        B: res({
          physicalId: 'phys-new',
          properties: { a: 2 },
          updateReplacePolicy: 'Retain',
          provisionedBy: SURVIVOR_LAYER,
        }),
      };

      const result = await replayRollback([opWithLayer()], state, 'S', ctx);

      expect(result.warnings).toBe(1);
      const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
      expect(ok).toBeDefined();
      expect(ok!.physicalId).toBe('phys-new');
      expect(ok!.reason).toContain('UpdateReplacePolicy: Retain');
      expect(ok!.reason).toContain('phys-new');
      expect(ok!.reason).toContain('phys-old-2');
      // The twin clause — see the readopt case for why the wording is pinned
      // and not only the ids.
      expect(ok!.reason).toContain('State records the re-created old resource (phys-old-2)');
      expect(ok!.reason).not.toContain('restored to');
      expect(ok!.provisionedBy).toBe(SURVIVOR_LAYER);
      expect(ok!.provisionedBy).not.toBe(OP_LAYER);
    });

    it('reverse-replacement WITHOUT retention: neither field is set, layer stays the OP\'s', async () => {
      // Finding 1 of the security round: the un-gate negative existed only for
      // the READOPT site, so un-gating the reverse-replacement gate ALONE left
      // the whole unit suite green — its only fence would have been the
      // real-AWS fixture's control rows, behind a 14-day TTL. This is the
      // missing half; the two negatives are per-site on purpose.
      const del = vi.fn().mockResolvedValue(undefined);
      const { ctx } = makeCtx({
        create: vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' }),
        delete: del,
      });
      const events = captureEvents(ctx);
      const state: Record<string, ResourceState> = {
        // Same layer split as the retain cases, so this is a real negative for
        // the layer too.
        B: res({ physicalId: 'phys-new', properties: { a: 2 }, provisionedBy: SURVIVOR_LAYER }),
      };

      const result = await replayRollback([opWithLayer()], state, 'S', ctx);

      // The new copy was DELETED on this path — the precondition that makes
      // publishing its id wrong.
      expect(del).toHaveBeenCalledTimes(1);
      expect(result.warnings).toBe(0);
      const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
      expect(ok).toBeDefined();
      expect(ok!.physicalId).toBeUndefined();
      expect(ok!.reason).toBeUndefined();
      expect(ok!.provisionedBy).toBe(OP_LAYER);
    });

    it('reports the OP\'s layer when the survivor record predates provisionedBy', async () => {
      // A pre-v7 survivor record carries no layer. What this pins is the
      // UNCONDITIONAL `op.provisionedBy` spread on the event: with no record
      // layer the survivor override does not fire, so that spread is the only
      // thing left putting a layer on a row that now carries a physical id.
      //
      // It deliberately does NOT pin a `?? op.provisionedBy` fallback -- an
      // earlier revision had one and the probe proved it DEAD (removing it
      // changed no emitted value, because the spread already produced exactly
      // that answer). The fallback is gone; this case is what covers the
      // behaviour it was meant to provide.
      const { ctx } = makeCtx({ create: vi.fn(), delete: vi.fn() });
      const events = captureEvents(ctx);
      const state: Record<string, ResourceState> = {
        B: res({
          physicalId: 'phys-new',
          properties: { a: 2 },
          updateReplacePolicy: 'Retain',
          // provisionedBy deliberately ABSENT.
        }),
      };

      const result = await replayRollback([opWithLayer(true)], state, 'S', ctx);

      expect(result.warnings).toBe(1);
      const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
      expect(ok!.physicalId).toBe('phys-new');
      // Not undefined, and not dropped: the op's layer is the only answer left.
      expect(ok!.provisionedBy).toBe(OP_LAYER);
    });

    it('a delete-new that FAILS publishes the survivor too (same class, pre-existing)', async () => {
      // Finding 3: state already points at the re-created OLD resource, the new
      // copy is alive and untracked, and its id went only to `logger.warn` —
      // the event emitted with the reason binding still `undefined`, so
      // `cdkd events` showed a clean SUCCEEDED naming nothing. An orphan by
      // OUTCOME rather than by policy, so no `Retain` on the record here.
      const del = vi.fn().mockRejectedValue(new Error('AccessDenied: cannot delete'));
      const { ctx } = makeCtx({
        create: vi.fn().mockResolvedValue({ physicalId: 'phys-old-2' }),
        delete: del,
      });
      const events = captureEvents(ctx);
      const state: Record<string, ResourceState> = {
        B: res({ physicalId: 'phys-new', properties: { a: 2 }, provisionedBy: SURVIVOR_LAYER }),
      };

      const result = await replayRollback([opWithLayer()], state, 'S', ctx);

      expect(del).toHaveBeenCalledTimes(1);
      expect(result.warnings).toBe(1);
      const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
      expect(ok!.physicalId).toBe('phys-new');
      expect(ok!.reason).toContain('could not be deleted');
      expect(ok!.reason).toContain('AccessDenied: cannot delete');
      // The survivor's layer, as on the Retain arms.
      expect(ok!.provisionedBy).toBe(SURVIVOR_LAYER);
      // State still names the re-created OLD resource — the survivor is the
      // one the event had to carry.
      expect(state.B!.physicalId).toBe('phys-old-2');
    });

    it('WITHOUT retention neither field is set — the id would name a DELETED resource', async () => {
      // The polarity that makes the two cases above discriminate, and a real
      // hazard on its own: an unconditional `physicalId: current.physicalId`
      // would point a cleanup pass at the copy this rollback just deleted.
      const del = vi.fn().mockResolvedValue(undefined);
      const { ctx } = makeCtx({ create: vi.fn(), delete: del });
      const events = captureEvents(ctx);
      const state: Record<string, ResourceState> = {
        // Same layer split as the retain cases, so this is a real negative for
        // the layer too and not merely a fixture where both happen to agree.
        B: res({ physicalId: 'phys-new', properties: { a: 2 }, provisionedBy: SURVIVOR_LAYER }),
      };

      const result = await replayRollback([opWithLayer(true)], state, 'S', ctx);

      expect(del).toHaveBeenCalledTimes(1);
      expect(result.warnings).toBe(0);
      const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
      expect(ok).toBeDefined();
      expect(ok!.physicalId).toBeUndefined();
      expect(ok!.reason).toBeUndefined();
      // The new copy was DELETED on this path, so the event describes the OP
      // and must keep reporting the OP's layer. An ungated survivor-layer
      // override would silently relabel every non-retain revert.
      expect(ok!.provisionedBy).toBe(OP_LAYER);
    });
  });

  describe('the plan preview cannot promise a delete the replay will skip', () => {
    it('flags the retention on both replacement actions and nowhere else', () => {
      const state: Record<string, ResourceState> = {
        Reverse: res({
          physicalId: 'phys-new',
          properties: { a: 2 },
          updateReplacePolicy: 'Retain',
        }),
        Readopt: res({
          physicalId: 'r-new',
          properties: { a: 2 },
          updateReplacePolicy: 'Retain',
        }),
        // A rolled-back CREATE carrying the same attribute: its disposal is
        // governed by `DeletionPolicy`, so the replacement flag must stay
        // false or the preview annotates a row the flag decides nothing on.
        Created: res({ physicalId: 'c-new', updateReplacePolicy: 'Retain' }),
      };
      const ops: CompletedOperation[] = [
        {
          logicalId: 'Reverse',
          changeType: 'UPDATE',
          resourceType: 'AWS::SQS::Queue',
          physicalId: 'phys-new',
          previousState: res({ physicalId: 'phys-old', properties: { a: 1 } }),
        },
        {
          logicalId: 'Readopt',
          changeType: 'UPDATE',
          resourceType: 'AWS::SQS::Queue',
          physicalId: 'r-new',
          previousState: res({ physicalId: 'r-old', properties: { a: 1 } }),
          oldResourceRetained: true,
        },
        {
          logicalId: 'Created',
          changeType: 'CREATE',
          resourceType: 'AWS::SQS::Queue',
          physicalId: 'c-new',
        },
      ];

      const byId = new Map(planRollback(ops, state).map((i) => [i.op.logicalId, i]));

      expect(byId.get('Reverse')?.action).toBe('reverse-replacement');
      expect(byId.get('Reverse')?.retainsNewResource).toBe(true);
      expect(byId.get('Readopt')?.action).toBe('reverse-replacement-readopt');
      expect(byId.get('Readopt')?.retainsNewResource).toBe(true);
      expect(byId.get('Created')?.action).toBe('delete');
      expect(byId.get('Created')?.retainsNewResource).toBe(false);
    });
  });
});
