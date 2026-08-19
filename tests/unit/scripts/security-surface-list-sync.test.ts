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
 *     deleted from a list while a prose sentence elsewhere still named it was
 *     still "found", and a list carrying an entry twice was indistinguishable
 *     from one carrying it once -- the fence reported green on exactly the
 *     drift it exists to catch.
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
 *
 * HOW the prose copies are read, and why it is shaped this way. Every prose
 * extractor validates that its whole region IS an enumeration -- a positive
 * shape, `` `entry`, `entry`, ... `` end to end -- before pulling entries out
 * of it. It does NOT scan a region for entry-shaped spans and hope the rest is
 * harmless. That distinction is the whole defect: a scan can be refilled by a
 * prose sentence sitting at the index of a deleted entry, and closing that off
 * one bad spelling at a time is a race nobody wins (prose AFTER the list was
 * closed first, prose BEFORE the first entry survived, and neither of those was
 * the last one). Requiring the region to contain nothing but entries refuses
 * every interleaving, including the ones not yet imagined -- an interleaved
 * sentence makes the parse FAIL rather than contribute.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const HOOK = join(repoRoot, '.claude', 'hooks', 'pr-review-gate.sh');
const SKILL = join(repoRoot, '.claude', 'skills', 'review-pr', 'SKILL.md');
const AGENT = join(repoRoot, '.claude', 'agents', 'pr-security-reviewer.md');
const CLAUDE_MD = join(repoRoot, 'CLAUDE.md');

/**
 * One spelling of a surface entry -- a concrete `src/**` file or a `/**` glob.
 *
 * Every extractor that reads an entry uses this one alphabet, so all five see
 * the same characters. Per-extractor charsets are how a copy silently stops
 * being compared: an entry with an underscore, an uppercase letter or a dotted
 * basename would be visible to the permissive extractors and invisible to the
 * strict ones, and the fence would report a drift that does not exist while
 * hiding one that does.
 */
const ENTRY = 'src/[A-Za-z0-9_./-]+(?:\\*\\*)?';

/**
 * CLAUDE.md's "PR review pattern" bullet additionally uses a per-directory
 * brace spelling that expands to several entries: `src/local/{a,b}.ts`. It is a
 * second spelling of the same alphabet, not a second alphabet -- the directory
 * part admits `/` so a nested directory group is read rather than skipped.
 */
const BRACE_GROUP = '(src/[A-Za-z0-9_./-]+)/\\{([A-Za-z0-9_,.-]+)\\}\\.ts';

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

/**
 * Read a comma-separated enumeration of backticked items, refusing anything
 * that is not one.
 *
 * `region` is flattened (the prose copies wrap across lines) and then required
 * to match `item(, item)*` END TO END. Only then are the items pulled out. A
 * sentence interleaved anywhere in the region -- before the first item, between
 * two of them, after the last -- makes this throw instead of contributing an
 * item, which is what stops a prose mention from standing in for an entry
 * deleted from the list (issue #2006).
 */
function readEnumeration(region: string, itemSource: string, source: string): string[] {
  const flat = region.replace(/\s+/g, ' ').trim();
  const shape = new RegExp('^(?:' + itemSource + ', )*' + itemSource + '$');
  expect(
    shape.test(flat),
    `${source}: this region must be an enumeration of surface entries and nothing else, ` +
      `but it does not parse as one. Prose interleaved with the entries is refused rather ` +
      `than read, because a sentence sitting where a deleted entry used to be would ` +
      `silently refill it (issue #2006). Region as parsed:\n  ${flat}`,
  ).toBe(true);
  return [...flat.matchAll(new RegExp(itemSource, 'g'))].map((m) => m[0]);
}

/**
 * One top-level CLAUDE.md bullet, so an extractor cannot pick up a same-shaped
 * span from an unrelated part of a 300-line instruction file.
 *
 * The bullet ends at the next top-level `- ` rather than the next `- **`: the
 * bolder boundary would silently widen this scope the day someone unbolds the
 * following bullet.
 */
function claudeMdBullet(md: string, startsWith: string, source: string): string {
  const at = md.indexOf(startsWith);
  expect(at, `CLAUDE.md must carry the ${source} bullet, starting "${startsWith}"`).toBeGreaterThan(
    -1,
  );
  const after = md.slice(at + 1);
  const end = after.indexOf('\n- ');
  return end > -1 ? after.slice(0, end) : after;
}

/** The hook's UP_PATH_REGEX alternations, in regex order. */
function hookEntries(): string[] {
  const sh = readFileSync(HOOK, 'utf8');
  const m = sh.match(/^UP_PATH_REGEX='\^\((.+)\)\$'$/m);
  expect(m, 'pr-review-gate.sh must define an anchored UP_PATH_REGEX').not.toBeNull();
  const entries = m![1]!
    .split('|')
    // Normalise the glob BEFORE unescaping, never after. `providers/.*` is the
    // regex spelling of the `/**` the prose copies use; the escaped
    // `providers/\.*` is a plausible slip (every sibling alternation
    // escapes its dot) that matches only literal dots and therefore no real
    // file. Unescaping first would collapse the two into the same string and
    // pass a gate that had silently stopped up-biasing every provider PR.
    .map((alt) => (alt.endsWith('/.*') ? `${alt.slice(0, -2)}**` : alt))
    .map((alt) => alt.replace(/\\\./g, '.'));
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

  // Here the enumeration is one entry per LIST ITEM, so the positive shape is
  // per line: the whole line must be a bullet and nothing but an entry. Prose
  // cannot satisfy it, which is the same guarantee `readEnumeration` gives the
  // inline copies. `[ \t]*$` rather than `$` so a stray trailing space does not
  // silently drop an entry.
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

  // The section is an enumeration followed by prose, with a colon marking the
  // hand-off. The region is that enumeration's OWN paragraph: the blank line
  // above it, the colon below.
  //
  // The boundary is the colon, NOT the providers glob that happens to carry it
  // today -- pinning the literal would turn a legitimate consistent shrink
  // (dropping that entry from all five copies at once) into a failure telling
  // the maintainer to undo a correct edit.
  //
  // What `readEnumeration` guarantees, precisely: nothing inside the region
  // that is not an entry can CONTRIBUTE an entry. It does NOT validate that the
  // region is the right one. If an earlier `` `x`: `` in the section moves the
  // colon, the outcome depends on what that region happens to contain -- a
  // short one trips the floor, whose message does name the parse; a long enough
  // one parses cleanly as an enumeration and is caught only by the SEQUENCE
  // COMPARISON, whose message blames drift between the copies. Neither names
  // the cut. That is the honest division of labour here: the shape check closes
  // the refill class, the comparison is what catches a wrong region.
  const headingEnd = section.indexOf('\n');
  const colonAt = section.indexOf('`:', headingEnd);
  expect(
    colonAt,
    'pr-security-reviewer.md section 4 must end its entry enumeration with a colon ' +
      '(`...`: <prose>), which is what separates the list from the description of what ' +
      'to look for in it.',
  ).toBeGreaterThan(-1);

  // Bounding at the HEADING instead would refuse any lead-in sentence, i.e. an
  // ordinary documentation edit. A guard that reds on a legitimate change gets
  // weakened by the next person who hits it, so it must not red on one.
  //
  // One lead-in shape still reds, and it is a residual rather than a design
  // goal: a sentence that itself contains a `` `x`: `` moves `colonAt` onto it,
  // and its paragraph then fails the shape. Deliberately not "fixed" by
  // searching forward for the first colon whose paragraph happens to parse --
  // that would silently choose a region, which is the class this whole file
  // exists to close, and it would trade a loud red on a rare edit for a quiet
  // wrong answer on a corrupted list.
  const paragraphAt = section.lastIndexOf('\n\n', colonAt);
  const regionStart = paragraphAt > -1 ? paragraphAt + 2 : headingEnd + 1;

  const entries = readEnumeration(
    section.slice(regionStart, colonAt + 1),
    '`' + ENTRY + '`',
    'pr-security-reviewer.md section 4 enumeration',
  ).map((span) => span.slice(1, -1));
  assertFloor(entries, 'pr-security-reviewer.md section 4 enumeration');
  return entries;
}

/**
 * CLAUDE.md carries the list twice in two different spellings: a
 * slash-separated form in the gate description and a brace-expansion form in
 * the "PR review pattern" bullet. Both must expand to the same sequence.
 *
 * Both are scoped to their own bullet first. An unscoped `md.match` takes the
 * FIRST same-shaped span in a 300-line file, so an unrelated phrase elsewhere
 * either injects entries or substitutes a fake list wholesale -- the same "a
 * mention elsewhere contributes an entry" class as issue #2006.
 */
function claudeMdEntrySequences(): [string[], string[]] {
  const md = readFileSync(CLAUDE_MD, 'utf8');

  const gateBullet = claudeMdBullet(
    md,
    '- **Before merging large / security-sensitive PRs**',
    'pr-review gate description',
  );
  // The CHAIN is its own positive shape -- a ` / `-joined run of entries matched
  // end to end -- so no prose between two entries can contribute one. WHICH
  // chain is a different question the anchor does not settle: this is a
  // first-match `.match`, so a second `any path under `a` / `b`` phrase earlier
  // in the same bullet would substitute its chain wholesale. What bounds that is
  // the floor (a short decoy) and the sequence comparison against the hook (a
  // long one), not the anchor.
  const slashForm = gateBullet.match(
    new RegExp('any path under (`' + ENTRY + '`(?: / `' + ENTRY + '`)+)'),
  );
  expect(slashForm, 'CLAUDE.md gate description must carry the slash-separated surface list')
    .not.toBeNull();
  const slashEntries = [...slashForm![1]!.matchAll(new RegExp('`(' + ENTRY + ')`', 'g'))].map(
    (m) => m[1]!,
  );
  assertFloor(slashEntries, 'CLAUDE.md gate-description slash form');

  const patternBullet = claudeMdBullet(md, '- **PR review pattern**', 'PR review pattern');
  const listOpen = 'security / process-launch surface is touched (';
  const listAt = patternBullet.indexOf(listOpen);
  expect(
    listAt,
    `CLAUDE.md "PR review pattern" must introduce the surface list with "${listOpen}"`,
  ).toBeGreaterThan(-1);
  // No paragraph bound to relax here, unlike the agent section: the list opens
  // immediately after `touched (`, so there is no lead-in region a legitimate
  // edit could add prose to. The only prose that can land inside these bounds is
  // prose interleaved with the entries themselves -- exactly what the shape
  // check exists to refuse -- so the strictness costs nothing here.
  const parenFrom = patternBullet.slice(listAt + listOpen.length);
  const parenEnd = parenFrom.indexOf(')');
  expect(parenEnd, 'the "PR review pattern" surface list must be parenthesised').toBeGreaterThan(-1);

  // Two spellings share the enumeration: brace groups that expand to several
  // entries, and plain entries (the providers glob today, a singleton file
  // tomorrow). Both are read; a group with no plain-entry alternative would
  // silently drop a singleton and blame CLAUDE.md for drift it does not have.
  const braceEntries = readEnumeration(
    parenFrom.slice(0, parenEnd),
    '(?:`' + BRACE_GROUP + '`|`' + ENTRY + '`)',
    'CLAUDE.md "PR review pattern" surface list',
  ).flatMap((span) => {
    const group = span.match(new RegExp('^`' + BRACE_GROUP + '`$'));
    return group ? group[2]!.split(',').map((n) => `${group[1]}/${n}.ts`) : [span.slice(1, -1)];
  });
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
        'gate, so the reviewer would be told to audit files the gate never flags.',
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
