import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// `typescript-v6`, the alias the repo's other AST fences use: TS7 ships the
// stable compiler API only under `typescript/unstable/*`.
import ts from 'typescript-v6';

/**
 * A concurrent resolution must not surface a part's rejection until every part
 * it started has SETTLED (issue
 * [#2563](https://github.com/go-to-k/cdkd/issues/2563)).
 *
 * Resolving a secret dynamic reference records `plaintext -> expression` into
 * `context.recordedSecretValues` just before its promise settles, and that map
 * is the needle set every masking and redaction site downstream reads. Under a
 * bare `Promise.all` a rejecting part surfaces at once, so a caller's `catch` /
 * `finally` can run while a sibling is still in flight — `DeployEngine`'s
 * `Export.Name` block copies its private map into the pass map in exactly such
 * a `finally`, and a recording that lands afterwards reaches nothing.
 *
 * WHY THE SEAM IS THE SDK CLIENT, NOT A FAKE RESOLVER. The property under test
 * is the resolver's own concurrency, so a mocked resolver cannot discriminate:
 * it behaves identically before and after the fix.
 * `deploy-engine-outputs-export-name-collision.test.ts` replaces the resolver
 * wholesale and therefore pins the CONSUMER side only. Here the Secrets Manager
 * client is faked and each lookup is held or failed BY SECRET ID from the test
 * body, so one part can be kept in flight while another rejects — which is what
 * fails on the pre-fix `Promise.all`.
 *
 * Every literal below is invented for this file.
 */

const SLOW_ID = 'cdkd-drain-slow';
const FAIL_ID = 'cdkd-drain-fail';
// Deliberately NOT a superstring of FAIL_ID: `toThrow(string)` matches by
// SUBSTRING, so `cdkd-drain-fail-late` would satisfy an assertion meant for
// `cdkd-drain-fail` and the input-order case below would pass vacuously
// (measured: it did, against an `allSettled` + first-rejected-ENTRY mutant).
const FAIL_LATE_ID = 'cdkd-drain-tardy';
/** The failure that sits one nesting level DOWN, inside a list part. */
const FAIL_DEEP_ID = 'cdkd-drain-inner';
/** One never-settling sibling per nesting level, so every level has a wait. */
const HANG_IDS = ['cdkd-drain-hang-a', 'cdkd-drain-hang-b', 'cdkd-drain-hang-c'];
const ref = (id: string): string => `{{resolve:secretsmanager:${id}:SecretString:password}}`;
const valueOf = (id: string): string => `${id}-plaintext`;

/**
 * Per-secret-id control over the fake client, mutated by each test body.
 * `vi.hoisted` because the `vi.mock` factory below is hoisted above the
 * imports and closes over it.
 */
const control = vi.hoisted(() => ({
  /** Lookups that wait for a gate the test opens: id -> promise to await. */
  holds: new Map<string, Promise<void>>(),
  /** Lookups that reject once they get past any hold. */
  fails: new Set<string>(),
  /** Of those, the ones that reject with `undefined` rather than an Error. */
  rejectsWithUndefined: new Set<string>(),
  /** Lookups that answer only after a real timer, so a sibling rejects first. */
  delays: new Map<string, number>(),
  /** Lookups that never settle at all — the hang the cap exists to bound. */
  hangs: new Set<string>(),
  /** What happened, in the order it happened. */
  events: [] as string[],
}));

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: { input?: { SecretId?: string }; constructor: { name: string } }): Promise<unknown> {
      if (command.constructor.name !== 'GetSecretValueCommand') {
        throw new Error(`unexpected Secrets Manager command ${command.constructor.name}`);
      }
      const id = command.input?.SecretId ?? '<none>';
      if (control.hangs.has(id)) await new Promise<never>(() => {});
      const hold = control.holds.get(id);
      if (hold) await hold;
      const delay = control.delays.get(id);
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
      if (control.fails.has(id)) {
        control.events.push(`reject:${id}`);
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (control.rejectsWithUndefined.has(id)) throw undefined;
        const error = new Error(`refused ${id}`);
        error.name = 'ResourceNotFoundException';
        throw error;
      }
      control.events.push(`record:${id}`);
      return { SecretString: JSON.stringify({ password: valueOf(id) }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));
// The engine case below reaches `getCreateOnlyPropertyPaths`, which fires a
// detached CloudFormation `DescribeType`. It is green today only because the
// case finishes first; on a loaded runner it trips the file's network fence
// and masks the real assertion.
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeCloudFormationClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      throw new Error('cloudformation is not modelled in this file');
    }
    destroy(): void {}
  }
  return { ...actual, CloudFormationClient: FakeCloudFormationClient };
});

import {
  IntrinsicFunctionResolver,
  concurrentDrainCap,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { withSharedDrainBudget } from '../../../src/deployment/drain-budget.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-function-resolver.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/** A promise the test body opens by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Let every already-queued microtask and timer callback run. */
const settleTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeContext(): ResolverContext & { recordedSecretValues: Map<string, string> } {
  return {
    template: { Resources: {} },
    resources: {},
    recordedSecretValues: new Map<string, string>(),
  } as unknown as ResolverContext & { recordedSecretValues: Map<string, string> };
}

/** Track settlement without awaiting, so "still pending" is observable. */
function watch<T>(promise: Promise<T>): { state: () => 'pending' | 'fulfilled' | 'rejected'; error: () => unknown } {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  let error: unknown;
  promise.then(
    () => {
      state = 'fulfilled';
    },
    (reason: unknown) => {
      state = 'rejected';
      error = reason;
    }
  );
  return { state: () => state, error: () => error };
}

// FILE scope, not inside the first `describe`: with it scoped there, the
// engine describe below inherited whatever the previous case left in
// `control` — measured, a case that fails before opening its gate left the
// engine case waiting on it, so one regression corrupted an unrelated
// verdict.
beforeEach(() => {
  control.holds.clear();
  control.fails.clear();
  control.rejectsWithUndefined.clear();
  control.delays.clear();
  control.hangs.clear();
  control.events.length = 0;
  delete concurrentDrainCap.ms;
});

// ALSO after: `beforeEach` alone leaves the last case's cap set for whatever
// runs next in this worker.
afterEach(() => {
  delete concurrentDrainCap.ms;
});

describe('a concurrent resolution drains every part before a rejection surfaces (issue #2563)', () => {
  it("Fn::Join: a sibling's recording lands before the rejection reaches the caller", async () => {
    const held = gate();
    control.holds.set(SLOW_ID, held.promise);
    control.fails.add(FAIL_ID);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    const pending = resolver.resolve({ 'Fn::Join': ['-', [ref(SLOW_ID), ref(FAIL_ID)]] }, context);
    const seen = watch(pending);

    // THE DISCRIMINATOR. The failing part has already rejected by now; under
    // the pre-fix `Promise.all` the join's promise is rejected here and the
    // caller's `catch` / `finally` has run, while the held part has recorded
    // nothing.
    await settleTurn();
    expect(control.events).toContain(`reject:${FAIL_ID}`);
    expect(seen.state(), 'the rejection must not surface while a sibling is in flight').toBe('pending');
    expect(context.recordedSecretValues.size, 'the held part has not recorded yet').toBe(0);

    held.open();
    await expect(pending).rejects.toThrow(`refused ${FAIL_ID}`);

    // ...and by the time it does surface, the sibling's recording is in the
    // map the caller is about to copy or read.
    expect(context.recordedSecretValues.get(valueOf(SLOW_ID))).toBe(ref(SLOW_ID));
    expect(control.events.indexOf(`record:${SLOW_ID}`)).toBeGreaterThan(-1);
  });

  it('Fn::Join: the surfaced error is the one that rejected FIRST IN TIME, not first in input order', async () => {
    // Pins the constraint the drain must not break. A drain built as
    // `Promise.allSettled` plus "the first rejected entry" selects by INPUT
    // order and would report the LATE one here; `Promise.all` and this helper
    // both report the early one.
    const held = gate();
    control.holds.set(FAIL_LATE_ID, held.promise);
    control.fails.add(FAIL_LATE_ID);
    control.fails.add(FAIL_ID);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    const pending = resolver.resolve(
      { 'Fn::Join': ['-', [ref(FAIL_LATE_ID), ref(FAIL_ID)]] },
      context
    );
    const seen = watch(pending);
    await settleTurn();
    expect(seen.state(), 'held: the late rejecter has not settled').toBe('pending');
    held.open();

    // The WHOLE message, not a substring: which of the two rejections is
    // reported is the entire point of the case.
    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect((error as Error).message).toBe(`refused ${FAIL_ID}`);
    expect(control.events).toEqual([`reject:${FAIL_ID}`, `reject:${FAIL_LATE_ID}`]);
  });

  it('a rejection whose reason is `undefined` still surfaces as a rejection', async () => {
    // The helper captures the reason in a WRAPPER object rather than in the
    // variable itself, which is the only reason an `undefined` reason works:
    // a "simplification" to `rejection ??= error` would treat it as "nothing
    // rejected" and RESOLVE a failed join with a bogus value. Reached through
    // the resolver rather than by calling the helper directly, because the
    // helper is module-private — a join part whose lookup rejects with
    // `undefined`.
    control.rejectsWithUndefined.add(FAIL_ID);
    control.fails.add(FAIL_ID);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    const outcome = await resolver
      .resolve({ 'Fn::Join': ['-', [ref(FAIL_ID)]] }, context)
      .then(
        (value: unknown) => ({ settled: 'fulfilled' as const, value }),
        (reason: unknown) => ({ settled: 'rejected' as const, value: reason })
      );

    expect(outcome.settled, 'an undefined reason is still a rejection').toBe('rejected');
    expect(outcome.value).toBeUndefined();
  });

  it('an empty list resolves to an empty list, with nothing to drain', async () => {
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    expect(await resolver.resolve({ 'Fn::Join': ['-', []] }, context)).toBe('');
    expect(await resolver.resolve([], context)).toEqual([]);
  });

  it('a sibling that never settles does not hold the rejection forever: the cap releases it', async () => {
    // The drain waits for a recording, but `resolveOutputs` runs after every
    // resource exists in AWS, before `saveState`, with the S3 lock held — so
    // an unbounded wait costs a deploy its state. Once a rejection is in hand
    // the remaining settles race the cap, and the recorded rejection is thrown
    // when it expires. Driven through the exported seam rather than a real
    // minute of waiting.
    concurrentDrainCap.ms = 50;
    control.hangs.add(SLOW_ID);
    control.fails.add(FAIL_ID);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    const started = Date.now();
    const pending = resolver.resolve({ 'Fn::Join': ['-', [ref(SLOW_ID), ref(FAIL_ID)]] }, context);
    const seen = watch(pending);
    await settleTurn();
    // One turn is not the cap: the rejection is held rather than surfacing at
    // once. (This alone would pass with `ms = 0` — it pins the ordering of a
    // timer against a microtask, not the wait. The elapsed check below is
    // what pins the wait.)
    expect(seen.state(), 'the rejection does not surface on the turn it happened').toBe('pending');

    await expect(pending).rejects.toThrow(`refused ${FAIL_ID}`);
    expect(Date.now() - started, 'the drain waited the cap out').toBeGreaterThanOrEqual(45);
    // The hung part never recorded, which is the price the cap accepts.
    expect(context.recordedSecretValues.size).toBe(0);
  });

  it('the cap is one budget for the whole resolution, not one per nesting level', async () => {
    // Each nested drain used to arm its own cap, so an outer drain waited on
    // an inner one that was itself waiting a full cap: measured linear in
    // depth. `resolveOutputs` holds the S3 lock and the state save for that
    // whole time, so depth x 60 s is the wrong bound to offer. The first
    // rejection anywhere opens ONE budget for the resolution and every drain
    // under it spends the same remaining wait.
    concurrentDrainCap.ms = 60;
    for (const id of HANG_IDS) control.hangs.add(id);
    control.fails.add(FAIL_DEEP_ID);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    // A never-settling sibling at EVERY level, so every level has something
    // to wait for: without that the outer drains have nothing pending once
    // the inner one throws, and a per-invocation cap costs nothing extra.
    // Shape: join -> [hangA, [hangB, [hangC, FAIL]]].
    // Depth 1 FIRST, as the baseline: an absolute ceiling would be a bet on
    // the runner's scheduler, while a ratio against a drain measured moments
    // earlier dilates with whatever load the machine is under.
    const flatStarted = Date.now();
    await expect(
      resolver.resolve({ 'Fn::Join': ['-', [ref(HANG_IDS[0]!), ref(FAIL_DEEP_ID)]] }, context)
    ).rejects.toThrow(`refused ${FAIL_DEEP_ID}`);
    const flat = Date.now() - flatStarted;

    const started = Date.now();
    await expect(
      resolver.resolve(
        {
          'Fn::Join': [
            '-',
            [ref(HANG_IDS[0]!), [ref(HANG_IDS[1]!), [ref(HANG_IDS[2]!), ref(FAIL_DEEP_ID)]]],
          ],
        },
        context
      )
    ).rejects.toThrow(`refused ${FAIL_DEEP_ID}`);
    const elapsed = Date.now() - started;

    expect(flat, 'the baseline really waited the cap').toBeGreaterThanOrEqual(50);
    expect(elapsed, 'three levels waited the cap').toBeGreaterThanOrEqual(50);
    // Three levels of drain: per-invocation caps measured ~3 x the baseline,
    // one shared budget ~1 x. Fewer than TWO baselines is the verdict.
    expect(elapsed, 'waited it ONCE, not once per level').toBeLessThan(flat * 2);
  });

  it('the cap timer is cleared on the way out, and the budget is released with it', async () => {
    // Two leaks a passing suite would not show: a timer nobody clears (the
    // process is held open for the rest of the cap, and vitest's own loop
    // hides it), and a budget left open across resolutions (the NEXT failure
    // would then drain against the FIRST call's remainder instead of its own
    // cap -- longer here, since this first call barely waits at all).
    const firstCap = 400;
    concurrentDrainCap.ms = firstCap;
    const cleared: unknown[] = [];
    const realClear = globalThis.clearTimeout;
    const spy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(((id: never) => {
        cleared.push(id);
        return realClear(id);
      }) as typeof globalThis.clearTimeout);
    try {
      // The sibling is RELEASED long before the cap, so the timer being
      // cleared is a LIVE one. Asserting the clear after an expiry would hold
      // just as well for code that only ever cleared expired timers, which
      // is the leak worth pinning.
      const held = gate();
      control.holds.set(SLOW_ID, held.promise);
      control.fails.add(FAIL_ID);
      const context = makeContext();
      const resolver = new IntrinsicFunctionResolver('us-east-1');

      const before = cleared.length;
      const started = Date.now();
      const pending = resolver.resolve({ 'Fn::Join': ['-', [ref(SLOW_ID), ref(FAIL_ID)]] }, context);
      void pending.catch(() => undefined);
      await settleTurn();
      held.open();
      await expect(pending).rejects.toThrow(`refused ${FAIL_ID}`);

      expect(Date.now() - started, 'released well before the cap could fire').toBeLessThan(100);
      expect(cleared.length, 'the live cap timer is cleared on the way out').toBeGreaterThan(before);

      // The SAME context again, and NO sleep between the two calls: the
      // budget holds remaining WAIT rather than an instant, so elapsed time
      // spends nothing and no sleep could make a leaked budget look spent.
      // What discriminates is the SIZE of the second wait. The first call
      // released its sibling almost at once, so a budget leaked from it --
      // kept per CONTEXT, or one module-level singleton -- still holds
      // nearly all of `firstCap`; the second drain would then wait that
      // remainder instead of its own much smaller cap. Hence the upper bound
      // below as well as the lower one: the lower alone passes under both
      // leaks (measured -- the singleton mutant is green against it).
      // A DIFFERENT id for the sibling: the resolver caches a resolved
      // dynamic reference, so reusing `SLOW_ID` here would answer from the
      // cache with nothing left to drain and the case would pin nothing.
      concurrentDrainCap.ms = 40;
      control.holds.clear();
      control.hangs.add(HANG_IDS[0]!);
      const secondStarted = Date.now();
      await expect(
        resolver.resolve({ 'Fn::Join': ['-', [ref(HANG_IDS[0]!), ref(FAIL_ID)]] }, context)
      ).rejects.toThrow(`refused ${FAIL_ID}`);
      const secondElapsed = Date.now() - secondStarted;
      expect(secondElapsed, 'the second failure took a wait of its own').toBeGreaterThanOrEqual(35);
      expect(
        secondElapsed,
        'the second failure waited its OWN cap, not a remainder leaked from the first'
      ).toBeLessThan(firstCap / 2);
    } finally {
      spy.mockRestore();
    }
  });

  it('a SLOW but successful resolution is not on the clock: the cap is armed by a rejection only', async () => {
    // The cap must measure the wait a FAILURE caused. Armed at call time
    // instead, a resolution slower than the cap would win the race with the
    // expiry sentinel while `rejection` is undefined — and the helper would
    // hand that sentinel back as if it were the resolved values.
    concurrentDrainCap.ms = 20;
    control.delays.set(SLOW_ID, 80);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    const out = await resolver.resolve({ 'Fn::Join': ['-', [ref(SLOW_ID), 'tail']] }, context);

    expect(out, 'the joined value, not a cap sentinel').toBe(`${valueOf(SLOW_ID)}-tail`);
    expect(context.recordedSecretValues.get(valueOf(SLOW_ID))).toBe(ref(SLOW_ID));
  });

  it('a TOP-LEVEL list drains too, not only one reached through a join', async () => {
    // `resolveValue`'s array arm is drained wherever it is entered. The other
    // list cases reach it through `resolveJoin`; this one calls `resolve`
    // with the array itself, so a drain applied at the join alone would not
    // cover it.
    const held = gate();
    control.holds.set(SLOW_ID, held.promise);
    control.fails.add(FAIL_ID);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    const pending = resolver.resolve([ref(SLOW_ID), ref(FAIL_ID)], context);
    const seen = watch(pending);
    await settleTurn();
    expect(seen.state(), 'the rejection waits for the held sibling').toBe('pending');
    held.open();

    await expect(pending).rejects.toThrow(`refused ${FAIL_ID}`);
    expect(
      context.recordedSecretValues?.get(valueOf(SLOW_ID)),
      "the held sibling's recording is in the map by the time the caller is reached",
    ).toBeDefined();
  });

  it('a LOOP of resolutions wrapped in one budget is bounded once, not per iteration', async () => {
    // `resolve` opens a budget per CALL, so a caller resolving in a loop got
    // one cap per iteration: the outputs pass walks `template.Outputs`
    // sequentially, and its worst-case hold before `saveState` with the S3
    // lock held was `#outputs x` the cap. `withSharedDrainBudget` is what the
    // engine wraps that loop in, and this pins that the wrap actually bounds
    // the aggregate rather than reading as though it does.
    concurrentDrainCap.ms = 60;
    control.hangs.add(HANG_IDS[0]!);
    control.hangs.add(HANG_IDS[1]!);
    control.hangs.add(HANG_IDS[2]!);
    control.fails.add(FAIL_ID);
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();

    // Three "outputs", each a join that fails beside a part that never
    // settles. Unwrapped this is 3 x the cap; wrapped it is one.
    const started = Date.now();
    await withSharedDrainBudget(async () => {
      for (const hang of HANG_IDS) {
        await resolver
          .resolve({ 'Fn::Join': ['-', [ref(hang), ref(FAIL_ID)]] }, context)
          .catch(() => undefined);
      }
    });
    const wrapped = Date.now() - started;

    // The same loop UNWRAPPED, as the baseline the wrap is measured against —
    // fresh ids so the resolver's cache cannot answer for them.
    const bareContext = makeContext();
    const bareStarted = Date.now();
    for (const hang of ['cdkd-drain-bare-a', 'cdkd-drain-bare-b', 'cdkd-drain-bare-c']) {
      control.hangs.add(hang);
      await resolver
        .resolve({ 'Fn::Join': ['-', [ref(hang), ref(FAIL_ID)]] }, bareContext)
        .catch(() => undefined);
    }
    const bare = Date.now() - bareStarted;

    expect(bare, 'the unwrapped loop pays the cap per iteration').toBeGreaterThanOrEqual(150);
    expect(wrapped, 'the wrapped loop paid it once').toBeLessThan(bare / 2);
  });

  it('ordinary resolution time between drains does not spend the shared budget', async () => {
    // The budget is REMAINING WAIT, not a deadline. Held as an absolute
    // instant it is spent by wall clock, so a wrapped loop that fails once
    // with a fast sibling and then does ordinary AWS work leaves a later
    // iteration with zero grace -- strictly worse for outputs 2..N than not
    // wrapping at all, in the direction this issue exists to fix.
    // A 1 s budget rather than 200 ms, because this case's lower bound is
    // not the usual "a timer cannot fire early" kind: it asserts what is
    // LEFT, so an event-loop stall long enough to swallow step 1's whole
    // budget would red it legitimately. Reproduced on review with a 220 ms
    // stall against a 200 ms budget. Real timers are kept -- the margin is
    // bought with a budget a stall would have to exceed by ~900 ms.
    concurrentDrainCap.ms = 1_000;
    control.delays.set(SLOW_ID, 80);
    control.fails.add(FAIL_ID);
    control.delays.set('cdkd-drain-clean', 1_200);
    control.hangs.add(HANG_IDS[0]!);
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();

    let lastWait = 0;
    await withSharedDrainBudget(async () => {
      // 1. A failure whose sibling settles in 80 ms: ~80 ms of WAIT spent,
      //    leaving ~920 of the 1000.
      await resolver
        .resolve({ 'Fn::Join': ['-', [ref(SLOW_ID), ref(FAIL_ID)]] }, context)
        .catch(() => undefined);
      // 2. Ordinary work, longer than the whole budget, with no rejection:
      //    spends nothing, because nothing drained.
      await resolver.resolve(ref('cdkd-drain-clean'), context);
      // 3. A second failure, this time against a sibling that never settles.
      const started = Date.now();
      await resolver
        .resolve({ 'Fn::Join': ['-', [ref(HANG_IDS[0]!), ref(FAIL_ID)]] }, context)
        .catch(() => undefined);
      lastWait = Date.now() - started;
    });

    // ~920 ms is correct, and a wall-clock deadline leaves it at ~0 since
    // step 2 alone outlasts the cap. Only the LOWER bound is asserted: an
    // upper one would have to sit close to the remainder to mean anything,
    // and a correct run of this case measured 3344 ms once under load. "It
    // is still charged" is covered where it can be measured robustly -- the
    // aggregate and nesting cases both red when nothing is ever charged.
    expect(lastWait, 'the last drain kept the grace the clean step did not spend').toBeGreaterThanOrEqual(300);
  });

  it('nested drains waiting CONCURRENTLY charge the budget once, not once per level', async () => {
    // The outer drain's wait CONTAINS the inner one's, so charging each level
    // would spend the shared budget once per level and re-create the
    // depth x cap shape one layer down -- the thing the shared budget exists
    // to remove. Only the outermost WAITING drain charges.
    //
    // The shape matters and a first draft of this case did not discriminate:
    // both levels need a failure of their OWN so they arm together and their
    // waits OVERLAP. With the failure only at the bottom, each level arms
    // after the one below it finished, the waits are sequential, and charging
    // once and charging per level cost the same.
    // A 600 ms budget against 200 ms waits, so the two readings are 400 and
    // 200 rather than 200 and 100: the relative bounds below stay
    // discriminating until the fixture's own timers stretch past 2x nominal,
    // where a 300/100 shape went vacuous at 1.5x (measured on review).
    concurrentDrainCap.ms = 600;
    control.delays.set('cdkd-charge-outer', 200);
    control.delays.set('cdkd-charge-inner', 200);
    control.fails.add(FAIL_ID);
    control.fails.add(FAIL_DEEP_ID);
    control.hangs.add('cdkd-charge-hung');
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();

    await withSharedDrainBudget(async () => {
      // Outer and inner both reject at once and both wait ~200 ms, together.
      const spentStart = Date.now();
      await resolver
        .resolve(
          {
            'Fn::Join': [
              '-',
              [
                ref(FAIL_ID),
                ref('cdkd-charge-outer'),
                [ref(FAIL_DEEP_ID), ref('cdkd-charge-inner')],
              ],
            ],
          },
          context
        )
        .catch(() => undefined);
      // What that overlapping wait actually cost, measured rather than
      // assumed to be the nominal 200 ms: under parallel workers the fake
      // client's timers stretch, and an absolute bound below then reds a
      // correct run (observed while this file ran beside `scrub.test.ts`).
      const spent = Date.now() - spentStart;

      // What is left decides it: about `cap - spent` if that overlapping wait
      // was charged once, about `cap - 2 x spent` if each level charged its
      // own. Both bounds are relative to the measurement, so load moves them
      // together.
      const started = Date.now();
      await resolver
        .resolve({ 'Fn::Join': ['-', [ref('cdkd-charge-hung'), ref(FAIL_ID)]] }, context)
        .catch(() => undefined);
      const left = Date.now() - started;

      expect(spent, 'the overlapping wait actually happened').toBeGreaterThanOrEqual(100);
      // Above ~2x nominal the arithmetic stops separating the two readings,
      // so say that rather than let the case pass on a machine where it
      // measured nothing.
      expect(
        spent,
        'the fixture timers stretched past 2x nominal — this case cannot measure here',
      ).toBeLessThan(420);
      expect(left, 'the overlapping wait was charged once, not twice').toBeGreaterThan(
        600 - spent * 1.4
      );
      expect(left, 'and it WAS charged -- this is not a fresh budget').toBeLessThan(
        600 - spent * 0.6
      );
    });
  });

  it('two conditions share the CALLER\'s budget when there is one, and not otherwise', async () => {
    // Both halves, because the file had only the first and `cdkd import`
    // made the second reachable by calling `evaluateConditions` inside its
    // own wrap:
    //
    //   no caller budget -> each condition gets its OWN cap. A failed
    //     condition is downgraded and evaluation continues, so one
    //     condition's slow parts must not spend the next one's.
    //   inside a caller's budget -> they SHARE it, so the caller's aggregate
    //     bound holds. `import` runs this with a lock held and `saveState`
    //     downstream.
    //
    // A version of this case that did not wrap measured identically either
    // way, which is why the wrapped half is the discriminating one.
    concurrentDrainCap.ms = 120;
    control.hangs.add('cdkd-cond-hang-a');
    control.hangs.add('cdkd-cond-hang-b');
    control.fails.add(FAIL_ID);
    const context = makeContext();
    context.template.Conditions = {
      First: {
        'Fn::Equals': [
          { 'Fn::Join': ['-', [ref('cdkd-cond-hang-a'), ref(FAIL_ID)]] },
          'never-equal',
        ],
      },
      Second: {
        'Fn::Equals': [
          { 'Fn::Join': ['-', [ref('cdkd-cond-hang-b'), ref(FAIL_ID)]] },
          'never-equal',
        ],
      },
    };
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    // INSIDE a caller's budget: the two conditions share it, so the total is
    // about one cap rather than two.
    const wrappedStart = Date.now();
    const wrapped = await withSharedDrainBudget(() => resolver.evaluateConditions(context));
    const wrappedElapsed = Date.now() - wrappedStart;

    expect(wrapped['First']).toBe(false);
    expect(wrapped['Second']).toBe(false);
    expect(wrappedElapsed, 'the conditions shared the caller budget').toBeLessThan(200);

    // NO caller budget: each condition opens its own, so the total is about
    // two caps. Fresh ids, because the resolver caches a resolved reference.
    control.hangs.add('cdkd-cond-hang-c');
    control.hangs.add('cdkd-cond-hang-d');
    const bare = makeContext();
    bare.template.Conditions = {
      First: {
        'Fn::Equals': [
          { 'Fn::Join': ['-', [ref('cdkd-cond-hang-c'), ref(FAIL_ID)]] },
          'never-equal',
        ],
      },
      Second: {
        'Fn::Equals': [
          { 'Fn::Join': ['-', [ref('cdkd-cond-hang-d'), ref(FAIL_ID)]] },
          'never-equal',
        ],
      },
    };
    const bareStart = Date.now();
    await new IntrinsicFunctionResolver('us-east-1').evaluateConditions(bare);
    expect(
      Date.now() - bareStart,
      'unwrapped, each condition got its own budget',
    ).toBeGreaterThanOrEqual(200);
  });

  it('a drain arming while another WAITS gets what is left of the open window', async () => {
    // `remaining` is charged when the last waiter leaves, so a drain arming
    // mid-window must subtract the part of that window already run. Without
    // it, two staggered drains each arm against the full remainder and keep
    // extending the bound: at a 100 ms budget, A at t=0 and B at t=80 were
    // released at 100 and 180 (measured on review).
    concurrentDrainCap.ms = 200;
    control.hangs.add('cdkd-stagger-a');
    control.hangs.add('cdkd-stagger-b');
    control.fails.add(FAIL_ID);
    control.fails.add(FAIL_DEEP_ID);
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();

    const started = Date.now();
    await withSharedDrainBudget(async () => {
      const first = resolver
        .resolve({ 'Fn::Join': ['-', [ref('cdkd-stagger-a'), ref(FAIL_ID)]] }, context)
        .catch(() => undefined);
      // Start the second one well into the first's window.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const second = resolver
        .resolve({ 'Fn::Join': ['-', [ref('cdkd-stagger-b'), ref(FAIL_DEEP_ID)]] }, context)
        .catch(() => undefined);
      await Promise.all([first, second]);
    });
    const total = Date.now() - started;

    // Both drains hang, so the budget is spent in full and no further: ~200.
    // Arming the second against the whole remainder gives ~320.
    expect(total, 'the second drain took what was LEFT of the window').toBeLessThan(280);
    expect(total, 'and the budget really was spent').toBeGreaterThanOrEqual(180);
  });

  it('a re-entrant `resolve` INHERITS the open budget instead of resetting it', async () => {
    // `ResolverContext.conditionResolver` is an optional field on the
    // EXPORTED interface, and `resolveValue` invokes it INSIDE the store
    // `resolve` opened. Nothing in cdkd sets it except `evaluateConditions`,
    // which is what leaves this unreached today — but it is a publicly
    // reachable path, and a caller that sets the hook and re-enters
    // `resolver.resolve(...)` from it lands on the inheritance branch. Without
    // that branch each level opens a FRESH budget and the bound goes back to
    // depth x cap, which is the defect the per-resolution budget removed.
    concurrentDrainCap.ms = 60;
    for (const id of HANG_IDS) control.hangs.add(id);
    control.fails.add(FAIL_DEEP_ID);
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = makeContext();

    // Depth 1 through the same path, as the load-tracking baseline.
    const flatContext = makeContext();
    flatContext.conditionResolver = async () => true;
    const flatStarted = Date.now();
    await expect(
      resolver.resolve({ 'Fn::Join': ['-', [ref(HANG_IDS[0]!), ref(FAIL_DEEP_ID)]] }, flatContext)
    ).rejects.toThrow(`refused ${FAIL_DEEP_ID}`);
    const flat = Date.now() - flatStarted;

    // Three RE-ENTRANT levels: each hook body calls `resolve` again, so the
    // budget is opened once at the top and inherited twice.
    let depth = 0;
    context.conditionResolver = async (): Promise<boolean> => {
      depth += 1;
      const inner =
        depth < 3
          ? { Condition: 'Deeper' }
          : { 'Fn::Join': ['-', [ref(HANG_IDS[2]!), ref(FAIL_DEEP_ID)]] };
      await resolver.resolve({ 'Fn::Join': ['-', [ref(HANG_IDS[depth - 1]!), inner]] }, context);
      return true;
    };

    const started = Date.now();
    await expect(resolver.resolve({ Condition: 'Top' }, context)).rejects.toThrow(
      `refused ${FAIL_DEEP_ID}`
    );
    const elapsed = Date.now() - started;

    expect(flat, 'the baseline really waited the cap').toBeGreaterThanOrEqual(50);
    // Three nested `resolve` calls. Opening a fresh budget at each measures
    // ~3 x the baseline; inheriting measures ~1 x.
    expect(elapsed, 'the re-entrant calls shared ONE budget').toBeLessThan(flat * 2);
  });

  it('a CONDITION operand gets one budget too, not one per nesting level', async () => {
    // `evaluateConditions` enters the private resolvers directly rather than
    // through `resolve`, so without its own store every nested drain under a
    // condition operand would take a fresh cap. A condition's failure is
    // downgraded to false rather than thrown, so the wait is the observable.
    concurrentDrainCap.ms = 60;
    for (const id of HANG_IDS) control.hangs.add(id);
    control.fails.add(FAIL_DEEP_ID);
    const context = makeContext();
    context.template.Conditions = {
      Deep: {
        'Fn::Equals': [
          {
            'Fn::Join': [
              '-',
              [ref(HANG_IDS[0]!), [ref(HANG_IDS[1]!), [ref(HANG_IDS[2]!), ref(FAIL_DEEP_ID)]]],
            ],
          },
          'never-equal',
        ],
      },
    };
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    // Depth 1 through the same entry point, as the load-tracking baseline.
    context.template.Conditions['Flat'] = {
      'Fn::Equals': [{ 'Fn::Join': ['-', [ref(HANG_IDS[0]!), ref(FAIL_DEEP_ID)]] }, 'never-equal'],
    };
    const flatStarted = Date.now();
    await resolver.evaluateConditions({
      ...context,
      template: { ...context.template, Conditions: { Flat: context.template.Conditions['Flat'] } },
    } as never);
    const flat = Date.now() - flatStarted;
    delete context.template.Conditions['Flat'];

    const started = Date.now();
    const conditions = await resolver.evaluateConditions(context);
    const elapsed = Date.now() - started;

    expect(conditions['Deep'], 'a failed condition is downgraded, not thrown').toBe(false);
    expect(flat, 'the baseline really waited the cap').toBeGreaterThanOrEqual(50);
    expect(elapsed, 'waited it ONCE, not once per level').toBeLessThan(flat * 2);
  });

  it('two resolutions sharing one context do not share one budget', async () => {
    // A budget keyed by the CONTEXT was the first shape here, and it is
    // wrong: the engine holds one context per pass and can have more than one
    // `resolve` in flight against it. The second call would then inherit the
    // first's budget — measured when this was keyed by context: at an 80 ms
    // cap it waited 19 ms and returned before its own sibling had recorded.
    concurrentDrainCap.ms = 140;
    control.hangs.add(HANG_IDS[0]!);
    control.fails.add(FAIL_ID);
    control.delays.set(SLOW_ID, 90);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    // First resolution: fails at once and then waits out its whole budget on
    // a part that never settles.
    const first = resolver.resolve(
      { 'Fn::Join': ['-', [ref(HANG_IDS[0]!), ref(FAIL_ID)]] },
      context
    );
    const firstSettled = watch(first);
    void first.catch(() => undefined);
    // Start the second one late enough that a SHARED budget would have only
    // 60 ms left, less than the 90 ms its own sibling needs. The first call
    // is actually WAITING for that whole 80 ms, which is what spends a
    // budget -- unlike the clear-on-the-way-out case above, where the first
    // call barely waits and a leaked budget stays nearly full. Every
    // margin here is >= 30 ms: the first is still draining at 80 of 140, a
    // shared budget misses the sibling by 30, and its own budget clears it by
    // 50. The first shape of this case was 60-of-80 against a 45 ms sibling,
    // an 11 ms margin measured under load — the tightest window in the file.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(firstSettled.state(), 'the first is still draining').toBe('pending');

    const started = Date.now();
    await expect(
      resolver.resolve({ 'Fn::Join': ['-', [ref(SLOW_ID), ref(FAIL_ID)]] }, context)
    ).rejects.toThrow(`refused ${FAIL_ID}`);

    expect(Date.now() - started, 'the second call got its own budget').toBeGreaterThanOrEqual(70);
    expect(
      context.recordedSecretValues.get(valueOf(SLOW_ID)),
      "the second call's own sibling recorded before its rejection surfaced",
    ).toBe(ref(SLOW_ID));
    await expect(first).rejects.toThrow(`refused ${FAIL_ID}`);
  });

  it('the nested rule: an inner drain holds its failure, so the SHALLOWER one is reported', async () => {
    // Consequence 2, pinned rather than only described. The inner list drains
    // around its own held sibling, so its earlier rejection is still in that
    // drain when the outer join's later one arrives — and the outer reports
    // the later, shallower failure. Pre-drain the inner rejected at once and
    // the caller saw the DEEPER one.
    const held = gate();
    control.holds.set(SLOW_ID, held.promise);
    control.fails.add(FAIL_DEEP_ID);
    control.fails.add(FAIL_ID);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    const pending = resolver.resolve(
      { 'Fn::Join': ['-', [[ref(SLOW_ID), ref(FAIL_DEEP_ID)], ref(FAIL_ID)]] },
      context
    );
    const seen = watch(pending);
    await settleTurn();
    expect(seen.state()).toBe('pending');
    held.open();

    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect((error as Error).message, 'the shallower failure is the one reported').toBe(
      `refused ${FAIL_ID}`
    );
    // The whole sequence, not only the two rejections: the deeper one really
    // does happen first, and the held sibling really does record after both —
    // which is what makes the surfaced SHALLOWER error a selection rather
    // than an accident of what had run.
    expect(control.events, 'deep rejects, shallow rejects, then the held sibling records').toEqual([
      `reject:${FAIL_DEEP_ID}`,
      `reject:${FAIL_ID}`,
      `record:${SLOW_ID}`,
    ]);
  });

  it('a LIST inside a join part drains too, which a join-level drain alone would not do', async () => {
    // `resolveValue`'s array arm is its own concurrent resolution. With only
    // `resolveJoin` drained, the inner list rejects early, the join sees its
    // single part as settled, and the held child inside the list is still in
    // flight when the caller is reached.
    const held = gate();
    control.holds.set(SLOW_ID, held.promise);
    control.fails.add(FAIL_ID);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    const pending = resolver.resolve(
      { 'Fn::Join': ['-', [[ref(SLOW_ID), ref(FAIL_ID)]]] },
      context
    );
    const seen = watch(pending);

    await settleTurn();
    expect(control.events).toContain(`reject:${FAIL_ID}`);
    expect(seen.state(), 'the inner list must drain before its rejection surfaces').toBe('pending');

    held.open();
    await expect(pending).rejects.toThrow(`refused ${FAIL_ID}`);
    expect(context.recordedSecretValues.get(valueOf(SLOW_ID))).toBe(ref(SLOW_ID));
  });
});

describe('the drain covers every concurrent site the resolver has (issue #2563)', () => {
  it('every public member that can reach a drain opens a budget store', () => {
    // The concurrency fence below pins WHERE a drain starts. This one pins
    // that every way IN opens a budget first, which is the property the
    // per-resolution cap rests on: a new public method calling
    // `this.resolveValue` directly -- exactly what `evaluateConditions`
    // does -- would take the helper's no-store fallback, and a 4-deep
    // template would hold `saveState` for 4 x the cap with the S3 lock in
    // hand. Every other case in this file would stay green.
    //
    // A SYNTACTIC regression check, not a proof of coverage: it asks whether
    // a public reacher opens a budget somewhere in its body, not whether the
    // resolution runs inside it, so `run(() => undefined)` beside a bare
    // `this.resolveValue(...)` passes. What it catches is the realistic
    // shape -- a new way in that opens no budget at all.
    //
    // Reachability follows exactly ONE edge shape: a `this.<identifier>(...)`
    // call, from methods and callable fields, transitively to a fixed point.
    // That is the weak half of this case and it is stated as such -- a first
    // cut that looked one level deep at methods alone stayed green under
    // three real shapes (measured), and the current walk is still green under
    // these, all measured rather than reasoned:
    //
    //   const self = this; self.resolveValue(...)      // aliased receiver
    //   this.resolveValue.bind(this)                   // no call node
    //   this['resolveValue'](...)                      // element access
    //   a public getter returning a closure over it
    //   a static method reaching through a parameter
    //   an exported module-level function calling a private resolver
    //   a second declaration of a public reacher's NAME (the members map is
    //     keyed by bare name file-wide, so the later one wins)
    //   a `#private` hop -- `public -> this.#hop() -> this.resolveValue()` --
    //     since collection requires `ts.isIdentifier(name)` and a
    //     `PrivateIdentifier` member is never collected, so the edge dangles
    //   a `drainDeadlines.run` in a branch that does not cover the call
    //
    // The seeds themselves are seeds rather than exemptions, so making
    // `resolveValue` or `resolveJoin` public reds too -- an outside caller of
    // one gets no store.
    const file = join(import.meta.dirname, '../../../src/deployment/intrinsic-function-resolver.ts');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

    // DERIVED from the call sites of `allSettledKeepingFirstRejection`, not
    // named: a new public method that fans out through the blessed helper
    // itself -- the one shape this file's design actively invites -- is a
    // drain neither fence saw while the seeds were a literal pair. The
    // equality assertion below is what makes a third call site announce
    // itself rather than silently widening the seed set.
    const HELPER = 'allSettledKeepingFirstRejection';
    const drainSeeds = new Set<string>();
    const unowned: string[] = [];
    const seedWalk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === HELPER) {
        let owner: string | undefined;
        let inHelper = false;
        // Walk OUT through nested functions rather than stopping at the first
        // one: a call inside a local helper function declared in a method is
        // still that method's call site. Only the helper's OWN declaration is
        // exempt, by name, so its recursive shape is not a seed of itself.
        for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
          if (ts.isFunctionDeclaration(n) && n.name?.text === HELPER) {
            inHelper = true;
            break;
          }
          if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) {
            owner = n.name.text;
            break;
          }
          if (ts.isPropertyDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
            owner = n.name.text;
            break;
          }
        }
        // A call at module scope, or anywhere else this walk cannot attribute,
        // must FAIL rather than vanish -- an unattributed site is exactly the
        // silent third site the derivation exists to stop.
        if (!inHelper) {
          if (owner === undefined) unowned.push(node.getText().slice(0, 60));
          else drainSeeds.add(owner);
        }
      }
      ts.forEachChild(node, seedWalk);
    };
    seedWalk(sf);
    expect(
      unowned,
      `a call to ${HELPER} that this walk cannot attribute to a method or callable field — ` +
        'give it one, or teach the walk the shape',
    ).toEqual([]);
    // Like the sibling `Promise` fence's `const P = Promise` caveat: this
    // finds DIRECT calls only, so `const alias = allSettledKeepingFirstRejection;
    // alias(...)` is a call site it does not see.
    expect(
      [...drainSeeds].sort(),
      `a new DIRECT call site of ${HELPER} — fence it, then add it here ` +
        '(an aliased call is not seen; see the comment above)',
    ).toEqual(['resolveJoin', 'resolveValue']);
    const DRAIN_SEEDS = [...drainSeeds];
    interface Member {
      readonly name: string;
      readonly isPublic: boolean;
      readonly calls: Set<string>;
      readonly opensBudget: boolean;
    }
    const members = new Map<string, Member>();

    const bodyFacts = (node: ts.Node): { calls: Set<string>; opensBudget: boolean } => {
      const calls = new Set<string>();
      let opensBudget = false;
      const visit = (n: ts.Node): void => {
        // A bare call to the opener imported from `drain-budget.ts` counts,
        // which is how `resolve` opens its budget.
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'withSharedDrainBudget') {
          opensBudget = true;
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const target = n.expression.expression;
          const name = n.expression.name.getText();
          if (target.kind === ts.SyntaxKind.ThisKeyword) calls.add(name);
          if (target.getText() === 'drainDeadlines' && name === 'run') opensBudget = true;

        }
        ts.forEachChild(n, visit);
      };
      visit(node);
      return { calls, opensBudget };
    };

    const collect = (node: ts.Node): void => {
      const isHidden = (mods: ts.NodeArray<ts.ModifierLike> | undefined): boolean =>
        mods?.some(
          (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
        ) === true;
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        const { calls, opensBudget } = bodyFacts(node);
        members.set(node.name.text, {
          name: node.name.text,
          isPublic: !isHidden(node.modifiers),
          calls,
          opensBudget,
        });
      }
      // A callable FIELD is an entry point too: `readonly foo = async () => ...`
      if (
        ts.isPropertyDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        const { calls, opensBudget } = bodyFacts(node.initializer);
        members.set(node.name.text, {
          name: node.name.text,
          isPublic: !isHidden(node.modifiers),
          calls,
          opensBudget,
        });
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);

    expect(
      DRAIN_SEEDS.every((seed) => members.has(seed)),
      'the walk found neither drain seed — it is matching nothing and would pass vacuously',
    ).toBe(true);

    // Transitive closure over `this.x(...)` edges, seeded at the two members
    // that own the wrapped concurrent sites.
    const reaches = new Set<string>(DRAIN_SEEDS);
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of members.values()) {
        if (reaches.has(m.name)) continue;
        if ([...m.calls].some((c) => reaches.has(c))) {
          reaches.add(m.name);
          grew = true;
        }
      }
    }

    // Opening a budget counts inline `drainDeadlines.run` and a direct call
    // to the module-level `withSharedDrainBudget`, and nothing else --
    // `resolve` delegates to that helper rather than opening inline, and this
    // case red on exactly that refactor, which is the fence doing its job.
    //
    // Deliberately NOT transitive, unlike reachability. A closure over
    // arbitrary `this.x(...)` edges credits a member for calling an opener on
    // a path the drain never takes: make `resolveJoin` public and change its
    // `values = await this.resolveValue(...)` normalisation to `this.resolve`
    // and the closure marks BOTH seeds guarded, though a literal-array join
    // never runs that line (measured). One hop to a known opener is a claim
    // the walk can actually support.
    const opens = new Set<string>(
      [...members.values()].filter((m) => m.opensBudget).map((m) => m.name)
    );

    // Guarded means: the member opens a budget ITSELF -- inline
    // `drainDeadlines.run`, or a direct call to `withSharedDrainBudget`. Not
    // "or delegates to one that does": `opens` above is direct-only, so a
    // public member that loops over `await this.resolve(...)` is reported
    // unguarded even though every iteration opens a budget. That is a FALSE
    // POSITIVE and it is the price of not being transitive, which is the
    // right trade here (a closure credits a member for calling an opener on
    // a path the drain never takes) but should not be described as something
    // it is not. Lexical containment is
    // the stricter reading and `evaluateConditions` legitimately fails it —
    // it reaches the resolver through a local arrow and opens the store
    // around the CALL to that arrow — so this asks the weaker question, which
    // still reds the shape worth catching: a public way in that opens no
    // budget at all.
    const unguarded = [...members.values()]
      .filter((m) => m.isPublic && reaches.has(m.name) && !opens.has(m.name))
      .map((m) => m.name)
      .sort();

    expect(
      [...reaches],
      'the two known entry points must be among the reachers',
    ).toEqual(expect.arrayContaining(['resolve', 'evaluateConditions']));
    expect(
      unguarded,
      'a public member reaches a drain without opening a budget — wrap it in ' +
        '`withSharedDrainBudget`, or the cap goes back to depth x 60 s for anything reached ' +
        'through it. This fence accepts `drainDeadlines.run` too, since either opens a ' +
        'budget; WHICH one is right is behavioural, and the conditions case is what ' +
        'discriminates it (`run` always installs a FRESH store, so it buys nothing inside a ' +
        'caller that already wrapped a loop)',
    ).toEqual([]);
  });

  it('the resolver starts no concurrent resolution outside the wrapped helper', () => {
    // The engine comments now rest on "these are the only two concurrent
    // sites" in a file of this size. Asserted rather than believed, and by
    // PARSING rather than by counting text: a comment mentioning
    // `Promise.all(` would red a text scan, and `Promise.all<unknown>([])`
    // would escape it. Each call is located by its enclosing function, so a
    // third site added later names itself here instead of silently escaping
    // the drain.
    //
    // What this does NOT catch, stated so the assertion is not read as more
    // than it is, and measured rather than guessed: a combinator reached
    // through an alias (`const P = Promise; P.all(...)`), a qualified
    // spelling (`globalThis.Promise.all`), a computed key that is not a
    // string literal, or a hand-rolled fan-out (`map` + sequential `await`). It fences calls written on an identifier named `Promise`,
    // by property or by string-literal index, which is the spelling a later
    // edit actually reaches for — and the failure message says so rather
    // than claiming to have proved the absence of concurrency.
    const CONCURRENCY_COMBINATORS = new Set(['all', 'allSettled', 'any', 'race']);
    const file = join(import.meta.dirname, '../../../src/deployment/intrinsic-function-resolver.ts');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found: { api: string; inside: string }[] = [];
    const enclosing = (node: ts.Node): string => {
      for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) return n.name?.getText() ?? '<anonymous>';
      }
      return '<top level>';
    };
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
      ) {
        const target = node.expression.expression.getText();
        const api = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.getText()
          : ts.isStringLiteralLike(node.expression.argumentExpression)
            ? node.expression.argumentExpression.text
            : '<computed>';
        // Every combinator that starts work concurrently, not only the two
        // this file uses: `any` and `allSettled` are the two shapes a later
        // edit would most plausibly reach for, and both escape the drain.
        if (target === 'Promise' && CONCURRENCY_COMBINATORS.has(api)) {
          found.push({ api, inside: enclosing(node) });
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);

    // Sorted, so the assertion pins WHICH calls exist and where, not the
    // order a tree walk happens to reach them (the `race` encloses the
    // `all`, so source order is not alphabetical).
    expect(
      [...found].sort((a, b) => a.api.localeCompare(b.api)),
      'a Promise combinator written directly on `Promise` outside ' +
        'allSettledKeepingFirstRejection escapes the drain — wrap it (aliases and ' +
        'hand-rolled fan-outs are NOT fenced here; see the comment above)',
    ).toEqual([
      { api: 'all', inside: 'allSettledKeepingFirstRejection' },
      { api: 'race', inside: 'allSettledKeepingFirstRejection' },
    ]);
  });
});

describe('the callers that must wrap a resolve LOOP do (issue #2563)', () => {
  it.each([
    ['src/deployment/deploy-engine.ts', 'resolveOutputs', 2],
    ['src/cli/commands/import.ts', 'resolveImportedProperties', 2],
    ['src/cli/commands/export.ts', 'buildResolvedParametersPerStack', 1],
  ])('every %s call to %s is inside a shared drain budget', (file, callee, atLeast) => {
    // The wraps are this round's whole deliverable and nothing held them:
    // deleting either engine one left `tests/unit/deployment` and then the
    // full unit suite green, because the aggregate case above calls
    // `withSharedDrainBudget` from the TEST body -- it pins the helper, never
    // the caller. A new unwrapped call site would be invisible the same way.
    //
    // Every callee here is a resolve LOOP entered with a lock held.
    // `deploy-engine` and `import` also write state downstream; `export`
    // does not -- its justification is the lock plus the CFn import
    // parameters it builds.
    //
    // `scrub.ts` wraps its loops with ONE INLINE budget rather than at a
    // callee, so it does not fit this callee-keyed table -- it gets the
    // OWNER-KEYED case below instead. Calling it "not expressible" here was
    // wrong, and that sentence is what let a third, unwrapped loop sit in
    // that file for a round while both narratives said it was done.
    //
    // Syntactic, like the fences above, and with the same limits: it asks
    // whether the call sits lexically inside a `withSharedDrainBudget(...)`
    // argument, not whether it runs inside one.
    const abs = join(import.meta.dirname, '../../..', file);
    const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);

    const calls: { line: number; wrapped: boolean }[] = [];
    const walk = (node: ts.Node): void => {
      const isTarget =
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === callee) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.getText() === callee));
      if (isTarget) {
        let wrapped = false;
        for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
          if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === 'withSharedDrainBudget'
          ) {
            wrapped = true;
            break;
          }
        }
        calls.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          wrapped,
        });
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);

    // A floor per file, so a walk that matched nothing fails here rather than
    // leaving the verdict below vacuously true over an empty list.
    expect(calls.length, `no call to ${callee} found in ${file}`).toBeGreaterThanOrEqual(atLeast);
    expect(
      calls.filter((c) => !c.wrapped).map((c) => c.line),
      `a ${callee} call outside \`withSharedDrainBudget\` in ${file} — that loop then spends ` +
        'one cap PER ITERATION with a lock held and a state write downstream',
    ).toEqual([]);
  });
});

/**
 * The engine-level consequence, on the path the issue actually reports: an
 * `Export.Name` built by `Fn::Join` from a secret reference and a sibling that
 * THROWS. The engine resolves that name into a PRIVATE `nameSecrets` map and
 * copies it into the pass map in a `finally`; pre-drain the sibling's
 * recording landed after that copy and the pass map never learned the
 * plaintext.
 *
 * THE DISCRIMINATOR IS A LATER EXPORT NAME, not the failing one. A name whose
 * literal text carries a plaintext the pass knows is REFUSED and not keyed
 * (the exposure guard); one whose plaintext the pass does NOT know is
 * published, putting the secret in the export key space and in state. So the
 * drain is observable as "the later name was refused", which is exactly what
 * the missing needle would have allowed through.
 *
 * Uses the REAL resolver — `deploy-engine-outputs-export-name-collision.test.ts`
 * replaces it wholesale and so pins the copy's SEQUENTIAL shape only.
 */
describe('an INLINE budget is fenced by its OWNER, not by a callee (issue #2563)', () => {
  it('every `resolver.resolve` inside `scrubStack` is under a shared drain budget', () => {
    // `cdkd scrub` hoists ONE budget over its three resolve loops rather than
    // wrapping a callee, so the table above cannot key on it. Keying on the
    // ENCLOSING FUNCTION can, and this is the case that would have caught
    // what a review round had to: with only the two output loops wrapped,
    // the `resolver.resolve` in the resources loop sits in `scrubStack` and
    // outside the wrap, and every other test in the repo stayed green.
    //
    // `makeCrossStackPrePass` is deliberately out of scope: its own
    // `resolver.resolve` inherits the budget at RUNTIME from whichever loop
    // called it, which is not a lexical property and not this walk's
    // business.
    const file = join(import.meta.dirname, '../../../src/cli/commands/scrub.ts');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

    const OWNER = 'scrubStack';
    // Find the OWNER's declaration and walk its whole subtree, rather than
    // asking each call which function encloses it: the innermost-enclosing
    // reading assigns a nested arrow's calls to the arrow, so an unwrapped
    // `const fourth = async () => { await resolver.resolve(...) }` inside
    // `scrubStack` walked straight past the first cut of this case
    // (measured). `makeCrossStackPrePass` is a separate top-level function,
    // so it stays out for free.
    let ownerBody: ts.Node | undefined;
    const findOwner = (node: ts.Node): void => {
      if (ownerBody !== undefined) return;
      const named =
        (ts.isFunctionDeclaration(node) && node.name?.text === OWNER) ||
        ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
          ts.isIdentifier(node.name) &&
          node.name.text === OWNER &&
          node.initializer !== undefined &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)));
      if (named) {
        ownerBody = node;
        return;
      }
      ts.forEachChild(node, findOwner);
    };
    findOwner(sf);
    expect(ownerBody, `${OWNER} not found — this case is asserting nothing`).toBeDefined();

    const owned: { line: number; wrapped: boolean; wrapper: ts.Node | undefined }[] = [];
    const walk = (node: ts.Node): void => {
      // Any receiver spelling, deliberately: `const r = resolver; r.resolve()`
      // and `resolver['resolve']()` both escaped a receiver-name filter
      // (measured). Inside this subtree a `.resolve(` call is the resolver's
      // until shown otherwise, and a false positive here is a loud test
      // rather than a silent hole.
      if (
        ts.isCallExpression(node) &&
        ((ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.getText() === 'resolve') ||
          (ts.isElementAccessExpression(node.expression) &&
            ts.isStringLiteralLike(node.expression.argumentExpression) &&
            node.expression.argumentExpression.text === 'resolve'))
      ) {
        let wrapper: ts.Node | undefined;
        for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
          if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === 'withSharedDrainBudget'
          ) {
            wrapper = n;
            break;
          }
        }
        owned.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          wrapped: wrapper !== undefined,
          wrapper,
        });
      }
      ts.forEachChild(node, walk);
    };
    walk(ownerBody!);

    expect(
      owned.length,
      `fewer than three resolve calls found in ${OWNER} — the walk is matching nothing`,
    ).toBeGreaterThanOrEqual(3);
    expect(
      owned.filter((c) => !c.wrapped).map((c) => c.line),
      `a resolver.resolve in ${OWNER} outside withSharedDrainBudget — that loop then spends ` +
        'one cap per iteration with the scrub lock held and `saveState` downstream',
    ).toEqual([]);

    // "Each call wrapped" is NOT the property: wrapping every `resolve`
    // individually passes the assertion above and restores exactly the
    // per-iteration budget the hoist removed (measured). What must hold is
    // ONE wrapper shared by all of them, with no loop between it and the
    // owner -- a wrapper inside a loop is per-iteration by another spelling.
    const wrappers = new Set(owned.map((c) => c.wrapper?.getStart(sf)));
    expect(
      wrappers.size,
      'the resolve calls sit under DIFFERENT budgets — one wrapper each is one cap each',
    ).toBe(1);
    const loopsBetween: string[] = [];
    for (let n: ts.Node | undefined = owned[0]?.wrapper?.parent; n && n !== ownerBody; n = n.parent) {
      if (ts.isIterationStatement(n, false)) loopsBetween.push(ts.SyntaxKind[n.kind]);
    }
    expect(
      loopsBetween,
      'the shared budget is opened INSIDE a loop, so it is one budget per iteration',
    ).toEqual([]);
  });
});

describe('the engine Export.Name copy sees a concurrent sibling record (issue #2563)', () => {
  const stackName = 'drain-export-name-stack';

  it('a later export name carrying the plaintext is refused, not published', async () => {
    // The failing sibling rejects in a microtask; the secret part answers a
    // timer later, so pre-drain the `finally` copy ran first.
    control.delays.set(SLOW_ID, 1);
    control.fails.add(FAIL_ID);

    const provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'res-phys' }),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    const stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
    const engine = new DeployEngine(
      stateBackend as never,
      { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn().mockResolvedValue(undefined) } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['Res']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(
          new Map<string, ResourceChange>([
            [
              'Res',
              {
                logicalId: 'Res',
                changeType: 'CREATE',
                resourceType: 'AWS::SQS::Queue',
                desiredProperties: { QueueName: 'q' },
              },
            ],
          ])
        ),
        hasChanges: vi.fn().mockReturnValue(true),
        filterByType: vi
          .fn()
          .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
            Array.from(changes.values()).filter((c) => c.changeType === type)
          ),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false },
      'us-east-1',
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );

    const laterName = `prod-${valueOf(SLOW_ID)}-endpoint`;
    const template: CloudFormationTemplate = {
      Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
      Outputs: {
        Exporter: {
          Value: 'public-a',
          Export: { Name: { 'Fn::Join': ['', [ref(SLOW_ID), ref(FAIL_ID)]] } as never },
        },
        LaterExporter: { Value: 'public-b', Export: { Name: laterName } },
        // The positive control. Both assertions below are NEGATIVES, so
        // without a name that MUST be published they hold just as well when
        // the outputs pass never ran at all — measured: a `continue` as the
        // first statement of pass 2 leaves them green.
        PublicExporter: { Value: 'public-c', Export: { Name: 'prod-public-endpoint' } },
      },
    };

    await engine.deploy(stackName, template);

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(
      saved.exportNames ?? [],
      'the pass must have PUBLISHED — otherwise the two negatives below are vacuous',
    ).toContain('prod-public-endpoint');
    expect(saved.exportNames ?? [], 'the later name must be REFUSED, not keyed').not.toContain(laterName);
    expect(JSON.stringify(saved), 'the plaintext must not reach state').not.toContain(valueOf(SLOW_ID));
  });
});
