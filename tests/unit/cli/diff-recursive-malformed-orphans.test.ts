/**
 * Issue go-to-k/cdkd#3379, diff half — the `orphans` CONTAINER, one level above
 * the ENTRY guard `diff-recursive-malformed-properties.test.ts` covers.
 *
 * `cdkd diff` cannot WRITE state, so the answer here is the repair-and-report
 * half rather than a refusal, exactly as it is for the `resources` bag and the
 * `outputs` map: replace the container with an empty list on the in-memory
 * record, warn naming the container, and list a stand-in row in the node's
 * `unreadable` so `--json` and the rendered preview both say the view is
 * incomplete.
 *
 * AT THE LOAD, and the string shape is why. The adoption gate is
 * `currentState.orphans?.length && options.previewOrphanAdoption`, and
 * `'abc'.length` is 3 — so the gate PASSES for a string and the walk below it
 * reads characters as orphan records. A guard written at the gate would sit
 * under the dereference that already lied.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

import { getLogger } from '../../../src/utils/logger.js';
import { buildDiffTree, diffTreeToJson, renderDiffTree } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { UNREADABLE_ORPHANS_CONTAINER_ROW } from '../../../src/state/malformed-resources-bag.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const STACK = 'DiffStack';
const REGION = 'us-east-1';

const template: CloudFormationTemplate = {
  Resources: { Keep: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
};

function record(orphans: unknown): StackState {
  return {
    stackName: STACK,
    region: REGION,
    version: 10,
    resources: {
      Keep: { physicalId: 'p', resourceType: 'AWS::SSM::Parameter', properties: { Value: 'x' } },
    },
    outputs: {},
    orphans: orphans as StackState['orphans'],
    lastModified: 0,
  };
}

async function diff(state: StackState, previewOrphanAdoption?: () => never) {
  return buildDiffTree({
    stackName: STACK,
    displayName: STACK,
    region: REGION,
    template,
    nestedTemplates: {},
    recursive: false,
    stateBackend: {
      getState: async (name: string) => (name === STACK ? { state, etag: 'fake' } : null),
    } as unknown as S3StateBackend,
    diffCalculator: new DiffCalculator(),
    isNestedChild: false,
    ...(previewOrphanAdoption && {
      previewOrphanAdoption:
        previewOrphanAdoption as unknown as Parameters<typeof buildDiffTree>[0]['previewOrphanAdoption'],
    }),
  });
}

function warnings(): string {
  return (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((args) => String(args[0]))
    .join('\n');
}

describe('cdkd diff over an unreadable orphans container (go-to-k/cdkd#3379)', () => {
  beforeEach(() => vi.clearAllMocks());

  const MALFORMED: Array<[string, unknown]> = [
    ['a string container', 'abc'],
    ['a number container', 5],
    ['a plain object container', {}],
    ['an object carrying length', { length: 1 }],
    ['a null container', null],
  ];

  for (const [label, orphans] of MALFORMED) {
    it(`reports ${label} and still diffs the stack`, async () => {
      const node = await diff(record(orphans));
      // It REPORTED rather than threw: `cdkd diff` is the command a user runs
      // to inspect a record like this one.
      expect(node.unreadable).toContain(UNREADABLE_ORPHANS_CONTAINER_ROW);
      expect(warnings()).toContain("'orphans'");
      // And the rest of the record still diffed — the resources bag is intact.
      expect(node.stackName).toBe(STACK);
    });
  }

  it('repairs BEFORE the adoption preview, so a string container never reaches it', async () => {
    // The preview throws if it is reached at all. Unrepaired, `'abc'.length`
    // is 3, so the gate passes and this fires — which is the abort the guard
    // removes, and what makes this case discriminate placement rather than
    // merely verdict.
    const node = await diff(record('abc'), () => {
      throw new Error('previewOrphanAdoption was reached with an unreadable container');
    });
    expect(node.unreadable).toContain(UNREADABLE_ORPHANS_CONTAINER_ROW);
  });

  it('names the container in the row rather than rendering it as a logical id', async () => {
    const node = await diff(record(5));
    // The row is a container stand-in; `displayLogicalId` would quote it as if
    // it were a resource name.
    expect(node.unreadable).toEqual([UNREADABLE_ORPHANS_CONTAINER_ROW]);
  });

  it('renders the stand-in row verbatim and withholds the logical-id sentence', async () => {
    // Two clauses of the renderer, both keyed on the row being a CONTAINER
    // stand-in rather than a logical id: it is not quoted like an id, and the
    // "one the template still declares is shown above as a create" sentence —
    // which is about ids — is suppressed. Without the second, a node whose only
    // row is this container claims the template declares one of them.
    const node = await diff(record('abc'));
    expect(diffTreeToJson(node).unreadable).toEqual([UNREADABLE_ORPHANS_CONTAINER_ROW]);
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    const text = lines.join('\n');
    expect(text).toContain(`1 state record row(s) could not be read: ${UNREADABLE_ORPHANS_CONTAINER_ROW}.`);
    expect(text).not.toContain('shown above as a create');
  });

  it('keeps the logical-id sentence when a REAL id joins the container row', async () => {
    // The suppression is `.every`, not "exactly one container row": a node
    // holding both an unreadable container and a torn resource entry still owes
    // the sentence, because one of its rows IS a logical id. A `.some` here
    // would swallow it.
    const state = record('abc');
    (state.resources as Record<string, unknown>)['Torn'] = null;
    const node = await diff(state);
    expect(node.unreadable).toContain(UNREADABLE_ORPHANS_CONTAINER_ROW);
    expect(node.unreadable).toContain('Torn');
    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    expect(lines.join('\n')).toContain('shown above as a create');
  });

  it('CONTROL: a readable or absent container yields no row and no warning', async () => {
    for (const orphans of [[], undefined]) {
      vi.clearAllMocks();
      const node = await diff(record(orphans));
      expect(node.unreadable).not.toContain(UNREADABLE_ORPHANS_CONTAINER_ROW);
      expect(warnings()).not.toContain("'orphans'");
    }
  });
});

/**
 * Issue go-to-k/cdkd#3500, `cdkd diff` half — the READ-ONLY disposition for a
 * row no reader can use: DROP it and name it, never refuse. `cdkd diff` is the
 * command an operator runs to look at a record they already suspect.
 *
 * What changed here is the VERDICT, not the disposition. The filter used to ask
 * `isReadableResourceEntry(record?.state)` locally, so a row with a healthy
 * `state` and a non-string `logicalId` previewed as an adoption while every
 * writer now refuses it. Both sides read the module's row predicate now.
 */
/**
 * `buildDiffTree` with a preview callback, recording what it was handed. The row
 * pass is gated on `options.previewOrphanAdoption`, so every case here needs one
 * or it measures nothing.
 */
async function diffWithPreview(state: StackState, seen: unknown[] = []) {
  return buildDiffTree({
    stackName: STACK,
    displayName: STACK,
    region: REGION,
    template,
    nestedTemplates: {},
    recursive: false,
    isNestedChild: false,
    stateBackend: {
      getState: async (name: string) => (name === STACK ? { state, etag: 'fake' } : null),
    } as unknown as S3StateBackend,
    diffCalculator: new DiffCalculator(),
    previewOrphanAdoption: (async (previewed: StackState) => {
      seen.push(...(previewed.orphans ?? []));
      return { adopted: {}, refusals: [] };
    }) as unknown as Parameters<typeof buildDiffTree>[0]['previewOrphanAdoption'],
  });
}

describe('cdkd diff drops an unusable orphan ROW rather than refusing (go-to-k/cdkd#3500)', () => {
  beforeEach(() => vi.clearAllMocks());

  const healthy = {
    logicalId: 'Keep',
    orphanedAt: 1,
    state: { physicalId: 'live-keep', resourceType: 'AWS::SQS::Queue', properties: {} },
  };

  it('drops the row the OLD local filter admitted: healthy `state`, non-string id', async () => {
    // The discriminating case for this change, and it has to observe the PREVIEW
    // rather than the report: the names come from `unpreviewableOrphanRecords`,
    // which answers independently of the filter, so asserting only the warning
    // and the `unreadable` row stays green with the filter reverted (maintainer
    // proxy pass). `seen` is what the preview was actually handed. A preview
    // callback is REQUIRED for the row pass to run at all — it is gated on
    // `options.previewOrphanAdoption`.
    const seen: unknown[] = [];
    const node = await diffWithPreview(
      record([healthy, { logicalId: 5, orphanedAt: 1, state: healthy.state }] as unknown),
      seen
    );
    expect(seen, 'the row reached the adoption preview').toEqual([healthy]);
    expect(node.unreadable, 'the row was not named').toHaveLength(1);
    expect(warnings()).toContain('rollback-orphan record');
    // The diagnosis matches THIS caller's predicate: `cdkd diff` keeps a row
    // whose maps are torn, so naming those as a cause would tell the operator to
    // repair something that was not why this row was dropped (go-to-k/cdkd#3500).
    expect(warnings(), "diff's warning names a cause it does not act on").not.toContain(
      "'properties' or 'attributes' map that is not an object"
    );
    // The CONSEQUENCE clause is keyed on the same flag, so it is pinned here too:
    // what the operator loses on THIS command is the adoption preview, and scrub's
    // secret-scan wording would name a pass `cdkd diff` does not run.
    expect(warnings()).toContain('not previewed for adoption');
    expect(warnings(), "diff's warning states scrub's consequence").not.toContain(
      'excluded from the secret scan'
    );
    // Named as the UNRENDERABLE stand-in, not as the number: a non-string id has
    // no honest rendering, and `displayLogicalId` owns that spelling.
    expect(node.unreadable[0]).toBe('');
    expect(node.stackName).toBe(STACK);
  });

  it('KEEPS a row whose `properties` map is torn, because the repair below names it', async () => {
    // The half the writers' predicate would get wrong here. `cdkd diff` runs the
    // `properties` repair a second time over the adopted records — the behaviour
    // `docs/cli-diff.md` and `.claude/rules/state-malformed-properties.md` both
    // describe — so dropping this row would make that report unreachable rather
    // than stricter. Taking the writers' full predicate reds this case.
    const torn = {
      logicalId: 'Torn',
      orphanedAt: 1,
      state: { physicalId: 'live-torn', resourceType: 'AWS::SQS::Queue', properties: 'abcdef' },
    };
    const seen: unknown[] = [];
    // ADOPTING it, not just previewing it: the repair this case credits runs
    // inside `computeStackDiff`'s adopted-records branch, so a callback returning
    // `adopted: {}` pins preservation through the filter and nothing about the
    // repair (maintainer proxy pass, round 2).
    const node = await buildDiffTree({
      stackName: STACK,
      displayName: STACK,
      region: REGION,
      template,
      nestedTemplates: {},
      recursive: false,
      isNestedChild: false,
      stateBackend: {
        getState: async (name: string) =>
          name === STACK ? { state: record([healthy, torn] as unknown), etag: 'fake' } : null,
      } as unknown as S3StateBackend,
      diffCalculator: new DiffCalculator(),
      previewOrphanAdoption: (async (previewed: StackState) => {
        seen.push(...(previewed.orphans ?? []));
        return { adopted: { Torn: torn.state as never }, refusals: [] };
      }) as unknown as Parameters<typeof buildDiffTree>[0]['previewOrphanAdoption'],
    });
    expect(seen, 'the torn-properties row was dropped instead of previewed').toEqual([
      healthy,
      torn,
    ]);
    expect(node.unreadable, 'it was named as unpreviewable, which it is not').toEqual([]);
    // ...and the repair DID reach it: the second `properties` pass names the
    // adopted record it emptied, which is the report dropping the row would have
    // retired.
    // Not a bare `toContain('Torn')` — the id alone is satisfied by ANY warning
    // that happens to name the row, the orphan-ROW warning included, so it would
    // stay green if this row started being reported as unpreviewable instead of
    // repaired. Pin the id INSIDE the properties-repair wording, which only that
    // pass emits.
    const propertiesRepair = warnings()
      .split('\n')
      .filter((line) => line.includes('Continuing with those maps EMPTY'))
      .join('\n');
    expect(
      propertiesRepair,
      'the second `properties` pass never ran over the adopted record'
    ).toContain('Torn');
  });

  it('survives a list too long to SPREAD into `push`, naming every row', async () => {
    // `push(...ids)` passes each element as an ARGUMENT, so past the engine's
    // argument limit it throws a bare `RangeError` naming no field, container or
    // stack — on the command a user runs BECAUSE the record is suspect
    // (go-to-k/cdkd#3500 security review; measured OK at 100k, over at 130k).
    // 200_000 is comfortably past it in both directions, since the limit is not a
    // documented constant. Restoring the spread reds this case.
    const many = Array.from({ length: 200_000 }, (_, i) => ({ logicalId: i, orphanedAt: 1 }));
    const node = await diffWithPreview(record(many as unknown));
    // Every row named, not merely "it did not throw": a `slice` added to dodge the
    // limit would also stop throwing while silently under-reporting.
    expect(node.unreadable).toHaveLength(200_000);
    // ...and the WARNING still caps what it prints, which is the other half.
    // Neither the count nor the overflow fragment pins that on its own — a text
    // naming all 200,000 rows carries both (measured: dropping
    // `namedOrphanRows`'s `.slice` keeps them) — so the BOUND is the assertion,
    // with the two fragments saying what the bounded text must still contain.
    expect(warnings()).toContain('200000 ');
    expect(warnings()).toContain('and 199995 more');
    expect(
      warnings().length,
      'the warning grew with the row count, so it names rows instead of capping'
    ).toBeLessThan(2000);
  }, 60_000);

  for (const [label, tornState] of [
    [
      'a torn `attributes` map',
      { physicalId: 'live', resourceType: 'AWS::SQS::Queue', properties: {}, attributes: 5 },
    ],
    [
      'a torn `properties` map on a row the preview does NOT adopt',
      { physicalId: 'live', resourceType: 'AWS::SQS::Queue', properties: 'abcdef' },
    ],
  ] as const) {
    it(`PREDICTS the deploy refusal for ${label}`, async () => {
      // go-to-k/cdkd#3641 M1. `cdkd diff` KEEPS such a row on purpose — the second
      // `properties` repair names an adopted one — but `cdkd deploy` now refuses
      // the whole record over it, and neither shape was refused at deploy before
      // this lane. Without a blocking reason `cdkd diff --fail` exits 0 and the
      // deploy the operator runs next refuses, which is the contract `cdkd diff`
      // states for the adoption preview.
      //
      // The `attributes` case is the one nothing else can report: the second
      // repair does not touch that map. The `properties` case is the one the
      // second repair MISSES, because it walks adopted records only and this
      // callback adopts nothing.
      const torn = { logicalId: 'Torn', orphanedAt: 1, state: tornState };
      const seen: unknown[] = [];
      const node = await diffWithPreview(record([healthy, torn] as unknown), seen);
      // Kept, not dropped — the narrow predicate is unchanged.
      expect(seen, 'the row was dropped instead of previewed').toHaveLength(2);
      expect(node.unreadable, 'the kept row was named as unpreviewable').toEqual([]);
      // ...and the node SAYS the deploy will refuse, which is what `--fail` counts.
      const reason = node.blocking.find((r) => r.includes('carry a')) ?? '';
      expect(reason, `no deploy-refusal reason for ${label}: ${JSON.stringify(node.blocking)}`).toContain(
        "'properties' or 'attributes' map that cannot be read"
      );
      // The row is NAMED, since no warning names this class: the row is kept, so
      // the drop warning never fires for it.
      expect(reason).toContain('Torn');
      expect(reason).toContain('1 rollback-orphan record(s)');
    });
  }

  it('the deploy-refusal prediction is TOP-LEVEL only, like every other blocking reason', async () => {
    // A nested child's row must not raise exit 3: the deploy skips an unchanged
    // nested-stack row, so a reason there would report a refusal over a deploy
    // that succeeds. `isNestedChild` is the explicit argument that decides it.
    const torn = {
      logicalId: 'Torn',
      orphanedAt: 1,
      state: { physicalId: 'live', resourceType: 'AWS::SQS::Queue', properties: 'abcdef' },
    };
    const child = await buildDiffTree({
      stackName: STACK,
      displayName: STACK,
      region: REGION,
      template,
      nestedTemplates: {},
      recursive: false,
      isNestedChild: true,
      stateBackend: {
        getState: async (name: string) =>
          name === STACK ? { state: record([torn] as unknown), etag: 'fake' } : null,
      } as unknown as S3StateBackend,
      diffCalculator: new DiffCalculator(),
      previewOrphanAdoption: (async () => ({ adopted: {}, refusals: [] })) as unknown as Parameters<
        typeof buildDiffTree
      >[0]['previewOrphanAdoption'],
    });
    expect(
      child.blocking.join('\n'),
      'a nested child raises the deploy-refusal reason, so exit 3 fires for a row the deploy skips'
    ).not.toContain("'properties' or 'attributes' map that cannot be read");
    // ...and it STILL WARNS, which is what makes the top-level-only reason safe
    // (go-to-k/cdkd#3641 round 2). Every other class warns at every node; this one
    // had no warning at all, because the row is KEPT and the drop warning speaks
    // only for rows that were dropped — so a changed nested child printed nothing
    // while its own deploy refused.
    expect(
      warnings(),
      'a nested child says NOTHING about a row its own deploy will refuse'
    ).toContain("whose 'properties' or 'attributes' map is not an object");
    expect(warnings(), 'the warning does not name the row').toContain('Torn');
  });

  it('WARNS at the top level too, beside the reason', async () => {
    // The warning is not nested-only: the top-level node carries both, the way
    // every other class does — the warning names the rows, the reason is what
    // `--fail` counts.
    const torn = {
      logicalId: 'Torn',
      orphanedAt: 1,
      state: { physicalId: 'live', resourceType: 'AWS::SQS::Queue', properties: 'abcdef' },
    };
    const node = await diffWithPreview(record([torn] as unknown));
    expect(warnings()).toContain("whose 'properties' or 'attributes' map is not an object");
    expect(node.blocking.join('\n')).toContain(
      "'properties' or 'attributes' map that cannot be read"
    );
  });

  it('never refuses: the container is a list, so only the row is dropped', async () => {
    const node = await diffWithPreview(record([{ logicalId: 'Gone', orphanedAt: 1 }] as unknown));
    // No container row — the field IS a list, and conflating the two would send
    // an operator to rewrite a field that is already the right shape.
    expect(node.unreadable).not.toContain(UNREADABLE_ORPHANS_CONTAINER_ROW);
    expect(node.unreadable).toEqual(['Gone']);
  });

  it('the usable rows still reach the adoption preview', async () => {
    // DRIVEN: the preview is what makes the drop a drop rather than a refusal,
    // so the case asserts the survivors arrive — a filter dropping everything
    // would satisfy every assertion above.
    const seen: unknown[] = [];
    const node = await buildDiffTree({
      stackName: STACK,
      displayName: STACK,
      region: REGION,
      template,
      nestedTemplates: {},
      recursive: false,
      isNestedChild: false,
      stateBackend: {
        getState: async (name: string) =>
          name === STACK
            ? { state: record([healthy, 5, { logicalId: 'Gone', orphanedAt: 1 }] as unknown), etag: 'fake' }
            : null,
      } as unknown as S3StateBackend,
      diffCalculator: new DiffCalculator(),
      previewOrphanAdoption: (async (state: StackState) => {
        seen.push(...(state.orphans ?? []));
        return { adopted: {}, refusals: [] };
      }) as unknown as Parameters<typeof buildDiffTree>[0]['previewOrphanAdoption'],
    });
    expect(seen, 'the preview saw a row the filter should have dropped').toEqual([healthy]);
    expect(node.unreadable.sort()).toEqual(['', 'Gone']);
  });

  it('CONTROL: a list whose every row is usable is passed through untouched', async () => {
    const seen: unknown[] = [];
    const node = await buildDiffTree({
      stackName: STACK,
      displayName: STACK,
      region: REGION,
      template,
      nestedTemplates: {},
      recursive: false,
      isNestedChild: false,
      stateBackend: {
        getState: async (name: string) =>
          name === STACK ? { state: record([healthy] as unknown), etag: 'fake' } : null,
      } as unknown as S3StateBackend,
      diffCalculator: new DiffCalculator(),
      previewOrphanAdoption: (async (state: StackState) => {
        seen.push(...(state.orphans ?? []));
        return { adopted: {}, refusals: [] };
      }) as unknown as Parameters<typeof buildDiffTree>[0]['previewOrphanAdoption'],
    });
    expect(seen).toEqual([healthy]);
    expect(node.unreadable).toEqual([]);
    expect(warnings()).not.toContain('rollback-orphan record');
  });
});
