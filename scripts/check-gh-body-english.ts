/**
 * gh-body-english — refuse non-English writing-system characters in the issue /
 * PR text this repo PUBLISHES to GitHub.
 *
 * REPLACES: `.claude/hooks/gh-body-english-gate.sh` (551 lines + a 916-line
 * suite), retired with the rest of the PreToolUse gh gates.
 *
 * ## What is PRESERVED
 *
 * The character class, exactly, and that is the whole of the hook's detection
 * logic:
 *
 *   U+3000-U+303F  CJK punctuation
 *   U+3040-U+309F  hiragana
 *   U+30A0-U+30FF  katakana
 *   U+4E00-U+9FFF  CJK ideographs (kanji / Chinese)
 *   U+AC00-U+D7AF  hangul
 *
 * Kept character-for-character in sync with the sibling `non-english-text-gate`
 * port, whose subject is the PR DIFF rather than a body. The two share ONLY
 * this class; their subjects are disjoint, and the hooks said the same thing
 * about each other. If you widen or narrow it here, widen or narrow it there in
 * the same change -- a class that differs between the two is a body rule and a
 * file rule that disagree, which is worse than either being wrong.
 *
 * Also preserved:
 *
 *   - the SCOPE. Only the published field is scanned, never a surrounding
 *     context. The hook extracted the body / title value out of the command
 *     rather than scanning the command, so that a body file living under a
 *     Japanese-named DIRECTORY passed. The CI analogue is that only `title` and
 *     `body` are read out of the subject; the author's login, the label names,
 *     a linked URL and the repository name are not text this repo published.
 *   - the ten-offender report cap (`MAX_REPORT`), per field.
 *   - NO bypass marker. The fix is to translate the text, which is trivial and
 *     is the point.
 *   - the documented KNOWN LIMITS of the class, which follow from the ranges
 *     rather than from the shell: fullwidth and halfwidth forms (U+FF00-U+FFEF,
 *     including halfwidth katakana) and the Kana Supplement blocks are OUTSIDE
 *     it and PASS. They are pinned by test so they cannot silently change.
 *
 * ## What is DROPPED
 *
 * Everything that existed to find the body inside a shell command: flag
 * spellings and glued forms, quoting including ANSI-C `$'...'`, heredoc
 * extraction with its write-vs-append and terminator rules, command-position
 * segmentation, `cd` resolution, and the `perl -CSD` decoding dance. See
 * `gh-subject.ts` for the full inventory and why none of it translates.
 *
 * ## What got STRONGER
 *
 *   - The short flags `-b` / `-t` / `-n` were a DOCUMENTED SILENT MISS: they
 *     collide with `echo -n` / `grep -n` / `sed -n` / `sort -t`, so the hook
 *     refused to scan them and `gh issue comment -b "<japanese>"` passed. There
 *     are no flags here; every body reaches the check by the same path.
 *   - So were `gh api --input <file>` and `--body-file -` (stdin), and text the
 *     shell assembled at run time (`--body "$(cat jp.txt)"`), and a body file
 *     written by something other than a heredoc redirect. All of them arrive
 *     here as the finished text.
 *   - So was a gh call nested in a command substitution, a subshell, an `if`, a
 *     loop, or behind `xargs` -- the shared command-position anchor never armed
 *     the gate at all. The event fires on the RESULT, so how it was created is
 *     not a variable.
 *   - The FALSE-POSITIVE direction the hook accepted is gone too: a non-gh
 *     command in the same chain carrying a literal `--body` with non-English
 *     text used to block.
 *
 * ## What got WEAKER
 *
 *   - TIMING, and it is not a small difference. The hook refused BEFORE the
 *     text reached GitHub. This runs after: on a PR the failing check blocks
 *     the merge, but on an issue or a comment the text is already public and
 *     the check can only report it. `.claude/rules/layout-ci-checks.md` records this rather than
 *     leaving it to be discovered.
 *   - Release notes (`gh release create --notes` / `--notes-file`) were in the
 *     hook's verb set and are NOT covered here. See `.claude/rules/layout-ci-checks.md`.
 *
 * Run: `node scripts/check-gh-body-english.ts <subject.json>`
 * Exit 0 = clean, 1 = offenders found (report on stdout), 2 = could not run.
 */

import { foldAnnotationRuns } from './annotation-text.ts';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSubject, type Subject } from './gh-subject.ts';

/**
 * The five ranges, character-for-character as the hook spelled them.
 *
 * NOT `\p{Script=Han}` or any other property escape, deliberately. A property
 * escape is a different set that drifts with each Unicode revision, and the
 * sibling PR-diff check has to test the identical set -- two hand-written
 * ranges can be compared by eye, a property escape and a range list cannot --
 * and "by eye" is not the guarantee: `tests/unit/scripts/non-english-class-sync.test.ts`
 * fences this literal against the sibling in `scripts/check-pr-non-english-text.ts`.
 *
 * Every one of these is in the BMP, so a UTF-16 code-unit class is exact here;
 * no surrogate handling is needed and none is implied for other ranges.
 *
 * Spelled with `\uXXXX` ESCAPES, not with literal characters. A literal class
 * would be a file in this repo carrying hiragana and hangul, which the sibling
 * PR-diff check (the port of `non-english-text-gate`) reads as a violation --
 * the checker's own source would fail the rule it enforces. The escapes are
 * also what makes the two ports comparable by eye.
 */
export const NON_ENGLISH_RE =
  /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/u;

/** Per-field cap on reported lines, matching the hook's `head -10`. */
export const MAX_REPORT = 10;

export interface Offender {
  /** `title` or `body`. */
  field: string;
  /** 1-based, within that field. */
  line: number;
  /** The offending line, trimmed to 120 characters for the report. */
  text: string;
  /** The offending characters found on that line, de-duplicated, in order. */
  characters: string[];
}

/** True when the text carries any character from the class. */
export function containsNonEnglish(text: string): boolean {
  return NON_ENGLISH_RE.test(text);
}

/**
 * Every offending character on a line, de-duplicated and in first-seen order.
 *
 * Reported because the class is five ranges wide and "line 4 is non-English" is
 * not actionable when the offender is a single U+3001 ideographic comma inside
 * an otherwise English sentence -- the shape a review comment actually hits.
 */
export function offendingCharacters(line: string): string[] {
  const seen: string[] = [];
  for (const ch of line) {
    if (NON_ENGLISH_RE.test(ch) && !seen.includes(ch)) seen.push(ch);
  }
  return seen;
}

/** Scan one named field. An absent or empty field yields nothing. */
export function scanField(field: string, text: string | undefined): Offender[] {
  if (!text) return [];
  const out: Offender[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!containsNonEnglish(line)) continue;
    out.push({
      field,
      line: i + 1,
      text: line.length > 120 ? `${line.slice(0, 120)}…` : line,
      characters: offendingCharacters(line),
    });
    if (out.length >= MAX_REPORT) break;
  }
  return out;
}

/**
 * Scan the fields that are PUBLISHED text for this subject kind.
 *
 * A comment has no title; an issue and a PR have both. Nothing else in the
 * payload is scanned -- see the SCOPE note in the header.
 */
export function scanSubject(subject: Subject): Offender[] {
  const offenders: Offender[] = [];
  if (subject.kind !== 'issue_comment') {
    offenders.push(...scanField('title', subject.title));
  }
  offenders.push(...scanField('body', subject.body));
  return offenders;
}

/**
 * Whether the event was raised by a BOT, and this check must therefore not run.
 *
 * ## Why the rule lives here rather than only in the workflow
 *
 * Two of `issue-conventions.yml`'s jobs POST COMMENTS, and a comment is itself
 * an `issue_comment: created` event. Without this filter the English check
 * scans its SIBLINGS' output on every violation. That output is English and
 * would pass, which is exactly what makes it dangerous: it costs a run per
 * comment and reads as fine right up until one of those comments QUOTES an
 * offending body back at the author -- at which point the check fails on text
 * it wrote itself, and the author cannot clear it.
 *
 * The rule used to exist ONLY as `github.event.sender.type != 'Bot'` in the
 * job's `if:`, where no test could reach it: deleting that clause was silent,
 * and its failure mode is a comment loop the check then reports on
 * (go-to-k/cdkd#2736). This is the same move go-to-k/cdkd#2717 made for
 * `isMintEvent` in `check-issue-dup-check.ts` -- the `if:` stays as a cheap
 * filter that avoids spawning a runner, and the SCRIPT is the authority, which
 * is the half under test.
 *
 * ## Why the default is "not a bot"
 *
 * An ABSENT `SENDER_TYPE` means the caller did not pass one -- the `english-pr`
 * job does not, because a fork PR opened by a bot still publishes a body worth
 * checking and no PR job posts a comment that could feed back. Defaulting to
 * "skip" would silently disable the check for every caller that forgot the env
 * var, which is the fail-open direction; defaulting to "scan" costs at worst a
 * redundant run.
 *
 * GitHub spells the field `User` / `Bot` / `Organization`. The comparison is
 * case-insensitive so a payload shape change cannot re-open the loop quietly.
 */
export function isBotSender(senderType: string | undefined): boolean {
  return (senderType ?? '').trim().toLowerCase() === 'bot';
}

const KIND_LABEL: Record<Subject['kind'], string> = {
  issue: 'issue',
  issue_comment: 'issue comment',
  pull_request: 'pull request',
};

/**
 * Quote attacker text so it cannot become Markdown.
 *
 * A fenced block, with a fence LONGER than the longest backtick run in the
 * text -- which is what CommonMark requires to make the content uninterpreted,
 * and is why this is not simply "escape the backticks". Inside such a fence
 * nothing is a link, a mention, an image or a heading. Newlines are folded to
 * spaces first, so one offending line stays one line and cannot forge extra
 * report rows.
 *
 * `\r` is stripped for the same reason a newline is: a lone CR renders as a
 * line break in some clients and would split the row visually.
 */
export function fencedQuote(text: string): string {
  // Delegates to the SHARED fold rather than carrying a fourth private copy of
  // the rule. This function's own `/[\r\n]+/g` is what kept the two
  // comment-posting jobs safe, and those run with `issues: write` and are
  // reachable by any GitHub user -- so it is the highest-privilege instance of
  // the class, and it was the one still spelled separately after
  // go-to-k/cdkd#2736 unified the other four (round-3 security review).
  //
  // `foldAnnotationRuns`, not `foldAnnotationText` + a space collapse: the
  // latter also collapses runs the fold never created, silently re-indenting
  // code and mis-aligning tables inside a fence whose whole point is to
  // preserve them.
  const flat = foldAnnotationRuns(text);
  const longestRun = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${flat}\n${fence}`;
}

/**
 * The refusal, carrying the hook's own wording. Markdown, because on an issue
 * or a comment this is posted as a review comment rather than only logged --
 * the workflow's only way to be visible on a surface with no check run.
 */
export function formatReport(subject: Subject, offenders: Offender[]): string {
  const lines: string[] = [];
  lines.push(`**Non-English text in this ${KIND_LABEL[subject.kind]}.**`);
  lines.push('');
  lines.push(
    'Issue and PR bodies, titles, comments and release notes are public OSS',
  );
  lines.push('artifacts and must be English, exactly like the files in the repo.');
  lines.push('');
  lines.push('Found:');
  lines.push('');
  for (const o of offenders) {
    // The offending line is NOT embedded as Markdown. It is attacker text --
    // any GitHub account can open an issue -- and this report is posted as a
    // comment by the repository's own bot, so anything that escapes the span
    // is arbitrary Markdown published under the repo's identity: live links,
    // real @mentions, and `owner/repo#N` backlinks attributed to this repo.
    // A backtick closes an inline code span, which is one character.
    //
    // Reported and reproduced by the security review of go-to-k/cdkd#2717 --
    // and flagged as a MINOR one round earlier, deferred, then escalated with
    // a working PoC. `o.characters` needs no treatment (a closed Unicode set);
    // `o.text` does.
    lines.push(`- \`${o.field}\` line ${o.line}: ${o.characters.join(' ')} —`);
    lines.push('');
    // INDENTED two spaces so the fence stays INSIDE the list item. At column 0
    // it terminates the list, and each offender renders as its own single-item
    // <ul> (go-to-k/cdkd#2717 review). Two spaces is enough for a `- ` marker
    // and does not add a code block's worth of leading whitespace.
    lines.push(
      fencedQuote(o.text)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
    lines.push('');
  }
  lines.push('');
  lines.push('(hiragana / katakana / kanji / Chinese / hangul / CJK punctuation)');
  lines.push('');
  lines.push('Fix:');
  lines.push('');
  lines.push('- Translate the body / title to English and edit it.');
  lines.push(
    "- A Session-fit gloss is text like any other: write `Session-fit: next (not this session)`, not a localized gloss.",
  );
  lines.push(
    '- Chat with the user stays in whatever language you like; this check covers only what gets PUBLISHED.',
  );
  lines.push('');
  lines.push('Rule: CLAUDE.md -> Workflow Rules -> English-only');
  return lines.join('\n');
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  // Checked BEFORE the subject is read, so a bot-authored comment costs no API
  // call and cannot fail on an unrelated parse error either.
  //
  // It also precedes the ARGV check, so `SENDER_TYPE=Bot` with no subject path
  // exits 0 rather than the usage 2 -- a workflow that stopped passing the path
  // would be silent for bot events. Accepted: those events are skipped anyway,
  // so nothing is lost that the argv check would have caught. Named here rather
  // than left for the next reader to rediscover (go-to-k/cdkd#2736 code review).
  if (isBotSender(process.env['SENDER_TYPE'])) {
    console.log(
      `gh-body-english: sender type is Bot; skipping. This check posts comments, and a ` +
        `comment is itself an issue_comment event -- scanning them makes the check report on ` +
        `its own output.`,
    );
    process.exit(0);
  }
  const path = process.argv[2];
  if (!path) {
    console.error('usage: gh-body-english.ts <subject.json>');
    process.exit(2);
  }
  let subject: Subject;
  try {
    subject = parseSubject(readFileSync(path, 'utf8'));
  } catch (err) {
    // Exit 2, never 0. A checker that cannot read its subject has found
    // nothing BECAUSE IT DID NOT LOOK, and reporting that as a pass is the
    // fail-open the hooks' own load guards existed to prevent.
    console.error(`gh-body-english: cannot read subject: ${(err as Error).message}`);
    process.exit(2);
  }
  const offenders = scanSubject(subject);
  if (offenders.length === 0) {
    console.log(`gh-body-english: ${KIND_LABEL[subject.kind]} #${subject.number} is English-only.`);
    process.exit(0);
  }
  console.log(formatReport(subject, offenders));
  process.exit(1);
}
