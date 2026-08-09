import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vite-plus/test';
import {
  HANDLED_WIRING_ALLOW_LIST,
  PREVIOUS_PROPERTY_BAG_PARAM_NAMES,
  PROPERTY_BAG_PARAM_NAMES,
  allowKey,
  buildReport,
  classifySource,
  findGaps,
  findStaleAllowListEntries,
  loadReport,
  type AllowListEntry,
  type ClassClassification,
} from '../../../scripts/gen-handled-property-wiring.js';

const REPO_ROOT = process.cwd();
const PROVIDERS_DIR = resolve(REPO_ROOT, 'src/provisioning/providers');
const SCRIPT = resolve(REPO_ROOT, 'scripts/gen-handled-property-wiring.ts');
const providerSource = (file: string): string =>
  readFileSync(resolve(PROVIDERS_DIR, file), 'utf8');

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

  it('walks a RESOLVABLE delegation even when its result is only compared', () => {
    // Skipping the whole call branch on the inert check meant
    // `this.buildInput(properties)`'s reads were never collected AND no blind
    // spot was recorded, so the evidence vanished invisibly.
    //
    // The helper's parameter is `bag`, NOT a name in PROPERTY_BAG_PARAM_NAMES:
    // with `props` the helper is seeded by NAME as a top-level member anyway and
    // the test passes even with the call edge broken.
    const c = only(
      withDeclaration(
        ['Alpha'],
        `
        update(id, pid, type, properties) { if (this.buildInput(properties) !== undefined) send(); }
        private buildInput(bag) { return bag['Alpha']; }
        `
      )
    );
    expect(c.bucket).toBe('wired');
    expect(c.blindSpots).toEqual([]);
  });

  it('separates a class MEMBER from a same-named file-local function', () => {
    // The cycle-guard key used to drop the callee namespace, so whichever
    // `build` was walked first marked the other visited and its reads were lost.
    const src = `
      function build(bag) { return { a: bag['Alpha'] }; }
      ${withDeclaration(
        ['Alpha', 'Beta'],
        `
        create(id, type, properties) { send(build(properties)); }
        update(id, pid, type, properties) { send(this.build(properties)); }
        private build(bag) { return { b: bag['Beta'] }; }
        `
      )}
    `;
    const c = only(src);
    expect(c.bucket).toBe('wired');
    expect(c.gaps).toEqual([]);
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

  it('a table declared inside ANOTHER class cannot vouch for this class', () => {
    // The reviewer's reproduction of the file-wide `collectLiteralNameSets`
    // leak: `passThrough` is local to `Wirer.create`, so lexically it does not
    // exist at `Other.create`'s loop and must credit nothing there.
    const src = `
      export class Wirer {
        handledProperties = new Map([['AWS::Test::A', new Set(['Alpha', 'Beta', 'Gamma'])]]);
        create(id, type, properties) {
          const passThrough = ['Alpha', 'Beta', 'Gamma'];
          for (const k of passThrough) send(properties[k]);
        }
      }
      export class Other {
        handledProperties = new Map([['AWS::Test::B', new Set(['Beta', 'Gamma'])]]);
        create(id, type, properties) { for (const k of passThrough) { send(properties[k]); } }
      }
    `;
    const classes = classifySource(src, 'multi.ts');
    expect(classes.map((c) => [c.className, c.bucket, c.gaps])).toEqual([
      ['Wirer', 'wired', []],
      ['Other', 'gap', ['Beta', 'Gamma']],
    ]);
  });

  it('resolves two same-named tables to the NEAREST enclosing declaration', () => {
    // `glue-provider.ts` really does declare `result` x12, `out` x5, `toAdd` x3.
    // The old file-wide map was last-wins, so one function's table silently
    // answered for another's.
    const src = withDeclaration(
      ['Alpha', 'Gamma'],
      `
      create(id, type, properties) {
        const table = ['Alpha'];
        const out = {};
        for (const k of table) { out[k] = properties[k]; }
        return out;
      }
      private other(properties) {
        const table = ['Gamma'];
        return properties['Beta'];
      }
      `
    );
    const c = only(src);
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['Gamma']);
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

  it('DOCUMENTS the limit: a two-bag diff still clears the property', () => {
    // The exclusion does NOT close the "diffs it, then forgets to send it"
    // disguise for a single `element-read` — the DESIRED-side read of the
    // comparison clears it. Pinned so the module header's (corrected) claim and
    // the behavior cannot drift apart again.
    const c = only(
      withDeclaration(
        ['Alpha'],
        `update(id, pid, type, properties, previousProperties) {
          if (properties['Alpha'] !== previousProperties['Alpha']) throw new Error('immutable');
        }`
      )
    );
    expect(c.bucket).toBe('wired');
  });
});

describe('table-driven evidence', () => {
  it('credits every name of an INLINE literal array loop that DELIVERS', () => {
    const c = only(
      withDeclaration(
        ['Alpha', 'Beta'],
        `update(id, pid, type, properties) { const out = {}; for (const k of ['Alpha', 'Beta']) { out[k] = properties[k]; } send(out); }`
      )
    );
    expect(c.bucket).toBe('wired');
    expect(c.properties.map((p) => p.evidence)).toEqual([['table-loop'], ['table-loop']]);
  });

  it('credits a FILE-LOCAL const array table, through an `as` cast on the key', () => {
    // The real GlueJobProvider shape: `r[k as string] = p[k as string]`.
    const src = `
      const passThrough = ['Alpha', 'Beta'];
      ${withDeclaration(
        ['Alpha', 'Beta'],
        `create(id, type, properties) { const r = {}; for (const k of passThrough) { r[k as string] = properties[k as string]; } send(r); }`
      )}
    `;
    expect(only(src).bucket).toBe('wired');
  });

  it('credits an Object.entries(TABLE) destructured loop', () => {
    // The real SQSQueueProvider shape.
    const src = `
      const CDK_TO_SQS = { Alpha: 'alpha', Beta: 'beta' };
      ${withDeclaration(
        ['Alpha', 'Beta'],
        `create(id, type, properties) { const a = {}; for (const [cdkKey, sqsKey] of Object.entries(CDK_TO_SQS)) { a[sqsKey] = properties[cdkKey]; } send(a); }`
      )}
    `;
    expect(only(src).bucket).toBe('wired');
  });

  it('a declared property MISSING from the table is still a gap', () => {
    // The whole point of recognizing the shape rather than allow-listing it:
    // adding a declaration without adding it to the table must still fail.
    const src = `
      const passThrough = ['Alpha'];
      ${withDeclaration(
        ['Alpha', 'Gamma'],
        `create(id, type, properties) { const r = {}; for (const k of passThrough) { r[k] = properties[k]; } send(r); }`
      )}
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

  it('a COMPARISON-ONLY table loop credits nothing (the EC2 createOnly guard)', () => {
    // The blocker: the loop reads the table's names off BOTH bags and throws.
    // Crediting it re-admits the diff-is-not-delivery disguise, multiplied by
    // the size of the table. It is not a blind spot either — nothing is hidden.
    const c = only(
      withDeclaration(
        ['VpcId', 'CidrBlock'],
        `update(id, pid, type, properties, previousProperties) {
          for (const createOnly of ['VpcId', 'CidrBlock']) {
            const next = properties[createOnly];
            const prev = previousProperties[createOnly];
            if (next !== undefined && prev !== undefined && next !== prev) throw new Error('immutable');
          }
        }`
      )
    );
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['CidrBlock', 'VpcId']);
    expect(c.blindSpots).toEqual([]);
  });

  it('sees through JSON.stringify in a comparison-only loop (the EFS / Lambda shape)', () => {
    const c = only(
      withDeclaration(
        ['Alpha', 'Beta'],
        `update(id, pid, type, properties, previousProperties) {
          for (const key of ['Alpha', 'Beta']) {
            if (JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key])) {
              throw new Error('immutable');
            }
          }
        }`
      )
    );
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['Alpha', 'Beta']);
  });

  it('a bare truthiness scan that only returns the KEY is not a delivery', () => {
    // The real FirehoseProvider.detectDestinationKey shape: the VALUE never
    // leaves, only the name of the first present destination.
    const c = only(
      withDeclaration(
        ['Alpha', 'Beta'],
        `private detect(properties) { for (const key of ['Alpha', 'Beta']) { if (properties[key] !== undefined) return key; } return undefined; }`
      )
    );
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['Alpha', 'Beta']);
  });

  it('credits the loop whose body DELIVERS even when a sibling loop only compares', () => {
    // The real RDSDBProxyProvider shape, and the proof the rule discriminates
    // rather than blanket-denying every table loop.
    const c = only(
      withDeclaration(
        ['Immutable', 'Mutable'],
        `update(id, pid, type, properties, previousProperties) {
          for (const field of ['Immutable']) {
            if (JSON.stringify(properties[field]) !== JSON.stringify(previousProperties[field])) {
              throw new Error('immutable');
            }
          }
          const input = {};
          for (const key of ['Mutable']) {
            if (properties[key] !== undefined) input[key] = properties[key];
          }
          send(input);
        }`
      )
    );
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['Immutable']);
    expect(c.properties.find((p) => p.name === 'Mutable')?.evidence).toEqual(['table-loop']);
  });

  it('a key read OUTSIDE the loop that bound it credits nothing', () => {
    // The keySets map used to be method-scoped, so an unresolvable
    // `properties[key]` in a sibling arrow function inherited the loop's table
    // and was silently credited with no blind spot recorded. This is the real
    // `EFSProvider.updateFileSystem` shape, down to the arrow parameter reusing
    // the loop variable's name — with distinct names the leak does not
    // reproduce, so the naming here is load-bearing.
    const c = only(
      withDeclaration(
        ['Alpha'],
        `update(id, pid, type, properties, previousProperties) {
          const out = {};
          for (const key of ['Alpha']) { out[key] = properties[key]; }
          const changed = (key) => JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key]);
          return changed('Beta');
        }`
      )
    );
    expect(c.bucket).toBe('wired');
    expect(c.blindSpots).toEqual(['computed key in update()']);
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

  it('a `.length` MEASUREMENT is inert however it is consumed', () => {
    // `if (!Object.keys(properties).length)` used to escape the exemption and
    // be reported as a place the walk cannot see.
    const c = only(
      withDeclaration(
        ['Alpha'],
        `update(id, pid, type, properties) { if (!Object.keys(properties).length) return; send(properties['Alpha']); }`
      )
    );
    expect(c.bucket).toBe('wired');
    expect(c.blindSpots).toEqual([]);
  });
});

describe('seeding member is recorded', () => {
  it('names the member whose walk produced the evidence, through delegation', () => {
    const c = only(
      withDeclaration(
        ['Alpha'],
        `
        create(id, type, properties) { send(this.buildInput(properties)); }
        private buildInput(props) { return { a: props['Alpha'] }; }
        `
      )
    );
    // `buildInput` is BOTH reached from create() and seeded directly by its
    // property-bag-shaped parameter name, so both members appear.
    expect(c.properties[0]?.seededBy).toEqual(['buildInput', 'create']);
  });

  it('exposes evidence that came ONLY from a non-delivery member', () => {
    // The header claims evidence comes from a DELIVERY path while the walk seeds
    // EVERY member. There are zero such cases in the tree (pinned below), but
    // the JSON has to make a future one visible rather than silently `wired`.
    const c = only(
      withDeclaration(
        ['Alpha'],
        `readCurrentState(physicalId, type, properties) { return { a: properties['Alpha'] }; }`
      )
    );
    expect(c.bucket).toBe('wired');
    expect(c.properties[0]?.seededBy).toEqual(['readCurrentState']);
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
//
// The report comes from the SHIPPED `loadReport()`, not a test-local re-walk of
// the directory: a floor computed by a private re-implementation would keep
// passing after the shipped entry point broke.
describe('real-repo coverage floors', () => {
  const report = loadReport(PROVIDERS_DIR);
  const classes = report.classes;
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
    // 43 properties across 5 classes today (Glue / SQS / RDS DBProxy / ...).
    // Without this recognizer those would all be false-positive gaps, so a
    // regression here is loud in the other direction too — but the floor makes
    // it loud even if someone "fixes" the noise by weakening the check.
    expect(propsWith('table-loop')).toBeGreaterThanOrEqual(35);
    expect(classesWith('table-loop')).toBeGreaterThanOrEqual(4);
  });

  it('floors the properties whose ONLY evidence is the table-loop shape', () => {
    // 29 today (GlueJobProvider 16, SQSQueueProvider 13). These are the ones
    // that would flip straight to `gap` if the recognizer died, so they are the
    // real measure of how load-bearing it is — the aggregate above includes
    // properties that would survive on their own element-read.
    const soleTableLoop = allProps.filter((p) => {
      const shapes = p.evidence.filter((e) => e !== 'delegated');
      return shapes.length === 1 && shapes[0] === 'table-loop';
    });
    expect(soleTableLoop.length).toBeGreaterThanOrEqual(25);
    expect([...new Set(soleTableLoop.map((p) => p.name))].length).toBeGreaterThanOrEqual(25);
  });

  it('floors the delegated-read edge (the interprocedural part)', () => {
    // 666 properties across 47 classes today. If the `this.x()` / file-function
    // edges broke, this collapses long before the aggregate does.
    expect(propsWith('delegated')).toBeGreaterThanOrEqual(400);
    expect(classesWith('delegated')).toBeGreaterThanOrEqual(30);
  });

  it('pins the two shapes with NO real-tree instance today', () => {
    // `properties.Alpha` and `const { Alpha } = properties` are recognized (see
    // the synthetic tests above AND the real-code rewrites below) but no
    // provider currently uses them. Pinned at exactly 0 rather than floored at
    // >= 1: a floor would fail spuriously, and an unpinned shape could silently
    // become the only evidence for a property whose recognizer has regressed.
    expect(propsWith('property-read')).toBe(0);
    expect(propsWith('destructure')).toBe(0);
  });

  it('records blind spots in the real tree (the recorder is alive)', () => {
    // 19 classes today. A zero here would mean the blind-spot walk went dead
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
    // Pinned by name, not floored. The critic's first run found four; the two
    // KNOWN GAPS are gone (issues #1411 / #1412 moved
    // `EC2Provider#MaxDrainDurationSeconds` and
    // `LogsLogGroupProvider#ResourcePolicyDocument` into `unhandledByDesign`,
    // so they are no longer a wiring claim at all). What remains is the two
    // rationale'd NOT-A-BUG entries, and the pin is what stops a third
    // neighbour appearing quietly.
    const allowed = classes
      .flatMap((c) => c.properties.filter((p) => p.status === 'allow-listed').map((p) => allowKey(c.className, p.name)))
      .sort();
    expect(allowed).toEqual(['IAMAccessKeyProvider#Serial', 'NestedStackProvider#TemplateURL']);
    expect([...HANDLED_WIRING_ALLOW_LIST.keys()].sort()).toEqual(allowed);
  });

  it('has no property whose evidence comes ONLY from a non-delivery member', () => {
    // The header claims evidence establishes a DELIVERY path, but the walk seeds
    // every member — so a read inside `readCurrentState()` alone would classify
    // the property `wired` and quietly contradict that claim. Zero cases today;
    // this fence is what makes a future one loud instead of invisible.
    const nonDelivery = (m: string): boolean => /^read/.test(m) || /^getDrift/.test(m) || m === 'getAttribute';
    const offenders = classes.flatMap((c) =>
      c.properties
        .filter((p) => p.status === 'wired' && p.seededBy.length > 0 && p.seededBy.every(nonDelivery))
        .map((p) => `${c.className}#${p.name} (${p.seededBy.join(', ')})`)
    );
    expect(offenders).toEqual([]);
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
// checker. These probes mutate the REAL provider source IN MEMORY and require
// the REAL verdict to flip. Nothing under `src/` is ever written.
describe('REAL-CODE regression probes', () => {
  const realEcr = providerSource('ecr-provider.ts');
  const realEc2 = providerSource('ec2-provider.ts');
  const realGlue = providerSource('glue-provider.ts');
  const realSqs = providerSource('sqs-queue-provider.ts');
  const realIamAccessKey = providerSource('iam-access-key-provider.ts');

  const classOf = (source: string, file: string, name: string): ClassClassification => {
    const found = classifySource(source, file).find((c) => c.className === name);
    expect(found, `${name} must be classified`).toBeDefined();
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
    const c = classOf(stripped, 'ecr-provider.ts', 'ECRProvider');
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
    expect(classOf(stripped, 'ecr-provider.ts', 'ECRProvider').gaps).toContain(
      'ImageTagMutabilityExclusionFilters'
    );
  });

  it('does NOT flag it on the real, un-mutated source', () => {
    // The other half of the probe: proves the flip above came from the mutation
    // and not from a checker that flags everything.
    expect(classOf(realEcr, 'ecr-provider.ts', 'ECRProvider').gaps).toEqual([]);
  });

  it('stays wired when the real ECR read is rewritten as a DOTTED read', () => {
    // Free real-code coverage for `property-read`, which the floors above can
    // only pin at 0. Without it the shape is exercised by synthetic fixtures
    // alone, and a regression would be invisible until a provider adopted it.
    const rewritten = realEcr.replaceAll(
      "properties['ImageTagMutabilityExclusionFilters']",
      'properties.ImageTagMutabilityExclusionFilters'
    );
    expect(rewritten).not.toBe(realEcr);
    const p = classOf(rewritten, 'ecr-provider.ts', 'ECRProvider').properties.find(
      (p) => p.name === 'ImageTagMutabilityExclusionFilters'
    );
    expect(p?.status).toBe('wired');
    expect(p?.evidence).toContain('property-read');
  });

  it('stays wired when the real ECR read is rewritten as a DESTRUCTURE', () => {
    // Same idea for the `destructure` shape.
    const rewritten = realEcr.replaceAll(
      "properties['ImageTagMutabilityExclusionFilters']",
      '(() => { const { ImageTagMutabilityExclusionFilters } = properties; return ImageTagMutabilityExclusionFilters; })()'
    );
    expect(rewritten).not.toBe(realEcr);
    const p = classOf(rewritten, 'ecr-provider.ts', 'ECRProvider').properties.find(
      (p) => p.name === 'ImageTagMutabilityExclusionFilters'
    );
    expect(p?.status).toBe('wired');
    expect(p?.evidence).toContain('destructure');
  });

  it('BLOCKER: the real EC2 createOnly loop cannot vouch for VpcId on its own', () => {
    // Reviewer's probe. Strip every DESIRED-bag read of `VpcId` from the real
    // provider and leave the `for (const createOnly of ['VpcId', ...])` guard
    // standing: before the delivery requirement the loop reported
    // `wired [delegated, table-loop]`.
    const stripped = realEc2.replaceAll("properties['VpcId']", 'undefined');
    expect(stripped).not.toBe(realEc2);
    expect(stripped).toContain("for (const createOnly of ['VpcId'");
    const c = classOf(stripped, 'ec2-provider.ts', 'EC2Provider');
    expect(c.gaps).toContain('VpcId');
    expect(classOf(realEc2, 'ec2-provider.ts', 'EC2Provider').gaps).toEqual([]);
  });

  it('BLOCKER: a table local to another function cannot vouch for a new class', () => {
    // Reviewer's file-wide-pooling reproduction, run against the REAL
    // `glue-provider.ts`: `stringPassThrough` lives inside
    // `buildJobCommonFields()`, so it is not in scope for a class that merely
    // shares the file. Before the lexical resolver this class came out `wired`.
    const withIntruder = `${realGlue}
export class BorrowerProvider {
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Glue::Job', new Set(['JobMode', 'Description'])],
  ]);
  async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const k of stringPassThrough) out[k as string] = properties[k as string];
    return out;
  }
}
`;
    expect(classOf(withIntruder, 'glue-provider.ts', 'BorrowerProvider').gaps).toEqual([
      'Description',
      'JobMode',
    ]);
    // ...and the real class in the same file is untouched by the intruder.
    expect(classOf(withIntruder, 'glue-provider.ts', 'GlueJobProvider').bucket).toBe('wired');
  });

  it('flags a name dropped from the REAL Glue pass-through table', () => {
    // The table recognizer must stay a real check, not a rubber stamp: removing
    // one entry from the actual `stringPassThrough` list has to surface the
    // declared property as a gap.
    const cut = realGlue.replace(
      "    'JobMode',\n    'JobRunQueuingEnabled',",
      "    'JobRunQueuingEnabled',"
    );
    expect(cut).not.toBe(realGlue);
    expect(classOf(realGlue, 'glue-provider.ts', 'GlueJobProvider').gaps).toEqual([]);
    expect(classOf(cut, 'glue-provider.ts', 'GlueJobProvider').gaps).toEqual(['JobMode']);
  });

  it('flags a name dropped from the REAL SQS attribute table', () => {
    const cut = realSqs.replace(/^\s*DelaySeconds: 'DelaySeconds',\n/m, '');
    expect(cut).not.toBe(realSqs);
    expect(classOf(realSqs, 'sqs-queue-provider.ts', 'SQSQueueProvider').gaps).toEqual([]);
    expect(classOf(cut, 'sqs-queue-provider.ts', 'SQSQueueProvider').gaps).toEqual([
      'DelaySeconds',
    ]);
  });

  it('reports the IAM access-key allow-list entry as STALE once the real provider reads it', () => {
    // The stale verdict is what forces an allow-list entry out once the gap is
    // fixed, so it needs a real-code probe of its own. It used to probe
    // `EC2Provider#MaxDrainDurationSeconds`; issues #1411 / #1412 retired both
    // KNOWN GAP entries, so the probe moved to a still-live entry —
    // `IAMAccessKeyProvider#Serial` — which keeps the verdict covered against
    // real code rather than only against a synthetic fixture.
    const key = allowKey('IAMAccessKeyProvider', 'Serial');
    // Scoped to the entry under probe: the other entry names a class in a file
    // this single-file parse never sees, so it would read as stale for an
    // unrelated reason.
    const allow = new Map([[key, HANDLED_WIRING_ALLOW_LIST.get(key)!]]);
    const anchor = 'this.logger.debug(`Creating IAM access key ${logicalId}`);';
    expect(realIamAccessKey).toContain(anchor);
    const wired = realIamAccessKey.replace(
      anchor,
      `${anchor}\n    const serial = properties['Serial'];\n    void serial;`
    );
    expect(wired).not.toBe(realIamAccessKey);
    const report = buildReport(classifySource(wired, 'iam-access-key-provider.ts', allow));
    expect(findStaleAllowListEntries(report, allow)).toEqual([key]);
    // Un-mutated, the entry is live (not stale) — the other half of the probe.
    expect(
      findStaleAllowListEntries(
        buildReport(classifySource(realIamAccessKey, 'iam-access-key-provider.ts', allow)),
        allow
      )
    ).toEqual([]);
  });

  it('keeps AWS::EC2::NatGateway.MaxDrainDurationSeconds and AWS::Logs::LogGroup.ResourcePolicyDocument out of handledProperties', () => {
    // Issues #1411 / #1412: both were declared handled while nothing read them
    // (the #1392 silent-drop class). The fix moved them to `unhandledByDesign`,
    // so they must not reappear as a wiring CLAIM — re-adding one without a
    // read would be a silent drop again, and re-adding one WITH a read would
    // need a real API call this provider has no way to make.
    const declared = (file: string, className: string): string[] =>
      classOf(providerSource(file), file, className).properties.map((p) => p.name);
    expect(declared('ec2-provider.ts', 'EC2Provider')).not.toContain('MaxDrainDurationSeconds');
    expect(declared('logs-loggroup-provider.ts', 'LogsLogGroupProvider')).not.toContain(
      'ResourcePolicyDocument'
    );
  });
});

// The floors and probes above all drive the library functions. This block drives
// the SHIPPED command — argv parsing, `loadReport`, the failure text and the
// exit code — because that is what CI actually runs.
describe('the shipped --check command', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'cdkd-hpw-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const runCheck = (providersDir?: string): { status: number; stderr: string } => {
    const args = ['--check', ...(providersDir ? [`--providers-dir=${providersDir}`] : [])];
    const run = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(run.error, 'the critic must be spawnable').toBeUndefined();
    return { status: run.status ?? -1, stderr: run.stderr };
  };

  it('exits 0 and reports its coverage on the real providers tree', () => {
    const { status, stderr } = runCheck();
    expect(status).toBe(0);
    expect(stderr).toContain('handled-property-wiring: OK');
    expect(stderr).toContain('0 gaps');
  });

  it('exits 1 naming the class#property when a REAL provider drops its wiring', () => {
    // A scratch COPY of the providers tree carries the injected regression, so
    // the shipped exit path is exercised against real code with `src/` untouched.
    const dir = join(scratch, 'providers-gap');
    cpSync(PROVIDERS_DIR, dir, { recursive: true });
    const file = join(dir, 'ecr-provider.ts');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replaceAll(
        "properties['ImageTagMutabilityExclusionFilters']",
        'undefined'
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('declared-but-unwired handledProperties entries');
    expect(stderr).toContain('ECRProvider#ImageTagMutabilityExclusionFilters');
  });

  it('exits 1 naming a STALE allow-list entry, alongside any gap', () => {
    // Both verdicts have to be reported in one run: an earlier revision returned
    // after the gap block, so a stale entry stayed hidden until the unrelated
    // gap was fixed.
    const dir = join(scratch, 'providers-stale');
    cpSync(PROVIDERS_DIR, dir, { recursive: true });
    const accessKey = join(dir, 'iam-access-key-provider.ts');
    const anchor = 'this.logger.debug(`Creating IAM access key ${logicalId}`);';
    const accessKeySource = readFileSync(accessKey, 'utf8');
    expect(accessKeySource, 'the stale probe needs its anchor').toContain(anchor);
    writeFileSync(
      accessKey,
      accessKeySource.replace(
        anchor,
        `${anchor}\n    const serial = properties['Serial'];\n    void serial;`
      )
    );
    const ecr = join(dir, 'ecr-provider.ts');
    writeFileSync(
      ecr,
      readFileSync(ecr, 'utf8').replaceAll(
        "properties['ImageTagMutabilityExclusionFilters']",
        'undefined'
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('stale HANDLED_WIRING_ALLOW_LIST entries');
    expect(stderr).toContain('IAMAccessKeyProvider#Serial');
    expect(stderr).toContain('ECRProvider#ImageTagMutabilityExclusionFilters');
  });
});
