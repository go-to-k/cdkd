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
import { buildDiffTree } from '../../../src/cli/commands/diff-recursive.js';
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
  });
});
