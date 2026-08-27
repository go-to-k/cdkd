/**
 * Issue #2269 — a DIFFERENTIAL fence over the secret-mask critic's masker
 * recognition.
 *
 * WHY A DIFFERENTIAL RATHER THAN MORE CASES
 * -----------------------------------------
 * The thing under change is a CLASSIFIER: source text in, `masked` / `raw` /
 * nothing out. A hand-picked case list cannot fence one, because the cases are
 * chosen by the same person who chose the rule and they agree with it by
 * construction — which is exactly how the receiver-blindness this issue reports
 * shipped past 50 self-probes. So both classifiers are RUN: the frozen
 * `origin/main` one in `fixtures/secret-mask-baseline-2269.ts` and the live
 * one, over the same inputs, and every CELL where they disagree must land in an
 * enumerated INTENDED class.
 *
 * THREE PROPERTIES THAT MAKE IT A FENCE RATHER THAN A DIFF VIEWER
 * ---------------------------------------------------------------
 *  1. The classification is by the VALUES OBSERVED, not by the input's shape.
 *     A class declares the transition it requires (`masked -> raw` for a
 *     narrowing, `raw -> masked` for a widening); a cell whose observed
 *     transition contradicts its class FAILS, and so does a cell that differs
 *     while its class says `none`.
 *  2. It watches BOTH DIRECTIONS. A cell declared to be in a class and found
 *     NOT to differ fails too — otherwise a fix that quietly stopped applying
 *     would read as "no regressions". Finding 2 is a FALSE-POSITIVE fix, so its
 *     accept cells assert a correct sibling is not reddened, and its control
 *     cells assert the arm next door still is.
 *  3. Every class carries a FLOOR of differing cells. A pool that stops
 *     covering a class — a generator arm silently dropped, a spelling that
 *     stops parsing — cannot pass as "no differences found".
 *
 * The pools are CROSS PRODUCTS (masker spelling x site template, and
 * identity arrangement x use site) rather than a hand-written list, so a cell
 * cannot be quietly tuned one at a time.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

import ts from 'typescript-v6';

import {
  analyzeFile as analyzeLive,
  isErrorFactoryName,
  isInsideDirectory,
  isTransparentWrapper,
  main,
  type SiteVerdict,
} from '../../../scripts/check-provider-secret-mask.ts';
import { analyzeFile as analyzeBaseline } from './fixtures/secret-mask-baseline-2269.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const PROVIDERS_DIR = join(REPO_ROOT, 'src/provisioning/providers');
const COMPOSITE_ID = join(REPO_ROOT, 'src/provisioning/composite-id.ts');

const MASK_IMPORT = `import { maskDeep, maskerOrIdentity } from '../masked-retry-logger.js';`;

// ---------------------------------------------------------------------------
// The enumerated INTENDED classes
// ---------------------------------------------------------------------------

type Transition = 'masked -> raw' | 'raw -> masked';

interface IntendedClass {
  /** The transition every cell in this class must show. */
  readonly transition: Transition;
  /** Minimum differing cells, so a pool that stops covering it cannot pass. */
  readonly floor: number;
  readonly why: string;
}

const INTENDED: Record<string, IntendedClass> = {
  'receiver-narrowed': {
    transition: 'masked -> raw',
    floor: 15,
    why: 'finding 1: a derived masker NAME off a receiver the provider does not own',
  },
  'identity-scoped': {
    transition: 'raw -> masked',
    floor: 8,
    why: "finding 2: a correct sibling no longer reddened by the other arm's identity binding",
  },
  'wrapper-launders-identity': {
    transition: 'masked -> raw',
    floor: 6,
    why: 'a named / inline wrapper may no longer launder a REFUSED identity binding',
  },
  'option-argument': {
    transition: 'raw -> masked',
    floor: 6,
    why: "nit 1: `maskDeep(v, m, 1)` — a trailing CONSTANT option is not an unmasking",
  },
  'conditional-masker': {
    transition: 'raw -> masked',
    floor: 4,
    why: 'nit 2: `maskDeep(v, flag ? a : b)` — both arms are the capability',
  },
};

type ClassName = keyof typeof INTENDED | 'none';

interface Cell {
  readonly case: string;
  readonly index: number;
  readonly baseline: SiteVerdict;
  readonly live: SiteVerdict;
  readonly declared: ClassName;
}

function cellsFor(name: string, source: string, declare: (index: number) => ClassName): Cell[] {
  const file = `pool/${name}.ts`;
  const baseline = analyzeBaseline(file, source).sites.map((site) => site.verdict);
  const live = analyzeLive(file, source).sites.map((site) => site.verdict);
  // A pool case whose two runs disagree about how MANY sites exist is not a
  // classification difference at all — the population moved, which no class
  // covers and which must never be silently absorbed into one.
  expect(live.length, `${name}: site COUNT moved (population change, not a verdict change)`).toBe(
    baseline.length
  );
  expect(live.length, `${name}: produced no sites, so it classifies nothing`).toBeGreaterThan(0);
  return live.map((verdict, index) => ({
    case: name,
    index,
    baseline: baseline[index] as SiteVerdict,
    live: verdict,
    declared: declare(index),
  }));
}

// ---------------------------------------------------------------------------
// POOL A — masker SPELLING x site TEMPLATE
// ---------------------------------------------------------------------------

type SpellingKind = 'accepted' | 'foreign' | 'conditional' | 'rejected';

interface Spelling {
  readonly id: string;
  readonly kind: SpellingKind;
  readonly setup: string;
  readonly expression: string;
}

/**
 * The masker-position spellings, INCLUDING the evasions the defect would use:
 * the property is not reached only by the literal `junk.maskLeaf` the issue
 * quotes but by a nested read, a spread rebuild, an `Object.assign` rebuild and
 * a renamed local — plus a COMPUTED access, which neither classifier ever
 * accepted and which is here as the control that says so.
 */
const SPELLINGS: readonly Spelling[] = [
  { id: 'param', kind: 'accepted', setup: '', expression: 'm' },
  { id: 'ctx-read', kind: 'accepted', setup: '', expression: 'context?.maskSecrets' },
  {
    id: 'defaulter',
    kind: 'accepted',
    setup: '',
    expression: 'maskerOrIdentity(context?.maskSecrets)',
  },
  { id: 'inline-wrapper', kind: 'accepted', setup: '', expression: '(v: unknown) => maskDeep(v, m)' },
  { id: 'nullish-left', kind: 'accepted', setup: '', expression: 'm ?? ((t: string) => t)' },
  { id: 'this-method', kind: 'accepted', setup: '', expression: 'this.maskLeaf' },
  { id: 'identity-inline', kind: 'rejected', setup: '', expression: '(t: unknown) => t' },
  {
    id: 'identity-defaulter',
    kind: 'rejected',
    setup: '',
    expression: 'maskerOrIdentity(undefined)',
  },
  {
    id: 'foreign-object',
    kind: 'foreign',
    setup: 'const junk = { maskLeaf: (t: unknown) => t };',
    expression: 'junk.maskLeaf',
  },
  {
    id: 'foreign-nested',
    kind: 'foreign',
    setup: 'const deps = { util: { maskLeaf: (t: unknown) => t } };',
    expression: 'deps.util.maskLeaf',
  },
  {
    id: 'foreign-spread',
    kind: 'foreign',
    setup: 'const base = { maskLeaf: (t: unknown) => t }; const rebuilt = { ...base };',
    expression: 'rebuilt.maskLeaf',
  },
  {
    id: 'foreign-assign',
    kind: 'foreign',
    setup: 'const built = Object.assign({}, { maskLeaf: (t: unknown) => t });',
    expression: 'built.maskLeaf',
  },
  {
    id: 'foreign-renamed',
    kind: 'foreign',
    setup: 'const junk = { maskLeaf: (t: unknown) => t }; const alias = junk;',
    expression: 'alias.maskLeaf',
  },
  {
    id: 'foreign-computed',
    kind: 'rejected',
    setup: 'const junk = { maskLeaf: (t: unknown) => t };',
    expression: "junk['maskLeaf']",
  },
  { id: 'conditional-both', kind: 'conditional', setup: '', expression: 'flag ? m : m2' },
  {
    // NESTED, because the arm added to `isMaskerArgument` recurses and a single
    // flat case cannot tell a recursive arm from a one-level one.
    id: 'conditional-nested',
    kind: 'conditional',
    setup: '',
    expression: 'flag ? m : flag ? m2 : m',
  },
  {
    id: 'conditional-one-identity',
    kind: 'rejected',
    setup: '',
    expression: 'flag ? m : ((t: string) => t)',
  },
];

const TEMPLATES = ['arg', 'arg-depth', 'callee', 'upstream'] as const;
type TemplateId = (typeof TEMPLATES)[number];

function buildSpellingCase(spelling: Spelling, template: TemplateId): string {
  const body = {
    arg: `return \`got \${JSON.stringify(maskDeep(p, ${spelling.expression}))}\`;`,
    'arg-depth': `return \`got \${JSON.stringify(maskDeep(p, ${spelling.expression}, 1))}\`;`,
    callee: `return \`got \${JSON.stringify((${spelling.expression})(p))}\`;`,
    upstream: `const shown = (${spelling.expression})(p);\n        return \`got \${JSON.stringify(shown)}\`;`,
  }[template];
  return `${MASK_IMPORT}
    class P {
      private maskLeaf(value: unknown, maskSecrets: SecretMasker) {
        return maskDeep(value, maskSecrets);
      }
      run(
        p: Record<string, unknown>,
        m: SecretMasker,
        m2: SecretMasker,
        flag: boolean,
        context?: CreateContext
      ) {
        ${spelling.setup}
        ${body}
      }
    }`;
}

/**
 * The class of a spelling x template cell, derived from the spelling's KIND and
 * the template — never written per cell, so a surprise cannot be silenced one
 * entry at a time.
 */
function spellingClass(kind: SpellingKind, template: TemplateId): ClassName {
  if (kind === 'rejected') return 'none';
  if (kind === 'foreign') {
    // `arg-depth` was already refused by the baseline for the WRONG reason (the
    // trailing `1` is not a masker), so the receiver narrowing changes nothing
    // there and the cell must NOT differ.
    return template === 'arg-depth' ? 'none' : 'receiver-narrowed';
  }
  if (kind === 'conditional') {
    // `callee` / `upstream` put the conditional in CALLEE position, which
    // neither classifier accepts — the arm added is in the masker ARGUMENT.
    return template === 'arg' || template === 'arg-depth' ? 'conditional-masker' : 'none';
  }
  return template === 'arg-depth' ? 'option-argument' : 'none';
}

function poolA(): Cell[] {
  const cells: Cell[] = [];
  for (const spelling of SPELLINGS) {
    for (const template of TEMPLATES) {
      cells.push(
        ...cellsFor(`${spelling.id}--${template}`, buildSpellingCase(spelling, template), () =>
          spellingClass(spelling.kind, template)
        )
      );
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// POOL B — identity ARRANGEMENT x USE site (finding 2)
// ---------------------------------------------------------------------------

interface Arrangement {
  readonly id: string;
  /** Site index bound to the IDENTITY masker; `'all'` when every arm is. */
  readonly identityCell: number | 'all';
  readonly build: (use: (binding: string) => string) => string;
}

const USES: Record<string, (binding: string) => string> = {
  direct: (b) => `return \`x \${JSON.stringify(${b}(p))}\`;`,
  arg: (b) => `return \`x \${JSON.stringify(maskDeep(p, ${b}))}\`;`,
  wrapper: (b) =>
    `const maskLeaf = (v: unknown) => maskDeep(v, ${b});\n        return \`x \${JSON.stringify(maskLeaf(p))}\`;`,
};

const ARRANGEMENTS: readonly Arrangement[] = [
  {
    id: 'sibling-methods',
    identityCell: 1,
    build: (u) => `${MASK_IMPORT}
    class P {
      create(p: Record<string, unknown>, context?: CreateContext) {
        const mask = maskerOrIdentity(context?.maskSecrets);
        ${u('mask')}
      }
      delete(p: Record<string, unknown>) {
        const mask = maskerOrIdentity(undefined);
        ${u('mask')}
      }
    }`,
  },
  {
    id: 'sibling-functions',
    identityCell: 1,
    build: (u) => `${MASK_IMPORT}
    function create(p: Record<string, unknown>, context?: CreateContext) {
      const mask = maskerOrIdentity(context?.maskSecrets);
      ${u('mask')}
    }
    function remove(p: Record<string, unknown>) {
      const mask = maskerOrIdentity(undefined);
      ${u('mask')}
    }`,
  },
  {
    // Declared BELOW its sibling, because the derivation runs two passes and a
    // rule that only worked in source order would pass the arrangement above.
    id: 'identity-first',
    identityCell: 0,
    build: (u) => `${MASK_IMPORT}
    class P {
      delete(p: Record<string, unknown>) {
        const mask = maskerOrIdentity(undefined);
        ${u('mask')}
      }
      create(p: Record<string, unknown>, context?: CreateContext) {
        const mask = maskerOrIdentity(context?.maskSecrets);
        ${u('mask')}
      }
    }`,
  },
  {
    // The CONTROL: a MODULE-scope refusal has no enclosing function, so it must
    // still red every arm. Without it, "scoped" could degrade into "identity
    // bindings stopped counting anywhere" and every accept cell above would
    // still pass.
    id: 'module-identity',
    identityCell: 'all',
    build: (u) => `${MASK_IMPORT}
    const mask = maskerOrIdentity(undefined);
    class P {
      create(p: Record<string, unknown>) { ${u('mask')} }
      delete(p: Record<string, unknown>) { ${u('mask')} }
    }`,
  },
  {
    id: 'nested-arrow',
    identityCell: 1,
    build: (u) => `${MASK_IMPORT}
    class P {
      create(p: Record<string, unknown>, context?: CreateContext) {
        const mask = maskerOrIdentity(context?.maskSecrets);
        ${u('mask')}
      }
      delete(p: Record<string, unknown>) {
        const run = () => {
          const mask = maskerOrIdentity(undefined);
          ${u('mask')}
        };
        return run();
      }
    }`,
  },
];

function poolB(): Cell[] {
  const cells: Cell[] = [];
  for (const arrangement of ARRANGEMENTS) {
    for (const [useId, use] of Object.entries(USES)) {
      cells.push(
        ...cellsFor(`${arrangement.id}--${useId}`, arrangement.build(use), (index) => {
          const isIdentityArm =
            arrangement.identityCell === 'all' || arrangement.identityCell === index;
          if (useId === 'wrapper') {
            // The baseline called EVERY wrapper a mask, whatever it closed
            // over, so the identity arms are the ones that move.
            return isIdentityArm ? 'wrapper-launders-identity' : 'none';
          }
          return isIdentityArm ? 'none' : 'identity-scoped';
        })
      );
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------

function describeCell(cell: Cell): string {
  return `${cell.case}[${cell.index}] ${cell.baseline} -> ${cell.live} (declared ${cell.declared})`;
}

describe('secret-mask recognition — differential against the frozen origin/main classifier', () => {
  const poolACells = poolA();
  const poolBCells = poolB();
  const cells = [...poolACells, ...poolBCells];

  it('the synthetic pool is the FULL cross product, not a handful of cases', () => {
    // EXACT products rather than floors. A floor lets a dropped generator arm
    // slide while the class floors below still pass -- measured during review:
    // deleting the `foreign-spread` spelling landed `receiver-narrowed` exactly
    // on its old floor of 12 and all 18 tests stayed green. A loose coverage
    // guard is the same over-claim as a loose fence.
    expect(SPELLINGS.length).toBe(17);
    expect(TEMPLATES.length).toBe(4);
    expect(ARRANGEMENTS.length).toBe(5);
    expect(Object.keys(USES).length).toBe(3);
    expect(new Set(SPELLINGS.map((spelling) => spelling.id)).size).toBe(SPELLINGS.length);
    expect(new Set(ARRANGEMENTS.map((a) => a.id)).size).toBe(ARRANGEMENTS.length);
    // Pool A is one site per case; pool B is two (the sibling pair).
    expect(poolACells.length).toBe(SPELLINGS.length * TEMPLATES.length);
    expect(poolBCells.length).toBe(ARRANGEMENTS.length * Object.keys(USES).length * 2);
    expect(cells.length).toBe(98);
    // Every spelling KIND is represented, so a whole kind cannot vanish while
    // the arithmetic above is patched back up by adding a sibling of another.
    for (const kind of ['accepted', 'foreign', 'conditional', 'rejected'] as const) {
      expect(
        SPELLINGS.filter((spelling) => spelling.kind === kind).length,
        `no ${kind} spelling left in the pool`
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('every differing cell falls in an enumerated INTENDED class', () => {
    const unenumerated = cells
      .filter((cell) => cell.baseline !== cell.live && cell.declared === 'none')
      .map(describeCell);
    expect(unenumerated, 'a verdict moved with no class claiming it').toEqual([]);
  });

  it('every differing cell shows the transition its class requires', () => {
    const wrong = cells
      .filter((cell) => cell.baseline !== cell.live && cell.declared !== 'none')
      .filter((cell) => `${cell.baseline} -> ${cell.live}` !== INTENDED[cell.declared]?.transition)
      .map(describeCell);
    // Classified by the VALUES observed rather than by what the input looks
    // like: a cell that moved the OTHER way is a different change wearing this
    // class's name.
    expect(wrong, 'a cell moved in the direction its class forbids').toEqual([]);
  });

  it('every cell a class CLAIMS actually differs (the other direction)', () => {
    // A fence that only asks "is the bad input still flagged?" never notices a
    // fix that stopped applying: the cell would simply agree with the baseline
    // and read as "no regression".
    const inert = cells
      .filter((cell) => cell.declared !== 'none' && cell.baseline === cell.live)
      .map(describeCell);
    expect(inert, 'a class claims a cell that no longer moves — the fix went inert').toEqual([]);
  });

  it('each intended class meets its FLOOR of differing cells', () => {
    const observed = new Map<string, number>();
    for (const cell of cells) {
      if (cell.baseline === cell.live || cell.declared === 'none') continue;
      observed.set(cell.declared, (observed.get(cell.declared) ?? 0) + 1);
    }
    const short = Object.entries(INTENDED)
      .filter(([name, spec]) => (observed.get(name) ?? 0) < spec.floor)
      .map(([name, spec]) => `${name}: ${observed.get(name) ?? 0} < ${spec.floor} (${spec.why})`);
    expect(short, 'the pool stopped covering a class, so "no regressions" proves less').toEqual([]);
  });

  it('leaves the REAL provider corpus byte-for-byte identically classified', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir).sort()) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) files.push(full);
      }
    };
    walk(PROVIDERS_DIR);
    files.push(COMPOSITE_ID);

    const differences: string[] = [];
    let sites = 0;
    let masked = 0;
    for (const file of files) {
      const rel = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, 'utf8');
      const before = analyzeBaseline(rel, text).sites;
      const after = analyzeLive(rel, text).sites;
      sites += after.length;
      masked += after.filter((site) => site.verdict === 'masked').length;
      if (before.length !== after.length) {
        differences.push(`${rel}: site count ${before.length} -> ${after.length}`);
        continue;
      }
      for (const [index, site] of after.entries()) {
        const previous = before[index];
        if (previous && previous.verdict !== site.verdict) {
          differences.push(
            `${rel}:${site.line} \`${site.expression}\`: ${previous.verdict} -> ${site.verdict}`
          );
        }
      }
    }
    // The narrowing is only free if it reds nothing real. Stated as ZERO rather
    // than as a class, because a real-tree move is never intended by this
    // change and would need its own calibration.
    expect(differences, 'the recognition change moved a REAL provider site').toEqual([]);
    // FLOORS, so an empty walk cannot report "no differences".
    expect(files.length).toBeGreaterThanOrEqual(80);
    expect(sites).toBeGreaterThanOrEqual(41);
    expect(masked).toBeGreaterThanOrEqual(37);
    // Two full parses of 83 files: ~2 s idle, and measured at 6.5 s while other
    // suites shared the machine, which timed this out at vitest's 5 s default
    // during a review probe. A fence that goes red under load teaches the
    // reader to re-run rather than to read.
  }, 120_000);
});

describe('secret-mask recognition — the findings, asserted directly', () => {
  const verdicts = (source: string): SiteVerdict[] =>
    analyzeLive('probe/case.ts', source).sites.map((site) => site.verdict);

  it('finding 1: a derived masker NAME off a foreign receiver is refused', () => {
    const source = `${MASK_IMPORT}
      class P {
        private maskLeaf(value: unknown, maskSecrets: SecretMasker) {
          return maskDeep(value, maskSecrets);
        }
        run(p: Record<string, unknown>, maskSecrets: SecretMasker) {
          const junk = { maskLeaf: (t: unknown) => t };
          return \`a \${JSON.stringify(junk.maskLeaf(p))} b \${JSON.stringify(maskDeep(p, junk.maskLeaf))} c \${JSON.stringify(this.maskLeaf(p, maskSecrets))}\`;
        }
      }`;
    // The third span is the ACCEPT control: `this` is a receiver the provider
    // owns, so the narrowing must not have reddened it too.
    expect(verdicts(source)).toEqual(['raw', 'raw', 'masked']);
  });

  it('finding 1 keeps KNOWN BOUND (4): the CONTRACT property name is still believed', () => {
    expect(
      verdicts(`${MASK_IMPORT}
        const bag = { maskSecrets: (t: unknown) => t };
        function f(p: Record<string, unknown>) {
          return \`got \${JSON.stringify(maskDeep(p, bag.maskSecrets))}\`;
        }`)
    ).toEqual(['masked']);
  });

  it('finding 2: the unmasked DELETE arm does not red its CREATE sibling', () => {
    expect(
      verdicts(`${MASK_IMPORT}
        class P {
          create(p: Record<string, unknown>, context?: CreateContext) {
            const mask = maskerOrIdentity(context?.maskSecrets);
            return \`c \${JSON.stringify(maskDeep(p, mask))}\`;
          }
          delete(p: Record<string, unknown>) {
            const mask = maskerOrIdentity(undefined);
            return \`d \${JSON.stringify(maskDeep(p, mask))}\`;
          }
        }`)
    ).toEqual(['masked', 'raw']);
  });

  it('finding 3: a bare `logger.warn(JSON.stringify(x))` is COUNTED, not silently dropped', () => {
    const analyzed = analyzeLive(
      'probe/sink.ts',
      `function f(value: unknown, logger: { warn(m: string): void }) {
         logger.warn(JSON.stringify(value));
         throw new ProvisioningError(JSON.stringify(value));
       }`
    );
    expect(analyzed.sites).toEqual([]);
    expect(analyzed.bareSinkSites).toBe(2);
  });

  it('finding 3 stays scoped to a SINK: the real tree has two non-sink bare stringifies', () => {
    const analyzed = analyzeLive(
      'probe/nonsink.ts',
      `function f(value: unknown, client: { update(x: string): void }) {
         client.update(JSON.stringify(value));
         return Buffer.from(JSON.stringify(value));
       }`
    );
    expect(analyzed.bareSinkSites).toBe(0);
  });

  it('finding 3: the RECEIVER half of the sink test is fenced on its own', () => {
    // `Buffer.from` / `client.update` above reject on the METHOD name, so they
    // never reach the receiver check — measured: making that check accept any
    // receiver left all 91 assertions green. A level-named method on a
    // non-logger receiver is the case that reaches it.
    const analyzed = analyzeLive(
      'probe/level-named-nonlogger.ts',
      `function f(value: unknown, metrics: { warn(m: string): void }, report: { error(m: string): void }) {
         metrics.warn(JSON.stringify(value));
         report.error(JSON.stringify(value));
       }`
    );
    expect(analyzed.bareSinkSites).toBe(0);

    const real = analyzeLive(
      'probe/real-logger.ts',
      `function f(value: unknown, logger: { warn(m: string): void }) {
         logger.warn(JSON.stringify(value));
       }`
    );
    expect(real.bareSinkSites).toBe(1);
  });

  it('nit 1: a trailing CONSTANT option does not unmask, but index 1 is still required', () => {
    expect(
      verdicts(`${MASK_IMPORT}
        function f(p: Record<string, unknown>, m: SecretMasker, opts: unknown) {
          return \`a \${JSON.stringify(maskDeep(p, m, 1))} b \${JSON.stringify(maskDeep(p, undefined))} c \${JSON.stringify(maskDeep(p, m, opts))}\`;
        }`)
    ).toEqual(['masked', 'raw', 'raw']);
  });

  it('nit 1 TWIN: the wrapper carries its OWN option guard, and it is fenced', () => {
    // The trailing-constant allowance exists TWICE -- in `isMasked` (pinned by
    // the case above) and in `wrapsFirstParameter`. Only the first was fenced,
    // so relaxing the second to reach index 1 left all 92 tests green while
    // `const maskLeaf = (v) => maskDeep(v, undefined)` became a masker: a
    // wrapper laundering a no-op, the issue go-to-k/cdkd#2007 class this whole
    // change exists to refuse. Every value the guard's offset reaches is
    // covered -- `undefined`, `null`, the inline spelling -- plus the accept
    // control that stops the fix degrading into "no extra argument allowed".
    expect(
      verdicts(`${MASK_IMPORT}
        function f(p: Record<string, unknown>) {
          const maskLeaf = (v: unknown): unknown => maskDeep(v, undefined);
          return \`got \${JSON.stringify(maskLeaf(p))}\`;
        }`)
    ).toEqual(['raw']);
    expect(
      verdicts(`${MASK_IMPORT}
        function f(p: Record<string, unknown>) {
          const maskLeaf = (v: unknown): unknown => maskDeep(v, null);
          return \`got \${JSON.stringify(maskLeaf(p))}\`;
        }`)
    ).toEqual(['raw']);
    expect(
      verdicts(`${MASK_IMPORT}
        function refuse(input: unknown, maskValue: (v: unknown) => unknown = (v) => v) {
          throw new Error(\`unsupported \${JSON.stringify(maskValue(input))}\`);
        }
        function caller(value: unknown) {
          refuse(value, (v: unknown) => maskDeep(v, undefined));
        }`)
    ).toEqual(['raw']);
    expect(
      verdicts(`${MASK_IMPORT}
        function f(p: Record<string, unknown>, m: SecretMasker) {
          const maskLeaf = (v: unknown): unknown => maskDeep(v, m, 1);
          return \`got \${JSON.stringify(maskLeaf(p))}\`;
        }`)
    ).toEqual(['masked']);
  });

  it('finding 3 TWIN: a FACTORY throw and a CHAINED logger receiver are counted', () => {
    // The corpus throws 33 messages through `this.wrapError(...)` /
    // `this.wrapUpdateError(...)`, which the first cut of bound (5) could not
    // see because `isErrorConstructor` required `new`; and
    // `getLogger().child('SNSTopicProvider').warn(...)` puts a CallExpression in
    // the receiver position, where the first receiver reader produced
    // `undefined`. Both ran at exit 0 with `bareSinkSites` reporting zero.
    const factory = analyzeLive(
      'probe/factory.ts',
      `class P {
         private wrapError(message: string): Error { return new Error(message); }
         private wrapUpdateError(message: string): Error { return new Error(message); }
         a(value: unknown): never { throw this.wrapError(JSON.stringify(value)); }
         b(value: unknown): never { throw this.wrapUpdateError(JSON.stringify(value)); }
       }`
    );
    expect(factory.bareSinkSites).toBe(2);

    const chained = analyzeLive(
      'probe/chained.ts',
      `declare function getLogger(): { child(n: string): { warn(m: string): void } };
       function f(value: unknown, options: { warn(m: string): void }) {
         getLogger().child('SNSTopicProvider').warn(JSON.stringify(value));
         options.warn(JSON.stringify(value));
       }`
    );
    expect(chained.bareSinkSites).toBe(2);

    // The refuse twin for the FACTORY arm: it matches by NAME, so a name
    // outside the set must not be swept in.
    const notAFactory = analyzeLive(
      'probe/not-a-factory.ts',
      `class P {
         private buildPayload(message: string): string { return message; }
         run(value: unknown): string { return this.buildPayload(JSON.stringify(value)); }
       }`
    );
    expect(notAFactory.bareSinkSites).toBe(0);
  });

  it('finding 3 COUNTER-DIRECTION: a MASKED bare sink is correct code and is not counted', () => {
    // The false positive the widening opened, measured in review: a factory
    // throw whose value already reached the project's masker is CORRECT, and
    // failing CI over it is worse than the miss the widening replaced -- the
    // remedy the next author reaches for is to work AROUND the fence. Both
    // directions, and both sink FORMS, so the fix cannot degrade into "nothing
    // is ever counted".
    const maskedFactory = analyzeLive(
      'probe/masked-factory.ts',
      `${MASK_IMPORT}
       class P {
         private wrapError(message: string): Error { return new Error(message); }
         run(value: unknown, maskSecrets: SecretMasker): never {
           throw this.wrapError(JSON.stringify(maskDeep(value, maskSecrets)));
         }
       }`
    );
    expect(maskedFactory.bareSinkSites).toBe(0);

    const rawFactory = analyzeLive(
      'probe/raw-factory.ts',
      `class P {
         private wrapError(message: string): Error { return new Error(message); }
         run(properties: Record<string, unknown>): never {
           throw this.wrapError(JSON.stringify(properties));
         }
       }`
    );
    expect(rawFactory.bareSinkSites).toBe(1);
    expect(rawFactory.bareSinkLocations).toEqual(['probe/raw-factory.ts:4 (error factory)']);

    const maskedLogger = analyzeLive(
      'probe/masked-logger.ts',
      `${MASK_IMPORT}
       function f(value: unknown, maskSecrets: SecretMasker, logger: { warn(m: string): void }) {
         logger.warn(JSON.stringify(maskDeep(value, maskSecrets)));
       }`
    );
    expect(maskedLogger.bareSinkSites).toBe(0);

    const rawLogger = analyzeLive(
      'probe/raw-logger.ts',
      `function f(properties: Record<string, unknown>, logger: { warn(m: string): void }) {
         logger.warn(JSON.stringify(properties));
       }`
    );
    expect(rawLogger.bareSinkSites).toBe(1);
    expect(rawLogger.bareSinkLocations).toEqual(['probe/raw-logger.ts:2 (logger call)']);
  });

  it('finding 3: the failure LOCATES the site and names the form the author wrote', () => {
    // Same argument as `truncatedFiles`: a bare count over an 83-file corpus
    // names nothing, and after the factory arm landed the message could name a
    // spelling that is not in the file at all.
    const analyzed = analyzeLive(
      'probe/forms.ts',
      `class P {
         private wrapDeleteError(message: string): Error { return new Error(message); }
         a(p: Record<string, unknown>, logger: { warn(m: string): void }) {
           logger.warn(JSON.stringify(p));
         }
         b(p: Record<string, unknown>): never { throw this.wrapDeleteError(JSON.stringify(p)); }
         c(p: Record<string, unknown>): never { throw new ProvisioningError(JSON.stringify(p)); }
       }`
    );
    expect(analyzed.bareSinkLocations).toEqual([
      'probe/forms.ts:4 (logger call)',
      'probe/forms.ts:6 (error factory)',
      'probe/forms.ts:7 (error constructor)',
    ]);
  });

  it('finding 3: a CAST argument does not smuggle a bare sink past the counter', () => {
    // `bareMessageSinkForm` walked up through parentheses only, while
    // `unwrap` strips casts everywhere else in this file.
    const cast = analyzeLive(
      'probe/cast.ts',
      `function f(p: Record<string, unknown>, logger: { warn(m: string): void }) {
         logger.warn(JSON.stringify(p) as string);
       }`
    );
    expect(cast.bareSinkSites).toBe(1);
    // ...and the masked twin still is not counted, so the cast fix did not
    // reintroduce the false positive one level in.
    const maskedCast = analyzeLive(
      'probe/cast-masked.ts',
      `${MASK_IMPORT}
       function f(p: Record<string, unknown>, m: SecretMasker, logger: { warn(x: string): void }) {
         logger.warn(JSON.stringify(maskDeep(p, m)) as string);
       }`
    );
    expect(maskedCast.bareSinkSites).toBe(0);
  });

  it('nit 2: a `?:` masker argument needs BOTH arms', () => {
    expect(
      verdicts(`${MASK_IMPORT}
        function f(p: Record<string, unknown>, a: SecretMasker, b: SecretMasker, flag: boolean) {
          return \`x \${JSON.stringify(maskDeep(p, flag ? a : b))} y \${JSON.stringify(maskDeep(p, flag ? a : ((t: string) => t)))}\`;
        }`)
    ).toEqual(['masked', 'raw']);
  });

  it('nit 3: a masker set that does not converge is REPORTED, not swallowed', () => {
    // Every real file converges, so the signal is asserted in its healthy
    // state; the failure arm is exercised by the entrypoint test below.
    const analyzed = analyzeLive(
      'probe/converge.ts',
      `${MASK_IMPORT}
       function f(p: Record<string, unknown>, m: SecretMasker) {
         return \`got \${JSON.stringify(maskDeep(p, m))}\`;
       }`
    );
    expect(analyzed.fixpointTruncated).toBe(false);
  });
});

/**
 * Every `throw <call>(...)` callee in the scanned corpus must be a name the
 * bound-(5) matcher KNOWS — either as an error factory, or as an audited
 * not-a-factory.
 *
 * The completeness guard the factory NAME set could not give itself. Review
 * measured `throw this.wrapDeleteError(JSON.stringify(v))` escaping the set
 * entirely, which is the same shape the round had just finished fixing: a
 * spelling outside the matcher while the prose calls the measured zero honest.
 * A `^wrap[A-Za-z]*Error$` pattern closes today's escape; only an ENUMERATION
 * keeps the zero honest as the corpus grows, because it fails on a name nobody
 * predicted rather than on the ones somebody did.
 */
const NOT_A_MESSAGE_FACTORY: ReadonlyMap<string, string> = new Map([
  [
    'markNonRetryable',
    'marks an EXISTING error object non-retryable; its argument is that error, never a message',
  ],
  [
    'onInterrupted',
    "the interrupt watch's own error builder; it takes no caller-supplied message",
  ],
]);

describe('secret-mask recognition — the bound (5) factory set is COMPLETE, not just current', () => {
  /** Callee name of every `throw <call>(...)` under the scanned corpus. */
  function thrownCallCallees(): Map<string, number> {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir).sort()) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) files.push(full);
      }
    };
    walk(PROVIDERS_DIR);
    files.push(COMPOSITE_ID);

    const callees = new Map<string, number>();
    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      const visit = (node: ts.Node): void => {
        if (ts.isThrowStatement(node) && node.expression && ts.isCallExpression(node.expression)) {
          const callee = node.expression.expression;
          const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
              ? callee.name.text
              : undefined;
          if (name !== undefined) callees.set(name, (callees.get(name) ?? 0) + 1);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return callees;
  }

  it('knows every `throw <call>(...)` callee the corpus actually spells', () => {
    const callees = thrownCallCallees();
    // Population floor: "found nothing" and "everything is known" are the same
    // green otherwise, which is the vacuous pass this whole file exists against.
    expect(callees.size).toBeGreaterThanOrEqual(3);
    expect([...callees.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(30);
    expect(callees.has('wrapError'), 'the corpus stopped spelling `wrapError`').toBe(true);

    const unknown = [...callees]
      .filter(([name]) => !isErrorFactoryName(name) && !NOT_A_MESSAGE_FACTORY.has(name))
      .map(([name, count]) => `${name} (${count} throw site(s))`);
    expect(
      unknown,
      'a `throw <call>(...)` callee the bound (5) matcher does not know: either it builds a ' +
        'message (add it to MESSAGE_SINK_FACTORIES, or make it match `wrap<X>Error`) or it does ' +
        'not (add it to NOT_A_MESSAGE_FACTORY with the reason)'
    ).toEqual([]);
  });

  it('re-audits the not-a-factory list, so an entry cannot outlive its reason', () => {
    const callees = thrownCallCallees();
    const stale = [...NOT_A_MESSAGE_FACTORY.keys()].filter((name) => !callees.has(name));
    // Same discipline as `auditExemptions`: an entry nobody re-checks goes inert
    // exactly when it stops being needed, and then hides the next real one.
    expect(stale, 'a not-a-factory entry names a callee the corpus no longer throws').toEqual([]);
    // ...and it must not overlap the factory predicate, or one of the two is wrong.
    expect([...NOT_A_MESSAGE_FACTORY.keys()].filter((name) => isErrorFactoryName(name))).toEqual([]);
  });

  it('records the bound the enumeration leaves open, with its measured population', () => {
    // The counter accepts a factory in ANY position, while the enumeration
    // above walks only `throw <call>(...)`. Both halves are pinned so the
    // stated bound cannot quietly stop being true.
    const nonThrow = analyzeLive(
      'probe/factory-non-throw.ts',
      `class P {
         private wrapDeleteError(m: string): Error { return new Error(m); }
         run(p: Record<string, unknown>) { const e = this.wrapDeleteError(JSON.stringify(p)); return e; }
       }`
    );
    expect(nonThrow.bareSinkSites).toBe(1);

    // ...and the escape the bound names: an unknown factory in NON-throw
    // position is seen by neither the name set nor the enumeration.
    const escapes = analyzeLive(
      'probe/unknown-factory-non-throw.ts',
      `declare function buildError(m: string): Error;
       function f(p: Record<string, unknown>) { const e = buildError(JSON.stringify(p)); return e; }`
    );
    expect(escapes.bareSinkSites).toBe(0);

    // The measured population that makes the escape empty TODAY: the corpus
    // has exactly two calls taking a bare `JSON.stringify` outside the sink
    // set, and neither builds a message. Re-derived here rather than quoted,
    // so the bound's "measured zero" fails if the corpus grows a third.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir).sort()) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) files.push(full);
      }
    };
    walk(PROVIDERS_DIR);
    files.push(COMPOSITE_ID);

    const nonSinkCallees: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          for (const argument of node.arguments) {
            if (
              ts.isCallExpression(argument) &&
              argument.expression.getText(source).replace(/\s+/g, '') === 'JSON.stringify'
            ) {
              nonSinkCallees.push(node.expression.getText(source).replace(/\s+/g, ''));
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(nonSinkCallees.sort()).toEqual(["Buffer.from", "createHash('sha256').update"]);
  });

  it('the factory predicate accepts a `wrap<X>Error` nobody listed, and refuses a near-miss', () => {
    expect(isErrorFactoryName('wrapError')).toBe(true);
    expect(isErrorFactoryName('wrapUpdateError')).toBe(true);
    expect(isErrorFactoryName('wrapDeleteError')).toBe(true);
    expect(isErrorFactoryName('handleError')).toBe(true);
    // The refuse side: the pattern is anchored, so neither a prefix nor a suffix
    // neighbour is swept in.
    expect(isErrorFactoryName('unwrapError')).toBe(false);
    expect(isErrorFactoryName('wrapErrorMessage')).toBe(false);
    expect(isErrorFactoryName('wrap')).toBe(false);
    expect(isErrorFactoryName('fail')).toBe(false);
  });
});

describe('secret-mask recognition — the two wrapper spellings cannot drift apart', () => {
  const SCRIPT_TEXT = readFileSync(
    join(REPO_ROOT, 'scripts/check-provider-secret-mask.ts'),
    'utf8'
  );

  /** The `ts.isX(...)` guards inside one top-level function's body. */
  function guardsOf(name: string): Set<string> {
    const start = SCRIPT_TEXT.indexOf(`function ${name}(`);
    expect(start, `no \`function ${name}(\` in the script`).toBeGreaterThan(-1);
    // Body runs to the first line that is exactly `}` — every function here is
    // top-level, so column zero terminates it.
    const end = SCRIPT_TEXT.indexOf('\n}\n', start);
    expect(end, `no terminator found for \`${name}\``).toBeGreaterThan(start);
    const body = SCRIPT_TEXT.slice(start, end);
    return new Set([...body.matchAll(/ts\.is([A-Za-z]+)\(/g)].map((m) => m[1] as string));
  }

  it('`isTransparentWrapper` accepts exactly the node kinds `unwrap` strips', () => {
    // One question asked from two directions — "strip this node's wrapper" and
    // "is my parent a wrapper". A divergence between two spellings of one
    // question is this repo's recurring defect, and the cast escape the parent-
    // chain predicate exists to close WAS that divergence: `unwrap` stripped
    // five wrappers while the parent walk understood one. Nothing asserted the
    // two agreed, so a sixth wrapper added to `unwrap` later would re-open the
    // hole silently.
    const stripped = guardsOf('unwrap');
    const tested = guardsOf('isTransparentWrapper');
    // Floors first: a regex that matched nothing would make the equality below
    // trivially true, which is the vacuous pass this file exists against.
    expect(stripped.size).toBeGreaterThanOrEqual(5);
    expect(tested.size).toBeGreaterThanOrEqual(5);
    expect([...tested].sort()).toEqual([...stripped].sort());
    // ...and the set is the one we think it is, so BOTH drifting together in
    // the same direction is still caught.
    expect([...stripped].sort()).toEqual([
      'AsExpression',
      'NonNullExpression',
      'ParenthesizedExpression',
      'SatisfiesExpression',
      'TypeAssertionExpression',
    ]);
  });

  it('each wrapper spelling is live-probed through the counter, not only compared', () => {
    // The source-level equality above cannot see a guard that is present but
    // unreachable. Every spelling `unwrap` strips must actually let a bare sink
    // through to the counter.
    const spellings: [string, string][] = [
      ['parenthesized', '(JSON.stringify(p))'],
      ['as-cast', 'JSON.stringify(p) as string'],
      ['non-null', 'JSON.stringify(p)!'],
      ['angle-cast', '<string>JSON.stringify(p)'],
      ['satisfies', 'JSON.stringify(p) satisfies string'],
    ];
    for (const [name, expression] of spellings) {
      const analyzed = analyzeLive(
        `probe/wrapper-${name}.ts`,
        `function f(p: Record<string, unknown>, logger: { warn(m: string): void }) {
           logger.warn(${expression});
         }`
      );
      expect(analyzed.bareSinkSites, `${name} escaped the bare-sink counter`).toBe(1);
    }
  });

  it('`isTransparentWrapper` refuses a node kind that is NOT a wrapper', () => {
    // The refuse side: without it the predicate could degrade to `return true`
    // and every assertion above would still pass.
    const source = ts.createSourceFile(
      'probe/not-a-wrapper.ts',
      'const x = f(1);',
      ts.ScriptTarget.Latest,
      true
    );
    const statement = source.statements[0]!;
    expect(isTransparentWrapper(statement)).toBe(false);
    expect(isTransparentWrapper(source)).toBe(false);
  });
});

describe('secret-mask recognition — the remaining issue #2269 nits', () => {
  it('nit 4: containment is on a path SEGMENT boundary, not a string prefix', () => {
    // `/…/cdkd-scratch/x.ts` starts with `/…/cdkd`, and the branch this feeds
    // decides whether a site is reported under its repo-relative path or
    // re-rooted under the providers root — which is the string `EXEMPT` is
    // keyed on. A prefix match there mints keys no entry can ever match.
    expect(isInsideDirectory('/repo/cdkd', '/repo/cdkd/src/a.ts')).toBe(true);
    expect(isInsideDirectory('/repo/cdkd', '/repo/cdkd')).toBe(true);
    expect(isInsideDirectory('/repo/cdkd', '/repo/cdkd-scratch/src/a.ts')).toBe(false);
    expect(isInsideDirectory('/repo/cdkd', '/repo/cdkdx.ts')).toBe(false);
    expect(isInsideDirectory('/repo/cdkd/', '/repo/cdkd/src/a.ts')).toBe(true);
    // A path that LEAVES the root is not inside it. Unreachable from the two
    // call sites (both pass resolved paths), but the function is EXPORTED and
    // the claim above is about a path SEGMENT boundary, which a raw prefix
    // compare cannot make.
    expect(isInsideDirectory('/repo/cdkd', '/repo/cdkd/../evil/a.ts')).toBe(false);
    expect(isInsideDirectory('/repo/cdkd', '/repo/cdkd/src/../../evil/a.ts')).toBe(false);
    expect(isInsideDirectory('/repo/cdkd', '/repo/cdkd/src/../a.ts')).toBe(true);
    // ...and it agrees with itself about a directory containing itself however
    // the caller spelled the root.
    expect(isInsideDirectory('/repo/cdkd/', '/repo/cdkd')).toBe(true);
    expect(isInsideDirectory('/repo/cdkd', '/repo/cdkd/')).toBe(true);
  });

  it('nit 3: an unconverged masker set is REPORTED, and used to be silently wrong', () => {
    // A chain of locally declared wrappers, each declared ABOVE the one it
    // depends on, so growth advances exactly one link per round. At eleven
    // links the ten-round cap bites: the verdict is `raw` — WRONG, since every
    // link does reach the shared walk — and before this change nothing said so.
    const chain = (links: number): string => {
      const declarations: string[] = [];
      for (let i = links; i >= 2; i -= 1) {
        declarations.push(`  const w${i} = (v: unknown): unknown => w${i - 1}(v);`);
      }
      declarations.push('  const w1 = (v: unknown): unknown => maskDeep(v, m);');
      return `import { maskDeep } from '../masked-retry-logger.js';
function f(p: Record<string, unknown>, m: SecretMasker) {
${declarations.join('\n')}
  return \`got \${JSON.stringify(w${links}(p))}\`;
}`;
    };

    const converging = analyzeLive('probe/chain-9.ts', chain(9));
    expect(converging.fixpointTruncated).toBe(false);
    expect(converging.sites.map((site) => site.verdict)).toEqual(['masked']);

    const truncated = analyzeLive('probe/chain-11.ts', chain(11));
    expect(truncated.fixpointTruncated).toBe(true);
    // The signal, not the verdict, is the deliverable: the verdict is allowed
    // to be wrong here (fail-closed), and the point is that it no longer is
    // wrong SILENTLY.
    expect(truncated.sites.map((site) => site.verdict)).toEqual(['raw']);
  });

  it('nit 5: a scan failure still prints the FAILED block it used to share', () => {
    // The dead `report?.filesScanned` went away by making the scan-failure path
    // return through one shared reporter. That refactor could have dropped the
    // header or the exit code; both are pinned here.
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk) => {
      stderr.push(String(chunk));
      return true;
    };
    let status: number;
    try {
      status = main([`--providers-dir=${join(REPO_ROOT, 'no-such-providers-dir-2269')}`], () => ({
        failures: [],
        ran: 99,
      }));
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    const text = stderr.join('');
    expect(status).toBe(1);
    expect(text).toContain('provider secret-mask check FAILED');
    expect(text).toContain('no-such-providers-dir-2269');
  });
});
