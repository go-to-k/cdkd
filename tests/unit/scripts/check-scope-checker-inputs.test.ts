import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Checker-INPUT scope fence (issue #2364).
 *
 * The `check` markgate marker attests that the unit suite was green on the
 * digested tree. That attestation is only sound if every file the suite
 * READS is inside the gate's `include` — otherwise an edit to a checker
 * input leaves the marker fresh over a tree the suite would fail on. This
 * class recurred silently: issue #2041 put `work-issues` in scope, then the
 * #2362 split added a test reading EVERY skill directory and the five-skill
 * enumeration went stale with nothing noticing until issue #2364's sweep.
 *
 * This fence derives the population from the TESTS (the readers), not from
 * the include list (the remedy): it extracts every repo-root-relative
 * literal read target from tests/unit sources and asserts each existing
 * target outside `src`/`tests`/`scripts` (already-scoped trees) is matched
 * by a `check` include glob. A new checker input therefore fails here the
 * moment it is written, naming the include entry to add.
 *
 * Extraction is deliberately LITERAL-ONLY (join(REPO_ROOT, '...') /
 * join(repoRoot, ...) / join(root, ...) with string-literal segments):
 * dynamic paths cannot be resolved statically and repo-wide scanners
 * (git ls-files walks, the rules-corpus walk) are the documented known
 * limit in .markgate.yml's comment — scoping cannot follow a population
 * that is the whole tree. The parser floor below keeps "extracted nothing"
 * from passing as "everything is covered".
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');

// Trees whose membership in the check scope is structural, not per-file:
// src/tests/scripts are the gate's own subject; dist and node_modules are
// build outputs, not inputs the marker must track.
const ALREADY_SCOPED = /^(src|tests|scripts|dist|node_modules)(\/|$)/;

function testSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(join(REPO_ROOT, 'tests', 'unit'));
  return out;
}

/** join(REPO_ROOT|repoRoot|root, 'a', 'b', ...) with literal segments only. */
const JOIN_RE = /join\(\s*(?:REPO_ROOT|repoRoot|root)\s*((?:,\s*'[^']+')+)\s*\)/g;

function extractTargets(): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const file of testSources()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(JOIN_RE)) {
      const segs = [...m[1].matchAll(/'([^']+)'/g)].map((s) => s[1]);
      if (segs.some((s) => s.includes('..'))) continue; // escapes the root — not a repo path
      const rel = segs.join('/');
      const list = targets.get(rel) ?? [];
      list.push(file.slice(REPO_ROOT.length + 1));
      targets.set(rel, list);
    }
  }
  return targets;
}

function checkIncludeGlobs(): string[] {
  const yml = readFileSync(join(REPO_ROOT, '.markgate.yml'), 'utf8');
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^ {2}check:/.test(l));
  expect(start, '.markgate.yml has a `check:` gate').toBeGreaterThanOrEqual(0);
  const globs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) break; // next gate
    const m = lines[i].match(/^ {6}- "([^"]+)"/);
    if (m) globs.push(m[1]);
  }
  return globs;
}

/** Minimal glob matcher for the include spellings this repo uses. */
function globToRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` swallows the slash too
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^$()[]{}|\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

describe('check-gate scope covers every literal checker input (issue #2364)', () => {
  const targets = extractTargets();
  const globs = checkIncludeGlobs();
  const res = globs.map(globToRe);

  const covered = (rel: string): boolean => {
    // A directory read (readdirSync target) is covered when files UNDER it
    // are — probe with a sentinel child path as well as the path itself.
    const candidates = [rel, `${rel}/__sentinel__`];
    return candidates.some((c) => res.some((r) => r.test(c)));
  };

  it('parser floor: the extraction sees the known checker inputs', () => {
    // Literal floor, NOT derived from the include list (a fence derived from
    // its own remedy goes vacuous — the #2362 table-driven lesson). These
    // are reads that exist in tests/unit today; if one moves, update the
    // floor deliberately.
    for (const known of [
      '.claude/settings.json',
      '.github/workflows/ci.yml',
      '.github/workflows/pr-inherit-issue-labels.yml',
      '.claude/agents/pr-security-reviewer.md',
      '.claude/hooks/integ-broad-gate.sh',
      '.claude/hooks/pr-review-gate.sh',
      'docs/cli-reference.md',
      'docs/changelog-cdkd.md',
    ]) {
      expect([...targets.keys()], `extraction finds ${known}`).toContain(known);
    }
    expect(globs.length, 'include list parsed').toBeGreaterThanOrEqual(10);
  });

  it('every existing out-of-tree read target is inside the check include', () => {
    const misses: string[] = [];
    for (const [rel, readers] of targets) {
      if (ALREADY_SCOPED.test(rel)) continue;
      const abs = join(REPO_ROOT, rel);
      if (!existsSync(abs)) continue; // fixture-only literals
      // A tracked-file-or-dir read only; skip e.g. generated junk.
      try {
        statSync(abs);
      } catch {
        continue;
      }
      if (!covered(rel)) misses.push(`${rel} (read by ${readers.join(', ')})`);
    }
    expect(
      misses,
      'checker inputs outside the check include — add the path to .markgate.yml `check.include` (see the issue #2364 comment there), or record it as a repo-wide-scanner known limit',
    ).toEqual([]);
  });

  it('the fence itself fails when a covered entry is dropped (self-probe)', () => {
    // Deleting `.claude/settings.json` from the include must flip the main
    // assertion. Simulated here rather than left to a manual mutation
    // probe: re-run coverage with that glob removed and assert a miss
    // appears — this is the "watched it go red" half, kept green by
    // inverting it.
    const without = globs.filter((g) => g !== '.claude/settings.json');
    const resWithout = without.map(globToRe);
    const stillCovered = ['.claude/settings.json', '.claude/settings.json/__sentinel__'].some((c) =>
      resWithout.some((r) => r.test(c)),
    );
    expect(globs).toContain('.claude/settings.json');
    expect(stillCovered, 'dropping the entry uncovers its reader').toBe(false);
  });
});
