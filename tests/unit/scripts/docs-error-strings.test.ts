import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  analyze,
  extractTemplates,
  scanTemplateLiterals,
  matchesSourceTemplate,
  scanPage,
  collectDocPages,
  runSelfProbe,
  deriveErrorNames,
  FLOORS,
  FOREIGN_ERROR_NAMES,
  SELF_PROBE_CASES,
  MIN_TEMPLATE_LITERAL_CHARS,
  BLOCKING,
} from '../../../scripts/check-docs-error-strings.ts';

/**
 * Enforcement for `scripts/check-docs-error-strings.ts` — this test IS the CI
 * gate (there is no `vp run audit:*` task), matching the arrangement used by
 * `check-verification-depth-rule.ts` and `check-source-control-bytes.ts`.
 *
 * The script's own header states what it does and does not claim. What this
 * file adds is the pair of properties a checker cannot establish about itself:
 * that it still SEES the tree (floors, magnitudes) and that it still REJECTS a
 * violation introduced into REAL repo content, not merely into a synthetic
 * fixture the author wrote to match their own mental model.
 */

const ROOT = join(import.meta.dirname, '../../..');
const SCRIPT = join(ROOT, 'scripts/check-docs-error-strings.ts');

/** Write a throwaway source file and return the templates extracted from it. */
function templatesOf(source: string): ReturnType<typeof extractTemplates> {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-doc-err-'));
  try {
    const f = join(dir, 'sample.ts');
    writeFileSync(f, source, 'utf8');
    return extractTemplates([f]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fenced = (line: string): string => ['```text', line, '```'].join('\n');

describe('docs error-string checker: self-probe', () => {
  it('passes its own fixed cases', () => {
    expect(runSelfProbe()).toEqual([]);
  });

  it('does not hard-code the allow-listed name its foreign case relies on', () => {
    // Retiring a FOREIGN_ERROR_NAMES entry should fail the STALENESS arm, not
    // break the self-probe — they are separate claims.
    const foreignCase = SELF_PROBE_CASES.find((c) => c.expect === 'foreign-allowed');
    expect(foreignCase).toBeDefined();
    const name = foreignCase!.line.split(':')[0]!;
    expect([...FOREIGN_ERROR_NAMES.keys()]).toContain(name);
  });

  it('every self-probe source is valid TypeScript', () => {
    // The checker REFUSES a file with parse diagnostics, so a probe fixture
    // that is not valid TS throws out of the probe rather than producing its
    // verdict — and the failure names a deleted tmpdir path. One case already
    // had to be fixed for this; nothing fenced the next one.
    for (const c of SELF_PROBE_CASES) {
      expect(() => scanTemplateLiterals(c.source), c.what).not.toThrow();
    }
  });

  it('covers every verdict, including the failing ones', () => {
    const covered = new Set(SELF_PROBE_CASES.map((c) => c.expect));
    // A probe suite made only of accept cases dies silently when a reject arm
    // degrades to "return true".
    expect(covered).toContain('anchored');
    expect(covered).toContain('no-source-anchor');
    expect(covered).toContain('unknown-class');
    expect(covered).toContain('foreign-allowed');
    expect(covered).toContain('no-finding');
  });

  it('still consults the probe from the shipped binary', () => {
    /*
     * Without this seam, `main()` dropping the runSelfProbe() call would be
     * invisible — the unit test calls the function directly. Asserting only a
     * non-zero exit is NOT equivalent: a blocking finding, a floor violation,
     * a stale allow-list entry and a type-strip failure all exit non-zero too,
     * so the assertion must name the probe's OWN wording.
     */
    let out = '';
    let failed = false;
    try {
      execFileSync('node', [SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, CDKD_SELF_PROBE_FORCE_FAIL: '1' },
        stdio: 'pipe',
      });
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      failed = true;
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    expect(failed).toBe(true);
    expect(out).toContain('CDKD_SELF_PROBE_FORCE_FAIL');
    expect(out).toContain('failed its own fixed cases');
  }, 60_000);

  it('exits 0 without the seam (the control that makes the case above mean something)', () => {
    const out = execFileSync('node', [SCRIPT], { cwd: ROOT, stdio: 'pipe' }).toString();
    expect(out).toContain('check OK');
  }, 60_000);
});

describe('docs error-string checker: template extraction', () => {
  it('does not pair backticks across JSDoc prose', () => {
    // The first cut paired a comment's tick with an unrelated one far away and
    // produced "templates" made of whole object literals.
    const tokens = scanTemplateLiterals(
      ['/** Mentions `a` and `b` in prose. */', 'const x = `a real template ${v} here`;'].join('\n')
    );
    expect(tokens.map((t) => t.raw)).toEqual(['a real template ${v} here']);
  });

  it('ignores backticks inside ordinary strings', () => {
    const tokens = scanTemplateLiterals(`const s = 'has a \` tick'; const t = "another \` one";`);
    expect(tokens).toEqual([]);
  });

  it('rejoins literals concatenated with +', () => {
    const t = templatesOf(
      "throw new E(\n  `Failed to acquire lock for stack ` +\n    `'${s}' after ${n} attempts.`\n);"
    );
    expect(matchesSourceTemplate("Failed to acquire lock for stack 'MyStack' after 4 attempts.", t)).toBe(true);
  });

  it('matches a hole in the middle of a phrase, and only the right message', () => {
    const t = templatesOf('throw new E(`Failed to ${verb} resource ${id}`);');
    expect(matchesSourceTemplate('Failed to create resource MyBucket', t)).toBe(true);
    expect(matchesSourceTemplate('Failed to update resource MyBucket', t)).toBe(true);
    // The discrimination a substring or word-run test does not make:
    expect(matchesSourceTemplate('Failed to publish asset: Access Denied', t)).toBe(false);
  });

  it('refuses a template too weak to vouch for anything, and accepts its twin', () => {
    const weak = templatesOf('throw new E(`${a}: ${b}`);');
    expect(weak).toEqual([]);
    expect(matchesSourceTemplate('literally anything: at all', weak)).toBe(false);

    /*
     * The ACCEPT twin. Without it, `toEqual([])` cannot tell "rejected by
     * MIN_TEMPLATE_LITERAL_CHARS" from "the extractor returned nothing at
     * all" — the same shape `check-provider-secret-mask` pairs its arms for.
     * Same source, same holes; only the literal text crosses the threshold.
     */
    const strong = templatesOf('throw new E(`${a} failed for the thing: ${b}`);');
    expect(strong.length).toBe(1);
    expect(matchesSourceTemplate('CREATE failed for the thing: boom', strong)).toBe(true);
  });


  it('REFUSES a quotation the author truncated with an ellipsis', () => {
    /*
     * Six review rounds each found the partial-match rule accepting a
     * fabrication one step further out, and the measurement that settled it is
     * that ZERO of the site's quoted lines are truncated. Refusing is now the
     * contract: the author quotes the message in full.
     */
    const t = templatesOf('throw new E(`State has been modified by another process. ${tail}`);');
    expect(matchesSourceTemplate('State has been modified by another ...', t)).toBe(false);
    // The same quotation, complete, is accepted.
    expect(matchesSourceTemplate('State has been modified by another process. yes', t)).toBe(true);
  });

  it('does not let a trailing HOLE absorb the ellipsis', () => {
    /*
     * The refusal is inert unless truncated subjects are matched only against
     * templates whose own text ends in an ellipsis: most templates end in a
     * hole, whose wildcard swallows the author's `...` so the fabrication
     * matches outright and never reaches the refusal. Measured on the real
     * corpus, `Failed to ${verb} resource ${id}` vouched for a whole invented
     * sentence this way.
     */
    const t = templatesOf('throw new E(`Failed to ${verb} resource ${logicalId}`);');
    expect(
      matchesSourceTemplate('Failed to reach the state bucket and every resource ...', t)
    ).toBe(false);
  });

  it('still accepts a message whose REAL text ends in an ellipsis', () => {
    // The narrow legitimate case the refusal must not break.
    const t = templatesOf('throw new E(`Reticulating splines, please wait...`);');
    expect(matchesSourceTemplate('Reticulating splines, please wait...', t)).toBe(true);
  });

  it('drops a template longer than the cap, and keeps one just under it', () => {
    const long = 'x'.repeat(700);
    expect(templatesOf(`const a = \`${long}\`;`)).toEqual([]);
    const short = 'y'.repeat(100);
    expect(templatesOf(`const a = \`${short}\`;`).length).toBe(1);
  });

  it('dedupes identical templates', () => {
    const t = templatesOf('const a = `the same message ${x}`; const b = `the same message ${y}`;');
    expect(t.length).toBe(1);
  });

  it('handles line comments, escapes and hole nesting', () => {
    // `//` line comment — its backticks must not open a template.
    expect(scanTemplateLiterals('// a `tick` in a line comment\nconst x = 1;')).toEqual([]);
    // An escaped backtick does not close the template.
    expect(scanTemplateLiterals('const x = `a \\` still inside`;').map((t) => t.raw)).toEqual([
      'a \\` still inside',
    ]);
    // A `}` inside a hole must not be read as the hole's end.
    const nested = scanTemplateLiterals('const x = `v=${ {a:1}.a } end`;');
    expect(nested.map((t) => t.raw)).toEqual(['v=${ {a:1}.a } end']);
  });

  it('refuses a file it cannot parse rather than scanning a partial tree', () => {
    /*
     * An unparseable file yields a PARTIAL tree, not an error, so its
     * templates go missing while every count stays plausible — and the
     * templates floor carries thousands of slack, enough to hide the largest
     * files dropping out entirely. The sibling critics hard-fail on
     * diagnostics for the same reason.
     */
    expect(() => scanTemplateLiterals('const a = ;;; function (')).toThrow(/parse diagnostic/);
    // Control: a valid file does not throw.
    expect(() => scanTemplateLiterals('const a = `fine ${x}`;')).not.toThrow();
  });

  it('treats an empty or whitespace-only template as no template', () => {
    expect(templatesOf('const a = ``; const b = `   `;')).toEqual([]);
  });

  it('never matches an empty message', () => {
    const t = templatesOf('throw new E(`a perfectly good template ${x}`);');
    expect(matchesSourceTemplate('', t)).toBe(false);
    expect(matchesSourceTemplate('   ', t)).toBe(false);
  });

  /*
   * Regressions for the three blockers review found in the first cut. Each was
   * MEASURED against the real tree, so each gets a case rather than a comment.
   */
  it('does not desync on a regex literal containing a quote', () => {
    // Review measured this dropping 11 genuine templates and MANUFACTURING
    // four live matchers out of the JSDoc prose that followed.
    const src = [
      'const re = /"([^"\\\\]{1,64})"\\s*:/g;',
      'throw new E(`a genuine message template ${x} here`);',
    ].join('\n');
    const t = templatesOf(src);
    expect(matchesSourceTemplate('a genuine message template VALUE here', t)).toBe(true);
  });

  it('does not desync on a regex literal containing an apostrophe', () => {
    const src = [
      "const re = /'args\\[(\\d+)\\]'[^']*?Received /g;",
      'throw new E(`another genuine template ${x} here`);',
    ].join('\n');
    const t = templatesOf(src);
    expect(matchesSourceTemplate('another genuine template VALUE here', t)).toBe(true);
  });

  it('treats a division operator as division, not as a regex start', () => {
    // The inverse error: over-eager regex detection would swallow real code.
    const src = 'const half = total / 2; throw new E(`a template after division ${x}`);';
    const t = templatesOf(src);
    expect(matchesSourceTemplate('a template after division V', t)).toBe(true);
  });

  it('does not end a template at a brace nested inside a hole', () => {
    /*
     * A shape the hand-rolled scanner ended early, losing one real template
     * and manufacturing six bogus ones. `src/cli/commands/state.ts` has it.
     */
    const src = 'throw new E(`Run: ${ f({ a: 1 }) || `fallback text here` } tail`);';
    const tokens = scanTemplateLiterals(src);
    expect(tokens.map((x) => x.raw)).toEqual(['Run: ${ f({ a: 1 }) || `fallback text here` } tail']);
  });

  it('does not desync on a brace inside a STRING inside a hole', () => {
    // A shape the hand-rolled scanner got wrong twice. Kept as a regression
    // against ever replacing the parser with heuristics again.
    const src = 'const a = `pre ${ f("{") } post`; const b = `a second template ${x} here`;';
    const tokens = scanTemplateLiterals(src);
    expect(tokens.map((x) => x.raw)).toEqual([
      'pre ${ f("{") } post',
      'a second template ${x} here',
    ]);
  });







});

describe('docs error-string checker: page scanning', () => {
  const names = new Set(['StateError']);
  const templates = templatesOf('throw new StateError(`State file for stack ${s} is not valid JSON: ${e}`);');

  it('reads only inside fenced blocks', () => {
    const outside = scanPage('p.md', 'StateError: State file for stack x is not valid JSON: y', names, templates);
    expect(outside.findings).toEqual([]);
  });

  it('joins a message wrapped across lines', () => {
    const wrapped = [
      '```text',
      "StateError: State file for stack 'MyStack' is not",
      'valid JSON: Unexpected token',
      '```',
    ].join('\n');
    const scan = scanPage('p.md', wrapped, names, templates);
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]!.verdict).toBe('anchored');
  });

  it('stops absorbing at a Caused by: line', () => {
    const text = [
      '```text',
      "StateError: State file for stack 'MyStack' is not valid JSON: bad",
      'Caused by: bad',
      '```',
    ].join('\n');
    const scan = scanPage('p.md', text, names, templates);
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]!.message).not.toContain('Caused by');
  });

  it('reports a wrapped message at the line it STARTS on', () => {
    // The absorption loop moves the cursor; reading the line number after it
    // reports where the message ENDS, sending a reader to the wrong place.
    const text = [
      'intro',
      '```text',
      "StateError: State file for stack 'MyStack' is not",
      'valid JSON: nope',
      '```',
    ].join('\n');
    const scan = scanPage('p.md', text, names, templates);
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]!.line).toBe(3);
  });

  it('reports an unknown class name', () => {
    const scan = scanPage('p.md', fenced('AssetPublisherError: whatever it says'), names, templates);
    expect(scan.findings[0]!.verdict).toBe('unknown-class');
  });
});

describe('docs error-string checker: the real tree', () => {
  const report = analyze(ROOT);

  it('has no blocking finding', () => {
    const blocking = report.findings.filter((f) => BLOCKING.has(f.verdict));
    if (blocking.length > 0) {
      console.error(blocking.map((f) => `${f.file}:${f.line} ${f.errorName}: ${f.message}`).join('\n'));
    }
    expect(blocking).toEqual([]);
  });

  it('carries no stale allow-list entry', () => {
    expect(report.staleForeignNames).toEqual([]);
  });

  it('clears every floor', () => {
    expect(report.floorViolations).toEqual([]);
  });

  /*
   * `FLOORS` pinned to LITERALS. Without this the bands below could be
   * satisfied by lowering the constants, which is the same edit that hides a
   * collapsed scope. Measured: zeroing every floor and narrowing
   * `collectDocPages` to `troubleshooting.md` alone — 72 of 73 pages
   * unscanned — left an earlier version of this suite fully green, because its
   * bands were expressed as `> FLOORS.x`.
   */
  it('pins the floor constants themselves', () => {
    expect(FLOORS).toEqual({
      pages: 40,
      fencedBlocks: 300,
      fencedLines: 2500,
      errorNames: 20,
      templates: 5_000,
    });
  });

  it('really is reading the tree, at magnitudes stated INDEPENDENTLY of the floors', () => {
    // Literals, not `FLOORS.x`. The bands sit well under the real magnitudes
    // so ordinary growth and shrinkage do not touch them — deliberately no
    // measured figure is quoted here, because a number in a comment drifts
    // and the assertions below are the thing that must stay true. Every
    // counter gets a band:
    // the two that previously had none are where a collapse would hide.
    expect(report.counts.pages).toBeGreaterThanOrEqual(60);
    expect(report.counts.fencedBlocks).toBeGreaterThanOrEqual(400);
    expect(report.counts.fencedLines).toBeGreaterThanOrEqual(3_500);
    expect(report.counts.errorNames).toBeGreaterThanOrEqual(35);
    expect(report.counts.templates).toBeGreaterThanOrEqual(6_000);
  });

  it('walks past the generated directory rather than into it', () => {
    /*
     * Asserting no FINDING under `docs/_generated/` pins nothing — those pages
     * contain no `Error:` line, so the assertion is green with the skip
     * deleted. Assert the walk itself: the directory exists and has pages, and
     * none of them is collected.
     */
    const generated = join(ROOT, 'docs/_generated');
    const rawCount = readdirSync(generated).filter((f) => f.endsWith('.md')).length;
    expect(rawCount).toBeGreaterThan(0);
    const walked = collectDocPages(join(ROOT, 'docs'));
    expect(walked.some((p) => p.includes(`docs${sep}_generated${sep}`))).toBe(false);
    expect(walked.length).toBeGreaterThan(0);
  });

  it('finds its subject on more than one page', () => {
    // A count alone survives the measured collapse above: all findings come
    // from two pages, so narrowing the walk to the busiest one keeps the
    // total near its full value. The SPREAD is what that cannot fake.
    expect(report.findings.length).toBeGreaterThanOrEqual(10);
    const files = new Set(report.findings.map((f) => f.file));
    expect(files.size).toBeGreaterThanOrEqual(2);
  });

  it('derives the error names from the real tree, not a list', () => {
    const names = deriveErrorNames([join(ROOT, 'src/utils/error-handler.ts')]);
    expect(names.has('StateError')).toBe(true);
    expect(names.has('LockError')).toBe(true);
    expect(names.has('ProvisioningError')).toBe(true);
    // Subclasses declared outside error-handler.ts must be picked up too.
    const all = analyze(ROOT);
    expect(all.counts.errorNames).toBeGreaterThan(names.size);
  });

  it('requires a reason of real length on every allow-list entry', () => {
    for (const [name, reason] of FOREIGN_ERROR_NAMES) {
      expect(reason.length, `${name} needs a real reason`).toBeGreaterThan(40);
    }
  });
});

describe('docs error-string checker: fails against real code', () => {
  /**
   * The properties synthetic fixtures cannot establish. Both run against a
   * COPY of the real tree so nothing is written under `src/` or `docs/`.
   */
  /**
   * ONE copy, reused by every probe, with the mutated files restored after
   * each. Copying per probe made seven ~19 MB trees and seven full-tree
   * TypeScript parses in a single worker, which produced an intermittent
   * `Worker exited unexpectedly` — a green summary next to a non-zero exit,
   * the flakiest shape there is to debug later.
   */
  const MUTABLE = [
    'docs/troubleshooting.md',
    'src/state/s3-state-backend.ts',
    'src/utils/error-handler.ts',
    'scripts/check-docs-error-strings.ts',
  ] as const;

  let dir = '';

  beforeAll(() => {
    /*
     * realpath is load-bearing on macOS: `mkdtemp` hands back `/var/...` while
     * the spawned script resolves its own path to `/private/var/...`, so the
     * `import.meta.filename === process.argv[1]` guard in `main()` fails and
     * the process exits 0 having run nothing. Every probe below then "passes"
     * against a checker that never executed.
     */
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-doc-err-tree-')));
    for (const sub of ['src', 'docs', 'scripts']) {
      mkdirSync(join(dir, sub), { recursive: true });
      execFileSync('cp', ['-R', join(ROOT, sub) + '/.', join(dir, sub)]);
    }
    // The checker imports `typescript-v6`, so the copy needs a module
    // resolution root. A symlink is enough and copying node_modules is not
    // (gigabytes, and slow enough to time these probes out).
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  }, 180_000);

  afterAll(() => {
    // `recursive` does not follow the node_modules symlink — it unlinks it.
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function runOnCopy(mutate: (root: string) => void): { code: number; out: string } {
    // Without this, an unbuilt `dir` ('') makes `mutate` write RELATIVE paths
    // into the real repository before the spawn fails.
    if (!dir) throw new Error('copy tree was not built');
    try {
      mutate(dir);
      try {
        const out = execFileSync('node', [join(dir, 'scripts/check-docs-error-strings.ts')], {
          cwd: dir,
          stdio: 'pipe',
        }).toString();
        return { code: 0, out };
      } catch (e) {
        const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
        return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    } finally {
      // Restore every file a probe may have touched, so probes cannot leak
      // into each other — a mutated tree that survives would make the NEXT
      // probe pass for the previous probe's reason.
      for (const rel of MUTABLE) {
        writeFileSync(join(dir, rel), readFileSync(join(ROOT, rel), 'utf8'), 'utf8');
      }
    }
  }

  it('is green on an unmutated copy (the control)', () => {
    const { code } = runOnCopy(() => {});
    expect(code).toBe(0);
  }, 180_000);

  it('reports a page that drifts from the source', () => {
    const { code, out } = runOnCopy((root) => {
      const p = join(root, 'docs/troubleshooting.md');
      const text = readFileSync(p, 'utf8');
      writeFileSync(
        p,
        text.replace(
          'StateError: State has been modified by another process.',
          'StateError: State was modified by another process.'
        ),
        'utf8'
      );
    });
    expect(code).not.toBe(0);
    expect(out).toContain('no-source-anchor');
    expect(out).toContain('State was modified by another process');
  }, 180_000);

  it('reports a source that drifts from the page', () => {
    // The direction that matters over time: the page was right when written.
    const { code, out } = runOnCopy((root) => {
      const p = join(root, 'src/state/s3-state-backend.ts');
      const text = readFileSync(p, 'utf8');
      writeFileSync(
        p,
        text.replace(
          'State has been modified by another process.',
          'State changed underneath this write.'
        ),
        'utf8'
      );
    });
    expect(code).not.toBe(0);
    expect(out).toContain('no-source-anchor');
  }, 180_000);

  it('reports a class name the tree no longer assigns', () => {
    const { code, out } = runOnCopy((root) => {
      const p = join(root, 'src/utils/error-handler.ts');
      const text = readFileSync(p, 'utf8');
      writeFileSync(p, text.replace("this.name = 'StateError';", "this.name = 'StateErrorX';"), 'utf8');
    });
    expect(code).not.toBe(0);
    expect(out).toContain('unknown-class');
  }, 180_000);

  /** Rewrite a constant in the COPIED checker itself. */
  function patchChecker(root: string, from: string, to: string): void {
    const p = join(root, 'scripts/check-docs-error-strings.ts');
    const text = readFileSync(p, 'utf8');
    if (!text.includes(from)) throw new Error(`probe needle not found: ${from}`);
    writeFileSync(p, text.replace(from, to), 'utf8');
  }

  it('fails when a floor is not met, rather than reporting a confident zero', () => {
    // The floors exist for a scan that silently stopped seeing its input.
    // Raising one above the real magnitude simulates exactly that.
    const { code, out } = runOnCopy((root) => patchChecker(root, 'pages: 40,', 'pages: 40_000,'));
    expect(code).not.toBe(0);
    expect(out).toContain('floor: pages');
  }, 180_000);

  it('fails a stale allow-list entry whose name became a real cdkd error', () => {
    const { code, out } = runOnCopy((root) => {
      // CredentialsProviderError is quoted on the proxy page and is NOT cdkd's.
      // Make the tree assign it, and the exemption must be reported stale.
      const p = join(root, 'src/utils/error-handler.ts');
      const text = readFileSync(p, 'utf8');
      writeFileSync(
        p,
        text.replace(
          "this.name = 'StateError';",
          "this.name = 'StateError';\n    void 'CredentialsProviderError';\n    this.name = this.name;"
        ),
        'utf8'
      );
      patchChecker(
        root,
        "const names = new Set<string>(['Error']);",
        "const names = new Set<string>(['Error', 'CredentialsProviderError']);"
      );
    });
    expect(code).not.toBe(0);
    expect(out).toContain('now a real cdkd error name');
  }, 180_000);

  it('fails a stale allow-list entry no page quotes any more', () => {
    const { code, out } = runOnCopy((root) => {
      // Retire the only quotation of CredentialsProviderError from the page.
      const p = join(root, 'docs/troubleshooting.md');
      const text = readFileSync(p, 'utf8');
      writeFileSync(p, text.replace('CredentialsProviderError: Error:', 'SomeOther: Error:'), 'utf8');
    });
    expect(code).not.toBe(0);
    expect(out).toContain('no page quotes it any more');
  }, 180_000);
  it('is still green AFTER every probe, and left the copy byte-identical', () => {
    /*
     * Runs LAST on purpose: a leading control cannot see a failed restore, so
     * without this a probe could pass on its predecessor's mutation and the
     * suite would still read green.
     *
     * The `diff -r` is the second half. The exit-code check only catches a
     * leak that makes the checker FAIL; a green-preserving leak — a widened
     * allow-list, a lowered floor — would pass it. Comparing the whole copy
     * against ROOT also fences `MUTABLE`: a future probe touching a fifth file
     * fails here rather than leaking silently.
     */
    const { code, out } = runOnCopy(() => {});
    expect(code).toBe(0);
    expect(out).toContain('check OK');

    for (const sub of ['src', 'docs', 'scripts']) {
      const r = spawnSync('diff', ['-r', join(ROOT, sub), join(dir, sub)], { encoding: 'utf8' });
      expect(r.stdout, `${sub} differs from ROOT after the probes`).toBe('');
      expect(r.status).toBe(0);
    }
  }, 180_000);

});
