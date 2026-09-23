import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STATE_RESOURCES_MALFORMED,
  malformedOrphanResourceAttributesRefusalMessage,
  malformedOrphanResourceEntriesRefusalMessage,
  malformedOrphanResourcePropertiesRefusalMessage,
  malformedOrphansForOrphanRefusalMessage,
  malformedOutputsRefusalMessage,
  malformedStateRefusalMessage,
  refuseMalformedOrphansForOrphan,
  refuseMalformedResourceAttributesForOrphan,
  refuseMalformedResourceEntriesForOrphan,
  unreadableOrphanRecords,
  unreadableResourceAttributeBags,
} from '../../../src/state/malformed-resources-bag.js';
import { UNRENDERABLE } from '../../../src/utils/display-safe.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * `cdkd orphan`'s guards over what its save keeps beyond a survivor's
 * `properties` map (go-to-k/cdkd#3350, #3345, #3344), and the region-less
 * legacy arm the state / outputs refusals gained (go-to-k/cdkd#3388). The
 * command-level cases, through the real rewriter, are in
 * `tests/unit/cli/orphan.test.ts`.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Source with comments removed, so a fence cannot be satisfied by prose. */
function code(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function record(resources: unknown, extra: Partial<StackState> = {}): StackState {
  return {
    version: 10,
    stackName: 'S',
    region: 'us-east-1',
    resources: resources as StackState['resources'],
    outputs: {},
    lastModified: 0,
    ...extra,
  };
}

const OK = { physicalId: 'p', resourceType: 'AWS::S3::Bucket', properties: {} };

function thrown(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('refuseMalformedResourceEntriesForOrphan (go-to-k/cdkd#3350)', () => {
  it('refuses a SURVIVING unreadable entry with the class code', () => {
    const e = thrown(() =>
      refuseMalformedResourceEntriesForOrphan(record({ A: OK, B: 'abcdef' }), ['A'], 'S', 'us-east-1')
    );
    expect(e).toBeInstanceOf(CdkdError);
    expect((e as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
    expect((e as Error).message).toContain('— B —');
  });

  it('subtracts the orphan set, so dropping the damaged entry stays possible', () => {
    expect(() =>
      refuseMalformedResourceEntriesForOrphan(record({ A: OK, B: null }), ['B'], 'S', 'us-east-1')
    ).not.toThrow();
  });

  it('is silent on an unreadable BAG, which refuseMalformedState owns', () => {
    expect(() =>
      refuseMalformedResourceEntriesForOrphan(record('abcdef'), [], 'S', 'us-east-1')
    ).not.toThrow();
  });
});

describe('the attributes container (go-to-k/cdkd#3345)', () => {
  it('names every entry whose map is null or not an object, and nothing else', () => {
    const state = record({
      Absent: OK,
      Empty: { ...OK, attributes: {} },
      Str: { ...OK, attributes: 'abcdef' },
      Nul: { ...OK, attributes: null },
      List: { ...OK, attributes: [] },
      Zero: { ...OK, attributes: 0 },
      // Not an object at all: the ENTRY class names it, not this one.
      Torn: 'abcdef',
    });
    expect([...unreadableResourceAttributeBags(state)].sort()).toEqual(['List', 'Nul', 'Str', 'Zero']);
    expect(unreadableResourceAttributeBags(record(null))).toEqual([]);
  });

  it('renders each id through the display boundary, and caps the list', () => {
    const hostile = malformedOrphanResourceAttributesRefusalMessage('S', 'r', ['A\x1b[31m', '']);
    expect(hostile).not.toContain('\x1b');
    expect(hostile).toContain(UNRENDERABLE);
    const text = malformedOrphanResourceAttributesRefusalMessage('S', 'r', [
      'A', 'B', 'C', 'D', 'E', 'F', 'G',
    ]);
    expect(text).toContain('holds 7 resource record(s)');
    expect(text).toContain('and 2 more');
    expect(text).not.toContain('F,');
  });

  it('refuses a survivor and subtracts the orphan set', () => {
    const state = record({ A: { ...OK, attributes: 'x' }, B: OK });
    expect(() => refuseMalformedResourceAttributesForOrphan(state, ['A'], 'S', 'r')).not.toThrow();
    expect(() => refuseMalformedResourceAttributesForOrphan(state, ['B'], 'S', 'r')).toThrow(
      `whose 'attributes' map cannot be read — A —`
    );
  });
});

describe('the orphans list and its records (go-to-k/cdkd#3344)', () => {
  const rec = (state: unknown, logicalId: unknown = 'R'): unknown => ({
    logicalId,
    orphanedAt: 1,
    state,
  });

  it('names each record by the part of it a reader cannot use', () => {
    const orphans = [
      rec(OK, 'Healthy'),
      rec({ ...OK, attributes: { Arn: 'a' } }, 'HealthyWithCache'),
      rec({ ...OK, properties: 'abcdef' }, 'TornProperties'),
      rec({ ...OK, properties: undefined }, 'NoProperties'),
      rec({ ...OK, attributes: null }, 'TornAttributes'),
      rec({ physicalId: 'p', properties: {} }, 'NoType'),
      rec(null, 'NullState'),
      'a string record',
      rec('abc', 5),
      // A HEALTHY state with no string id (go-to-k/cdkd#3500's other half):
      // such rows key one map entry and collapse in `orphansAfterRollback`.
      // Literal, not `rec(OK, undefined)`: the default parameter would fill it.
      { orphanedAt: 1, state: OK },
      rec(OK, 7),
      null,
      5,
    ] as unknown as StackState['orphans'];
    expect(unreadableOrphanRecords({ orphans })).toEqual([
      'TornProperties',
      'NoProperties',
      'TornAttributes',
      'NoType',
      'NullState',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
  });

  it('is silent on an absent or unreadable CONTAINER — the refusal asks that first', () => {
    expect(unreadableOrphanRecords({})).toEqual([]);
    expect(unreadableOrphanRecords({ orphans: 'abc' as unknown as StackState['orphans'] })).toEqual(
      []
    );
  });

  it('refuses the container and the records with their own arms, and passes a healthy list', () => {
    const container = thrown(() =>
      refuseMalformedOrphansForOrphan({ orphans: {} as unknown as StackState['orphans'] }, 'S', 'r')
    ) as Error;
    expect(container.message).toContain(`has no readable 'orphans' list`);
    const records = thrown(() =>
      refuseMalformedOrphansForOrphan(
        { orphans: [rec({ ...OK, properties: 5 }, 'Gone')] as StackState['orphans'] },
        'S',
        'r'
      )
    ) as Error;
    expect(records.message).toContain(`rollback-orphan record(s) in 'orphans' that cannot be read — Gone —`);
    expect(() => refuseMalformedOrphansForOrphan({}, 'S', 'r')).not.toThrow();
    expect(() => refuseMalformedOrphansForOrphan({ orphans: [] }, 'S', 'r')).not.toThrow();
    expect(() =>
      refuseMalformedOrphansForOrphan({ orphans: [rec(OK)] as StackState['orphans'] }, 'S', 'r')
    ).not.toThrow();
  });

  it('renders a record with no string logicalId as the stand-in, and caps the list', () => {
    expect(malformedOrphansForOrphanRefusalMessage('S', 'r', [''])).toContain(UNRENDERABLE);
    const text = malformedOrphansForOrphanRefusalMessage('S', 'r', ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(text).toContain('holds 7 rollback-orphan record(s)');
    expect(text).toContain('and 2 more');
    expect(text).not.toContain('F,');
  });
});

describe('the three texts share the properties refusal\'s remedy half', () => {
  const BUILT: ReadonlyArray<readonly [string, string]> = [
    ['entries', malformedOrphanResourceEntriesRefusalMessage('S', 'us-east-1', ['A'])],
    ['attributes', malformedOrphanResourceAttributesRefusalMessage('S', 'us-east-1', ['A'])],
    ['orphans records', malformedOrphansForOrphanRefusalMessage('S', 'us-east-1', ['A'])],
    ['orphans container', malformedOrphansForOrphanRefusalMessage('S', 'us-east-1', undefined)],
  ];
  const properties = malformedOrphanResourcePropertiesRefusalMessage('S', 'us-east-1', ['A']);
  const tailLines = (text: string): string[] => text.split('\n').slice(1);

  it.each(BUILT)('%s: the same command lines, and the same two template-free ways out', (_l, text) => {
    expect(tailLines(text)).toEqual(tailLines(properties));
    expect(text).toContain(
      `No state was written. Two ways out need no CDK app: repair the record by hand, or drop it ` +
        `whole with the 'Drop the record' command below`
    );
    expect(text).toContain(`under '--dry-run' too`);
  });

  it('only the survivor-scoped texts offer cdkd orphan <construct path>', () => {
    for (const [label, text] of BUILT) {
      const survivor = label === 'entries' || label === 'attributes';
      expect(text.includes('only while the CDK app STILL DECLARES'), label).toBe(survivor);
    }
  });

  it('the orphans texts forbid the deletion a hand repair would reach for', () => {
    expect(BUILT[2]![1]).toContain('Repair the record by hand rather than deleting it');
    expect(BUILT[3]![1]).toContain('rewriting it to [] by hand discards');
  });

  it('only the orphans texts caveat the drop remedy, which discards the same list', () => {
    for (const [label, text] of BUILT) {
      const orphans = label.startsWith('orphans');
      expect(text.includes(`it also discards the 'orphans' list`), label).toBe(orphans);
    }
    expect(properties).not.toContain(`discards the 'orphans' list`);
  });
});

describe('the state and outputs refusals for a region-less legacy record (go-to-k/cdkd#3388)', () => {
  const BUILDERS = [
    ['state', malformedStateRefusalMessage],
    ['outputs', malformedOutputsRefusalMessage],
  ] as const;

  it.each(BUILDERS)('%s: names the object, with the real prefix and bucket', (_l, build) => {
    const text = build('MyStack', undefined, { stateBucket: 'b', statePrefix: 'custom' });
    expect(text).not.toMatch(/cdkd state show MyStack/);
    const lines = text.split('\n');
    expect(lines.slice(1)).toEqual(['Object key: custom/MyStack/state.json', 'State bucket: b']);
  });

  it.each(BUILDERS)('%s: without recovery, the prefix is a quoted hole and says so', (_l, build) => {
    const text = build('MyStack', undefined);
    expect(text).toContain(`Its prefix is 'cdkd' unless '--state-prefix' was given.`);
    expect(text.split('\n').slice(1)).toEqual([`Object key: '<prefix>/MyStack/state.json'`]);
  });

  it.each(BUILDERS)('%s: with NO identity at all, still ends on the two-hole command', (_l, build) => {
    for (const region of ['', undefined]) {
      expect(build('', region)).toMatch(
        /Inspect it with: cdkd state show '<stack>' --stack-region '<region>' --json$/
      );
    }
  });

  it.each(BUILDERS)('%s: an inexact name prints no object path', (_l, build) => {
    const text = build('prod-api ', undefined, { stateBucket: 'b' });
    expect(text).not.toContain('Object key');
    expect(text).toContain('did not render exactly');
  });

  it.each(BUILDERS)('%s: CONTROL — a region-keyed record is unchanged, ending on the command', (_l, build) => {
    const text = build('MyStack', 'us-east-1', { stateBucket: 'b' });
    expect(text.endsWith('Inspect it with: cdkd state show MyStack --stack-region us-east-1 --json')).toBe(true);
    expect(text).not.toContain('\n');
  });
});

describe('cdkd orphan wires every load refusal (source fence)', () => {
  const ORPHAN = 'src/cli/commands/orphan.ts';
  const src = code(ORPHAN);
  /** Each refusal at the load, and whether it is scoped by the orphan set. */
  const CALLS: ReadonlyArray<readonly [string, boolean]> = [
    ['refuseMalformedState(', false],
    ['refuseMalformedOutputs(', false],
    ['refuseMalformedResourceEntriesForOrphan(', true],
    ['refuseMalformedResourcePropertiesForOrphan(', true],
    ['refuseMalformedResourceAttributesForOrphan(', true],
    ['refuseMalformedOrphansForOrphan(', false],
  ];

  it.each(CALLS)('%s is an unconditional statement above the rewrite and the dry-run return', (name, scoped) => {
    const at = src.indexOf(name);
    expect(at, `${ORPHAN} no longer calls ${name}`).toBeGreaterThan(-1);
    expect(src.indexOf(name, at + 1), `${ORPHAN} calls ${name} twice`).toBe(-1);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(src).toMatch(new RegExp(`\\n\\s*${escaped}`));
    expect(at).toBeLessThan(src.indexOf('rewriteResourceReferences('));
    expect(at).toBeLessThan(src.indexOf('if (options.dryRun)'));
    // No dry-run gate in the stretch between the load and this call.
    expect(src.slice(src.indexOf('const { state, etag'), at)).not.toContain('dryRun');
    const call = src.slice(at, src.indexOf(');', at));
    // The region the record is LISTED under — go-to-k/cdkd#3388 for the first
    // two, go-to-k/cdkd#3359 for the properties one.
    expect(call).toContain('recordRegion');
    expect(call).not.toContain('targetRegion');
    expect(call).toContain('recovery');
    expect(call).toContain('stackInfo.stackName');
    expect(call.includes('orphanLogicalIds'), 'the orphan-set scope').toBe(scoped);
  });
});

describe('ONE exactness spelling in the module (go-to-k/cdkd#3388)', () => {
  it('no comparison of a safe* rendering against its input outside rendersExactly', () => {
    const src = code('src/state/malformed-resources-bag.ts');
    const start = src.indexOf('function rendersExactly(');
    expect(start, 'rendersExactly was renamed; this fence reads nothing').toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    const outside = src.slice(0, start) + src.slice(end);
    const inline = /safe(?:Identifier|StackName|Region)\([^;]*?\)\s*[!=]==|[!=]==\s*safe(?:Identifier|StackName|Region)\(/;
    expect(outside).not.toMatch(inline);
    // Non-vacuity: the predicate's own body IS such a comparison.
    expect(src.slice(start, end)).toMatch(inline);
  });
});
