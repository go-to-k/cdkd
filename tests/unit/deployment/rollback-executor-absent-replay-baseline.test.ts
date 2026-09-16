import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * Issue [#3203](https://github.com/go-to-k/cdkd/issues/3203): every replay arm
 * coalesces the desired bag (`desiredProps ?? {}`), and `{}` is NOT a no-op —
 * it is a complete desired state saying "this resource has no properties".
 * `JsonPatchGenerator.generatePatch` emits an `op: 'remove'` for every key the
 * previous side holds and the desired side lacks, and the Cloud Control
 * provider calls it with no empty-desired guard, so the rollback the user
 * asked for STRIPS the live resource. On the reverse-replacement arm the
 * outcome differs and is worse: `{}` creates a default-configured resource and
 * the arm then deletes the live one.
 *
 * Found while the review of go-to-k/cdkd#3149 checked a claim in that PR's own
 * text (which said the bag arrived as `undefined` — it does not; the `??` was
 * measured). That issue refuses at the PARSER the nested shapes no handling
 * can make correct, and deliberately leaves PRESENCE to the state boundary,
 * which tolerates such a record so the recovery commands can still read it.
 * So an ABSENT bag is skipped HERE rather than refused there; a PRESENT but
 * unusable one is REFUSED here too, which keeps the journal.
 *
 * Where the shape comes from, corrected in review: `properties` has been
 * required since schema v1, but "cdkd never writes this shape" is FALSE --
 * the `reverse-replacement-readopt` arm writes `op.previousState` into
 * `state.json` verbatim, so a properties-less record is cdkd's own output on
 * that path. It sends no desired bag to a provider, which is why it is
 * go-to-k/cdkd#3211's class and deliberately unguarded here. A hand-edited or
 * planted record is the OTHER producer, not the only one.
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

// The skip is reported through `warn` — capturing the wrong channel is how a
// message assertion silently becomes vacuous.
const warnLines: string[] = [];
// `info` is captured for the ORDERING, not for its text: each arm announces the
// restore it is about to perform (`Restoring X`, `force-reverting failed UPDATE
// of X`), and every guard must sit ABOVE that line so the operator never reads
// an announcement the next line retracts. Round 3 moved the `revert` arm's
// guard for that reason and round 6 the `--revert-failed` arm's, but with
// `info` uncaptured BOTH moves were 0 red across `tests/unit/` — measured, and
// the reason this twin of `warnLines` exists at all.
const infoLines: string[] = [];
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

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: QUEUE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

/** A previous-state record with NO `properties` key at all. */
function prevWithoutProperties(physicalId = 'phys'): ResourceState {
  const { properties: _dropped, ...rest } = res({ physicalId });
  return rest as ResourceState;
}

function makeCtx(provider: Record<string, unknown>): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  };
}

beforeEach(() => {
  warnLines.length = 0;
  infoLines.length = 0;
});

describe('a replay arm refuses an ABSENT desired bag instead of sending {} (issue #3203)', () => {
  it('revert (UPDATE): does not call provider.update with an empty desired state', async () => {
    const update = vi.fn();
    const ctx = makeCtx({ update });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Q',
        changeType: 'UPDATE',
        resourceType: QUEUE,
        physicalId: 'phys',
        previousState: prevWithoutProperties(),
      },
    ];
    const state = { Q: res({ properties: { DelaySeconds: '30' } }) };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(update).not.toHaveBeenCalled();
    expect(result.warnings).toBe(1);
    // NOT a failure: `failures` blocks the journal-segment pop, which would
    // leave the user retrying a rollback that can never succeed (there is no
    // baseline to succeed FROM). Unpinned, a stray `failures++` beside the
    // `warnings++` was measured 0 red.
    expect(result.failures).toBe(0);
    const warn = warnLines.join('\n');
    expect(warn).toContain('Cannot restore Q');
    expect(warn).toContain('has no `properties` bag');
    // Route-NEUTRAL: the patch route removes every property, but an SDK
    // provider may reset a subset or replace the resource instead
    // (`IAMRoleProvider` derives `newRoleName` from this bag).
    expect(warn).toContain('a patch provider removes every property');
    expect(warn).toContain('an SDK provider may reset a subset or replace the resource');
    // The remedy is pinned as a WHOLE and against the sibling arm's wording.
    // `toContain('cdkd deploy')` alone was measured 0 red: the
    // `--revert-failed` remedy ALSO contains `cdkd deploy`, so this arm could
    // carry that arm's two-part drift remedy with the suite green -- the
    // round-2 BLOCKER's own class (an arm-blind remedy), one field over from
    // where round 4 fixed it.
    expect(warn).not.toContain('cdkd drift');
    // The WHOLE skip sentence, for the same reason the throw is pinned as a
    // unit above. It also catches a defect the needles could not: with an
    // arm's `consequence` substituted, the earlier `Replaying an empty desired
    // state would ${consequence}` rendered "Replaying ... would be applied as
    // a complete desired state", whose gerund subject cannot "be applied" and
    // whose clause is circular. Round 10 fixed that framing in the throw and
    // left the warn; nothing here would have caught it.
    expect(warn).toContain(
      'Rollback: Cannot restore Q — its recorded previous state has no `properties` bag, so ' +
        'there is nothing to restore it to. An empty desired state would be applied as a ' +
        'complete desired state: a patch provider removes every property, and an SDK provider ' +
        'may reset a subset or replace the resource. The resource is therefore left exactly as ' +
        'it is. Re-run `cdkd deploy` to re-converge it.'
    );
    // The record is left untouched: this arm restores or it does nothing.
    expect(state['Q']!.properties).toEqual({ DelaySeconds: '30' });
    // GUARD PLACEMENT: the guard sits ABOVE the `Restoring ...` announcement,
    // so nothing is announced and then retracted. Moving it back below that
    // line was measured 0 red until this assertion existed.
    expect(infoLines.join('\n')).not.toContain('Restoring Q');
  });

  it('reverse-replacement: creates nothing and deletes nothing', async () => {
    // The worse outcome of the two: `{}` would CREATE a default-configured
    // resource and the arm would then DELETE the live one.
    const create = vi.fn();
    const del = vi.fn();
    const ctx = makeCtx({ create, delete: del });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Q',
        changeType: 'UPDATE',
        resourceType: QUEUE,
        physicalId: 'phys-new',
        previousState: prevWithoutProperties('phys-old'),
        oldResourceRetained: false,
      },
    ];
    const state = { Q: res({ physicalId: 'phys-new', properties: { DelaySeconds: '30' } }) };

    const result = await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });

    expect(create).not.toHaveBeenCalled();
    // `create` is asserted first and always fails first without the guard, so
    // this second assertion carries no discriminating power on its own -- it
    // is here because "creates nothing AND deletes nothing" is the claim.
    expect(del).not.toHaveBeenCalled();
    expect(result.warnings).toBe(1);
    expect(result.failures).toBe(0);
    const warn = warnLines.join('\n');
    expect(warn).toContain('create a default-configured resource and then delete the live one');
    // This arm's remedy was asserted NOWHERE and deleting it entirely measured
    // 0 red -- a user-facing next step could be removed with the suite green.
    expect(warn).toContain('Re-run `cdkd deploy` to re-converge it.');
    expect(warn).not.toContain('cdkd drift');
    // The live resource keeps its identity in state.
    expect(state['Q']!.physicalId).toBe('phys-new');
    // Same placement rule on this arm -- but the needle must be THIS arm's own
    // announcement. The first spelling reused `Restoring Q`, which this arm
    // never logs (it says `Reversing replacement of ...`), so the assertion was
    // vacuous and moving the guard back below the announce line stayed 0 red:
    // the hole round 8 closed on two arms, left open on the third. Measured.
    expect(infoLines.join('\n')).not.toContain('Reversing replacement of Q');
  });

  it('revert-failed: skips the op and STILL processes the rest of the pass', async () => {
    // `break`, not `return`: this arm sits inside the failed-op loop, so one
    // unrestorable op must not end the pass.
    //
    // ORDER IS LOAD-BEARING and the first draft of this case had it wrong,
    // measured by a 0-red mutation row: `replayFailedOperations` iterates in
    // REVERSE (`for (let i = failedOps.length - 1; i >= 0; i--)`), so the
    // op placed LAST is processed FIRST. With the bad op first in the array
    // the good one had already been replayed before the mutant returned, and
    // the case passed under both spellings.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-2' });
    const ctx = makeCtx({ update });
    const failed: FailedOperation[] = [
      {
        logicalId: 'Good',
        changeType: 'UPDATE',
        resourceType: QUEUE,
        physicalId: 'phys-2',
        previousState: res({ physicalId: 'phys-2', properties: { DelaySeconds: '10' } }),
        attemptedProperties: { DelaySeconds: '60' },
      },
      // LAST = processed FIRST (see the note above).
      {
        logicalId: 'Bad',
        changeType: 'UPDATE',
        resourceType: QUEUE,
        physicalId: 'phys',
        previousState: prevWithoutProperties(),
        attemptedProperties: { DelaySeconds: '60' },
      },
    ];
    const state = {
      Bad: res({ properties: { DelaySeconds: '30' } }),
      Good: res({ physicalId: 'phys-2', properties: { DelaySeconds: '60' } }),
    };

    const result = await replayFailedOperations(failed, state, 'S', ctx);

    expect(warnLines.join('\n')).toContain('Cannot restore Bad');
    expect(result.warnings).toBe(1);
    expect(result.failures).toBe(0);
    // This arm's remedy is NOT `cdkd deploy`: the op died mid-flight, so the
    // remote state is unknown, and `cdkd diff` compares the template against
    // `state.properties` rather than an AWS readback -- a half-applied
    // resource shows no change and is never re-converged.
    // Pinned as a WHOLE: `toContain('cdkd drift')` alone leaves the second
    // clause deletable at 0 red, and that clause is the half naming what
    // actually re-converges the resource.
    expect(warnLines.join('\n')).toContain(
      'Inspect it with `cdkd drift` (this op died mid-flight, so its remote state is unknown) and re-converge with `cdkd drift --revert` or `cdkd deploy`.'
    );
    // The SECOND op was still replayed — the `break`-vs-`return` discriminator.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toBe('Good');
    // GUARD PLACEMENT on the `--revert-failed` arm, whose announcement also
    // asserts the remote state is unknown. `Bad` must never be announced; the
    // restorable `Good` op still is, which is what keeps this from passing
    // merely because nothing was logged.
    expect(infoLines.join('\n')).not.toContain('force-reverting failed UPDATE of Bad');
    expect(infoLines.join('\n')).toContain('force-reverting failed UPDATE of Good');
  });

  it.each([
    // `typeof null` is `'object'`, so the message rendered the one shape every
    // doc names as `null` under the wrong word -- and the first draft of this
    // table PINNED that mistake. The review measured it.
    ['null', null, 'null'],
    ['a string', 'abc', 'a string'],
    ['an array', [], 'an array'],
  ])(
    'REFUSES (does not skip) a previousState.properties that is %s, keeping the journal',
    async (_l, bag, shown) => {
      // `=== undefined` was the WRONG predicate and a 0-red mutation row said
      // so: `null ?? {}` is `{}`, so a null bag reaches the provider as an
      // empty desired state exactly as an absent one does, and a string /
      // array bag reaches it VERBATIM. go-to-k/cdkd#3149 refuses these for a
      // JOURNAL-sourced record at the parser -- but `previousState` is equally
      // often STATE-sourced, and `parseStateBody` validates no inner shape.
      //
      // The DISPOSITION differs from the absent case, and the seam is what the
      // record holds: here content EXISTS and only its shape is wrong, so the
      // journal is the only durable copy of something an operator can repair.
      // Failing keeps the segment from popping (`failures` blocks the pop),
      // which is what `refuseMaskedReplayBaseline` does for the same class.
      const update = vi.fn();
      const ctx = makeCtx({ update });
      const prev = { ...res(), properties: bag } as unknown as ResourceState;
      const ops: CompletedOperation[] = [
        {
          logicalId: 'Q',
          changeType: 'UPDATE',
          resourceType: QUEUE,
          physicalId: 'phys',
          previousState: prev,
        },
      ];
      const state = { Q: res({ properties: { DelaySeconds: '30' } }) };

      const result = await replayRollback(ops, state, 'S', ctx);

      expect(update).not.toHaveBeenCalled();
      expect(result.failures).toBe(1);
      expect(result.warnings).toBe(0);
      const warn = warnLines.join('\n');
      // The WHOLE rendered sentence, not a handful of needles. Every review
      // round from 4 to 11 found the PREVIOUS round's message fix unpinned --
      // the retry phrase, then the remedy, then the throw's two-disjunct
      // framing, each measured 0 red one phrase after the last one was closed.
      // Chasing that with another `toContain` only moves the gap along, so the
      // message is pinned as a unit: any reword reds here and the author
      // decides whether the new wording is right.
      //
      // The framing is load-bearing, not styling: `consequence` describes the
      // EMPTY-bag outcome, while this throw also fires for a string / array,
      // which reach a provider VERBATIM. Reverting to `Replaying it would
      // ${consequence}.` restores both the round-8 over-claim and the colon
      // swallow, and was measured 0 red before this assertion existed.
      expect(warn).toContain(
        `Cannot roll Q back: its recorded previous state has a \`properties\` field that is not ` +
          `a property bag (${shown}), so cdkd cannot tell what to restore it to. Replaying it ` +
          `would do one of two things, and cdkd does neither: send the malformed value to the ` +
          `provider as-is, or send an empty desired state (which would be applied as a complete ` +
          `desired state: a patch provider removes every property, and an SDK provider may reset ` +
          `a subset or replace the resource). The rollback JOURNAL record is kept: once that ` +
          `record holds a property bag again, re-running \`cdkd rollback\` retries this op. ` +
          `Otherwise fix forward with \`cdkd deploy\`, or remove the stack with \`cdkd destroy\`.`
      );
      // The CONSEQUENCE is the helper's only per-arm argument, and deleting it
      // from the throw was measured 0 red: pinned in the skip direction at two
      // arms, in the refuse direction nowhere, so this arm could have carried
      // another arm's wording with the suite green.
      expect(warn).toContain('a patch provider removes every property');
      // The retry that actually works on THIS arm -- a plain `cdkd rollback`.
      expect(warn).toContain('re-running `cdkd rollback` retries this op');
      // The bag's own content never reaches the terminal.
      expect(warn).not.toContain('abc');
    }
  );

  it.each([
    ['reverse-replacement', 'rr'],
    ['revert-failed', 'rf'],
  ])('the %s arm uses the same predicate, not an absence test', async (_label, arm) => {
    // The predicate is fenced by the cases above, but each arm WIRES it
    // separately and narrowing one back to `=== undefined` was measured 0 red
    // across the whole deployment suite -- the same mistake the predicate's
    // own doc says a 0-red row already caught once.
    const update = vi.fn();
    const create = vi.fn();
    const ctx = makeCtx({ update, create, delete: vi.fn() });
    const prev = { ...res({ physicalId: 'phys-old' }), properties: null } as unknown as ResourceState;

    if (arm === 'rr') {
      const ops: CompletedOperation[] = [
        {
          logicalId: 'Q',
          changeType: 'UPDATE',
          resourceType: QUEUE,
          physicalId: 'phys-new',
          previousState: prev,
          oldResourceRetained: false,
        },
      ];
      const state = { Q: res({ physicalId: 'phys-new', properties: { DelaySeconds: '30' } }) };
      const result = await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });
      expect(create).not.toHaveBeenCalled();
      expect(result.failures).toBe(1);
    } else {
      const failed: FailedOperation[] = [
        {
          logicalId: 'Q',
          changeType: 'UPDATE',
          resourceType: QUEUE,
          physicalId: 'phys',
          previousState: prev,
          attemptedProperties: { DelaySeconds: '60' },
        },
      ];
      const state = { Q: res({ properties: { DelaySeconds: '30' } }) };
      const result = await replayFailedOperations(failed, state, 'S', ctx);
      expect(update).not.toHaveBeenCalled();
      expect(result.failures).toBe(1);
    }
    const warn = warnLines.join('\n');
    expect(warn).toContain('not a property bag');
    // Each arm's own consequence, for the same reason as above -- the
    // reverse-replacement arm creates-then-deletes rather than stripping.
    expect(warn).toContain(
      arm === 'rr'
        ? 'create a default-configured resource and then delete the live one'
        : 'a patch provider removes every property'
    );
    // The failed-op arm's retry NEEDS the flag: a plain `cdkd rollback` there
    // replays only the completed ops and pops the whole segment, discarding
    // the record this refusal preserved. Asserted for BOTH arms rather than
    // only `rf`: gated on `rf` alone, rewriting the reverse-replacement arm's
    // phrase to the `--revert-failed` one was 0 red (the review measured it),
    // so the flag could have spread to an arm a plain re-run does retry.
    expect(warn).toContain(
      arm === 'rf'
        ? '`cdkd rollback --revert-failed` retries this op'
        : 're-running `cdkd rollback` retries this op'
    );
  });

  it('a PRESENT but empty bag is still replayed: absent and empty are different states', async () => {
    // The distinction the guard must keep. `properties: {}` on a resource that
    // really has none is a legitimate desired state the operator recorded;
    // only ABSENCE means "cdkd never recorded one".
    //
    // What this case discriminates, MEASURED rather than assumed: a predicate
    // that also required the bag to be non-EMPTY (`Object.keys(bag).length > 0`)
    // reds this case. It is NOT the only case that reds -- across the whole
    // `tests/unit/` that mutant measures 12, spread over FOUR replay suites
    // (this one, `replay-fallback-name`, `stateful-warn` and
    // `name-collision-route`), all of which replay recorded bags that are empty
    // or become empty. An earlier comment claimed "here alone", which was true
    // only of this FILE; a second one named a single other suite, which review
    // showed could supply at most 7 of the 11 OTHER cases (12 total minus the
    // one in this file) -- the attribution is now taken from the probe's own
    // named cases rather than guessed. That comment also
    // claimed the mutant caught a FALSINESS predicate, which it does not,
    // since `Boolean({})` is `true`. The falsiness mutant is caught by the
    // string and array rows above instead.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys' });
    const ctx = makeCtx({ update });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Q',
        changeType: 'UPDATE',
        resourceType: QUEUE,
        physicalId: 'phys',
        previousState: res({ properties: {} }),
      },
    ];
    const state = { Q: res({ properties: { DelaySeconds: '30' } }) };

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[3]).toEqual({});
    expect(result.warnings).toBe(0);
    expect(warnLines.join('\n')).not.toContain('Cannot restore');
  });
});
