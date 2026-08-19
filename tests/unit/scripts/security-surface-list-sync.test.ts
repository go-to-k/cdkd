import { describe, it, expect } from 'vite-plus/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The "security / process-launch surface" entry list is duplicated in FOUR
 * places, one of which is executable:
 *
 *   1. `.claude/hooks/pr-review-gate.sh`  -- `UP_PATH_REGEX`, a live merge gate
 *   2. `.claude/skills/review-pr/SKILL.md` -- the bullet list the hook calls
 *      its source of truth
 *   3. `.claude/agents/pr-security-reviewer.md` -- section 4
 *   4. `CLAUDE.md` -- twice (gate description + "PR review pattern")
 *
 * Three failure modes, all silent, all fenced here:
 *
 *   - A listed entry stops existing. `src/local/lambda-authorizer.ts` outlived
 *     its move to cdk-local in PR #691, and `src/local-invoke/docker-runner.ts`
 *     outlived the PR #228 rename to `src/local/`. A dead alternative can never
 *     match, so the gate quietly stopped up-biasing the surface it named, and
 *     the files that inherited the logic went unlisted (issue #1972).
 *   - The copies drift apart, so the hook and the skill disagree about the tier
 *     a PR needs -- the same class the down-bias list already carries a
 *     "keep in sync" comment for.
 *   - The fence itself goes blind (issue #2006). Two extractors used to compare
 *     as a SORTED SET, and the `pr-security-reviewer.md` one matched any code
 *     span in the section rather than only enumeration items. So an entry
 *     deleted from a list while a prose sentence in the same section still
 *     named it was still "found", and a list carrying an entry twice was
 *     indistinguishable from one carrying it once -- the fence reported green
 *     on exactly the drift it exists to catch.
 *
 * NOT fenced, and no test here should be read as covering it: **a live security
 * surface that was never added to ANY copy**. All five spellings agreeing
 * proves the copies say the same thing, never that what they say is complete --
 * `sigv4-verify.ts` and `docker-cmd.ts` were both missing from every copy at
 * once while their callers were listed. That one needs the (a)/(b)/(c) judgment
 * call in `.claude/skills/review-pr/SKILL.md`, which states the same limit
 * about itself.
 *
 * What the copies must prove is that they are the SAME LIST, and a list is an
 * ordered sequence with multiplicity -- not a set. All five spellings (the four
 * files, with CLAUDE.md contributing two) are in the identical document order
 * today, so the order is free signal and is asserted; every extractor below
 * therefore yields document order with duplicates preserved, and the
 * comparisons are sequence comparisons.
 *
 * The `src/provisioning/providers/**` glob is a first-class member of that
 * sequence, not a special case skipped for parsing convenience. It is the
 * broadest and highest-blast-radius entry on the list, so an extractor that
 * dropped it would leave the entry that matters most unfenced. The hook spells
 * it as the regex `src/provisioning/providers/.*`; that is normalised to the
 * `/**` spelling the four prose copies use.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const HOOK = join(repoRoot, '.claude', 'hooks', 'pr-review-gate.sh');
const SKILL = join(repoRoot, '.claude', 'skills', 'review-pr', 'SKILL.md');
const AGENT = join(repoRoot, '.claude', 'agents', 'pr-security-reviewer.md');
const CLAUDE_MD = join(repoRoot, 'CLAUDE.md');

/**
 * One spelling of a surface entry -- a concrete `src/**` file or a `/**` glob --
 * shared by every extractor so all five see the same alphabet.
 *
 * Per-extractor charsets are how a copy silently stops being compared: an entry
 * with an underscore, an uppercase letter or a dotted basename would be visible
 * to the permissive extractors and invisible to the strict ones, and the fence
 * would report a drift that does not exist while hiding one that does.
 */
const ENTRY = 'src/[A-Za-z0-9_./-]+(?:\\*\\*)?';

/** The literal that both ends the agent enumeration and is its last member. */
const AGENT_TERMINATOR = '`src/provisioning/providers/**`:';

/**
 * Floor for every extractor below, asserted INSIDE each one so no call site can
 * forget it.
 *
 * The job no other assertion in this file does: the `names only paths that
 * exist` test consumes a list and asserts nothing was missing, so an extractor
 * returning `[]` passes it vacuously -- and that is a reachable state, not a
 * hypothetical. Simplify `UP_PATH_REGEX` to nothing but globs, or reword any of
 * the four prose anchors, and the corresponding extractor yields an empty
 * sequence. The sync tests would then compare empty against empty and agree.
 *
 * The surface currently holds 13 entries. The floor sits at 10 rather than 13
 * so a genuine one- or two-entry shrink (an implementation moving out to
 * cdk-local, as `lambda-authorizer.ts` did) does not need a test edit in the
 * same PR, while a parser that has gone blind -- which loses the whole list at
 * once, not one entry -- cannot clear it. A single dropped entry is caught by
 * the sequence comparisons instead, which is the tighter guard of the two.
 */
const MIN_PATHS = 10;

function assertFloor(entries: readonly string[], source: string): void {
  expect(
    entries.length,
    `${source}: extracted ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, below ` +
      `the floor of ${MIN_PATHS}. Either the surface list genuinely shrank (lower MIN_PATHS ` +
      `deliberately) or this extractor stopped seeing its input -- "the regex matched nothing" ` +
      `must never read as "everything matches".`,
  ).toBeGreaterThanOrEqual(MIN_PATHS);
}

/** Repeated entries, each reported once, in order of first REPEAT. */
function duplicatesOf(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const e of entries) {
    if (seen.has(e)) dupes.add(e);
    seen.add(e);
  }
  return [...dupes];
}

/** The hook's UP_PATH_REGEX alternations, in regex order. */
function hookEntries(): string[] {
  const sh = readFileSync(HOOK, 'utf8');
  const m = sh.match(/^UP_PATH_REGEX='\^\((.+)\)\$'$/m);
  expect(m, 'pr-review-gate.sh must define an anchored UP_PATH_REGEX').not.toBeNull();
  const entries = m![1]!
    .split('|')
    .map((alt) => alt.replace(/\\\./g, '.'))
    // `src/provisioning/providers/.*` is the regex spelling of the `/**` glob
    // the four prose copies use -- normalise it rather than drop it.
    .map((alt) => (alt.endsWith('/.*') ? `${alt.slice(0, -2)}**` : alt));
  assertFloor(entries, 'pr-review-gate.sh UP_PATH_REGEX');
  return entries;
}

/** The up-bias entry bullets in the skill, in document order. */
function skillEntries(): string[] {
  const md = readFileSync(SKILL, 'utf8');
  const start = md.indexOf('security / process-launch surface');
  expect(start, 'review-pr SKILL.md must have a security-surface bullet list').toBeGreaterThan(-1);
  const rest = md.slice(start);
  const end = rest.indexOf('- Branch has > 1 fix-back commit');
  expect(
    end,
    'the up-bias entry bullets must be followed by the fix-back-commit bullet, which is ' +
      'what bounds them; the providers/** bullet is INSIDE the list, not its terminator',
  ).toBeGreaterThan(-1);

  // Two bullet shapes, both anchored at the start of a list item so prose in
  // the same block cannot contribute an entry: the per-file bullets, whose line
  // is nothing but the code span, and the `Any path under <glob>` bullet, which
  // carries trailing prose. `[ \t]*$` rather than `$` so a stray trailing space
  // does not silently drop an entry.
  const item = new RegExp(
    '^\\s+- `(' + ENTRY + ')`[ \\t]*$|^\\s+- Any path under `(' + ENTRY + ')`',
    'gm',
  );
  const entries = [...rest.slice(0, end).matchAll(item)].map((m) => (m[1] ?? m[2])!);
  assertFloor(entries, 'review-pr SKILL.md up-bias bullet list');
  return entries;
}

/** Section 4 of the security reviewer's own definition, in document order. */
function agentEntries(): string[] {
  const md = readFileSync(AGENT, 'utf8');
  const start = md.indexOf('### 4. AuthZ');
  expect(start, 'pr-security-reviewer.md must have an AuthZ/authn section').toBeGreaterThan(-1);
  const rest = md.slice(start);
  const end = rest.indexOf('### 5.');
  const section = end > -1 ? rest.slice(0, end) : rest;

  // The section opens with a comma-separated enumeration and turns into prose
  // after the providers glob. Scanning the WHOLE section would let a prose
  // mention stand in for a deleted enumeration entry (issue #2006), so cut at
  // the enumeration's end first. Anchor on the terminator LITERAL, not on the
  // first code-span-then-colon: any earlier `` `x`: `` in the section would
  // move a positional cut, and the failure would then name the wrong cause.
  const termAt = section.indexOf(AGENT_TERMINATOR);
  expect(
    termAt,
    'pr-security-reviewer.md section 4 must end its enumeration with the literal ' +
      `${AGENT_TERMINATOR} -- that entry is both the last member of the list and the ` +
      'boundary that keeps the prose after it from refilling a deleted entry.',
  ).toBeGreaterThan(-1);
  const enumeration = section.slice(0, termAt + AGENT_TERMINATOR.length);

  // A LOOKAHEAD on the separator, not a consumed comma: whichever entry ends
  // the enumeration is punctuated by the terminator's colon instead, so
  // requiring a comma would make it invisible and blame the wrong list.
  const item = new RegExp('`(' + ENTRY + ')`(?=[,:])', 'g');
  const entries = [...enumeration.matchAll(item)].map((m) => m[1]!);
  assertFloor(entries, 'pr-security-reviewer.md section 4 enumeration');
  return entries;
}

/**
 * CLAUDE.md carries the list twice in two different spellings: a
 * slash-separated form in the gate description and a brace-expansion form in
 * the "PR review pattern" bullet. Both must expand to the same sequence.
 */
function claudeMdEntrySequences(): [string[], string[]] {
  const md = readFileSync(CLAUDE_MD, 'utf8');

  const slashForm = md.match(new RegExp('any path under (`' + ENTRY + '`(?: / `' + ENTRY + '`)+)'));
  expect(slashForm, 'CLAUDE.md must carry the slash-separated surface list').not.toBeNull();
  const slashEntries = [...slashForm![1]!.matchAll(new RegExp('`(' + ENTRY + ')`', 'g'))].map(
    (m) => m[1]!,
  );
  assertFloor(slashEntries, 'CLAUDE.md gate-description slash form');

  // Scoped to the "PR review pattern" bullet. An unscoped sweep of the whole
  // file would let any unrelated `src/<dir>/{a,b}.ts` span anywhere in
  // CLAUDE.md inject entries and report a drift that does not exist -- the same
  // "a mention elsewhere contributes an entry" class as issue #2006.
  const patternAt = md.indexOf('- **PR review pattern**');
  expect(patternAt, 'CLAUDE.md must carry the "PR review pattern" bullet').toBeGreaterThan(-1);
  const afterPattern = md.slice(patternAt + 1);
  const patternEnd = afterPattern.indexOf('\n- **');
  const patternBullet = patternEnd > -1 ? afterPattern.slice(0, patternEnd) : afterPattern;

  // The brace form is written per-directory (`src/utils/{a,b}.ts`), with the
  // providers glob spelled out alongside them. Expand every group in document
  // order rather than assuming one.
  const braceItem = new RegExp(
    '`(src/[A-Za-z0-9_.-]+)/\\{([A-Za-z0-9_,.-]+)\\}\\.ts`|`(src/[A-Za-z0-9_./-]+\\*\\*)`',
    'g',
  );
  const braceEntries = [...patternBullet.matchAll(braceItem)].flatMap((m) =>
    m[3] ? [m[3]] : m[2]!.split(',').map((n) => `${m[1]}/${n}.ts`),
  );
  assertFloor(braceEntries, 'CLAUDE.md "PR review pattern" brace form');

  return [slashEntries, braceEntries];
}

/** Every copy, keyed by where it lives, for the shape-independent checks. */
function allCopies(): Record<string, string[]> {
  const [slashEntries, braceEntries] = claudeMdEntrySequences();
  return {
    'pr-review-gate.sh UP_PATH_REGEX': hookEntries(),
    'review-pr/SKILL.md bullet list': skillEntries(),
    'pr-security-reviewer.md section 4': agentEntries(),
    'CLAUDE.md gate description': slashEntries,
    'CLAUDE.md "PR review pattern"': braceEntries,
  };
}

describe('security-surface entry list', () => {
  it('names only paths that exist (a dead entry can never fire)', () => {
    // A `dir/**` glob is checked as its directory -- a glob whose directory was
    // renamed away is as dead as a missing file, and the up-bias it claims to
    // carry is the broadest one on the list.
    const missing = hookEntries()
      .map((e) => (e.endsWith('/**') ? e.slice(0, -3) : e))
      .filter((p) => !existsSync(join(repoRoot, p)));
    expect(
      missing,
      `UP_PATH_REGEX names path(s) that do not exist, so the merge gate can never ` +
        `up-bias them: ${missing.join(', ')}. Either restore the file or replace ` +
        `the entry with the path that inherited its logic (issue #1972).`,
    ).toEqual([]);
  });

  it('is in sync between the hook regex and the /review-pr skill', () => {
    const hook = hookEntries();
    expect(
      skillEntries(),
      'pr-review-gate.sh UP_PATH_REGEX and review-pr/SKILL.md disagree; the hook ' +
        'comment declares the skill list its source of truth, so a PR would get a ' +
        'different tier from the gate than from the skill. The comparison is ' +
        'order- and duplicate-sensitive: the two copies must be the same LIST.',
    ).toEqual(hook);
  });

  it('is in sync between the hook regex and the pr-security-reviewer definition', () => {
    const hook = hookEntries();
    expect(
      agentEntries(),
      'pr-security-reviewer.md section 4 lists a different surface sequence than the ' +
        'gate, so the reviewer would be told to audit files the gate never flags. ' +
        'Only the section-opening enumeration counts -- a prose mention elsewhere in ' +
        'the section does not restore a deleted entry (issue #2006).',
    ).toEqual(hook);
  });

  it('is in sync across both spellings in CLAUDE.md', () => {
    const hook = hookEntries();
    const [slashEntries, braceEntries] = claudeMdEntrySequences();
    expect(slashEntries, 'CLAUDE.md gate description drifted from UP_PATH_REGEX').toEqual(hook);
    expect(braceEntries, 'CLAUDE.md "PR review pattern" drifted from UP_PATH_REGEX').toEqual(hook);
  });

  // Sequence equality already fails a duplicate that only ONE copy carries. This
  // catches the case it cannot: the same duplicate pasted into every copy, which
  // stays self-consistent while making the list say a file matters twice.
  it('carries no repeated entry in any copy', () => {
    const offenders = Object.entries(allCopies())
      .map(([source, entries]) => [source, duplicatesOf(entries)] as const)
      .filter(([, dupes]) => dupes.length > 0)
      .map(([source, dupes]) => `${source}: ${dupes.join(', ')}`);
    expect(
      offenders,
      `the security-surface list repeats an entry, which says nothing the single ` +
        `entry does not:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
