/**
 * The drain BUDGET for one intrinsic resolution (issue
 * [#2563](https://github.com/go-to-k/cdkd/issues/2563)).
 *
 * Its own module rather than a corner of `intrinsic-function-resolver.ts`,
 * and that is forced rather than tidy: 70+ unit files `vi.mock` the resolver
 * module, and the ones that REPLACE its exports rather than spreading
 * `...actual` see no new export -- so an opener declared there, whether as a
 * resolver method or as a module-level function, reddens most of
 * `tests/unit/deployment` the moment `deploy-engine.ts` imports it (measured,
 * both ways). A module the engine and the resolver both import, and nobody
 * mocks, is the shape that works.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The drain wait LEFT in one budget: whoever opens it -- an
 * `IntrinsicFunctionResolver.resolve` call, or a caller wrapping a whole loop
 * of them in {@link withSharedDrainBudget} -- gets a store that every drain
 * underneath reads. Two independently opened budgets never see each other's
 * remainder; everything under ONE open budget deliberately shares it,
 * including nested drains and, when a caller wraps a loop, its iterations.
 * `waiting` and `since` exist so only real WAITING spends it, and only once
 * for waits that overlap.
 *
 * Why an async-context store and NOT a map keyed by the resolver context,
 * which was the first shape here: a context is not one resolution. Two
 * `resolve` calls can run concurrently against the same context object — the
 * engine holds one per pass — and they would then share a budget whether or
 * not the caller asked for that, so the second would inherit an expiry the
 * first had already spent and skip its own wait entirely (measured on review:
 * with an 80 ms cap the second resolution waited 19 ms and returned before
 * its 45 ms sibling recorded). The same keying also leaked across SEQUENTIAL
 * reuse, because a nested drain left waiting on parts that never settle never
 * releases its refcount. A store has neither failure: sharing is what the
 * CALLER opts into by wrapping, and there is nothing to release.
 *
 * A drain reached WITHOUT a store — anything calling the private resolvers
 * directly — falls back to its own budget, which is the old per-invocation
 * behaviour and never shorter than it should be.
 */
export interface DrainBudget {
  /** Milliseconds of drain WAIT left, undefined until the first rejection. */
  remaining: number | undefined;
  /** How many drains under this budget are waiting right now. */
  waiting: number;
  /** When the outermost of those started waiting; undefined when none is. */
  since: number | undefined;
}

/**
 * Named `drainDeadlines` from when it held one, and kept because the name is
 * cited from several comments and a rename is churn this issue does not need.
 * It holds a {@link DrainBudget} -- remaining WAIT, not an instant.
 */
export const drainDeadlines = new AsyncLocalStorage<DrainBudget>();

/**
 * Run `fn` under ONE drain budget (issue #2563), inheriting the caller's if
 * there is one.
 *
 * A module-level function rather than a resolver METHOD, deliberately: the
 * engine's callers mock the resolver wholesale, and a new method on that
 * surface would make every such mock throw before it resolved anything
 * (measured -- most of `tests/unit/deployment` red).
 *
 * Why a caller needs this. `resolve` opens a budget per CALL, and a caller
 * that resolves in a LOOP therefore gets one cap per iteration: the outputs
 * pass walks `template.Outputs` sequentially, so the DRAIN WAIT it could
 * spend before `saveState`, with the S3 lock held, was `#outputs x` the cap
 * rather than the cap. CloudFormation allows 200 outputs. Wrapping the loop
 * here bounds the total drain WAIT under it at one budget.
 *
 * The budget is REMAINING milliseconds of wait, not a deadline, and that
 * distinction is the whole of it: an absolute deadline is spent by wall
 * clock, so ordinary resolution time between drains burns it although
 * nothing drained -- an output failing with a 5 ms sibling would leave a
 * later one with zero grace after 60 s of clean AWS work. Charged only while
 * a drain is actually waiting, and only once for nested drains whose waits
 * overlap, an iteration that spent nothing keeps its full grace.
 *
 * WHAT IT DOES NOT BOUND, since the cap is not a deadline on the pass: the
 * cap is armed by a REJECTION and bounds only the extra wait a drain takes
 * after one. Ordinary resolution time is outside it entirely -- a lookup
 * that hangs with no sibling rejection anywhere is unbounded here exactly
 * as it was before this issue, and `withResourceDeadline` does not reach
 * the outputs pass. So this wrap bounds aggregate drain grace, not the
 * hold.
 *
 * THE TRADE, stated because it is real: iterations that actually WAIT spend
 * the shared budget, so a later one can find it exhausted and its drain get
 * no grace. That is the same exposure issue
 * [#2814](https://github.com/go-to-k/cdkd/issues/2814) records for nesting,
 * now reachable across a loop as well -- and on the `Export.Name` leg the
 * cost is a DROPPED write rather than a late one, since that block's
 * `nameSecrets` is a per-iteration local. What bounds it is that only real
 * waiting spends the budget: reaching zero takes a full cap of drain wait
 * inside one pass, not merely a slow pass. It is taken deliberately -- an
 * unbounded hold on a deploy's state save costs a first deploy every
 * resource it just created -- and the caller chooses, since a loop that
 * would rather buy grace per iteration simply does not wrap.
 *
 * `evaluateConditions` deliberately does NOT wrap its loop: a failed
 * condition is downgraded and evaluation continues, it runs before any
 * resource is provisioned, and one condition's slow parts should
 * not spend the next one's budget. Its aggregate is `#conditions x` the cap,
 * with the deploy lock already held -- less severe than the outputs pass,
 * where the state save is the thing waiting, but not lock-free.
 *
 * The other resolve LOOPS in the tree, assessed rather than assumed -- and
 * the first version of this note got two of them wrong, so each is stated
 * with what was checked:
 *
 * - `cdkd scrub` (`scrub.ts`): lock acquired above, `saveState` downstream,
 *   and its resolve loops -- the resources loop, two output loops, and
 *   `resolveCrossStackReads`, a per-leaf loop the other three each invoke.
 *   One budget is hoisted over all of them. That wrap is INLINE rather than
 *   around a callee, so the callee-keyed table in
 *   `intrinsic-resolver-concurrent-drain.test.ts` cannot see it; an
 *   owner-keyed case in that same file fences it instead.
 * - `cdkd import` (`import.ts`): `acquireLock` at the root and per child,
 *   `resolveImportedProperties` loops the resources, `saveState` follows.
 *   WRAPPED at both call sites.
 * - `cdkd export` (`export.ts`): child locks acquired before
 *   `buildResolvedParametersPerStack`, which loops `resolve` over the
 *   intrinsic parameters. WRAPPED.
 * - `diff-recursive.ts`: loops `resolve` over a parent's parameters with no
 *   lock and no state write -- a read-only diff. LEFT per-call, since a
 *   shared budget would buy no safety and would spend one resolution's
 *   grace on the next.
 *
 * The drain is what issue #2563 adds, so the wait in all four is new and
 * bounding it where it can hold something is part of adding it.
 */
export async function withSharedDrainBudget<T>(fn: () => Promise<T>): Promise<T> {
  // A caller already INSIDE a budget keeps it rather than opening a fresh
  // one, which is what makes the aggregate bound hold: without this, the
  // per-output `resolve` inside a wrapped loop would open a fresh budget at
  // every iteration and the wrap would buy nothing.
  const open = drainDeadlines.getStore();
  if (open !== undefined) return await fn();
  return await drainDeadlines.run({ remaining: undefined, waiting: 0, since: undefined }, fn);
}
