/**
 * WIRING for issue [go-to-k/cdkd#3335](https://github.com/go-to-k/cdkd/issues/3335):
 * `cdkd diff` REPAIRS two containers `cdkd deploy` REFUSES, and before this
 * neither repair reached the command's exit signals.
 *
 * The gap is only visible when the template declares nothing in the damaged
 * container: the repaired `{}` then produces no delta, so `nodeHasChanges` is
 * false, `--fail` exits 0, and a CI step gating on it passes over a record the
 * next deploy stops on. Where the template DOES declare something the row
 * happens to be an `UPDATE`, which is why a case built only on that shape
 * cannot see the defect.
 *
 * The fix reuses go-to-k/cdkd#2943's mechanism rather than a new one: a deploy
 * that would refuse this node is a BLOCKING reason on it, so `countBlocking`
 * raises the exit-3 `DeployRefusalPreviewError` ahead of `--fail`. The ids are
 * deliberately NOT pushed into `unreadable`, which means "dropped from the
 * diff" — these rows are previewed, and exit 3 would still be unset. A
 * container the diff DROPS carries both (go-to-k/cdkd#3512).
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

import { buildDiffTree, countBlocking } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState, StackOrphanRecord } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const STACK = 'S';
const REGION = 'us-east-1';

function entry(properties: unknown): ResourceState {
  return {
    physicalId: 'q',
    resourceType: 'AWS::SQS::Queue',
    properties: properties as Record<string, unknown>,
  };
}

function record(extra: Partial<StackState> = {}): StackState {
  return {
    stackName: STACK,
    region: REGION,
    version: 10,
    resources: { Q: entry({ QueueName: 'q' }) },
    outputs: {},
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
  extra: {
    tpl?: CloudFormationTemplate;
    children?: Record<string, StackState>;
    recursive?: boolean;
    nestedTemplates?: Record<string, string>;
    ancestorTemplatePaths?: ReadonlySet<string>;
    stackName?: string;
    previewOrphanAdoption?: Parameters<typeof buildDiffTree>[0]['previewOrphanAdoption'];
  } = {}
) {
  const stackName = extra.stackName ?? STACK;
  return buildDiffTree({
    stackName,
    displayName: stackName,
    region: REGION,
    template: extra.tpl ?? { Resources: { Q: { Type: 'AWS::SQS::Queue' } } },
    nestedTemplates: extra.nestedTemplates ?? {},
    recursive: extra.recursive ?? false,
    stateBackend: backendHolding({ [stackName]: state, ...(extra.children ?? {}) }),
    diffCalculator: new DiffCalculator(),
    isNestedChild: false,
    ...(extra.ancestorTemplatePaths && { ancestorTemplatePaths: extra.ancestorTemplatePaths }),
    ...(extra.previewOrphanAdoption && { previewOrphanAdoption: extra.previewOrphanAdoption }),
  });
}

describe('cdkd diff reports a deploy refusal it repaired (issue go-to-k/cdkd#3335)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The first two of the three template shapes the issue measured — the pair
  // where the defect lived: no delta, so every other signal this node carries
  // stays silent. The third, a DECLARED `Properties` whose row is an `UPDATE`,
  // is its own case below.
  for (const [label, properties] of [
    ['no Properties key', undefined],
    ['an empty Properties', {}],
  ] as const) {
    it(`blocks over an unreadable 'properties' map when the template declares ${label}`, async () => {
      const tpl: CloudFormationTemplate = {
        Resources: {
          Q: { Type: 'AWS::SQS::Queue', ...(properties && { Properties: properties }) },
        },
      };
      // `recursive: true` on this one, deliberately: a gate keyed on the WALK
      // MODE rather than on the ancestor chain is invisible while every
      // root-damaged case runs non-recursively — and under it
      // `cdkd diff --recursive`, the mode CI uses on nested stacks, exits 0
      // over exactly the record this issue is about.
      const node = await diff(record({ resources: { Q: entry('abcdef') } }), {
        tpl,
        recursive: true,
      });

      // The shape that made this invisible: no change row at all.
      expect(node.changes.get('Q')?.changeType).toBe('NO_CHANGE');
      // ...and the repaired row is NOT in `unreadable` — it was previewed, not
      // dropped. Asserting this keeps the fix off the wrong mechanism.
      expect(node.unreadable).toEqual([]);
      // The signal that now fires, and the exit code it drives.
      expect(node.blocking).toHaveLength(1);
      expect(node.blocking[0]).toContain("'properties' map that cannot be read");
      expect(node.blocking[0]).toContain("'cdkd deploy' refuses the record");
      expect(countBlocking(node)).toBe(1);
    });
  }

  it('COUNTS the torn records in its reason, and still reports one reason', async () => {
    // The number in the sentence is what a reader acts on, and nothing pinned
    // it: every other case has exactly one torn map, so `logicalIds.length`
    // could be the literal 1. Three torn records, one reason.
    const node = await diff(
      record({
        resources: { A: entry('abcdef'), B: entry(['x']), C: entry(5) },
      }),
      { tpl: { Resources: { A: { Type: 'AWS::SQS::Queue' } } } }
    );
    expect(node.blocking).toHaveLength(1);
    expect(node.blocking[0]).toContain('3 resource record(s)');
    expect(countBlocking(node)).toBe(1);
  });

  it('blocks over a declared-properties record too, where the row is an UPDATE', async () => {
    // The third shape. `--fail` already exited 1 here, but for the wrong
    // reason: it reported a change the deploy will not make, and exit 3 — the
    // code that says the deploy refuses — was unset.
    const tpl: CloudFormationTemplate = {
      Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
    };
    const node = await diff(record({ resources: { Q: entry('abcdef') } }), { tpl });
    expect(node.changes.get('Q')?.changeType).toBe('UPDATE');
    expect(countBlocking(node)).toBe(1);
  });

  it("blocks over an unreadable 'outputs' bag with no declared Outputs", async () => {
    // The arm the issue read off the code rather than driving: with no
    // Outputs declared the repaired `{}` produces no output delta either.
    //
    // The resource row is made NO_CHANGE deliberately. The default record
    // carries `{ QueueName: 'q' }` against a template that declares no
    // `Properties`, which is an UPDATE — so the node would have a delta of its
    // own and this case would no longer be the shape the defect needs, where
    // nothing at all changes and `--fail` alone exits 0.
    const node = await diff(
      record({ resources: { Q: entry({}) }, outputs: 'abcdef' as unknown as StackState['outputs'] })
    );
    expect(node.changes.get('Q')?.changeType, 'the node must have no delta of its own').toBe(
      'NO_CHANGE'
    );
    expect(node.outputChanges).toEqual([]);
    // The "deliberately NOT `unreadable`" decision, for THIS container too:
    // the `properties` arm pins it above and a push added beside this refusal
    // survived every case without it.
    expect(node.unreadable).toEqual([]);
    expect(node.blocking).toHaveLength(1);
    expect(node.blocking[0]).toContain("The 'outputs' bag cannot be read");
    expect(countBlocking(node)).toBe(1);
  });

  it('counts BOTH containers on one record, once each', async () => {
    // Two damaged containers are two independent refusals, and the count is
    // what `countBlocking` sums — a single `push` for "something was damaged"
    // would report 1 here.
    const node = await diff(
      record({
        resources: { Q: entry('abcdef') },
        outputs: 'abcdef' as unknown as StackState['outputs'],
      })
    );
    expect(node.blocking).toHaveLength(2);
    expect(countBlocking(node)).toBe(2);
  });

  it('still blocks on the ROOT when the ancestor set is non-empty', async () => {
    // `ancestorTemplatePaths` is the CYCLE-detection set, and the first cut of
    // this gate read "am I root" off it being empty. Nothing stops a future
    // caller seeding it for another reason, and this is the ONLY case that
    // passes one — without it, restoring `(ancestorTemplatePaths?.size ?? 0) > 0`
    // in place of `isNestedChild` left the whole suite green while exit 3
    // silently stopped firing for the user who named this stack.
    const node = await diff(record({ resources: { Q: entry('abcdef') } }), {
      ancestorTemplatePaths: new Set(['/somewhere/else.template.json']),
    });
    expect(node.blocking).toHaveLength(1);
    // The reason TEXT too, not just the count: every sibling case pins it, and
    // without it any single reason from any source satisfies this case.
    expect(node.blocking[0]).toContain("'properties' map that cannot be read");
    expect(countBlocking(node)).toBe(1);
  });

  it("blocks over an unreadable 'resources' BAG too, and KEEPS its unreadable row", async () => {
    // The third container, and the rule go-to-k/cdkd#3512 settled for all three
    // at once: a container `cdkd deploy` refuses is a blocking reason, and
    // whatever `unreadable` row it already had stays. The two containers above
    // are previewed in place, so they have no row; the bag is DROPPED, so it has
    // both — `--fail` still counts the row and exit 3, which outranks it, says
    // the deploy refuses. The dropped-container cases live in
    // `diff-recursive-dropped-container-blocking.test.ts`.
    const node = await diff({
      ...record(),
      resources: 'abcdef' as unknown as StackState['resources'],
    });
    expect(node.unreadable).toEqual(['(resources map)']);
    expect(node.blocking).toHaveLength(1);
    expect(node.blocking[0]).toContain("The 'resources' map cannot be read");
    expect(countBlocking(node)).toBe(1);
  });

  it('says nothing when the stack has NO state record at all', async () => {
    // The first-ever `cdkd diff` on a stack, and the most common invocation of
    // the command. `loadStateOrEmpty`'s no-record arm returns its own
    // `deployRefusals: []`, which nothing else here reaches — seeding it with a
    // reason instead survives every other case in tests/unit/cli while making
    // that first run exit 3.
    const node = await buildDiffTree({
      stackName: STACK,
      displayName: STACK,
      region: REGION,
      template: { Resources: { Q: { Type: 'AWS::SQS::Queue' } } },
      nestedTemplates: {},
      recursive: false,
      stateBackend: backendHolding({}),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    expect(node.changes.get('Q')?.changeType, 'a first deploy CREATEs the row').toBe('CREATE');
    expect(node.blocking).toEqual([]);
    expect(countBlocking(node)).toBe(0);
  });

  it("still blocks on a ROOT whose own name contains '~'", async () => {
    // `~` is the separator cdkd puts between a parent and a nested child in a
    // state key, so "am I a child" LOOKS derivable from the name. It is not: a
    // PREBUILT assembly supplies its own stack names, unvalidated, so a
    // top-level stack really can be called `A~B` — and under that reading it
    // would lose every repaired-container reason while the suite stayed green.
    const name = 'A~B';
    const node = await diff(
      { ...record({ resources: { Q: entry('abcdef') } }), stackName: name },
      { stackName: name }
    );
    expect(node.blocking).toHaveLength(1);
    expect(node.blocking[0]).toContain("'properties' map that cannot be read");
    expect(countBlocking(node)).toBe(1);
  });

  it('counts the LOADED and the ADOPTED torn map separately, though the reasons read alike', async () => {
    // One torn record in each pass, so both reason strings are BYTE-IDENTICAL
    // ("1 resource record(s) ..."). That is the shape a `new Set(...)` over the
    // assembled list silently collapses to one, reporting a single refusal
    // where the deploy has two populations to repair — and every other case
    // here damages only one pass, so none of them would notice.
    const state = record({
      resources: { Q: entry('abcdef') },
      orphans: [{ logicalId: 'Adopted', state: entry('abcdef') }] as unknown as StackOrphanRecord[],
    });
    const node = await diff(state, {
      tpl: {
        Resources: { Q: { Type: 'AWS::SQS::Queue' }, Adopted: { Type: 'AWS::SQS::Queue' } },
      },
      previewOrphanAdoption: async () => ({
        adopted: { Adopted: entry('abcdef') },
        refusals: [],
      }),
    });
    const properties = node.blocking.filter((r) =>
      r.includes("'properties' map that cannot be read")
    );
    expect(properties).toHaveLength(2);
    expect(properties[0], 'the two reasons must be identical for this to pin dedup').toBe(
      properties[1]
    );
    expect(countBlocking(node)).toBe(2);
  });

  it('counts a torn map on an ADOPTED rollback-orphan record', async () => {
    // The second repair, after the adoption splice. These records never pass
    // through the load, so the arm there cannot see them.
    const state = record({
      orphans: [{ logicalId: 'Adopted', state: entry('abcdef') }] as unknown as StackOrphanRecord[],
    });
    const node = await diff(state, {
      tpl: {
        Resources: { Q: { Type: 'AWS::SQS::Queue' }, Adopted: { Type: 'AWS::SQS::Queue' } },
      },
      previewOrphanAdoption: async () => ({
        adopted: { Adopted: entry('abcdef') },
        refusals: [],
      }),
    });
    expect(node.adoptedOrphans).toEqual(['Adopted']);
    expect(node.blocking.some((r) => r.includes("'properties' map that cannot be read"))).toBe(
      true
    );
    expect(countBlocking(node)).toBe(1);
  });

  it('says nothing for a healthy record, or one whose map and bag are a genuine {}', async () => {
    // The control. Without it a push that fired unconditionally would satisfy
    // every case above while making `cdkd diff` exit 3 on every ordinary run.
    for (const [label, state] of [
      ['healthy', record()],
      ['genuinely empty', record({ resources: { Q: entry({}) }, outputs: {} })],
    ] as const) {
      const node = await diff(state);
      expect(node.blocking, label).toEqual([]);
      expect(countBlocking(node), label).toBe(0);
    }
  });

  it('keeps a REFUSED adoption on the ROOT, which this PR must not have displaced', async () => {
    // The `...blocking` tail of the same expression: go-to-k/cdkd#2943's own
    // mechanism. Dropping it passed every case in tests/unit/cli — nothing
    // drove a TOP-LEVEL refusal through `buildDiffTree`, only through
    // `computeStackDiff` or a hand-built node — so a typo there would silently
    // unset exit 3 for the feature this PR borrows.
    const state = record({
      orphans: [
        { logicalId: 'Adopted', state: entry({ QueueName: 'q' }) },
      ] as unknown as StackOrphanRecord[],
    });
    const node = await diff(state, {
      previewOrphanAdoption: async () => ({
        adopted: {},
        refusals: ['a physical id another stack owns'],
      }),
    });
    expect(node.blocking).toEqual(['a physical id another stack owns']);
    expect(countBlocking(node)).toBe(1);
  });

  it('says nothing over an adoption whose records are HEALTHY', async () => {
    // The post-splice guard's own control: moving its push outside
    // `if (tornAdopted.length > 0)` blocks every ordinary adoption, and no
    // other case here adopts anything healthy.
    const state = record({
      orphans: [
        { logicalId: 'Adopted', state: entry({ QueueName: 'q' }) },
      ] as unknown as StackOrphanRecord[],
    });
    const node = await diff(state, {
      tpl: {
        Resources: { Q: { Type: 'AWS::SQS::Queue' }, Adopted: { Type: 'AWS::SQS::Queue' } },
      },
      previewOrphanAdoption: async () => ({
        adopted: { Adopted: entry({ QueueName: 'q' }) },
        refusals: [],
      }),
    });
    expect(node.adoptedOrphans).toEqual(['Adopted']);
    expect(node.blocking).toEqual([]);
    expect(countBlocking(node)).toBe(0);
  });

  describe('a nested child adds NO reason, however its own record is damaged', () => {
    // The scope decision, exercised through a TEMPLATE-DECLARED child — the
    // only route that reaches the gate. A child discovered from state alone
    // goes through `buildDeletedSubtree`, which hard-codes `blocking: []`, so a
    // case built that way passes with the gate deleted entirely (round-1 Codex
    // finding on this PR).
    let dir: string;
    let childPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cdkd-3335-'));
      childPath = join(dir, 'child.template.json');
    });
    afterEach(() => {
      // Per test, not per suite: `beforeEach` makes one directory each, so an
      // `afterAll` would remove only the last and leak the rest.
      rmSync(dir, { recursive: true, force: true });
    });

    /** A parent whose one row is the nested stack, and whose own record is healthy. */
    function parentState(): StackState {
      return {
        ...record(),
        resources: {
          Child: { physicalId: 'c', resourceType: 'AWS::CloudFormation::Stack', properties: {} },
        },
      };
    }

    const parentTpl: CloudFormationTemplate = {
      Resources: { Child: { Type: 'AWS::CloudFormation::Stack', Properties: {} } },
    };

    it('under a NO_CHANGE parent row, for a torn map in the child record', async () => {
      writeFileSync(childPath, JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } }));
      const child: StackState = {
        ...record({ resources: { Q: entry('abcdef') } }),
        stackName: `${STACK}~Child`,
      };
      const node = await diff(parentState(), {
        recursive: true,
        tpl: parentTpl,
        nestedTemplates: { Child: childPath },
        children: { [`${STACK}~Child`]: child },
      });

      // The parent row really is the shape the decision rests on.
      expect(node.changes.get('Child')?.changeType).toBe('NO_CHANGE');
      const kid = node.children.find((c) => c.stackName === `${STACK}~Child`);
      expect(kid, 'the nested child node is missing').toBeDefined();
      expect(kid!.blocking).toEqual([]);
      expect(countBlocking(node)).toBe(0);
    });

    it('for a torn map on the child\'s own ADOPTED orphan record', async () => {
      // The second repair runs per node, so without its own gate this child
      // raised exit 3 over a deploy that never diffs it.
      writeFileSync(
        childPath,
        JSON.stringify({
          Resources: { Q: { Type: 'AWS::SQS::Queue' }, Adopted: { Type: 'AWS::SQS::Queue' } },
        })
      );
      const child: StackState = {
        ...record({
          orphans: [
            { logicalId: 'Adopted', state: entry('abcdef') },
          ] as unknown as StackOrphanRecord[],
        }),
        stackName: `${STACK}~Child`,
      };
      const node = await diff(parentState(), {
        recursive: true,
        tpl: parentTpl,
        nestedTemplates: { Child: childPath },
        children: { [`${STACK}~Child`]: child },
        previewOrphanAdoption: async () => ({
          adopted: { Adopted: entry('abcdef') },
          refusals: [],
        }),
      });

      const kid = node.children.find((c) => c.stackName === `${STACK}~Child`);
      expect(kid, 'the nested child node is missing').toBeDefined();
      expect(kid!.adoptedOrphans).toEqual(['Adopted']);
      expect(kid!.blocking).toEqual([]);
      expect(countBlocking(node)).toBe(0);
    });

    it("under a NO_CHANGE parent row, for a torn 'outputs' bag in the child record", async () => {
      // The other container, because the exclusion is claimed for BOTH and a
      // mutant forwarding only the outputs reason survives a properties-only
      // suite.
      writeFileSync(childPath, JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } }));
      const child: StackState = {
        ...record({ outputs: 'abcdef' as unknown as StackState['outputs'] }),
        stackName: `${STACK}~Child`,
      };
      const node = await diff(parentState(), {
        recursive: true,
        tpl: parentTpl,
        nestedTemplates: { Child: childPath },
        children: { [`${STACK}~Child`]: child },
      });

      const kid = node.children.find((c) => c.stackName === `${STACK}~Child`);
      expect(kid, 'the nested child node is missing').toBeDefined();
      expect(kid!.blocking).toEqual([]);
      expect(countBlocking(node)).toBe(0);
    });

    it('at DEPTH TWO as well, so the rule is "every non-root node"', async () => {
      // Depth one alone lets `> 0` become `=== 1` with no case reddening,
      // which would block on a damaged GRANDCHILD under an unchanged parent.
      const grandchildPath = join(dir, 'grandchild.template.json');
      writeFileSync(
        grandchildPath,
        JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } })
      );
      // The grandchild's template is reached from the CHILD's own
      // `aws:asset:path`, the way synth emits it — the `nestedTemplates` map
      // below only indexes the ROOT's children.
      writeFileSync(
        childPath,
        JSON.stringify({
          Resources: {
            G: {
              Type: 'AWS::CloudFormation::Stack',
              Properties: {},
              Metadata: { 'aws:asset:path': 'grandchild.template.json' },
            },
          },
        })
      );
      const child: StackState = {
        ...record(),
        stackName: `${STACK}~Child`,
        resources: {
          G: { physicalId: 'g', resourceType: 'AWS::CloudFormation::Stack', properties: {} },
        },
      };
      const grandchild: StackState = {
        ...record({ resources: { Q: entry('abcdef') } }),
        stackName: `${STACK}~Child~G`,
      };
      const node = await diff(parentState(), {
        recursive: true,
        tpl: parentTpl,
        nestedTemplates: { Child: childPath },
        children: {
          [`${STACK}~Child`]: child,
          [`${STACK}~Child~G`]: grandchild,
        },
      });

      const kid = node.children.find((c) => c.stackName === `${STACK}~Child`);
      expect(kid, 'the nested child node is missing').toBeDefined();
      const grandkid = kid!.children.find((c) => c.stackName === `${STACK}~Child~G`);
      expect(grandkid, 'the grandchild node is missing — the case pins nothing').toBeDefined();
      expect(grandkid!.blocking).toEqual([]);
      expect(countBlocking(node)).toBe(0);
    });

    it('under an ATTRIBUTE-ONLY UPDATE parent row, the other shape the deploy skips', async () => {
      // The second half of the scope argument: an `UPDATE` that moves only
      // `DeletionPolicy` / `UpdateReplacePolicy` refreshes the recorded
      // attributes with no provider call, so the child is not diffed there
      // either. A gate keyed on "the parent row is NO_CHANGE" would pass the
      // sibling case above and fail here.
      writeFileSync(childPath, JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } }));
      const parent: StackState = {
        ...record(),
        resources: {
          Child: {
            physicalId: 'c',
            resourceType: 'AWS::CloudFormation::Stack',
            properties: {},
            deletionPolicy: 'Delete',
          },
        },
      };
      const child: StackState = {
        ...record({ resources: { Q: entry('abcdef') } }),
        stackName: `${STACK}~Child`,
      };
      const node = await diff(parent, {
        recursive: true,
        tpl: {
          Resources: {
            Child: {
              Type: 'AWS::CloudFormation::Stack',
              Properties: {},
              DeletionPolicy: 'Retain',
            },
          },
        },
        nestedTemplates: { Child: childPath },
        children: { [`${STACK}~Child`]: child },
      });

      // The premise, pinned rather than asserted: `changeType === 'UPDATE'`
      // alone is satisfied by a PROPERTY-changing update too, and that shape
      // DOES reach the child — so a fixture that drifted into it would read as
      // this case while exercising the one the scope argument excludes.
      const row = node.changes.get('Child');
      expect(row?.changeType).toBe('UPDATE');
      // No `?? []` fallback: the calculator sets `propertyChanges` on every
      // UPDATE row, so a coalesce would let the key GOING MISSING satisfy this.
      expect(
        row!.propertyChanges,
        'a property moved — this is not the attribute-only shape'
      ).toEqual([]);
      expect(row?.attributeChanges).toEqual([
        { attribute: 'DeletionPolicy', oldValue: 'Delete', newValue: 'Retain' },
      ]);
      const kid = node.children.find((c) => c.stackName === `${STACK}~Child`);
      expect(kid, 'the nested child node is missing').toBeDefined();
      expect(kid!.blocking).toEqual([]);
      expect(countBlocking(node)).toBe(0);
    });

    it('and under a CREATE parent row, which the deploy certainly DOES reach', async () => {
      // The scope is "every non-root node", NOT "every node the deploy skips",
      // and this is the case that tells them apart: on a CREATE row the deploy
      // provisions the child, so suppressing the reason here is the
      // CONSERVATIVE half of the decision rather than a consequence of the
      // deploy's own behaviour.
      //
      // Without it, moving the decision to the call site as
      // `isNestedChild: the row is NO_CHANGE or attribute-only` passes every
      // other case in this file while changing what a user sees.
      //
      // A CREATE row rather than a property-changing UPDATE for a fixture
      // reason, not a behavioural one: a non-empty `Properties` on the
      // nested-stack row enters the parent's intrinsic resolver, whose region
      // provider falls through to IMDS and trips the suite's AWS fence. The
      // parent row here is CREATE because the parent's STATE does not hold
      // `Child` at all, so the template row needs no properties to move.
      writeFileSync(childPath, JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } }));
      const child: StackState = {
        ...record({ resources: { Q: entry('abcdef') } }),
        stackName: `${STACK}~Child`,
      };
      const node = await diff(record({ resources: {} }), {
        recursive: true,
        tpl: parentTpl,
        nestedTemplates: { Child: childPath },
        children: { [`${STACK}~Child`]: child },
      });

      // The premise: this is neither shape the deploy skips.
      expect(node.changes.get('Child')?.changeType).toBe('CREATE');
      const kid = node.children.find((c) => c.stackName === `${STACK}~Child`);
      expect(kid, 'the nested child node is missing').toBeDefined();
      expect(kid!.blocking).toEqual([]);
      expect(countBlocking(node)).toBe(0);
    });

    it('and for a DELETED child, which the deploy removes without diffing it', async () => {
      // The third shape from the issue's plan: state holds the child, the
      // template no longer declares it, so `buildDeletedSubtree` diffs it
      // against an empty template. Its removal goes through the nested-stack
      // provider, which never reads `properties` through the diff.
      const parent: StackState = {
        ...record(),
        resources: {
          Child: { physicalId: 'c', resourceType: 'AWS::CloudFormation::Stack', properties: {} },
        },
      };
      const child: StackState = {
        ...record({ resources: { Q: entry('abcdef') } }),
        stackName: `${STACK}~Child`,
      };
      const node = await diff(parent, {
        recursive: true,
        tpl: { Resources: {} },
        children: { [`${STACK}~Child`]: child },
      });

      const kid = node.children.find((c) => c.stackName === `${STACK}~Child`);
      expect(kid, 'the deleted child node is missing').toBeDefined();
      expect(kid!.blocking).toEqual([]);
      expect(countBlocking(node)).toBe(0);
    });

    it('but a REFUSED adoption on the child still blocks, which is not this scope', async () => {
      // The control that keeps the gate honest: `plan.refusals` is a refusal
      // wherever it sits (go-to-k/cdkd#2943), and this PR must not have
      // silenced it on children while excluding its own reasons.
      writeFileSync(childPath, JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } }));
      // A HEALTHY orphan record, so the preview runs at all — it is gated on
      // the container being non-empty — and returns its refusal.
      const child: StackState = {
        ...record({
          orphans: [
            { logicalId: 'Adopted', state: entry({ QueueName: 'q' }) },
          ] as unknown as StackOrphanRecord[],
        }),
        stackName: `${STACK}~Child`,
      };
      const node = await diff(parentState(), {
        recursive: true,
        tpl: parentTpl,
        nestedTemplates: { Child: childPath },
        children: { [`${STACK}~Child`]: child },
        previewOrphanAdoption: async (state) => ({
          adopted: {},
          refusals: state.stackName === `${STACK}~Child` ? ['a physical id another stack owns'] : [],
        }),
      });

      const kid = node.children.find((c) => c.stackName === `${STACK}~Child`);
      expect(kid!.blocking).toEqual(['a physical id another stack owns']);
      expect(countBlocking(node)).toBe(1);
    });
  });
});
