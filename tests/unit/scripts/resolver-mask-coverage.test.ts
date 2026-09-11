/**
 * Tests for `scripts/check-resolver-mask-coverage.ts`.
 *
 * THE HISTORY. Four enumerations of "every site in the resolver that
 * interpolates a resolved value" disagreed, each asserting completeness and
 * each refuted by the next round. The fourth was a LINE-ANCHORED checker built
 * to end that cycle, and review found it could not see the masks it certified:
 * its exclusion was per-STATEMENT (one note exempted a statement's masked
 * interpolations too, so stripping the mask off `physicalId` in
 * `guardedPhysicalIdFallback` left it green) and it counted parens through
 * COMMENTS (a comment containing `throw new Error(` ran one statement's window
 * 50 lines past its end, attaching a note to the wrong site).
 *
 * Both are properties of scanning TEXT, so the checker is now an AST walk and
 * this suite's job is to prove the walk cannot regress to either.
 *
 * Two instruments, deliberately different in kind:
 *
 *   - **collapse toward zero** — a walk that stops finding statements reports
 *     "0 unannotated" and exits 0, byte-identical to a clean tree. FLOORS on
 *     what it must FIND, per SHAPE.
 *   - **collapse toward green** — an `isMasked` that returns true always leaves
 *     every count identical. KNOWN-BAD inputs, one per shape that was MEASURED
 *     passing the old substring predicate while leaking, plus REAL-TREE mutation
 *     probes that strip a mask this PR added and require a finding.
 */

import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import {
  scan,
  SUBJECT,
  MASKERS,
  EXCLUSION_TAG,
  BANDS,
  bandViolations,
} from '../../../scripts/check-resolver-mask-coverage.ts';

const realSource = (): string => readFileSync(SUBJECT, 'utf8');

/** Findings for a synthetic source. */
const findingsIn = (src: string): number => scan(src, 'probe.ts').findings.length;

describe('check-resolver-mask-coverage', () => {
  describe('the real tree is clean', () => {
    it('every interpolated value is masked or individually annotated', () => {
      // Names the sites, so a regression reads as a work list rather than a
      // count that moved.
      expect(
        scan().findings.map((f) => `${SUBJECT}:${f.line} [${f.kind}] \${${f.expr}}`)
      ).toEqual([]);
    });

    it('carries no marker that no site reads', () => {
      // A `not-in-class(...)` note nobody consults reads as coverage and is
      // none. Four existed when this was first measured, all of them on
      // statements the walk deliberately does not record (bare re-throws), so
      // they excused nothing and asserted something false about a site that was
      // never in the population.
      expect(
        scan().unconsumedMarkers.map((m) => `${SUBJECT}:${m.line} ${EXCLUSION_TAG}(${m.expr})`)
      ).toEqual([]);
    });
  });

  describe('the walk did not collapse', () => {
    const result = scan();

    it('the real tree sits INSIDE every band, with none of them violated', () => {
      // THE BAND IS THE CI-SIDE INSTRUMENT, and it is deliberately looser than
      // the pin below: `bandViolations` runs inside the shipped checker, where
      // a bound tight enough to fail on any legitimate edit would be turned off
      // rather than obeyed. This case asserts the shipped verdict; the exact
      // pin is a separate, tighter instrument that lives only in the suite.
      expect(bandViolations(result)).toEqual([]);
      // Per-shape floors beside the aggregate bands: an aggregate stays
      // satisfied while one shape is dead, and the LOG shape is the one the
      // first sweep was blind to.
      expect(result.sites.filter((s) => s.kind === 'throw').length).toBeGreaterThanOrEqual(20);
      expect(result.sites.filter((s) => s.kind === 'log').length).toBeGreaterThanOrEqual(40);
    });

    it('the bands are LITERALS, and the suite pins the counts EXACTLY', () => {
      // A band computed from the pool it guards is unfalsifiable, so `BANDS` is
      // pinned as literals — widening one is then a diff a reviewer sees.
      expect(BANDS).toEqual({
        statements: { min: 128, max: 165 },
        maskedExprs: { min: 150, max: 200 },
        markers: { min: 90, max: 140 },
      });
      // ...and the counts are pinned EXACTLY, from a separate measurement
      // (2026-09-10: 131 / 155 / 98; issue #2814's drain warning then added one
      // log site and its two notes). This subsumes the band check on the real tree and is meant
      // to: a change to this file's throw/log population is a decision, and the
      // three numbers moving in a diff is how it gets read. The band still earns
      // its place — it is what the SHIPPED binary enforces in CI, where this
      // suite's assertions do not run.
      expect(result.statements).toBe(132);
      expect(result.maskedExprs).toBe(155);
      expect(result.markers).toBe(100);
    });

    it('a subject with no statements is not silently green', () => {
      // The shape of a walk that stopped matching: nothing found, nothing to
      // report, exit 0. The bands above are what catch it on the real tree;
      // this pins that the walk really does return zero for empty input rather
      // than throwing, so the bands are the only thing standing there.
      const empty = scan('export const x = 1;', 'probe.ts');
      expect(empty.statements).toBe(0);
      expect(empty.findings).toEqual([]);
    });

    it('REFUSES a subject that does not parse, rather than reporting a partial tree', () => {
      // A parse error truncates the tree: statements disappear, every count
      // stays plausible, and the run is green over a subject nobody read.
      expect(() => scan(`${realSource()}\nclass Broken { m( {`, 'probe.ts')).toThrow(
        /parse diagnostic/
      );
    });

    it.each([
      ['private async resolveSelect'],
      ['private async resolveFindInMap'],
      ['private async resolveCidr'],
      ['private async resolveSplit'],
      ['private async resolveGetAZs'],
    ])('a `/*` inserted at %s cannot pass the gate', (anchor) => {
      // THE INJECTION THE OLD FLOORS MISSED. It usually produces NO diagnostic:
      // an opened block comment closes on the next `*` + `/` in the file, so the
      // statements between simply stop existing and everything downstream stays
      // plausible. What catches each anchor is deliberately NOT asserted here —
      // the sibling case below pins which instrument catches which, and stating
      // it twice is how one copy goes stale. This case asserts only the property
      // that has to hold for every anchor: SOMETHING complains.
      const base = realSource();
      const at = base.indexOf(anchor);
      expect(at, 'the premise: the anchor is present to cut at').toBeGreaterThan(0);
      const broken = `${base.slice(0, at)}/*\n${base.slice(at)}`;

      let caught: string[];
      try {
        const r = scan(broken);
        caught = [...bandViolations(r), ...r.unconsumedMarkers.map((m) => `stale:${m.expr}`)];
      } catch {
        caught = ['refused: parse diagnostics'];
      }
      expect(caught.length, `${anchor} was swallowed with nothing complaining`).toBeGreaterThan(0);
    });

    it('ALL THREE instruments are live — none of them is dead weight', () => {
      // The case above passes if ONE mechanism catches everything, which is how
      // a second mechanism quietly stops mattering. Each anchor below is
      // measured to be caught by a DIFFERENT one, and each assertion is
      // EXCLUSIVE — "caught by the stale report" is only evidence about the
      // stale report if the band is simultaneously clean.
      const base = realSource();
      const cut = (anchor: string) => {
        const at = base.indexOf(anchor);
        expect(at).toBeGreaterThan(0);
        return `${base.slice(0, at)}/*\n${base.slice(at)}`;
      };

      // BAND: this one removes enough statements to fall through the floor.
      const byBand = scan(cut('private async resolveFindInMap'));
      expect(bandViolations(byBand).length, 'caught by the BAND').toBeGreaterThan(0);

      // STALE: this one clears every band — the swallowed statements left their
      // markers behind, and nothing reads them any more.
      const byStale = scan(cut('private async resolveSplit'));
      expect(bandViolations(byStale), 'this one clears every band...').toEqual([]);
      expect(byStale.unconsumedMarkers.length, '...and is caught by the STALE report').toBeGreaterThan(
        0
      );

      // PARSE REFUSAL: cutting here really does unbalance the file, so the
      // refusal is the instrument — and it is the ONLY one, since a throwing
      // scan produces no counts for the other two to judge.
      expect(() => scan(cut('private async resolveGetAZs')), 'caught by the PARSE REFUSAL').toThrow(
        /parse diagnostic/
      );
    });
  });

  describe('KNOWN-BAD inputs — each MEASURED passing the old predicate', () => {
    it.each([
      [
        'a plain bare interpolation (control)',
        'class X { m(a){ throw new Error(`v ${a}`); } }',
      ],
      [
        'stringifyAttributeForLog, which redacts on the NAME only',
        'class X { m(a,v){ this.logger.debug(`x ${stringifyAttributeForLog(a, v)}`); } }',
      ],
      [
        'JSON.stringify of an UNMASKED value',
        'class X { m(v){ this.logger.debug(`x ${JSON.stringify(v)}`); } }',
      ],
      [
        'a message built by CONCAT, with no ${} at all',
        "class X { m(s){ throw new Error('a: ' + s); } }",
      ],
      [
        'a message assembled in a HELPER and logged as a bare identifier',
        'class X { m(a){ const msg = build(a); this.logger.warn(msg); } }',
      ],
      [
        'a binding merely NAMED logged*',
        'class X { m(r){ const loggedX = r; throw new Error(`v ${loggedX}`); } }',
      ],
      [
        'a masker in ONE arm of a ternary',
        'class X { m(a,b,c,x){ throw new Error(`v ${c ? this.maskSecretsForLog(a,x) : b}`); } }',
      ],
      [
        'truncation WITHOUT masking',
        'class X { m(v){ throw new Error(`v ${stripControlChars(v).slice(0, 64)}`); } }',
      ],
      [
        'a FREE function whose arguments are all literals (vacuously "every argument masked")',
        "class X { m(){ throw new Error(`v ${lookupSecret('db-password')}`); } }",
      ],
      [
        'a free function called with NO arguments at all (control — the OLD predicate rejected this too)',
        'class X { m(){ throw new Error(`v ${currentSecret()}`); } }',
      ],
      [
        'a `let` whose masked initializer is reassigned later',
        'class X { m(v,c){ let s = this.maskSecretsForLog(v, c); s = v; throw new Error(`v ${s}`); } }',
      ],
      [
        'a name declared TWICE — the textual first match is not the one in scope',
        'class X { a(v,c){ const s = this.maskSecretsForLog(v, c); return s; }\n' +
          ' b(v){ const s = v; throw new Error(`v ${s}`); } }',
      ],
      [
        'a PARAMETER shadowed by a foreign masked const of the same name',
        'class X { a(v,c){ const s = this.maskSecretsForLog(v, c); return s; }\n' +
          ' b(s){ throw new Error(`v ${s}`); } }',
      ],
      // The three DESTRUCTURING shapes. A pattern declares a name with no
      // `ts.isIdentifier` binding name, so a walk that collects only identifiers
      // sees nothing at all, climbs past the scope that really binds the use,
      // and credits it from the enclosing masked `const`. Each of these was
      // measured at 0 findings before the pattern refusal landed.
      [
        'an ARRAY-destructured binding shadowing an outer masked const',
        'const s = this.maskSecretsForLog(1, 2);\n' +
          'class X { m(v){ const [s] = v; throw new Error(`v ${s}`); } }',
      ],
      [
        'an OBJECT-destructured binding shadowing an outer masked const',
        'const s = this.maskSecretsForLog(1, 2);\n' +
          'class X { m(v){ const { s } = v; throw new Error(`v ${s}`); } }',
      ],
      [
        'a destructured CATCH binding shadowing an outer masked const',
        'const message = this.maskSecretsForLog(1, 2);\n' +
          'class X { m(){ try { f(); } catch ({ message }) { throw new Error(`v ${message}`); } } }',
      ],
      [
        'a destructured PARAMETER shadowing an outer masked const',
        'const s = this.maskSecretsForLog(1, 2);\n' +
          'class X { m({ s }){ throw new Error(`v ${s}`); } }',
      ],
    ])('rejects %s', (_label, src) => {
      expect(findingsIn(src)).toBe(1);
    });

    it.each([
      [
        'a real masker',
        'class X { m(v,c){ throw new Error(`v ${this.maskSecretsForLog(v, c)}`); } }',
      ],
      [
        'mask BEFORE encode',
        'class X { m(v,c){ this.logger.debug(`x ${JSON.stringify(this.maskValueLeaves(v, c))}`); } }',
      ],
      [
        'mask before TRUNCATION',
        'class X { m(v,c){ throw new Error(`v ${this.maskThenStripThenMask(v, c).slice(0, 64)}`); } }',
      ],
      [
        'BOTH ternary arms masked',
        'class X { m(a,b,c,x){ throw new Error(`v ${c ? this.maskSecretsForLog(a,x) : this.maskSecretsForLog(b,x)}`); } }',
      ],
      [
        'a logged* binding that IS masked',
        'class X { m(v,c){ const loggedX = this.maskSecretsForLog(v, c); throw new Error(`v ${loggedX}`); } }',
      ],
      ['a type name', 'class X { m(v){ throw new Error(`got ${typeof v}`); } }'],
      ['a length', 'class X { m(i){ throw new Error(`n=${i.length}`); } }'],
    ])('accepts %s', (_label, src) => {
      expect(findingsIn(src)).toBe(0);
    });

    it('accepts an ANNOTATED bare expression, and only for the named one', () => {
      const one = `class X { m(a,b){\n  // ${EXCLUSION_TAG}(a): a literal.\n  throw new Error(\`v \${a} \${b}\`); } }`;
      // `a` is annotated, `b` is not — the per-EXPRESSION property. Under the
      // per-STATEMENT form this returned 0 and that was the defect.
      expect(findingsIn(one)).toBe(1);
      expect(scan(one, 'probe.ts').findings[0]?.expr).toBe('b');
    });

    it('matches a marker whose expression contains parentheses', () => {
      // `[^)]*` truncated at the inner `)`, so the marker never matched and the
      // site read unannotated forever.
      const src = `class X { m(r){\n  // ${EXCLUSION_TAG}(r.join(', ')): a list of literals.\n  throw new Error(\`v \${r.join(', ')}\`); } }`;
      expect(findingsIn(src)).toBe(0);
    });
  });

  describe('MASKERS contains only real maskers', () => {
    it('does not list the NAME-based encoders', () => {
      // `stringifyAttributeForLog` redacts on the attribute NAME regex and
      // otherwise returns the value verbatim, so listing it made the mutation
      // probe for all four `Fn::GetAtt` lines inert.
      expect(MASKERS).not.toContain('stringifyAttributeForLog');
      expect(MASKERS).not.toContain('stringifyParameterForLog');
      expect(MASKERS).not.toContain('stringifyValue');
      expect(MASKERS).not.toContain('JSON.stringify');
    });
  });

  describe('REAL-TREE mutation probes — the fence watches the field it claims', () => {
    it.each([
      ['physicalId in guardedPhysicalIdFallback (BL1 own fix)', '${this.maskSecretsForLog(physicalId, context)}', '${physicalId}'],
      ['attributeName', '${this.maskSecretsForLog(attributeName, context)}', '${attributeName}'],
      ['maskValueLeaves under a JSON encoding', 'this.maskValueLeaves(value, context)', 'value'],
    ])('reports a finding when the mask is stripped from %s', (_label, pattern, replacement) => {
      const base = realSource();
      expect(base, 'the premise: the mask is present to strip').toContain(pattern);
      const before = scan(base).findings.length;
      const after = scan(base.replace(pattern, replacement)).findings.length;
      expect(before, 'the real tree is clean').toBe(0);
      expect(after).toBeGreaterThan(before);
    });

    it('reports findings when a logged* binding stops being masked', () => {
      // The binding is resolved and judged on its INITIALIZER, so this reds
      // every site that interpolates it — a naming convention cannot.
      const base = realSource();
      const pattern = 'const loggedExportName = this.maskSecretsForLog';
      expect(base).toContain(pattern);
      expect(
        scan(base.replace(pattern, 'const loggedExportName = String')).findings.length
      ).toBeGreaterThan(0);
    });

    it('reports an APPENDED unmasked site', () => {
      const base = realSource();
      const appended = `${base}\nclass Probe { m(secret: string) { throw new Error(\`leak \${secret}\`); } }\n`;
      const f = scan(appended).findings;
      expect(f.length).toBe(1);
      expect(f[0]?.expr).toBe('secret');
    });
  });
});
