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
 * `Export.Name` block copied its private map into the pass map in exactly such
 * a `finally`, and a recording that landed afterwards reached nothing (since
 * issue #2814 that block writes each recording through to the pass map).
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
    ['src/cli/commands/scrub.ts', 'resolveCrossStackReads', 3],
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
    // `scrub.ts` wraps its three resolve LOOPS with ONE INLINE budget rather
    // than at a callee, so THOSE do not fit this callee-keyed table -- they
    // get the OWNER-KEYED case below instead. Calling it "not expressible"
    // here was wrong, and that sentence is what let a third, unwrapped loop
    // sit in that file for a round while both narratives said it was done.
    //
    // Its cross-stack pre-pass DOES fit, and is the last row (issue
    // go-to-k/cdkd#2895). `resolveCrossStackReads` is built by
    // `makeCrossStackPrePass` at module scope and returned as a closure, so
    // its own per-leaf `resolver.resolve` sits OUTSIDE `scrubStack`'s subtree
    // and the owner-keyed case below cannot see it -- while its CALL SITES
    // are inside `scrubStack` and are the property worth holding. Correct
    // today because `withSharedDrainBudget` INHERITS, so a call already
    // inside the hoisted budget spends that one. Before this row a fourth
    // call site added above the wrap would have opened a budget per leaf with
    // nothing reddening; that mutation is what this row now catches (measured:
    // it reports the added line).
    //
    // The row is NAME-KEYED, and the claim is bounded to match (issue
    // go-to-k/cdkd#2895's own "state the limit in the fix rather than discover
    // it after"): it holds every call SPELLED `resolveCrossStackReads`. A
    // differently named binding for the factory's return value --
    // `const alias = resolveCrossStackReads; await alias(...)` above the wrap
    // -- passes, measured. Tracking the binding needs symbol resolution, the
    // same instrument the wrapper-shadow KNOWN LIMIT below declines, so the
    // sentence is narrowed instead of the fence widened.
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
 * The owner-keyed walk, extracted so its CLAUSES can be pinned against
 * synthetic sources as well as against the real `scrub.ts`.
 *
 * Every clause here is invisible to a real-tree-only case, which is the same
 * shape as the hole issue go-to-k/cdkd#2894 reports: today's `scrubStack` is a
 * function declaration with no iteration or function boundary between the
 * wrapper and itself, so deleting EITHER barrier clause, stopping the barrier
 * walk at the owner's DECLARATION, or narrowing the receiver match left the
 * whole repository green while the cases below did not exist. Those cases
 * carry the shapes that tell the mutants apart, and the real-tree case stays
 * GREEN under every one of them — which is the point.
 */
function analyseSharedBudget(
  sourceText: string,
  owner: string
): {
  resolveCount: number;
  unwrappedLines: number[];
  distinctWrappers: number;
  perCallBarriers: string[];
  ownerFound: boolean;
} {
  const sf = ts.createSourceFile('probe.ts', sourceText, ts.ScriptTarget.Latest, true);

  // Find the OWNER's declaration and walk its whole subtree, rather than
  // asking each call which function encloses it: the innermost-enclosing
  // reading assigns a nested arrow's calls to the arrow, so an unwrapped
  // `const fourth = async () => { await resolver.resolve(...) }` inside
  // `scrubStack` walked straight past the first cut of this case
  // (measured). `makeCrossStackPrePass` is a separate top-level function,
  // so it stays out for free.
  // The BODY test is what makes this find the IMPLEMENTATION: without it a
  // `declare function scrubStack(...)`, or an overload signature sitting
  // above its implementation, matches first, the walk covers an empty
  // subtree, and the result reads "owner found, no resolve calls" (issue
  // go-to-k/cdkd#2915 review, m1). For the `declare` shape the `>= 3` floor
  // reds either way and only the report was a lie; for the OVERLOAD shape the
  // floor reds a tree that is perfectly correct, which is the worse half.
  //
  // The name must be an IDENTIFIER: a `PropertyName` can be a string literal
  // or computed, and `"scrubStack"() {}` carries `.text === 'scrubStack'`
  // without being a declaration this fence understands.
  let ownerDecl: ts.Node | undefined;
  const findOwner = (node: ts.Node): void => {
    if (ownerDecl !== undefined) return;
    const named =
      ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name) &&
        node.name.text === owner &&
        node.body !== undefined) ||
      ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === owner &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)));
    if (named) {
      ownerDecl = node;
      return;
    }
    ts.forEachChild(node, findOwner);
  };
  findOwner(sf);
  if (ownerDecl === undefined) {
    return {
      resolveCount: 0,
      unwrappedLines: [],
      distinctWrappers: 0,
      perCallBarriers: [],
      ownerFound: false,
    };
  }

  // The barrier walk below stops at the owner's FUNCTION node, not at its
  // declaration: for `const scrubStack = async () => {...}` the arrow sits
  // BETWEEN the wrapper and the VariableDeclaration, so stopping at the
  // declaration would count the owner itself as a callback barrier and red a
  // correct tree. Today `scrubStack` is a function declaration and the two
  // coincide; the `const` arm of the const-arrow case below is what keeps this
  // honest, because the real tree cannot exercise it.
  const ownerFn: ts.Node =
    (ts.isVariableDeclaration(ownerDecl) || ts.isPropertyDeclaration(ownerDecl)) &&
    ownerDecl.initializer !== undefined
      ? ownerDecl.initializer
      : ownerDecl;

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
      // KNOWN LIMIT, and deliberate (issue go-to-k/cdkd#2894): the wrapper
      // is matched by identifier TEXT, so a local
      // `const withSharedDrainBudget = async (fn) => await fn()` shadowing
      // the import would satisfy this walk while opening nothing. Closing it
      // means introducing symbol resolution, which this fence does not use
      // anywhere -- a new instrument for a shape nobody writes by accident.
      // Named here rather than chased.
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
  walk(ownerDecl);

  // An iteration statement is only ONE way to lose "opened once per call of
  // the owner". A wrapper inside a CALLBACK --
  // `await Promise.all(xs.map(async () => withSharedDrainBudget(...)))` --
  // opens one budget per element while matching no `ts.isIterationStatement`,
  // and the earlier version of this clause passed it (issue
  // go-to-k/cdkd#2894). Both clauses are needed and neither subsumes the
  // other: a `for` written directly in the owner has the owner as its
  // enclosing function, so the boundary test alone goes green on it.
  //
  // KNOWN LIMIT, and deliberate: this is an OVER-approximation. A wrapper
  // inside a helper arrow the owner calls exactly once -- or an IIFE -- opens
  // the budget once per owner call and is still reported, because from the
  // syntax alone the fence can no longer tell how many times it is opened, so
  // it reds. In the shape `scrub.ts` actually has, the wrapper reaches the
  // owner with no iteration or function boundary between the two (a `try` is
  // neither), and that is the property held here.
  //
  // Driven by the ONE shared wrapper rather than by `owned[0]`: with the
  // distinct-wrapper count asserted at 1, source order is irrelevant, and an
  // unwrapped FIRST call no longer makes this walk vacuous by starting it at
  // `undefined` (issue go-to-k/cdkd#2915 review, m3).
  const wrapperNodes = owned.map((c) => c.wrapper).filter((w): w is ts.Node => w !== undefined);
  const sharedWrapper: ts.Node | undefined = wrapperNodes[0];
  const perCallBarriers: string[] = [];
  for (let n: ts.Node | undefined = sharedWrapper?.parent; n && n !== ownerFn; n = n.parent) {
    if (ts.isIterationStatement(n, false) || ts.isFunctionLike(n)) {
      perCallBarriers.push(ts.SyntaxKind[n.kind]);
    }
  }

  return {
    resolveCount: owned.length,
    unwrappedLines: owned.filter((c) => !c.wrapped).map((c) => c.line),
    // UNWRAPPED calls do not contribute: counting `undefined` as a member
    // reported `1` for an owner with no wrapper at all, which reads as "one
    // shared wrapper" (issue go-to-k/cdkd#2915 review, m2). Masked today by
    // `unwrappedLines` asserting first; a count should not need a bodyguard.
    distinctWrappers: new Set(wrapperNodes.map((w) => w.getStart(sf))).size,
    perCallBarriers,
    ownerFound: true,
  };
}

describe('an INLINE budget is fenced by its OWNER, not by a callee (issue #2563)', () => {
  it('every `resolver.resolve` inside `scrubStack` is under a shared drain budget', () => {
    // `cdkd scrub` hoists ONE budget over its three resolve loops rather than
    // wrapping a callee, so the table above cannot key on it. Keying on the
    // ENCLOSING FUNCTION can, and this is the case that would have caught
    // what a review round had to: with only the two output loops wrapped,
    // the `resolver.resolve` in the resources loop sits in `scrubStack` and
    // outside the wrap, and every other test in the repo stayed green.
    //
    // `makeCrossStackPrePass` is deliberately out of scope HERE: its own
    // `resolver.resolve` inherits the budget at RUNTIME from whichever loop
    // called it, which is not a lexical property and not this walk's
    // business. Its CALL SITES are held by the callee-keyed table above
    // instead (issue go-to-k/cdkd#2895).
    const file = join(import.meta.dirname, '../../../src/cli/commands/scrub.ts');
    const OWNER = 'scrubStack';
    const found = analyseSharedBudget(readFileSync(file, 'utf8'), OWNER);

    expect(found.ownerFound, `${OWNER} not found — this case is asserting nothing`).toBe(true);
    expect(
      found.resolveCount,
      `fewer than three resolve calls found in ${OWNER} — the walk is matching nothing`,
    ).toBeGreaterThanOrEqual(3);
    expect(
      found.unwrappedLines,
      `a \`.resolve(\` call in ${OWNER} outside withSharedDrainBudget — that loop then spends ` +
        'one cap per iteration with the scrub lock held and `saveState` downstream. This walk ' +
        'matches ANY receiver by design, so an unrelated `.resolve(` in this function — a plain ' +
        '`Promise.resolve()`, say — reds here too: a loud false positive chosen over a silent ' +
        'hole, not a claim that the line is a resolver call (issue go-to-k/cdkd#2894)',
    ).toEqual([]);

    // "Each call wrapped" is NOT the property: wrapping every `resolve`
    // individually passes the assertion above and restores exactly the
    // per-iteration budget the hoist removed (measured). What must hold is
    // ONE wrapper shared by all of them, with no loop or callback between it
    // and the owner.
    expect(
      found.distinctWrappers,
      'the resolve calls sit under DIFFERENT budgets — one wrapper each is one cap each',
    ).toBe(1);
    expect(
      found.perCallBarriers,
      'a loop or a function boundary sits between the shared budget and the owner, so how ' +
        'many times the budget is opened is no longer readable from the syntax — a loop ' +
        'spelling opens one per iteration, and a helper called once does not, but this fence ' +
        'refuses both rather than guessing',
    ).toEqual([]);
  });

  // The cases below pin the CLAUSES the case above cannot: the real tree has
  // none of these shapes, so every mutant stays green against IT. Measured on
  // the tree WITHOUT them, each mutant left the full suite green; with them,
  // of 30 cases in this file — deleting `ts.isFunctionLike` from the barrier
  // reds the callback case alone; stopping the barrier walk at the owner's
  // DECLARATION reds both arrow-owner cases; dropping
  // `ts.isPropertyDeclaration` from the normalisation reds the class-field
  // case alone. The real-tree case above survives all three.
  it('a wrapper opened inside a CALLBACK is a per-invocation budget, not a shared one', () => {
    const source = `
      async function scrubStack(ids: string[]) {
        await Promise.all(
          ids.map(async (id) =>
            withSharedDrainBudget(async () => {
              await resolver.resolve(id);
            })
          )
        );
      }
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.ownerFound).toBe(true);
    expect(found.resolveCount).toBe(1);
    // Syntactically ONE wrapper and no iteration statement, which is why the
    // pre-go-to-k/cdkd#2894 clause passed this shape.
    expect(found.unwrappedLines).toEqual([]);
    expect(found.distinctWrappers).toBe(1);
    expect(found.perCallBarriers).toContain('ArrowFunction');
  });

  it('a const-arrow owner whose wrapper sits in its own body reports NO barrier', () => {
    // The negative control for the clause above, and one of the two shapes
    // that exercise the owner-FUNCTION normalisation (the class-field case
    // below carries the other arm): stop the barrier walk at the declaration
    // instead and the owner's own arrow is counted as a callback barrier,
    // reddening a correct shape.
    const source = `
      const scrubStack = async (ids: string[]) => {
        await withSharedDrainBudget(async () => {
          for (const id of ids) {
            await resolver.resolve(id);
          }
        });
      };
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.ownerFound).toBe(true);
    expect(found.resolveCount).toBe(1);
    expect(found.unwrappedLines).toEqual([]);
    expect(found.perCallBarriers).toEqual([]);
  });

  it('a class-FIELD arrow owner reports NO barrier either', () => {
    // The owner finder accepts a `PropertyDeclaration` as well as a
    // `VariableDeclaration`, so the normalisation above has two arms and the
    // case before this one pins only one of them: drop
    // `ts.isPropertyDeclaration` from it and a class-field owner reports
    // `['ArrowFunction']` for a correct shape — measured: that mutant reds
    // this case alone, 1 failed of 30.
    const source = `
      class Scrubber {
        scrubStack = async (ids: string[]) => {
          await withSharedDrainBudget(async () => {
            for (const id of ids) {
              await resolver.resolve(id);
            }
          });
        };
      }
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.ownerFound).toBe(true);
    expect(found.resolveCount).toBe(1);
    expect(found.unwrappedLines).toEqual([]);
    expect(found.perCallBarriers).toEqual([]);
  });

  it('a method owner is accepted like the other three declaration shapes', () => {
    // Symmetry, not a shape `scrub.ts` has: once a class-FIELD arrow owner is
    // accepted, a method of the same name reporting `ownerFound: false` makes
    // the finder's coverage look arbitrary (issue go-to-k/cdkd#2915 review,
    // m6). It reds loudly on the first assertion either way, so this pins the
    // report rather than closing a hole.
    const source = `
      class Scrubber {
        async scrubStack(ids: string[]) {
          await withSharedDrainBudget(async () => {
            for (const id of ids) {
              await resolver.resolve(id);
            }
          });
        }
      }
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.ownerFound).toBe(true);
    expect(found.resolveCount).toBe(1);
    expect(found.unwrappedLines).toEqual([]);
    expect(found.perCallBarriers).toEqual([]);
  });

  it('a wrapper inside a LOOP written directly in the owner is still per-iteration', () => {
    // The clause the boundary check does NOT subsume, and the probe issue
    // go-to-k/cdkd#2894's Proposed fix asked for by name: here the wrapper's
    // enclosing function IS the owner, so `ts.isFunctionLike` never fires on
    // the upward path and only `ts.isIterationStatement` reports. Measured on
    // the tree BEFORE this case existed, deleting
    // `ts.isIterationStatement(n, false) ||` left all 30 cases green — the
    // clause was unpinned entirely. With this case and the source-order one
    // below, that mutant reds the two of them and nothing else.
    const source = `
      async function scrubStack(ids: string[]) {
        for (const id of ids) {
          await withSharedDrainBudget(async () => {
            await resolver.resolve(id);
          });
        }
      }
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.ownerFound).toBe(true);
    expect(found.resolveCount).toBe(1);
    expect(found.unwrappedLines).toEqual([]);
    expect(found.perCallBarriers).toContain('ForOfStatement');
  });

  it('an unrelated `.resolve(` OUTSIDE the wrapper reds, and INSIDE it does not', () => {
    // The any-receiver match is deliberate and the failure message now says
    // so; both arms of that sentence are pinned here (issue go-to-k/cdkd#2894
    // item 3, and its verification plan's fifth bullet). Measured: narrowing
    // the matcher to `resolver.resolve` — which also drops the element-access
    // arm — left every case green before this one and the element-access case
    // below existed, since every other source under test spells it that way;
    // with them, that mutant reds exactly those two.
    const outside = `
      async function scrubStack(ids: string[]) {
        await Promise.resolve();
        await withSharedDrainBudget(async () => {
          for (const id of ids) {
            await resolver.resolve(id);
          }
        });
      }
    `;
    const outsideFound = analyseSharedBudget(outside, 'scrubStack');
    expect(outsideFound.resolveCount).toBe(2);
    expect(outsideFound.unwrappedLines).toHaveLength(1);

    const inside = `
      async function scrubStack(ids: string[]) {
        await withSharedDrainBudget(async () => {
          await Promise.resolve();
          for (const id of ids) {
            await resolver.resolve(id);
          }
        });
      }
    `;
    const insideFound = analyseSharedBudget(inside, 'scrubStack');
    expect(insideFound.resolveCount).toBe(2);
    expect(insideFound.unwrappedLines).toEqual([]);
  });

  it('an ELEMENT-ACCESS resolve call outside the wrapper reds too', () => {
    // The second half of the any-receiver match, and the arm a narrowing
    // mutant removes wholesale: `resolver['resolve']()` escaped a
    // receiver-name filter during go-to-k/cdkd#2797's review, and nothing
    // pinned it until here.
    const source = `
      async function scrubStack(ids: string[]) {
        await resolver['resolve'](ids[0]);
        await withSharedDrainBudget(async () => {
          for (const id of ids) {
            await resolver.resolve(id);
          }
        });
      }
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.resolveCount).toBe(2);
    expect(found.unwrappedLines).toHaveLength(1);
  });

  it('a bodyless owner declaration is not reported as the owner', () => {
    // `ownerFound` must describe what was found, not what was named (issue
    // go-to-k/cdkd#2915 review, m1): an overload signature or a `declare`
    // used to match, giving `{ownerFound: true, resolveCount: 0}` — the floor
    // reds either way, but the report was a lie about which case it was.
    const source = `
      declare function scrubStack(ids: string[]): Promise<void>;
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.ownerFound).toBe(false);
    expect(found.resolveCount).toBe(0);
  });

  it('an owner with no wrapper at all reports ZERO shared wrappers', () => {
    // `distinctWrappers` counted `undefined` as a member, so "no wrapper
    // anywhere" reported 1 — indistinguishable from "one shared wrapper"
    // (issue go-to-k/cdkd#2915 review, m2).
    const source = `
      async function scrubStack(ids: string[]) {
        for (const id of ids) {
          await resolver.resolve(id);
        }
      }
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.resolveCount).toBe(1);
    expect(found.distinctWrappers).toBe(0);
    expect(found.unwrappedLines).toHaveLength(1);
  });

  it('an OVERLOAD signature does not capture the owner from its implementation', () => {
    // The half of the body test that matters: a `declare` only made the report
    // lie, but an overload sitting above its implementation makes the finder
    // stop at the signature and red a tree that is entirely correct (issue
    // go-to-k/cdkd#2915 review). Pinning "reject `declare`" alone would leave
    // this shape broken, which is why the test is written against the
    // invariant — the owner is the declaration that HAS a body.
    const source = `
      async function scrubStack(ids: string[]): Promise<void>;
      async function scrubStack(ids: string[]) {
        await withSharedDrainBudget(async () => {
          for (const id of ids) {
            await resolver.resolve(id);
          }
        });
      }
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.ownerFound).toBe(true);
    expect(found.resolveCount).toBe(1);
    expect(found.unwrappedLines).toEqual([]);
    expect(found.perCallBarriers).toEqual([]);
  });

  it('an ANONYMOUS function declaration in the same file does not break the walk', () => {
    // The name-PRESENCE half of the guard, which the quoted-name case does not
    // reach: `FunctionDeclaration.name` is optional, so `export default
    // function () {}` gives `node.name === undefined` and an unguarded
    // `ts.isIdentifier(node.name)` throws on it before the real owner is ever
    // seen (issue go-to-k/cdkd#2915 review). A negative control: the owner
    // below must still be found, with the anonymous declaration walked past.
    const source = `
      export default function () {
        return 1;
      }
      async function scrubStack(ids: string[]) {
        await withSharedDrainBudget(async () => {
          for (const id of ids) {
            await resolver.resolve(id);
          }
        });
      }
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.ownerFound).toBe(true);
    expect(found.resolveCount).toBe(1);
    expect(found.unwrappedLines).toEqual([]);
    expect(found.perCallBarriers).toEqual([]);
  });

  it('a QUOTED method name is not the owner', () => {
    // `PropertyName` covers string literals and computed names, and
    // `"scrubStack"() {}` carries `.text === 'scrubStack'`. Accepting it would
    // widen the finder past the declaration shapes this fence understands, so
    // the identifier test is what this pins (issue go-to-k/cdkd#2915 review).
    const source = `
      class Scrubber {
        async "scrubStack"(ids: string[]) {
          await withSharedDrainBudget(async () => {
            for (const id of ids) {
              await resolver.resolve(id);
            }
          });
        }
      }
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.ownerFound).toBe(false);
    expect(found.resolveCount).toBe(0);
  });

  it('the barrier walk does not depend on which resolve comes FIRST in source order', () => {
    // Driving the walk from `owned[0]` made it vacuous whenever the first
    // `.resolve(` in source order was unwrapped: the start point is
    // `undefined`, so no barrier is ever reported, and the loop below goes
    // unseen (issue go-to-k/cdkd#2915 review, m3). Safe in practice only
    // because `unwrappedLines` reds first — a check that needs a bodyguard is
    // not a check.
    const source = `
      async function scrubStack(ids: string[]) {
        await resolver.resolve(ids[0]);
        for (const id of ids) {
          await withSharedDrainBudget(async () => {
            await resolver.resolve(id);
          });
        }
      }
    `;
    const found = analyseSharedBudget(source, 'scrubStack');
    expect(found.resolveCount).toBe(2);
    expect(found.unwrappedLines).toHaveLength(1);
    expect(found.perCallBarriers).toContain('ForOfStatement');
  });
});

/**
 * The engine-level consequence, on the path the issue actually reports: an
 * `Export.Name` built by `Fn::Join` from a secret reference and a sibling that
 * THROWS. The engine resolved that name into a PRIVATE `nameSecrets` map and
 * copied it into the pass map in a `finally`; pre-drain the sibling's
 * recording landed after that copy and the pass map never learned the
 * plaintext. (Since issue #2814 the map writes through instead, so this case
 * pins the drain's ORDER; the #2814 describe below pins the write-through.)
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
describe('the engine Export.Name copy sees a concurrent sibling record (issue #2563)', () => {
  const stackName = 'drain-export-name-stack';

  it('a later export name carrying the plaintext is refused, not published', async () => {
    // The failing sibling rejects in a microtask; the secret part answers a
    // timer later, so pre-drain the name's block ended first.
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

/**
 * Poll, one macrotask at a time, until `condition` holds. The cases below
 * order events by what they OBSERVE rather than by racing timers against each
 * other, so a loaded runner changes how long they take, not what they assert.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 500; turn += 1) {
    if (condition()) return;
    await settleTurn();
  }
  throw new Error(`timed out waiting for: ${what}`);
}

type WarnSpy = ReturnType<typeof vi.fn<(message: string) => void>>;

/** The resolver's own logger, whose `warn` carries the abandoned-drain report. */
function spyResolverWarn(resolver: unknown): WarnSpy {
  const logger = (resolver as { logger: { warn: (message: string) => void } }).logger;
  return vi.spyOn(logger, 'warn').mockImplementation(() => {}) as unknown as WarnSpy;
}

const abandonedReports = (warn: WarnSpy): string[] =>
  warn.mock.calls.map(([message]) => String(message)).filter((m) => m.includes('cdkd stopped waiting'));

describe('a drain the cap releases reports the parts it stopped waiting for (issue #2814)', () => {
  it('warns once, with the count, and the late recording still lands in the map', async () => {
    concurrentDrainCap.ms = 20;
    const slow = gate();
    control.holds.set(SLOW_ID, slow.promise);
    control.fails.add(FAIL_ID);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const warn = spyResolverWarn(resolver);

    await expect(
      resolver.resolve({ 'Fn::Join': ['-', [ref(SLOW_ID), ref(FAIL_ID)]] }, context)
    ).rejects.toThrow(`refused ${FAIL_ID}`);

    // The premise: the cap released the rejection BEFORE the held part
    // recorded. Without it the report below would describe nothing.
    expect(context.recordedSecretValues.has(valueOf(SLOW_ID))).toBe(false);
    const reports = abandonedReports(warn);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('1 concurrent part was still running');
    expect(reports[0]).toContain('capped at 0.02s');

    // Late, not lost: the part keeps running and records into the same map.
    slow.open();
    await until(() => control.events.includes(`record:${SLOW_ID}`), 'the held part to record');
    await settleTurn();
    expect(context.recordedSecretValues.get(valueOf(SLOW_ID))).toBe(ref(SLOW_ID));
  });

  it('counts every part still running when the cap fires', async () => {
    concurrentDrainCap.ms = 20;
    control.hangs.add(HANG_IDS[0]!);
    control.hangs.add(HANG_IDS[1]!);
    control.fails.add(FAIL_ID);
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const warn = spyResolverWarn(resolver);

    await expect(
      resolver.resolve(
        { 'Fn::Join': ['-', [ref(HANG_IDS[0]!), ref(HANG_IDS[1]!), ref(FAIL_ID)]] },
        makeContext()
      )
    ).rejects.toThrow(`refused ${FAIL_ID}`);

    const reports = abandonedReports(warn);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('2 concurrent parts were still running');
  });

  it('a LIST drain reports too, not only a join', async () => {
    // The helper's other call site: a list resolves its elements through the
    // same drain, and wires its own report.
    concurrentDrainCap.ms = 20;
    control.hangs.add(HANG_IDS[0]!);
    control.fails.add(FAIL_ID);
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const warn = spyResolverWarn(resolver);

    await expect(
      resolver.resolve([ref(HANG_IDS[0]!), ref(FAIL_ID)], makeContext())
    ).rejects.toThrow(`refused ${FAIL_ID}`);

    const reports = abandonedReports(warn);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('1 concurrent part was still running');
  });

  it('warns once per budget when one failure releases nested drains', async () => {
    // The inner join spends the budget waiting on its hung part and throws;
    // the outer join then arms on the spent budget and releases at once,
    // abandoning ITS hung part too. Two drains abandoned work, one report.
    concurrentDrainCap.ms = 20;
    control.hangs.add(HANG_IDS[0]!);
    control.hangs.add(HANG_IDS[1]!);
    control.fails.add(FAIL_DEEP_ID);
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const warn = spyResolverWarn(resolver);

    await expect(
      resolver.resolve(
        {
          'Fn::Join': [
            '-',
            [{ 'Fn::Join': ['-', [ref(HANG_IDS[0]!), ref(FAIL_DEEP_ID)]] }, ref(HANG_IDS[1]!)],
          ],
        },
        makeContext()
      )
    ).rejects.toThrow(`refused ${FAIL_DEEP_ID}`);

    expect(abandonedReports(warn)).toHaveLength(1);
  });

  it('reports again for an independent resolution: once per budget, not per resolver', async () => {
    concurrentDrainCap.ms = 20;
    control.hangs.add(HANG_IDS[0]!);
    control.fails.add(FAIL_ID);
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const warn = spyResolverWarn(resolver);
    const join = { 'Fn::Join': ['-', [ref(HANG_IDS[0]!), ref(FAIL_ID)]] };

    await expect(resolver.resolve(join, makeContext())).rejects.toThrow(`refused ${FAIL_ID}`);
    await expect(resolver.resolve(join, makeContext())).rejects.toThrow(`refused ${FAIL_ID}`);

    expect(abandonedReports(warn)).toHaveLength(2);
  });

  it('reports once for two resolutions sharing one budget', async () => {
    // The outputs pass wraps its loop this way, so one report per pass.
    concurrentDrainCap.ms = 20;
    control.hangs.add(HANG_IDS[0]!);
    control.hangs.add(HANG_IDS[1]!);
    control.fails.add(FAIL_ID);
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const warn = spyResolverWarn(resolver);

    await withSharedDrainBudget(async () => {
      for (const hung of [HANG_IDS[0]!, HANG_IDS[1]!]) {
        await expect(
          resolver.resolve({ 'Fn::Join': ['-', [ref(hung), ref(FAIL_ID)]] }, makeContext())
        ).rejects.toThrow(`refused ${FAIL_ID}`);
      }
    });

    expect(abandonedReports(warn)).toHaveLength(1);
  });

  it('names the DEFAULT cap when no test seam is set', async () => {
    // Every case here that RENDERS a warning shrinks the cap through
    // `concurrentDrainCap.ms`, so the 60 s the shipped binary reports is
    // never rendered by them. Calling the reporter directly is the only way
    // to see that arm without waiting a real minute for a drain to release.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const warn = spyResolverWarn(resolver);

    (resolver as unknown as { warnAbandonedParts: (pending: number) => void }).warnAbandonedParts(2);

    const reports = abandonedReports(warn);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('2 concurrent parts were still running');
    expect(reports[0]).toContain('capped at 60s');
  });

  it('does not warn when every part settled inside the cap', async () => {
    control.delays.set(SLOW_ID, 1);
    control.fails.add(FAIL_ID);
    const context = makeContext();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const warn = spyResolverWarn(resolver);

    await expect(
      resolver.resolve({ 'Fn::Join': ['-', [ref(SLOW_ID), ref(FAIL_ID)]] }, context)
    ).rejects.toThrow(`refused ${FAIL_ID}`);

    // The positive half: the drain DID wait for the slow part, so the absent
    // report is about a drain that had nothing to abandon.
    expect(context.recordedSecretValues.has(valueOf(SLOW_ID))).toBe(true);
    expect(abandonedReports(warn)).toEqual([]);
  });
});

describe('a record the drain cap stopped waiting for still reaches the engine readers after it (issue #2814)', () => {
  const stackName = 'drain-late-record-stack';
  const SPACER_ID = 'cdkd-drain-spacer';
  /** Resolves CLEANLY during the outputs pass, so the needle bag is not empty. */
  const CLEAN_ID = 'cdkd-drain-clean';

  /**
   * `existing` switches the engine onto the NO-CHANGE path: the stack is
   * already in state, and the diff reports its one resource unchanged.
   */
  function buildEngine(readCurrentState: () => Promise<unknown>, existing?: StackState) {
    const provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'res-phys' }),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(readCurrentState),
    };
    const stateBackend = {
      getState: vi
        .fn()
        .mockResolvedValue(existing ? { state: existing, etag: 'etag-0' } : { state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
    const exportIndex = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
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
                changeType: existing ? 'NO_CHANGE' : 'CREATE',
                resourceType: 'AWS::SQS::Queue',
                desiredProperties: { QueueName: 'q' },
              },
            ],
          ])
        ),
        hasChanges: vi.fn().mockReturnValue(existing === undefined),
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
      exportIndex as never
    );
    const warn = spyResolverWarn((engine as unknown as { resolver: unknown }).resolver);
    // The ENGINE's own logger, a separate object: the refused-name and
    // failed-output warnings go through it, and a plaintext check that read
    // the resolver's stream alone could not see them.
    const engineWarn = vi
      .spyOn((engine as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn')
      .mockImplementation(() => {}) as unknown as WarnSpy;
    return { engine, provider, stateBackend, exportIndex, warn, engineWarn };
  }

  it('a later export name carrying a plaintext recorded after the drain released is refused', async () => {
    // Pre-fix, the Export.Name block resolved into a local map and copied it
    // into the pass map in a `finally`: a part the cap stopped waiting for
    // recorded into that local AFTER the copy, and the entry was dropped.
    concurrentDrainCap.ms = 20;
    const slow = gate();
    const spacer = gate();
    control.holds.set(SLOW_ID, slow.promise);
    control.holds.set(SPACER_ID, spacer.promise);
    control.fails.add(FAIL_ID);
    const { engine, stateBackend, warn, engineWarn } = buildEngine(() => Promise.resolve(undefined));

    const laterName = `prod-${valueOf(SLOW_ID)}-endpoint`;
    const template: CloudFormationTemplate = {
      Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
      Outputs: {
        Exporter: {
          Value: 'public-a',
          Export: { Name: { 'Fn::Join': ['', [ref(SLOW_ID), ref(FAIL_ID)]] } as never },
        },
        // Holds the pass between the release above and the name below, so
        // the late recording has somewhere to land before that name is judged.
        Spacer: {
          Value: 'public-s',
          Export: { Name: { 'Fn::Join': ['-', ['spacer', ref(SPACER_ID)]] } as never },
        },
        LaterExporter: { Value: 'public-b', Export: { Name: laterName } },
        // The positive control: without a name that MUST be published, the
        // negatives below hold just as well when the pass never ran.
        PublicExporter: { Value: 'public-c', Export: { Name: 'prod-public-endpoint' } },
      },
    };

    const run = engine.deploy(stackName, template);
    await until(() => abandonedReports(warn).length > 0, 'the cap to release the Exporter name');
    expect(control.events, 'the held part must not have recorded yet').not.toContain(
      `record:${SLOW_ID}`
    );
    slow.open();
    await until(() => control.events.includes(`record:${SLOW_ID}`), 'the late recording');
    await settleTurn();
    spacer.open();
    await run;

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(
      saved.exportNames ?? [],
      'the pass must have PUBLISHED — otherwise the two negatives below are vacuous'
    ).toContain('prod-public-endpoint');
    expect(saved.exportNames ?? [], 'the later name must be REFUSED, not keyed').not.toContain(laterName);
    expect(JSON.stringify(saved), 'the plaintext must not reach state').not.toContain(valueOf(SLOW_ID));
    // The refusal is announced on the ENGINE's logger, naming the output;
    // that warning is the one place the refused name could leak.
    const engineWarnings = engineWarn.mock.calls.map(([message]) => String(message));
    expect(
      engineWarnings.some((message) => message.includes('LaterExporter')),
      'the refusal must have been warned — otherwise the negative below is vacuous'
    ).toBe(true);
    expect(engineWarnings.join('\n'), 'no engine warning carries the plaintext').not.toContain(
      valueOf(SLOW_ID)
    );
  });

  it('a plaintext recorded after the outputs pass is redacted from the save, the exports index and the summary', async () => {
    // The outputs pass redacts its bag when it ends; a part the cap stopped
    // waiting for records after that. The observed-capture drain before the
    // final save is the window, held here so the recording lands inside it.
    concurrentDrainCap.ms = 20;
    const slow = gate();
    const capture = gate();
    control.holds.set(SLOW_ID, slow.promise);
    control.fails.add(FAIL_ID);
    const { engine, provider, stateBackend, exportIndex, warn, engineWarn } = buildEngine(() =>
      capture.promise.then(() => undefined)
    );
    const redactOutputs = vi.spyOn(
      engine as unknown as { redactOutputs: (o: Record<string, unknown>) => Record<string, unknown> },
      'redactOutputs'
    );

    const literal = `lit-${valueOf(SLOW_ID)}-tail`;
    const template: CloudFormationTemplate = {
      Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
      Outputs: {
        Failing: { Value: { 'Fn::Join': ['', [ref(SLOW_ID), ref(FAIL_ID)]] } },
        // Carries the plaintext by a route that resolves nothing, so only a
        // needle the late part recorded can redact it.
        Literal: { Value: literal, Export: { Name: 'lit-export' } },
      },
    };

    const run = engine.deploy(stackName, template);
    await until(() => redactOutputs.mock.calls.length > 0, 'the outputs pass to redact its bag');
    expect(abandonedReports(warn), 'the cap must have released the Failing output').toHaveLength(1);
    expect(control.events, 'the held part must not have recorded yet').not.toContain(
      `record:${SLOW_ID}`
    );
    expect(provider.readCurrentState, 'the capture drain must be what holds the save').toHaveBeenCalled();
    expect(
      stateBackend.saveState.mock.calls.some(
        (call) => (call[2] as StackState).outputs?.['Literal'] !== undefined
      ),
      'the final save must not have run yet'
    ).toBe(false);
    slow.open();
    await until(() => control.events.includes(`record:${SLOW_ID}`), 'the late recording');
    await settleTurn();
    capture.open();
    const result = await run;

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.outputs['Literal'], 'the literal is PUBLISHED, and redacted').toBe(
      `lit-${ref(SLOW_ID)}-tail`
    );
    expect(JSON.stringify(saved), 'the plaintext must not reach state').not.toContain(valueOf(SLOW_ID));
    const indexed = exportIndex.updateForStack.mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(indexed['lit-export'], 'the export is INDEXED, and redacted').toBe(`lit-${ref(SLOW_ID)}-tail`);
    expect(result.outputs, 'the summary prints the redacted literal').toEqual({
      Literal: `lit-${ref(SLOW_ID)}-tail`,
    });
    expect(
      [...warn.mock.calls, ...engineWarn.mock.calls].flat().join('\n'),
      'no warning, resolver or engine, carries the plaintext'
    ).not.toContain(valueOf(SLOW_ID));
  });

  it('folds the pass map in AGAIN when the needle bag is already non-empty', async () => {
    // The REFOLD, not the first fold, and no other case here can see it —
    // for two different reasons, neither of which is "the fold never runs".
    // The late-record cases resolve no secret SUCCESSFULLY, so their bag is
    // empty until the late needle arrives and the first fold carries it; the
    // export-name case above does record (both its parts settle before the
    // pass ends), but those recordings land BEFORE the first fold. Either
    // way a `redactOutputs` folding only on an empty bag serves them all
    // (measured by the maintainer on PR 3044: 6414 tests, zero new
    // failures). Here a clean secret output fills the bag DURING the pass and
    // the late needle arrives after the first fold, so it can reach the save,
    // the index and the summary only through a LATER one.
    concurrentDrainCap.ms = 20;
    const slow = gate();
    const capture = gate();
    control.holds.set(SLOW_ID, slow.promise);
    control.fails.add(FAIL_ID);
    const { engine, provider, stateBackend, exportIndex, warn, engineWarn } = buildEngine(() =>
      capture.promise.then(() => undefined)
    );
    const redactOutputs = vi.spyOn(
      engine as unknown as { redactOutputs: (o: Record<string, unknown>) => Record<string, unknown> },
      'redactOutputs'
    );
    const needleBag = (): Map<string, string> =>
      (engine as unknown as { outputSecrets: Map<string, string> }).outputSecrets;

    const literal = `lit-${valueOf(SLOW_ID)}-tail`;
    const template: CloudFormationTemplate = {
      Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
      Outputs: {
        // Resolves cleanly, so its plaintext is a needle before the drain
        // releases — this is what makes the fold below a REfold.
        Clean: { Value: ref(CLEAN_ID) },
        Failing: { Value: { 'Fn::Join': ['', [ref(SLOW_ID), ref(FAIL_ID)]] } },
        Literal: { Value: literal, Export: { Name: 'lit-export' } },
      },
    };

    const run = engine.deploy(stackName, template);
    await until(() => redactOutputs.mock.calls.length > 0, 'the outputs pass to redact its bag');
    expect(
      needleBag().get(valueOf(CLEAN_ID)),
      'the clean secret must already be a needle — otherwise the first fold is the only fold and this case proves nothing'
    ).toBe(ref(CLEAN_ID));
    expect(abandonedReports(warn), 'the cap must have released the Failing output').toHaveLength(1);
    expect(control.events, 'the held part must not have recorded yet').not.toContain(
      `record:${SLOW_ID}`
    );
    expect(provider.readCurrentState, 'the capture drain must be what holds the save').toHaveBeenCalled();
    slow.open();
    await until(() => control.events.includes(`record:${SLOW_ID}`), 'the late recording');
    await settleTurn();
    capture.open();
    const result = await run;

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.outputs['Clean'], 'the clean secret persists as its expression').toBe(ref(CLEAN_ID));
    expect(saved.outputs['Literal'], 'the LATE needle redacted the literal too').toBe(
      `lit-${ref(SLOW_ID)}-tail`
    );
    const indexed = exportIndex.updateForStack.mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(indexed['lit-export'], 'the export is INDEXED, and redacted').toBe(`lit-${ref(SLOW_ID)}-tail`);
    expect(result.outputs, 'the summary prints both, redacted').toEqual({
      Clean: ref(CLEAN_ID),
      Literal: `lit-${ref(SLOW_ID)}-tail`,
    });
    expect(
      [...warn.mock.calls, ...engineWarn.mock.calls].flat().join('\n'),
      'no warning, resolver or engine, carries the plaintext'
    ).not.toContain(valueOf(SLOW_ID));
  });

  it('a plaintext recorded while the final save is in flight is still redacted from the exports index and the summary', async () => {
    // Each reader after the pass redacts at the moment it reads, so the index
    // and the summary, which run after the save's await, see a needle that
    // arrived during it. The save itself took its copy before, which is the
    // residual this issue documents -- asserted below as the premise that
    // the recording really arrived after that copy.
    concurrentDrainCap.ms = 20;
    const slow = gate();
    const save = gate();
    control.holds.set(SLOW_ID, slow.promise);
    control.fails.add(FAIL_ID);
    const { engine, stateBackend, exportIndex, warn, engineWarn } = buildEngine(() =>
      Promise.resolve(undefined)
    );
    const redactOutputs = vi.spyOn(
      engine as unknown as { redactOutputs: (o: Record<string, unknown>) => Record<string, unknown> },
      'redactOutputs'
    );
    // Only a save AFTER the outputs pass is held: the per-resource saves
    // during provisioning run before it.
    let finalSaveEntered = false;
    stateBackend.saveState.mockImplementation(async () => {
      if (redactOutputs.mock.calls.length > 0) {
        finalSaveEntered = true;
        await save.promise;
      }
      return 'etag-new';
    });

    const template: CloudFormationTemplate = {
      Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
      Outputs: {
        Failing: { Value: { 'Fn::Join': ['', [ref(SLOW_ID), ref(FAIL_ID)]] } },
        Literal: { Value: `lit-${valueOf(SLOW_ID)}-tail`, Export: { Name: 'lit-export' } },
      },
    };

    const run = engine.deploy(stackName, template);
    await until(() => finalSaveEntered, 'the final save to be in flight');
    expect(abandonedReports(warn), 'the cap must have released the Failing output').toHaveLength(1);
    expect(control.events, 'the held part must not have recorded yet').not.toContain(
      `record:${SLOW_ID}`
    );
    slow.open();
    await until(() => control.events.includes(`record:${SLOW_ID}`), 'the late recording');
    await settleTurn();
    save.open();
    const result = await run;

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    // Asserting a plaintext IN state deliberately: it is the residual this
    // issue documents, not a regression — the save had already taken its copy
    // when the recording arrived, which no bounded wait can change. The
    // assertions after it are what the fix buys: the index and the summary,
    // both written later, carry the expression instead.
    expect(saved.outputs['Literal'], 'the save took its copy before the recording (the residual)').toBe(
      `lit-${valueOf(SLOW_ID)}-tail`
    );
    const indexed = exportIndex.updateForStack.mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(indexed['lit-export'], 'the export is INDEXED, and redacted').toBe(`lit-${ref(SLOW_ID)}-tail`);
    expect(result.outputs, 'the summary prints the redacted literal').toEqual({
      Literal: `lit-${ref(SLOW_ID)}-tail`,
    });
    expect(
      [...warn.mock.calls, ...engineWarn.mock.calls].flat().join('\n'),
      'no warning, resolver or engine, carries the plaintext'
    ).not.toContain(valueOf(SLOW_ID));
  });

  it('the no-change path prints its kept bag redacted, as its save writes it', async () => {
    // A released drain leaves an output unresolved, so this path keeps the
    // PREVIOUS deploy's bag -- which here holds a literal nothing resolved
    // then. The auto-refresh capture is the wait the late recording lands in.
    concurrentDrainCap.ms = 20;
    const slow = gate();
    const capture = gate();
    control.holds.set(SLOW_ID, slow.promise);
    control.fails.add(FAIL_ID);
    const literal = `lit-${valueOf(SLOW_ID)}-tail`;
    const existing = {
      version: 10,
      stackName,
      region: 'us-east-1',
      resources: {
        Res: { physicalId: 'res-phys', resourceType: 'AWS::SQS::Queue', properties: { QueueName: 'q' } },
      },
      outputs: { Literal: literal },
      exportNames: [],
      lastModified: 0,
    } as unknown as StackState;
    const { engine, provider, stateBackend, warn } = buildEngine(
      () => capture.promise.then(() => undefined),
      existing
    );
    const template: CloudFormationTemplate = {
      Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
      Outputs: {
        Failing: { Value: { 'Fn::Join': ['', [ref(SLOW_ID), ref(FAIL_ID)]] } },
        Literal: { Value: literal },
      },
    };

    const run = engine.deploy(stackName, template);
    await until(() => abandonedReports(warn).length > 0, 'the cap to release the Failing output');
    expect(provider.readCurrentState, 'the auto-refresh capture must be what holds the save').toHaveBeenCalled();
    expect(stateBackend.saveState, 'the save must not have run yet').not.toHaveBeenCalled();
    expect(control.events, 'the held part must not have recorded yet').not.toContain(
      `record:${SLOW_ID}`
    );
    slow.open();
    await until(() => control.events.includes(`record:${SLOW_ID}`), 'the late recording');
    await settleTurn();
    capture.open();
    const result = await run;

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.outputs['Literal'], 'the save re-redacts the kept bag').toBe(`lit-${ref(SLOW_ID)}-tail`);
    expect(result.outputs, 'the summary prints what the save wrote').toEqual({
      Literal: `lit-${ref(SLOW_ID)}-tail`,
    });
  });

  it("a reused engine does not carry the previous deploy's outputs-pass secrets into the next", async () => {
    // Every redaction re-reads the pass maps, so the list of them must start
    // empty per deploy like the bag it feeds: otherwise a literal output that
    // merely equals a secret an EARLIER deploy resolved would be rewritten,
    // which the outputs redaction deliberately never does.
    const { engine, stateBackend } = buildEngine(() => Promise.resolve(undefined));
    const resources = { Res: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } };

    await engine.deploy(stackName, { Resources: resources, Outputs: { Secret: { Value: ref(SLOW_ID) } } });
    const first = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(first.outputs['Secret'], 'the first deploy must have RECORDED the secret').toBe(ref(SLOW_ID));

    const literal = `lit-${valueOf(SLOW_ID)}-tail`;
    await engine.deploy(stackName, { Resources: resources, Outputs: { Literal: { Value: literal } } });
    const second = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(second.outputs['Literal'], 'nothing THIS deploy resolved recorded it').toBe(literal);
  });
});
