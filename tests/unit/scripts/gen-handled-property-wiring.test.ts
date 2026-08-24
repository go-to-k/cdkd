import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vite-plus/test';
import {
  ACCEPT_LOSS_FLAG,
  HANDLED_WIRING_ALLOW_LIST,
  PREVIOUS_PROPERTY_BAG_PARAM_NAMES,
  PROPERTY_BAG_PARAM_NAMES,
  allowKey,
  buildReport,
  classifySource,
  findEvidenceLosses,
  findGaps,
  findStaleAllowListEntries,
  loadBaseline,
  ACCEPT_MISSING_BASELINE_FLAG,
  loadReport,
  assessBaseline,
  shouldRefuseUnusableBaseline,
  type AllowListEntry,
  type ClassClassification,
  type PropertyClassification,
  type HandledPropertyWiringReport,
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

// Issue #1842. `unwrap` peeled `as T` / `satisfies T` / parentheses but NOT the
// `!` non-null assertion, while its upward twin `climb` DID — so the two
// disagreed and `properties!['X']` contributed nothing.
describe('transparent wrappers around the property bag (#1842)', () => {
  it('counts a read through a `!` non-null assertion', () => {
    const c = only(
      withDeclaration(['Alpha'], `create(id, type, properties) { send(properties!['Alpha']); }`)
    );
    expect(c.bucket).toBe('wired');
    expect(c.properties[0]?.evidence).toContain('element-read');
  });

  it('counts a DOTTED read through a `!` assertion', () => {
    const c = only(
      withDeclaration(['Alpha'], `create(id, type, properties) { send(properties!.Alpha); }`)
    );
    expect(c.properties[0]?.evidence).toContain('property-read');
  });

  it('counts a DESTRUCTURE off a `!`-asserted bag', () => {
    const c = only(
      withDeclaration(
        ['Alpha'],
        `create(id, type, properties) { const { Alpha } = properties!; send(Alpha); }`
      )
    );
    expect(c.properties[0]?.evidence).toContain('destructure');
  });

  it('follows a `!`-asserted bag across a delegation edge', () => {
    const c = only(
      withDeclaration(
        ['Alpha'],
        `
        create(id, type, properties) { send(this.buildInput(properties!)); }
        private buildInput(props) { return { a: props['Alpha'] }; }
        `
      )
    );
    expect(c.bucket).toBe('wired');
    expect(c.properties[0]?.evidence).toContain('delegated');
  });

  it('records a blind spot for a spread of a `!`-asserted bag', () => {
    // The spread recogniser has to see through the wrapper too, or the site
    // silently stops being reported as a place the walk cannot see.
    const c = only(
      withDeclaration(
        ['Alpha'],
        `create(id, type, properties) { send({ ...properties!, a: properties['Alpha'] }); }`
      )
    );
    expect(c.blindSpots).toEqual(['object spread in create()']);
  });

  it('counts a read through a `<T>` type assertion and a stack of wrappers', () => {
    const c = only(
      withDeclaration(
        ['Alpha', 'Beta'],
        `
        create(id, type, properties) {
          send((<Bag>properties)['Alpha']);
          send(((properties as Bag)! satisfies Bag)['Beta']);
        }
        `
      )
    );
    expect(c.bucket).toBe('wired');
    expect(c.properties.map((p) => p.name)).toEqual(['Alpha', 'Beta']);
  });

  it('CREDITS an optional-chained read, which is the correct behavior', () => {
    // Pinned because the header claimed `?.` was "excluded and pinned by a
    // test": neither half was true, AND the behavior it described would have
    // been wrong. `properties?.['X']` is an element access whose own
    // `.expression` is the bag, so the walk credits it — correctly, because when
    // the bag exists the read happens. Pinning the real behavior is worth more
    // than deleting the sentence.
    const c = only(
      withDeclaration(['Alpha'], `create(id, type, properties) { send(properties?.['Alpha']); }`)
    );
    expect(c.bucket).toBe('wired');
    expect(c.properties[0]?.evidence).toContain('element-read');
  });

  it('does NOT credit a read off a DEFAULTED bag', () => {
    // The counter-case that keeps the above from being a blanket "peel anything
    // near a bag": `(properties ?? {})['X']` reads a DIFFERENT object when the
    // bag is absent, so it must fail closed.
    const c = only(
      withDeclaration(['Alpha'], `create(id, type, properties) { send((properties ?? {})['Alpha']); }`)
    );
    expect(c.bucket).toBe('gap');
  });

  it('does NOT peel a node that is not transparent at runtime', () => {
    // The admission rule is "erases to nothing". `await` defers and can change
    // the value, so peeling it would credit a read the runtime may never make.
    // Guards against a future widening of the wrapper set past type-only syntax.
    const c = only(
      withDeclaration(
        ['Alpha'],
        `async create(id, type, properties) { send((await properties)['Alpha']); }`
      )
    );
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['Alpha']);
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
    // 84 classes / 1138 declared properties as measured today.
    expect(classes.length).toBeGreaterThanOrEqual(70);
    expect(report.summary.declaredProperties).toBeGreaterThanOrEqual(900);
  });

  it('floors the element-read shape (the dominant one)', () => {
    // 1107 properties across 81 classes today.
    expect(propsWith('element-read')).toBeGreaterThanOrEqual(900);
    expect(classesWith('element-read')).toBeGreaterThanOrEqual(70);
  });

  it('floors the table-loop shape', () => {
    // 49 properties across 8 classes today (Glue / SQS / RDS DBProxy / ...).
    // Counted from the committed matrix; it moved 43/5 -> 47/7 -> 49/8 as
    // providers gained pass-through tables, which is why the assertion is a
    // FLOOR and this line is dated rather than load-bearing.
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
    // 744 properties across 51 classes today. If the `this.x()` / file-function
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
    // 21 classes today. A zero here would mean the blind-spot walk went dead
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


// Issue #1842's second half. `wired` is a floor of ONE surviving read, so the
// gap verdict is blind to a property falling from `delegated` + three seeds down
// to a single weak one. These drive the comparison itself; the REAL-code probe
// and the shipped-command block below carry it through to a red exit code.
describe('evidence-loss verdict (#1842)', () => {
  const reportOf = (classes: readonly ClassClassification[]): HandledPropertyWiringReport =>
    buildReport(classes as ClassClassification[]);

  /** A one-class report declaring `Alpha` with the given evidence + seeds. */
  const stub = (
    evidence: readonly string[],
    seededBy: readonly string[],
    status: 'wired' | 'gap' = 'wired',
    name = 'Alpha'
  ): HandledPropertyWiringReport =>
    reportOf([
      {
        file: 'p.ts',
        className: 'P',
        bucket: status === 'wired' ? 'wired' : 'gap',
        declaredCount: 1,
        properties: [
          {
            name,
            status,
            types: ['AWS::Test::Thing'],
            evidence: evidence as never,
            seededBy,
          },
        ],
        gaps: status === 'gap' ? [name] : [],
        blindSpots: [],
      },
    ]);

  it('reports nothing when there is no baseline to grade against', () => {
    // This function alone: it cannot invent a recorded state. That is NOT a
    // licence to proceed — `main` refuses an unusable baseline in both modes
    // before calling this, and only `--accept-missing-baseline` waives it. The
    // separation is the point: this stays a pure comparison, and the policy
    // lives in one predicate (`assessBaseline` + `shouldRefuseUnusableBaseline`).
    expect(findEvidenceLosses(null, stub(['element-read'], ['create']))).toEqual([]);
  });

  it('reports nothing when the evidence is unchanged', () => {
    const r = stub(['delegated', 'element-read'], ['create', 'update']);
    expect(findEvidenceLosses(r, r)).toEqual([]);
  });

  it('names the SHAPES a property stopped being able to prove', () => {
    const before = stub(['delegated', 'element-read', 'table-loop'], ['create']);
    const after = stub(['element-read'], ['create']);
    expect(findEvidenceLosses(before, after)).toEqual([
      { className: 'P', property: 'Alpha', lostShapes: ['delegated', 'table-loop'], lostSeeds: [] },
    ]);
  });

  it('names the SEEDING MEMBERS a property stopped being reached from', () => {
    // The issue's own example: `WarmThroughput` keeping `element-read` while
    // losing its `getDriftUnknownPaths` / `readCurrentState` seeds is the same
    // degradation event as losing a shape.
    const before = stub(['element-read'], ['create', 'getDriftUnknownPaths', 'readCurrentState']);
    const after = stub(['element-read'], ['create']);
    expect(findEvidenceLosses(before, after)).toEqual([
      {
        className: 'P',
        property: 'Alpha',
        lostShapes: [],
        lostSeeds: ['getDriftUnknownPaths', 'readCurrentState'],
      },
    ]);
  });

  it('lets evidence GROW for free', () => {
    const before = stub(['element-read'], ['create']);
    const after = stub(['delegated', 'element-read'], ['create', 'update']);
    expect(findEvidenceLosses(before, after)).toEqual([]);
  });

  it('treats a wired -> gap collapse as a loss too (evidence emptied)', () => {
    const before = stub(['delegated', 'element-read'], ['create']);
    const after = stub([], [], 'gap');
    const losses = findEvidenceLosses(before, after);
    expect(losses).toHaveLength(1);
    expect(losses[0]?.lostShapes).toEqual(['delegated', 'element-read']);
  });

  it('does NOT treat a REMOVED declaration as a loss', () => {
    // Moving a property to `unhandledByDesign` (or deleting it) retires the
    // wiring CLAIM; `gen-property-coverage.ts` owns that transition. Counting it
    // here would make every legitimate removal a false failure.
    const before = stub(['delegated', 'element-read'], ['create']);
    const after = stub(['element-read'], ['create'], 'wired', 'Beta');
    expect(findEvidenceLosses(before, after)).toEqual([]);
  });

  /** Rename a one-class stub's class + file, so a report can hold several. */
  const renamed = (r: HandledPropertyWiringReport, className: string): ClassClassification[] =>
    r.classes.map((c) => ({ ...c, className, file: `${className.toLowerCase()}.ts` }));

  it('sorts losses by CLASS then property so the failure text is stable', () => {
    // Both keys are exercised: two distinct classes (in distinct files, as the
    // real generator always produces) each losing two properties. An earlier
    // version of this test built both classes as `P`, so the className
    // comparator could be deleted with no test failing.
    const build = (evidence: readonly string[]): HandledPropertyWiringReport =>
      reportOf([
        ...renamed(stub(evidence, ['create'], 'wired', 'Zeta'), 'ZProvider'),
        ...renamed(stub(evidence, ['create'], 'wired', 'Alpha'), 'ZProvider'),
        ...renamed(stub(evidence, ['create'], 'wired', 'Zeta'), 'AProvider'),
        ...renamed(stub(evidence, ['create'], 'wired', 'Alpha'), 'AProvider'),
      ]);
    const losses = findEvidenceLosses(build(['delegated', 'element-read']), build(['element-read']));
    expect(losses.map((l) => `${l.className}#${l.property}`)).toEqual([
      'AProvider#Alpha',
      'AProvider#Zeta',
      'ZProvider#Alpha',
      'ZProvider#Zeta',
    ]);
  });

  it('sorts the lost shapes and lost seeds WITHIN a loss', () => {
    // Fixture inputs elsewhere happen to be pre-sorted, so the inner sorts were
    // unfenced: dropping them changed nothing. The failure text is compared
    // literally by the shipped-command test, so their order is load-bearing.
    const before = stub(
      ['table-loop', 'delegated', 'element-read'],
      ['update', 'create', 'readCurrentState']
    );
    const after = stub(['element-read'], ['create']);
    const [loss] = findEvidenceLosses(before, after);
    expect(loss?.lostShapes).toEqual(['delegated', 'table-loop']);
    expect(loss?.lostSeeds).toEqual(['readCurrentState', 'update']);
  });

  it('every classified class name is DISTINCT, which is what the class-only key relies on', () => {
    // The loss comparison keys by class name (matching `allowKey` and the
    // allow-list), so a same-name class in two provider files would mis-pair.
    // 84/84 distinct today; this makes a future collision loud rather than a
    // silent wrong comparison.
    const names = loadReport(PROVIDERS_DIR).classes.map((c) => c.className);
    expect(new Set(names).size).toBe(names.length);
  });

  it('loads the committed matrix as a baseline, and returns null for a non-baseline', () => {
    const baseline = loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'));
    expect(baseline?.schemaVersion).toBe(1);
    expect(baseline!.classes.length).toBeGreaterThanOrEqual(70);
    expect(loadBaseline(resolve(REPO_ROOT, 'docs/_generated/nope-does-not-exist.json'))).toBeNull();
  });

  it('returns null rather than throwing on a corrupt / wrong-schema baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-hpw-baseline-'));
    try {
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{ not json');
      expect(loadBaseline(bad)).toBeNull();
      const wrongSchema = join(dir, 'v2.json');
      writeFileSync(wrongSchema, JSON.stringify({ schemaVersion: 2, classes: [] }));
      expect(loadBaseline(wrongSchema)).toBeNull();
      // A TRUNCATED matrix parses as valid JSON with a well-formed header, so
      // the envelope checks above all pass and only the per-class check catches
      // it. Without that check `findEvidenceLosses` throws
      // `c.properties is not iterable` — a CRASH where the stated contract is
      // "unusable baseline means no comparison". Deleting the guard left 106/106
      // green before this case existed.
      // The fields the comparison CONSUMES must be shape-checked, not just
      // present: `"evidence": "element-read"` (a string) exited 1 as
      // `(before.evidence ?? []).filter is not a function` — the raw-TypeError
      // shape a structured refusal exists to replace.
      for (const bad of [
        { evidence: 'element-read', seededBy: ['create'] },
        { evidence: ['element-read'], seededBy: 'create' },
      ]) {
        const f = join(dir, `bad-${typeof bad.evidence === 'string' ? 'evidence' : 'seeds'}.json`);
        writeFileSync(
          f,
          JSON.stringify({
            schemaVersion: 1,
            summary: {},
            classes: [
              {
                className: 'P',
                file: 'p.ts',
                bucket: 'wired',
                declaredCount: 1,
                gaps: [],
                blindSpots: [],
                properties: [{ name: 'Alpha', status: 'wired', types: [], ...bad }],
              },
            ],
          })
        );
        expect(loadBaseline(f), `${JSON.stringify(bad)} must be rejected`).toBeNull();
      }

      const truncated = join(dir, 'truncated.json');
      writeFileSync(truncated, JSON.stringify({ schemaVersion: 1, classes: [{ className: 'P' }] }));
      expect(loadBaseline(truncated)).toBeNull();
      // ...and the contract holds end-to-end: an unusable baseline degrades to
      // "no comparison" rather than an exception. The REFUSAL that stops the run
      // from proceeding on it is `main`'s, fenced separately.
      expect(() =>
        findEvidenceLosses(loadBaseline(truncated), loadReport(PROVIDERS_DIR))
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('grades the SHIPPED matrix against the SHIPPED tree with zero losses', () => {
    // The committed matrix must describe the committed providers exactly, or
    // every later run starts from a baseline nobody can reproduce.
    expect(
      findEvidenceLosses(
        loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json')),
        loadReport(PROVIDERS_DIR)
      )
    ).toEqual([]);
  });
});

// The REAL-code half of #1842, per `.claude/rules/testing.md`: a synthetic
// fixture shares the checker's blind spot, so the probes below drive the actual
// `dynamodb-table-provider.ts` — the file the issue measured.
describe('REAL-CODE evidence-loss probes (#1842)', () => {
  const FILE = 'dynamodb-table-provider.ts';
  const realDdb = providerSource(FILE);
  const analyze = (source: string): HandledPropertyWiringReport =>
    buildReport(classifySource(source, FILE));
  const evidenceOf = (
    report: HandledPropertyWiringReport,
    property: string
  ): { evidence: readonly string[]; seededBy: readonly string[] } => {
    const p = report.classes
      .find((c) => c.className === 'DynamoDBTableProvider')
      ?.properties.find((x) => x.name === property);
    expect(p, `${property} must be classified`).toBeDefined();
    return { evidence: p!.evidence, seededBy: p!.seededBy };
  };

  // The single delegated read behind `WarmThroughput`'s extra evidence: the
  // file-local `declaresWarmThroughput()` is what `getDriftUnknownPaths()` and
  // `readCurrentState()` reach the bag through.
  // The delegated read `getDriftUnknownPaths()` / `readCurrentState()` reach the
  // bag through. PR #1808 rewrote this line into the `properties !== undefined
  // && ...` spelling BECAUSE the `!` form was invisible to this critic (its own
  // in-code comment says so) — which is issue #1842 in one line, and why the
  // anchor is asserted unique rather than assumed.
  const DELEGATED_READ =
    "  return properties !== undefined && isSendableWarmThroughput(properties['WarmThroughput']);";

  it('the fixture still discriminates: the real read carries delegated evidence', () => {
    // Without this the two probes below could both pass vacuously — a property
    // with nothing to lose cannot demonstrate a loss.
    expect(realDdb.split(DELEGATED_READ).length - 1, 'probe anchor must be unique').toBe(1);
    const { evidence, seededBy } = evidenceOf(analyze(realDdb), 'WarmThroughput');
    expect(evidence).toContain('delegated');
    expect(seededBy).toEqual(expect.arrayContaining(['getDriftUnknownPaths', 'readCurrentState']));
  });

  it('the `!` spelling of the real reads costs NOTHING now (the parser fix)', () => {
    // Before the fix this exact rewrite dropped `delegated` plus two seeds while
    // `--check` printed `OK ... 0 gaps` byte-identically. It must now be a
    // no-op, evidence-for-evidence.
    const bang = realDdb.replaceAll(
      "properties['WarmThroughput']",
      "properties!['WarmThroughput']"
    );
    expect(bang, 'the probe must actually change the source').not.toBe(realDdb);
    expect(evidenceOf(analyze(bang), 'WarmThroughput')).toEqual(
      evidenceOf(analyze(realDdb), 'WarmThroughput')
    );
    expect(findEvidenceLosses(analyze(realDdb), analyze(bang))).toEqual([]);
  });

  it('a real degradation the walk CANNOT follow is reported as a loss, not a gap', () => {
    // "Piece 1 without piece 2 leaves the same class reachable through the next
    // unfollowed AST node" — so the verdict is probed through a DIFFERENT
    // unfollowable spelling (a computed key with no literal table behind it).
    const degraded = realDdb.replace(
      DELEGATED_READ,
      "  const k = 'Warm' + 'Throughput';\n  return properties !== undefined && isSendableWarmThroughput(properties[k]);"
    );
    expect(degraded).not.toBe(realDdb);
    const losses = findEvidenceLosses(analyze(realDdb), analyze(degraded));
    expect(losses.map((l) => `${l.className}#${l.property}`)).toEqual([
      'DynamoDBTableProvider#WarmThroughput',
    ]);
    expect(losses[0]?.lostShapes).toEqual(['delegated']);
    expect(losses[0]?.lostSeeds).toEqual(['getDriftUnknownPaths', 'readCurrentState']);
    // The property is STILL `wired` and the class still reports no gap — which
    // is precisely why the gap verdict could not see this.
    expect(analyze(degraded).classes.flatMap((c) => c.gaps)).toEqual([]);
    expect(evidenceOf(analyze(degraded), 'WarmThroughput').evidence).toEqual(['element-read']);
  });
});

// The floors and probes above all drive the library functions. This block drives
// the SHIPPED command — argv parsing, `loadReport`, the failure text and the
// exit code — because that is what CI actually runs.
// Each case here `cpSync`s the whole providers tree and spawns a full 84-file
// AST walk, so 5s (Vitest's default) is not a safe budget under a loaded
// parallel run — two of these flaked on timeout while the suite was otherwise
// green. The generous per-test budget is about machine load, not about any of
// them being slow enough to be worth optimizing.
const SPAWN_TIMEOUT_MS = 60_000;

describe('the shipped --check command', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'cdkd-hpw-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  // SAFETY NET, and it earns its keep: several cases here deliberately run the
  // WRITER against a degraded providers tree, with only a production guard
  // standing between them and the committed matrix. When a mutation probe broke
  // one of those guards, the run rewrote `docs/_generated/*` and TEN unrelated
  // tests then failed for the side effect rather than on their own subject —
  // which both hides which fence actually died and leaves the repo dirty.
  // Restoring after every case keeps a broken guard's blast radius inside the
  // one test that asserts the file is untouched.
  const MATRIX_NAMES = ['handled-property-wiring.json', 'handled-property-wiring.md'];
  const MATRIX = MATRIX_NAMES.map((n) => resolve(REPO_ROOT, 'docs/_generated', n));
  // A broken guard does not only overwrite the matrix IN PLACE — a run whose
  // output path resolves to the cwd drops the two files at the REPO ROOT as
  // untracked strays. That happened during a probe here, and because the net did
  // not cover it, the leftovers made the empty-value test fail on every LATER
  // probe — a false RED that masked a different fence reporting nothing at all.
  const STRAYS = MATRIX_NAMES.map((n) => resolve(REPO_ROOT, n));
  const pristine = new Map(
    MATRIX.map((f) => [f, { content: readFileSync(f, 'utf8'), stat: statSync(f) }] as const)
  );
  /**
   * Put a matrix file back byte-for-byte and mtime-for-mtime — but ONLY when it
   * actually changed. Both halves matter and for different reasons: the bytes so
   * a broken guard cannot leak into the repo or into later tests, and the
   * unconditional-write avoidance because Vite+ invalidates a task's cache on
   * the WRITE SYSCALL, not on content — so restoring on every case would make
   * `vp run test` permanently uncacheable for everyone.
   */
  afterEach(() => {
    for (const [file, { content, stat }] of pristine) {
      if (existsSync(file) && readFileSync(file, 'utf8') === content) continue;
      writeFileSync(file, content);
      utimesSync(file, stat.atime, stat.mtime);
    }
    for (const stray of STRAYS) rmSync(stray, { force: true });
  });

  const run = (args: readonly string[]): { status: number; stderr: string } => {
    const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(proc.error, 'the critic must be spawnable').toBeUndefined();
    return { status: proc.status ?? -1, stderr: proc.stderr };
  };

  const runCheck = (
    providersDir?: string,
    extra: readonly string[] = []
  ): { status: number; stderr: string } =>
    run(['--check', ...(providersDir ? [`--providers-dir=${providersDir}`] : []), ...extra]);

  /**
   * A scratch COPY of the providers tree with one real file rewritten, so every
   * probe below drives REAL provider source while `src/` is never written.
   */
  const providersCopyWith = (name: string, file: string, rewrite: (src: string) => string): string => {
    const dir = join(scratch, name);
    cpSync(PROVIDERS_DIR, dir, { recursive: true });
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    const after = rewrite(before);
    expect(after, `the ${name} probe must actually change ${file}`).not.toBe(before);
    writeFileSync(path, after);
    return dir;
  };

  // The one delegated read behind `WarmThroughput`'s extra evidence (see the
  // REAL-CODE probes above).
  // The delegated read `getDriftUnknownPaths()` / `readCurrentState()` reach the
  // bag through. PR #1808 rewrote this line into the `properties !== undefined
  // && ...` spelling BECAUSE the `!` form was invisible to this critic (its own
  // in-code comment says so) — which is issue #1842 in one line, and why the
  // anchor is asserted unique rather than assumed.
  const DELEGATED_READ =
    "  return properties !== undefined && isSendableWarmThroughput(properties['WarmThroughput']);";
  const degradeWarmThroughput = (src: string): string => {
    expect(src.split(DELEGATED_READ).length - 1, 'probe anchor must be unique').toBe(1);
    return src.replace(
      DELEGATED_READ,
      "  const k = 'Warm' + 'Throughput';\n  return properties !== undefined && isSendableWarmThroughput(properties[k]);"
    );
  };

  it('exits 0 and reports its coverage on the real providers tree', () => {
    const { status, stderr } = runCheck();
    expect(status).toBe(0);
    expect(stderr).toContain('handled-property-wiring: OK');
    expect(stderr).toContain('0 gaps');
  }, SPAWN_TIMEOUT_MS);

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
  }, SPAWN_TIMEOUT_MS);

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
  }, SPAWN_TIMEOUT_MS);

  // ---- issue #1842: the evidence-loss verdict, end to end ----

  it('exits 1 naming the property whose EVIDENCE shrank, with zero gaps', () => {
    // The #1842 case in full: a REAL provider read moves out of the walk's
    // sight, the property stays `wired`, the gap verdict stays silent — and the
    // run must still go red.
    const dir = providersCopyWith('providers-evidence-loss', 'dynamodb-table-provider.ts', degradeWarmThroughput);
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('declared properties LOST wiring evidence');
    // The exact rendered line, so a reformatting that drops the lost shapes or
    // seeds (leaving only the property name) cannot pass.
    expect(stderr).toContain(
      'DynamoDBTableProvider#WarmThroughput \u2014 lost evidence [delegated] ' +
        'and seeded-by [getDriftUnknownPaths, readCurrentState]'
    );
    // Not a gap. If this ever starts matching, the probe stopped exercising the
    // degradation-under-a-surviving-read case that the gap verdict is blind to.
    expect(stderr).not.toContain('declared-but-unwired handledProperties entries');
  }, SPAWN_TIMEOUT_MS);

  it('names the escape hatch in the failure text', () => {
    const dir = providersCopyWith('providers-loss-hatch', 'dynamodb-table-provider.ts', degradeWarmThroughput);
    const { stderr } = runCheck(dir);
    expect(stderr).toContain(ACCEPT_LOSS_FLAG);
    expect(stderr).toContain('vp run gen:handled-property-wiring:accept-loss');
  }, SPAWN_TIMEOUT_MS);

  it('stays green when the SAME real reads are respelled with `!`', () => {
    // The other half of the probe: the parser fix means the `!` spelling is not
    // a loss, so the verdict must not fire on it. Without the fix this exits 1.
    const dir = providersCopyWith('providers-bang-spelling', 'dynamodb-table-provider.ts', (src) =>
      src.replaceAll("properties['WarmThroughput']", "properties!['WarmThroughput']")
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(0);
    expect(stderr).toContain('0 evidence losses');
  }, SPAWN_TIMEOUT_MS);

  it('REFUSES --accept-evidence-loss on the check path', () => {
    // The escape hatch belongs to the writer. A `--check` that could be told to
    // look away is not a verdict.
    const dir = providersCopyWith('providers-loss-refuse', 'dynamodb-table-provider.ts', degradeWarmThroughput);
    const { status, stderr } = runCheck(dir, [ACCEPT_LOSS_FLAG]);
    expect(status).toBe(1);
    expect(stderr).toContain('is a WRITER escape hatch');
    // Even on a CLEAN tree the flag is refused, so it can never be pasted into
    // the CI task as a no-op that quietly disarms the check later.
    expect(runCheck(undefined, [ACCEPT_LOSS_FLAG]).status).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it('the WRITER refuses to overwrite the matrix with weaker evidence', () => {
    // This is the half that makes the verdict reachable at all: `--check` alone
    // passes for the author who edits the source AND regenerates in one commit,
    // because regenerating moves the baseline underneath the comparison.
    const dir = providersCopyWith('providers-writer-refusal', 'dynamodb-table-provider.ts', degradeWarmThroughput);
    const outDir = join(scratch, 'out-refused');
    const { status, stderr } = run([`--providers-dir=${dir}`, `--out-dir=${outDir}`]);
    expect(status).toBe(1);
    expect(stderr).toContain('declared properties LOST wiring evidence');
    expect(stderr).toContain('DynamoDBTableProvider#WarmThroughput');
    expect(existsSync(join(outDir, 'handled-property-wiring.json'))).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  it('the WRITER writes, and ANNOUNCES the reduction, once the loss is accepted', () => {
    const dir = providersCopyWith('providers-writer-accepted', 'dynamodb-table-provider.ts', degradeWarmThroughput);
    const outDir = join(scratch, 'out-accepted');
    const { status, stderr } = run([
      `--providers-dir=${dir}`,
      `--out-dir=${outDir}`,
      ACCEPT_LOSS_FLAG,
    ]);
    expect(status).toBe(0);
    expect(stderr).toContain('ACCEPTED EVIDENCE LOSS');
    expect(stderr).toContain('DynamoDBTableProvider#WarmThroughput');
    const written = JSON.parse(
      readFileSync(join(outDir, 'handled-property-wiring.json'), 'utf8')
    ) as HandledPropertyWiringReport;
    const p = written.classes
      .find((c) => c.className === 'DynamoDBTableProvider')
      ?.properties.find((x) => x.name === 'WarmThroughput');
    expect(p?.status).toBe('wired');
    expect(p?.evidence).toEqual(['element-read']);
  }, SPAWN_TIMEOUT_MS);

  it('rejects an unrecognized flag / a stray argument instead of falling through to WRITER mode', () => {
    // A typo must not rewrite the committed matrix and exit 0 — and with
    // `--accept-evidence-loss` in the vocabulary, `--chekc --accept-evidence-loss`
    // would rewrite it while ACCEPTING a degradation.
    const typo = run(['--chekc']);
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain('Unknown flag(s): --chekc');
    // The SPACE form of a value flag would otherwise slip past the `=` prefix
    // test and leave the path as a positional the writer ignores.
    const spaced = run(['--providers-dir', PROVIDERS_DIR]);
    expect(spaced.status).toBe(1);
    expect(spaced.stderr).toContain('Unknown flag(s): --providers-dir');
    // A bare positional on its own is rejected by the stray-argument guard.
    const positional = run([PROVIDERS_DIR]);
    expect(positional.status).toBe(1);
    expect(positional.stderr).toContain('Unexpected argument(s)');
  }, SPAWN_TIMEOUT_MS);

  it('refuses --providers-dir= in WRITER mode unless the output is redirected too', () => {
    // Otherwise the writer renders docs/_generated from a tree that is not src/.
    const dir = providersCopyWith('providers-writer-guard', 'dynamodb-table-provider.ts', degradeWarmThroughput);
    // This case deliberately omits --out-dir, so the ONLY thing standing between
    // it and the committed matrix is the guard under test. When a reviewer broke
    // that guard, the run rewrote the matrix in their worktree and two LATER
    // tests failed for the side effect rather than on their own subject. Assert
    // the file is intact so the blast radius stays inside this test.
    const committed = resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json');
    const untouched = readFileSync(committed, 'utf8');
    const { status, stderr } = run([`--providers-dir=${dir}`]);
    expect(readFileSync(committed, 'utf8'), 'the committed matrix must be untouched').toBe(untouched);
    expect(status).toBe(1);
    expect(stderr).toContain('Refusing to render');
    // ...and it IS allowed once the output is REALLY redirected. Asserting only
    // `status === 1` would not discriminate: exit 1 is also what the guard
    // returns, so the assertion has to be that the GUARD did not speak.
    const allowed = run([`--providers-dir=${dir}`, `--out-dir=${join(scratch, 'guard-ok')}`]);
    expect(allowed.stderr).not.toContain('Refusing to render');
    expect(allowed.stderr).toContain('declared properties LOST wiring evidence');
  }, SPAWN_TIMEOUT_MS);

  it('refuses an --out-dir= that resolves BACK to docs/_generated (a fake redirect)', () => {
    // Checking only that the flag is PRESENT let `--out-dir=docs/_generated`
    // satisfy the guard while still rendering the committed matrix from a
    // degraded tree against a nulled baseline — the flag became its own bypass.
    //
    // The last two spellings are the ones a STRING compare of `resolve()` output
    // still let through, and both were measured writing the committed matrix at
    // exit 0: a case variant (this checkout is on case-insensitive APFS, so
    // `docs/_GENERATED` is the same directory under a different string) and a
    // SYMLINK (a different path entirely, same directory). `realpathSync` does
    // not settle the first; only `dev`+`ino` identity settles both.
    const dir = providersCopyWith('providers-fake-redirect', 'dynamodb-table-provider.ts', degradeWarmThroughput);
    const committed = resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json');
    const before = readFileSync(committed, 'utf8');
    const link = join(scratch, 'link-to-generated');
    rmSync(link, { force: true });
    symlinkSync(resolve(REPO_ROOT, 'docs/_generated'), link);

    // Whether a CASE variant names the same directory is a property of the
    // filesystem, not of the guard: macOS/APFS folds case (so `docs/_GENERATED`
    // IS docs/_generated and must be refused), while CI on ext4 does not (so it
    // is a genuine, safe redirect to a new directory). Asserting the
    // redirect-guard message unconditionally passed locally and failed on CI —
    // the guard was right in both places, the test was wrong in one. Probe the
    // filesystem rather than assume either behavior.
    const sameInode = (a: string, b: string): boolean => {
      try {
        const x = statSync(a);
        const y = statSync(b);
        return x.dev === y.dev && x.ino === y.ino;
      } catch {
        return false;
      }
    };
    const generated = resolve(REPO_ROOT, 'docs/_generated');
    const caseFolding = sameInode(generated, resolve(REPO_ROOT, 'docs/_GENERATED'));

    const alwaysSameDir = [
      'docs/_generated',
      './docs/_generated/.',
      'docs/_generated/../_generated',
      generated,
      link,
    ];
    const caseVariants = ['docs/_GENERATED', 'DOCS/_GENERATED'];
    for (const outDir of [...alwaysSameDir, ...(caseFolding ? caseVariants : [])]) {
      const { status, stderr } = run([
        `--providers-dir=${dir}`,
        `--out-dir=${outDir}`,
        '--baseline=/nonexistent-baseline.json',
      ]);
      expect(status, `--out-dir=${outDir} must be refused`).toBe(1);
      expect(stderr, `--out-dir=${outDir} must name the redirect guard`).toContain('SOMEWHERE ELSE');
    }
    // The invariant that holds on EVERY filesystem, whichever guard spoke.
    expect(readFileSync(committed, 'utf8'), 'the committed matrix must be untouched').toBe(before);
  }, SPAWN_TIMEOUT_MS);

  it('refuses an EMPTY value for any path flag', () => {
    // `resolve('')` is the cwd, so `--out-dir=` passed the redirect test and
    // dropped handled-property-wiring.{json,md} at the REPO ROOT as two
    // untracked files (measured). An empty value is a path, not "unset".
    for (const flag of ['--out-dir=', '--baseline=', '--providers-dir=']) {
      const { status, stderr } = run([flag]);
      expect(status, `${flag} with no value must be refused`).toBe(1);
      expect(stderr).toContain('needs a path; got an empty value');
    }
    for (const stray of ['handled-property-wiring.json', 'handled-property-wiring.md']) {
      expect(existsSync(resolve(REPO_ROOT, stray)), `${stray} must not be dropped at the repo root`).toBe(
        false
      );
    }
  }, SPAWN_TIMEOUT_MS);

  it('refuses --baseline= in WRITER mode unless the output is redirected too', () => {
    // The subtler and strictly worse half of the same guard, and the one with no
    // coverage before: an unreadable `--baseline=` makes `loadBaseline` answer
    // null, which the loss check reads as "nothing to compare" — so without this
    // guard the writer would overwrite the COMMITTED matrix with weaker
    // evidence, exit 0, and print nothing. Verified against real degraded input.
    const dir = providersCopyWith('providers-baseline-guard', 'dynamodb-table-provider.ts', degradeWarmThroughput);
    const committed = resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json');
    const before = readFileSync(committed, 'utf8');
    const { status, stderr } = run([`--providers-dir=${dir}`, '--baseline=/nonexistent-baseline.json']);
    expect(status).toBe(1);
    expect(stderr).toContain('--baseline=');
    expect(stderr).toContain('Refusing to render');
    expect(readFileSync(committed, 'utf8'), 'the committed matrix must be untouched').toBe(before);
  }, SPAWN_TIMEOUT_MS);

  it('--baseline= actually redirects the grading, and is not silently ignored', () => {
    // Without this the flag could be parsed wrong (an off-by-one `slice`) and
    // every `--check` using it would pass vacuously via the null-baseline
    // fail-open. A baseline that RECORDS MORE than the tree can prove must fail.
    const inflated = join(scratch, 'inflated-baseline.json');
    const real = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'), 'utf8')
    ) as HandledPropertyWiringReport;
    writeFileSync(
      inflated,
      JSON.stringify({
        ...real,
        classes: real.classes.map((c) =>
          c.className === 'ECRProvider'
            ? {
                ...c,
                properties: c.properties.map((p) =>
                  p.name === 'ImageTagMutabilityExclusionFilters'
                    ? { ...p, seededBy: [...p.seededBy, 'aMemberThatDoesNotExist'] }
                    : p
                ),
              }
            : c
        ),
      })
    );
    const { status, stderr } = runCheck(undefined, [`--baseline=${inflated}`]);
    expect(status).toBe(1);
    expect(stderr).toContain('ECRProvider#ImageTagMutabilityExclusionFilters');
    expect(stderr).toContain('seeded-by [aMemberThatDoesNotExist]');
    // The same run against the REAL baseline is clean - so the failure came
    // from the redirect, not from the tree.
    expect(runCheck().status).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  it('reports a gap AND a loss in the SAME run, not one instead of the other', () => {
    // Every other loss case here has zero gaps, so turning the loss block into
    // an `else if` after the gap block would have gone unnoticed - the same
    // both-verdicts-in-one-run property the stale+gap test above protects.
    const dir = providersCopyWith('providers-gap-and-loss', 'ecr-provider.ts', (src) =>
      src.replaceAll("properties['ImageTagMutabilityExclusionFilters']", 'undefined')
    );
    const ddb = join(dir, 'dynamodb-table-provider.ts');
    writeFileSync(ddb, degradeWarmThroughput(readFileSync(ddb, 'utf8')));
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('declared-but-unwired handledProperties entries');
    expect(stderr).toContain('ECRProvider#ImageTagMutabilityExclusionFilters');
    expect(stderr).toContain('declared properties LOST wiring evidence');
    expect(stderr).toContain('DynamoDBTableProvider#WarmThroughput');
  }, SPAWN_TIMEOUT_MS);

  it('the escape-hatch vp task is a NO-OP on a clean tree (writes, announces nothing)', () => {
    // `vp run gen:handled-property-wiring:accept-loss` runs exactly this. On a
    // tree with nothing to accept it must behave like the plain writer, not
    // announce a phantom reduction.
    const outDir = join(scratch, 'out-accept-clean');
    const { status, stderr } = run([`--out-dir=${outDir}`, ACCEPT_LOSS_FLAG]);
    expect(status).toBe(0);
    expect(stderr).not.toContain('ACCEPTED EVIDENCE LOSS');
    expect(stderr).toContain('wrote handled-property-wiring');
    expect(readFileSync(join(outDir, 'handled-property-wiring.json'), 'utf8')).toBe(
      readFileSync(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'), 'utf8')
    );
  }, SPAWN_TIMEOUT_MS);

  it('--help prints usage and writes nothing', () => {
    const proc = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('Usage: node scripts/gen-handled-property-wiring.ts');
    expect(proc.stdout).toContain(ACCEPT_LOSS_FLAG);
  }, SPAWN_TIMEOUT_MS);

  it('refuses --out-dir= on the check path instead of silently ignoring it', () => {
    // Accepting-and-ignoring invites "I redirected the output, so this run was
    // harmless" about a run that never writes anything either way.
    const { status, stderr } = runCheck(undefined, [`--out-dir=${join(scratch, 'nope')}`]);
    expect(status).toBe(1);
    expect(stderr).toContain('--out-dir= is a WRITER flag');
  }, SPAWN_TIMEOUT_MS);

  it('refuses a value flag given twice instead of silently taking the first', () => {
    // `--baseline=<real> --baseline=/nope` would otherwise read as the real one
    // while the author believed the opposite. A seam that decides what the loss
    // check grades against must not have a silent precedence rule.
    const real = resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json');
    const { status, stderr } = runCheck(undefined, [`--baseline=${real}`, '--baseline=/nope.json']);
    expect(status).toBe(1);
    expect(stderr).toContain('--baseline= given 2 times');
  }, SPAWN_TIMEOUT_MS);

  it('the escape-hatch command it prints is the REAL vp task name', () => {
    // The failure text hands the reader a command to run. Asserting the literal
    // alone would keep passing after a task rename, leaving the critic pointing
    // at a command that does not exist. Same cross-check shape as
    // tests/unit/scripts/matrix-regen-coverage.test.ts.
    const dir = providersCopyWith('providers-hatch-name', 'dynamodb-table-provider.ts', degradeWarmThroughput);
    const { stderr } = runCheck(dir);
    const printed = /vp run (gen:handled-property-wiring:[a-z-]+)/.exec(stderr)?.[1];
    expect(printed, 'the failure text must name a vp task').toBeDefined();
    const viteConfig = readFileSync(resolve(REPO_ROOT, 'vite.config.ts'), 'utf8');
    expect(viteConfig, `vite.config.ts must define the '${printed}' task`).toContain(`'${printed}':`);
    // ...and that task must actually pass the escape-hatch flag.
    const taskBlock = new RegExp(`'${printed}':\\s*\\{[\\s\\S]*?\\n      \\},`).exec(viteConfig)?.[0];
    expect(taskBlock).toBeDefined();
    expect(taskBlock).toContain(ACCEPT_LOSS_FLAG);
  }, SPAWN_TIMEOUT_MS);

  it('--check REFUSES rather than reporting an unearned green when it graded against nothing', () => {
    // Measured before the fix: with the matrix deleted, `--check` printed
    // `OK - ... 0 gaps, 0 evidence losses` and exited 0 — success reported for a
    // comparison never made, which is the verdict this critic exists to abolish.
    // CI caught the deletion only because the `gen:` step runs first and now
    // refuses; a checker must not borrow another step's ordering for its honesty.
    const { status, stderr } = runCheck(undefined, ['--baseline=/nonexistent-baseline.json']);
    expect(status).toBe(1);
    expect(stderr).toContain('unusable baseline at');
    expect(stderr).not.toContain('0 evidence losses');
    expect(stderr).not.toContain('handled-property-wiring: OK');
  }, SPAWN_TIMEOUT_MS);

  it('--check refuses a TRUNCATED baseline the same way', () => {
    const truncated = join(scratch, 'truncated-for-check.json');
    writeFileSync(truncated, JSON.stringify({ schemaVersion: 1, classes: [{ className: 'P' }] }));
    const { status, stderr } = runCheck(undefined, [`--baseline=${truncated}`]);
    expect(status).toBe(1);
    expect(stderr).toContain('unusable baseline at');
    expect(stderr).not.toContain('handled-property-wiring: OK');
  }, SPAWN_TIMEOUT_MS);

  it('the WRITER refuses to write with NO usable baseline, even redirected', () => {
    // Reachable without touching the repo, which is the point: an earlier draft
    // exempted redirected writes, leaving the rule testable only by deleting the
    // real matrix — and a test that WRITES a tracked file makes `vp run test`
    // permanently uncacheable (Vite+ invalidates on the write syscall).
    const outDir = join(scratch, 'out-no-baseline-refused');
    const { status, stderr } = run([`--out-dir=${outDir}`, '--baseline=/nonexistent-baseline.json']);
    expect(status).toBe(1);
    expect(stderr).toContain('unusable baseline at');
    expect(existsSync(join(outDir, 'handled-property-wiring.json'))).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  it('refuses every UNUSABLE baseline payload end-to-end, in both modes', () => {
    // The blocker-1 reproduction. Each payload is structurally valid enough to
    // pass the envelope checks, so before the positive predicate they all made
    // `--check` print `OK - 0 evidence losses` and the writer overwrite the
    // tamper at exit 0, leaving zero trace. They are ONE condition now: the
    // comparison covers no pair of the live tree, so it could not have failed.
    const payloads: ReadonlyArray<[string, string]> = [
      ['empty class list', '{"schemaVersion":1,"classes":[]}'],
      [
        'classes present, no properties',
        '{"schemaVersion":1,"classes":[{"className":"P","properties":[]}]}',
      ],
      [
        'class set disjoint from the tree',
        JSON.stringify({
          schemaVersion: 1,
          classes: [
            {
              className: 'NoSuchProvider',
              properties: [
                { name: 'P', status: 'wired', types: [], evidence: ['element-read'], seededBy: ['create'] },
              ],
            },
          ],
        }),
      ],
    ];
    for (const [why, payload] of payloads) {
      const file = join(scratch, `unusable-${why.replace(/\W+/g, '-')}.json`);
      writeFileSync(file, payload);
      const checked = runCheck(undefined, [`--baseline=${file}`]);
      expect(checked.status, `--check must refuse: ${why}`).toBe(1);
      expect(checked.stderr, why).toContain('unusable baseline at');
      expect(checked.stderr, why).not.toContain('handled-property-wiring: OK');

      const outDir = join(scratch, `unusable-out-${why.replace(/\W+/g, '-')}`);
      const written = run([`--out-dir=${outDir}`, `--baseline=${file}`]);
      expect(written.status, `the writer must refuse: ${why}`).toBe(1);
      expect(existsSync(join(outDir, 'handled-property-wiring.json')), why).toBe(false);
      // The tamper is left ON DISK rather than silently overwritten — the trace
      // is the whole point.
      expect(readFileSync(file, 'utf8'), why).toBe(payload);
    }
  }, SPAWN_TIMEOUT_MS);

  it('PRINTS the graded coverage on BOTH the check and the WRITE path', () => {
    // The zero threshold is defended in-code by "every run prints graded N/M",
    // so that string is load-bearing prose — and nothing pinned it. Worse, the
    // WRITER did not print it at all, which is the path CI runs and the path an
    // author runs when regenerating (the #1808 shape), so the sole stated
    // mitigation was absent exactly where it was needed.
    // The DEPTH half is asserted too. Round 4 found the pairs figure pinned by
    // nothing; the field added to fix that then shipped unasserted itself —
    // stripping `(N evidence entries)` from all four print sites left the suite
    // green, two lines from the sibling assertion for pairs.
    const checked = runCheck();
    expect(checked.status).toBe(0);
    expect(checked.stderr).toMatch(/graded \d+\/\d+ pairs, \d+ evidence entries/);

    const written = run([`--out-dir=${join(scratch, 'out-graded-line')}`]);
    expect(written.status).toBe(0);
    expect(written.stderr, 'the WRITER must print it too').toMatch(
      /graded \d+\/\d+ pairs \(\d+ evidence entries\)/
    );
  }, SPAWN_TIMEOUT_MS);

  it('the refusal NAMES the pair counts and the remediation flag', () => {
    // The twin of "names the escape hatch in the failure text" on the loss path.
    // Without it, stripping the counts and the flag from the refusal is green.
    const { status, stderr } = runCheck(undefined, ['--baseline=/nonexistent-baseline.json']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/Graded \d+\/\d+ pairs \(\d+ evidence entries\)/);
    expect(stderr).toContain(ACCEPT_MISSING_BASELINE_FLAG);
  }, SPAWN_TIMEOUT_MS);

  it('refuses a SELF-INCONSISTENT baseline, whose summary disagrees with its classes', () => {
    // The measured bypass: cutting the real matrix to ONE pair with a single
    // `jq` line grades 1 pair, so a bare non-vacuity test waved it through while
    // the other 1137 went ungraded — writer exit 0, CI's regenerate-and-diff
    // clean, `--check` OK. The cut file still advertises the full
    // `declaredProperties`, and that disagreement is a free discriminator.
    const real = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'), 'utf8')
    ) as HandledPropertyWiringReport;
    const one = real.classes[0]!;
    const shrunk = join(scratch, 'shrunk-one-pair.json');
    writeFileSync(
      shrunk,
      JSON.stringify({ ...real, classes: [{ ...one, properties: [one.properties[0]!] }] })
    );
    const degraded = providersCopyWith('providers-shrunk-baseline', 'dynamodb-table-provider.ts', degradeWarmThroughput);
    const outDir = join(scratch, 'out-shrunk-baseline');
    const { status, stderr } = run([
      `--providers-dir=${degraded}`,
      `--out-dir=${outDir}`,
      `--baseline=${shrunk}`,
    ]);
    expect(status, 'a shrunken baseline must not be graded against').toBe(1);
    expect(stderr).toContain('Its own summary disagrees with the classes it holds');
    expect(existsSync(join(outDir, 'handled-property-wiring.json'))).toBe(false);
    // ...and a baseline with NO summary at all is the same defect: the generator
    // always writes one, so its absence means the file is not generator output.
    const noSummary = join(scratch, 'no-summary.json');
    writeFileSync(
      noSummary,
      JSON.stringify({ schemaVersion: 1, classes: [{ ...one, properties: [one.properties[0]!] }] })
    );
    const b = runCheck(undefined, [`--baseline=${noSummary}`]);
    expect(b.status).toBe(1);
    expect(b.stderr).toContain('it carries no summary at all');
  }, SPAWN_TIMEOUT_MS);

  it('every malformed FIELD gets a STRUCTURED refusal, not a caught crash', () => {
    // `expect(loadBaseline(x)).toBeNull()` is a weak assertion here: the outer
    // try/catch turns the walk's TypeError into null too, so it passes with the
    // shape checks DELETED — it cannot tell a structured refusal from the very
    // crash those checks exist to replace. Drive the shipped command and assert
    // the verdict text, plus the absence of the crash prefix.
    //
    // Each payload is built from the REAL matrix with its summary RECOMPUTED
    // around the malformation, so no earlier condition can fire and the shape
    // check is the only thing that can refuse. A first attempt used a synthetic
    // payload with `summary: {}`, and the `status` / `bucket` mutants passed on
    // condition 1 instead — the "trips an earlier clause" trap, reproduced in
    // the very test written to avoid it.
    const real = loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'))!;
    const firstWired = real.classes.findIndex((c) => c.properties.some((p) => p.status === 'wired'));
    const withClass = (
      mutate: (c: ClassClassification) => unknown
    ): Record<string, unknown> => {
      const classes = real.classes.map((c, i) => (i === firstWired ? mutate(c) : c));
      return { ...buildReport(real.classes), classes };
    };
    const consistent = (mutate: (c: ClassClassification) => ClassClassification): Record<string, unknown> => {
      const classes = real.classes.map((c, i) => (i === firstWired ? mutate(c) : c));
      // Recomputed AROUND the malformation, so condition 1 is satisfied and only
      // the union check can refuse.
      return buildReport(classes) as unknown as Record<string, unknown>;
    };
    const mutateFirstProp = (
      c: ClassClassification,
      f: (p: PropertyClassification) => unknown
    ): ClassClassification => {
      const pi = c.properties.findIndex((p) => p.status === 'wired');
      return { ...c, properties: c.properties.map((p, j) => (j === pi ? f(p) : p)) } as ClassClassification;
    };

    const mutations: ReadonlyArray<[string, Record<string, unknown>]> = [
      // Union violations, with a summary consistent WITH the malformed value —
      // these are the ones only `BUCKETS.has` can catch.
      [
        // The panel's exact one-line tamper: relabel ONE property to a value not
        // in the union AND blank its evidence. Consistent summary (condition 1
        // satisfied), no label contradiction (condition 2 sees a non-wired entry
        // with no evidence), still overlapping (condition 3 fine) — so ONLY the
        // union check stands between this and hiding the loss being committed.
        // Leaving the evidence in place instead made condition 2 fire, and the
        // fixture passed without exercising the union check at all.
        'status not in the union',
        consistent(
          (c) =>
            mutateFirstProp(c, (p) => ({
              ...p,
              status: 'totally-bogus-status',
              evidence: [],
              seededBy: [],
            })) as ClassClassification
        ),
      ],
      [
        'bucket not in the union',
        consistent((c) => ({ ...c, bucket: 'not-a-bucket' } as unknown as ClassClassification)),
      ],
      // Shape / type errors.
      ['className missing', withClass((c) => ({ ...c, className: undefined }))],
      ['className not a string', withClass((c) => ({ ...c, className: 42 }))],
      ['file missing', withClass((c) => ({ ...c, file: undefined }))],
      ['gaps not an array', withClass((c) => ({ ...c, gaps: 'none' }))],
      ['blindSpots not an array', withClass((c) => ({ ...c, blindSpots: null }))],
      ['properties not an array', withClass((c) => ({ ...c, properties: 'Alpha' }))],
      ['property name missing', withClass((c) => mutateFirstProp(c, (p) => ({ ...p, name: undefined })))],
      ['evidence not an array', withClass((c) => mutateFirstProp(c, (p) => ({ ...p, evidence: 'element-read' })))],
      ['seededBy not an array', withClass((c) => mutateFirstProp(c, (p) => ({ ...p, seededBy: 'create' })))],
    ];
    for (const [why, payload] of mutations) {
      const file = join(scratch, `malformed-${why.replace(/\W+/g, '-')}.json`);
      writeFileSync(file, JSON.stringify(payload));
      const { status, stderr } = runCheck(undefined, [`--baseline=${file}`]);
      expect(status, `${why} must be refused`).toBe(1);
      expect(stderr, `${why} must get the structured verdict`).toContain('unusable baseline at');
      expect(stderr, `${why} must NOT surface as a raw crash`).not.toContain(
        'handled-property-wiring: failed —'
      );
    }
  }, SPAWN_TIMEOUT_MS);

  it('a TRUNCATED baseline is refused the same way a missing one is', () => {
    // `loadBaseline` answers null for both, so the refusal must not be keyed on
    // the file being absent — a half-written matrix is the likelier accident.
    const truncated = join(scratch, 'truncated-baseline.json');
    writeFileSync(truncated, JSON.stringify({ schemaVersion: 1, classes: [{ className: 'P' }] }));
    const { status, stderr } = run([
      `--out-dir=${join(scratch, 'out-truncated')}`,
      `--baseline=${truncated}`,
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain('unusable baseline at');
  }, SPAWN_TIMEOUT_MS);

  it('an absent --baseline= on an un-redirected WRITE is refused by the seam guard', () => {
    // The seam guard fires FIRST, which is correct: pointing the baseline at
    // nothing and writing the committed matrix is the attack, whichever message
    // names it. The missing-FILE case cannot be reached by any flag, so it is
    // covered by the predicate table and the file-move case below.
    const { status, stderr } = run(['--baseline=/nonexistent-baseline.json']);
    expect(status).toBe(1);
    expect(stderr).toContain('may only accompany a WRITE when --out-dir=');
  }, SPAWN_TIMEOUT_MS);

  // ---- the TWO-FLAG matrix ----
  //
  // Splitting one waiver into two doubled the surface, and round 3 shipped it
  // roughly half-fenced: dropping ACCEPT_MISSING_BASELINE_FLAG from the
  // check-mode rejection list left the whole suite GREEN, as did making the loss
  // waiver also waive a missing baseline. Each flag needs FOUR assertions —
  // it waives its own condition, it does NOT waive the other's, it is rejected
  // under --check, and its condition refuses when neither flag is passed — so
  // they are enumerated as a matrix rather than case by case.
  const UNUSABLE_BASELINE = '--baseline=/nonexistent-baseline.json';
  /** A providers tree whose only defect is an evidence LOSS (baseline is fine). */
  const lossOnlyTree = (): string =>
    providersCopyWith('providers-two-flag-matrix', 'dynamodb-table-provider.ts', degradeWarmThroughput);

  it('MATRIX: each waiver waives its OWN condition and NOT the other', () => {
    const outDir = (n: string): string => join(scratch, `matrix-${n}`);
    const degraded = lossOnlyTree();

    // 1. loss waiver + loss condition -> writes, announces the enumeration.
    const a = run([`--providers-dir=${degraded}`, `--out-dir=${outDir('a')}`, ACCEPT_LOSS_FLAG]);
    expect(a.status, 'loss waiver must waive a loss').toBe(0);
    expect(a.stderr).toContain('ACCEPTED EVIDENCE LOSS');
    expect(a.stderr).toContain('DynamoDBTableProvider#WarmThroughput');

    // 2. loss waiver + unusable-baseline condition -> REFUSED (the corrupted-byte
    //    tamper: one flag for both let this write an ungraded matrix at exit 0).
    const b = run([`--out-dir=${outDir('b')}`, UNUSABLE_BASELINE, ACCEPT_LOSS_FLAG]);
    expect(b.status, 'loss waiver must NOT waive an unusable baseline').toBe(1);
    expect(b.stderr).toContain('unusable baseline at');
    expect(existsSync(join(outDir('b'), 'handled-property-wiring.json'))).toBe(false);

    // 3. baseline waiver + unusable-baseline condition -> writes, announces.
    const c = run([`--out-dir=${outDir('c')}`, UNUSABLE_BASELINE, ACCEPT_MISSING_BASELINE_FLAG]);
    expect(c.status, 'baseline waiver must waive an unusable baseline').toBe(0);
    expect(c.stderr).toContain('ACCEPTED MISSING BASELINE');
    expect(c.stderr).toMatch(/0\/\d+ pairs\n\(0 evidence entries\)/);
    expect(c.stderr).toContain('/nonexistent-baseline.json');
    expect(existsSync(join(outDir('c'), 'handled-property-wiring.json'))).toBe(true);

    // 3b. The SAME cell with a PARSEABLE but unusable payload. Cell 3 above uses
    // an absent file, so `baseline === null` and `!assessment.usable` are
    // indistinguishable there — which is exactly how the silent-write bug
    // survived: keying the announcement on the former left this path writing
    // with NO announcement at all, and the whole suite stayed green.
    const parseableUnusable = join(scratch, 'matrix-empty-classes.json');
    writeFileSync(parseableUnusable, '{"schemaVersion":1,"classes":[]}');
    const c2 = run([
      `--out-dir=${outDir('c2')}`,
      `--baseline=${parseableUnusable}`,
      ACCEPT_MISSING_BASELINE_FLAG,
    ]);
    expect(c2.status, 'a parseable-but-unusable baseline must also be waivable').toBe(0);
    expect(c2.stderr, 'the waiver must ANNOUNCE, not write silently').toContain(
      'ACCEPTED MISSING BASELINE'
    );
    expect(c2.stderr).toMatch(/0\/\d+ pairs\n\(0 evidence entries\)/);
    expect(existsSync(join(outDir('c2'), 'handled-property-wiring.json'))).toBe(true);

    // 4. baseline waiver + loss condition -> REFUSED (the mirror of 2).
    const d = run([
      `--providers-dir=${degraded}`,
      `--out-dir=${outDir('d')}`,
      ACCEPT_MISSING_BASELINE_FLAG,
    ]);
    expect(d.status, 'baseline waiver must NOT waive an evidence loss').toBe(1);
    expect(d.stderr).toContain('declared properties LOST wiring evidence');
    expect(d.stderr).not.toContain('ACCEPTED');

    // 5. neither flag -> both conditions refuse.
    const e = run([`--providers-dir=${degraded}`, `--out-dir=${outDir('e')}`]);
    expect(e.status).toBe(1);
    expect(e.stderr).toContain('declared properties LOST wiring evidence');
    const f = run([`--out-dir=${outDir('f')}`, UNUSABLE_BASELINE]);
    expect(f.status).toBe(1);
    expect(f.stderr).toContain('unusable baseline at');
  }, SPAWN_TIMEOUT_MS);

  it('BOTH waivers together announce BOTH acceptances, not just the loss', () => {
    // The notice was an `else if` chained to the loss acceptance. An ABSENT
    // baseline cannot expose that: with nothing to compare there are no losses,
    // so the `else` branch runs either way and the test passes under both
    // keyings. It needs a baseline that is UNUSABLE yet content-rich enough to
    // still produce losses — a self-inconsistent copy of the real matrix — so
    // both conditions hold at once and chaining them visibly swallows one.
    const real = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'), 'utf8')
    ) as HandledPropertyWiringReport;
    const inconsistent = join(scratch, 'inconsistent-but-rich.json');
    writeFileSync(
      inconsistent,
      JSON.stringify({
        ...real,
        summary: { ...real.summary, classifiedCount: real.summary.classifiedCount + 7 },
      })
    );
    const degraded = providersCopyWith('providers-both-waivers', 'dynamodb-table-provider.ts', degradeWarmThroughput);
    const outDir = join(scratch, 'out-both-waivers');
    const { status, stderr } = run([
      `--providers-dir=${degraded}`,
      `--out-dir=${outDir}`,
      `--baseline=${inconsistent}`,
      ACCEPT_LOSS_FLAG,
      ACCEPT_MISSING_BASELINE_FLAG,
    ]);
    expect(status).toBe(0);
    expect(stderr, 'the loss enumeration must be printed').toContain('ACCEPTED EVIDENCE LOSS');
    expect(stderr).toContain('DynamoDBTableProvider#WarmThroughput');
    expect(stderr, 'the missing-baseline notice must not be swallowed by the loss notice').toContain(
      'ACCEPTED MISSING BASELINE'
    );
    expect(stderr).toContain('wrote handled-property-wiring');
  }, SPAWN_TIMEOUT_MS);

  it('MATRIX: BOTH waivers are rejected under --check, together and separately', () => {
    // Round 3 fenced only ACCEPT_LOSS_FLAG here; dropping the other from the
    // rejection list left 125 green while
    // `--check --baseline=<absent> --accept-missing-baseline` printed
    // `OK - 0 evidence losses` at exit 0 — the unearned green, reopened.
    for (const flags of [
      [ACCEPT_LOSS_FLAG],
      [ACCEPT_MISSING_BASELINE_FLAG],
      [ACCEPT_LOSS_FLAG, ACCEPT_MISSING_BASELINE_FLAG],
    ]) {
      // On a CLEAN tree — the flag is refused for existing at all, not because
      // something else was wrong.
      const clean = runCheck(undefined, flags);
      expect(clean.status, `--check ${flags.join(' ')} must be refused`).toBe(1);
      expect(clean.stderr).toContain('is a WRITER escape hatch');
      // ...and with the condition it would waive actually present, so it cannot
      // pass by silently suppressing the verdict.
      const armed = runCheck(undefined, [...flags, UNUSABLE_BASELINE]);
      expect(armed.status).toBe(1);
      expect(armed.stderr).toContain('is a WRITER escape hatch');
      expect(armed.stderr).not.toContain('handled-property-wiring: OK');
      expect(armed.stderr).not.toContain('0 evidence losses');
    }
  }, SPAWN_TIMEOUT_MS);


  it('the WRITER is clean on the real tree and reproduces the COMMITTED matrix byte-for-byte', () => {
    // The baseline every future run grades against has to be reproducible from
    // the committed source, or the verdict is graded against a fiction.
    const outDir = join(scratch, 'out-real');
    const { status } = run([`--out-dir=${outDir}`]);
    expect(status).toBe(0);
    for (const name of ['handled-property-wiring.json', 'handled-property-wiring.md']) {
      expect(readFileSync(join(outDir, name), 'utf8'), `${name} must match the committed copy`).toBe(
        readFileSync(resolve(REPO_ROOT, 'docs/_generated', name), 'utf8')
      );
    }
  }, SPAWN_TIMEOUT_MS);

});

describe('unusable-baseline refusal predicate (#1842)', () => {
  const cases: ReadonlyArray<[Parameters<typeof shouldRefuseUnusableBaseline>[0], boolean, string]> = [
    [{ usable: false, acceptMissingBaseline: false }, true, 'nothing it can prove'],
    [{ usable: true, acceptMissingBaseline: false }, false, 'ordinary run'],
    [{ usable: false, acceptMissingBaseline: true }, false, 'first-ever generation'],
    [{ usable: true, acceptMissingBaseline: true }, false, 'waiver with a usable baseline'],
  ];
  for (const [opts, expected, why] of cases) {
    it(`${expected ? 'refuses' : 'allows'}: ${why}`, () => {
      expect(shouldRefuseUnusableBaseline(opts)).toBe(expected);
    });
  }

  it('refuses ONLY when the baseline is unusable and unwaived', () => {
    const bools = [false, true];
    const refusals = bools.flatMap((usable) =>
      bools
        .map((acceptMissingBaseline) => ({ usable, acceptMissingBaseline }))
        .filter(shouldRefuseUnusableBaseline)
    );
    expect(refusals).toEqual([{ usable: false, acceptMissingBaseline: false }]);
  });
});

describe('assessBaseline — usability stated POSITIVELY (#1842)', () => {
  const live = loadReport(PROVIDERS_DIR);
  const pair = (className: string, name: string) => ({
    file: 'p.ts',
    className,
    bucket: 'wired' as const,
    declaredCount: 1,
    properties: [
      {
        name,
        status: 'wired' as const,
        types: [],
        // Non-empty: a `wired` property with blank evidence is now itself a
        // defect (`evidence-stripped`), so a fixture using it would test that
        // rather than whatever it meant to.
        evidence: ['element-read'] as never[],
        seededBy: ['create'],
      },
    ],
    gaps: [],
    blindSpots: [],
  });
  const wrap = (classes: ClassClassification[]): HandledPropertyWiringReport => buildReport(classes);

  // Every shape three review rounds closed one at a time. They are ONE condition
  // — the comparison cannot fail — and this table is what stops a fourth
  // spelling from needing a fourth guard.
  it('treats absent / empty / property-less / disjoint baselines identically: unusable', () => {
    const shapes: ReadonlyArray<[string, HandledPropertyWiringReport | null]> = [
      ['absent (loadBaseline gave null)', null],
      ['empty class list', wrap([])],
      ['classes present, no properties', wrap([{ ...pair('P', 'X'), properties: [] }])],
      ['class set disjoint from the tree', wrap([pair('NoSuchProvider', 'Whatever')])],
    ];
    for (const [why, baseline] of shapes) {
      const a = assessBaseline(baseline, live);
      expect(a.usable, `${why} must be unusable`).toBe(false);
      expect(a.gradedPairs, why).toBe(0);
      expect(a.currentPairs, why).toBeGreaterThan(900);
    }
  });

  it('refuses a SELF-INCONSISTENT baseline before asking about overlap', () => {
    // The fourth spelling, and the one a bare non-vacuity test cannot see: the
    // real matrix cut to one pair DOES overlap, so only the artifact disagreeing
    // with itself distinguishes it from a legitimately tiny tree.
    const real = live.classes[0]!;
    const shrunk = buildReport([{ ...real, properties: [real.properties[0]!] }]);
    const withStaleSummary = {
      ...shrunk,
      summary: { ...shrunk.summary, declaredProperties: 1138, classifiedCount: 84 },
    } as HandledPropertyWiringReport;
    const a = assessBaseline(withStaleSummary, live);
    expect(a.usable).toBe(false);
    expect(a.defect).toBe('self-inconsistent');
    expect(a.baselinePairs).toBe(1);
    expect(a.baselineClaimedPairs).toBe(1138);
    // It DOES overlap — which is exactly why non-vacuity alone waved it through.
    expect(a.gradedPairs).toBe(1);
  });

  it('detects a mismatch in EACH summary field ON ITS OWN', () => {
    // Round 5's check was a two-clause conjunction and NEITHER clause was
    // fenced: both fixtures shrank the matrix to one class AND one property, so
    // each tripped both clauses at once and deleting either half stayed green.
    // A fixture that trips every clause of a conjunction fences none of them.
    // The property-only shrink is also the LIKELIER accident — a partial write
    // or bad merge drops properties inside classes while the class count holds.
    const real = loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'))!;
    const fields = [
      'classifiedCount',
      'declaredProperties',
      'wiredProperties',
      'wired',
      'gap',
      'allowListed',
      'classesWithBlindSpots',
    ] as const;
    for (const field of fields) {
      const tampered = {
        ...real,
        summary: { ...real.summary, [field]: (real.summary[field] as number) + 1 },
      } as HandledPropertyWiringReport;
      const a = assessBaseline(tampered, live);
      expect(a.usable, `a wrong ${field} alone must be caught`).toBe(false);
      expect(a.defect, field).toBe('self-inconsistent');
      expect(a.detail, field).toContain(field);
    }
  });

  it('catches a PROPERTY-only shrink that leaves the class count intact', () => {
    // The realistic `jq` cut: keep all 84 classes, trim each to its first
    // property. `classifiedCount` still agrees; only the property-side fields
    // disagree. Measured before this: reported OK, exit 0, graded 81/1138.
    const real = loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'))!;
    const shrunk = {
      ...real,
      classes: real.classes.map((c) => ({ ...c, properties: c.properties.slice(0, 1) })),
    } as HandledPropertyWiringReport;
    expect(shrunk.classes.length, 'the class count must still agree').toBe(real.summary.classifiedCount);
    const a = assessBaseline(shrunk, live);
    expect(a.usable).toBe(false);
    expect(a.defect).toBe('self-inconsistent');
    expect(a.detail).toContain('declaredProperties');
    expect(a.gradedPairs, 'it DOES overlap — which is why non-vacuity missed it').toBeGreaterThan(0);
  });

  it('catches a CLASS-only drop that leaves the property arrays untouched', () => {
    // The mirror: remove whole classes, so `declaredProperties` and
    // `classifiedCount` disagree in the other direction.
    const real = loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'))!;
    const dropped = { ...real, classes: real.classes.slice(0, 40) } as HandledPropertyWiringReport;
    const a = assessBaseline(dropped, live);
    expect(a.usable).toBe(false);
    expect(a.defect).toBe('self-inconsistent');
    expect(a.detail).toContain('classifiedCount');
  });

  it('detects EACH label defect ON ITS OWN (the biconditional, per half)', () => {
    // Round 5's fix reproduced round 5's defect INSIDE itself: the evidence
    // requirement was `evidence.length === 0 || seededBy.length === 0`, and the
    // sole fixture blanked BOTH, so dropping either half stayed green. Every
    // clause is itself a conjunction or disjunction needing its own fixture —
    // the lesson recurses, so it is applied here to all three directions.
    const real = loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'))!;
    const firstWired = (): { ci: number; pi: number } => {
      for (const [ci, c] of real.classes.entries()) {
        const pi = c.properties.findIndex((x) => x.status === 'wired');
        if (pi >= 0) return { ci, pi };
      }
      throw new Error('the fixture needs a wired property');
    };
    const { ci, pi } = firstWired();
    // The summary is RECOMPUTED for each fixture. Without that, relabelling a
    // property changes `wiredProperties` and condition 1 fires first, so the
    // label check would never be reached and the fixture would pass for the
    // wrong reason — the same "trips an earlier clause" trap one layer over.
    const patch = (
      mutate: (p: PropertyClassification) => PropertyClassification
    ): HandledPropertyWiringReport =>
      buildReport(
        real.classes.map((c, i) =>
          i !== ci
            ? c
            : { ...c, properties: c.properties.map((x, j) => (j !== pi ? x : mutate(x))) }
        )
      );

    const cases: ReadonlyArray<[string, HandledPropertyWiringReport, string]> = [
      // wired, evidence blanked, seeds intact — only the evidence half fires.
      ['evidence half', patch((x) => ({ ...x, evidence: [] })), 'wired with no evidence'],
      // wired, seeds blanked, evidence intact — only the seeds half fires.
      ['seeds half', patch((x) => ({ ...x, seededBy: [] })), 'wired with no seeding member'],
      // the CONVERSE direction: relabelled away from wired while still carrying
      // evidence. A one-way check keyed on `status` misses this entirely.
      [
        'converse',
        patch((x) => ({ ...x, status: 'gap' as const })),
        'not wired yet carrying evidence',
      ],
      // The converse is ITSELF a disjunction, and its two halves cannot be
      // fenced by any fixture derived from the real matrix: there,
      // `evidence` and `seededBy` are PERFECTLY CORRELATED (1136 with both, 2
      // with neither, ZERO one-sided), so every real-data fixture trips both
      // halves at once. That is the repo's documented "perfectly correlated
      // signals leave one half unfenced" trap, and it is why this defect
      // recurred through six rounds — not a missed case, but a discriminating
      // input real data cannot produce. These two are synthesized deliberately.
      [
        'converse, EVIDENCE side only',
        patch((x) => ({ ...x, status: 'gap' as const, seededBy: [] })),
        'not wired yet carrying evidence',
      ],
      [
        'converse, SEEDS side only',
        patch((x) => ({ ...x, status: 'gap' as const, evidence: [] })),
        'not wired yet carrying evidence',
      ],
    ];
    for (const [why, baseline, expected] of cases) {
      const a = assessBaseline(baseline, live);
      expect(a.usable, `${why} must be caught alone`).toBe(false);
      expect(a.defect, why).toBe('evidence-stripped');
      expect(a.detail, why).toContain(expected);
    }

    // ...and the SAME one-sided fixture fences the `provable` OR, which an
    // earlier revision called unfenceable "because no input can distinguish
    // them downstream of condition 2". Both halves of that were wrong:
    // `provable` is computed UPSTREAM of condition 2, and these counts are
    // returned on every failure path (and printed, and written on under
    // `--accept-missing-baseline`). A one-sided entry is still provable — it can
    // lose the side it has — so narrowing to `&&` undercounts by exactly one.
    const oneSided = assessBaseline(
      patch((x) => ({ ...x, status: 'gap' as const, evidence: [] })),
      live
    );
    const intact = assessBaseline(real, live);
    expect(oneSided.gradedPairs, 'the one-sided entry stays provable under `||`').toBe(
      intact.gradedPairs
    );
    expect(oneSided.gradedDepth, 'it contributes only the side it still has').toBe(
      intact.gradedDepth - real.classes[ci]!.properties[pi]!.evidence.length
    );
  });

  it('measures the DEPTH of the record, not just pair presence', () => {
    // Pair counting is binary per pair, so trimming ONE entry's `seededBy` to a
    // still-non-empty subset of what the current tree proves hid a real loss at
    // ZERO announced cost — the OK line was byte-identical to the clean-tree
    // one. Depth is what issue #1842 defends, so depth is what the metric now
    // reports. It cannot be padded for the same reason the biconditional cannot
    // be gamed: fabricated evidence must be a SUBSET of what the current run
    // proves, or the comparison reports it as a loss.
    const real = loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'))!;
    const intact = assessBaseline(real, live);
    expect(intact.gradedDepth).toBe(
      real.classes
        .flatMap((c) => c.properties)
        .reduce((n, p) => n + p.evidence.length + p.seededBy.length, 0)
    );

    // Trim one entry's seeds; the PAIR count must not move, the depth must.
    const ci = real.classes.findIndex((c) => c.properties.some((p) => p.seededBy.length > 1));
    const pi = real.classes[ci]!.properties.findIndex((p) => p.seededBy.length > 1);
    const before = real.classes[ci]!.properties[pi]!;
    const trimmed = {
      ...real,
      classes: real.classes.map((c, i) =>
        i !== ci
          ? c
          : {
              ...c,
              properties: c.properties.map((p, j) =>
                j !== pi ? p : { ...p, seededBy: p.seededBy.slice(0, 1) }
              ),
            }
      ),
    } as HandledPropertyWiringReport;
    const after = assessBaseline(trimmed, live);
    expect(after.gradedPairs, 'pair counting is blind to a trim').toBe(intact.gradedPairs);
    expect(after.gradedDepth, 'depth is not').toBe(
      intact.gradedDepth - (before.seededBy.length - 1)
    );
  });

  it('sums depth over the INTERSECTION with the live tree, not the whole baseline', () => {
    // The correlation trap, third instance: every other depth fixture grades the
    // committed matrix against the live tree, and those are IDENTICAL — so
    // "sum over the intersection" and "sum over all baseline entries" cannot be
    // told apart by real data, and forcing the latter left 145/145 green.
    //
    // It matters because a SUPERSET baseline is explicitly admitted (an older
    // checked-out matrix), and summing the whole thing would over-report the
    // announced depth — the same "the number claims presence, not provable
    // content" defect this metric was added to fix, one level along.
    const real = loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'))!;
    const narrowed: HandledPropertyWiringReport = {
      ...live,
      classes: live.classes.slice(0, 10),
    };
    const a = assessBaseline(real, narrowed);
    const expectedPairs = narrowed.classes.reduce((n, c) => n + c.properties.length, 0);
    const baselineByKey = new Map(
      real.classes.flatMap((c) => c.properties.map((p) => [allowKey(c.className, p.name), p] as const))
    );
    const expectedDepth = narrowed.classes
      .flatMap((c) => c.properties.map((p) => baselineByKey.get(allowKey(c.className, p.name))))
      .reduce((n, p) => n + (p ? p.evidence.length + p.seededBy.length : 0), 0);

    expect(a.currentPairs).toBe(expectedPairs);
    expect(a.gradedDepth, 'only the 10 classes being graded may contribute').toBe(expectedDepth);
    // The discriminator: the whole baseline is far deeper than the slice.
    const wholeBaselineDepth = real.classes
      .flatMap((c) => c.properties)
      .reduce((n, p) => n + p.evidence.length + p.seededBy.length, 0);
    expect(a.gradedDepth).toBeLessThan(wholeBaselineDepth);
  });

  it('counts as GRADED only the pairs the baseline could actually fail on', () => {
    // The announced number was a claim about KEY PRESENCE, so a wholesale
    // blanking still printed `graded 1138/1138` — the mitigation asserting full
    // coverage of a baseline that could prove nothing. Counting provable pairs
    // makes the printed line mean what it says, which is worth more than the
    // refusal: a surgical one-property tamper now announces 1135 rather than a
    // clean 1138.
    const real = loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'))!;
    const intact = assessBaseline(real, live);
    expect(intact.gradedPairs).toBeLessThan(intact.currentPairs);
    expect(intact.gradedPairs, 'the 2 allow-listed pairs have no evidence to lose').toBe(
      real.classes.flatMap((c) => c.properties).filter((p) => p.evidence.length || p.seededBy.length)
        .length
    );
    const blanked = {
      ...real,
      classes: real.classes.map((c) => ({
        ...c,
        properties: c.properties.map((p) => ({ ...p, status: 'gap' as const, evidence: [], seededBy: [] })),
      })),
    } as HandledPropertyWiringReport;
    expect(assessBaseline(blanked, live).gradedPairs, 'blanked pairs grade nothing').toBe(0);
  });

  it('refuses a baseline whose counts are perfect but whose EVIDENCE is stripped', () => {
    // Strictly worse than any shrink: every count is immaculate, so the
    // mitigation announces `graded 1138/1138` while the comparison reads blank
    // fields and can report nothing. Rounds 1-4 all constrained something
    // ADJACENT to the comparison; this is the field it actually consumes.
    const real = loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'))!;
    const blanked = {
      ...real,
      classes: real.classes.map((c) => ({
        ...c,
        properties: c.properties.map((p) => ({ ...p, evidence: [], seededBy: [] })),
      })),
    } as HandledPropertyWiringReport;
    const a = assessBaseline(blanked, live);
    expect(a.usable).toBe(false);
    expect(a.defect).toBe('evidence-stripped');
    // It still holds every KEY — which is why key-presence counting announced a
    // clean `graded 1138/1138` here — but nothing it holds can fail.
    expect(a.baselinePairs).toBe(a.currentPairs);
    expect(a.gradedPairs, 'every key present, zero provable content').toBe(0);
  });

  it('counts DISTINCT pairs, so replication cannot fake a length', () => {
    const real = loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json'))!;
    const replicated = {
      ...real,
      classes: real.classes.map((c) => ({
        ...c,
        properties: c.properties.map(() => c.properties[0]!),
      })),
    } as HandledPropertyWiringReport;
    const a = assessBaseline(replicated, live);
    expect(a.baselinePairs, 'distinct keys, not array length').toBeLessThan(
      replicated.classes.reduce((n, c) => n + c.properties.length, 0)
    );
    expect(a.usable).toBe(false);
  });

  it('names WHICH defect made a baseline unusable', () => {
    expect(assessBaseline(null, live).defect).toBe('absent');
    const disjoint = buildReport([pair('NoSuchProvider', 'Whatever')]);
    expect(assessBaseline(disjoint, live).defect).toBe('no-overlap');
  });

  it('DOCUMENTS the residual bound: a self-consistent miniature IS accepted', () => {
    // Stated as a test rather than glossed in prose. The accidental shapes (a
    // bad merge, a partial write, a truncation, a `jq` edit) all leave the
    // summary disagreeing and are refused; producing a CONSISTENT miniature
    // requires hand-authoring a file claiming the tree has one property, which
    // is no longer an accident — and every run prints `graded 1/1138`, so it
    // announces itself in output the author is already reading.
    const real = live.classes[0]!;
    const mini = buildReport([{ ...real, properties: [real.properties[0]!] }]);
    const a = assessBaseline(mini, live);
    expect(a.usable, 'a self-consistent miniature is accepted — the documented bound').toBe(true);
    expect(a.gradedPairs).toBe(1);
    expect(a.currentPairs).toBeGreaterThan(900);
  });

  it('a baseline sharing even ONE real pair is usable, and says how much it covers', () => {
    // The threshold is zero rather than a ratio: any positive number would be a
    // magic constant, and legitimate drift (a PR adding a provider class) must
    // not trip it. Partial coverage is handled by VISIBILITY — the run prints
    // `graded N/M pairs` — not by a threshold nobody can defend.
    const real = live.classes[0]!;
    const a = assessBaseline(wrap([{ ...real, properties: [real.properties[0]!] }]), live);
    expect(a.usable).toBe(true);
    expect(a.gradedPairs).toBe(1);
    expect(a.gradedPairs).toBeLessThan(a.currentPairs);
  });

  it('the COMMITTED matrix grades every pair that CAN fail', () => {
    // The repo invariant that makes the zero-threshold safe: erosion of coverage
    // is loud here rather than implied by a silent OK. Stated against the
    // PROVABLE pairs rather than all declared ones — the 2 allow-listed
    // properties carry no evidence by definition, so 1136/1138 is the honest
    // ceiling and pinning 100% would have been pinning a falsehood.
    const a = assessBaseline(
      loadBaseline(resolve(REPO_ROOT, 'docs/_generated/handled-property-wiring.json')),
      live
    );
    expect(a.usable).toBe(true);
    const provable = live.classes
      .flatMap((c) => c.properties)
      .filter((p) => p.evidence.length > 0 || p.seededBy.length > 0).length;
    expect(a.gradedPairs).toBe(provable);
    expect(a.currentPairs - a.gradedPairs, 'exactly the allow-listed pairs').toBe(
      live.classes.flatMap((c) => c.properties).filter((p) => p.status !== 'wired').length
    );
  });
});
