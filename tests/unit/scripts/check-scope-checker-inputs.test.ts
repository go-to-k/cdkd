import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
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
 *       integ-s3-versions-harness.test.ts walks ROOTS = ['docs', ...], and
 *       that walk contributes NO target of its own — the harness is visible
 *       here only via the separate 'docs/testing.md' literal beside it. So
 *       what the fence knows about that reader is one file, not the subtree
 *       it really reads. (An earlier draft said rewriting that literal makes
 *       the docs root invisible; measured, it does not — two other REAL docs
 *       literals are read elsewhere, 'docs/cli-deploy.md' and
 *       'docs/_generated/handled-property-wiring.json', beside several
 *       synthetic fixture names. The gap is the WALK, not the root.)
 *       The BARE floor names the literal so it cannot be rewritten silently,
 *       which is a mitigation, not a fix.
 *   (f) Both bare parsers scan COMMENTS as well as code, and cannot tell a
 *       read from any other use of a path-shaped string. That fails toward
 *       demanding an include entry (noise), never toward missing one — but it
 *       also means a NON-read occurrence can satisfy a named floor after the
 *       last real reader is gone. Measured occurrences outside this file:
 *       '.claude/hooks/branch-gate.sh' 1, 'docs/testing.md' 1, 'README.md' 3
 *       — and two of README.md's three are mock fixtures in
 *       codecommit-repository-provider.test.ts, not reads, so that floor
 *       entry alone would survive cc-protection-doc-coverage.test.ts ceasing
 *       to read it. The carve-out list is the only place a use is classified
 *       by hand; everywhere else this parser reports candidates.
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
    'source-control-bytes.test.ts passes it to isBinaryPath() as a dotfile-with-a-non-binary-extension case — the file is never opened',
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
 * Belt-and-braces today: `.markgate.yml` also enters the population from
 * cross-cutting-list-sync.test.ts, so dropping this fold would change nothing
 * right now. It is kept because that co-reader is not this file's to rely on —
 * the day it stops reading the config, this fence's own read is the one that
 * must keep the entry honest.
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
 * tool has already subtracted from. Found by the sibling lane
 * go-to-k/cdk-real-drift#1838.
 *
 * Measured against markgate 0.4.1 in a throwaway repo. The hazard is NOT that
 * adding an exclude to an existing marker turns `verify` green — it does not,
 * because subtracting files changes the digest (rc stays 1). It is that a
 * marker RECORDED while the exclude is present is then permanently blind to
 * the excluded files:
 *
 *   include ["docs/**"], exclude ["docs/a.md"] -> `set` rc=0
 *     edit docs/a.md (excluded) -> `verify` rc=0   <- never blocks again
 *     edit docs/b.md (included) -> `verify` rc=1
 *
 * An earlier revision of this comment stated the rc=1 -> rc=0 transition, from
 * a probe that re-`set` the marker between the two reads — moving two
 * variables while claiming to move one, the exact mistake it warns against.
 *
 * markgate 0.4.1's gate keys, read from the pinned BINARY's schema rather than
 * from `markgate init`'s starter config (which names only six of them, omitting
 * the two this repo would most easily forget): `hash`, `include`, `exclude`,
 * `base`, `ttl`, `state_dir`, `requires`, `composes`. Of those only `include`
 * and `exclude` select FILES. `base` / `ttl` / `requires` / `composes` change
 * when a marker is fresh rather than what it digests, and `state_dir` moves
 * where the marker is written — but `composes` is not inert either, since the
 * binary reports that "composes/requires without include makes the gate
 * deps-only", i.e. a gate with no scope of its own. That is refused rather than
 * modelled: the tripwire below fires on it too. Model the tool's keys, not the
 * ones this repo happens to use today.
 */
type GateScope = { include: string[]; exclude: string[] };

/**
 * markgate 0.4.1's complete gate-key set, read from the pinned BINARY's schema
 * rather than from `markgate init`'s starter config (which emits only six,
 * omitting `requires` and `composes` — precisely the two a repo is likeliest
 * not to have written). Anything outside this set is REFUSED below rather than
 * ignored: an unmodelled key is how a scope silently stops meaning what this
 * fence assumes.
 */
/**
 * `merge: true` is LOAD-BEARING, not a default worth inheriting. YAML's merge
 * key (`<<: *anchor`) splices another mapping's entries into this one, and
 * markgate honours it — measured end-to-end on 0.4.1 with an anchor carrying an
 * `exclude` defined on a SIBLING gate: `set check` rc=0, an edit to the
 * excluded file keeps `verify` at rc=0 permanently, while an edit to an
 * included file still reds. Without this option `yaml` reports the check gate's
 * keys as `["hash", "<<"]` and its `exclude` as undefined, so the scope this
 * fence reasons about is not the scope markgate uses.
 */
const YAML_OPTS = { merge: true } as const;

const MARKGATE_GATE_KEYS = new Set([
  'hash',
  'include',
  'exclude',
  'base',
  'ttl',
  'state_dir',
  'requires',
  'composes',
]);

/** Keys that would change what the marker means in ways this fence cannot model. */
const REFUSED_GATE_KEYS: ReadonlyMap<string, string> = new Map([
  [
    'exclude',
    'markgate resolves scope as include MINUS exclude. resolveCovered() subtracts it, but a marker RECORDED with an exclude present never blocks on an excluded file again (measured on 0.4.1: `set` rc=0, then an edit to an excluded file keeps `verify` at rc=0 permanently while an included file still reds). Re-verify this fence against the installed markgate, then name the new list here.',
  ],
  [
    'composes',
    'the binary reports "composes/requires without include makes the gate deps-only", i.e. a gate with no scope of its own. Nothing here knows how to resolve a composed scope — work out what the marker attests to before removing this.',
  ],
]);

/**
 * Parses one gate out of `.markgate.yml` with the `yaml` package — a PRODUCTION
 * dependency of this repo (package.json), not a scanner written here.
 *
 * This is the third revision, and the first two are the argument for it. A
 * hand-rolled line scanner was written, then patched once per spelling that got
 * through, and each patch was followed by another spelling:
 *
 *   1. block items only            -> a FLOW list (`exclude: ["docs/**"]`) passed
 *   2. unquoted keys only          -> `"exclude":` passed
 *   3. block terminated on /^ {2}\S/ -> a 2-space COMMENT between include and
 *      exclude ended the scan early, and all 14 cases stayed GREEN while
 *      markgate really did subtract (verified against 0.4.1: `config lint` rc=0,
 *      `set` rc=0, an edit to the excluded file then keeps `verify` at rc=0)
 *
 * Three measurements is enough: a hand-rolled scanner for a real grammar is a
 * losing position, and the "raw text tripwire" that was supposed to escape the
 * parser's blind spot inherited every one of them, because it was another
 * hand-rolled pattern over the same text. The sibling lane
 * go-to-k/cdk-real-drift#1838 reached the same conclusion.
 *
 * Reading a real parser is not the failure the earlier tripwire guarded
 * against: `yaml` is third-party, versioned and separately tested, so it is not
 * "the fence checking its own work". What replaces the raw-text tripwire is
 * FAIL-CLOSED key handling — an allow-list of markgate's keys plus an explicit
 * refusal list — which is strictly stronger than deny-listing the two spellings
 * someone thought of.
 */
function parseGateScope(yml: string, gate: string): GateScope {
  const doc = parseYaml(yml, YAML_OPTS) as { gates?: Record<string, unknown> } | null;
  const raw = doc?.gates?.[gate];
  expect(raw, `.markgate.yml has a \`${gate}:\` gate`).toBeTruthy();
  const g = raw as Record<string, unknown>;

  const unknown = Object.keys(g).filter((k) => !MARKGATE_GATE_KEYS.has(k));
  expect(
    unknown,
    `the \`${gate}\` gate carries key(s) markgate 0.4.1 does not define: ${unknown.join(', ')}. Either it is a typo markgate silently ignores (its \`config lint\` reports these, but nothing in this repo runs it), or markgate gained a key and this fence has not been taught what it means for scope. Fail closed until that is settled.`,
  ).toEqual([]);

  const list = (v: unknown): string[] =>
    v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map((x) => String(x));
  return { include: list(g['include']), exclude: list(g['exclude']) };
}

function checkGateScope(): GateScope {
  return parseGateScope(readFileSync(join(REPO_ROOT, '.markgate.yml'), 'utf8'), 'check');
}

/** The parsed `check` gate object, for assertions about keys rather than values. */
function checkGateRaw(): Record<string, unknown> {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, '.markgate.yml'), 'utf8'), YAML_OPTS) as {
    gates?: Record<string, unknown>;
  };
  return (doc.gates?.['check'] ?? {}) as Record<string, unknown>;
}

/**
 * markgate's file scope for a `hash: files` gate: `include` MINUS `exclude`.
 * A directory read (a readdirSync target) counts as covered when files UNDER it
 * are, so the include is probed with a sentinel child as well as the path —
 * but the EXCLUDE is tested against the real path too, or an exact-path exclude
 * would be escaped by the sentinel that only exists to widen the include.
 */
function resolveCovered(rel: string, scope: GateScope): boolean {
  const inc = scope.include.map(globToRe);
  const exc = scope.exclude.map(globToRe);
  if (exc.some((r) => r.test(rel))) return false;
  return [rel, `${rel}/__sentinel__`].some(
    (c) => inc.some((r) => r.test(c)) && !exc.some((r) => r.test(c)),
  );
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
  'docs/cli-deploy.md',
  'docs/changelog-cdkd.md',
] as const;

describe('gate-scope resolution matches markgate (include MINUS exclude)', () => {
  // The delta's headline behaviour needs coverage that does not depend on the
  // repo's current config: round 2 measured that BOTH the exclude arm of the
  // parser and the subtraction in the resolver could be deleted with every
  // other case green, because nothing exercised them. These fixtures do.
  const FIXTURE = [
    'gates:',
    '  check:',
    '    hash: files',
    '    include:',
    '      - "src/**"',
    "      - 'docs/**'",
    '      - README.md',
    '    exclude:',
    '      - "docs/_generated/**"',
    '  other:',
    '    hash: files',
    '    include:',
    '      - "nope/**"',
  ].join('\n');

  const FLOW = ['gates:', '  check:', '    include: ["src/**"]', '    exclude: ["src/vendor/**"]'].join('\n');

  it('parses block items in every quoting style, and stops at the next gate', () => {
    const scope = parseGateScope(FIXTURE, 'check');
    expect(scope.include).toEqual(['src/**', 'docs/**', 'README.md']);
    expect(scope.exclude).toEqual(['docs/_generated/**']);
  });

  it('parses a FLOW sequence, the spelling the first revision was blind to', () => {
    const scope = parseGateScope(FLOW, 'check');
    expect(scope.include).toEqual(['src/**']);
    expect(scope.exclude).toEqual(['src/vendor/**']);
  });

  it('a QUOTED key is parsed, because markgate honours one', () => {
    // Measured on 0.4.1: with `"exclude": ["docs/a.md"]` the marker sets rc=0,
    // an edit to docs/a.md keeps verify at rc=0, and an edit to docs/b.md reds.
    // An unquoted-only match let exactly this spelling through the parser AND
    // the raw tripwire — the headline failure surviving in one spelling.
    const scope = parseGateScope(
      ['gates:', '  check:', '    "include":', '      - "src/**"', "    'exclude': ['src/vendor/**']"].join('\n'),
      'check',
    );
    expect(scope.include).toEqual(['src/**']);
    expect(scope.exclude).toEqual(['src/vendor/**']);
  });

  it('a BLOCK-list sibling key does not leak its items into include', () => {
    // Shape matters here, and the first version had it wrong. With the sibling
    // key written as a FLOW list (`requires: [a, b]`) there are no `- ` items
    // to leak, so the case passed whatever the parser did — it could not fail.
    // Measured on the hand-rolled predecessor: deleting its key-reset arm made
    // a fixture like this yield `include: ["src/**", "docs/**"]`, i.e. OVER-
    // covering, which masks a miss.
    //
    // So: a NON-list key sandwiched between two BLOCK lists, and the trailing
    // one carries a path-shaped item that would be visible in `include` if it
    // leaked.
    const scope = parseGateScope(
      [
        'gates:',
        '  check:',
        '    include:',
        '      - "src/**"',
        '    ttl: 14d',
        '    requires:',
        '      - docs',
        '    state_dir: .markgate-cache',
        '    exclude:',
        '      - "src/vendor/**"',
      ].join('\n'),
      'check',
    );
    expect(scope.include, 'a sibling block list must not leak into include').toEqual(['src/**']);
    expect(scope.exclude, 'and the real exclude must still be found past two non-list keys').toEqual([
      'src/vendor/**',
    ]);
  });

  it('a 2-space COMMENT between include and exclude does not hide the exclude', () => {
    // The spelling that defeated revision 3 and left all 14 cases GREEN. The
    // hand-rolled scanner ended the gate block at /^ {2}\S/, which a 2-space
    // comment matches. Verified against markgate 0.4.1 that the tool itself
    // honours this file: `config lint` rc=0, `set` rc=0, then an edit to
    // docs/a.md keeps `verify` at rc=0 while an edit to docs/b.md reds.
    const scope = parseGateScope(
      [
        'gates:',
        '  check:',
        '    hash: files',
        '    include:',
        '      - "docs/**"',
        '  # a note at two-space indent',
        '    exclude: ["docs/a.md"]',
      ].join('\n'),
      'check',
    );
    expect(scope.include).toEqual(['docs/**']);
    expect(scope.exclude).toEqual(['docs/a.md']);
    expect(resolveCovered('docs/a.md', scope), 'the hidden exclude subtracts').toBe(false);
    expect(resolveCovered('docs/b.md', scope), 'a sibling is still covered').toBe(true);
  });

  it('an UNKNOWN gate key fails CLOSED rather than being ignored', () => {
    // The generalisation of the three spellings that got through: refuse what
    // is not modelled instead of deny-listing what someone thought of. markgate
    // 0.4.1 silently ignores an unknown key at runtime, and its `config lint`
    // would report one — but nothing in this repo runs `config lint`, so this
    // assertion is the only thing standing there.
    expect(() =>
      parseGateScope(
        ['gates:', '  check:', '    include:', '      - "src/**"', '    ignore:', '      - "src/vendor/**"'].join(
          '\n',
        ),
        'check',
      ),
    ).toThrow(/does not define: ignore/);
  });

  it('a gate key markgate DOES define is accepted', () => {
    // The other direction, so the allow-list cannot be satisfied by refusing
    // everything: all eight of markgate 0.4.1's keys parse without throwing.
    const scope = parseGateScope(
      [
        'gates:',
        '  check:',
        '    hash: diff',
        '    base: origin/main',
        '    ttl: 14d',
        '    state_dir: .markgate-cache',
        '    requires: [docs]',
        '    include:',
        '      - "src/**"',
        '    exclude:',
        '      - "src/vendor/**"',
      ].join('\n'),
      'check',
    );
    expect(scope.include).toEqual(['src/**']);
    expect(scope.exclude).toEqual(['src/vendor/**']);
  });

  it('subtracts exclude from include, and an exact-path exclude is not escaped by the sentinel', () => {
    const scope = parseGateScope(FIXTURE, 'check');
    expect(resolveCovered('src/a.ts', scope), 'plain include hit').toBe(true);
    expect(resolveCovered('docs/testing.md', scope), 'include hit, no exclude').toBe(true);
    expect(resolveCovered('docs/_generated/x.json', scope), 'exclude subtracts').toBe(false);
    // The sentinel child exists to make a DIRECTORY read count as covered. It
    // must not become a way around an exact-path exclude: `docs/testing.md`
    // excluded by name still has an unexcluded `docs/testing.md/__sentinel__`.
    const exact = { include: ['docs/**'], exclude: ['docs/testing.md'] };
    expect(resolveCovered('docs/testing.md', exact), 'exact-path exclude holds').toBe(false);
    expect(resolveCovered('docs/other.md', exact), 'a sibling is still covered').toBe(true);
  });

  it('globToRe escapes a literal dot rather than treating it as any character', () => {
    // Unfenced, `.` matched anything and nothing noticed — so `docs/aXmd`
    // would count as covered by `docs/a.md`.
    expect(globToRe('docs/a.md').test('docs/a.md')).toBe(true);
    expect(globToRe('docs/a.md').test('docs/aXmd')).toBe(false);
    expect(globToRe('src/**').test('src/a/b.ts')).toBe(true);
    expect(globToRe('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});

describe('check-gate scope covers every literal checker input (issue #2364)', () => {
  const targets = extractTargets();
  const scope = checkGateScope();
  const globs = scope.include;
  const covered = (rel: string): boolean => resolveCovered(rel, scope);

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
    // 19 entries on the shipping tree (this PR replaced six precise entries
    // with two globs, 22 -> 19). Floored at 15: a floor nine entries under its
    // subject would survive most of the list being deleted, which is the
    // failure a parse floor exists to catch.
    expect(globs.length, 'include list parsed').toBeGreaterThanOrEqual(15);
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
    // Measured 97 on the shipping tree (99 with the carve-out disabled), by
    // appending a probe case to this file that prints
    // `[...extractBareTargets().keys()].filter((k) => !joinKeys.has(k)).length`.
    // A review round measured 93 from an isolated `git archive` copy — the
    // number is tree-dependent, so it is worth naming which tree rather than
    // treating either as wrong. Floored at 75 (~77%) so ordinary churn is free
    // while a narrowing is not. The first revision floored this at 5, which a
    // 95% collapse would have passed — a floor far under its subject fences
    // only total disappearance, which the named paths above already catch.
    expect(
      bareOnly.length,
      `the bare parser reaches only ${bareOnly.length} target(s) the join parser misses; it was narrowed toward what the join idiom already covers, so it is no longer fencing the table-sourced idiom it exists for`,
    ).toBeGreaterThanOrEqual(75);
  });

  it('the root-file shape reaches real root files and no directory', () => {
    // What this pins is the OUTCOME, not the mechanism. Two things reject a
    // directory here and only one of them is the statSync isFile guard: the
    // regex already requires an extension, and no tracked repo-root DIRECTORY
    // has one ('docs', 'skills', '.github', '.claude' all fail the regex).
    // Measured round 2: mutating the guard to always-true reds nothing, and
    // that is not a hole — it is the guard being a forward defence against a
    // future dotted directory name, which today's tree does not contain. Said
    // plainly here so a later reader does not mistake this case for a fence on
    // the guard.
    const rootShaped = [...extractBareTargets().keys()].filter((k) => !k.includes('/'));
    expect(rootShaped.length, 'the root-file shape reaches something').toBeGreaterThan(0);
    const dirs = rootShaped.filter((k) => {
      try {
        return statSync(join(REPO_ROOT, k)).isDirectory();
      } catch {
        return false;
      }
    });
    expect(dirs, `${dirs.join(', ')} are directories, not files`).toEqual([]);
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
    //
    // This checks OCCURRENCE, not verdict: it cannot tell that a still-present
    // literal has been converted from a pure-function argument into a real
    // read. That judgement is not mechanically decidable from the text, so the
    // reason string beside each entry is what a future reader re-checks.
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

  it('the check gate carries no key this fence cannot model (fail CLOSED)', () => {
    // Replaces a raw-text tripwire that existed to escape a hand-rolled
    // parser's blind spot — and inherited every one of them, being another
    // hand-rolled pattern over the same text (three spellings got through in
    // three rounds; go-to-k/cdk-real-drift#1838). With the `yaml` package doing
    // the parsing, the escape hatch is not needed; what replaces it is an
    // ALLOW-LIST of markgate's keys plus this explicit refusal list, which is
    // strictly stronger than deny-listing the spellings someone thought of.
    //
    // parseGateScope() already fails on a key outside markgate's set. This
    // case covers keys that ARE markgate's but whose meaning this fence does
    // not model.
    const g = checkGateRaw();
    for (const [key, why] of REFUSED_GATE_KEYS) {
      expect(Object.keys(g), `the \`check\` gate grew a \`${key}:\` key. ${why}`).not.toContain(key);
    }
    // And the value-level view must agree, so the two cannot drift.
    expect(scope.exclude, 'key-level and value-level views disagree about exclude').toEqual([]);
  });

  it('no gate ANYWHERE declares exclude / composes / a merge key (whole-map raw check)', () => {
    // Scoped to the WHOLE `gates:` map, not the `check` block, and that is the
    // structural point rather than a widening for its own sake: a YAML anchor
    // is DEFINED on one gate and SPLICED into another, so an `exclude` that
    // reaches `check` through `<<: *sh` is not written anywhere inside the
    // `check` block at all. A per-block scan cannot see it by construction —
    // measured on markgate 0.4.1, an anchor carrying `exclude` on a sibling
    // gate makes `set check` rc=0 and then leaves an edit to the excluded file
    // at `verify` rc=0 forever, with an included file still redding.
    //
    // This is a coarse, deliberately OVER-broad backstop: it refuses a sibling
    // gate's own legitimate `exclude` too. That is the right direction to fail
    // — the parsed check above is the precise instrument, and this exists for
    // the case where the parser and markgate disagree.
    const yml = readFileSync(join(REPO_ROOT, '.markgate.yml'), 'utf8');
    const gatesAt = yml.indexOf('\ngates:');
    expect(gatesAt, '.markgate.yml has a top-level `gates:` map').toBeGreaterThanOrEqual(0);
    const gatesMap = yml.slice(gatesAt);
    const offenders = gatesMap
      .split('\n')
      .map((line, i) => ({ line, n: i }))
      .filter(({ line }) => !/^\s*#/.test(line))
      .filter(({ line }) => /^\s*["']?(exclude|composes)["']?:/.test(line) || /^\s*<<\s*:/.test(line))
      .map(({ line }) => line.trim());
    expect(
      offenders,
      `the \`gates:\` map declares ${offenders.join(' | ')}. Any of these can change what the \`check\` marker attests to — \`exclude\` subtracts from scope, \`composes\` can make a gate deps-only, and a merge key splices another gate's entries in (which is how an exclude reaches \`check\` without appearing in its block). Re-verify this fence against the installed markgate before removing this.`,
    ).toEqual([]);
  });

  it('the check gate is still `hash: files`, which is what this fence assumes', () => {
    // Stated in prose above and asserted nowhere until now. Under `hash: diff`
    // the marker digests a BRANCH DELTA rather than file content, so "every
    // checker input is inside the include" stops being the property that makes
    // the marker sound — an unchanged-but-red input would not be digested at
    // all.
    expect(
      checkGateRaw()['hash'],
      'the `check` gate changed hash type; this fence reasons about file-content scope and does not model a branch-delta digest',
    ).toBe('files');
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
    // assertion. Simulated here rather than left to a manual mutation probe:
    // re-run coverage with that glob removed and assert a miss appears — the
    // "watched it go red" half, kept green by inverting it.
    //
    // Routed through resolveCovered(), the SAME predicate the main assertion
    // uses. An inline re-implementation cannot see that predicate regress, so
    // the twin has to mirror it rather than merely resemble it.
    expect(globs).toContain('.claude/settings.json');
    expect(
      resolveCovered('.claude/settings.json', scope),
      'the entry covers its reader while present',
    ).toBe(true);
    expect(
      resolveCovered('.claude/settings.json', {
        include: globs.filter((g) => g !== '.claude/settings.json'),
        exclude: scope.exclude,
      }),
      'dropping the entry uncovers its reader',
    ).toBe(false);
  });
});
