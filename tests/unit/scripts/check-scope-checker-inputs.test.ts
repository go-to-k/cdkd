import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
 * Scope is resolved as markgate resolves it — `include` MINUS `exclude` — see
 * checkGateScope() for why that is not a detail.
 *
 * KNOWN LIMITS that remain, stated because the parser floors cannot bound
 * them (they only fence a parser going dead, not idiom coverage), each
 * verified by probe rather than assumed:
 *   (a) A root-less relative join — work-issues-skill-refs.test.ts's
 *       join('.claude', 'skills', ...), resolved against cwd, covered today
 *       by the skills glob.
 *   (b) Template-literal paths.
 *   (c) A path assembled from segments that never appear as one literal
 *       (measured: `['docs','testing.md'].join('/')` is invisible).
 *   (d) Dynamic paths and repo-wide scanners (git ls-files walks, the
 *       rules-corpus walk) — scoping cannot follow a population that is the
 *       whole tree. .markgate.yml's comment states the predicate that decides
 *       when such a scanner may be carved out at all: rare-condition
 *       assertions may, ordinary-content ones may not.
 *   (e) A RECURSIVE corpus walk seeded from a roots ARRAY is not resolved.
 *       integ-s3-versions-harness.test.ts's ROOTS = ['docs', ...] is covered
 *       today only because that block ALSO names 'docs/testing.md' as a bare
 *       literal — measured: rewrite that one literal and the docs root goes
 *       invisible again. The BARE floor names it so it cannot be rewritten
 *       silently, which is a mitigation, not a fix.
 *   (f) Both bare parsers scan COMMENTS as well as code, so a quoted path in
 *       a comment is a candidate. That fails toward demanding an include
 *       entry (noise), never toward missing one — but it also means a
 *       commented-out path could satisfy a floor after its last real reader
 *       is gone. Measured today: each floor path has exactly one non-fence
 *       occurrence, all of them real reads.
 *   (g) The bare parsers' character class covers what this repo's tracked
 *       paths actually use. A path containing a space, `+`, `(`, `)` or `~`
 *       is not matched — measured: no tracked path uses one. Widening the
 *       class costs precision against ordinary prose, so it is deliberately
 *       deferred until a real path needs it.
 * When adding a NEW test that reads a repo file through any of those shapes,
 * add the include entry by hand.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');

/**
 * This file is excluded from BOTH parsers' scans, compared by RESOLVED PATH
 * rather than by filename suffix (an `endsWith` test would drop every file
 * whose name merely ENDS with this one's — a hole a real read could hide in).
 *
 * The reason is self-satisfaction: this file's own text is full of path
 * literals that are declarations, not reads — floor entries, carve-out keys,
 * and worked examples in the doc comments. Scanned, they enter the population
 * the fence then asserts over, so a floor can be satisfied by the fence's own
 * prose after every real reader has gone. That is not hypothetical: an earlier
 * revision of this file explained the count-based floor with a comment
 * containing a literal `join(REPO_ROOT, 'docs', ...)` example, and the JOIN
 * parser recorded it as a real read of that path. The sibling lane
 * go-to-k/cdk-real-drift#1838 shipped the same shape with 3 self-matches
 * against a floor of 3.
 *
 * Genuine reads this file DOES perform are declared in SELF_READS below.
 */
const SELF = fileURLToPath(import.meta.url);

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

/**
 * A whole path written as one quoted literal, in two shapes:
 *  - BARE_DIR_RE  — has at least one '/' and ends in an extension.
 *  - BARE_ROOT_RE — a repo-ROOT file with no directory at all ('README.md').
 *
 * The second exists because requiring a '/' hides a real population: a table
 * row naming a root file is invisible to BOTH parsers. Measured on this tree —
 * cc-protection-doc-coverage.test.ts reads 'README.md' exactly that way, and
 * README.md is only accidentally in scope. Restricting the second shape to an
 * existing repo-root FILE with an extension keeps the noise at one entry
 * (segment names like 'docs' and extension-less roots like LICENSE are not
 * matched at all).
 */
const BARE_DIR_RE = /['"]([A-Za-z0-9_.][A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]*\.[A-Za-z0-9]+)['"]/g;
const BARE_ROOT_RE = /['"]([A-Za-z0-9_.][A-Za-z0-9_.-]*\.[A-Za-z0-9]+)['"]/g;

/**
 * Path-SHAPED literals that are not reads. Each is an argument to a pure
 * function, so demanding an include entry for it would be noise.
 *
 * Two assertions keep this honest, because a carve-out list rots in two
 * opposite directions: the key set is asserted EXACTLY (it cannot grow into a
 * blanket suppressor), and every entry is re-audited against the scan run with
 * the carve-out DISABLED (it cannot outlive the literal it exempts — the
 * exemption-outlives-its-reason shape `scripts/check-provider-secret-mask.ts`
 * re-audits its own EXEMPT verdicts for).
 */
const NON_READ_LITERALS: ReadonlyMap<string, string> = new Map([
  [
    'assets/cdk-vs-cdkd.gif',
    'source-control-bytes.test.ts passes it to isBinaryPath(), a pure string predicate — the file is never opened',
  ],
  [
    '.mise.toml',
    'source-control-bytes.test.ts passes it to isBinaryPath() as the extension-less-config case — the file is never opened',
  ],
]);

function record(targets: Map<string, string[]>, rel: string, file: string): void {
  const list = targets.get(rel) ?? [];
  list.push(file.slice(REPO_ROOT.length + 1));
  targets.set(rel, list);
}

/**
 * Reads this file itself performs. Declared rather than scanned, because BOTH
 * parsers skip this file (see SELF below) and a real read must not be lost with
 * the phantoms.
 *
 * Keep this list tiny. If it grows, ask whether the fence has started doing
 * work that belongs in a separate test.
 */
const SELF_READS: ReadonlyMap<string, string> = new Map([
  ['.markgate.yml', 'checkGateScope() parses the check gate include/exclude out of it'],
]);

function extractJoinTargets(): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const file of testSources()) {
    if (file === SELF) continue; // see SELF
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(JOIN_RE)) {
      const segs = [...m[1].matchAll(/'([^']+)'/g)].map((s) => s[1]);
      if (segs.some((s) => s.includes('..'))) continue; // escapes the root — not a repo path
      record(targets, segs.join('/'), file);
    }
  }
  return targets;
}

/**
 * Repo-root entries TRACKED by git, not `readdirSync(REPO_ROOT)`. The working
 * tree also holds untracked and gitignored roots (`dist`, `coverage`, a scratch
 * directory), which would make the population differ between two machines
 * running the same commit.
 */
function trackedRootSegments(): Set<string> {
  return new Set(
    execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean)
      .map((f) => f.split('/')[0]),
  );
}

/**
 * `carveOut: false` re-runs the same scan with NON_READ_LITERALS ignored, which
 * is what lets the carve-out be audited against the population instead of only
 * against itself.
 */
function extractBareTargets(carveOut = true): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  const roots = trackedRootSegments();
  for (const file of testSources()) {
    // THIS file's own path literals are floor declarations, not reads. Counting
    // them would derive part of the population from the fence itself, so
    // deleting the last real reader of a path would leave it demanded anyway —
    // the fence asserting against its own text. Compared by RESOLVED PATH, not
    // by filename suffix: an `endsWith` test drops every file whose name merely
    // ENDS with this one's, which is a hole a real read could hide in.
    if (file === SELF) continue;
    const src = readFileSync(file, 'utf8');
    for (const re of [BARE_DIR_RE, BARE_ROOT_RE]) {
      for (const m of src.matchAll(re)) {
        const rel = m[1];
        if (rel.includes('..') || rel.startsWith('/')) continue;
        if (!roots.has(rel.split('/')[0])) continue; // not repo-root-relative
        if (carveOut && NON_READ_LITERALS.has(rel)) continue;
        if (!rel.includes('/')) {
          // Root shape: accept only an existing FILE, so a bare directory or
          // package-ish literal cannot enter the population.
          let isFile = false;
          try {
            isFile = statSync(join(REPO_ROOT, rel)).isFile();
          } catch {
            isFile = false;
          }
          if (!isFile) continue;
        }
        record(targets, rel, file);
      }
    }
  }
  return targets;
}

function extractTargets(): Map<string, string[]> {
  const targets = extractJoinTargets();
  for (const [rel, readers] of extractBareTargets()) {
    targets.set(rel, [...new Set([...(targets.get(rel) ?? []), ...readers])]);
  }
  const selfRel = SELF.slice(REPO_ROOT.length + 1);
  for (const rel of SELF_READS.keys()) {
    targets.set(rel, [...new Set([...(targets.get(rel) ?? []), selfRel])]);
  }
  return targets;
}

/**
 * markgate's file scope for a `hash: files` gate is `include` MINUS `exclude`,
 * so a fence modelling only `include` reports full coverage over a scope the
 * tool has already subtracted from. Measured against markgate 0.4.1 in a
 * throwaway repo, holding `include` CONSTANT and changing only `exclude` (a
 * probe that moves two variables proves nothing about either): with
 * `include: ["docs/**"]` an edit to `docs/a.md` gives `verify` rc=1; adding
 * `exclude: ["docs/**"]` and nothing else gives rc=0 — and `set` still exits 0,
 * so the gate becomes one that can never block. Found by the sibling lane
 * go-to-k/cdk-real-drift#1838.
 *
 * markgate 0.4.1's gate keys, from `markgate init`'s starter config: `hash`,
 * `include`, `exclude`, `base`, `ttl`, `state_dir`, `requires`. Of those only
 * `include` and `exclude` select FILES; `base` / `ttl` / `requires` change when
 * a marker is fresh rather than what it digests, and `state_dir` moves where
 * the marker is written. Model the tool's keys, not the ones this repo happens
 * to use today.
 */
function checkGateScope(): { include: string[]; exclude: string[] } {
  const yml = readFileSync(join(REPO_ROOT, '.markgate.yml'), 'utf8');
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^ {2}check:/.test(l));
  expect(start, '.markgate.yml has a `check:` gate').toBeGreaterThanOrEqual(0);
  const out: { include: string[]; exclude: string[] } = { include: [], exclude: [] };
  let key: 'include' | 'exclude' | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) break; // next gate
    if (/^ {4}\S/.test(lines[i])) {
      key = /^ {4}include:/.test(lines[i])
        ? 'include'
        : /^ {4}exclude:/.test(lines[i])
          ? 'exclude'
          : undefined;
    }
    const m = lines[i].match(/^ {6}- "([^"]+)"/);
    if (m && key) out[key].push(m[1]);
  }
  return out;
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

/**
 * Reads that exist in tests/unit today and are written in the JOIN idiom.
 * A literal floor, NOT derived from the include list — a fence derived from its
 * own remedy goes vacuous (the go-to-k/cdkd#2362 table-driven lesson). If one
 * moves, update this deliberately.
 */
const JOIN_FLOOR = [
  '.claude/settings.json',
  '.github/workflows/ci.yml',
  '.github/workflows/pr-inherit-issue-labels.yml',
  '.claude/agents/pr-security-reviewer.md',
  '.claude/hooks/integ-broad-gate.sh',
  '.claude/hooks/pr-review-gate.sh',
  'docs/cli-reference.md',
  'docs/changelog-cdkd.md',
] as const;

describe('check-gate scope covers every literal checker input (issue #2364)', () => {
  const targets = extractTargets();
  const scope = checkGateScope();
  const globs = scope.include;
  const res = globs.map(globToRe);
  const excludeRes = scope.exclude.map(globToRe);

  const covered = (rel: string): boolean => {
    // A directory read (readdirSync target) is covered when files UNDER it
    // are — probe with a sentinel child path as well as the path itself.
    const candidates = [rel, `${rel}/__sentinel__`];
    // include MINUS exclude, the way markgate resolves it: a path an exclude
    // subtracts is NOT in scope however many includes name it.
    return candidates.some(
      (c) => res.some((r) => r.test(c)) && !excludeRes.some((r) => r.test(c)),
    );
  };

  it('parser floor: the JOIN extraction sees the known checker inputs', () => {
    // Literal floor, NOT derived from the include list (a fence derived from
    // its own remedy goes vacuous — the #2362 table-driven lesson). These
    // are reads that exist in tests/unit today; if one moves, update the
    // floor deliberately. Asserted against the JOIN parser ALONE: merged with
    // the bare parser, which also finds every one of these, this floor would
    // stop noticing the join idiom going dead.
    const joinTargets = extractJoinTargets();
    for (const known of JOIN_FLOOR) {
      expect([...joinTargets.keys()], `JOIN extraction finds ${known}`).toContain(known);
    }
    expect(globs.length, 'include list parsed').toBeGreaterThanOrEqual(10);
  });

  it('parser floor: the BARE extraction sees what the JOIN parser cannot (issue #2381)', () => {
    // These three are read as checker input and none is written as
    // join(repoRoot, ...), so a floor naming them is a floor on the idiom this
    // parser exists for, not on the remedy. The first two are the #2381 gaps
    // (each reds a different suite when its file is renamed); README.md is the
    // root-file shape, invisible to both parsers before this revision.
    const bareTargets = extractBareTargets();
    for (const known of ['.claude/hooks/branch-gate.sh', 'docs/testing.md', 'README.md']) {
      expect([...bareTargets.keys()], `BARE extraction finds ${known}`).toContain(known);
    }

    // The floor must also prove the bare parser reaches a population the JOIN
    // parser does not — otherwise it would still pass with BARE_* narrowed to
    // whatever the join idiom already covers. Asserted as a COUNT rather than
    // per-path: pinning a named path as BARE-ONLY reds on an innocent change
    // (someone writing an ordinary join-idiom read of that same path is not a
    // defect), while the count only falls when the parser narrows.
    const joinKeys = new Set(extractJoinTargets().keys());
    const bareOnly = [...bareTargets.keys()].filter((k) => !joinKeys.has(k));
    expect(
      bareOnly.length,
      `the bare parser reaches only ${bareOnly.length} target(s) the join parser misses (${bareOnly.join(', ')}); it was narrowed to what the join idiom already covers, so it is no longer fencing the table-sourced idiom it exists for`,
    ).toBeGreaterThanOrEqual(5);
  });

  it('the non-read carve-out list stays exactly what was measured, and every entry is still LIVE', () => {
    // Direction 1 — it cannot grow silently into a blanket suppressor.
    expect([...NON_READ_LITERALS.keys()].sort()).toEqual(['.mise.toml', 'assets/cdk-vs-cdkd.gif']);
    for (const [rel, why] of NON_READ_LITERALS) {
      expect(why.length, `${rel} needs a stated reason`).toBeGreaterThan(20);
      expect(existsSync(join(REPO_ROOT, rel)), `${rel} still exists`).toBe(true);
    }

    // Direction 2 — and it cannot outlive the literal it exempts. Without this,
    // deleting or rewriting the exempted literal leaves a dead entry that
    // silently suppresses the NEXT read of the same path. Measured: a reviewer
    // renamed the gif literal and all five cases stayed green.
    const uncarved = new Set(extractBareTargets(false).keys());
    const dead = [...NON_READ_LITERALS.keys()].filter((rel) => !uncarved.has(rel));
    expect(
      dead,
      `${dead.join(', ')} no longer occurs as a path literal in tests/unit, so the carve-out exempts nothing and would silently suppress a future real read of the same path. Drop the entry.`,
    ).toEqual([]);
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

  it('the check gate has no `exclude`, and this fence subtracts one if it grows (go-to-k/cdk-real-drift#1838)', () => {
    // A TRIPWIRE, not a prohibition. `covered()` above already subtracts
    // `exclude` the way markgate does, so an exclude that removes a checker
    // input reds the main assertion. This case exists because the resolver is a
    // RE-IMPLEMENTATION of another tool's semantics: the day someone adds the
    // first exclude is the day to re-read it against markgate's behaviour
    // rather than to trust a transcription written when no exclude existed.
    expect(
      scope.exclude,
      'the `check` gate grew an `exclude:` list. That is allowed — but markgate resolves scope as include MINUS exclude, so re-verify this fence against the installed markgate first (measured on 0.4.1: adding `exclude: ["docs/**"]` to an unchanged `include: ["docs/**"]` takes `verify` from rc=1 to rc=0, and `set` still exits 0), then update this expectation to the new list.',
    ).toEqual([]);

    // Guard-the-guard: an exclude is only subtracted if the parser SEES it.
    // Feed the resolver's matcher a synthetic exclude and confirm it bites.
    const synthetic = ['.claude/settings.json'].map(globToRe);
    expect(
      synthetic.some((r) => r.test('.claude/settings.json')),
      'the exclude matcher can match a real include entry, so subtraction is live rather than structurally inert',
    ).toBe(true);
  });

  it('this file contributes no scanned target, and its declared self-reads are LIVE', () => {
    // Direction 1 — the exclusion works. If it stops working, every floor in
    // this file becomes satisfiable by the file's own declarations and prose,
    // which is the shape go-to-k/cdk-real-drift#1838 shipped (3 self-matches
    // against a floor of 3) and an earlier revision of this file reproduced.
    const selfRel = SELF.slice(REPO_ROOT.length + 1);
    const scanned = [
      ...[...extractJoinTargets().values()].flat(),
      ...[...extractBareTargets(false).values()].flat(),
    ];
    expect(
      scanned.filter((r) => r === selfRel),
      'this file appears as a READER in a scanned population; the SELF exclusion is not matching, so this file\'s floor entries and doc-comment examples are now targets it asserts over',
    ).toEqual([]);

    // Direction 2 — and the reads it really does perform are not lost with the
    // phantoms. Re-scan this file ALONE and require each declared entry to
    // actually occur, so the declaration cannot outlive the code.
    const src = readFileSync(SELF, 'utf8');
    const seen = new Set(
      [...src.matchAll(JOIN_RE)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).join('/')),
    );
    for (const [rel, why] of SELF_READS) {
      expect(why.length, `${rel} needs a stated reason`).toBeGreaterThan(20);
      expect(seen, `SELF_READS declares ${rel} but this file no longer reads it — drop the entry`).toContain(rel);
    }
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
