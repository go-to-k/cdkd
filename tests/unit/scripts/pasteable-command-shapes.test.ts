/**
 * The pasteable-command SHAPE fence's own test — and its CI enforcement.
 *
 * `scripts/check-pasteable-command-shapes.ts` has no `vp run` task and no
 * `ci.yml` step, the shape `check-source-control-bytes.ts` and
 * `check-verification-depth-rule.ts` use: this file IS what blocks a
 * regression. So it has to do three separate jobs, and the repo's rule in
 * `.claude/rules/testing.md` is that each needs its own instrument —
 *
 *  1. prove the classifier SEES its input (floors, per SHAPE);
 *  2. prove it still REJECTS a violation (real-code probes, not only planted
 *     fixtures, because a checker and its fixtures can share a blind spot);
 *  3. prove it does not report everything (the script's own self-probes, whose
 *     negative cases a floor cannot replace).
 */

import { describe, expect, it } from 'vite-plus/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript-v6';
import {
  EXEMPTIONS,
  sourceFiles,
  FLOORS,
  blankInertText,
  SELF_PROBE_CASES,
  applyExemptions,
  checkPasteableCommandShapes,
  scanSource,
  type PasteableShape,
} from '../../../scripts/check-pasteable-command-shapes.js';

/**
 * The EXTERNAL bound on every spawned run of the critic.
 *
 * It is what turns a non-terminating walk into a FAILURE. Vitest's own timeout
 * runs on the same event loop, so a synchronous infinite loop inside the
 * classifier hangs the worker rather than failing the case — review measured
 * exactly that against the `close !== -1` fall-through, whose mutant loops
 * forever. `spawnSync`'s `timeout` kills the CHILD, so the binary's own
 * self-probes (one of which carries an unterminated backtick inside double
 * quotes) are what reach the looping arm. It is the PIN for that mutant, not a
 * backstop: measured, the mutant visits the same index forever, so nothing on
 * this worker's event loop can report it. Every spawn carries the bound,
 * including the dirty-tree one — review found that one still without it.
 */
const SPAWN_TIMEOUT_MS = 90_000;

/**
 * Resolved from THIS FILE, never from `process.cwd()`. A relative `'src'` read
 * correctly in isolation and under-counted in the full suite — a floor test
 * that depends on who ran it is a floor test that attests to nothing.
 */
const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

/**
 * The repo root, passed as every spawn's `cwd`.
 *
 * The critic's default root is the RELATIVE `'src'`, so a spawned run inherits
 * whatever directory the suite happens to start in — which is the cwd-dependence
 * the file's own header records for the in-process scan and which review found
 * still live for the CHILD: launching the absolute script path from `/tmp`
 * dies with `ENOENT: scandir 'src'`. Pinning `cwd` is what makes every
 * default-root case below attest to THIS tree.
 */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * ONE scan of the real tree, shared by every case that needs it.
 *
 * Scanning 358 files parses 358 sources, which is seconds under load — three
 * cases each doing it independently blew Vitest's 5 s IN-PROCESS default and
 * failed as a timeout, green in isolation and red in the full suite. The cases
 * below still declare a generous bound of their own, because its job is to stop
 * a HANG rather than to police latency.
 */
let cachedReport: ReturnType<typeof checkPasteableCommandShapes> | undefined;
function realTree(): ReturnType<typeof checkPasteableCommandShapes> {
  cachedReport ??= checkPasteableCommandShapes(SRC);
  return cachedReport;
}

/** The shapes a source produces, sorted, for a compact comparison. */
function shapesOf(source: string): PasteableShape[] {
  return scanSource('probe.ts', source)
    .findings.map((f) => f.shape)
    .sort();
}

/** A scratch tree holding one file, for the real-code probes. */
function withScratch<T>(relativePath: string, contents: string, run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'cdkd-pasteable-fence-'));
  try {
    const full = join(root, relativePath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents, 'utf8');
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('pasteable-command shape fence — the classifier sees its input', () => {
  it('clears every per-SHAPE floor over the real tree', () => {
    const report = realTree();
    // Per SHAPE, not one aggregate. `spansExamined` can stay high while the
    // command-literal walk dies and the total still clears a grand floor, so a
    // single number would hide exactly one dead recognizer.
    expect(report.filesScanned).toBeGreaterThanOrEqual(FLOORS.filesScanned);
    expect(report.spansExamined).toBeGreaterThanOrEqual(FLOORS.spansExamined);
    expect(report.commandLiteralsExamined).toBeGreaterThanOrEqual(FLOORS.commandLiteralsExamined);
  }, 60_000);

  it('states the real magnitudes SEPARATELY from the floors', () => {
    // The floors are constants the fence itself exports, so asserting the run
    // against them is circular: zeroing all three leaves this file green. These
    // are independent literals — if the scope silently stops matching, this
    // fails with `FLOORS` untouched. Measured 2026-09-25 at 361 / 1423 / 868,
    // after a rebase onto a `main` that removed cdkd's own quotes from around
    // displayed identifiers (go-to-k/cdkd#3658): the SPAN count fell while the
    // other two rose, which is the shape of that change and not of a narrowing.
    // Both non-file magnitudes moved DOWN during review without the scan
    // narrowing: a duplicate visit of nested literals was removed, and folding
    // `+` runs merges several literals into the one command literal they
    // spell — which is the command counter's whole subject.
    const report = realTree();
    expect(report.filesScanned).toBeGreaterThan(340);
    expect(report.spansExamined).toBeGreaterThan(1300);
    expect(report.commandLiteralsExamined).toBeGreaterThan(800);
  }, 60_000);

  it('visits a nested literal ONCE, not twice', () => {
    // Review's finding: the template walk visited each interpolated
    // expression's CHILDREN and then the expression itself, so a literal inside
    // an interpolation was considered twice — duplicate findings, and both
    // floors inflated by whatever the tree happens to nest. Counting is the
    // only instrument that sees it; a findings assertion would not, since the
    // outer literal here carries none.
    const nested = scanSource('probe.ts', "const m = `outer ${f(`'a' 'b'`)} tail`;");
    // Two quoted spans in the nested literal, seen once.
    expect(nested.spans).toBe(2);
  });

  it('substitutes a DECODED NUL rather than refusing the file', () => {
    // The raw-source refusal was necessary and not sufficient — TypeScript
    // decodes `\\u0000` into `node.text` — but refusing on the decoded form made
    // the fence unrunnable: `src/deployment/deploy-engine.ts` uses exactly that
    // separator for its export-index keys, in three live literals.
    //
    // The premise is taken from the PARSED file, not from a substring of its
    // source. Review measured the earlier form: replacing every live separator
    // with `|` and leaving a `// historical separator: \\u0000` comment behind
    // kept it green, so it pinned a spelling anywhere in the file rather than a
    // decoded NUL in a literal.
    const real = readFileSync(join(SRC, 'deployment/deploy-engine.ts'), 'utf8');
    const parsed = ts.createSourceFile(
      'deploy-engine.ts',
      real,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    let literalsCarryingNul = 0;
    const walk = (node: ts.Node): void => {
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
        if (node.text.includes('\u0000')) literalsCarryingNul++;
      } else if (ts.isTemplateExpression(node)) {
        const texts = [node.head.text, ...node.templateSpans.map((sp) => sp.literal.text)];
        if (texts.some((t) => t.includes('\u0000'))) literalsCarryingNul++;
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(parsed, walk);
    expect(
      literalsCarryingNul,
      'the premise moved — no literal in deploy-engine decodes to a NUL any more'
    ).toBeGreaterThan(0);
    expect(() => scanSource('deployment/deploy-engine.ts', real)).not.toThrow();
  }, 30_000);

  it('blanks a message to exactly its own length, unterminated runs included', () => {
    // The callers slice `blankInertText`'s output by the offsets of the
    // UNBLANKED text, so a one-character drift silently points every later
    // finding at the wrong span. Two clauses exist only to hold this invariant
    // and NEITHER can change a verdict — a lone trailing delimiter has nothing
    // after it to shift, and the `close !== -1` fall-through is what keeps the
    // walk advancing at all rather than re-entering at the same index.
    //
    // It runs in an externally bounded CHILD, not in this worker, and review
    // had to correct me twice to get here. The `close !== -1` mutant does NOT
    // terminate: with no closer, `i = close + 1` resets the enclosing walk to
    // 0 and the same index is visited forever — I claimed it terminated on the
    // strength of a run whose failures were the SPAWNED cases being killed,
    // which is exactly the "do not report a probe you did not run" shape.
    // Vitest's timeout runs on this worker's event loop, so a synchronous loop
    // hangs the case rather than failing it; `spawnSync`'s `timeout` kills a
    // child, so the check has to BE one.
    const child = mkdtempSync(join(tmpdir(), 'cdkd-pasteable-len-'));
    try {
      const fence = fileURLToPath(
        new URL('../../../scripts/check-pasteable-command-shapes.ts', import.meta.url)
      );
      const runner = join(child, 'length.mjs');
      writeFileSync(
        runner,
        `import { blankInertText } from ${JSON.stringify(fence)};\n` +
          `const corpus = JSON.parse(process.argv[2]);\n` +
          `for (const input of corpus) {\n` +
          `  const out = blankInertText(input);\n` +
          `  if (out.length !== input.length) {\n` +
          `    process.stderr.write('LENGTH ' + JSON.stringify(input) + ' -> ' + out.length + '\\n');\n` +
          `    process.exit(1);\n` +
          `  }\n` +
          `}\n` +
          `process.stdout.write('LENGTH OK\\n');\n`,
        'utf8'
      );
      const corpus = [
        '',
        '"',
        "'",
        '`',
        'Run cdkd deploy <stack> --all',
        "Run cdkd deploy '<stack>' --all",
        'Run cdkd deploy "unterminated',
        "Run cdkd deploy 'unterminated",
        'Run `cdkd deploy <stack>',
        'Run "`cdkd deploy <stack> --all`"',
        // Unterminated backtick inside double quotes: the `close !== -1` arm.
        'Run "`cdkd deploy <stack> --all"',
        String.raw`Run "literal \`cdkd events <stack>\`"`,
        String.raw`Run cdkd deploy 'O'\''Brien' --resource <id>`,
        "The record's name is odd, and the stack's region too.",
        'a "b `c \'d` e" f `g',
        // An unterminated double-quoted run ending in ONE backslash, and in
        // two: without `Math.min`, the escape step consumes two fill characters
        // for the one character left and the output grows by one.
        'Run "cdkd deploy \\',
        'Run "cdkd deploy \\\\',
      ];
      const run = spawnSync(process.execPath, [runner, JSON.stringify(corpus)], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        cwd: REPO_ROOT,
      });
      // A non-zero OR null status both count: the non-terminating mutant is
      // either killed by `timeout` or dies first exhausting the heap on its
      // unbounded accumulator (measured at ~15 s). What matters is that the
      // failure REACHES this worker, which a hang would not.
      expect(run.status, `blankInertText did not finish or drifted: ${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('LENGTH OK');
    } finally {
      rmSync(child, { recursive: true, force: true });
    }
  }, 180_000);

  it('refuses a file it cannot read rather than skipping it', () => {
    // A parse failure contributes zero findings, which reads exactly like a
    // clean file. Both refusals are the same decision.
    expect(() => scanSource('broken.ts', 'const x = (;')).toThrow(/did not parse/);
    expect(() => scanSource('nul.ts', `const x = "a${String.fromCharCode(0)}b";`)).toThrow(/literal NUL/);
  });
});

describe('pasteable-command shape fence — it still rejects each shape', () => {
  it('flags a quoted cdkd command carrying an interpolation', () => {
    expect(shapesOf("const m = `Run 'cdkd deploy ${name}' to migrate.`;")).toEqual([
      'quoted-command',
    ]);
  });

  it('flags a span assembled from two holes — the hintFor shape', () => {
    expect(shapesOf("const m = t.map((x) => `'${command} ${x}'`);")).toEqual([
      'quoted-interpolation',
    ]);
  });

  it('flags a gated command re-wrapped in quotes by hand', () => {
    // The regression this fence most expects: taking `pasteableCommand`'s
    // result — every value gated, every hole quoted — and putting it back
    // inside a prose `'...'` span, which throws all of that away.
    expect(shapesOf("const m = `'${pasteableCommand(v, a).command} ${tail}'`;")).toEqual([
      'quoted-interpolation',
    ]);
  });

  it('flags a bare hole with a flag after it', () => {
    expect(shapesOf('const m = `Run cdkd force-unlock <stack> --stack-region <region>`;')).toEqual([
      'open-hole',
    ]);
  });
});

describe('pasteable-command shape fence — it does not report everything', () => {
  // There is deliberately NO in-process `expect(runSelfProbes()).toEqual([])`
  // case here, and its absence is the point. The probe set carries a source
  // with an unterminated backtick inside double quotes, which is what reaches
  // `blankInsideDoubleQuotes`'s termination guard — so a mutant dropping that
  // guard would HANG this worker rather than fail it, and Vitest's timeout
  // cannot interrupt a synchronous loop. Review found this second, unbounded
  // entry point after the length check had already been moved out. The spawned
  // case below asserts the same thing with an external bound, and its
  // `clean.stderr` message carries the failing probe's own label, so nothing
  // is lost by not calling it here.

  it('consults those probes from the SPAWNED binary, not only from this file', () => {
    // SPAWNED, because calling `runSelfProbes` here proves only that the
    // function works. The thing that has to hold is that the shipped entry
    // point still CALLS it before reading the tree -- and a review of an
    // earlier revision of this file found exactly that gap: the critic had no
    // entry point at all, so the seam proved nothing about enforcement.
    const script = fileURLToPath(
      new URL('../../../scripts/check-pasteable-command-shapes.ts', import.meta.url)
    );
    const clean = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      cwd: REPO_ROOT,
    });
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain('0 findings');

    const forced = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      cwd: REPO_ROOT,
      env: { ...process.env, CDKD_SELF_PROBE_FORCE_FAIL: '1' },
    });
    // Exit 2, not 1: "the critic is broken" and "the tree is dirty" are
    // different verdicts and the binary keeps them apart.
    expect(forced.status).toBe(2);
    expect(forced.stderr).toContain('forced by CDKD_SELF_PROBE_FORCE_FAIL');
  }, 120_000);

  it('exits 2 when the DEFAULT root does not clear a floor', () => {
    // The other half of the floor decision, and the one a probe showed was
    // unpinned: disabling enforcement entirely left every case green, because
    // the real tree always clears the floors and the scratch-root case does
    // not consult them. This raises a floor above the real tree instead, which
    // is the only way to observe enforcement without breaking the scan.
    const script = fileURLToPath(
      new URL('../../../scripts/check-pasteable-command-shapes.ts', import.meta.url)
    );
    const raised = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      cwd: REPO_ROOT,
      env: { ...process.env, CDKD_PASTEABLE_FLOOR_FILES: '999999' },
    });
    expect(raised.status).toBe(2);
    expect(raised.stderr).toContain('floor not met');
  }, 120_000);

  it('exits 2 when EACH floor clause is raised above the tree, one at a time', () => {
    // Review's finding: only the FILE floor had a seam, so deleting either of
    // the other two clauses reddened nothing and two thirds of the "per SHAPE,
    // not one aggregate" claim was itself unpinned. One seam per clause, raised
    // ALONE, so each clause is separately load-bearing.
    const script = fileURLToPath(
      new URL('../../../scripts/check-pasteable-command-shapes.ts', import.meta.url)
    );
    for (const seam of [
      'CDKD_PASTEABLE_FLOOR_FILES',
      'CDKD_PASTEABLE_FLOOR_SPANS',
      'CDKD_PASTEABLE_FLOOR_COMMANDS',
    ]) {
      const raised = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        cwd: REPO_ROOT,
        env: { ...process.env, [seam]: '999999' },
      });
      expect(raised.status, `${seam} did not fail the run: ${raised.stderr}`).toBe(2);
      expect(raised.stderr).toContain('floor not met');
    }
  }, 180_000);

  it('REFUSES a floor seam that is not a number, on EVERY seam, with exit 2', () => {
    // Parameterized over all three seams (M9-M16 proxy pass): the first cut
    // drove only SPANS, and deleting either of the other two
    // `=== undefined` branches left the run printing the error and exiting 0
    // -- a broken seam silently disabling the floor it was meant to exercise.
    // And `toBe(2)`, not `not.toBe(0)` (M14 of the review): the first cut
    // THREW, and an uncaught throw exits 1, the "tree is dirty" verdict.
    const script = fileURLToPath(
      new URL('../../../scripts/check-pasteable-command-shapes.ts', import.meta.url)
    );
    for (const seam of [
      'CDKD_PASTEABLE_FLOOR_FILES',
      'CDKD_PASTEABLE_FLOOR_SPANS',
      'CDKD_PASTEABLE_FLOOR_COMMANDS',
    ]) {
      const bad = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        cwd: REPO_ROOT,
        env: { ...process.env, [seam]: 'lots' },
      });
      expect(bad.status, `${seam}=lots did not exit 2: ${bad.stdout}${bad.stderr}`).toBe(2);
      expect(bad.stderr).toContain(`${seam}=lots`);
    }
  }, 240_000);

  it('actually COMPARES each probe verdict, not merely runs the probes', () => {
    // `CDKD_SELF_PROBE_FORCE_FAIL` does not short-circuit the loop — review
    // corrected that — but the assertion on it passes whether or not the
    // verdicts are compared, so it proves the binary CALLS the probes and
    // nothing more. Measured: replacing the comparison with `false` left the
    // spawned test green. This seam appends a case whose expectation is
    // knowingly wrong, which only a live comparison can report.
    const script = fileURLToPath(
      new URL('../../../scripts/check-pasteable-command-shapes.ts', import.meta.url)
    );
    const injected = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      cwd: REPO_ROOT,
      env: { ...process.env, CDKD_SELF_PROBE_INJECT_MISMATCH: '1' },
    });
    expect(injected.status, injected.stderr).toBe(2);
    expect(injected.stderr).toContain('injected control');
    // And the message names the DISAGREEMENT, not just the label -- a failure
    // reporting only "a probe failed" cannot tell the arms apart.
    expect(injected.stderr).toMatch(/expected \[\], got \[quoted-command\]/);
  }, 120_000);

  it('exits 1 when the LIVE exemption goes stale against a --root= tree', () => {
    // M14 of the review: dropping `|| report.staleExemptions.length > 0` from
    // `main` survived every case, because the real tree never makes the live
    // entry stale. A scratch root that lacks the entry's file does, and the
    // binary must refuse it with exit 1 -- the "tree is dirty" verdict, since
    // an exemption outliving its target is a dirt of the tree's own making.
    expect(EXEMPTIONS.length, 'this case needs a live entry to make stale').toBeGreaterThan(0);
    const script = fileURLToPath(
      new URL('../../../scripts/check-pasteable-command-shapes.ts', import.meta.url)
    );
    const root = mkdtempSync(join(tmpdir(), 'cdkd-pasteable-stale-'));
    try {
      writeFileSync(join(root, 'clean.ts'), 'export const m = `nothing to see`;\n', 'utf8');
      const stale = spawnSync(process.execPath, [script, `--root=${root}`], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        cwd: REPO_ROOT,
      });
      expect(stale.status, stale.stderr).toBe(1);
      expect(stale.stderr).toContain('stale exemption');
      expect(stale.stderr).toContain(EXEMPTIONS[0]!.file);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('exits 1 when the LIVE exemption covers TWO findings in a --root= tree', () => {
    // M11 through the binary: the entry is reproduced at its own path with
    // its target literal written TWICE, so one entry matches two findings.
    expect(EXEMPTIONS.length, 'this case needs a live entry to overmatch').toBeGreaterThan(0);
    const entry = EXEMPTIONS[0]!;
    const script = fileURLToPath(
      new URL('../../../scripts/check-pasteable-command-shapes.ts', import.meta.url)
    );
    const root = mkdtempSync(join(tmpdir(), 'cdkd-pasteable-over-'));
    try {
      const target = join(root, entry.file);
      mkdirSync(join(target, '..'), { recursive: true });
      // Two prose-quoted `cdkd import` commands carrying an interpolation,
      // both containing the entry's `contains` prefix.
      writeFileSync(
        target,
        "export const a = `Repair ('cdkd import <stack> --resource ${id}=<p> --force').`;\n" +
          "export const b = `Repair ('cdkd import <stack> --resource ${id}=<p> --force').`;\n",
        'utf8'
      );
      const over = spawnSync(process.execPath, [script, `--root=${root}`], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        cwd: REPO_ROOT,
      });
      expect(over.status, over.stderr).toBe(1);
      expect(over.stderr).toContain('overmatched exemption');
      // The verdict must be the OVERMATCH's alone (round-65 proxy finding). A
      // second live entry whose file is absent from this scratch tree would go
      // stale and produce exit 1 by itself, masking removal of the overmatch
      // clause while its diagnostic still printed. So: no stale entry, and no
      // ordinary finding either -- both sites here are matched by the entry,
      // which is the premise, and a surviving finding would mean it was not.
      expect(over.stderr).not.toContain('stale exemption');
      // Filename-AGNOSTIC (round-66 proxy finding): a guard keyed on
      // `export.ts` alone would let an ordinary finding in a sibling file
      // supply the exit 1 unnoticed. Any `<file>:<line> [<shape>]` diagnostic
      // is an ordinary finding, whatever file it names -- and the in-process
      // scan of the same root says the same thing from the other side.
      expect(over.stderr).not.toMatch(
        /^\S+:\d+ \[(quoted-command|quoted-interpolation|open-hole)\]/m
      );
      expect(checkPasteableCommandShapes(root).findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('exits 1 -- not 2 -- for a DIRTY tree, naming the site', () => {
    // The third arm, and the one that makes the 1-vs-2 split mean something.
    // Review of an earlier revision noted the test asserted 0 and 2 while the
    // body claimed all three; a distinction nothing exercises is a distinction
    // a later edit can collapse for free.
    //
    // `--root=` points at a scratch tree rather than `src`, so this never
    // depends on the real tree being dirty -- which it is not, and must not be.
    const script = fileURLToPath(
      new URL('../../../scripts/check-pasteable-command-shapes.ts', import.meta.url)
    );
    const root = mkdtempSync(join(tmpdir(), 'cdkd-pasteable-dirty-'));
    try {
      writeFileSync(
        join(root, 'probe.ts'),
        "export const m = `Run 'cdkd deploy ${name}' to migrate.`;\n",
        'utf8'
      );
      const dirty = spawnSync(process.execPath, [script, `--root=${root}`], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        cwd: REPO_ROOT,
      });
      // 2 would mean the FLOORS refused a one-file tree before the findings
      // were reached, so this also pins that the floors are not consulted in a
      // way that masks a real finding.
      expect(dirty.status, dirty.stderr).toBe(1);
      expect(dirty.stderr).toContain('quoted-command');
      expect(dirty.stderr).toContain('probe.ts');
      // ...and the floors were SKIPPED rather than silently met: a scratch
      // tree of one file cannot clear them, so a run that enforced them would
      // have said so on stderr and exited 2.
      expect(dirty.stderr).not.toContain('floor not met');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('carries an accept AND a NEAR-MISS negative for each shape', () => {
    // What this has to pin is that BOTH degenerate classifiers fail the set:
    // one reporting nothing (the accepts catch it) and one reporting
    // everything (the negatives do). An earlier version asserted a simple
    // MAJORITY of negatives, which went false the moment real accept arms were
    // added and said nothing about coverage anyway.
    //
    // A near-miss is a negative whose source carries the shape's own TRIGGER
    // and still must not fire — the only kind that constrains a
    // report-everything classifier per shape. The triggers are spelled here
    // rather than imported so a widened recognizer cannot widen its own test.
    const TRIGGERS = {
      'quoted-command': (src: string) => src.includes("'") && /cdkd [a-z]/.test(src),
      'quoted-interpolation': (src: string) => src.includes("'") && src.split('${').length > 2,
      'open-hole': (src: string) => /<[A-Za-z][A-Za-z0-9_-]*>/.test(src),
    } as const;

    const negatives = SELF_PROBE_CASES.filter((c) => c.expect.length === 0);
    expect(negatives.length, 'a set with no negatives cannot fail a report-everything classifier')
      .toBeGreaterThan(0);

    for (const [shape, carriesTrigger] of Object.entries(TRIGGERS)) {
      expect(
        SELF_PROBE_CASES.some((c) => c.expect.includes(shape as PasteableShape)),
        `no accept case for ${shape}`
      ).toBe(true);
      expect(
        negatives.some((c) => carriesTrigger(c.source)),
        `no NEAR-MISS negative for ${shape} — a report-everything classifier survives it`
      ).toBe(true);
    }
  });

  it('leaves a quoted DISPLAY value alone', () => {
    // `'${stackName}'` is go-to-k/cdkd#3232's class and vastly outnumbers the
    // real findings. Reporting it here would bury every one, so the two-hole
    // floor is load-bearing rather than an optimisation — and this is the case
    // that would red if someone relaxed it. (The name carried a count of 944
    // until review; the critic and I measured that population differently and
    // neither number was reproducible, so it is gone rather than shipped.)
    expect(shapesOf("const m = `Stack '${stackName}' has no region.`;")).toEqual([]);
    expect(shapesOf("const m = `docker cp into '${id}:${dir}' failed`;")).toEqual([]);
  });

  it('leaves a hole inside quotes alone, wherever the quotes sit', () => {
    // `'<stack>'` is the REMEDY. A fence that reported it would be telling
    // callers to undo go-to-k/cdkd#3363's fix.
    expect(
      shapesOf("const m = `Migrate with: cdkd deploy '<stack>' --stack-region '<region>'`;")
    ).toEqual([]);
    // Review's finding: the first version passed the line above only because
    // each hole is followed IMMEDIATELY by its closing quote, so the regex's
    // "words after it" clause happened to miss. A hole, a space and a flag
    // inside ONE quoted run was reported, though nothing there redirects.
    expect(shapesOf("const m = `Run cdkd deploy '<stack> --all'`;")).toEqual([]);
    // ...and a command is not joined to a later quoted phrase across the prose
    // between them, which is how the pairing used to swallow a whole sentence.
    expect(
      shapesOf("const m = `Run 'cdkd state list'. The '<name> value' is required.`;")
    ).toEqual([]);
  });

  it('is not truncated by an ESCAPED quote inside a double-quoted run', () => {
    // `displayIdent` renders through `JSON.stringify`, so a value carrying a
    // quote reaches the message as `\\"`. Closing the run there left the real
    // closer looking unmatched, truncated the command, and hid the hole after
    // it — the fence going quiet on exactly the shape it exists for.
    expect(shapesOf('const m = `Run cdkd deploy "a\\\\"b" --resource <id> --force`;')).toEqual([
      'open-hole',
    ]);
  });

  it('leaves a hole and a verb in different sentences alone', () => {
    // Both directions of the command-TAIL bound, because each is rejected by a
    // different half of it. First: the hole precedes the verb, so slicing from
    // the verb drops it. Second: the verb comes first and the hole follows a
    // sentence end, so only the END bound rejects it — and without this case
    // removing that bound reds nothing (measured).
    expect(
      shapesOf('const m = `Pass --state-bucket <name> (cdkd deploy uses the same bucket).`;')
    ).toEqual([]);
    expect(
      shapesOf('const m = `Run cdkd deploy MyStack. Then pass --resource <id> --force by hand.`;')
    ).toEqual([]);
  });
});

describe('pasteable-command shape fence — concatenated literals are FOLDED', () => {
  it('classifies a command split across a `+` run exactly as the single literal', () => {
    // This was recorded as a stated BOUND until review, on the grounds that the
    // site was still reported as `open-hole` and only its classification was
    // lost. Both halves stopped holding once a quoted run stopped being scanned
    // for holes: the concatenated form then reported NOTHING. Folding it found
    // `export.ts`'s `buildImportPlan` refusal, a real site three PRs of this
    // lane had walked past.
    const concatenated =
      "const m = `Repair with 'cdkd import <stack> --resource ` + `${id}=<physicalId> --force';`;";
    const single = "const m = `Repair with 'cdkd import <stack> --resource ${id}=<physicalId> --force';`;";

    // Same command, written two ways, and the SAME verdict either way — which
    // is the whole point of the fold. It is `quoted-command` alone: the hole
    // sits inside the prose quotes, which this fence treats as taken WITH the
    // span (see `blankInertText`'s single-quote arm for the disagreement that
    // model has with M7, and the three measured false positives that stopped
    // me approximating around it).
    expect(shapesOf(single)).toEqual(['quoted-command']);
    expect(shapesOf(concatenated)).toEqual(['quoted-command']);
  });

  it('treats a NON-literal operand of the run as an interpolation', () => {
    // `\`...\` + value + \`...\`` interpolates `value` between two literals, so
    // it is a hole — which is what makes the mixed run work without a second
    // code path.
    expect(shapesOf("const m = `Run 'cdkd deploy ` + name + `' to migrate.`;")).toEqual([
      'quoted-command',
    ]);
  });

  it('folds a run with NO literal to holes, which is the same nothing', () => {
    // Renamed and re-explained after review. This used to be called "leaves
    // ARITHMETIC alone" and was read as pinning an early return for a run
    // carrying no literal. It pinned no such thing: that guard's mutant
    // SURVIVED, because a run of holes carries no quote and no verb and yields
    // nothing either way. The guard is gone and this states what is true.
    expect(shapesOf('const n = a + 1 + b;')).toEqual([]);
    // Same run with a literal that DOES spell a command still reports, so the
    // case above cannot pass by the fold having stopped working. The quote
    // opens after a SPACE on purpose: an apostrophe sitting directly between an
    // interpolation and a letter is read as a possessive (`${want}'s`), which
    // is the heuristic's stated cost and not what this control is about.
    expect(shapesOf("const m = a + `Run 'cdkd deploy ${x}' now` + b;")).toEqual([
      'quoted-command',
    ]);
  });

  it('does not pair an English APOSTROPHE across the folded run', () => {
    // The fold's cost, and the heuristic that pays it: merging a `+` run makes
    // spans long enough that a possessive starts pairing with one several
    // sentences away. Measured at eight false `quoted-command` findings across
    // `src/`, every one bracketed by two possessives — including one on an
    // interpolated value, which is why a HOLE counts as a word character too.
    expect(
      shapesOf(
        "const m = `The bucket's region is ${actual}, ` + `so cdkd deploy cannot adopt ${want}'s bucket.`;"
      )
    ).toEqual([]);
    // CONTROL: a real quoted command in the same folded shape IS reported, so
    // the case above cannot pass by the fold having stopped working.
    expect(
      shapesOf("const m = `The bucket's region is wrong. Run 'cdkd ` + `deploy ${want}' first.`;")
    ).toEqual(['quoted-command']);
  });
});

describe('pasteable-command shape fence — real code, not only fixtures', () => {
  // A synthetic fixture encodes the author's mental model, so a checker and its
  // tests can share a blind spot. Each probe here introduces the shape into a
  // copy of a REAL message from this repo and requires the fence to name it.

  it('flags the re-wrap regression applied to the REAL asset-storage remedy', () => {
    // The repo's rule is that a real-code probe reintroduces the violation into
    // REAL repo code, and review was right that the probes below fall short of
    // it: they are hand-typed transcriptions of real messages, so a
    // transcription that drifted would keep passing. This one READS the
    // production file, asserts the line it mutates is still there, applies the
    // regression, and requires a non-zero verdict on the result.
    const path = join(SRC, 'assets/asset-storage.ts');
    const real = readFileSync(path, 'utf8');
    const anchor = '`\\nBootstrap with: ${bootstrapUnique.command}`';
    expect(
      real.includes(anchor),
      'the anchor moved — re-derive this probe from the current asset-storage.ts'
    ).toBe(true);

    // Unmutated, the real file is clean: without this the probe below passes on
    // a fence that reports the gated form too.
    expect(scanSource('assets/asset-storage.ts', real).findings).toEqual([]);

    // The regression itself — the gated result put back inside a prose `'...'`
    // span with a second interpolation, which is what go-to-k/cdkd#3499 removed.
    const mutated = real.replace(
      anchor,
      "`\\nRun '${bootstrapUnique.command} ${want}' to fix it.`"
    );
    expect(mutated, 'the replacement did not apply').not.toBe(real);
    expect(scanSource('assets/asset-storage.ts', mutated).findings.map((f) => f.shape)).toContain(
      'quoted-interpolation'
    );
  }, 30_000);

  it('flags the go-to-k/cdkd#3363 shape reintroduced into a real refusal', () => {
    const real =
      'export function f(stackName: string): string {\n' +
      '  return `Stack has only a legacy state record without a region. ' +
      "Run 'cdkd deploy ${stackName}' to migrate it.`;\n" +
      '}\n';
    const report = withScratch('cli/commands/probe.ts', real, (root) =>
      checkPasteableCommandShapes(root)
    );
    expect(report.findings.map((f) => f.shape)).toContain('quoted-command');
    expect(report.findings[0]?.file).toBe('cli/commands/probe.ts');
  });

  it('flags the hintFor shape reintroduced into a real recovery hint', () => {
    const real =
      'export function hintFor(command: string, targets: string[], label: string): string {\n' +
      "  return targets.map((t) => `\\n${label}: '${command} ${t}'`).join('');\n" +
      '}\n';
    const report = withScratch('cli/commands/probe.ts', real, (root) =>
      checkPasteableCommandShapes(root)
    );
    expect(report.findings.map((f) => f.shape)).toContain('quoted-interpolation');
  });

  it('goes GREEN on the same hint built the gated way', () => {
    // The control. Without it the probe above passes on a fence that reports
    // every `hintFor`, gated or not — and the gated form is what #3499 shipped.
    const fixed =
      'export function hintFor(command: string, targets: string[], label: string): string {\n' +
      '  return targets\n' +
      "    .map((t) => `\\n${label}: ${pasteableCommand(command, [{ value: t, hole: 'stack' }]).command}`)\n" +
      '    .join("");\n' +
      '}\n';
    const report = withScratch('cli/commands/probe.ts', fixed, (root) =>
      checkPasteableCommandShapes(root)
    );
    expect(report.findings).toEqual([]);
  });
});

describe('pasteable-command shape fence — the tree is CLEAN, and stays clean', () => {
  it('reports ZERO findings across src/', () => {
    // This is the assertion that makes the fence a fence rather than a report.
    // Every site it found is fixed in this PR except ONE, which is EXEMPT
    // rather than fixed -- an `export.ts` own-copy gate the maintainer asked
    // to land in a follow-up PR. `findings` is what survives the exemptions,
    // so this asserts zero NON-EXEMPT findings; the case below is what keeps
    // the exempt one honest. Any new site reds here by
    // name — which is the whole point of keying on a SHAPE: nobody has to know
    // what the next author calls their gate.
    const report = realTree();
    expect(
      report.findings.map((f) => `${f.file}:${f.line} ${f.shape} ${f.excerpt}`),
      'a pasteable command in a prose quoted span, assembled from holes, or with a bare <hole> followed by words'
    ).toEqual([]);
  }, 60_000);
});

describe('pasteable-command shape fence — exemptions cannot go stale', () => {
  it('every LIVE exemption names a file the scan reads, and none is stale', () => {
    // Asserted on the LIST, not only on `staleExemptions`: a non-empty list
    // whose entries all MATCH also reports no stale ones, so the `[]`
    // comparison alone was satisfied by two different worlds.
    //
    // The list is no longer empty. Each entry is a go-to-k/cdkd#3436 own-copy
    // gate the maintainer asked to land in a follow-up PR rather than widen
    // this one, and an exemption is how that decision stays on the record
    // instead of becoming a blind spot — when the gate lands the entry goes
    // STALE and the run refuses until it is deleted.
    // TWO assertions this case used to carry are gone, both for the same
    // reason: they pinned something other than what they claimed.
    //
    // No assertion on the `why` PROSE — a minimum length plus a substring,
    // which the repo's "no fences on prose" rule forbids and which padding
    // passed anyway. And no CARDINALITY assertion: requiring a non-empty list
    // would make the documented cleanup (fix the deferred site, delete its
    // entry) fail a test, which is a fence holding a defect in place.
    //
    // What is left is BEHAVIOUR about each entry that EXISTS — it names a file
    // the scan actually reads, and it is not stale — and zero entries
    // satisfies it.
    const scanned = new Set(sourceFiles(SRC).map((f) => relative(SRC, f).split(sep).join('/')));
    for (const e of EXEMPTIONS) {
      expect(scanned.has(e.file), `${e.file} is exempt but the scan never reads it`).toBe(true);
    }
    // ...and none of them is stale against the tree as it ships.
    expect(realTree().staleExemptions).toEqual([]);
  }, 60_000);

  it('matches a live exemption and REPORTS one whose target is gone', () => {
    const findings = scanSource(
      'cli/commands/probe.ts',
      'const m = `Run cdkd force-unlock <stack> --stack-region <region>`;'
    ).findings;
    expect(findings).toHaveLength(1);

    const live = {
      file: 'cli/commands/probe.ts',
      shape: 'open-hole' as const,
      contains: 'cdkd force-unlock',
      why: 'usage text, not a remedy',
    };
    const gone = {
      file: 'cli/commands/deleted.ts',
      shape: 'open-hole' as const,
      contains: 'cdkd bootstrap',
      why: 'its site was removed three PRs ago',
    };

    // The live entry SUPPRESSES its finding and is not reported stale...
    const matched = applyExemptions(findings, [live]);
    expect(matched.kept).toEqual([]);
    expect(matched.stale).toEqual([]);

    // ...the one whose target is gone suppresses nothing and IS reported, by
    // the key a reader can grep for. Both directions, because an exemption
    // mechanism that only ever suppresses is how a fence goes quiet with nobody
    // editing it.
    const stale = applyExemptions(findings, [gone]);
    expect(stale.kept).toHaveLength(1);
    expect(stale.stale).toEqual(['cli/commands/deleted.ts:open-hole:cdkd bootstrap']);

    // ONE entry, TWO matching findings: a REFUSAL, not two exemptions (M11).
    // Review measured the failure this closes: two `cdkd import ... ${x}=`
    // sites in `export.ts` gave two findings and zero survived under a single
    // entry, so a regression of the GATED twin back to its prose form would
    // have been silently exempted while the original target still existed.
    const twice = applyExemptions([...findings, { ...findings[0]!, line: 99 }], [live]);
    expect(twice.kept).toEqual([]);
    expect(twice.stale).toEqual([]);
    expect(twice.overmatched).toEqual(['cli/commands/probe.ts:open-hole:cdkd force-unlock']);
    // ...and the single-match case above is NOT overmatched, so the count
    // discriminates rather than firing on every use.
    expect(matched.overmatched).toEqual([]);

    // THREE near-misses, each differing from the live entry in exactly ONE
    // field. Review measured the pair above: the stale fixture differed in both
    // file and excerpt and both fixtures shared a shape, so deleting any one of
    // the three comparisons from `applyExemptions` left every assertion green.
    // A match is a CONJUNCTION, and a conjunction needs one case per term.
    for (const [term, nearMiss] of [
      ['file', { ...live, file: 'cli/commands/other.ts' }],
      ['shape', { ...live, shape: 'quoted-command' as const }],
      ['excerpt', { ...live, contains: 'cdkd force-unlok' }],
    ] as const) {
      const result = applyExemptions(findings, [nearMiss]);
      expect(result.kept, `the ${term} comparison is not doing anything`).toHaveLength(1);
      expect(result.stale, `the ${term} near-miss should be reported stale`).toHaveLength(1);
    }
  });
});
