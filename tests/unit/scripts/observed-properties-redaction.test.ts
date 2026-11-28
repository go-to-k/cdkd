/**
 * `scripts/check-observed-properties-redaction.ts` (go-to-k/cdkd#6765). The
 * real-tree case IS the enforcement: a new writer of `observedProperties`
 * whose value does not come from the state redaction (or from a bag already
 * in state) fails it, wherever the value was built.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

import {
  CARRIERS,
  EXEMPTIONS,
  REDACTORS,
  analyzeFiles,
  checkAll,
  judgeSites,
  type Site,
} from '../../../scripts/check-observed-properties-redaction.ts';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.ts';
import {
  carryRedactionMarks,
  keepTemplateLiteralLeaves,
  markSameGenerationBag,
  maskReadbackAtCoordinates,
  redactForState,
} from '../../../src/deployment/secret-redaction.js';
import { redactAtProvenance } from '../../../src/deployment/secret-redaction/context.js';
import { redactSecretsForState } from '../../../src/deployment/secret-redaction/redact-state.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** A stand-in redaction family, so a synthetic file can import from it. */
const FAMILY = [
  'export function redactForState<T>(bag: T, _context: unknown): T { return bag; }',
  'export function scrubResourceRecord<T>(record: T, ..._rest: unknown[]): T { return record; }',
  'export function markSameGenerationBag<T>(bag: T): T { return bag; }',
  'export function carryRedactionMarks<T>(_from: unknown, to: T): T { return to; }',
].join('\n');

const IMPORT =
  "import { redactForState, scrubResourceRecord, carryRedactionMarks } from './deployment/secret-redaction.js';\n";

function sites(body: string, withImport = true): Site[] {
  return analyzeFiles(
    new Map([
      ['src/deployment/secret-redaction.ts', FAMILY],
      ['src/x.ts', (withImport ? IMPORT : '') + body],
    ])
  ).filter((s) => s.file === 'src/x.ts');
}

/** `<kind>:ok` or `<kind>:raw` per write site. */
/** Verdicts for `src/x.ts` among several files (a caller in another file). */
function verdictsAcross(extra: Record<string, string>, body: string): string[] {
  return analyzeFiles(
    new Map([
      ['src/deployment/secret-redaction.ts', FAMILY],
      ['src/x.ts', IMPORT + body],
      ...Object.entries(extra),
    ])
  )
    .filter((s) => s.file === 'src/x.ts')
    .map((s) => `${s.kind}:${s.raw.length === 0 ? 'ok' : 'raw'}`);
}

const verdicts = (body: string, withImport = true): string[] =>
  sites(body, withImport).map((s) => `${s.kind}:${s.raw.length === 0 ? 'ok' : 'raw'}`);

describe('check-observed-properties-redaction (go-to-k/cdkd#6765)', () => {
  it(
    'the real tree: every observedProperties writer takes a redacted or stored value',
    () => {
      const { failures, scan } = checkAll();
      expect(failures).toEqual([]);
      // Each writer #6765 names is in the population.
      for (const file of [
        'src/deployment/deploy-engine/observed-capture.ts',
        'src/cli/commands/drift/accept.ts',
        'src/cli/commands/drift/revert.ts',
        'src/deployment/deploy-engine/noecho.ts',
        'src/deployment/ssm-slashed-name-heal.ts',
      ]) {
        expect(scan.sites.some((s) => s.file === file)).toBe(true);
      }
    },
    CONTENDED_CASE_TIMEOUT_MS
  );

  it('the drain exemption: the deploy engine still saves through the persist choke point', () => {
    expect(EXEMPTIONS.map((e) => `${e.file}#${e.fn}`)).toEqual([
      'src/deployment/deploy-engine/observed-capture.ts#drainObservedCaptures',
      'src/cli/commands/scrub/twin-references.ts#withObservedTwinsPositioned',
    ]);
    const engine = readFileSync(join(REPO_ROOT, 'src/deployment/deploy-engine.ts'), 'utf8');
    expect(engine).toContain('return redactStateForPersist.call(this, state);');
    const persist = readFileSync(join(REPO_ROOT, 'src/deployment/deploy-engine/state-persist.ts'), 'utf8');
    expect(persist).toContain('this.redactStateForPersist(state)');
    expect(persist).toContain('scrubResourceRecord(');
  });

  it('the scrub twin exemption: it runs over the redacted bag, and writes only a proven leaf', () => {
    const rewrite = readFileSync(join(REPO_ROOT, 'src/cli/commands/scrub/stack-rewrite.ts'), 'utf8');
    expect(rewrite.replace(/\s+/g, ' ')).toContain('withObservedTwinsPositioned( scrubResourceRecord(positioned,');
    const twins = readFileSync(join(REPO_ROOT, 'src/cli/commands/scrub/twin-references.ts'), 'utf8');
    expect(twins).toContain('return provenTemplateText(s, t, secrets, plaintexts) ? t : p;');
    expect(twins).toContain('if (!corroborates(s[i], t[i])) return item;');
  });

  describe('roots', () => {
    it('passes a redactor, a stored bag, a physical id and a literal', () => {
      expect(
        verdicts(`
export function f(rec: any, other: any, read: () => unknown) {
  rec.observedProperties = redactForState(read(), {});
  rec.observedProperties = other.observedProperties;
  rec.observedProperties = { ...rec.observedProperties, Name: rec.physicalId };
  rec.observedProperties = undefined;
}`)
      ).toEqual(['assignment:ok', 'assignment:ok', 'assignment:ok', 'assignment:ok']);
    });

    it('fails a readback written directly, in every write shape', () => {
      expect(
        verdicts(`
export function f(rec: any, read: () => any) {
  rec.observedProperties = read();
  rec.observedProperties ??= read();
  rec['observedProperties'] = read();
  const observedProperties = read();
  return { ...rec, observedProperties, other: { observedProperties: read() } };
}`)
      ).toEqual(['assignment:raw', 'assignment:raw', 'assignment:raw', 'shorthand:raw', 'property:raw']);
    });

    it('a redactor counts only as the family function of that name', () => {
      // A same-named local, and an import renamed onto the name.
      expect(
        verdicts(
          `
function redactForState(v: unknown, _c: unknown) { return v; }
export function f(rec: any, read: () => unknown) { rec.observedProperties = redactForState(read(), {}); }`,
          false
        )
      ).toEqual(['assignment:raw']);
      expect(
        verdicts(
          `
import { markSameGenerationBag as redactForState } from './deployment/secret-redaction.js';
export function f(rec: any, read: () => unknown) { rec.observedProperties = redactForState(read(), {}); }`,
          false
        )
      ).toEqual(['assignment:raw']);
    });

    it('a carrier is followed into the argument it carries', () => {
      expect(
        verdicts(`
export function f(rec: any, read: () => object) {
  rec.observedProperties = carryRedactionMarks(read(), rec.observedProperties);
  rec.observedProperties = carryRedactionMarks(rec.observedProperties, read());
}`)
      ).toEqual(['assignment:ok', 'assignment:raw']);
    });

    it('an object literal handed straight to scrubResourceRecord is a redaction input', () => {
      expect(
        verdicts(`
export function f(read: () => unknown) {
  return scrubResourceRecord({ properties: {}, observedProperties: read() }).observedProperties;
}`)
      ).toEqual(['property:ok']);
      // Only as the call's own argument: a literal bound first is a write site.
      expect(
        verdicts(`
export function f(read: () => unknown) {
  const input = { properties: {}, observedProperties: read() };
  return scrubResourceRecord(input);
}`)
      ).toEqual(['property:raw']);
    });

    it('the baseline idiom takes the same record\'s properties, and no other', () => {
      expect(
        verdicts(`
export function f(rec: any, other: any) { other.observedProperties = rec.observedProperties ?? rec.properties; }`)
      ).toEqual(['assignment:ok']);
      expect(
        verdicts(`
export function f(rec: any, other: any) { other.observedProperties = rec.observedProperties ?? other.properties; }`)
      ).toEqual(['assignment:raw']);
    });
  });

  describe('helpers and callbacks', () => {
    it('follows a helper into its returns, its parameters bound to the call', () => {
      expect(
        verdicts(`
function clean(v: unknown) { return redactForState(v, {}); }
function pass(v: unknown) { return v; }
export function f(rec: any, read: () => unknown) {
  rec.observedProperties = clean(read());
  rec.observedProperties = pass(rec.observedProperties);
  rec.observedProperties = pass(read());
}`)
      ).toEqual(['assignment:ok', 'assignment:ok', 'assignment:raw']);
    });

    it('follows a callback a helper calls', () => {
      expect(
        verdicts(`
function within<T>(run: () => T): T { return run(); }
export function f(rec: any, read: () => unknown) {
  rec.observedProperties = within(() => redactForState(read(), {}));
  rec.observedProperties = within(() => read());
}`)
      ).toEqual(['assignment:ok', 'assignment:raw']);
    });

    it('fails a callback parameter outside map / flatMap, and follows those', () => {
      expect(
        verdicts(`
export function f(recs: any[], read: () => unknown[]) {
  read().forEach((r) => { recs[0].observedProperties = r; });
  recs.map((r) => ({ ...r, observedProperties: r.observedProperties }));
}`)
      ).toEqual(['assignment:raw', 'property:ok']);
    });

    it('moves a rendered parameter to every caller', () => {
      const put = 'function put(rec: any, bag: unknown) { rec.observedProperties = bag; }\n';
      expect(
        verdicts(
          put +
            'export function f(rec: any, read: () => unknown) { put(rec, redactForState(read(), {})); put(rec, rec.observedProperties); }'
        )
      ).toEqual(['assignment:ok']);
      // One raw caller keeps it raw.
      expect(
        verdicts(
          put +
            'export function f(rec: any, read: () => unknown) { put(rec, redactForState(read(), {})); put(rec, read()); }'
        )
      ).toEqual(['assignment:raw']);
      // A function also passed as a value has callers the critic cannot see.
      expect(
        verdicts(put + 'export const table = { put };\nexport function f(rec: any) { put(rec, rec.observedProperties); }')
      ).toEqual(['assignment:raw']);
    });

    it('follows what a helper writes into an accumulator parameter', () => {
      const collect = 'function collect(v: unknown, out: unknown[] = []) { out.push(v); return out; }\n';
      expect(
        verdicts(collect + 'export function f(rec: any, read: () => unknown) { rec.observedProperties = collect(redactForState(read(), {})); }')
      ).toEqual(['assignment:ok']);
      expect(
        verdicts(collect + 'export function f(rec: any, read: () => unknown) { rec.observedProperties = collect(read()); }')
      ).toEqual(['assignment:raw']);
    });

    it('reads a destructured parameter at its own member', () => {
      const g = 'function g(args: { a: unknown; b: unknown }) { const { a } = args; return a; }\n';
      expect(
        verdicts(g + 'export function f(rec: any, read: () => unknown) { rec.observedProperties = g({ a: rec.observedProperties, b: read() }); }')
      ).toEqual(['assignment:ok']);
      expect(
        verdicts(g + 'export function f(rec: any, read: () => unknown) { rec.observedProperties = g({ a: read(), b: rec.observedProperties }); }')
      ).toEqual(['assignment:raw']);
    });

    it('takes a branch fact from the site into the value it reads', () => {
      const body = (guarded: boolean): string => `
export function f(rec: any, has: boolean, read: () => unknown) {
  const base = has ? rec.observedProperties : read();
  ${guarded ? 'if (has) ' : ''}rec.observedProperties = base;
}`;
      expect(verdicts(body(true))).toEqual(['assignment:ok']);
      expect(verdicts(body(false))).toEqual(['assignment:raw']);
    });
  });

  describe('writes into a followed container', () => {
    it('follows later writes into a local, and a registered mutator', () => {
      expect(
        verdicts(`
declare function defineOwnKey(o: object, k: string, v: unknown): void;
export function f(rec: any, read: () => unknown) {
  const a: Record<string, unknown> = {};
  a.x = read();
  rec.observedProperties = a;
  const b: Record<string, unknown> = {};
  defineOwnKey(b, 'x', read());
  rec.observedProperties = b;
  const c: Record<string, unknown> = {};
  c.x = redactForState(read(), {});
  rec.observedProperties = c;
}`)
      ).toEqual(['assignment:raw', 'assignment:raw', 'assignment:ok']);
    });

    it('follows a container into the function it escapes to, and under a property name', () => {
      const tail =
        '\nexport function f(rec: any, read: () => unknown) {\n  const m = new Map<string, unknown>();\n  CALL;\n  for (const [, v] of m) rec.observedProperties = v;\n}';
      const fill = (value: string): string =>
        `function fill(m: Map<string, unknown>, read: () => unknown) { m.set('a', ${value}); }` +
        tail.replace('CALL', 'fill(m, read)');
      expect(verdicts(fill('read()'))).toEqual(['assignment:raw']);
      expect(verdicts(fill('redactForState(read(), {})'))).toEqual(['assignment:ok']);
      expect(
        verdicts(
          "function fill(ctx: { m: Map<string, unknown> }, read: () => unknown) { ctx.m.set('a', read()); }" +
            tail.replace('CALL', 'fill({ m }, read)')
        )
      ).toEqual(['assignment:raw']);
      // A logger only reads it; a call the critic cannot follow may write anything into it.
      expect(verdicts(tail.replace('CALL', "logger.debug('m', m)"))).toEqual(['assignment:ok']);
      expect(verdicts(tail.replace('CALL', 'unknownSink(m)'))).toEqual(['assignment:raw']);
      expect(verdicts(tail.replace('CALL', 'read.call(undefined, m)'))).toEqual(['assignment:raw']);
    });

    it('judges an interior write into a stored bag, directly or through an alias', () => {
      expect(
        verdicts(`
export function f(rec: any, read: () => any) {
  rec.observedProperties.Name = read();
  const o = rec.observedProperties;
  o[read()] = read();
  Object.assign(rec.observedProperties, read());
  rec.observedProperties.Name = rec.physicalId;
}`)
      ).toEqual(['interior:raw', 'interior:raw', 'interior:raw', 'interior:ok']);
    });

    it('reads a key variable as the field, and fails a field name it cannot follow', () => {
      expect(
        verdicts(`
export function f(rec: any, read: () => unknown) {
  for (const field of ['attributes', 'observedProperties'] as const) rec[field] = redactForState(read(), {});
}
function own(rec: any, key: 'attributes' | 'observedProperties') { return rec[key]; }
export function g(rec: any, read: () => unknown) {
  own(rec, 'observedProperties');
  const key = 'observedProperties';
  rec[key] = read();
}`)
      ).toEqual(['assignment:ok', 'computed-key:raw']);
    });
  });

  describe('review round 1 (each a value that passed and must fail)', () => {
    it('follows two calls of one helper from outside it, and a recursive one once', () => {
      expect(
        verdicts(`
function id<T>(v: T): T { return v; }
export function f(rec: any, read: () => unknown) {
  rec.observedProperties = { a: redactForState(1, {}), b: id(id(read())) };
}`)
      ).toEqual(['assignment:raw']);
    });

    it('does not keep a result a cycle cut short', () => {
      expect(
        verdicts(`
export function f(r: any, r2: any, read: () => unknown) {
  const a: any = {};
  a.y = read();
  const c = a.y;
  a.x = c;
  r.observedProperties = a;
  r2.observedProperties = c;
}`)
      ).toEqual(['assignment:raw', 'assignment:raw']);
    });

    it('a nested local shadowing the imported redactor is not it', () => {
      expect(
        verdicts(`
export function f(rec: any, read: () => unknown) {
  const redactForState = <T,>(x: T, ..._r: unknown[]): T => x;
  rec.observedProperties = redactForState(read(), {});
}`)
      ).toEqual(['assignment:raw']);
    });

    it('a caller through a renamed, re-exported or namespace import keeps the parameter raw', () => {
      const put = 'export function put(rec: any, bag: unknown) { rec.observedProperties = bag; }\nexport function ok(rec: any) { put(rec, rec.observedProperties); }';
      expect(verdictsAcross({ 'src/y.ts': "import { put as store } from './x.js';\nexport function g(r: any, read: () => unknown) { store(r, read()); }" }, put)).toEqual(['assignment:raw']);
      expect(verdictsAcross({ 'src/y.ts': "import * as h from './x.js';\nexport function g(r: any, read: () => unknown) { h.put(r, read()); }" }, put)).toEqual(['assignment:raw']);
      expect(
        verdictsAcross(
          {
            'src/barrel.ts': "export { put as install } from './x.js';",
            'src/y.ts': "import { install } from './barrel.js';\nexport function g(r: any, read: () => unknown) { install(r, read()); }",
          },
          put
        )
      ).toEqual(['assignment:raw']);
      expect(verdictsAcross({}, put)).toEqual(['assignment:ok']);
    });

    it('a caller in another file is never taken for a recursive call by its offset alone', () => {
      // The caller's offset falls inside the callee's span, in another file.
      const put = 'export function put(rec: any, bag: unknown) { rec.observedProperties = bag; }\nexport function ok(rec: any) { put(rec, rec.observedProperties); }';
      const head = "import { put } from './x.js';\ndeclare function read(): unknown;\n";
      const putAt = IMPORT.length + 5;
      const y = head + `/*${' '.repeat(Math.max(0, putAt - head.length))}*/ export function g(r: any) { put(r, read()); }`;
      expect(y.indexOf('put(r') > putAt && y.indexOf('put(r') < IMPORT.length + put.indexOf('}\n')).toBe(true);
      expect(verdictsAcross({ 'src/y.ts': y }, put)).toEqual(['assignment:raw']);
    });

    it('a container handed to a constructor is raw', () => {
      expect(
        verdicts(`
export function f(rec: any) {
  const bag: Record<string, unknown> = {};
  new Filler(bag);
  rec.observedProperties = bag;
}`)
      ).toEqual(['assignment:raw']);
    });

    it('follows a helper writing into a non-fresh bag it was handed', () => {
      expect(
        verdicts(`
function copyLive(to: any, from: unknown) { to.x = from; }
export function f(rec: any, read: () => unknown) {
  const written = redactForState(read(), {});
  copyLive(written, read());
  rec.observedProperties = written;
}`)
      ).toEqual(['assignment:raw']);
    });

    it('follows a member of a redacted bag handed to a helper that writes into it', () => {
      const body = (arg: string): string => `
function patch(def: any, live: any) { def.Secret = live.Secret; }
export function f(rec: any, live: any) {
  const bag = redactForState(live, {});
  patch(${arg}, live.Definition);
  rec.observedProperties = bag;
}`;
      expect(verdicts(body('bag.Definition'))).toEqual(['assignment:raw']);
      expect(verdicts(body("(bag['Definition'] as any)"))).toEqual(['assignment:raw']);
      expect(verdicts(body('{}'))).toEqual(['assignment:ok']);
    });

    it('follows a const alias of a followed binding through casts', () => {
      const body = (write: string): string => `
export function f(rec: any, live: any) {
  const written = redactForState(live, {});
  const bag = (written as Record<string, unknown>)!;
  ${write};
  rec.observedProperties = written;
}`;
      expect(verdicts(body("bag['Definition'] = live['Definition']"))).toEqual(['assignment:raw']);
      expect(verdicts(body('Object.assign(bag, live)'))).toEqual(['assignment:raw']);
      expect(verdicts(body("bag['Definition'] = undefined"))).toEqual(['assignment:ok']);
      // The alias's own escapes, an alias of the alias, and a member destructured off it.
      const patch = 'function patch(to: any, l: any) { to.X = l.X; }\n';
      expect(verdicts(patch + body('patch(bag, live)'))).toEqual(['assignment:raw']);
      expect(verdicts(patch + body("patch(bag['Definition'] as any, live)"))).toEqual(['assignment:raw']);
      expect(verdicts(body('const b2 = bag; b2.X = live.X'))).toEqual(['assignment:raw']);
      expect(verdicts(body('const { Nested } = bag as any; Nested.X = live.X'))).toEqual(['assignment:raw']);
      // A fresh container's alias is followed on through its escapes too.
      expect(
        verdicts(`
function fill(m: any, live: any) { m.x = live; }
export function f(rec: any, live: any) {
  const a: Record<string, unknown> = {};
  const b = a satisfies object;
  fill(b, live);
  rec.observedProperties = a;
}`)
      ).toEqual(['assignment:raw']);
    });

    it('sees every interior write shape into a stored bag', () => {
      expect(
        verdicts(`
function heal(bag: any, v: unknown) { bag.X = v; }
export function f(rec: any, read: () => any) {
  rec.observedProperties.Tags.push(read());
  Object.defineProperty(rec.observedProperties, 'A', { value: read() });
  const { observedProperties } = rec;
  observedProperties.Name = read();
  const o = rec.observedProperties;
  const p = o;
  p.Name = read();
  heal(rec.observedProperties, read());
}`).sort()
      ).toEqual(['interior:raw', 'interior:raw', 'interior:raw', 'interior:raw', 'interior:raw']);
    });

    it('a compound assignment used as a value, a caught value, a generator and a reshaping static are raw', () => {
      expect(
        verdicts(`
function* live(read: () => unknown) { yield read(); }
export function f(rec: any, cache: any, read: () => unknown) {
  rec.observedProperties = (cache.v ??= read());
  try { read(); } catch (e) { rec.observedProperties = e; }
  for (const v of live(read)) rec.observedProperties = v;
  const { Def } = Object.fromEntries([['Def', read()]]);
  rec.observedProperties = Def;
}`)
      ).toEqual(['assignment:raw', 'assignment:raw', 'assignment:raw', 'assignment:raw']);
    });

    it('a class field and a getter named observedProperties are write sites', () => {
      expect(
        verdicts(`
export class R {
  observedProperties = read();
  get other(): unknown { return 1; }
}
export class S { get observedProperties(): unknown { return read(); } }
declare function read(): unknown;`)
      ).toEqual(['property:raw', 'property:raw']);
    });
  });

  it('counts an exemption exactly, in both directions', () => {
    const raw = (fn: string): Site => ({
      file: 'src/a.ts',
      line: 1,
      fn,
      kind: 'assignment',
      text: 'x',
      roots: [],
      raw: ['why'],
    });
    const exemption = { file: 'src/a.ts', fn: 'f', count: 1, reason: 'r' };
    expect(judgeSites([raw('f')], [exemption])).toEqual([]);
    expect(judgeSites([raw('f'), raw('f')], [exemption])).toEqual([
      'exemption src/a.ts (f) expects 1 raw site(s), found 2',
    ]);
    expect(judgeSites([], [exemption])[0]).toMatch(/expects 1 raw site\(s\), found 0: remove or lower it/);
    expect(judgeSites([raw('g')], [exemption])).toHaveLength(2);
  });

  describe('runtime twins: what the critic believes of each registered function', () => {
    const PLAIN = 'sk-live-observed-writer-secret';
    const EXPR = '{{resolve:secretsmanager:app/api:SecretString:key}}';
    const secrets = (): Map<string, string> => new Map([[PLAIN, EXPR]]);
    const leaks = (value: unknown): boolean => JSON.stringify(value).includes(PLAIN);

    const redactors: Record<string, () => unknown> = {
      redactForState: () =>
        redactForState({ Auth: PLAIN, Nested: { Inner: `x ${PLAIN} y` } }, { provenance: 'value-scan', secrets: secrets() }),
      redactAtProvenance: () =>
        redactAtProvenance({ Auth: PLAIN }, secrets(), { Auth: EXPR }, 'template-derived', false),
      redactSecretsForState: () => redactSecretsForState({ Auth: PLAIN }, secrets(), { Auth: EXPR }),
    };

    it('covers every REDACTORS entry', () => {
      expect(Object.keys(redactors).sort()).toEqual([...REDACTORS].sort());
    });

    it.each(Object.entries(redactors))('%s persists no resolved value', (_name, run) => {
      expect(leaks(run())).toBe(false);
    });

    // Each carrier holds the secret in an argument it does NOT carry, and the
    // result must not show it.
    const carriers: Record<string, () => unknown> = {
      // One argument: what it returns IS that argument, by identity.
      markSameGenerationBag: () => {
        const bag = { A: 'kept' };
        expect(markSameGenerationBag(bag)).toBe(bag);
        return markSameGenerationBag({ Auth: EXPR });
      },
      carryRedactionMarks: () => carryRedactionMarks(markSameGenerationBag({ Auth: PLAIN }), { A: 'kept' }),
      maskReadbackAtCoordinates: () => maskReadbackAtCoordinates({ A: 'kept' }, { Auth: PLAIN, A: '***' }, [['A']]),
      keepTemplateLiteralLeaves: () =>
        // The template spells the reference: the readback's plaintext stays out.
        keepTemplateLiteralLeaves({ Auth: EXPR }, { Auth: PLAIN }, { Auth: EXPR }, secrets()),
    };

    it('covers every CARRIERS entry', () => {
      expect(Object.keys(carriers).sort()).toEqual(Object.keys(CARRIERS).sort());
    });

    it.each(Object.entries(carriers))('%s adds nothing from its other arguments', (_name, run) => {
      expect(leaks(run())).toBe(false);
    });
  });
});
