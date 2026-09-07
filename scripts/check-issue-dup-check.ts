/**
 * issue-dup-check — an issue body must carry a `Dup-check:` line recording that
 * the OPEN issue list was searched for an issue already covering this root
 * cause.
 *
 * REPLACES: `.claude/hooks/issue-dup-check-gate.sh` (371 lines + a 380-line
 * suite).
 *
 * ## THE THREAT MODEL, quoted from the hook because it decides everything else
 *
 *   "The threat model is FORGETTING to run the search, not defeating the gate:
 *    someone who types the line without searching has already decided to, and
 *    no regex reaches that."
 *
 * That is why a one-line marker is enough, why capitalisation variants are
 * accepted, and why this port loses very little by running after the fact
 * rather than before: it is a REMINDER aimed at an omission, not a control
 * aimed at an adversary.
 *
 * ## WHY the rule exists (measured 2026-08-25, go-to-k/cdkd)
 *
 * The backlog was not rotting -- median time-to-close four hours, exactly two
 * open issues older than a month. But BOTH of those two, and all four of the
 * oldest, were UMBRELLA-SHAPED: #609 (90d, "Backfill silent-drop properties
 * into providers' handledProperties"), #1160 (33d), #1225 (30d), #1393 (16d).
 * In a repo that closes a median issue in four hours, the issues that do not
 * close are the ones naming N sites, because no single lane can close one.
 *
 * The unit of an issue had drifted from "one root cause" to "one affected
 * site", and this codebase's site space is types x properties wide.
 * `/work-issues` section 5-f already said the right thing -- "N sites of one
 * root cause is ONE issue and ONE PR, never N issues" -- and had said it for
 * months. Registration is not execution.
 *
 * ## THIS CHECK DOES NOT SUPPRESS FINDINGS, AND MUST NEVER BE USED TO
 *
 * /work-issues section 10-0 is explicit that `filed <= closed` is not a target
 * and that an unfiled finding is strictly worse than a filed one, because it
 * removes the defect from the record while leaving it in the product. Nothing
 * here changes the threshold for writing a defect down. It changes only WHERE:
 * into the open issue that already names its root cause, as a checklist row,
 * rather than into a new issue number. If the search genuinely finds nothing,
 * say so on the line and file -- that is a PASS and the expected outcome for a
 * real new root cause.
 *
 * ## THE TWO MARKER SPELLINGS, and which one is anchored
 *
 * The hook carried two, and the difference was not cosmetic:
 *
 *   MARKER_RE_LINE  = '^[[:space:]]*([-*+>][[:space:]]+)?dup-check:'   (anchored)
 *   MARKER_RE_LOOSE = 'dup-check:'                                     (unanchored)
 *
 * ANCHORED was used for a body FILE, where the line structure is real, so that
 * a passing mention inside a sentence ("we ran a dup-check: nothing turned up")
 * does not satisfy the requirement. UNANCHORED was used for the raw COMMAND,
 * where an inline `--body 'Bug. Dup-check: ...'` is ONE LINE and the anchor
 * could never match -- there, refusing would have rejected a body carrying
 * exactly what was asked for.
 *
 * A CI subject always has real line structure: `issue.body` is a multi-line
 * string whether it was authored inline, from a file, or in the web UI. So the
 * loose spelling has no remaining job, and the ANCHORED one applies
 * universally. That makes this port STRICTLY STRONGER than the hook on
 * inline-authored bodies, where a mid-sentence mention used to satisfy the
 * gate.
 *
 * The loose spelling is KEPT — not as a verdict, as a DIAGNOSIS. When the
 * anchored form misses and the loose one hits, the author wrote the marker
 * mid-sentence, and saying so is far more useful than "no `Dup-check:` line".
 * `-i` on both, so `Dup-Check:` is accepted: refusing a capitalisation variant
 * teaches people the check is capricious and nothing is gained.
 *
 * ## WHAT ELSE IS PRESERVED
 *
 *   - the list-item prefixes `- * + >` before the marker, and leading
 *     whitespace.
 *   - `gh issue create` was the ONLY gated verb. `gh issue edit` and `gh issue
 *     comment` were deliberately NOT gated: folding a finding into an existing
 *     issue is the outcome this steers toward, and taxing it would penalise the
 *     cheap path and leave the costly one free. Here that becomes `issues:
 *     [opened]` and nothing else -- see `isMintEvent`.
 *   - the remediation text, including the `mktemp` + `[ -s ]` + chained-`&&`
 *     fold recipe, whose chaining is load-bearing: the redirect truncates the
 *     temp file before `gh` runs, so an unchained recipe whose `view` fails
 *     replaces the umbrella's WHOLE body with the single new row, destroying
 *     every previously folded finding through the very procedure meant to
 *     preserve them.
 *
 * ## WHAT IS DROPPED
 *
 * All the shell parsing (see `gh-subject.ts`), plus:
 *
 *   - the SEGMENT SCOPING, which existed for one measured fail-open: `git
 *     commit -F <msg> && gh issue create --body-file <no-marker>` passed,
 *     because `-F` is `git commit`'s flag as well as gh's short `--body-file`,
 *     so the extraction read the COMMIT MESSAGE and found the marker there.
 *     Commit messages quote the lines they describe. No command, no scoping.
 *   - the unreadable-path and unexpanded-`$VAR` refusal arms, and the
 *     whole-command fallback for the `heredoc -> file -> --body-file` shape
 *     whose file does not exist yet at PreToolUse time.
 *   - the `.markgate.yml` repo OPT-IN: a workflow file lives in exactly one
 *     repo.
 *
 * ## WHAT GOT WEAKER — stated plainly
 *
 * THE ISSUE ALREADY EXISTS. The hook refused `gh issue create`, so a duplicate
 * was never minted; this can only comment on an issue that is already filed and
 * already counted. The remediation therefore changes shape too: the hook said
 * "search first, then file or fold", while this has to say "search now, and if
 * it is a duplicate, fold and CLOSE this one".
 *
 * That is a real loss of force and it is recorded rather than hidden. What
 * survives is what the threat model says actually matters: the reminder lands
 * on the author, in public, attached to the issue, at a point where folding is
 * still cheap.
 *
 * Run: `node scripts/check-issue-dup-check.ts <subject.json>`
 * Exit 0 = marker present, 1 = missing (comment body on stdout), 2 = could not
 * run.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSubject, type Subject } from './gh-subject.ts';

/**
 * ANCHORED: the marker must START a line, optionally after whitespace and a
 * list-item / blockquote prefix. This is the VERDICT regex.
 *
 * `[ \t]` rather than the hook's `[[:space:]]`: the bash class includes a
 * newline but `grep` is line-based, so it could never match one. In a JS regex
 * with `m` it could, which would let `Dup-check:` be satisfied by a blank line
 * followed by the marker three lines down -- more permissive than the hook,
 * silently. Same translation as the classification check's space class.
 */
export const MARKER_RE_LINE = /^[ \t]*(?:[-*+>][ \t]+)?dup-check:/im;

/**
 * UNANCHORED. Never a verdict here -- see the header. Used only to tell "the
 * marker is missing" apart from "the marker is there but mid-sentence", which
 * is the difference between a useful comment and a baffling one.
 */
export const MARKER_RE_LOOSE = /dup-check:/i;

export type Diagnosis =
  /** A `Dup-check:` line at line start. Nothing to do. */
  | 'present'
  /** `dup-check:` appears, but only inside a sentence. */
  | 'mid-line'
  /** No `dup-check:` anywhere. */
  | 'absent';

export function diagnose(body: string): Diagnosis {
  if (MARKER_RE_LINE.test(body)) return 'present';
  if (MARKER_RE_LOOSE.test(body)) return 'mid-line';
  return 'absent';
}

/**
 * Which events MINT an issue.
 *
 * The hook gated `gh issue create` and, through the REST verb, `gh api
 * repos/<o>/<r>/issues` -- the same act. It deliberately did NOT gate `gh issue
 * edit` or `gh issue comment`. Both REST and CLI mints arrive here as one
 * event, `issues` / `opened`, so the two trigger spellings collapse into one.
 *
 * `edited` is NOT a mint and is deliberately excluded: the issue was already
 * checked when it opened, and re-checking on every body edit would nag on the
 * very edit that adds the line.
 */
export function isMintEvent(eventName: string, action: string): boolean {
  return eventName === 'issues' && action === 'opened';
}

/** The comment posted on an issue opened without the line. */
export function formatComment(): string {
  return [
    '**This issue body carries no `Dup-check:` line**, so nothing records that the OPEN issue list',
    'was searched for an issue already covering this root cause.',
    '',
    'Search the CONCEPT, not this instance\'s spelling — an existing umbrella was written from a',
    'different site and names a different provider:',
    '',
    '```sh',
    "gh issue list --state open --limit 200 --search '<root-cause concept>' \\",
    '  --json number,title',
    'gh issue list --state open --limit 200 --json number,title,body \\',
    '  --jq \'.[] | select((.body // "") | test("<shared symbol / call / assumption>";"i"))',
    '        | "\\(.number)\\t\\(.title)"\'',
    '```',
    '',
    'On a HIT, fold this finding into that issue as a checklist row and CLOSE this one as a',
    'duplicate — the defect stays on the record while the open count stays one-per-root-cause:',
    '',
    '```sh',
    'U=$(mktemp)   # NOT a fixed /tmp path: parallel lanes share the scratchpad',
    'gh issue view <hit> --json body -q .body > "$U" \\',
    '  && [ -s "$U" ] \\',
    "  && printf -- '- [ ] <site>: <one line, plus where the evidence is>\\n' >> \"$U\" \\",
    '  && gh issue edit <hit> --body-file "$U"',
    '```',
    '',
    'The chaining and the `-s` test are load-bearing, not style: the redirect truncates `$U` before',
    '`gh` runs, so an unchained recipe whose `view` fails replaces the umbrella\'s WHOLE body with the',
    'single new row — destroying every previously folded finding through the very procedure meant to',
    'preserve them.',
    '',
    'On a MISS, this is a real new root cause. Edit the body and record the search:',
    '',
    '```text',
    'Dup-check: searched open issues for <terms> -- none covers this root cause',
    '```',
    '',
    'This check never asks you to drop a finding. /work-issues section 10-0 is explicit that',
    '`filed <= closed` is not a target and that an unfiled finding is worse than a filed one. It',
    'changes only WHERE the finding is written, so an open issue counts one unresolved root cause',
    'rather than one unfixed site.',
    '',
    'Rule: `.claude/skills/work-issues/references/filing.md` section 5-f ("N sites of one root cause',
    'is ONE issue and ONE PR, never N issues").',
  ].join('\n');
}

/** The extra line appended when the marker IS present but mid-sentence. */
export function formatMidLineHint(): string {
  return [
    '',
    '---',
    '',
    'Note: this body does contain `dup-check:`, but inside a sentence rather than at the start of a',
    'line. The marker has to START a line (optionally after `-`, `*`, `+` or `>`) so that a passing',
    'mention does not satisfy the requirement.',
  ].join('\n');
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
  const path = process.argv[2];
  if (!path) {
    console.error('usage: issue-dup-check.ts <subject.json>');
    process.exit(2);
  }
  // The mint check runs HERE, in the shipped path, and not only in the
  // workflow's `if:`. Both spellings existed until the go-to-k/cdkd#2717 test
  // review: `isMintEvent` was exported and asserted in four directions while
  // having NO call site, so those cases passed whatever the workflow did, and
  // the real discrimination sat in an `if:` expression no test reads. Changing
  // the trigger to `issue_comment` would have spammed every comment with the
  // whole suite green -- a decoy, in the sense `check-local-reachability.ts`
  // exists to catch, in a directory that critic does not scan.
  //
  // The workflow keeps its `if:` as a cheap filter that avoids spawning a
  // runner at all; this is the authority. Two layers, only one of them tested,
  // was the defect -- so the tested one is now the one that decides.
  // `||`, not `??`: `??` falls through only on undefined, so an EMPTY
  // `ACTION` -- which any event carrying no action produces, and which the `if:`
  // above would hand over if it were ever loosened as its own comment invites --
  // made `isMintEvent` false and exited 0 SILENTLY UNCHECKED
  // (go-to-k/cdkd#2717 fix-delta review). Defaulting an empty value to the mint
  // case fails toward CHECKING, which is the safe direction here.
  const eventName = process.env['EVENT_NAME'] || 'issues';
  const action = process.env['ACTION'] || 'opened';
  if (!isMintEvent(eventName, action)) {
    console.log(`issue-dup-check: ${eventName}/${action} does not MINT an issue; nothing to check.`);
    process.exit(0);
  }
  let subject: Subject;
  try {
    subject = parseSubject(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`issue-dup-check: cannot read subject: ${(err as Error).message}`);
    process.exit(2);
  }
  const verdict = diagnose(subject.body);
  if (verdict === 'present') {
    console.log(`issue-dup-check: issue #${subject.number} records a Dup-check line.`);
    process.exit(0);
  }
  console.log(formatComment() + (verdict === 'mid-line' ? formatMidLineHint() : ''));
  process.exit(1);
}
