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
  RAW_MASKERS,
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
        statements: { min: 133, max: 165 },
        maskedExprs: { min: 161, max: 200 },
        markers: { min: 98, max: 140 },
      });
      // ...and the counts are pinned EXACTLY, from a separate measurement
      // (2026-09-10: 131 / 155 / 98; issue #2814's drain warning then added one
      // log site and its two notes; issue #3096 replaced the EC2 arm's two
      // physical-id warns (3 masks, 2 notes) with `refuseUnservedAttribute`'s
      // throw, `describeFailureObserved`'s debug line and the DBProxy `VpcId`
      // throw (6 masks, 8 notes): 132 / 155 / 100 -> 133 / 158 / 106; its review
      // round added the VPC `vpc-id` filter-shape refusal, one mask and one
      // note: 134 / 159 / 107; its delta round added the CloudFront
      // distribution-id shape refusal the same way: 135 / 160 / 108; issue
      // #3097's security-group `VpcId` live arm added the `sg-<hex>` shape
      // refusal the same way — its two `refuseUnservedAttribute` calls share
      // the existing throw site: 136 / 161 / 109; issue #3150 masked the
      // nested-stack refusal's declared-output list, the producer-region line,
      // three `Fn::ImportValue` producer-region interpolations and the
      // ambiguous-region refusal's producer-region list, retiring the six notes
      // that described them as unmasked: 136 / 167 / 103; issue #3207 added
      // `resolveGetStackOutput`'s malformed-producer-record refusal, ONE throw
      // interpolating the two already-masked identifiers its neighbours use and
      // needing no note: 137 / 169 / 103, re-measured on the combined tree
      // rather than carried from either side of the rebase, since #3150 and
      // #3207 moved these counts independently and neither side's triple is
      // right for the merge; go-to-k/cdkd#3426 then routed the `Ref <id> not
      // found` warn / debug / throw through the builder, which ADDS three
      // masked expressions and RETIRES the three markers that had exempted
      // them: 137 / 169 / 103 -> 137 / 172 / 100. The statement count is
      // deliberately unmoved -- that change renders the same three sites
      // differently, it does not add or remove one). This subsumes the band
      // check on the real tree and is meant
      // to: a change to this file's throw/log population is a decision, and the
      // three numbers moving in a diff is how it gets read. The band still earns
      // its place — it is what the SHIPPED binary enforces in CI, where this
      // suite's assertions do not run.
      expect(result.statements).toBe(137);
      expect(result.maskedExprs).toBe(172);
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
        'class X { m(a,b,c,x){ throw new Error(`v ${c ? this.displayMasked(a,x) : b}`); } }',
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
        'class X { m(v,c){ let s = this.displayMasked(v, c); s = v; throw new Error(`v ${s}`); } }',
      ],
      [
        'a name declared TWICE — the textual first match is not the one in scope',
        'class X { a(v,c){ const s = this.displayMasked(v, c); return s; }\n' +
          ' b(v){ const s = v; throw new Error(`v ${s}`); } }',
      ],
      [
        'a PARAMETER shadowed by a foreign masked const of the same name',
        'class X { a(v,c){ const s = this.displayMasked(v, c); return s; }\n' +
          ' b(s){ throw new Error(`v ${s}`); } }',
      ],
      // The three DESTRUCTURING shapes. A pattern declares a name with no
      // `ts.isIdentifier` binding name, so a walk that collects only identifiers
      // sees nothing at all, climbs past the scope that really binds the use,
      // and credits it from the enclosing masked `const`. Each of these was
      // measured at 0 findings before the pattern refusal landed.
      [
        'an ARRAY-destructured binding shadowing an outer masked const',
        'const s = this.displayMasked(1, 2);\n' +
          'class X { m(v){ const [s] = v; throw new Error(`v ${s}`); } }',
      ],
      [
        'an OBJECT-destructured binding shadowing an outer masked const',
        'const s = this.displayMasked(1, 2);\n' +
          'class X { m(v){ const { s } = v; throw new Error(`v ${s}`); } }',
      ],
      [
        'a destructured CATCH binding shadowing an outer masked const',
        'const message = this.displayMasked(1, 2);\n' +
          'class X { m(){ try { f(); } catch ({ message }) { throw new Error(`v ${message}`); } } }',
      ],
      [
        'a destructured PARAMETER shadowing an outer masked const',
        'const s = this.displayMasked(1, 2);\n' +
          'class X { m({ s }){ throw new Error(`v ${s}`); } }',
      ],
    ])('rejects %s', (_label, src) => {
      expect(findingsIn(src)).toBe(1);
    });

    // ROUND FIVE's shape (go-to-k/cdkd#3426). Every case here is MASKED — the
    // secret question is answered — and every one of them renders text that is
    // not control-stripped. They are findings under `raw-masker-render`, a
    // verdict the exclusion marker deliberately cannot silence.
    it.each([
      [
        'a BINDING of the bare masker, interpolated later',
        'class X { m(v,c){ const loggedX = this.maskSecretsRaw(v, c); throw new Error(`v ${loggedX}`); } }',
      ],
      [
        'a bare-masker call interpolated directly',
        'class X { m(v,c){ this.logger.warn(`x ${this.maskSecretsRaw(v, c)}`); } }',
      ],
      [
        'the strip-and-mask helper, which omits displaySafe',
        'class X { m(v,c){ throw new Error(`v ${this.maskThenStripThenMask(v, c).slice(0, 64)}`); } }',
      ],
      [
        'a LOG-TWIN leaf binding',
        'class X { m(v,c){ const twin = this.logTextOfLeaf(v, c); this.logger.debug(`x ${twin}`); } }',
      ],
      [
        'a bare masker in ONE arm of a ternary, the other arm built',
        'class X { m(a,b,c,x){ throw new Error(`v ${c ? this.maskSecretsRaw(a,x) : this.displayMasked(b,x)}`); } }',
      ],
      [
        'a bare masker under an ENCODER',
        'class X { m(v,c){ this.logger.warn(`x ${JSON.stringify(this.maskSecretsRaw(v, c))}`); } }',
      ],
      [
        'a `let` written by a += assignment',
        "class X { m(v,c){ let t = ''; t += this.maskSecretsRaw(v, c); throw new Error(`v ${t}`); } }",
      ],
      // The two entries go-to-k/cdkd#3426's review round 2 found on NEITHER
      // list. Both return an OBJECT whose `.twin` member is the masking
      // answer, so the render is a property access rather than a call — which
      // is how they escaped the first audit. No live site renders either
      // today, so these cases are what keeps the entries from being deleted as
      // dead weight: removing them leaves the real tree green.
      [
        'a product log twin, read off the returned object',
        'class X { m(p,c){ throw new Error(`v ${this.logTwinOfProduct(p, c).twin}`); } }',
      ],
      [
        // NOTE THE MISSING `await`, and it is a recorded BOUND rather than an
        // oversight (review round 3): the real method is `async` and all seven
        // call sites await it, and `reachesRawMasker` has no `await` arm since
        // the withdrawal — so the awaited spelling takes the weaker,
        // annotatable verdict. This case pins the entry's DIRECT-call
        // coverage; the awaited carry is what the withdrawal gave up.
        'a dynamic-reference log twin, bound and then read (no await — see the note)',
        'class X { m(v,c){ const r = this.resolveDynamicReferencesWithLogTwin(v, v, c); ' +
          'this.logger.warn(`x ${r.twin}`); } }',
      ],
    ])('rejects %s as a bare-masker render', (_label, src) => {
      const found = scan(src, 'probe.ts').findings;
      expect(found.length).toBe(1);
      expect(found[0]?.reason).toBe('raw-masker-render');
    });

    it.each([
      [
        'a raw masker as the ARGUMENT of a masked method call',
        "class X { m(v,c){ this.logger.warn(`x ${this.displayMasked(v, c).replace('@', this.logTextOfLeaf(v, c))}`); } }",
      ],
      [
        'the same, through a binding',
        "class X { m(v,c){ const twin = this.logTextOfLeaf(v, c); const line = this.displayMasked(v, c).replace('@', twin); this.logger.warn(`x ${line}`); } }",
      ],
    ])('reports %s, which reported NOTHING before round 3', (_label, src) => {
      // THE ZERO-FINDING SHAPE, found by go-to-k/cdkd#3426's third review
      // round. It is worse than the withdrawn arms' degradation: those still
      // report the annotatable verdict, while this reported NO finding at all
      // — `isMasked` credited the whole expression from its masked RECEIVER
      // while the raw argument was invisible to both walks at once.
      //
      // The subject writes `this.displayMasked(physicalId, context).slice(0,
      // 64)` at three sites today, so the hole sat one argument away from live
      // code. `isMasked`'s method arm now requires the receiver AND every
      // value-bearing argument.
      const found = scan(src, 'probe.ts').findings;
      expect(found.length).toBe(1);
    });

    it('still accepts a masked method call whose arguments are LITERALS', () => {
      // The other direction, and the reason the argument test filters
      // `carriesNoValue` first: the truncating renders this file is full of
      // (`displayMasked(v, c).slice(0, 64)`) pass only literals, and a rule
      // that failed them would red 73 sites on the real subject.
      expect(
        findingsIn("class X { m(v,c){ throw new Error(`v ${this.displayMasked(v, c).slice(0, 64)}`); } }")
      ).toBe(0);
    });

    it('does NOT let an exclusion marker silence a bare-masker render', () => {
      // The marker asserts "this value carries no resolved value", which is
      // false by construction for a value that went through the masking
      // machinery — so it answers the secret question and not this one. Without
      // this the ten binding sites could have been "closed" by annotating them,
      // which is the same enumeration one indirection further out.
      const src =
        'class X { m(v,c){\n' +
        `  // ${EXCLUSION_TAG}(loggedX): a name, not a value.\n` +
        '  const loggedX = this.maskSecretsRaw(v, c);\n' +
        '  throw new Error(`v ${loggedX}`); } }';
      const found = scan(src, 'probe.ts').findings;
      expect(found.length).toBe(1);
      expect(found[0]?.reason).toBe('raw-masker-render');
    });

    it('reports a bare-masker render ONCE, under the verdict that carries the remedy', () => {
      // Both rules can match one expression (it is unmasked AND raw). Reporting
      // it twice would put two contradictory remedies on one line — the second
      // of which, "add an exclusion marker", is the wrong one.
      const src = 'class X { m(v,c){ throw new Error(`v ${this.maskSecretsRaw(v, c)}`); } }';
      const found = scan(src, 'probe.ts').findings;
      expect(found.map((f) => f.reason)).toEqual(['raw-masker-render']);
    });

    it.each([
      [
        'a real masker',
        'class X { m(v,c){ throw new Error(`v ${this.displayMasked(v, c)}`); } }',
      ],
      [
        'mask BEFORE encode',
        'class X { m(v,c){ this.logger.debug(`x ${JSON.stringify(this.maskValueLeaves(v, c))}`); } }',
      ],
      [
        'mask before TRUNCATION',
        'class X { m(v,c){ throw new Error(`v ${this.displayMasked(v, c).slice(0, 64)}`); } }',
      ],
      [
        // The sanctioned composition, and the reason `reachesRawMasker` stops
        // at a `MASKERS` call rather than grepping for the raw name: this IS
        // `displayLeaf`'s body, so a walk that refused any reachable raw masker
        // would refuse the builder that fixes the class.
        'a RAW masker wrapped by the builder',
        'class X { m(v,c){ throw new Error(`v ${this.displayMasked(this.logTextOfLeaf(v, c), c)}`); } }',
      ],
      [
        'BOTH ternary arms masked',
        'class X { m(a,b,c,x){ throw new Error(`v ${c ? this.displayMasked(a,x) : this.displayMasked(b,x)}`); } }',
      ],
      [
        'a logged* binding that IS masked',
        'class X { m(v,c){ const loggedX = this.displayMasked(v, c); throw new Error(`v ${loggedX}`); } }',
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

  describe('RAW_MASKERS is not inert — every entry has a case', () => {
    // go-to-k/cdkd#3426 review round 3 measured 11 of the 16 entries carrying
    // NO case: deleting them left the suite green, so a rename or an
    // accidental drop was silently inert. That matters more than an ordinary
    // coverage gap, because the checker's receiver-only rule is justified BY
    // this list rather than by the walk.
    it.each([...RAW_MASKERS].map((name) => [name] as const))(
      '%s is load-bearing: a render of it is a bare-masker finding',
      (name) => {
        const found = scan(
          `class X { m(v,c){ this.logger.warn(\`x \${this.${name}(v, c)}\`); } }`,
          'probe.ts'
        ).findings;
        expect(found.map((f) => f.reason)).toEqual(['raw-masker-render']);
      }
    );

    it('every entry still NAMES something in the subject', () => {
      // The other staleness direction: an entry whose method was renamed or
      // deleted upstream stops guarding anything while the case above keeps
      // passing (it builds its own source). Two `RAW_MASKERS` names are
      // module-level rather than methods of the class, so the test is
      // occurrence in the file, not a declaration shape.
      const source = readFileSync(SUBJECT, 'utf8');
      const missing = [...RAW_MASKERS].filter((name) => !source.includes(name));
      expect(missing, 'a RAW_MASKERS entry names nothing in the subject').toEqual([]);
    });
  });

  describe('MASKERS contains only real maskers', () => {
    it('lists the SANITIZING maskers only, by name', () => {
      // Pinned as a SET rather than a floor: the entry that had to go
      // (go-to-k/cdkd#3426) was a masker that did not sanitize, and a
      // membership floor is satisfied by re-adding it. Each name here is a
      // security decision recorded at the list itself.
      expect([...MASKERS].sort()).toEqual([
        'displayLeaf',
        'displayMasked',
        'maskInherited',
        'maskValueLeaves',
      ]);
      // ...and the two that were REMOVED, stated as a negative so the removal
      // cannot be undone by a merge that looks like a restoration.
      expect(MASKERS).not.toContain('maskSecretsForLog');
      expect(MASKERS).not.toContain('maskThenStripThenMask');
      // The raw list is the other half of the same decision: a name on BOTH
      // would make the two verdicts contradict, and the raw rule would lose.
      for (const raw of RAW_MASKERS) expect(MASKERS).not.toContain(raw);
    });

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
      // Since #3096's review the physical id is also CONTROL-STRIPPED and
      // display-sanitised at every refusal site (a crafted state id with a
      // newline or U+2028 forges a log line), so the premise pattern is the
      // wrapped spelling. `String.replace` mutates the FIRST occurrence, which
      // is the DBProxy `VpcId` refusal, not `guardedPhysicalIdFallback`
      // (whose two sites are the last of the six).
      //
      // Both premises are now `this.displayMasked(...)`: go-to-k/cdkd#3408
      // collapsed the hand-spelled `displaySafe(this.maskThenStripThenMask(v))`
      // and the bare `this.displayMasked(v)` into ONE display builder, so
      // every interpolation in the subject reads the same way. That these two
      // rows had to change is the rename being observable rather than a
      // problem -- a transcribed literal that did NOT move would mean the
      // probe had stopped matching its subject.
      ['physicalId at the first strip-and-mask refusal site (DBProxy VpcId)', '${this.displayMasked(physicalId, context)}', '${physicalId}'],
      ['attributeName', '${this.displayMasked(attributeName, context)}', '${attributeName}'],
      // The full encoder call, not the bare mask: since issue #3114 the `Ref` to
      // a parameter and the `Fn::GetAtt` lines also pass `maskValueLeaves(value,
      // context)` into an encoder under an outer `maskSecretsForLog`, and the
      // first of them precedes this site, where stripping leaves a masked line.
      [
        'maskValueLeaves under a JSON encoding',
        'stringifyValue(this.maskValueLeaves(value, context))',
        'stringifyValue(value)',
      ],
    ])('reports a finding when the mask is stripped from %s', (_label, pattern, replacement) => {
      const base = realSource();
      expect(base, 'the premise: the mask is present to strip').toContain(pattern);
      // The re-anchored row names ONE site: `String.replace` mutates the first
      // occurrence, so a second one would silently re-target it. The other rows
      // mutate the first of several occurrences on purpose, as their comments say.
      if (pattern === 'stringifyValue(this.maskValueLeaves(value, context))') {
        expect(base.split(pattern).length, 'the premise: the pattern names ONE site').toBe(2);
      }
      const before = scan(base).findings.length;
      const after = scan(base.replace(pattern, replacement)).findings.length;
      expect(before, 'the real tree is clean').toBe(0);
      expect(after).toBeGreaterThan(before);
    });

    it('reports findings when a logged* binding stops being masked', () => {
      // The binding is resolved and judged on its INITIALIZER, so this reds
      // every site that interpolates it — a naming convention cannot.
      const base = realSource();
      const pattern = 'const loggedExportName = this.displayMasked';
      expect(base).toContain(pattern);
      expect(
        scan(base.replace(pattern, 'const loggedExportName = String')).findings.length
      ).toBeGreaterThan(0);
    });

    it('reports the RAW-MASKER verdict on the real tree, not the weaker one', () => {
      // THE VERDICT THIS WHOLE CHANGE RESTS ON, probed against real code rather
      // than a synthetic class. The distinction matters because the two
      // verdicts are not interchangeable: `unmasked-unannotated` is silenceable
      // with an exclusion marker and `raw-masker-render` is not, so a shape
      // that DEGRADES from one to the other quietly gives back the guarantee.
      // The existing binding probe below rewrites to `String`, which produces
      // the weaker verdict by construction and therefore cannot see that.
      const base = realSource();
      const pattern = 'const loggedExportName = this.displayMasked(exportName, context);';
      expect(base, 'the premise: the binding is present to rewrite').toContain(pattern);
      const raw = scan(
        base.replace(pattern, 'const loggedExportName = this.maskSecretsRaw(exportName, context);')
      ).findings;

      // EXACTLY seven — six logs and one throw — not a floor. A floor of six
      // stays green when one reader silently stops being reported, which is
      // the regression this case exists for (go-to-k/cdkd#3426 review round 2
      // measured the seven and named the loose floor).
      expect(raw.length, 'every site reading that binding must be reported').toBe(7);
      expect(raw.filter((f) => f.kind === 'log').length).toBe(6);
      expect(raw.filter((f) => f.kind === 'throw').length).toBe(1);
      expect(
        raw.map((f) => f.reason).filter((r) => r !== 'raw-masker-render'),
        'a site degraded to the silenceable verdict'
      ).toEqual([]);
      // ...including the warn go-to-k/cdkd#3426 called the sharpest site: the
      // one whose raw operand sits beside an already-sanitized neighbour.
      expect(raw.some((f) => f.kind === 'log')).toBe(true);
      expect(raw.some((f) => f.kind === 'throw')).toBe(true);
    });

    it('DEGRADES a callback-carried render to the weaker verdict — the withdrawn arms, pinned', () => {
      // THE BOUND, asserted rather than described. go-to-k/cdkd#3426's review
      // round 1 added arms for callbacks, object / array literals, spreads,
      // `await` and `new`; round 2 found a defect inside every one of them
      // (an exponential depth cap, three non-carrier methods credited as
      // carriers, a nested-function guard that missed `function` declarations,
      // an object literal tainting a read of an unrelated sibling key), two of
      // them reporting FALSE POSITIVES on this very subject. The arms were
      // WITHDRAWN.
      //
      // So a callback-carried render is a finding, but the ANNOTATABLE one.
      // This case exists so that bound cannot drift silently in either
      // direction: re-adding an arm reds it and forces the reviewer to look.
      const base = realSource();
      const pattern = "          `'${this.displayMasked(loggedRegionText, context)}'`";
      expect(base, 'the premise: the render is present to rewrite').toContain(pattern);
      const found = scan(
        base.replace(
          pattern,
          "          `'${['x'].map((k) => this.maskSecretsRaw(k, context)).join(', ')}'`"
        )
      ).findings;

      // Still REPORTED — the site is unmasked, so the walk is not blind to it.
      expect(found.length, 'a callback-carried raw render must still be a finding').toBe(1);
      expect(found[0]?.reason).toBe('unmasked-unannotated');
    });

    it('reports a LET-bound raw render, which the masked walk deliberately refuses', () => {
      // The two identifier resolvers disagree ON PURPOSE, and this pins the
      // direction. `isMasked`'s refuses a `let` (a reassignment makes the
      // initializer stop describing what is read — refusing is the safe answer
      // for "is this masked"), while the taint walk accepts one (a reassignable
      // binding is MORE suspicious). `loggedRegionText` is a real `let` bound
      // from a `RAW_MASKERS` entry, so with the `const`-only resolver a bare
      // render of it reported the silenceable verdict — measured in review.
      const base = realSource();
      const pattern = "          `'${this.displayMasked(loggedRegionText, context)}'`";
      const found = scan(base.replace(pattern, "          `'${loggedRegionText}'`")).findings;
      expect(found.map((f) => f.reason)).toEqual(['raw-masker-render']);
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
