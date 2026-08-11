import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BINARY_EXTENSIONS,
  describeFinding,
  findControlBytes,
  isBinaryPath,
} from '../../../scripts/check-source-control-bytes.js';

/**
 * Regression guard for issue #1587 — a committed raw NUL makes a source file
 * invisible to every grep/rg-based audit. See
 * `scripts/check-source-control-bytes.ts` for the measured blast radius.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..');

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('findControlBytes', () => {
  it('accepts ordinary text, including TAB and LF', () => {
    expect(findControlBytes(enc('const a = 1;\n\tconst b = 2;\n'))).toEqual([]);
  });

  it('flags a raw NUL and reports its offset and line', () => {
    const findings = findControlBytes(enc("line1\nconst sep = '\u0000';\n"));
    expect(findings).toHaveLength(1);
    // "line1\n" is 6 bytes, "const sep = '" is 13 more, so the NUL is at 19.
    expect(findings[0]).toEqual({ byte: 0, offset: 19, line: 2 });
  });

  it('does NOT flag the two-character \\0 escape, which is the fix', () => {
    // The escape is a backslash followed by '0' — ordinary printable bytes.
    expect(findControlBytes(enc("const sep = '\\0';\n"))).toEqual([]);
  });

  it('flags other C0 control bytes and DEL', () => {
    const bytes = findControlBytes(
      new Uint8Array([0x61, 0x1b, 0x0a, 0x62, 0x07, 0x0a, 0x63, 0x7f]),
    ).map((f) => f.byte);
    expect(bytes).toEqual([0x1b, 0x07, 0x7f]);
  });

  it('flags CR, because this repo is LF-only', () => {
    expect(findControlBytes(enc('a\r\nb\n')).map((f) => f.byte)).toEqual([0x0d]);
  });

  it('caps the ALLOCATION at `limit`, not just the display', () => {
    // An unlisted genuinely-binary file yields ~1 finding per byte, so an
    // uncapped walk over a large asset builds millions of objects before the
    // caller can trim. The scan still completes; only the array is bounded.
    const many = new Uint8Array(1000).fill(0x00);
    expect(findControlBytes(many, 5)).toHaveLength(5);
    expect(findControlBytes(many)).toHaveLength(64); // default
  });

  it('reports EVERY occurrence rather than short-circuiting', () => {
    const findings = findControlBytes(new Uint8Array([0x00, 0x0a, 0x00, 0x0a, 0x00]));
    expect(findings.map((f) => f.line)).toEqual([1, 2, 3]);
  });
});

describe('isBinaryPath', () => {
  it.each(['assets/cdk-vs-cdkd.gif', 'a/b.PNG', 'x.woff2'])('exempts %s', (p) => {
    expect(isBinaryPath(p)).toBe(true);
  });

  it.each(['src/a.ts', 'docs/b.md', 'Makefile', 'scripts/c.mjs'])('does not exempt %s', (p) => {
    expect(isBinaryPath(p)).toBe(false);
  });

  // The two properties the implementation's JSDoc claims. Both currently fail
  // SAFE (they under-exempt), which is exactly why nothing would notice a
  // regression — so assert them rather than leaving them as prose.
  it('scopes the extension to the BASENAME, not the whole path', () => {
    // On the full path this yields '.gif/baz', which matches no entry only by
    // accident. Basename scoping makes "never falsely exempt" a property.
    expect(isBinaryPath('foo.gif/baz')).toBe(false);
    expect(isBinaryPath('a.png/b/c.ts')).toBe(false);
    // ...while a real asset nested under a dotted directory still exempts.
    expect(isBinaryPath('foo.gif/bar.png')).toBe(true);
  });

  it('keeps dotfiles and extension-less files under check', () => {
    expect(isBinaryPath('.gitignore')).toBe(false);
    expect(isBinaryPath('.mise.toml')).toBe(false);
    expect(isBinaryPath('LICENSE')).toBe(false);
    expect(isBinaryPath('dir/.env')).toBe(false);
  });
});

describe('describeFinding', () => {
  it('names the file, position, consequence and the exact escape to use', () => {
    const message = describeFinding('src/x.ts', { byte: 0, offset: 17230, line: 435 });
    expect(message).toContain('src/x.ts:435');
    expect(message).toContain('offset 17230');
    expect(message).toContain('BINARY');
    expect(message).toContain("'\\0'");
  });

  it('renders a non-NUL byte as a \\u escape', () => {
    expect(describeFinding('src/x.ts', { byte: 0x1b, offset: 5, line: 1 })).toContain("'\\u001b'");
  });

  it('does NOT claim grep-blindness for a byte that does not cause it', () => {
    // Only a NUL makes grep/rg treat the file as binary. Asserting the
    // rationale for ESC/CR would be a false statement in a CI failure message.
    const esc = describeFinding('src/x.ts', { byte: 0x1b, offset: 5, line: 1 });
    // Match the CLAIM, not the bare word — "BINARY_EXTENSIONS" appears in the
    // remedy of every branch and is not the false statement being guarded.
    expect(esc).not.toContain('treat the whole file as BINARY');
    expect(esc).toContain('not valid');
    // ...while the NUL branch, where the claim is true, must still make it.
    expect(describeFinding('src/x.ts', { byte: 0, offset: 5, line: 1 })).toContain(
      'treat the whole file as BINARY'
    );
  });

  it('qualifies the escape remedy by language instead of stating it flatly', () => {
    // `.json` is the second-largest tracked extension and JSON has no `\0`
    // escape at all, so an unqualified "write it as '\0'" produces an invalid
    // file. Markdown / YAML / shell have no "runtime" either.
    const nul = describeFinding('a/b.json', { byte: 0, offset: 1, line: 1 });
    expect(nul).toContain('JS/TS string literal');
    expect(nul).toMatch(/JSON|without string escapes/);
  });

  it('tells a CR to convert line endings rather than to use an escape', () => {
    const cr = describeFinding('src/x.ts', { byte: 0x0d, offset: 5, line: 1 });
    expect(cr).toContain('LF');
    expect(cr).not.toContain("'\\u000d'");
  });
});

/**
 * The single sweep both the verdict AND the coverage floors read.
 *
 * The floors MUST be derived from files actually READ, not from the candidate
 * list: an earlier version filtered `trackedFiles()` without touching the
 * filesystem, so inverting the sweep's own `isFile()` guard (e.g.
 * `if (!stat.isSymbolicLink()) continue;`) skipped every regular file, produced
 * zero offenders, and left all four floors green — a fully vacuous pass. That
 * is the repo's "a checker must prove it SEES its input" rule failing on this
 * checker's own test.
 */
function sweepTree(): { offenders: string[]; read: string[] } {
  const offenders: string[] = [];
  const read: string[] = [];

  for (const path of trackedFiles()) {
    if (isBinaryPath(path)) continue;
    const full = join(REPO_ROOT, path);
    // `git ls-files` lists submodule gitlinks and files a checkout may omit.
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    // Cap per file. An unlisted GENUINELY binary file (someone commits a
    // .jar / .bin) is the designed "fails loudly" path — but uncapped it
    // yields ~1 finding per byte, so a 10 MB asset would build millions of
    // strings for vitest to diff. That is an OOM, not a loud message.
    const findings = findControlBytes(readFileSync(full));
    read.push(path);
    for (const finding of findings.slice(0, 5)) {
      offenders.push(describeFinding(path, finding));
    }
    if (findings.length > 5) {
      offenders.push(`${path}: ...and ${findings.length - 5} more control bytes`);
    }
  }

  return { offenders, read };
}

describe('the committed tree', () => {
  it('has no stray control bytes in any tracked text file', () => {
    expect(sweepTree().offenders).toEqual([]);
  });

  it('actually READ a realistic number of files, so a broken sweep cannot pass vacuously', () => {
    // Banded against the ~3344 actually read. A loose `> 500` floor was NOT
    // enough: adding `.ts` + `.md` to BINARY_EXTENSIONS neuters the check over
    // 1648 files and still leaves ~1695, which would clear it. The
    // per-extension floors below are what make that specific neuter fail.
    expect(sweepTree().read.length).toBeGreaterThan(2500);
  });

  it.each([
    ['.ts', 1000],
    ['.json', 800],
    ['.sh', 200],
    ['.md', 100],
  ])('actually READ the %s files (floor %i), so exempting them by extension fails', (ext, floor) => {
    const read = sweepTree().read.filter((p) => p.endsWith(ext));
    expect(read.length).toBeGreaterThan(floor);
  });

  it('keeps the efs-provider creationToken separator as the escape, not a raw NUL', () => {
    // The #1587 site. Pinned by NAME because it is the one occurrence the
    // tree-wide sweep above exists to have caught, and a re-introduction here
    // would be invisible to the grep-based audits that read this provider.
    const source = readFileSync(
      join(REPO_ROOT, 'src/provisioning/providers/efs-provider.ts'),
      'utf8',
    );
    // Tolerant of quote style / spacing so a benign reformat is not a false
    // failure. The absence assertion below is the one that cannot be dodged —
    // it catches a re-introduction in ANY spelling.
    expect(source).toMatch(/join\(\s*['"]\\0['"]\s*\)/);
    expect(source.includes('\u0000')).toBe(false);
  });
});

describe('BINARY_EXTENSIONS', () => {
  it('is lowercase and dot-prefixed, which isBinaryPath relies on', () => {
    for (const ext of BINARY_EXTENSIONS) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext.startsWith('.')).toBe(true);
    }
  });
});
