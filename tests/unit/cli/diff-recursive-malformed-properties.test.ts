/**
 * WIRING for issue [go-to-k/cdkd#3191](https://github.com/go-to-k/cdkd/issues/3191):
 * `cdkd diff` REPAIRS a resource record's unreadable `properties` bag at the
 * load and says so, where `cdkd deploy` REFUSES.
 *
 * The analyzer suite proves the refusal fires inside
 * `DiffCalculator.calculateDiff`. That is where the write-capable flow is
 * closed, and it is exactly why this file exists: `cdkd diff` reaches the SAME
 * calculator, so without a repair at its own load the read-only command would
 * inherit the refusal and stop reporting on the record a user runs it to
 * inspect. `loadStateOrEmpty` is the one point every `cdkd diff` state read
 * sits below — the top-level stack and every nested child — so these cases
 * enter through `buildDiffTree`, which is what the command calls.
 *
 * The split is the module contract `src/state/malformed-resources-bag.ts`
 * records for its other containers: repair + warn where nothing can be
 * persisted, refuse where it can.
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
import {
  buildDiffTree,
  diffTreeToJson,
  nodeHasChanges,
  renderDiffTree,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { ResourceState, StackOrphanRecord } from '../../../src/types/state.js';

const STACK = 'S';
const REGION = 'us-east-1';

/**
 * The logical id every case keys on. Deliberately NOT `A`: the shared clause
 * contains `ADDED` and `A REPLACEMENT`, so a one-letter id made
 * `toContain(id)` pass with the id omitted entirely — the assertion could not
 * fail (review of go-to-k/cdkd#3191).
 */
const TORN_ID = 'ParamZeta';

function template(): CloudFormationTemplate {
  return {
    Resources: { [TORN_ID]: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
  };
}

function entry(properties: unknown): ResourceState {
  return {
    physicalId: 'pid',
    resourceType: 'AWS::SSM::Parameter',
    properties: properties as Record<string, unknown>,
  };
}

/** A record whose `resources` and `outputs` bags are HEALTHY — only the entry's own bag is torn. */
function record(properties: unknown, extra: Partial<StackState> = {}): StackState {
  return {
    stackName: STACK,
    region: REGION,
    version: 10,
    resources: { [TORN_ID]: entry(properties) },
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
    children?: Record<string, StackState>;
    recursive?: boolean;
    tpl?: CloudFormationTemplate;
    previewOrphanAdoption?: Parameters<typeof buildDiffTree>[0]['previewOrphanAdoption'];
  } = {}
) {
  return buildDiffTree({
    stackName: STACK,
    displayName: STACK,
    region: REGION,
    template: extra.tpl ?? template(),
    nestedTemplates: {},
    recursive: extra.recursive ?? false,
    stateBackend: backendHolding({ [STACK]: state, ...(extra.children ?? {}) }),
    diffCalculator: new DiffCalculator(),
    isNestedChild: false,
    ...(extra.previewOrphanAdoption && { previewOrphanAdoption: extra.previewOrphanAdoption }),
  });
}

function warnings(): string {
  return (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((args) => String(args[0]))
    .join('\n');
}

describe('cdkd diff over an unreadable properties bag (issue go-to-k/cdkd#3191)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports instead of refusing, and names the record', async () => {
    // The whole point of the read-only half: a user reaching for `cdkd diff`
    // BECAUSE the state looks wrong must get a report, not the deploy's abort.
    const node = await diff(record('abcdef'));
    expect(node.changes.get(TORN_ID)?.changeType).toBe('UPDATE');
    expect(warnings()).toContain(TORN_ID);
    expect(warnings()).toContain("'properties' map cannot be read");
  });

  it('names the stack and region the CALLER resolved, not the record self-report', async () => {
    // The asymmetry with the deploy refusal, which names neither: this caller
    // holds a trusted pair — the identity its own load was keyed on — so it
    // prints that and never the record's own fields.
    const state = record('abcdef');
    state.stackName = 'prod-payments';
    state.region = 'us-west-2';
    await diff(state);
    expect(warnings()).toContain(`State for ${STACK} (${REGION})`);
    expect(warnings()).toContain(`cdkd state show ${STACK} --stack-region ${REGION} --json`);
    expect(warnings()).not.toContain('prod-payments');
    expect(warnings()).not.toContain('us-west-2');
  });

  it('invents no per-character rows from a string bag', async () => {
    // Measured at `122cf28e5`, before the repair: the six characters of
    // `abcdef` each became a property change with `oldValue` set. The repair
    // to `{}` is what leaves ONE row — the template's own `Value` — so this
    // row COUNT is the discriminator, not the presence of a change.
    const node = await diff(record('abcdef'));
    const changes = node.changes.get(TORN_ID)?.propertyChanges ?? [];
    expect(changes.map((c) => c.path)).toEqual(['Value']);
  });

  it('warns that the preview itself is wrong, and that deploy will refuse', async () => {
    // The repair does not make the preview accurate — every declared property
    // reads as an addition — so a silent repair would be its own defect: an
    // empty bag is indistinguishable from a resource that really declares
    // nothing. The warning has to say both halves.
    await diff(record(null));
    expect(warnings()).toContain('Continuing with those maps EMPTY');
    expect(warnings()).toContain("Do NOT run 'cdkd deploy' against this record");
    // BOTH arms, because a removed nested child is diffed against an EMPTY
    // template and declares nothing — the wording used to claim every property
    // "is previewed as an addition", which is impossible on such a node.
    expect(warnings()).toContain('previews as an addition');
    expect(warnings()).toContain('DELETE row shows an empty previous side');
  });

  it('says nothing for a healthy record', async () => {
    // The non-firing side. A warning on an ordinary run is what makes users
    // stop reading warnings.
    const node = await diff(record({ Value: 'x' }));
    expect(node.changes.get(TORN_ID)?.changeType).toBe('NO_CHANGE');
    expect(warnings()).not.toContain("'properties' map cannot be read");
  });

  it('says nothing for a record whose bag is genuinely empty', async () => {
    await diff(record({}));
    expect(warnings()).not.toContain("'properties' map cannot be read");
  });

  // ---- the RECURSIVE arms. Everything above returns at
  // `if (!recursive) return node;`, so without these the nested and
  // deleted-child walks were entirely unexercised despite this file's header
  // claiming them (review of go-to-k/cdkd#3191).

  it('repairs a DELETED child rather than aborting the whole tree', async () => {
    // `buildDeletedSubtree` diffs a child that state still holds against an
    // EMPTY template, so every row is a DELETE whose previous side is the
    // repaired `{}`. Unrepaired this threw the deploy's refusal out of
    // `cdkd diff` and took the parent's preview with it.
    const parent: StackState = {
      ...record({}),
      resources: {
        Child: {
          physicalId: 'c',
          resourceType: 'AWS::CloudFormation::Stack',
          properties: {},
        },
      },
    };
    const node = await diff(parent, {
      recursive: true,
      tpl: { Resources: {} },
      children: { [`${STACK}~Child`]: { ...record('abcdef'), stackName: `${STACK}~Child` } },
    });
    // The parent still previewed, and the child node is present with its row.
    const child = node.children.find((c) => c.stackName === `${STACK}~Child`);
    expect(child).toBeDefined();
    expect(child!.changes.get(TORN_ID)?.changeType).toBe('DELETE');
    // The warning names the stack the record came from — a healthy parent sits
    // above a torn child, which is the per-node claim `docs/cli-diff.md` makes.
    // Shell-quoted because of the `~`, the same rendering the sibling
    // container's test pins.
    expect(warnings()).toContain(`State for '${STACK}~Child'`);
    expect(warnings()).toContain(TORN_ID);
  });

  it('repairs a torn ADOPTED rollback-orphan record spliced in after the load', async () => {
    // `state.orphans` is a container `loadStateOrEmpty` never walks, and
    // `computeStackDiff` splices the adopted records straight into the bag it
    // hands the calculator. Unrepaired, a torn one aborted `cdkd diff` with
    // the deploy's refusal — on the command a user runs to inspect exactly
    // this kind of damage (review of go-to-k/cdkd#3191).
    const orphanId = 'AdoptedGamma';
    const orphanRecord: StackOrphanRecord = {
      logicalId: orphanId,
      state: entry('abcdef'),
    } as unknown as StackOrphanRecord;
    const state = record({ Value: 'x' }, { orphans: [orphanRecord] });
    const tpl: CloudFormationTemplate = {
      Resources: {
        [TORN_ID]: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
        [orphanId]: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'y' } },
      },
    };
    const node = await diff(state, {
      tpl,
      previewOrphanAdoption: async () => ({
        adopted: { [orphanId]: entry('abcdef') },
        refusals: [],
      }),
    });
    // It REPORTED rather than aborting, and named the adopted record.
    expect(node.changes.get(orphanId)?.changeType).toBe('UPDATE');
    expect(warnings()).toContain(orphanId);
    // And the torn bag did not invent one row per character.
    expect((node.changes.get(orphanId)?.propertyChanges ?? []).map((c) => c.path)).toEqual([
      'Value',
    ]);
  });

  it('says nothing about adoption when every adopted record is healthy', async () => {
    const orphanId = 'AdoptedGamma';
    const state = record({ Value: 'x' }, {
      orphans: [{ logicalId: orphanId, state: entry({ Value: 'y' }) } as unknown as StackOrphanRecord],
    });
    const tpl: CloudFormationTemplate = {
      Resources: {
        [TORN_ID]: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
        [orphanId]: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'y' } },
      },
    };
    await diff(state, {
      tpl,
      previewOrphanAdoption: async () => ({
        adopted: { [orphanId]: entry({ Value: 'y' }) },
        refusals: [],
      }),
    });
    expect(warnings()).not.toContain("'properties' map cannot be read");
    // The ENTRY guard's negative too: with every orphan healthy the entry
    // warning must not fire, or a guard dropped from the drop-and-warn block
    // would report `0 resource record(s)` on an ordinary run.
    expect(warnings()).not.toContain('cannot be read as resources');
  });

  it('drops an unreadable ENTRY before repairing properties, so a typeless torn row is reported once', async () => {
    // An OBJECT entry with no `resourceType` and a torn `properties` map is
    // named by BOTH predicates. The load drops entries first; swapped, this row
    // would be warned about as a preview ("every property it declares previews
    // as an addition") and then dropped, so the first warning describes a row
    // the diff no longer holds. The `null` entry is the control for the entry
    // warning, and the typed torn row the control for the properties one.
    const state = record('abcdef', {
      resources: {
        AlphaNull: null as unknown as ResourceState,
        BetaTypeless: { physicalId: 'p', properties: 'x' } as unknown as ResourceState,
        [TORN_ID]: entry('abcdef'),
      },
    });
    const node = await diff(state);
    expect(node.unreadable).toEqual(['AlphaNull', 'BetaTypeless']);
    const calls = (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (args) => String(args[0])
    );
    const entriesWarning = calls.filter((m) => m.includes('cannot be read as resources'));
    const propertiesWarning = calls.filter((m) => m.includes("'properties' map cannot be read"));
    expect(entriesWarning).toHaveLength(1);
    expect(propertiesWarning).toHaveLength(1);
    expect(entriesWarning[0]).toContain('AlphaNull');
    expect(entriesWarning[0]).toContain('BetaTypeless');
    expect(propertiesWarning[0]).toContain(TORN_ID);
    expect(propertiesWarning[0]).not.toContain('BetaTypeless');
  });

  it('drops an unreadable ORPHAN record BEFORE the adoption preview reads it', async () => {
    // The ENTRY half of the second pass this file already covers for
    // `properties`, and the half that has to run EARLIER. `planOrphanAdoption`
    // destructures each record and routes a provider by `state.resourceType`;
    // the `catch` around that call names the same field AGAIN, so a torn record
    // throws a TypeError straight OUT of the catch — go-to-k/cdkd#3018's class,
    // on `cdkd diff`. Repairing after the preview cannot help, because the
    // throw happens inside it.
    //
    // The stand-in below dereferences exactly what the real planner does, so
    // dropping the filter reproduces the abort rather than quietly passing a
    // torn record to a fake that never looks at it.
    const healthyId = 'AdoptedGamma';
    // Four value shapes the ENTRY predicate rejects rather than `null` alone: a
    // `!= null` guard admits the string, the number and the typeless object.
    // Of the shapes below, a `null` `state`, an absent one, a primitive record
    // and a `null` record ABORT; the string, the number and the typeless object
    // reach `state.resourceType` as `undefined`, which the planner's provider
    // lookup refuses and its catch keeps with a notice the preview discards —
    // so dropping those three is about naming a silently kept record rather
    // than about a throw.
    const orphans = [
      { logicalId: 'TornNull', state: null },
      { logicalId: 'TornString', state: 'abcdef' },
      // A non-string `logicalId` has no name to print either, so it takes the
      // same stand-in as the record with no id at all.
      { logicalId: 4242, state: null },
      { logicalId: 'TornNumber', state: 5 },
      { logicalId: 'TornTypeless', state: { physicalId: 'p', properties: {} } },
      // The two other ABORTING shapes: no `state` at all, and a primitive
      // record, whose `state` destructures to `undefined` the same way.
      { logicalId: 'TornAbsent' },
      7,
      // The record itself is `null`: `const { logicalId, state } = record`
      // throws one line earlier, and there is no id to name it by.
      null,
      { logicalId: healthyId, state: entry({ Value: 'y' }) },
    ] as unknown as StackOrphanRecord[];
    const tpl: CloudFormationTemplate = {
      Resources: {
        [TORN_ID]: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
        [healthyId]: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'y' } },
      },
    };
    let previewed: readonly unknown[] = [];
    const node = await diff(record({ Value: 'x' }, { orphans }), {
      tpl,
      previewOrphanAdoption: async (state) => {
        previewed = state.orphans ?? [];
        for (const orphanRecord of previewed as StackOrphanRecord[]) {
          const { logicalId, state: entryState } = orphanRecord;
          void `${logicalId} ${entryState.resourceType}`;
        }
        return { adopted: { [healthyId]: entry({ Value: 'y' }) }, refusals: [] };
      },
    });
    // The preview saw the healthy record only...
    expect(previewed).toHaveLength(1);
    expect((previewed[0] as StackOrphanRecord).logicalId).toBe(healthyId);
    // ...the healthy one was still adopted, so the guard did not cost the
    // feature. `NO_CHANGE` is what proves the splice: `DiffCalculator` decides
    // CREATE by ABSENCE from state, so an unadopted record would read `CREATE`
    // here however healthy it is.
    expect(node.changes.get(healthyId)?.changeType).toBe('NO_CHANGE');
    // ...and every torn record was REPORTED: eight against a five-name cap,
    // so the first five are named — the numeric-id one among them through
    // `displayLogicalId`'s existing stand-in rather than a new literal — and
    // the last three, the two other id-less records included, are the
    // overflow count.
    const entriesWarning = warnings()
      .split('\n')
      .filter((m) => m.includes('cannot be read as resources'));
    expect(entriesWarning).toHaveLength(1);
    // M16: it names the container it is ABOUT. Reusing the `resources` text
    // sent a reader to a map that is healthy, and when both sources fire the
    // two warnings opened with the identical sentence.
    expect(entriesWarning[0]).toContain("rollback-orphan record(s) in 'orphans'");
    expect(entriesWarning[0]).not.toContain('resource record(s)');
    for (const id of ['TornNull', 'TornString', 'TornNumber', 'TornTypeless']) {
      expect(entriesWarning[0], id).toContain(id);
    }
    expect(entriesWarning[0]).toContain('<unrenderable>');
    expect(entriesWarning[0]).toContain('8 rollback-orphan record(s)');
    expect(entriesWarning[0]).toContain('and 3 more');
    // The numeric id is not RENDERED as `4242`: it takes the stand-in, which a
    // guard keyed on absence rather than on the type would not do.
    expect(entriesWarning[0]).not.toContain('4242');
    expect(entriesWarning[0]).not.toContain(healthyId);
    // And they are CARRIED, not only warned about: the same list `--json`
    // prints and `--fail` counts, in record order, the id-less ones as `''`.
    // A warn-only drop would let `--fail` exit 0 over the record that used to
    // crash this command — the M7 shape one container over.
    expect(node.unreadable).toEqual([
      'TornNull',
      'TornString',
      '',
      'TornNumber',
      'TornTypeless',
      'TornAbsent',
      '',
      '',
    ]);
  });

  it('counts a dropped ORPHAN record as a change for --fail, with nothing else changed', async () => {
    // The `--fail` half on its own: no healthy adoption (which would satisfy
    // `nodeHasChanges` by itself) and a template that matches state, so the
    // torn record is the ONLY thing that can make this node count. A warn-only
    // drop leaves it at `false`, and `cdkd diff --fail` exits 0 over the record
    // that used to crash it.
    const node = await diff(record({ Value: 'x' }, { orphans: [{ logicalId: 'Torn', state: null }] as unknown as StackOrphanRecord[] }), {
      previewOrphanAdoption: async () => ({ adopted: {}, refusals: [] }),
    });
    expect(node.changes.get(TORN_ID)?.changeType).toBe('NO_CHANGE');
    expect(node.adoptedOrphans).toEqual([]);
    expect(node.unreadable).toEqual(['Torn']);
    expect(nodeHasChanges(node)).toBe(true);
  });

  it('carries a dropped ORPHAN id out to the renderer and to --json', async () => {
    // n16 of the round-5 review: the other cases stop at the in-memory
    // `node.unreadable`. Both readers take that single joined field with no
    // per-source branch, so there is no divergent path today — this is the
    // fence that keeps it that way.
    //
    // NOT extended to a nested child, and the reason is a property of the walk
    // rather than of this file: `buildDeletedSubtree` threads no
    // `previewOrphanAdoption`, so a state-only child never previews an adoption
    // and has no orphan record to drop; a TEMPLATE-declared child does get the
    // preview, but reaching one needs a `nestedTemplates` entry pointing at a
    // real file, which this harness does not build.
    const state = record({ Value: 'x' }, {
      orphans: [{ logicalId: 'TornOrphan', state: null }] as unknown as StackOrphanRecord[],
    });
    const node = await diff(state, {
      previewOrphanAdoption: async () => ({ adopted: {}, refusals: [] }),
    });

    expect(node.unreadable).toEqual(['TornOrphan']);
    expect(diffTreeToJson(node).unreadable).toEqual(['TornOrphan']);

    const lines: string[] = [];
    renderDiffTree(node, true, (m) => lines.push(m));
    const text = lines.join('\n');
    expect(text).toContain('1 state record row(s) could not be read: TornOrphan.');
  });

  it('keeps the LOAD\'s dropped rows ahead of the dropped orphan records, both surviving', async () => {
    // The two sources APPEND. Both cases above start from a healthy `resources`
    // map, so a node built from whichever list is non-empty passed them while
    // losing the load's rows the moment both sources carry one.
    const state = record(
      { Value: 'x' },
      {
        resources: {
          [TORN_ID]: entry({ Value: 'x' }),
          AlphaNull: null as unknown as ResourceState,
        },
        orphans: [{ logicalId: 'TornOrphan', state: null }] as unknown as StackOrphanRecord[],
      }
    );
    const node = await diff(state, {
      previewOrphanAdoption: async () => ({ adopted: {}, refusals: [] }),
    });
    expect(node.unreadable).toEqual(['AlphaNull', 'TornOrphan']);

    // And the two TEXTS, which this case is the only one that can falsify.
    // Both containers are damaged here, so a warning claiming the OTHER one is
    // intact is false — the claim the orphan text carried in two drafts before
    // it shipped ("the `resources` map is not what is damaged"), and which
    // nothing reddened, because the case that disproves it asserted only
    // `node.unreadable`. The membership spelling is unsafe for the same
    // reason at one remove: an already-managed logical id sits in BOTH
    // containers, so "these ids are not from `resources`" can name an id that
    // is. PROVENANCE is what the sentence may claim.
    const both = warnings().split('\n');
    const orphanText = both.filter((m) => m.includes("in 'orphans'"));
    const entriesText = both.filter((m) => m.includes('resource record(s)'));
    expect(orphanText).toHaveLength(1);
    expect(entriesText).toHaveLength(1);
    expect(orphanText[0]).toContain("were read from 'orphans'");
    for (const claim of ['not what is damaged', 'is healthy', "not from the 'resources' map"]) {
      expect(orphanText[0], claim).not.toContain(claim);
      expect(entriesText[0], claim).not.toContain(claim);
    }
  });
});
