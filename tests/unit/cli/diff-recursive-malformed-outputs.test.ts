/**
 * WIRING for issue go-to-k/cdkd#3189: `cdkd diff` repairs a malformed
 * `StackState.outputs` bag AT THE LOAD and says so.
 *
 * The analyzer suite proves `computeOutputsDiff` no longer fabricates from a
 * non-map bag. That is the second line of defence, and it cannot cover this
 * one: `loadStateOrEmpty` is the only point in the diff flow that every
 * consumer of the stored bag sits below — `resolveTemplateOutputs`'s
 * stored-key lookups (go-to-k/cdkd#2740's skipped-output record,
 * go-to-k/cdkd#1942's literal `Export.Name` verdict), `mergeNoChangeOutputs`'s
 * `persisted`, and only then the two walks that emit rows. A guard at the walk
 * leaves a wrong lookup, or a raw `TypeError`, one call above it.
 *
 * So these cases enter through `buildDiffTree`, which is what `cdkd diff` calls
 * and what routes through the load.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

import { getLogger } from '../../../src/utils/logger.js';
import { buildDiffTree } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { skippedOutputDigest } from '../../../src/analyzer/skipped-outputs.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const STACK = 'S';
const REGION = 'us-east-1';

function template(): CloudFormationTemplate {
  return {
    Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    Outputs: { Endpoint: { Value: 'https://endpoint' } },
  };
}

/** A record whose `resources` bag is HEALTHY — only `outputs` is under test. */
function record(outputs: unknown, extra: Partial<StackState> = {}): StackState {
  return {
    stackName: STACK,
    region: REGION,
    version: 10,
    resources: {
      A: {
        physicalId: 'pid',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: 'x' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: outputs as StackState['outputs'],
    lastModified: 0,
    ...extra,
  };
}

function backendHolding(states: Record<string, StackState>): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'fake' } : null;
    },
  } as unknown as S3StateBackend;
}

async function diff(
  state: StackState,
  tpl: CloudFormationTemplate = template(),
  extra: { children?: Record<string, StackState>; recursive?: boolean } = {}
) {
  return buildDiffTree({
    stackName: STACK,
    displayName: STACK,
    region: REGION,
    template: tpl,
    nestedTemplates: {},
    recursive: extra.recursive ?? false,
    stateBackend: backendHolding({ [STACK]: state, ...(extra.children ?? {}) }),
    diffCalculator: new DiffCalculator(),
    isNestedChild: false,
  });
}

/** Every `warn` line this run emitted, joined — the warnings are one per call. */
function warnings(): string {
  return (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((args) => String(args[0]))
    .join('\n');
}

describe('cdkd diff over a malformed outputs bag (issue go-to-k/cdkd#3189)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invents no REMOVE row from a string, and previews the template output as an ADD', async () => {
    // Measured at `aced052a`, before the guard: six REMOVE rows named "0".."5",
    // each carrying one character of the record as its `old:` side, and
    // `cdkd diff --fail` exiting 1 on them.
    const node = await diff(record('SECRET-abcdef'));
    // The row list IS the whole assertion here, and it is the discriminator:
    // unguarded this is 14 rows (`ADD:Endpoint` plus one `REMOVE` per character
    // of the planted value), each REMOVE carrying one of those characters as
    // its `old:` side.
    //
    // No stored-value canary beside it, deliberately. The one that stood here
    // could not fail: this case's only surviving row is an ADD, and the ADD
    // branch never sets `oldValue`, so the join is empty whatever the guard
    // does — and under a both-guards-removed probe the row-list assertion above
    // reds first and the canary never executes (review of go-to-k/cdkd#3194).
    // The layer where that canary IS falsifiable is the pure function; it lives
    // in `tests/unit/analyzer/outputs-diff.test.ts`, where a case can put
    // REMOVE rows on the broken side.
    expect(node.outputChanges.map((c) => [c.name, c.changeType])).toEqual([
      ['Endpoint', 'ADD'],
    ]);
  });

  it('invents no REMOVE row from a list either', async () => {
    const node = await diff(record(['one', 'two', 'three']));
    expect(node.outputChanges.map((c) => c.changeType)).toEqual(['ADD']);
  });

  it('WARNS, naming the stack, the container and what continuing empty means', async () => {
    await diff(record('abcdef'));
    const text = warnings();
    // `shellQuote` leaves a shell-safe identifier unquoted, so these are the
    // rendered bytes rather than a guess at the helper's output.
    expect(text).toContain(`State for S (us-east-1) has no readable 'outputs' map`);
    expect(text).toContain('is reported as an ADD');
    expect(text).toContain(`cdkd state show S --stack-region us-east-1 --json`);
    // The RESOURCES warning must NOT fire: that bag is healthy, and its text
    // tells the reader not to run `cdkd deploy` / `cdkd destroy`, which would
    // be false advice about a record whose resource map is intact.
    expect(text).not.toContain(`has no readable 'resources' map`);
  });

  it('warns about BOTH containers when both are malformed, once each', async () => {
    // A record can be malformed in either alone, so the two repairs are
    // independent; this pins that neither swallows the other.
    const node = await diff(
      record('abcdef', { resources: 'xy' as unknown as StackState['resources'] })
    );
    const text = warnings();
    expect(text).toContain(`has no readable 'outputs' map`);
    expect(text).toContain(`has no readable 'resources' map`);
    expect(getLogger().warn).toHaveBeenCalledTimes(2);
    // Each container reads as empty independently: no fabricated resource row
    // from `"xy"`, and every template resource previews as a CREATE — the
    // behaviour `docs/cli-diff.md` states for the repaired `resources` bag.
    expect([...node.changes.values()].map((c) => [c.logicalId, c.changeType])).toEqual([
      ['A', 'CREATE'],
    ]);
  });

  it('does NOT throw on a null bag whose stack carries a skipped-output record', async () => {
    // The half a walk-site guard cannot reach. `resolveTemplateOutputs` asks
    // `hasOwnProperty.call(storedOutputs, key)` for the go-to-k/cdkd#2740
    // record, and `null` passes its `!== undefined` gate and THROWS
    // `Cannot convert undefined or null to object` — a bare TypeError naming no
    // stack, key or remedy, from the command a user reaches for when state is
    // broken. Repaired at the load, the record binds and the key previews as
    // absent.
    const tpl = template();
    const state = record(null, {
      skippedOutputs: { Endpoint: skippedOutputDigest(tpl, 'Endpoint') },
    });
    const node = await diff(state, tpl);
    expect(node.outputChanges).toEqual([]);
    expect(warnings()).toContain(`has no readable 'outputs' map`);
  });

  /**
   * The `exportNames` FIELD (issue go-to-k/cdkd#3192) — the tenth site of that
   * class, and NOT an `outputs` bag at all, which is why the guard at this
   * load does not reach it and the comment beside that guard says so.
   *
   * `importableOutputKeys` in `src/types/state.ts` called
   * `state.exportNames.filter(...)` unconditionally, so a hand-edited
   * non-array threw `TypeError: state.exportNames.filter is not a function` —
   * a bare TypeError naming no stack, field or remedy, from `cdkd diff`, at
   * base AND at go-to-k/cdkd#3194's head. It is guarded where it is READ
   * rather than here, because that helper is also reached from the exports
   * index, the deploy-time resolver and the local-command loader, none of
   * which passes through this load.
   *
   * The fixture is the issue's own repro: a readable outputs bag, a broken
   * `exportNames`, a template carrying a `Conditions` block and an output that
   * cannot resolve — which is what routes the diff through
   * `mergeNoChangeOutputs`, whose `previousExportNames` argument is the call
   * that threw.
   */
  describe('a malformed `exportNames` (issue go-to-k/cdkd#3192)', () => {
    /** Unresolvable output + a Conditions block, no resource change. */
    function mergeReachingTemplate(): CloudFormationTemplate {
      return {
        Conditions: { Never: { 'Fn::Equals': ['a', 'b'] } },
        Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
        Outputs: {
          // `Fn::GetAtt` to a logical id the template does not declare: the
          // resolver returns no value and the diff reports `resolutionFailed`,
          // which is the branch that calls `mergeNoChangeOutputs`.
          Endpoint: { Value: { 'Fn::GetAtt': ['Missing', 'Arn'] } },
        },
      } as unknown as CloudFormationTemplate;
    }

    for (const [label, names] of [
      ['a string', 'abc'],
      ['null', null],
      ['a number', 5],
      ['an object', { Good: true }],
    ] as const) {
      it(`does not die with a bare TypeError when exportNames is ${label}`, async () => {
        const state = record({ Good: 'g' }, {
          exportNames: names as unknown as string[],
        });
        // The assertion is that the command COMPLETES. Pre-fix this rejected
        // with `state.exportNames.filter is not a function`, so a
        // `rejects.toThrow()` would have been the passing shape — asserting a
        // resolved value is what discriminates.
        const node = await diff(state, mergeReachingTemplate());
        expect(node).toBeDefined();
        // ...and the corrupt set is read as EMPTY, never as UNKNOWN. Falling
        // back to the pre-v9 every-key rule would make `Good` an export again,
        // which is the binding issue #2193 exists to close.
        expect(
          node.outputChanges.filter((c) => c.isExport).map((c) => c.name),
          'a corrupt exportNames was read as the legacy every-key rule'
        ).toEqual([]);
        // ...and it SAYS so. Reading the set as empty is the safe answer, but
        // a silently-safe answer over a record the operator can repair is a
        // loud failure turned quiet -- the regression review round 1 named.
        // `cdkd diff` is the caller that holds the stack identity, so it is
        // the one that warns; the shared predicate stays silent.
        //
        // Added in review round 10 (go-to-k/cdkd#3206): until then NOTHING
        // asserted this warning ever fires. The guard was watched from one
        // side only -- dropping its `isReadableBag` conjunct reds the
        // absent-bag floor below -- so mutating the whole guard to
        // `if (false)` left ZERO reds.
        expect(warnings(), `no warning named the damaged exportNames (${label})`).toContain(
          `has an unusable 'exportNames' list`
        );
        expect(warnings()).toContain(STACK);
      });
    }

    it('FLOOR: a healthy exportNames still marks its key as an export', async () => {
      // Without this the case above is one-sided — an implementation that
      // returned `[]` for every record would satisfy it. The template declares
      // the export, so the row is tagged from the RESOLVED side; the stored
      // set is what the merge path reads.
      const tpl = {
        Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
        Outputs: {
          Endpoint: { Value: 'https://endpoint', Export: { Name: 'S-Endpoint' } },
        },
      } as unknown as CloudFormationTemplate;
      const node = await diff(record({}, { exportNames: [] }), tpl);
      expect(node.outputChanges.filter((c) => c.isExport).map((c) => c.name)).toEqual([
        'S-Endpoint',
      ]);
    });
  });

  it('FLOOR: a healthy bag diffs exactly as before and says NOTHING', async () => {
    // The other side of the fence. A repair that fired on every record would
    // satisfy every assertion above while destroying the ordinary diff.
    const node = await diff(record({ Endpoint: 'https://old', Gone: 'g' }));
    expect(node.outputChanges.map((c) => [c.name, c.changeType])).toEqual([
      ['Endpoint', 'MODIFY'],
      ['Gone', 'REMOVE'],
    ]);
    expect(node.outputChanges.find((c) => c.name === 'Gone')?.oldValue).toBe('g');
    expect(getLogger().warn).not.toHaveBeenCalled();
  });

  it('FLOOR: an unchanged healthy bag reports no delta and no warning', async () => {
    const node = await diff(record({ Endpoint: 'https://endpoint' }));
    expect(node.outputChanges).toEqual([]);
    expect(getLogger().warn).not.toHaveBeenCalled();
  });

  it('FLOOR: an ABSENT bag is read as empty SILENTLY — a record cdkd itself writes', async () => {
    // The one shape exempted from the repair, and the exemption has to be
    // fenced from the WIRING too: `cdkd scrub` round-trips a record with no
    // `outputs` deliberately, and the deploy's failure-path saves drop the key
    // when it is undefined, so a warning here would fire on healthy state.
    // Rows are unaffected — every consumer on this path already carries its own
    // `?? {}`.
    const state = record(undefined);
    const node = await diff(state);
    expect(node.outputChanges.map((c) => [c.name, c.changeType])).toEqual([
      ['Endpoint', 'ADD'],
    ]);
    expect(getLogger().warn).not.toHaveBeenCalled();
    // ...and the record is not given a bag it did not have.
    expect(state.outputs).toBeUndefined();
  });

  it('a DELETED nested child with a malformed bag: no phantom rows, warning names the CHILD', async () => {
    // `buildDeletedSubtree` is the one path where `REMOVE` rows are the
    // EXPECTED output — the child is diffed against an empty template, so every
    // persisted key legitimately removes. That makes it the path where a
    // fabricated row is hardest to spot, and it enters through a second
    // `loadStateOrEmpty` call of its own.
    //
    // It also covers the per-node claim `docs/cli-diff.md` makes: a healthy
    // parent sits above a malformed child, and the warning names the stack it
    // came from.
    const parent = record({ Endpoint: 'https://endpoint' });
    parent.resources['Child'] = {
      physicalId: 'child-pid',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: {},
      attributes: {},
      dependencies: [],
    };
    const child = record('abcdef');
    child.stackName = `${STACK}~Child`;

    const node = await diff(parent, template(), {
      recursive: true,
      children: { [`${STACK}~Child`]: child },
    });

    // The parent is healthy: unchanged outputs, and its own record says nothing.
    expect(node.outputChanges).toEqual([]);
    const childNode = node.children.find((c) => c.stackName === `${STACK}~Child`);
    expect(childNode).toBeDefined();
    // Against an EMPTY template the child's stored keys would all REMOVE — and
    // with an unreadable bag there are none to remove, rather than six invented
    // ones.
    expect(childNode!.outputChanges).toEqual([]);

    const text = warnings();
    // QUOTED, unlike the parent's bare `S`: `shellQuote` keeps `~` out of its
    // unquoted class on purpose, because an unquoted leading `~` in the pasted
    // remedy is tilde expansion on a bucket-plantable value. These are the
    // rendered bytes, not a guess at the helper's output.
    expect(text).toContain(`State for '${STACK}~Child' (us-east-1) has no readable 'outputs' map`);
    // Named per node: the parent's own name never appears as the subject of an
    // outputs warning, so a reader can tell which record is damaged.
    expect(text).not.toContain(`State for ${STACK} (us-east-1) has no readable 'outputs' map`);
    expect(getLogger().warn).toHaveBeenCalledTimes(1);
  });
});
