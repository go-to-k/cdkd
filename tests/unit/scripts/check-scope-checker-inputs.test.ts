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
 * Extraction runs TWO literal parsers, because one idiom was not enough.
 *
 * 1. JOIN idiom — join|resolve over a named root variable with string-literal
 *    segments.
 * 2. BARE idiom — a quoted path literal written whole ('.claude/hooks/
 *    branch-gate.sh'), requiring at least one '/' and a file extension.
 *    Added for issue #2381: the JOIN parser is structurally blind to a path
 *    that arrives from a TABLE, and both of that issue's gaps were exactly
 *    that — rule-file-payload.test.ts's PAYLOAD_BUDGETS rows naming four
 *    .claude/hooks/*.sh files, and integ-s3-versions-harness.test.ts's
 *    'docs/testing.md' corpus assertion. Neither was visible here while both
 *    could red the suite against a fresh marker.
 *
 * A bare literal is a CANDIDATE, not proof of a read — a path-shaped string
 * can be a pure-function argument — so NON_READ_LITERALS below carves out the
 * measured false positives by name, with the reason, and is itself asserted
 * exactly so it cannot quietly grow into a blanket suppressor.
 *
 * KNOWN LIMITS that remain, stated because the parser floors cannot bound
 * them (they only fence a parser going dead, not idiom coverage): (a) a
 * root-less relative join (work-issues-skill-refs.test.ts's
 * join('.claude', 'skills', ...) — resolved against cwd, covered today by
 * the skills glob); (b) template-literal paths; (c) a path assembled from
 * segments that never appear as one literal; (d) dynamic paths and repo-wide
 * scanners (git ls-files walks, the rules-corpus walk) — scoping cannot
 * follow a population that is the whole tree, and .markgate.yml's comment
 * states the predicate that decides when such a scanner may be carved out at
 * all (rare-condition assertions may; ordinary-content ones may not). (e) A
 * RECURSIVE corpus walk seeded from a roots ARRAY is not resolved either:
 * integ-s3-versions-harness.test.ts's ROOTS = ['docs', ...] is covered today
 * only because that block ALSO names 'docs/testing.md' as a bare literal.
 * When adding a NEW test that reads a repo file through any of those shapes,
 * add the include entry by hand.
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

/** join|resolve(REPO_ROOT|repoRoot|root|ROOT, 'a', 'b', ...) — literal segments only. */
const JOIN_RE = /(?:join|resolve)\(\s*(?:REPO_ROOT|repoRoot|root|ROOT)\s*((?:,\s*'[^']+')+)\s*\)/g;

/** A whole path written as one quoted literal: at least one '/', ends in an extension. */
const BARE_RE = /['"]([A-Za-z0-9_.][A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]*\.[A-Za-z0-9]+)['"]/g;

/**
 * Path-SHAPED literals that are not reads. Each is an argument to a pure
 * function, so demanding an include entry for it would be noise. Asserted
 * exactly below: this list may only grow by a deliberate edit, because a
 * silently growing carve-out is how the fence stops fencing.
 */
const NON_READ_LITERALS: ReadonlyMap<string, string> = new Map([
  [
    'assets/cdk-vs-cdkd.gif',
    "source-control-bytes.test.ts passes it to isBinaryPath(), a pure string predicate — the file is never opened",
  ],
]);

function record(targets: Map<string, string[]>, rel: string, file: string): void {
  const list = targets.get(rel) ?? [];
  list.push(file.slice(REPO_ROOT.length + 1));
  targets.set(rel, list);
}

function extractJoinTargets(): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const file of testSources()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(JOIN_RE)) {
      const segs = [...m[1].matchAll(/'([^']+)'/g)].map((s) => s[1]);
      if (segs.some((s) => s.includes('..'))) continue; // escapes the root — not a repo path
      record(targets, segs.join('/'), file);
    }
  }
  return targets;
}

function extractBareTargets(): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  const roots = new Set(readdirSync(REPO_ROOT));
  for (const file of testSources()) {
    // THIS file's own path literals are floor declarations, not reads. Counting
    // them would derive part of the population from the fence itself, so
    // deleting the last real reader of a path would leave it demanded anyway —
    // the fence would be asserting against its own text.
    if (file.endsWith('check-scope-checker-inputs.test.ts')) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(BARE_RE)) {
      const rel = m[1];
      if (rel.includes('..') || rel.startsWith('/')) continue;
      if (!roots.has(rel.split('/')[0])) continue; // not repo-root-relative
      if (NON_READ_LITERALS.has(rel)) continue;
      record(targets, rel, file);
    }
  }
  return targets;
}

function extractTargets(): Map<string, string[]> {
  const targets = extractJoinTargets();
  for (const [rel, readers] of extractBareTargets()) {
    targets.set(rel, [...new Set([...(targets.get(rel) ?? []), ...readers])]);
  }
  return targets;
}

function checkIncludeGlobs(): string[] {
  const yml = readFileSync(join(REPO_ROOT, '.markgate.yml'), 'utf8');
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^ {2}check:/.test(l));
  expect(start, '.markgate.yml has a `check:` gate').toBeGreaterThanOrEqual(0);
  // Anchor to the `include:` sub-block, not the whole gate: a future
  // `exclude:` list parsed as include globs would over-cover and mask a
  // miss (reviewer nit on this PR).
  let inInclude = false;
  const globs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) break; // next gate
    if (/^ {4}\S/.test(lines[i])) inInclude = /^ {4}include:/.test(lines[i]);
    const m = lines[i].match(/^ {6}- "([^"]+)"/);
    if (m && inInclude) globs.push(m[1]);
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

  it('parser floor: the JOIN extraction sees the known checker inputs', () => {
    // Literal floor, NOT derived from the include list (a fence derived from
    // its own remedy goes vacuous — the #2362 table-driven lesson). These
    // are reads that exist in tests/unit today; if one moves, update the
    // floor deliberately. Asserted against the JOIN parser ALONE: merged with
    // the bare parser, which also finds every one of these, this floor would
    // stop noticing the join idiom going dead.
    const joinTargets = extractJoinTargets();
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
      expect([...joinTargets.keys()], `JOIN extraction finds ${known}`).toContain(known);
    }
    expect(globs.length, 'include list parsed').toBeGreaterThanOrEqual(10);
  });

  it('parser floor: the BARE extraction sees what the JOIN parser cannot (issue #2381)', () => {
    // These two are the #2381 gaps. Both are read as checker input, neither is
    // written as join(repoRoot, ...), and each reds a different suite when its
    // file is renamed — so a floor naming them is a floor on the idiom this
    // parser exists for, not on the remedy. Deliberately asserted against the
    // BARE parser alone, and deliberately paths the JOIN floor above does NOT
    // contain.
    const bareTargets = extractBareTargets();
    const joinTargets = extractJoinTargets();
    for (const known of ['.claude/hooks/branch-gate.sh', 'docs/testing.md']) {
      expect([...bareTargets.keys()], `BARE extraction finds ${known}`).toContain(known);
      expect(
        [...joinTargets.keys()],
        `${known} must stay a BARE-only case, or this floor stops fencing the bare parser`,
      ).not.toContain(known);
    }
  });

  it('the non-read carve-out list stays exactly what was measured', () => {
    // A carve-out that can grow silently is a suppressor. Each entry is a
    // path-SHAPED literal proved to be a pure-function argument rather than a
    // read; adding one must be a deliberate edit here.
    expect([...NON_READ_LITERALS.keys()].sort()).toEqual(['assets/cdk-vs-cdkd.gif']);
    for (const [rel, why] of NON_READ_LITERALS) {
      expect(why.length, `${rel} needs a stated reason`).toBeGreaterThan(20);
      expect(existsSync(join(REPO_ROOT, rel)), `${rel} still exists`).toBe(true);
    }
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
      // Skip case-folded ALIASES of a real path: on APFS existsSync says
      // true for `docs/_GENERATED` because the filesystem folds case, but
      // that literal is gen-handled-property-wiring.test.ts's deliberate
      // case-folding probe, not a distinct checker input. A path counts
      // only when every segment matches the on-disk entry byte-for-byte.
      {
        const segs = rel.split('/');
        let dir = REPO_ROOT;
        let exact = true;
        for (const seg of segs) {
          if (!readdirSync(dir).includes(seg)) {
            exact = false;
            break;
          }
          dir = join(dir, seg);
        }
        if (!exact) continue;
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
