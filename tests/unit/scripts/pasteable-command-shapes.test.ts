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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLOORS,
  SELF_PROBE_CASES,
  checkPasteableCommandShapes,
  runSelfProbes,
  scanSource,
  type PasteableShape,
} from '../../../scripts/check-pasteable-command-shapes.js';

/**
 * Resolved from THIS FILE, never from `process.cwd()`. A relative `'src'` read
 * correctly in isolation and under-counted in the full suite — a floor test
 * that depends on who ran it is a floor test that attests to nothing.
 */
const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

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
    // fails with `FLOORS` untouched. Measured 2026-09-24 at 358 / 1532 / 1047.
    const report = realTree();
    expect(report.filesScanned).toBeGreaterThan(340);
    expect(report.spansExamined).toBeGreaterThan(1400);
    expect(report.commandLiteralsExamined).toBeGreaterThan(950);
  }, 60_000);

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
  it('passes the script’s own self-probes, negatives included', () => {
    expect(runSelfProbes()).toEqual([]);
  });

  it('consults those probes from the BINARY, not only from this file', () => {
    // The seam. Without it, `main()` dropping its `runSelfProbes()` call is
    // unobservable from here, because this file calls the function directly.
    const previous = process.env['CDKD_SELF_PROBE_FORCE_FAIL'];
    process.env['CDKD_SELF_PROBE_FORCE_FAIL'] = '1';
    try {
      expect(runSelfProbes()).toContain('forced by CDKD_SELF_PROBE_FORCE_FAIL');
    } finally {
      if (previous === undefined) delete process.env['CDKD_SELF_PROBE_FORCE_FAIL'];
      else process.env['CDKD_SELF_PROBE_FORCE_FAIL'] = previous;
    }
  });

  it('carries a NEGATIVE case for every accept arm', () => {
    // A probe suite of accepts only cannot fail on a classifier that reports
    // everything. The majority here are negatives by design, and this pins that
    // rather than leaving it to whoever edits the list next.
    const negatives = SELF_PROBE_CASES.filter((c) => c.expect.length === 0);
    expect(negatives.length).toBeGreaterThan(SELF_PROBE_CASES.length / 2);
    for (const shape of ['quoted-command', 'quoted-interpolation', 'open-hole'] as const) {
      expect(
        SELF_PROBE_CASES.some((c) => c.expect.includes(shape)),
        `no accept case for ${shape}`
      ).toBe(true);
    }
  });

  it('leaves the 944 quoted DISPLAY values alone', () => {
    // `'${stackName}'` is go-to-k/cdkd#3232's class and occurs 944 times in
    // `src/`. Reporting it here would bury every real finding, so the two-hole
    // floor is load-bearing rather than an optimisation — and this is the case
    // that would red if someone relaxed it.
    expect(shapesOf("const m = `Stack '${stackName}' has no region.`;")).toEqual([]);
    expect(shapesOf("const m = `docker cp into '${id}:${dir}' failed`;")).toEqual([]);
  });

  it('leaves commandHole’s quoted placeholder alone', () => {
    // `'<stack>'` is the REMEDY. A fence that reported it would be telling
    // callers to undo go-to-k/cdkd#3363's fix.
    expect(shapesOf("const m = `Migrate with: cdkd deploy '<stack>' --stack-region '<region>'`;")).toEqual(
      []
    );
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

describe('pasteable-command shape fence — real code, not only fixtures', () => {
  // A synthetic fixture encodes the author's mental model, so a checker and its
  // tests can share a blind spot. Each probe here introduces the shape into a
  // copy of a REAL message from this repo and requires the fence to name it.

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

describe('pasteable-command shape fence — exemptions cannot go stale', () => {
  it('reports an exemption whose target no longer exists', () => {
    // An exemption outliving its target is how a fence goes quiet without
    // anyone editing it, so a stale one is a REFUSAL rather than a warning.
    // The live list is empty today; this pins the mechanism against that.
    const report = realTree();
    expect(report.staleExemptions).toEqual([]);
  }, 60_000);
});
