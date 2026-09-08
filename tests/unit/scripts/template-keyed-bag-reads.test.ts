/**
 * Tests for `scripts/check-template-keyed-bag-reads.ts` (issue #2802).
 *
 * The checker exists because four review rounds on PR #2777 each surfaced
 * sites the previous round had missed. Its own two failure modes are therefore
 * the subject here, and they need DIFFERENT instruments:
 *
 * - **collapse toward zero** — a checker that stopped parsing reports "no
 *   unguarded accesses" and exits 0, which is byte-identical to a clean tree.
 *   Fenced by per-SHAPE floors (`in` tests, index reads, index writes), never
 *   one aggregate: an aggregate is satisfied while one shape is dead, and the
 *   WRITE shape is exactly the one whose absence let `template-parser.ts` read
 *   clean while `filterResourcesByCondition` was dropping resources.
 * - **collapse toward green** — an `accepted` that is always true leaves every
 *   count identical and only a known-bad INPUT catches it. Fenced by the
 *   synthetic table below AND by the CHECKED-IN pre-sweep sources, which still
 *   carry every site the sweep fixed (measured: 46 findings).
 *
 * The pre-sweep probe is the load-bearing one: per `.claude/rules/testing.md`
 * a synthetic fixture and the checker can share a blind spot, so the FAIL side
 * is proven against real code that really carried the defect. It reads a
 * committed file rather than a git ref — see `PRE_SWEEP_FIXTURE` for the two
 * measured reasons a moving ref was wrong.
 */

import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import {
  findBagAccesses,
  scanRepo,
  SCANNED_FILES,
  ALLOW_MARKER,
  // Imported, never re-declared: a private copy here and the one the BINARY
  // enforces would drift, and CI runs the binary.
  EXAMINED_FLOORS,
  type Shape,
} from '../../../scripts/check-template-keyed-bag-reads.ts';

/**
 * The pre-sweep sources, CHECKED IN rather than read from `origin/main`.
 *
 * Reading a moving ref was wrong twice over, and both were measured: the
 * probe self-DESTRUCTS the moment this merges (`origin/main:<path>` becomes
 * HEAD's content, so the findings drop to zero and main goes red on the merge
 * commit), and it cannot run in CI at all, since `actions/checkout` defaults
 * to `fetch-depth: 1` and no `origin/main` ref exists on a `pull_request` run.
 * A checked-in fixture keeps the property that matters -- this is REAL code
 * that really carried the defect, extracted verbatim at `2a6193c7` -- while
 * being stable and available offline.
 */
const PRE_SWEEP_FIXTURE = 'tests/fixtures/template-keyed-bag-reads/pre-sweep-sites.ts.txt';

describe('check-template-keyed-bag-reads', () => {
  describe('the real tree is clean', () => {
    it('reports no unguarded accesses', () => {
      const { findings } = scanRepo();
      expect(findings.map((f) => `${f.file}:${f.line} ${f.text}`)).toEqual([]);
    });

    it('examines every shape, above its floor', () => {
      const { examined } = scanRepo();
      for (const shape of Object.keys(EXAMINED_FLOORS) as Shape[]) {
        expect
          .soft(examined[shape], `${shape} accesses examined`)
          .toBeGreaterThanOrEqual(EXAMINED_FLOORS[shape]);
      }
    });

    it('scans a LIST of files, each of which exists', () => {
      // A glob would silently pull in a new file, or silently stop matching.
      expect(SCANNED_FILES.length).toBeGreaterThanOrEqual(2);
      for (const file of SCANNED_FILES) {
        expect(() => readFileSync(file, 'utf8')).not.toThrow();
      }
    });
  });

  describe('FAIL probe against real code — the pre-sweep sources', () => {
    const scanFixture = () =>
      findBagAccesses(PRE_SWEEP_FIXTURE, readFileSync(PRE_SWEEP_FIXTURE, 'utf8'));

    it('finds the sites four review rounds took turns to surface', () => {
      const { findings } = scanFixture();
      const texts = findings.map((f) => f.text);

      // One representative per round, in the order the rounds found them.
      expect.soft(texts).toContain('context.resources[logicalId]'); // round 1: resolveRef
      expect.soft(texts).toContain('resource.attributes[attributeName]'); // round 3/4
      expect.soft(texts).toContain('parsed[jsonKey]'); // the secret JSON key
      expect.soft(texts).toContain('template.Resources[logicalId]'); // round 4
      // The WRITE is the site a read-only checker reports clean.
      expect.soft(texts).toContain('filteredResources[logicalId] = resource');

      // And far more than any single round found. Measured 2026-09-08 at 46.
      expect(findings.length).toBeGreaterThanOrEqual(35);
    });

    it('finds all three shapes in the pre-sweep sources', () => {
      const { findings } = scanFixture();
      for (const shape of ['in', 'index-read', 'index-write'] as Shape[]) {
        expect.soft(
          findings.filter((f) => f.shape === shape).length,
          `${shape} findings`
        ).toBeGreaterThanOrEqual(1);
      }
    });

    it('the fixture is not empty or truncated', () => {
      // The vacuous-pass shape: a fixture that stopped being readable would
      // make every assertion above pass with zero findings if they were
      // written as `not.toContain`. They are not — but the fixture's own size
      // is asserted so a truncation fails HERE with a legible reason.
      const text = readFileSync(PRE_SWEEP_FIXTURE, 'utf8');
      expect(text.length).toBeGreaterThan(100_000);
      expect(text).toContain('pre-sweep');
    });
  });

  describe('accept and refuse arms', () => {
    const scan = (body: string) => findBagAccesses('probe.ts', `function f() {\n${body}\n}\n`);
    const findings = (body: string) => scan(body).findings.map((x) => x.text);

    it('refuses a bare read, an `in` test and a bare write', () => {
      expect(findings('const v = bag[name];')).toEqual(['bag[name]']);
      expect(findings('if (name in bag) return 1;')).toEqual(['name in bag']);
      expect(findings('bag[name] = 1;')).toEqual(['bag[name] = 1']);
    });

    it('accepts a read guarded by Object.hasOwn in the same function', () => {
      expect(findings('const v = Object.hasOwn(bag, name) ? bag[name] : undefined;')).toEqual([]);
    });

    it('matches a guard written against a cast form', () => {
      // The guard and the access spell the bag differently; without cast
      // stripping this reported a false positive on the real nested walk.
      expect(
        findings(
          'if (Object.hasOwn(cursor as Record<string, unknown>, part)) { const v = (cursor as Record<string, unknown>)[part]; }'
        )
      ).toEqual([]);
    });

    it('accepts any access on a bag built with Object.create(null)', () => {
      expect(findings('const bag = Object.create(null); bag[name] = 1; const v = bag[name];')).toEqual(
        []
      );
    });

    it('accepts the defineProperty shadow arm, and only in the else of that if', () => {
      expect(
        findings(
          "if (key === '__proto__') { Object.defineProperty(bag, key, { value: v }); } else { bag[key] = v; }"
        )
      ).toEqual([]);
      // The same write WITHOUT the guarded then-branch is still a finding.
      expect(findings("if (other) { g(); } else { bag[key] = v; }")).toEqual(['bag[key] = v']);
    });

    it('accepts an annotated access, and requires a REASON', () => {
      expect(findings(`// ${ALLOW_MARKER}: keys are cdkd-minted\nconst v = bag[name];`)).toEqual([]);
      // A bare marker with no reason does not exempt.
      expect(findings(`// ${ALLOW_MARKER}\nconst v = bag[name];`)).toEqual(['bag[name]']);
      // A marker on the line itself counts too.
      expect(findings(`const v = bag[name]; // ${ALLOW_MARKER}: fine`)).toEqual([]);
    });

    it('finds the marker anywhere in the comment block above, not just one line up', () => {
      // A reason of real length wraps. Counting only the immediately preceding
      // line would teach the next author to shorten the explanation.
      expect(
        findings(`// ${ALLOW_MARKER}: a reason long enough\n// to wrap onto a second line\nconst v = bag[name];`)
      ).toEqual([]);
    });

    it('does not treat a literal key or a positional index as a finding', () => {
      expect(findings("const v = bag['Ref'];")).toEqual([]);
      expect(findings('const v = list[i];')).toEqual([]);
      expect(findings('const v = list[parts.length - 1];')).toEqual([]);
    });

    it('does NOT accept a WRITE on an Object.hasOwn guard', () => {
      // A guard proves the opposite for a write: the write executes when the
      // key is ABSENT, which is exactly when it reaches the inherited setter.
      expect(
        findings('if (Object.hasOwn(bag, key)) { g(); }\nbag[key] = v;')
      ).toEqual(['bag[key] = v']);
    });

    it('treats a COMPOUND assignment as a write, not a read', () => {
      // `+=` / `??=` still go through the setter, so a hasOwn guard must not
      // clear them the way it clears a read.
      for (const op of ['+=', '??=', '||=']) {
        expect
          .soft(findings(`if (Object.hasOwn(bag, key)) { g(); }\nbag[key] ${op} v;`), op)
          .toEqual([`bag[key] ${op} v`]);
      }
    });

    it('requires the defineProperty shadow to target the SAME bag and key', () => {
      expect(
        findings(
          "if (key === '__proto__') { Object.defineProperty(other, 'x', { value: v }); } else { bag[key] = v; }"
        )
      ).toEqual(['bag[key] = v']);
    });

    it('does not accept a write in the THEN branch of the shadow guard', () => {
      // A write there executes exactly when the key IS `__proto__` — the case
      // the shadow exists to divert.
      expect(
        findings(
          "if (key === '__proto__') { Object.defineProperty(bag, key, { value: v }); bag[key] = v; } else { g(); }"
        )
      ).toEqual(['bag[key] = v']);
    });

    it('does not let one function\'s Object.create(null) exempt another\'s bag', () => {
      // The scope walk must stop at the enclosing FUNCTIONS, not reach the
      // source file: one null-prototype `bag` anywhere would otherwise exempt
      // every same-named access in the file.
      const src =
        'function a() { const bag = Object.create(null); bag[name] = 1; }\n' +
        'function b(bag, name) { return bag[name]; }';
      expect(findBagAccesses('probe.ts', src).findings.map((x) => x.text)).toEqual(['bag[name]']);
    });

    it('still exempts a positional key with a qualified receiver', () => {
      // The re-anchoring must not swing into false positives.
      for (const key of ['this.parts.length - 1', 'a.b.length', 'parts.length + 1']) {
        expect.soft(findings(`const v = list[${key}];`), key).toEqual([]);
      }
    });

    it('does not treat a computed key as positional just because it mentions .length', () => {
      // `POSITIONAL_KEY`'s `\.length` was unanchored, so a genuinely
      // template-derived key spelled through an index was exempted.
      expect(findings('const v = bag[keys[keys.length - 1]];')).toEqual([
        'bag[keys[keys.length - 1]]',
      ]);
    });

    it('does not credit Object.create(null) from a DIFFERENT declaration of the same name', () => {
      // Two `out` bindings in one function: only one is null-prototype, and
      // the other must not inherit its exemption.
      expect(
        findings('const out: unknown[] = new Array(2);\nout[key] = v;\nconst out = Object.create(null);')
      ).toEqual(['out[key] = v']);
    });

    it('THROWS on input it cannot parse, rather than reporting it clean', () => {
      // A file that did not parse contributes zero accesses, which is
      // byte-identical to a clean one.
      expect(() => findBagAccesses('broken.ts', 'function f( {')).toThrow(/did not parse/);
    });

    it('counts what it examined even when it accepts', () => {
      // The coverage half: an accepted access must still be COUNTED, or the
      // floors above could be cleared by a checker that skips everything.
      const report = scan('const v = Object.hasOwn(bag, name) ? bag[name] : undefined;');
      expect(report.findings).toEqual([]);
      expect(report.examined['index-read']).toBeGreaterThanOrEqual(1);
    });
  });
});
