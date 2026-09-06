import { beforeAll, describe, it, expect } from 'vite-plus/test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BINARY_EXTENSIONS,
  describeFinding,
  findControlBytes,
  isBinaryPath,
} from '../../../scripts/check-source-control-bytes.js';

/**
 * Regression guard for issue #1587 — a raw NUL makes a source file invisible to
 * every grep/rg-based audit. See `scripts/check-source-control-bytes.ts` for the
 * measured blast radius.
 *
 * The population is the WORKING TREE, not the committed tree (issue #2696): a
 * file a session has just written but not yet committed is exactly where an
 * authoring-tool encoding artifact lands, and scanning only tracked files hid
 * such a byte until the commit that added it (measured 2026-09-06: a raw NUL at
 * offset 6547 in an untracked test file cleared `vp check --fix`, `vp run
 * check`, `vp run typecheck:test`, `vp run build` and a full 910-file
 * `vp test run`).
 */

const REPO_ROOT = join(import.meta.dirname, '../../..');

/** Shared by the probe paths below and by the pre-clean that removes their leftovers. */
const PROBE_PREFIX = '.source-control-bytes-probe-';

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/**
 * Untracked-but-not-ignored files — exactly the set `git status --porcelain`
 * reports as `??`. `--exclude-standard` is what keeps `node_modules/`, `dist/`
 * and every other `.gitignore` entry out, so the sweep needs no ignore list of
 * its own.
 *
 * `maxBuffer` is explicit because the default is 1 MB and THIS listing is the
 * one that can blow it: the tracked listing is bounded by what is committed,
 * while the untracked one is bounded by nothing. Measured — dropping
 * `--exclude-standard` takes it to ~93k paths and `execFileSync` dies with
 * `spawnSync git ENOBUFS` before a single assertion runs, so a mutation of the
 * population reports a SPAWN failure instead of the finding it should. Same
 * reason a developer with a large untracked, non-ignored directory would have
 * seen it.
 */
function untrackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
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
    // Since #2696 the population includes UNTRACKED files, so the binary
    // fallback cannot only say "add its extension to BINARY_EXTENSIONS" —
    // that is wrong advice for a developer's local scratch binary.
    expect(nul).toContain('BINARY_EXTENSIONS');
    expect(nul).toMatch(/UNTRACKED local scratch file/);
    expect(nul).toContain('gitignore');
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
function sweepTree(): { offenders: string[]; tracked: string[]; untracked: string[] } {
  const offenders: string[] = [];
  const read = { tracked: [] as string[], untracked: [] as string[] };

  // Two populations, ONE loop and ONE set of filters — the untracked half is a
  // widening of who is listed, never a second classifier. `read` stays SPLIT
  // because the floors below are per-population: folding the two into one count
  // would let untracked files top up a tracked floor that had collapsed.
  for (const [origin, paths] of [
    ['tracked', trackedFiles()],
    ['untracked', untrackedFiles()],
  ] as const) {
    for (const path of paths) {
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

      // The READ needs its own guard, for the cases the stat above CANNOT
      // absorb — measured, not assumed: a path that is already gone fails
      // `statSync` and is skipped there, so what reaches here is a file that
      // STATTED fine and still cannot be read. Three ways: it vanishes in the
      // stat→read window, it is unreadable (probed live with a mode-000
      // untracked file — unguarded the suite dies on `EACCES: permission
      // denied` with a stack trace instead of reporting a finding), or it is
      // too large (`ERR_FS_FILE_TOO_LARGE`). The untracked half is why this
      // now matters: that population is MUTABLE during a run and is not
      // curated by anyone — a peer session in a sibling worktree, or this
      // file's own probe, writes and removes files in it. A file this sweep
      // cannot read is one it cannot judge, and `read` records only what WAS
      // judged, so the floors stay honest about the skip.
      let content;
      try {
        content = readFileSync(full);
      } catch {
        continue;
      }

      // Cap per file. An unlisted GENUINELY binary file (someone commits a
      // .jar / .bin) is the designed "fails loudly" path — but uncapped it
      // yields ~1 finding per byte, so a 10 MB asset would build millions of
      // strings for vitest to diff. That is an OOM, not a loud message.
      const findings = findControlBytes(content);
      read[origin].push(path);
      for (const finding of findings.slice(0, 5)) {
        offenders.push(describeFinding(path, finding));
      }
      if (findings.length > 5) {
        offenders.push(`${path}: ...and ${findings.length - 5} more control bytes`);
      }
    }
  }

  return { offenders, ...read };
}

describe('the working tree', () => {
  it('has no stray control bytes in any text file, tracked or untracked', () => {
    expect(sweepTree().offenders).toEqual([]);
  });

  it('actually READ a realistic number of TRACKED files, so a broken sweep cannot pass vacuously', () => {
    // Banded against the ~3344 actually read. A loose `> 500` floor was NOT
    // enough: adding `.ts` + `.md` to BINARY_EXTENSIONS neuters the check over
    // 1648 files and still leaves ~1695, which would clear it. The
    // per-extension floors below are what make that specific neuter fail.
    expect(sweepTree().tracked.length).toBeGreaterThan(2500);
  });

  it.each([
    ['.ts', 1000],
    ['.json', 800],
    ['.sh', 200],
    ['.md', 100],
  ])('actually READ the tracked %s files (floor %i), so exempting them by extension fails', (ext, floor) => {
    const read = sweepTree().tracked.filter((p) => p.endsWith(ext));
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

/**
 * The untracked half's own floor.
 *
 * A COUNT is the wrong instrument here, and it would be flaky in the dangerous
 * direction: the untracked set is whatever a developer happens to have lying
 * about, and on a fresh checkout it is EMPTY (measured 0 on this tree), so
 * `untracked.length > N` either fails on a clean checkout or, at N = 0, IS the
 * vacuous pass this widening exists to remove. What is invariant is the
 * RELATION — whatever git reports as untracked-and-not-ignored, the sweep
 * reaches, reads and judges. So the floor SEEDS its own input and requires the
 * sweep to name that file: `.claude/rules/testing.md`'s "a checker must prove it
 * sees its input" and "must also prove it FAILS — against real code", written as
 * a test instead of a by-hand check.
 */
describe('the untracked half of the working tree', () => {
  // Every probe path starts with this, so the pre-clean below can find a
  // leftover from a process that died mid-probe.
  const probeRoot = `${PROBE_PREFIX}${process.pid}`;

  // A NUL-bearing probe lives ~500 ms; a kill inside that window leaves it at
  // the repo root, where — now that untracked files are in the population —
  // it reds the tree-wide sweep above on EVERY later run until someone removes
  // it by hand. Sweeping the prefix at start-up closes that, including a
  // leftover from a DIFFERENT pid. Scoped to entries directly under the repo
  // root whose name carries the prefix, which no real file uses.
  //
  // So the pid in `probeRoot` distinguishes LEFTOVERS, not concurrent runs:
  // this sweep would delete a live probe belonging to a second vitest process
  // running THIS file in THIS worktree at the same moment. That is not a case
  // the repo has — parallel lanes get their own worktree, so their REPO_ROOT
  // differs — and removing a leftover NUL beats tolerating one, because a
  // leaked probe reds every later run for everyone.
  beforeAll(() => {
    for (const entry of readdirSync(REPO_ROOT)) {
      if (entry.startsWith(PROBE_PREFIX)) {
        rmSync(join(REPO_ROOT, entry), { recursive: true, force: true });
      }
    }
  });

  /**
   * Seed one probe file at `relative`, run `body`, then remove the whole
   * top-level entry the probe created.
   *
   * The path is a PARAMETER because the three cases below need three different
   * ones — nested vs. root, and checked vs. gitignored — and one helper with a
   * parameter is cheaper than three seeding mechanisms.
   */
  function withProbe(relative: string, contents: string, body: (relative: string) => void): void {
    // The cleanup below removes `relative`'s FIRST segment recursively, so the
    // parameter added in this round put an `rm -rf` one bad argument away from
    // the worktree: measured, `/abs/x.ts` resolves that segment to REPO_ROOT
    // itself and `../s/x.ts` to its parent. Inert for the callers below, which
    // is exactly why it needs a guard rather than a convention.
    if (!relative.startsWith(PROBE_PREFIX)) {
      throw new Error(`probe path must start with ${PROBE_PREFIX}, got: ${relative}`);
    }
    const absolute = join(REPO_ROOT, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
    try {
      body(relative);
    } finally {
      // The TOP-LEVEL entry, not the file: a nested probe leaves its
      // directories behind otherwise, and an empty directory git does not list
      // would sit at the root forever.
      rmSync(join(REPO_ROOT, relative.split('/')[0]!), { recursive: true, force: true });
    }
    // Restore, asserted OUTSIDE the finally so a failing body reports its own
    // failure first.
    expect(existsSync(absolute)).toBe(false);
  }

  it('READS a freshly written untracked file in a SUBDIRECTORY and REPORTS a raw NUL in it', () => {
    // The path is NESTED and the extension is `.ts`, and both are load-bearing
    // rather than incidental:
    //   * nested, because `git ls-files --others` DESCENDS and a walk that
    //     stopped at the repo root would still satisfy a root-level probe —
    //     while issue #2696's own motivating case was a NUL in an untracked
    //     file under `tests/`. Mutating the population to
    //     `untrackedFiles().filter((p) => !p.includes('/'))` must red here.
    //   * `.ts`, because the tracked half carries four per-extension floors
    //     against a BINARY_EXTENSIONS neuter, and the untracked half has no
    //     real files to floor. A probe with a made-up extension would stay
    //     green under an untracked-only `.ts` exemption; this one does not.
    withProbe(`${probeRoot}/nested/stray.ts`, "const sep = '\u0000';\n", (relative) => {
      const { offenders, tracked, untracked } = sweepTree();
      // Receipt 1 — git really classifies the probe as untracked-and-not-ignored.
      expect(untracked).toContain(relative);
      // Receipt 2 — and it is NOT reachable through the tracked half, so the
      // verdict below can only come from the population this widening added.
      expect(tracked).not.toContain(relative);
      // Receipt 3 — the verdict names THAT file, at THAT offset: "const sep = '"
      // is 13 bytes, so the NUL sits at offset 13 on line 1.
      expect(offenders.filter((o) => o.startsWith(`${relative}:`))).toEqual([
        describeFinding(relative, { byte: 0, offset: 13, line: 1 }),
      ]);
    });
  });

  it('reads a CLEAN untracked file at the repo ROOT without reporting it', () => {
    // Two jobs. The other DIRECTION: without this, a sweep that flagged
    // everything it found untracked would satisfy the case above. And the
    // other DEPTH: the case above moved to a nested path to pin that the walk
    // descends, and had this one moved with it, a walk listing ONLY nested
    // paths — `untrackedFiles().filter((p) => p.includes('/'))` — would have
    // gone unnoticed. Depth coverage has to be ADDED, not relocated.
    withProbe(`${probeRoot}-clean.ts`, "const sep = '\\0';\n", (relative) => {
      const { offenders, untracked } = sweepTree();
      expect(untracked).toContain(relative);
      // Scoped to THIS file, not `offenders` as a whole: the tree-wide verdict
      // is the case above's job, and asserting it again here made a stray
      // control byte ANYWHERE red this case with a message naming a different
      // file (measured while live-testing go-to-k/cdkd#2696 with a seeded
      // untracked NUL). A discrimination case must fail for its own reason.
      expect(offenders.filter((o) => o.startsWith(`${relative}:`))).toEqual([]);
    });
  });

  it('leaves a GITIGNORED file out of the population entirely', () => {
    // `--exclude-standard` is what keeps `node_modules/` and `dist/` out, and
    // until this case it was claimed in prose and pinned by nothing: dropping
    // the flag takes the population from a handful of files to the whole
    // ignored tree, which reds eventually and by accident rather than here and
    // by name. `*.tmp` is a `.gitignore` entry, so this probe is invisible to
    // git — and it carries a NUL, so a sweep that read it anyway could not
    // stay quiet about it.
    withProbe(`${probeRoot}.tmp`, "const sep = '\u0000';\n", (relative) => {
      const { offenders, untracked, tracked } = sweepTree();
      // POSITIVE receipt first. Every other assertion here is an ABSENCE, and
      // absence is what an empty sweep produces too: collapsing BOTH
      // populations to `[]` left this case GREEN while seven of its siblings
      // red, so it was passing on their evidence rather than its own.
      expect(tracked).toContain('package.json');
      expect(untracked).not.toContain(relative);
      expect(tracked).not.toContain(relative);
      expect(offenders.filter((o) => o.startsWith(`${relative}:`))).toEqual([]);
    });
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
