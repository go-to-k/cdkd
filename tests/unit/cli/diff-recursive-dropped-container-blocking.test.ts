/**
 * Issue [go-to-k/cdkd#3512](https://github.com/go-to-k/cdkd/issues/3512): the
 * containers `cdkd diff` DROPS — the `resources` bag, a `resources` entry, the
 * `orphans` container and an `orphans` row — are each one `cdkd deploy`
 * refuses the record over, and before this none of them reached exit 3.
 *
 * The rule is go-to-k/cdkd#3335's, applied to the dropped half: a container the
 * deploy refuses carries a BLOCKING reason, and the `unreadable` row it already
 * had STAYS. So `--fail` still counts the row, `--json`'s `unreadable` keeps
 * meaning "dropped from the diff", and exit 3 — which `diff.ts` raises ahead of
 * `--fail` — says the deploy will not start.
 *
 * The verdict is not asserted from memory of the deploy: the PARITY block runs
 * the deploy's own refusals over a copy of every record shape here and requires
 * `cdkd diff` to report a reason exactly when one of them throws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import {
  buildDiffTree,
  countBlocking,
  diffTreeToJson,
  treeHasChanges,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  UNREADABLE_ORPHANS_CONTAINER_ROW,
  UNREADABLE_RESOURCES_MAP_ROW,
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
  refuseMalformedOutputs,
  refuseMalformedResourceEntriesForDeploy,
  refuseMalformedResourceProperties,
  refuseMalformedResourcesForDeploy,
} from '../../../src/state/malformed-resources-bag.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const STACK = 'S';
const REGION = 'us-east-1';

const BAG_REASON = "The 'resources' map cannot be read";
const ENTRIES_REASON = "in 'resources' cannot be read as resources";
const ORPHANS_CONTAINER_REASON = "The 'orphans' field is not a list";
const ORPHAN_ROWS_REASON = "in 'orphans' cannot be read as resources";

const queue = (properties: Record<string, unknown> = {}): ResourceState => ({
  physicalId: 'q',
  resourceType: 'AWS::SQS::Queue',
  properties,
});

/** A HEALTHY record whose one row is NO_CHANGE against {@link TPL}. */
function record(extra: Record<string, unknown> = {}): StackState {
  return {
    stackName: STACK,
    region: REGION,
    version: 10,
    resources: { Q: queue() },
    outputs: {},
    lastModified: 0,
    ...extra,
  } as StackState;
}

const TPL: CloudFormationTemplate = { Resources: { Q: { Type: 'AWS::SQS::Queue' } } };
const EMPTY_TPL: CloudFormationTemplate = { Resources: {} };

const healthyOrphan = {
  logicalId: 'Kept',
  orphanedAt: 1,
  state: { physicalId: 'live-kept', resourceType: 'AWS::SQS::Queue', properties: {} },
};

function backendHolding(states: Record<string, StackState>): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'fake' } : null;
    },
  } as unknown as S3StateBackend;
}

type PreviewOrphanAdoption = Parameters<typeof buildDiffTree>[0]['previewOrphanAdoption'];

/**
 * The adoption preview `diff.ts` always passes, stubbed to adopt nothing. The
 * orphan-ROW pass is gated on it, so a case without it measures nothing there.
 */
const adoptNothing = (async () => ({ adopted: {}, refusals: [] })) as unknown as PreviewOrphanAdoption;

async function diff(
  state: StackState,
  extra: {
    tpl?: CloudFormationTemplate;
    children?: Record<string, StackState>;
    recursive?: boolean;
    nestedTemplates?: Record<string, string>;
  } = {}
) {
  return buildDiffTree({
    stackName: STACK,
    displayName: STACK,
    region: REGION,
    template: extra.tpl ?? TPL,
    nestedTemplates: extra.nestedTemplates ?? {},
    recursive: extra.recursive ?? false,
    stateBackend: backendHolding({ [STACK]: state, ...(extra.children ?? {}) }),
    diffCalculator: new DiffCalculator(),
    isNestedChild: false,
    previewOrphanAdoption: adoptNothing,
  });
}

function warnings(): string {
  return (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((args) => String(args[0]))
    .join('\n');
}

const BAG_SHAPES: Array<[string, unknown]> = [
  ['a string', 'abcdef'],
  ['a list', ['x']],
  ['a number', 5],
  ['null', null],
];

describe("cdkd diff blocks over a DROPPED container the deploy refuses (go-to-k/cdkd#3512)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("the 'resources' bag", () => {
    for (const [label, bag] of BAG_SHAPES) {
      for (const [tplLabel, tpl] of [
        ['a template declaring nothing', EMPTY_TPL],
        ['a template declaring a resource', TPL],
      ] as const) {
        it(`blocks when the bag is ${label}, under ${tplLabel}`, async () => {
          const node = await diff(record({ resources: bag }), { tpl });
          // The row stays: `--fail` and `--json`'s `unreadable` are unchanged.
          expect(node.unreadable).toEqual([UNREADABLE_RESOURCES_MAP_ROW]);
          expect(treeHasChanges(node), '`--fail` still counts the dropped bag').toBe(true);
          // ...and the reason is new, exactly one, naming the container.
          expect(node.blocking).toHaveLength(1);
          expect(node.blocking[0]).toContain(BAG_REASON);
          expect(node.blocking[0]).toContain("'cdkd deploy' refuses the record");
          expect(countBlocking(node)).toBe(1);
          // The template-declaring-nothing shape is the one where only the row
          // and the reason speak: the empty bag yields no change row at all.
          if (tpl === EMPTY_TPL) expect(node.changes.size).toBe(0);
          else expect(node.changes.get('Q')?.changeType).toBe('CREATE');
        });
      }
    }

    it('blocks over an ABSENT bag, which the deploy refuses as a defect too', async () => {
      const state = record();
      delete (state as { resources?: unknown }).resources;
      const node = await diff(state);
      expect(node.unreadable).toEqual([UNREADABLE_RESOURCES_MAP_ROW]);
      expect(node.blocking).toHaveLength(1);
      expect(node.blocking[0]).toContain(BAG_REASON);
    });

    it('--json keeps the bag row in `unreadable` and adds the reason to `blocking`', async () => {
      // The contract go-to-k/cdkd#3018 shipped: `unreadable` is unchanged for a
      // consumer that already reads it.
      const json = diffTreeToJson(await diff(record({ resources: 'abcdef' })));
      expect(json.unreadable).toEqual([UNREADABLE_RESOURCES_MAP_ROW]);
      expect(json.blocking).toHaveLength(1);
      expect(json.blocking[0]).toContain(BAG_REASON);
    });
  });

  describe("a 'resources' entry", () => {
    it('blocks over a TYPELESS object holding a torn properties map, reported ONCE', async () => {
      // The shape both the entry guard and the `properties` repair name. The
      // entry drop runs first, so the row is dropped and reported as dropped —
      // one entries reason, not also a `properties` one.
      const node = await diff(
        record({ resources: { Q: queue(), R: { properties: 'abc' } } })
      );
      expect(node.unreadable).toEqual(['R']);
      expect(node.blocking).toHaveLength(1);
      expect(node.blocking[0]).toContain(`1 resource record(s) ${ENTRIES_REASON}`);
      expect(node.blocking.join('\n')).not.toContain("'properties' map");
      expect(countBlocking(node)).toBe(1);
    });

    // Not a control: the issue expected the deploy never to reach a `null` row,
    // but `refuseMalformedResourceEntriesForDeploy` refuses it at the engine's
    // load — the parity block below measures that.
    for (const [label, entry] of [
      ['a null entry', null],
      ['a typeless empty object', {}],
      ['a string entry', 'abc'],
    ] as const) {
      it(`blocks over ${label}, which the deploy refuses as well`, async () => {
        const node = await diff(record({ resources: { Q: queue(), R: entry } }));
        expect(node.unreadable).toEqual(['R']);
        expect(node.blocking).toHaveLength(1);
        expect(node.blocking[0]).toContain(ENTRIES_REASON);
        expect(countBlocking(node)).toBe(1);
      });
    }

    it('COUNTS the dropped entries in one reason', async () => {
      const node = await diff(
        record({ resources: { Q: queue(), A: null, B: {}, C: { properties: 5 } } })
      );
      expect(node.unreadable).toEqual(['A', 'B', 'C']);
      expect(node.blocking).toHaveLength(1);
      expect(node.blocking[0]).toContain(`3 resource record(s) ${ENTRIES_REASON}`);
    });

    it('survives more dropped entries than `push(...ids)` can spread, naming every one', async () => {
      // `push(...ids)` passes each id as an ARGUMENT and throws a bare
      // `RangeError` past the engine's argument limit (measured OK at 100k, over
      // at 130k in go-to-k/cdkd#3500) — on the command a user runs BECAUSE the
      // record is suspect. Restoring the spread reds this case.
      const resources: Record<string, unknown> = { Q: queue() };
      for (let i = 0; i < 200_000; i++) resources[`R${i}`] = null;
      const node = await diff(record({ resources }));
      expect(node.unreadable).toHaveLength(200_000);
      expect(node.blocking).toHaveLength(1);
      expect(node.blocking[0]).toContain('200000 resource record(s)');
    }, 60_000);
  });

  describe("the 'orphans' container and its rows", () => {
    for (const [label, orphans] of [
      ['a string', 'abc'],
      ['null', null],
      ['an object', {}],
    ] as const) {
      it(`blocks when the container is ${label}, keeping its row`, async () => {
        const node = await diff(record({ orphans }));
        expect(node.unreadable).toEqual([UNREADABLE_ORPHANS_CONTAINER_ROW]);
        expect(node.blocking).toHaveLength(1);
        expect(node.blocking[0]).toContain(ORPHANS_CONTAINER_REASON);
        expect(countBlocking(node)).toBe(1);
      });
    }

    it('blocks over DROPPED orphan rows, one reason counting them', async () => {
      const node = await diff(
        record({
          orphans: [healthyOrphan, 5, { logicalId: 'Gone', orphanedAt: 1 }],
        })
      );
      expect(node.unreadable.slice().sort()).toEqual(['', 'Gone']);
      expect(node.blocking).toHaveLength(1);
      expect(node.blocking[0]).toContain(`2 rollback-orphan record(s) ${ORPHAN_ROWS_REASON}`);
      expect(countBlocking(node)).toBe(1);
      // The drop warning still speaks for the rows.
      expect(warnings()).toContain('rollback-orphan record');
    });

    it('a dropped row and a KEPT torn row are two reasons, one each', async () => {
      // Disjoint arms: the kept-row reason walks only rows the preview kept.
      const node = await diff(
        record({
          orphans: [
            { logicalId: 'Gone', orphanedAt: 1 },
            {
              logicalId: 'Torn',
              orphanedAt: 1,
              state: { physicalId: 'live', resourceType: 'AWS::SQS::Queue', properties: {}, attributes: 5 },
            },
          ],
        })
      );
      expect(node.unreadable).toEqual(['Gone']);
      expect(node.blocking).toHaveLength(2);
      expect(node.blocking.filter((r) => r.includes(ORPHAN_ROWS_REASON))).toHaveLength(1);
      expect(node.blocking.filter((r) => r.includes('carry a'))).toHaveLength(1);
    });
  });

  it('counts every damaged container on one record, once each', async () => {
    const node = await diff(
      record({ resources: 'abcdef', outputs: 'abcdef', orphans: 'abc' })
    );
    expect(node.unreadable).toEqual([UNREADABLE_RESOURCES_MAP_ROW, UNREADABLE_ORPHANS_CONTAINER_ROW]);
    expect(node.blocking).toHaveLength(3);
    expect(countBlocking(node)).toBe(3);
  });

  it('CONTROL: a healthy record, a genuine {} bag and a healthy orphan list add nothing', async () => {
    for (const [label, state] of [
      ['healthy', record()],
      ['an empty resources bag', record({ resources: {} })],
      ['a healthy orphan list', record({ orphans: [healthyOrphan] })],
      ['an empty orphan list', record({ orphans: [] })],
    ] as const) {
      const node = await diff(state);
      expect(node.unreadable, label).toEqual([]);
      expect(node.blocking, label).toEqual([]);
      expect(countBlocking(node), label).toBe(0);
    }
  });

  describe('PARITY with the deploy: a reason exactly when the deploy refuses', () => {
    /** The refusals `DeployEngine`'s load and `calculateDiff` raise, in order. */
    function deployRefuses(state: StackState): boolean {
      try {
        refuseMalformedOutputs(state, STACK, REGION);
        refuseMalformedResourcesForDeploy(state, STACK, REGION);
        refuseMalformedResourceEntriesForDeploy(state, STACK, REGION);
        refuseMalformedOrphans(state, STACK, REGION);
        refuseMalformedOrphanRecords(state, STACK, REGION);
        refuseMalformedResourceProperties(state, undefined, undefined);
        return false;
      } catch {
        return true;
      }
    }

    const SHAPES: Array<[string, () => StackState]> = [
      ...BAG_SHAPES.map(([l, bag]): [string, () => StackState] => [
        `bag ${l}`,
        () => record({ resources: bag }),
      ]),
      ['a null entry', () => record({ resources: { Q: queue(), R: null } })],
      ['a typeless torn entry', () => record({ resources: { Q: queue(), R: { properties: 'x' } } })],
      ['a typeless empty entry', () => record({ resources: { Q: queue(), R: {} } })],
      ['an orphans string', () => record({ orphans: 'abc' })],
      ['a dropped orphan row', () => record({ orphans: [{ logicalId: 'Gone', orphanedAt: 1 }] })],
      ['healthy', () => record()],
      ['an empty bag', () => record({ resources: {} })],
      ['a healthy orphan list', () => record({ orphans: [healthyOrphan] })],
    ];

    for (const [label, make] of SHAPES) {
      it(`agrees for ${label}`, async () => {
        // Separate copies: the diff's read-only repairs mutate the record.
        const refused = deployRefuses(make());
        const node = await diff(make());
        expect(node.blocking.length > 0, `deploy refuses: ${refused}`).toBe(refused);
      });
    }

    it('the parity table holds both verdicts, so it cannot pass vacuously', () => {
      const verdicts = SHAPES.map(([, make]) => deployRefuses(make()));
      expect(verdicts.filter(Boolean).length).toBeGreaterThanOrEqual(9);
      expect(verdicts.filter((v) => !v).length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('a nested child adds NO reason, and keeps its unreadable row', () => {
    // go-to-k/cdkd#3335's scope, for the dropped containers: the deploy skips an
    // unchanged nested-stack row and an attribute-only UPDATE, so a reason there
    // would report a refusal over a deploy that succeeds.
    let dir: string;
    let childPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cdkd-3512-'));
      childPath = join(dir, 'child.template.json');
      writeFileSync(childPath, JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } }));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const childRow = (extra: Partial<ResourceState> = {}): ResourceState => ({
      physicalId: 'c',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: {},
      ...extra,
    });

    for (const [parentLabel, parentRow, parentTpl, expectRow] of [
      [
        'a NO_CHANGE parent row',
        childRow(),
        { Resources: { Child: { Type: 'AWS::CloudFormation::Stack', Properties: {} } } },
        'NO_CHANGE',
      ],
      [
        'an ATTRIBUTE-ONLY UPDATE parent row',
        childRow({ deletionPolicy: 'Delete' }),
        {
          Resources: {
            Child: { Type: 'AWS::CloudFormation::Stack', Properties: {}, DeletionPolicy: 'Retain' },
          },
        },
        'UPDATE',
      ],
    ] as const) {
      for (const [childLabel, childExtra, row] of [
        ['a torn bag', { resources: 'abcdef' }, UNREADABLE_RESOURCES_MAP_ROW],
        ['a null entry', { resources: { Q: queue(), R: null } }, 'R'],
        ['a torn orphans container', { orphans: 'abc' }, UNREADABLE_ORPHANS_CONTAINER_ROW],
        ['a dropped orphan row', { orphans: [{ logicalId: 'Gone', orphanedAt: 1 }] }, 'Gone'],
      ] as const) {
        it(`for ${childLabel} under ${parentLabel}`, async () => {
          const node = await diff(record({ resources: { Child: parentRow } }), {
            recursive: true,
            tpl: parentTpl as CloudFormationTemplate,
            nestedTemplates: { Child: childPath },
            children: { [`${STACK}~Child`]: { ...record(childExtra), stackName: `${STACK}~Child` } },
          });
          const parentChange = node.changes.get('Child');
          expect(parentChange?.changeType).toBe(expectRow);
          if (expectRow === 'UPDATE') expect(parentChange!.propertyChanges).toEqual([]);
          const kid = node.children.find((c) => c.stackName === `${STACK}~Child`);
          expect(kid, 'the nested child node is missing').toBeDefined();
          expect(kid!.unreadable, 'the child still reports what it dropped').toContain(row);
          expect(kid!.blocking).toEqual([]);
          expect(countBlocking(node)).toBe(0);
        });
      }
    }
  });
});
