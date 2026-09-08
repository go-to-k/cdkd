import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyze,
  extractTemplates,
  scanTemplateLiterals,
  matchesSourceTemplate,
  scanPage,
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
    // Without this seam, `main()` dropping the runSelfProbe() call would be
    // invisible — the unit test calls the function directly.
    let failed = false;
    try {
      execFileSync('node', [SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, CDKD_SELF_PROBE_FORCE_FAIL: '1' },
        stdio: 'pipe',
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
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

  it('refuses a template too weak to vouch for anything', () => {
    const t = templatesOf('throw new E(`${a}: ${b}`);');
    expect(t).toEqual([]);
    expect(matchesSourceTemplate('literally anything: at all', t)).toBe(false);
  });

  it('requires a truncated quote to overlap the opening literal by a real margin', () => {
    const t = templatesOf('throw new E(`State has been modified by another process. ${tail}`);');
    expect(matchesSourceTemplate('State has been modified by ...', t)).toBe(true);
    // A few shared characters must not be enough.
    expect(matchesSourceTemplate('State ...', t)).toBe(false);
    expect(MIN_TEMPLATE_LITERAL_CHARS).toBeGreaterThan(8);
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

  it('really is reading the tree, at magnitudes the floors do not pin', () => {
    // The floors are literals in the script and could be lowered alongside a
    // scope that silently stopped matching. These bands are derived here
    // instead, so both would have to be edited to hide a collapse.
    expect(report.counts.pages).toBeGreaterThan(FLOORS.pages);
    expect(report.counts.fencedBlocks).toBeGreaterThan(FLOORS.fencedBlocks);
    expect(report.counts.templates).toBeGreaterThan(FLOORS.templates);
    // The subject itself must not vanish: the site really does quote errors.
    expect(report.findings.length).toBeGreaterThanOrEqual(10);
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
  function runOnCopy(mutate: (root: string) => void): { code: number; out: string } {
    /*
     * realpath is load-bearing on macOS: `mkdtemp` hands back `/var/...` while
     * the spawned script resolves its own path to `/private/var/...`, so the
     * `import.meta.filename === process.argv[1]` guard in `main()` fails and
     * the process exits 0 having run nothing. Every probe below then "passes"
     * against a checker that never executed.
     */
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-doc-err-tree-')));
    try {
      // Only the two directories the checker reads.
      for (const sub of ['src', 'docs', 'scripts']) {
        mkdirSync(join(dir, sub), { recursive: true });
        execFileSync('cp', ['-R', join(ROOT, sub) + '/.', join(dir, sub)]);
      }
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
      rmSync(dir, { recursive: true, force: true });
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
});
