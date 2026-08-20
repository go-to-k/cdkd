import { describe, it, expect } from 'vite-plus/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * TWO hand-duplicated lists live behind the `integ-broad` gate, and both had
 * already drifted before this fence existed.
 *
 * 1. The CROSS-CUTTING FILE list -- the paths whose modification forces a broad
 *    real-AWS integ run. FIVE spellings, one of them executable:
 *      a. `.claude/hooks/integ-broad-gate.sh` -- `CROSS_CUTTING_REGEX`, the live
 *         merge gate, and therefore the source of truth every other copy is
 *         compared against.
 *      b. `.claude/skills/verify-pr/SKILL.md` step 6 -- the bullet list.
 *      c. `.claude/skills/verify-pr/SKILL.md` step 6 -- a VERBATIM copy of the
 *         regex, in the detection snippet a few lines below the bullet list.
 *      d. `CLAUDE.md` -- the `integ-broad` workflow entry.
 *      e. `.claude/skills/pick-integ/SKILL.md` step 2 -- the changed-path table.
 *
 * 2. The BROAD-SET TEST-NAME list -- which integ fixtures are broad enough to
 *    refresh the marker. SEVEN spellings: the hook's header comment, the hook's
 *    block message, `.markgate.yml`'s `integ-broad` comment, `/run-integ` step
 *    11, `/verify-pr` step 6, `CLAUDE.md`, and `/pick-integ` step 2.
 *
 * Why a fence rather than the "keep in sync" comments the copies already carry:
 * both lists were measurably out of sync when this file was written. The
 * cross-cutting list was missing `src/deployment/retry.ts` /
 * `retryable-errors.ts` from every copy (go-to-k/cdkd#2042) and
 * `rollback-executor.ts` besides, while the broad-set list stood at 9 entries
 * everywhere EXCEPT the hook's own header comment, which had 8 and omitted
 * `export`. A comment asking for sync is not a mechanism.
 *
 * WHAT THIS DOES NOT PROVE, and no assertion here should be read as covering
 * it: that the list is COMPLETE. All copies agreeing proves only that they say
 * the same thing -- exactly the state that held while three genuinely
 * cross-cutting files were absent from all of them at once. Completeness is the
 * judgment call the `integ-broad` entry in CLAUDE.md describes, and it needs a
 * human noticing that a file sits under every mutating AWS call. A sixth copy
 * added without being wired in here is likewise invisible; the extractor list
 * above is itself hand-maintained.
 *
 * TWO COPIES ARE DELIBERATELY EXCLUDED, both in
 * `.claude/skills/work-issues/SKILL.md`, which carries not one such list but
 * TWO, and they do not agree with each other:
 *   - lines ~165-176, the worktree-collision section's cross-cutting file list:
 *     `deploy-engine.ts`, `intrinsic-function-resolver.ts`, `dag-builder.ts`,
 *     `template-parser.ts`, `register-providers.ts`, `deploy.ts`, `destroy.ts`.
 *   - lines ~385-387, the triage heuristic, which calls itself "(the section-2
 *     list)" while naming `destroy-runner.ts` and `export.ts` and omitting
 *     `deploy.ts` / `destroy.ts` -- so it is not that list, and its own label
 *     is false.
 * Neither is the gate scope: both omit the three files this PR added, the
 * second names `export.ts`, which no gate scopes at all. They serve issue
 * TRIAGE (can two issues be worked as parallel lanes?), not merge gating, so
 * folding either in would assert an equality that was never true. Tracked
 * separately rather than fixed here; reconciling them is a decision about what
 * that heuristic should say.
 *
 * HOW the prose copies are read, stated as MEASURED rather than as intended.
 * Every extractor is a PREFIX SCAN from a fixed anchor: it consumes consecutive
 * entry-shaped lines and stops at the first line that is not one. Three
 * consequences, each checked against the real files rather than reasoned about:
 *
 *   - It never accepts a non-entry line AS an entry. Every captured line must
 *     match the entry shape exactly, so a prose sentence cannot refill the slot
 *     of a deleted entry -- the failure the `pr-review-gate` fence (issue #2006)
 *     was rewritten to close.
 *   - An interleaved sentence TRUNCATES the list; it does not refuse it.
 *     Measured: a sentence inserted before the 6th of 11 bullets yields 5
 *     entries, which the FLOOR rejects. A smaller truncation that clears the
 *     floor is rejected by the sequence comparison instead. An earlier revision
 *     of this comment claimed the parse "fails rather than contributing a
 *     partial list" -- it does not, and the difference matters because it names
 *     the wrong assertion as the one holding.
 *   - A sentence AFTER the final entry is invisible and harmless (measured: 5
 *     passed): it contributes nothing and the list is still complete.
 *
 * An extractor whose ANCHOR gets reworded is the case that does refuse: the
 * anchor match fails and the extractor asserts on the spot, rather than
 * returning `[]` -- which would compare equal to another `[]` and report green
 * having compared nothing.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const BROAD_HOOK = join(repoRoot, '.claude', 'hooks', 'integ-broad-gate.sh');
const DESTROY_HOOK = join(repoRoot, '.claude', 'hooks', 'integ-destroy-gate.sh');
const VERIFY_PR = join(repoRoot, '.claude', 'skills', 'verify-pr', 'SKILL.md');
const PICK_INTEG = join(repoRoot, '.claude', 'skills', 'pick-integ', 'SKILL.md');
const RUN_INTEG = join(repoRoot, '.claude', 'skills', 'run-integ', 'SKILL.md');
const MARKGATE_YML = join(repoRoot, '.markgate.yml');
const CLAUDE_MD = join(repoRoot, 'CLAUDE.md');

const read = (p: string): string => readFileSync(p, 'utf8');

/**
 * Floors, asserted INSIDE each extractor so no call site can forget one.
 *
 * The cross-cutting list holds 11 entries and the broad set 9. Both floors sit
 * a couple of entries below that so a genuine one- or two-entry shrink does not
 * need a test edit in the same PR, while a parser that has gone blind -- which
 * loses the whole list at once rather than one entry -- cannot clear it. A
 * single dropped entry is caught by the sequence comparisons instead, which is
 * the tighter of the two guards.
 */
const MIN_PATHS = 8;
const MIN_TESTS = 7;
const MIN_DESTROY_SCOPE = 9;

function assertFloor(entries: readonly string[], source: string, floor: number): void {
  expect(
    entries.length,
    `${source}: extracted ${entries.length} entries, below the floor of ${floor}. Either the ` +
      `list genuinely shrank (lower the floor deliberately) or this extractor stopped seeing ` +
      `its input -- "the regex matched nothing" and "everything matches" are the same green ` +
      `without this check.`,
  ).toBeGreaterThanOrEqual(floor);
}

/** Sorted copy, duplicates preserved: the copies are lists, not sets. */
const canonical = (entries: readonly string[]): string[] => [...entries].sort();

/**
 * PINS -- the literal contents of each gated list.
 *
 * These are deliberately one more copy of lists this file exists to
 * de-duplicate, and that is the point rather than an oversight. The sync
 * comparisons prove the copies AGREE; they cannot prove the agreed-upon list is
 * right, and a coordinated edit satisfies them perfectly. Measured before these
 * were added: deleting `src/deployment/deploy-engine.ts` from the hook regex AND
 * all four prose copies left the whole suite GREEN -- the `names only paths that
 * exist` test does not fire (the survivors all exist) and `MIN_PATHS = 8` leaves
 * room for a silent three-entry shrink. The narrow predecessor of this pin
 * protected only the three entries issue #2042 added, so it had exactly the hole
 * its own docblock disclosed for entries never added, plus one it did not: a
 * REMOVAL was invisible too.
 *
 * The pin is the one copy that must be edited CONSCIOUSLY. Shrinking a gate's
 * scope is a real decision -- it is how a file stops being verified against real
 * AWS -- so it should cost a test edit whose diff says which protection is being
 * dropped. Growing one costs the same edit, which is cheap and correct.
 *
 * What a pin still cannot do: prove the list is COMPLETE. A live cross-cutting
 * file never added to any copy is invisible to every assertion here -- which is
 * not hypothetical, since `retry.ts`, `retryable-errors.ts` and
 * `rollback-executor.ts` were all missing from all of them at once while their
 * callers were listed. That judgment lives in the CLAUDE.md `integ-broad` entry.
 */
const PIN_RATIONALE =
  'This list is PINNED. If you are adding an entry, add it here too. If you are REMOVING one, ' +
  'say in the PR body why that file no longer needs real-AWS verification -- a shrinking gate ' +
  'scope is how a file silently stops being verified, and every copy agreeing does not make it ' +
  'right.';

const CROSS_CUTTING_PIN = [
  'src/analyzer/dag-builder.ts',
  'src/analyzer/template-parser.ts',
  'src/cli/commands/deploy.ts',
  'src/cli/commands/destroy-runner.ts',
  'src/cli/commands/destroy.ts',
  'src/deployment/deploy-engine.ts',
  'src/deployment/intrinsic-function-resolver.ts',
  'src/deployment/retry.ts',
  'src/deployment/retryable-errors.ts',
  'src/deployment/rollback-executor.ts',
  'src/provisioning/register-providers.ts',
];

const DESTROY_SCOPE_PIN = [
  'src/analyzer/dag-builder.ts',
  'src/analyzer/implicit-delete-deps.ts',
  'src/analyzer/lambda-vpc-deps.ts',
  'src/cli/commands/destroy-runner.ts',
  'src/cli/commands/destroy.ts',
  'src/deployment/deploy-engine.ts',
  'src/deployment/retry.ts',
  'src/deployment/retryable-errors.ts',
  'src/deployment/rollback-executor.ts',
  'src/provisioning/cloud-control-provider.ts',
  'src/provisioning/providers/**',
  'src/provisioning/region-check.ts',
];

const BROAD_SET_PIN = [
  'bench-cdk-sample',
  'drift-revert',
  'drift-revert-vpc',
  'export',
  'lambda',
  'microservices',
  'multi-resource',
  'multi-stack-deps',
  'remove-protection',
];

// ---------------------------------------------------------------------------
// Cross-cutting FILE list
// ---------------------------------------------------------------------------

/**
 * Expand an anchored path ERE of the shape the two regex copies use:
 *   ^src/deployment/(deploy-engine|retry)\.ts$|^src/provisioning/register-providers\.ts$
 *
 * Splitting on `|` is depth-aware, since the alternation character is also the
 * separator INSIDE each group. Every alternative must match the path shape --
 * an unrecognised one makes the parse FAIL rather than get skipped, so a
 * reworked regex cannot silently contribute fewer entries.
 */
function expandPathRegex(re: string, source: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of re) {
    if (ch === '(') {
      depth += 1;
      current += ch;
    } else if (ch === ')') {
      depth -= 1;
      current += ch;
    } else if (ch === '|' && depth === 0) {
      alternatives.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  alternatives.push(current);

  const out: string[] = [];
  for (const alt of alternatives) {
    const m = /^\^([A-Za-z0-9_./-]+)(?:\(([A-Za-z0-9_|.-]+)\))?\\\.ts\$$/.exec(alt);
    expect(
      m,
      `${source}: alternative ${JSON.stringify(alt)} is not an anchored ` +
        `^<prefix>(<a|b>)\\.ts$ path shape. The extractor refuses rather than skips, so a ` +
        `reworded regex surfaces here instead of as a quietly shorter list.`,
    ).not.toBeNull();
    const prefix = m![1];
    const group = m![2];
    if (group === undefined) {
      out.push(`${prefix}.ts`);
    } else {
      for (const member of group.split('|')) out.push(`${prefix}${member}.ts`);
    }
  }
  assertFloor(out, source, MIN_PATHS);
  return out;
}

/** (a) the live gate: `CROSS_CUTTING_REGEX='...'` in the hook. */
function pathsFromHookRegex(): string[] {
  const m = /^CROSS_CUTTING_REGEX='([^']+)'$/m.exec(read(BROAD_HOOK));
  expect(m, 'integ-broad-gate.sh: no CROSS_CUTTING_REGEX=\'...\' assignment found').not.toBeNull();
  return expandPathRegex(m![1], 'integ-broad-gate.sh CROSS_CUTTING_REGEX');
}

/** (b) the `/verify-pr` step-6 bullet list. */
function pathsFromVerifyPrBullets(): string[] {
  const m = /When the PR diff touches ANY of:\n((?:\s*- `[^`]+`\n)+)/.exec(read(VERIFY_PR));
  expect(
    m,
    'verify-pr/SKILL.md: could not find the "When the PR diff touches ANY of:" bullet list. ' +
      'The anchor was reworded or the first bullet no longer has the `- `<path>`` shape. ' +
      '(An interleaved sentence LATER in the list does not reach here -- it truncates the ' +
      'scan, and the floor or the sequence comparison is what rejects that.)',
  ).not.toBeNull();
  const out = m![1]
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const entry = /^\s*- `([^`]+)`$/.exec(line);
      expect(entry, `verify-pr/SKILL.md: bullet ${JSON.stringify(line)} is not a plain path`).not
        .toBeNull();
      return entry![1];
    });
  assertFloor(out, 'verify-pr/SKILL.md bullet list', MIN_PATHS);
  return out;
}

/** (c) the `/verify-pr` step-6 detection snippet -- a second copy of the regex. */
function pathsFromVerifyPrRegex(): string[] {
  const m = /git diff origin\/main\.\.\.HEAD --name-only \| grep -qE '([^']+)'/.exec(
    read(VERIFY_PR),
  );
  expect(m, 'verify-pr/SKILL.md: no `git diff ... | grep -qE \'...\'` detection snippet found').not
    .toBeNull();
  return expandPathRegex(m![1], 'verify-pr/SKILL.md detection regex');
}

/** (d) the CLAUDE.md `integ-broad` entry. */
function pathsFromClaudeMd(): string[] {
  const m = /cross-cutting-list-sync\.test\.ts`\): ((?:`[^`]+`(?:, )?)+)\. Plus the same/.exec(
    read(CLAUDE_MD),
  );
  expect(
    m,
    'CLAUDE.md: could not find the integ-broad scope enumeration. The span between "): " and ' +
      '". Plus the same" must be nothing but comma-separated `path` items.',
  ).not.toBeNull();
  const out = m![1].split(', ').map((item) => {
    const entry = /^`([^`]+)`$/.exec(item);
    expect(entry, `CLAUDE.md: scope item ${JSON.stringify(item)} is not a plain \`path\``).not
      .toBeNull();
    return entry![1];
  });
  assertFloor(out, 'CLAUDE.md integ-broad scope', MIN_PATHS);
  return out;
}

/**
 * (e) the `/pick-integ` changed-path table row.
 *
 * This copy additionally uses a per-directory brace spelling that stands for
 * several entries (`src/cli/commands/{deploy,destroy}.ts`). It is a second
 * spelling of the same list, not a second list, so it is expanded rather than
 * skipped -- skipping it would drop three of the eleven entries and leave the
 * copy that names the most paths the least fenced.
 */
function pathsFromPickInteg(): string[] {
  const m = /^\s*\|\s*((?:`[^`]+`(?:, )?)+)\s*\|\s*\*\*BROAD set\*\*/m.exec(read(PICK_INTEG));
  expect(
    m,
    'pick-integ/SKILL.md: could not find the BROAD-set table row. Its first cell must be ' +
      'nothing but comma-separated `path` items.',
  ).not.toBeNull();
  const out: string[] = [];
  for (const item of m![1].split(', ')) {
    const entry = /^`([^`]+)`$/.exec(item);
    expect(entry, `pick-integ/SKILL.md: cell item ${JSON.stringify(item)} is not a \`path\``).not
      .toBeNull();
    const path = entry![1];
    const brace = /^([A-Za-z0-9_./-]+)\/\{([A-Za-z0-9_,.-]+)\}\.ts$/.exec(path);
    if (brace === null) {
      out.push(path);
    } else {
      for (const member of brace[2].split(',')) out.push(`${brace[1]}/${member}.ts`);
    }
  }
  assertFloor(out, 'pick-integ/SKILL.md BROAD-set row', MIN_PATHS);
  return out;
}

// ---------------------------------------------------------------------------
// integ-destroy: the hook's ACTIVATION patterns vs the marker's include scope
// ---------------------------------------------------------------------------

/**
 * THREE copies of one gate's scope: the hook's activation patterns, the
 * marker's include list, and the prose list in CLAUDE.md's `integ-destroy`
 * entry. The first two are the executable halves and a mismatch between them in
 * EITHER direction silently disarms the gate; the third is documentation, and
 * drifts against both. All three are compared here.
 *
 * Both executable failure modes have shipped:
 *
 *   - In `.markgate.yml` only (no hook pattern): the marker goes stale for the
 *     file, but the hook's diff guard passes the PR through before ever
 *     consulting the marker. Invalidated marker, gate never reads it. This is
 *     what `retry.ts` would have been if issue #2042 had been fixed in
 *     `.markgate.yml` alone.
 *   - In the hook only (no include entry): the FAIL-OPEN, and the worse of the
 *     two. The hook activates and blocks, `markgate verify` runs -- but the
 *     marker's `hash: diff` digest never saw the file, so it returns 0 and the
 *     merge proceeds with NO destroy verification. `destroy-runner.ts` and
 *     `region-check.ts` were both in this state on main, found by an audit
 *     prompted by the first direction's fix.
 *
 * A gate that has silently stopped gating is indistinguishable from a working
 * one from the outside, which is why this is compared mechanically rather than
 * left to the "keep in sync" comments both files carry.
 */

/**
 * Expand a FINITE ERE into the literal strings it matches.
 *
 * More general than `expandPathRegex` above because the destroy hook's patterns
 * use two shapes that one does not: an optional group (`destroy(-runner)?\.ts`)
 * and a wildcard (`providers/.*\.ts`). It refuses anything it does not
 * understand rather than skipping it, so a pattern reworked into a shape this
 * cannot read fails loudly instead of contributing a shorter list.
 */
function expandFiniteEre(src: string, source: string): string[] {
  let i = 0;
  const parseAlt = (): string[] => {
    let out = parseSeq();
    while (src[i] === '|') {
      i += 1;
      out = out.concat(parseSeq());
    }
    return out;
  };
  const parseSeq = (): string[] => {
    let acc = [''];
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      const parts = parseTerm();
      acc = acc.flatMap((a) => parts.map((p) => a + p));
    }
    return acc;
  };
  const parseTerm = (): string[] => {
    const ch = src[i];
    if (ch === '(') {
      i += 1;
      const inner = parseAlt();
      if (src[i] !== ')') throw new Error(`${source}: unbalanced '(' at offset ${i}`);
      i += 1;
      if (src[i] === '?') {
        i += 1;
        return [...inner, ''];
      }
      return inner;
    }
    if (ch === '\\') {
      i += 2;
      return [src[i - 1]];
    }
    if (ch === '.' && src[i + 1] === '*') {
      i += 2;
      return ['**'];
    }
    if (ch === '^' || ch === '$') {
      i += 1;
      return [''];
    }
    if (!/[A-Za-z0-9_/-]/.test(ch)) {
      throw new Error(`${source}: unsupported regex construct ${JSON.stringify(ch)} at ${i}`);
    }
    i += 1;
    return [ch];
  };
  const out = parseAlt();
  if (i !== src.length) throw new Error(`${source}: trailing input at ${i}: ${src.slice(i)}`);
  return out;
}

/**
 * The single deliberate normalization, applied to BOTH sides so neither is
 * privileged: a `**` swallows whatever follows it. The hook spells the provider
 * directory `src/provisioning/providers/.*\.ts` and `.markgate.yml` spells it
 * `src/provisioning/providers/**`; those denote the same scope, and an
 * extractor that dropped the entry rather than normalising it would leave the
 * broadest, highest-blast-radius entry on the list unfenced.
 */
const normalizeGlob = (p: string): string => p.replace(/\*\*.*$/, '**');

/** The three activation patterns in `integ-destroy-gate.sh`, expanded + merged. */
function destroyHookScope(): string[] {
  const src = read(DESTROY_HOOK);
  const out: string[] = [];
  for (const name of ['strict_delete', 'filtered_delete', 'provider_pattern']) {
    const m = new RegExp(`^\\s*${name}='([^']+)'$`, 'm').exec(src);
    expect(m, `integ-destroy-gate.sh: no ${name}='...' assignment found`).not.toBeNull();
    const entries = expandFiniteEre(m![1], `integ-destroy-gate.sh ${name}`).map(normalizeGlob);
    assertFloor(entries, `integ-destroy-gate.sh ${name}`, 3);
    out.push(...entries);
  }
  assertFloor(out, 'integ-destroy-gate.sh activation patterns', MIN_DESTROY_SCOPE);
  return out;
}

/**
 * The THIRD copy: the prose scope list in CLAUDE.md's `integ-destroy` entry.
 *
 * It was added by this PR, to say what the entry previously left unsaid -- that
 * the gate has two halves and they must agree. Adding an unfenced hand-copy of a
 * list inside the change whose whole thesis is "hand-duplicated lists drift" is
 * the one shape this must not ship with, so it is compared against BOTH
 * machine-readable halves rather than against whichever one happens to be handy.
 *
 * The anchor is deliberately two-part (the gate's own sentence, then the
 * terminator) because `Scope:` appears in five other CLAUDE.md gate entries. A
 * one-part anchor would match the first of them and compare the wrong list.
 */
function destroyScopeFromClaudeMd(): string[] {
  const m =
    /A fourth markgate gate, `integ-destroy`[\s\S]*?Scope: ((?:`[^`]+`(?:, )?)+)\. \*\*The gate has two halves/.exec(
      read(CLAUDE_MD),
    );
  expect(
    m,
    "CLAUDE.md: could not find the integ-destroy scope enumeration. Expected the `integ-destroy` " +
      'gate bullet to read "Scope: `path`, `path`, ... . **The gate has two halves". The anchor ' +
      'was reworded, or a non-`path` item was interleaved. This REFUSES rather than returning ' +
      '[], which would compare equal to nothing and pass trivially.',
  ).not.toBeNull();
  const out = m![1].split(', ').map((item) => {
    const entry = /^`([^`]+)`$/.exec(item);
    expect(
      entry,
      `CLAUDE.md: integ-destroy scope item ${JSON.stringify(item)} is not a plain \`path\``,
    ).not.toBeNull();
    return normalizeGlob(entry![1]);
  });
  assertFloor(out, 'CLAUDE.md integ-destroy scope', MIN_DESTROY_SCOPE);
  return out;
}

/** `.markgate.yml`'s `integ-destroy.include` list. */
function destroyIncludeScope(): string[] {
  const m = /^ {2}integ-destroy:\n([\s\S]*?)^ {2}[a-z][a-z-]*:$/m.exec(read(MARKGATE_YML));
  expect(m, '.markgate.yml: could not locate the integ-destroy gate block').not.toBeNull();
  const out = [...m![1].matchAll(/^\s+- "([^"]+)"$/gm)].map((e) => normalizeGlob(e[1]));
  assertFloor(out, '.markgate.yml integ-destroy.include', MIN_DESTROY_SCOPE);
  return out;
}

// ---------------------------------------------------------------------------
// Broad-SET test-name list
// ---------------------------------------------------------------------------

function assertTestNames(entries: readonly string[], source: string): string[] {
  for (const name of entries) {
    expect(name, `${source}: ${JSON.stringify(name)} is not an integ test name`).toMatch(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    );
  }
  assertFloor(entries, source, MIN_TESTS);
  return [...entries];
}

/** The hook's header comment -- the copy that was measurably stale (8 vs 9). */
function testsFromHookComment(): string[] {
  const m = /the test name is in the broad set \(([^)]+)\)/.exec(read(BROAD_HOOK));
  expect(m, 'integ-broad-gate.sh: no "broad set (...)" header enumeration found').not.toBeNull();
  const names = m![1]
    .replace(/\n#\s*/g, ' ')
    .split(/,\s+/)
    .map((s) => s.trim());
  return assertTestNames(names, 'integ-broad-gate.sh header comment');
}

/** The hook's block message -- one `/run-integ <name>` line per broad test. */
function testsFromHookMessage(): string[] {
  const names = [...read(BROAD_HOOK).matchAll(/^\s*\/run-integ ([a-z0-9-]+)/gm)].map((m) => m[1]);
  return assertTestNames(names, 'integ-broad-gate.sh block message');
}

/** `.markgate.yml`'s `integ-broad` comment block. */
function testsFromMarkgateYml(): string[] {
  const m = /broad-integ set \(keep in sync[\s\S]*?:\n((?:\s*#\s{3}[a-z0-9-]+\n)+)/.exec(
    read(MARKGATE_YML),
  );
  expect(m, '.markgate.yml: no integ-broad "broad-integ set" comment enumeration found').not
    .toBeNull();
  const names = m![1]
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.replace(/^\s*#\s+/, '').trim());
  return assertTestNames(names, '.markgate.yml integ-broad comment');
}

/** `/run-integ` step 11's fenced list. */
function testsFromRunInteg(): string[] {
  const m = /A test is "broad"\s*\n\s*iff its name is one of:\s*\n\s*```text\n([\s\S]*?)```/.exec(
    read(RUN_INTEG),
  );
  expect(m, 'run-integ/SKILL.md: no broad-set ```text fence found after the "iff" sentence').not
    .toBeNull();
  const names = m![1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return assertTestNames(names, 'run-integ/SKILL.md step 11 fence');
}

/** `/verify-pr` step 6's canonical-broad-set bullet list. */
function testsFromVerifyPr(): string[] {
  const m = /The canonical broad set \(keep in sync[\s\S]*?\):\n((?:\s*- `[a-z0-9-]+`[^\n]*\n)+)/
    .exec(read(VERIFY_PR));
  expect(m, 'verify-pr/SKILL.md: no "canonical broad set" bullet list found').not.toBeNull();
  const names = m![1]
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const entry = /^\s*- `([a-z0-9-]+)`/.exec(l);
      expect(entry, `verify-pr/SKILL.md: broad-set bullet ${JSON.stringify(l)} has no name`).not
        .toBeNull();
      return entry![1];
    });
  return assertTestNames(names, 'verify-pr/SKILL.md broad set');
}

/** CLAUDE.md's inline broad-set enumeration. */
function testsFromClaudeMdBroadSet(): string[] {
  const m = /the test name is in the broad set \(((?:`[a-z0-9-]+`(?:, )?)+)\) AND the run was clean/
    .exec(read(CLAUDE_MD));
  expect(m, 'CLAUDE.md: no inline broad-set enumeration found in the integ-broad entry').not
    .toBeNull();
  const names = m![1].split(', ').map((item) => {
    const entry = /^`([a-z0-9-]+)`$/.exec(item);
    expect(entry, `CLAUDE.md: broad-set item ${JSON.stringify(item)} is not a plain name`).not
      .toBeNull();
    return entry![1];
  });
  return assertTestNames(names, 'CLAUDE.md broad set');
}

/** `/pick-integ`'s BROAD-set table cell. */
function testsFromPickInteg(): string[] {
  const m = /\*\*BROAD set\*\* \(((?:`[a-z0-9-]+`(?:, )?)+)\)/.exec(read(PICK_INTEG));
  expect(m, 'pick-integ/SKILL.md: no "**BROAD set** (...)" enumeration found').not.toBeNull();
  const names = m![1].split(', ').map((item) => {
    const entry = /^`([a-z0-9-]+)`$/.exec(item);
    expect(entry, `pick-integ/SKILL.md: broad-set item ${JSON.stringify(item)} is malformed`).not
      .toBeNull();
    return entry![1];
  });
  return assertTestNames(names, 'pick-integ/SKILL.md broad set');
}

// ---------------------------------------------------------------------------

describe('cross-cutting file list stays in sync across its five copies', () => {
  it('every copy names the same paths as the live gate regex', () => {
    const gate = canonical(pathsFromHookRegex());
    const copies: Array<[string, string[]]> = [
      ['verify-pr/SKILL.md bullet list', pathsFromVerifyPrBullets()],
      ['verify-pr/SKILL.md detection regex', pathsFromVerifyPrRegex()],
      ['CLAUDE.md integ-broad entry', pathsFromClaudeMd()],
      ['pick-integ/SKILL.md BROAD-set row', pathsFromPickInteg()],
    ];
    for (const [name, entries] of copies) {
      expect(
        canonical(entries),
        `${name} disagrees with integ-broad-gate.sh's CROSS_CUTTING_REGEX. The regex is the ` +
          `live merge gate, so it is the side that is right by construction -- update the copy.`,
      ).toEqual(gate);
    }
  });

  it('names only paths that exist', () => {
    const missing = pathsFromHookRegex().filter((p) => !existsSync(join(repoRoot, p)));
    expect(
      missing,
      `these cross-cutting entries name files that no longer exist, so the gate alternative can ` +
        `never match and the surface it was written for is silently ungated`,
    ).toEqual([]);
  });

  it('holds exactly the pinned scope', () => {
    expect(canonical(pathsFromHookRegex()), PIN_RATIONALE).toEqual(canonical(CROSS_CUTTING_PIN));
  });
});

describe('integ-destroy hook activation and marker scope name the same files', () => {
  it('neither half names a file the other omits', () => {
    const hookScope = canonical(destroyHookScope());
    const includeScope = canonical(destroyIncludeScope());
    const failOpen = hookScope.filter((p) => !includeScope.includes(p));
    const inert = includeScope.filter((p) => !hookScope.includes(p));

    expect(
      failOpen,
      `FAIL-OPEN: these files ACTIVATE integ-destroy-gate.sh but are absent from ` +
        `.markgate.yml's integ-destroy.include. The hook blocks and consults markgate, but the ` +
        `marker's hash:diff digest never sees the file, so verify returns 0 and the merge goes ` +
        `through with no destroy verification at all. Add them to the include list.`,
    ).toEqual([]);

    expect(
      inert,
      `INERT: these files are in integ-destroy.include but match none of the hook's activation ` +
        `patterns. The marker goes stale for them while the hook passes the PR through before ` +
        `ever reading it -- an invalidated marker nobody consults. Add them to strict_delete, ` +
        `filtered_delete or provider_pattern in integ-destroy-gate.sh.`,
    ).toEqual([]);
  });

  it('the CLAUDE.md prose copy agrees with both machine-readable halves', () => {
    // Compared against BOTH, not just one. The two halves are proven equal by
    // the test above, so agreeing with either implies agreeing with the other --
    // but only while that test passes. When it fails, this one should say which
    // of the three copies is the odd one out rather than inheriting the
    // ambiguity, and that costs one extra assertion.
    const prose = canonical(destroyScopeFromClaudeMd());
    expect(
      prose,
      "CLAUDE.md's integ-destroy scope list disagrees with integ-destroy-gate.sh's activation " +
        'patterns. The prose is documentation; the hook is what runs. Fix whichever is wrong, ' +
        'but they must agree -- an entry documented as gated but not matched by any pattern is ' +
        'a scope readers will trust and the gate will not enforce.',
    ).toEqual(canonical(destroyHookScope()));
    expect(
      prose,
      "CLAUDE.md's integ-destroy scope list disagrees with .markgate.yml's integ-destroy.include.",
    ).toEqual(canonical(destroyIncludeScope()));
  });

  it('holds exactly the pinned scope', () => {
    expect(canonical(destroyHookScope()), PIN_RATIONALE).toEqual(canonical(DESTROY_SCOPE_PIN));
  });

  it('names only paths that exist', () => {
    const missing = destroyHookScope()
      .map((p) => p.replace(/\/\*\*$/, ''))
      .filter((p) => !existsSync(join(repoRoot, p)));
    expect(missing, 'these integ-destroy scope entries name paths that no longer exist').toEqual(
      [],
    );
  });
});

describe('broad-integ test-name list stays in sync across its seven copies', () => {
  it('every copy names the same tests', () => {
    const base = canonical(testsFromHookMessage());
    const copies: Array<[string, string[]]> = [
      ['integ-broad-gate.sh header comment', testsFromHookComment()],
      ['.markgate.yml integ-broad comment', testsFromMarkgateYml()],
      ['run-integ/SKILL.md step 11', testsFromRunInteg()],
      ['verify-pr/SKILL.md step 6', testsFromVerifyPr()],
      ['CLAUDE.md integ-broad entry', testsFromClaudeMdBroadSet()],
      ['pick-integ/SKILL.md step 2', testsFromPickInteg()],
    ];
    for (const [name, entries] of copies) {
      expect(
        canonical(entries),
        `${name} disagrees with the block message in integ-broad-gate.sh about which integ ` +
          `fixtures count as broad. This list drifted before: the hook's own header comment sat ` +
          `at 8 entries, omitting \`export\`, while every other copy had 9.`,
      ).toEqual(base);
    }
  });

  it('holds exactly the pinned broad set', () => {
    expect(canonical(testsFromHookMessage()), PIN_RATIONALE).toEqual(canonical(BROAD_SET_PIN));
  });

  it('names only fixtures that exist', () => {
    const missing = testsFromHookMessage().filter(
      (t) => !existsSync(join(repoRoot, 'tests', 'integration', t)),
    );
    expect(
      missing,
      'these broad-set names have no fixture directory under tests/integration/, so /run-integ ' +
        'can never flip the integ-broad marker with them',
    ).toEqual([]);
  });
});
