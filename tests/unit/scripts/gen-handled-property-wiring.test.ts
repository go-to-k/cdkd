import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  HANDLED_WIRING_ALLOW_LIST,
  PREVIOUS_PROPERTY_BAG_PARAM_NAMES,
  PROPERTY_BAG_PARAM_NAMES,
  allowKey,
  buildReport,
  classifySource,
  findGaps,
  findStaleAllowListEntries,
  type AllowListEntry,
  type ClassClassification,
} from '../../../scripts/gen-handled-property-wiring.js';

const PROVIDERS_DIR = resolve(process.cwd(), 'src/provisioning/providers');
const ECR_PROVIDER = resolve(PROVIDERS_DIR, 'ecr-provider.ts');

/** Wrap a class body in a `handledProperties` declaration for one type. */
const withDeclaration = (props: readonly string[], body: string, className = 'P'): string => `
  export class ${className} {
    handledProperties = new Map<string, ReadonlySet<string>>([
      ['AWS::Test::Thing', new Set([${props.map((p) => `'${p}'`).join(', ')}])],
    ]);
    ${body}
  }
`;

const only = (source: string, allow?: ReadonlyMap<string, AllowListEntry>): ClassClassification => {
  const classes = classifySource(source, 'test-provider.ts', allow);
  expect(classes).toHaveLength(1);
  return classes[0]!;
};

describe('evidence shapes', () => {
  it('counts an element-access read off the property bag', () => {
    const c = only(
      withDeclaration(['Alpha'], `create(id, type, properties) { send({ a: properties['Alpha'] }); }`)
    );
    expect(c.bucket).toBe('wired');
    expect(c.properties[0]?.evidence).toContain('element-read');
  });

  it('counts a dotted property read', () => {
    const c = only(
      withDeclaration(['Alpha'], `create(id, type, properties) { send({ a: properties.Alpha }); }`)
    );
    expect(c.bucket).toBe('wired');
    expect(c.properties[0]?.evidence).toContain('property-read');
  });

  it('counts an object destructure, including a renamed binding', () => {
    const c = only(
      withDeclaration(
        ['Alpha', 'Beta'],
        `create(id, type, properties) { const { Alpha, Beta: b } = properties; send({ Alpha, b }); }`
      )
    );
    expect(c.bucket).toBe('wired');
    expect(c.properties.map((p) => p.evidence)).toEqual([['destructure'], ['destructure']]);
  });

  it('follows a local alias of the bag', () => {
    const c = only(
      withDeclaration(['Alpha'], `create(id, type, properties) { const p = properties; send(p['Alpha']); }`)
    );
    expect(c.bucket).toBe('wired');
  });

  it('does NOT count a bare string literal, a comment, or the declaration itself', () => {
    // The #1392 shape exactly: the name is present in the file (in the
    // declaration and in a doc comment) but never read off the bag.
    const c = only(
      withDeclaration(
        ['Alpha'],
        `
        /** Alpha is handled by the create call. */
        create(id, type, properties) {
          const names = ['Alpha'];
          send({ other: properties['Beta'] });
        }
        getDriftUnknownPaths() { return ['Alpha']; }
        `
      )
    );
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['Alpha']);
  });

  it('does NOT count a readCurrentState reverse-mapping WRITE', () => {
    // `result['Alpha'] = ...` writes a CFn-named key onto an OUTPUT object; it
    // proves the drift READ path, never that a template value reaches AWS.
    const c = only(
      withDeclaration(
        ['Alpha'],
        `readCurrentState(physicalId, type) { const result = {}; result['Alpha'] = live.alpha; return result; }`
      )
    );
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['Alpha']);
  });
});

describe('delegation', () => {
  it('follows this.helper(properties) into a private member', () => {
    const c = only(
      withDeclaration(
        ['Alpha'],
        `
        create(id, type, properties) { send(this.buildInput(properties)); }
        private buildInput(props) { return { a: props['Alpha'] }; }
        `
      )
    );
    expect(c.bucket).toBe('wired');
    expect(c.properties[0]?.evidence).toContain('delegated');
  });

  it('follows a spread call `...this.toFields(properties)`', () => {
    const c = only(
      withDeclaration(
        ['Alpha'],
        `
        create(id, type, properties) { send({ ...this.toFields(properties) }); }
        private toFields(bag) { return { a: bag['Alpha'] }; }
        `
      )
    );
    expect(c.bucket).toBe('wired');
  });

  it('follows a FILE-LOCAL free function', () => {
    const src = `
      function buildCommon(bag) { return { a: bag['Alpha'] }; }
      ${withDeclaration(['Alpha'], `create(id, type, properties) { send(buildCommon(properties)); }`)}
    `;
    expect(only(src).bucket).toBe('wired');
  });

  it('taints an arrow-function class PROPERTY member too', () => {
    const c = only(
      withDeclaration(
        ['Alpha'],
        `
        create(id, type, properties) { send(this.build(properties)); }
        private build = (bag) => ({ a: bag['Alpha'] });
        `
      )
    );
    expect(c.bucket).toBe('wired');
  });

  it('does NOT taint a helper handed a SUB-read of the bag', () => {
    // `this.toSdk(properties['Alpha'])` already counted Alpha at the call site;
    // the helper's own `x['Beta']` reads INSIDE that sub-object and must not
    // vouch for the top-level Beta declaration.
    const c = only(
      withDeclaration(
        ['Alpha', 'Beta'],
        `
        create(id, type, properties) { send(this.toSdk(properties['Alpha'])); }
        private toSdk(x) { return { b: x['Beta'] }; }
        `
      )
    );
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['Beta']);
  });

  it('terminates on a delegation cycle', () => {
    const c = only(
      withDeclaration(
        ['Alpha'],
        `
        create(id, type, properties) { this.a(properties); }
        private a(bag) { this.b(bag); return bag['Alpha']; }
        private b(bag) { this.a(bag); }
        `
      )
    );
    expect(c.bucket).toBe('wired');
  });
});

describe('per-class scoping (the #1393 item-2 trap)', () => {
  it('a SIBLING class in the same file cannot vouch for this class', () => {
    // Many provider files hold several classes. A file-global literal match
    // would clear `Other`'s declaration on the strength of `Wirer`'s read.
    const src = `
      export class Wirer {
        handledProperties = new Map([['AWS::Test::A', new Set(['Alpha'])]]);
        create(id, type, properties) { send(properties['Alpha']); }
      }
      export class Other {
        handledProperties = new Map([['AWS::Test::B', new Set(['Alpha'])]]);
        create(id, type, properties) { send(properties['Beta']); }
      }
    `;
    const classes = classifySource(src, 'multi.ts');
    expect(classes.map((c) => [c.className, c.bucket])).toEqual([
      ['Wirer', 'wired'],
      ['Other', 'gap'],
    ]);
  });

  it('a file-local helper lends evidence ONLY to the class that calls it', () => {
    const src = `
      function build(bag) { return { a: bag['Alpha'] }; }
      export class Caller {
        handledProperties = new Map([['AWS::Test::A', new Set(['Alpha'])]]);
        create(id, type, properties) { send(build(properties)); }
      }
      export class NonCaller {
        handledProperties = new Map([['AWS::Test::B', new Set(['Alpha'])]]);
        create(id, type, properties) { send({}); }
      }
    `;
    const classes = classifySource(src, 'multi.ts');
    expect(classes.map((c) => c.bucket)).toEqual(['wired', 'gap']);
  });
});

describe('previous-state bags are not evidence', () => {
  it('the two name sets are disjoint', () => {
    for (const n of PREVIOUS_PROPERTY_BAG_PARAM_NAMES) {
      expect(PROPERTY_BAG_PARAM_NAMES.has(n)).toBe(false);
    }
  });

  it('a read off previousProperties alone is a gap (the diff-only disguise)', () => {
    // Diffing a property proves it participates in change DETECTION; it says
    // nothing about the value ever reaching AWS.
    const c = only(
      withDeclaration(
        ['Alpha'],
        `update(id, pid, type, properties, previousProperties) { if (previousProperties['Alpha']) send({}); }`
      )
    );
    expect(c.bucket).toBe('gap');
  });

  it('a previous bag handed to a helper by a call edge still does not taint', () => {
    const c = only(
      withDeclaration(
        ['Alpha'],
        `
        update(id, pid, type, properties, previousProperties) { this.diff(previousProperties); }
        private diff(previousProperties) { return previousProperties['Alpha']; }
        `
      )
    );
    expect(c.bucket).toBe('gap');
  });
});

describe('table-driven evidence', () => {
  it('credits every name of an INLINE literal array loop', () => {
    const c = only(
      withDeclaration(
        ['Alpha', 'Beta'],
        `update(id, pid, type, properties) { for (const k of ['Alpha', 'Beta']) { send(properties[k]); } }`
      )
    );
    expect(c.bucket).toBe('wired');
    expect(c.properties.map((p) => p.evidence)).toEqual([['table-loop'], ['table-loop']]);
  });

  it('credits a FILE-LOCAL const array table, through an `as` cast on the key', () => {
    // The real GlueJobProvider shape: `p[k as string]`.
    const src = `
      const passThrough = ['Alpha', 'Beta'];
      ${withDeclaration(['Alpha', 'Beta'], `create(id, type, properties) { for (const k of passThrough) { send(properties[k as string]); } }`)}
    `;
    expect(only(src).bucket).toBe('wired');
  });

  it('credits an Object.entries(TABLE) destructured loop', () => {
    // The real SQSQueueProvider shape.
    const src = `
      const CDK_TO_SQS = { Alpha: 'alpha', Beta: 'beta' };
      ${withDeclaration(['Alpha', 'Beta'], `create(id, type, properties) { for (const [cdkKey, sqsKey] of Object.entries(CDK_TO_SQS)) { send(properties[cdkKey]); } }`)}
    `;
    expect(only(src).bucket).toBe('wired');
  });

  it('a declared property MISSING from the table is still a gap', () => {
    // The whole point of recognizing the shape rather than allow-listing it:
    // adding a declaration without adding it to the table must still fail.
    const src = `
      const passThrough = ['Alpha'];
      ${withDeclaration(['Alpha', 'Gamma'], `create(id, type, properties) { for (const k of passThrough) { send(properties[k]); } }`)}
    `;
    const c = only(src);
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['Gamma']);
  });

  it('an UNRESOLVABLE computed key credits nothing and records a blind spot', () => {
    const c = only(
      withDeclaration(
        ['Alpha'],
        `create(id, type, properties) { for (const k of computeKeys()) { send(properties[k]); } }`
      )
    );
    expect(c.bucket).toBe('gap');
    expect(c.blindSpots).toEqual(['computed key in create()']);
  });
});

describe('blind spots are recorded but never an excuse', () => {
  it('an unresolvable whole-bag call does NOT clear an un-read declaration', () => {
    // The regression this guards: ECRProvider calls the imported
    // `hasCdkAutoDeleteTag(properties)` in delete(). A draft that let a blind
    // spot blanket-excuse the class silenced the very #1392 property.
    const c = only(
      withDeclaration(['Alpha'], `delete(id, pid, type, properties) { if (someImport(properties)) return; }`)
    );
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['Alpha']);
    expect(c.blindSpots).toEqual(['someImport(...) in delete()']);
  });

  it('an object spread of the bag is recorded and still does not excuse', () => {
    const c = only(
      withDeclaration(['Alpha'], `update(id, pid, type, properties) { send({ ...properties }); }`)
    );
    expect(c.bucket).toBe('gap');
    expect(c.blindSpots).toEqual(['object spread in update()']);
  });

  it('a whole-bag call whose result is only COMPARED is not a blind spot at all', () => {
    // Real EC2Provider shapes. Treating them as forwards masked a real gap.
    const c = only(
      withDeclaration(
        ['Alpha'],
        `
        update(id, pid, type, properties, previousProperties) {
          if (JSON.stringify(properties) === JSON.stringify(previousProperties)) return;
          if (Object.keys(properties).length > 0) send(properties['Alpha']);
        }
        `
      )
    );
    expect(c.bucket).toBe('wired');
    expect(c.blindSpots).toEqual([]);
  });
});

describe('allow-list (keyed by Class#Property)', () => {
  const allow = new Map<string, AllowListEntry>([
    [allowKey('P', 'Alpha'), { rationale: 'NOT-A-BUG: replacement trigger with no API counterpart' }],
  ]);

  it('an allow-listed property stays VISIBLE and does not block', () => {
    const c = only(withDeclaration(['Alpha'], `create(id, type, properties) {}`), allow);
    expect(c.bucket).toBe('allow-listed');
    expect(c.properties[0]?.status).toBe('allow-listed');
    expect(c.properties[0]?.rationale).toContain('NOT-A-BUG');
    expect(findGaps(buildReport([c]))).toEqual([]);
  });

  it('an entry for property A does NOT silence a NEW gap on property B', () => {
    const c = only(withDeclaration(['Alpha', 'Beta'], `create(id, type, properties) {}`), allow);
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['Beta']);
  });

  it('flags a STALE entry once the property is wired', () => {
    const c = only(
      withDeclaration(['Alpha'], `create(id, type, properties) { send(properties['Alpha']); }`),
      allow
    );
    expect(c.bucket).toBe('wired');
    expect(findStaleAllowListEntries(buildReport([c]), allow)).toEqual(['P#Alpha']);
  });
});

describe('handledProperties parsing', () => {
  it('ignores a class with no handledProperties declaration', () => {
    expect(classifySource(`export class Helper { create(id, type, properties) {} }`, 'h.ts')).toEqual(
      []
    );
  });

  it('pools a property declared for several types and records every type', () => {
    const src = `
      export class P {
        handledProperties = new Map([
          ['AWS::Test::A', new Set(['Alpha'])],
          ['AWS::Test::B', new Set(['Alpha', 'Beta'])],
        ]);
        create(id, type, properties) { send(properties['Alpha']); }
      }
    `;
    const c = only(src);
    expect(c.declaredCount).toBe(2);
    expect(c.properties.find((p) => p.name === 'Alpha')?.types).toEqual([
      'AWS::Test::A',
      'AWS::Test::B',
    ]);
    expect(c.gaps).toEqual(['Beta']);
  });
});

// Per .claude/rules/testing.md "A checker must prove it SEES its input":
// "0 gaps" and "parsed nothing at all" are indistinguishable without explicit
// floors — and an AGGREGATE floor alone would let one whole evidence shape die
// while the total absorbed the loss. So every shape the walk claims to
// recognize gets its own real-tree number.
describe('real-repo coverage floors', () => {
  const classes = readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .sort()
    .flatMap((f) => classifySource(readFileSync(resolve(PROVIDERS_DIR, f), 'utf8'), f));
  const report = buildReport(classes);
  const allProps = classes.flatMap((c) => c.properties);
  const propsWith = (shape: string): number =>
    allProps.filter((p) => p.evidence.includes(shape as never)).length;
  const classesWith = (shape: string): number =>
    classes.filter((c) => c.properties.some((p) => p.evidence.includes(shape as never))).length;

  it('parses a realistic number of provider classes and declarations', () => {
    // 84 classes / 1063 declared properties at the time of writing.
    expect(classes.length).toBeGreaterThanOrEqual(70);
    expect(report.summary.declaredProperties).toBeGreaterThanOrEqual(900);
  });

  it('floors the element-read shape (the dominant one)', () => {
    // 1030 properties across 81 classes today.
    expect(propsWith('element-read')).toBeGreaterThanOrEqual(900);
    expect(classesWith('element-read')).toBeGreaterThanOrEqual(70);
  });

  it('floors the table-loop shape', () => {
    // 89 properties across 12 classes today (Glue / SQS / EC2 / ...). Without
    // this recognizer those would all be false-positive gaps, so a regression
    // here is loud in the other direction too — but the floor makes it loud
    // even if someone "fixes" the noise by weakening the check.
    expect(propsWith('table-loop')).toBeGreaterThanOrEqual(60);
    expect(classesWith('table-loop')).toBeGreaterThanOrEqual(8);
  });

  it('floors the delegated-read edge (the interprocedural part)', () => {
    // 674 properties across 47 classes today. If the `this.x()` / file-function
    // edges broke, this collapses long before the aggregate does.
    expect(propsWith('delegated')).toBeGreaterThanOrEqual(400);
    expect(classesWith('delegated')).toBeGreaterThanOrEqual(30);
  });

  it('pins the two shapes with NO real-tree instance today', () => {
    // `properties.Alpha` and `const { Alpha } = properties` are recognized (see
    // the synthetic tests above) but no provider currently uses them. Pinned at
    // exactly 0 rather than floored at >= 1: a floor would fail spuriously, and
    // an unpinned shape could silently become the only evidence for a property
    // whose recognizer has quietly regressed.
    expect(propsWith('property-read')).toBe(0);
    expect(propsWith('destructure')).toBe(0);
  });

  it('records blind spots in the real tree (the recorder is alive)', () => {
    // 18 classes today. A zero here would mean the blind-spot walk went dead
    // and the matrix silently stopped showing where the analysis cannot see.
    expect(report.summary.classesWithBlindSpots).toBeGreaterThanOrEqual(10);
  });

  it('reports no un-allow-listed gap in the real tree', () => {
    expect(findGaps(report).map((c) => c.className)).toEqual([]);
  });

  it('keeps the shipped allow-list free of stale entries', () => {
    expect(findStaleAllowListEntries(report)).toEqual([]);
  });

  it('pins the exact set of allow-listed declarations', () => {
    // Pinned by name, not floored: these are the four findings of the critic's
    // first run. Two are KNOWN GAPS awaiting a provider fix and must not
    // quietly grow a fifth neighbour; the list is the filing queue.
    const allowed = classes
      .flatMap((c) => c.properties.filter((p) => p.status === 'allow-listed').map((p) => allowKey(c.className, p.name)))
      .sort();
    expect(allowed).toEqual([
      'EC2Provider#MaxDrainDurationSeconds',
      'IAMAccessKeyProvider#Serial',
      'LogsLogGroupProvider#ResourcePolicyDocument',
      'NestedStackProvider#TemplateURL',
    ]);
    expect([...HANDLED_WIRING_ALLOW_LIST.keys()].sort()).toEqual(allowed);
  });

  it('classifies the property fixed by #1392 / PR #1406 as wired', () => {
    // The strongest regression fence available: this exact declaration is the
    // bug the critic exists for, and its fix reads the bag inside create() AND
    // through a `this.toSdkTagMutabilityExclusionFilters(...)` delegation.
    const ecr = classes.find((c) => c.className === 'ECRProvider');
    expect(ecr, 'ECRProvider must be classified').toBeDefined();
    expect(ecr?.bucket).toBe('wired');
    expect(
      ecr?.properties.find((p) => p.name === 'ImageTagMutabilityExclusionFilters')?.status
    ).toBe('wired');
  });
});

// Per .claude/rules/testing.md: a synthetic fixture passing is necessary but
// never sufficient — a checker's fixtures encode the same mental model as the
// checker. These probes mutate the REAL provider source and require the REAL
// verdict to flip.
describe('REAL-CODE regression probes', () => {
  const realEcr = readFileSync(ECR_PROVIDER, 'utf8');

  const ecrClass = (source: string): ClassClassification => {
    const found = classifySource(source, 'ecr-provider.ts').find(
      (c) => c.className === 'ECRProvider'
    );
    expect(found, 'ECRProvider must be classified').toBeDefined();
    return found!;
  };

  it('flags ImageTagMutabilityExclusionFilters when the #1392 wiring is stripped', () => {
    // Replaying the pre-PR-#1406 state: the declaration stays, every read off
    // the desired-state bag goes. The property must be named as a gap.
    const stripped = realEcr.replaceAll(
      "properties['ImageTagMutabilityExclusionFilters']",
      'undefined'
    );
    expect(stripped, 'the probe must actually change the source').not.toBe(realEcr);
    const c = ecrClass(stripped);
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toContain('ImageTagMutabilityExclusionFilters');
  });

  it('still flags it when only the previousProperties diff read survives', () => {
    // The disguise: `previousProperties['X']` remains (change detection) while
    // nothing sends X. `replaceAll` on the lowercase-`p` spelling leaves the
    // `previousProperties[...]` read in place, which is exactly the case.
    const stripped = realEcr.replaceAll(
      "properties['ImageTagMutabilityExclusionFilters']",
      'undefined'
    );
    expect(stripped).toContain("previousProperties['ImageTagMutabilityExclusionFilters']");
    expect(ecrClass(stripped).gaps).toContain('ImageTagMutabilityExclusionFilters');
  });

  it('does NOT flag it on the real, un-mutated source', () => {
    // The other half of the probe: proves the flip above came from the mutation
    // and not from a checker that flags everything.
    expect(ecrClass(realEcr).gaps).toEqual([]);
  });
});
