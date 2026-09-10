/**
 * CI port of `.claude/hooks/closes-paren-form-gate.sh` (deleted by
 * go-to-k/cdkd#2731). Reports, as a WARNING, a PR body that spells a GitHub
 * auto-close keyword with parentheses around the issue number.
 *
 * WHAT THE HOOK WAS
 * -----------------
 * A PreToolUse gate on `gh pr merge` that REFUSED the merge when the PR body
 * contained `Closes (#N)` / `Fixes (#N)` / `Resolves (#N)`. GitHub's auto-close
 * grammar requires a parens-free `#N`, so the parens form is a silent no-op and
 * the target issue stays OPEN after the merge.
 *
 * The class was measured live four times: go-to-k/cdkd#509, #510, #511 and #514
 * all used `Closes (#N).` uniformly -- an overgeneralisation of the separate
 * rule that item numbers in a PR body must not carry `#` -- and every one of
 * those merged PRs left its issue open until someone ran `gh issue close` by
 * hand.
 *
 * WHY THIS WARNS INSTEAD OF FAILING
 * ---------------------------------
 * go-to-k/cdkd#2717 gave the guard layer a stopping rule: a gate may BLOCK only
 * when the harm completes at the moment of the action AND lands on a third
 * party's artifact, where the actor cannot undo it. This harm is neither. It
 * lands on the author's own issue, it is detectable afterwards with one
 * `gh issue list --state open`, and it is repaired with one `gh issue close`.
 * So the gate was retired on that criterion, and this successor is deliberately
 * NON-BLOCKING: it emits `::warning::` annotations and exits 0.
 *
 * That is weaker than the hook and stronger than what the retirement left
 * behind, which was a prose row in `/verify-pr` step 11
 * (`.claude/skills/verify-pr/references/wrap-up.md`) --
 * exactly the kind of instruction that gets skipped under time pressure, which
 * is the argument the hook's own header made for existing (go-to-k/cdkd#2736).
 *
 * WHAT WAS DELIBERATELY DROPPED
 * -----------------------------
 * Everything that existed only because a PreToolUse hook receives raw SHELL
 * COMMAND TEXT and has to find the artifact inside it:
 *
 *   - `gate_matches` verb recognition against `$GATE_RE_GH_PR_MERGE`, so that
 *     `vp test run && gh pr merge 1` fired while `echo "gh pr merge 1"` did not;
 *   - `gate_pr_selector` -- pulling the PR NUMBER out of the command, including
 *     the `gh -R owner/repo pr merge N` shape whose naive `${cmd##*gh pr merge}`
 *     strip returned the whole command and silently disabled the gate;
 *   - the REPO RESOLUTION half (`-R` / `--repo`, then `cd` / `git -C` target
 *     resolution, then the hook process's cwd), added after a measured false
 *     positive on 2026-08-25: `gh pr merge 553 -R go-to-k/cdk-local` was refused
 *     citing line 73 of *cdkd's* PR 553. Three of the hook's suite cases existed
 *     only to fence that;
 *
 * NOT dropped, though an earlier revision of this header said it was: the
 * hook's OFFLINE FAIL-OPEN ARM. "No command to parse and no repo to resolve"
 * covers repo resolution; it does not cover REACHABILITY, which still exists in
 * CI. The workflow keeps that policy explicitly -- a `gh` transport failure
 * emits a `::warning::` and SKIPS this check rather than reddening the job,
 * because a check documented as never failing a PR must not fail one on a
 * network blip. A subject file that is PRESENT but unreadable still exits 2:
 * that is a broken checker, not an unreachable API. Both halves were review
 * findings on go-to-k/cdkd#2736.
 *
 * The rest has no counterpart here. A `pull_request` workflow is told which PR
 * it is running for; there is no command to parse and no repo to resolve.
 *
 * WHAT WAS PRESERVED
 * ------------------
 *   - The detector: a close keyword followed by whitespace and a parenthesised
 *     `#N`, case-insensitive. The keyword set is GitHub's own.
 *   - The requirement that the parens IMMEDIATELY follow the keyword, so an
 *     incidental `See also (#502)` and a `References (#510) for context` both
 *     pass -- two of the hook's 13 cases.
 *   - Per-line reporting of every offending line, so a multi-line body naming
 *     one good and one bad reference reports the bad one.
 *
 * The deleted suite had **18** cases, of which **8 are DETECTION** and all 8
 * have successors here; the other 10 asserted shell-command and repo-resolution
 * machinery. (An earlier revision said "13 cases, six ported" -- a figure
 * copied from the issue body rather than re-derived. Count them with
 * `grep -cE '^(run|run_case_repo|run_gh_fail) '` against
 * `git show 5c9eff4f5^:.claude/hooks/closes-paren-form-gate.test.sh`.)
 *
 * WHAT IS NEW, AND WHY
 * --------------------
 * CODE-SPAN AND FENCE EXEMPTION, which the hook did not have. The hook fired on
 * `gh pr view`'s raw body, so a PR whose body DOCUMENTS this rule -- this one
 * does, and so does every future edit to it -- tripped its own check. The
 * sibling `check-pr-internal-labels.ts` already had to solve this for the same
 * reason; the fence walk here is the same shape.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { foldAnnotationText } from './annotation-text.ts';
import { parseSubject, type Subject } from './gh-subject.ts';

/**
 * GitHub's auto-close keywords, all three families and every inflection GitHub
 * documents. The hook spelled this as the ERE
 * `\b(close[sd]?|fix(es|ed)?|resolve[sd]?)`; it is spelled out here so a reader
 * can check it against GitHub's list without expanding a character class.
 */
/**
 * KNOWN BOUNDS of the detector, measured 2026-09-07 and inherited from the
 * hook's identical `\(#[0-9]+\)` -- so none is a regression, and each is a
 * MISS rather than a false warning:
 *
 *   Closes (#502, #503)          -- several references in one paren group
 *   Closes ([#502](https://...)) -- a linked reference
 *   Closes (go-to-k/cdkd#502)    -- the cross-repo form, which GitHub DOES
 *                                   honour parens-free
 *
 * Widening the pattern is a behaviour change beyond porting the gate and would
 * need its own probes, so it is recorded rather than done. Found by the code
 * review of go-to-k/cdkd#2736.
 */
export const CLOSE_KEYWORDS: readonly string[] = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
];

/**
 * The detector.
 *
 * `\s+` between the keyword and the paren, not `\s*`: `closes(#5)` is not the
 * shape the hook targeted and not a shape anyone writes by hand. The `\b`
 * prefix keeps `precloses (#5)` out.
 *
 * A NEW RegExp per call rather than a module-level literal with `/g`. The
 * reason first given here was wrong and is corrected rather than deleted:
 * `String.prototype.matchAll` CLONES its argument, so a shared global regex
 * would NOT carry `lastIndex` across calls (measured -- hoisting this to a
 * module constant survives the whole suite). The construction is therefore
 * defensive, not load-bearing: it costs nothing and it keeps the guarantee if a
 * future edit swaps `matchAll` for an `exec` loop, where `lastIndex` DOES
 * persist and the under-report is real.
 */
function detector(): RegExp {
  return new RegExp(String.raw`\b(?:${CLOSE_KEYWORDS.join('|')})\s+\(#\d+\)`, 'gi');
}

/** Every parens-form close directive on one line, in order. */
export function findClosesParen(line: string): string[] {
  return [...line.matchAll(detector())].map((m) => m[0]);
}

/**
 * Strip single-backtick code spans, so "write it as `Closes (#5)`" passes.
 * Same expression as the sibling `check-pr-internal-labels.ts`.
 */
export function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, '');
}

export interface BodyLine {
  /** 1-based line number within the body, as `grep -n` reported it. */
  line: number;
  text: string;
}

/**
 * Emit the body lines that sit OUTSIDE every fenced code block.
 *
 * Delimiters are PAIRED rather than walked as a toggle, and that is the whole
 * point. A toggle treats an UNTERMINATED fence as running to the end of the
 * document -- which is what CommonMark says, and which here is a SILENT
 * UNDER-REPORT: one stray ``` early in a body hides every directive after it.
 * Measured on the toggle version: `["```", "x", "Closes (#502)."]` reported
 * nothing.
 *
 * So an unpaired trailing delimiter is treated as ORDINARY TEXT, and the lines
 * after it are scanned. That can only produce a FALSE WARNING, never a miss,
 * which is the same bias this file takes everywhere else -- see the `~~~` note
 * below -- and the right one for a check that warns and never blocks.
 *
 * A paired delimiter line is itself excluded, which matters because
 * ```` ```Closes (#5)```` would otherwise read as an info string carrying a
 * directive.
 *
 * KNOWN BOUNDS, all in the false-warning direction:
 *   - Backtick fences only. A `~~~` fence is legal CommonMark and is not
 *     recognised.
 *   - A DOUBLE-backtick span (``Closes (#502)``) is not treated as code by
 *     `stripInlineCode`, so it warns.
 */
export function collectScannableLines(body: string): BodyLine[] {
  const lines = body.split('\n');

  const delimiters: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]*```/.test(lines[i] ?? '')) delimiters.push(i);
  }

  // Pair them off in order. `k + 1 < delimiters.length` is what does the work: a
  // final ODD delimiter never enters the loop, so it is never excluded, so it
  // and everything after it stay scannable.
  //
  // The two `undefined` checks are UNREACHABLE -- the bound guarantees both
  // indices exist -- and are here only for `noUncheckedIndexedAccess`. So the
  // rule IS spelled twice, and an earlier revision of this comment called the
  // bound "the ENTIRE rule" while criticising double-spelling three lines
  // later. The difference from the version below is that this second spelling
  // is inert in BOTH directions: an exhaustive probe over every `{```, x}` body
  // up to 8 lines (511 cases) found ZERO behavioural difference between
  // `k + 1 < len` and `k < len`, so neither can be silently wrong.
  //
  // That earlier revision also wrote `delimiters[k + 1] ?? 0` and leaned on
  // `i <= 0` not iterating. Same rule spelled twice, one spelling silent: it
  // made mutating the bound undetectable except when the stray delimiter sat on
  // line 1 (measured on the 55-case suite of the day -- the mutant passed all of them).
  const fenced = new Set<number>();
  for (let k = 0; k + 1 < delimiters.length; k += 2) {
    const open = delimiters[k];
    const close = delimiters[k + 1];
    if (open === undefined || close === undefined) continue;
    for (let i = open; i <= close; i++) fenced.add(i);
  }

  const out: BodyLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    out.push({ line: i + 1, text: lines[i] ?? '' });
  }
  return out;
}

export interface Offender {
  /** 1-based line number within the body. */
  line: number;
  /** The matched directives on that line, e.g. `['Closes (#502)']`. */
  hits: string[];
  /** The full line as written, trimmed for the report. */
  text: string;
}

/** Scan a PR body. Fenced blocks and inline code spans are exempt. */
export function scanBody(body: string): Offender[] {
  const out: Offender[] = [];
  for (const { line, text } of collectScannableLines(body)) {
    const hits = findClosesParen(stripInlineCode(text));
    if (hits.length > 0) {
      // Folded here AND at the emitter, for the reason the siblings carry:
      // a file gains echo sites over time and "fold at the emitter" was missed
      // twice in three rounds. Idempotent, so both are free.
      out.push({
        line,
        hits: hits.map(foldAnnotationText),
        text: foldAnnotationText(text).trim().slice(0, 200),
      });
    }
  }
  return out;
}

/**
 * The `::warning::` annotations plus the human explanation.
 *
 * Returned as lines rather than printed, so the unit suite reads the exact text
 * a reviewer sees instead of asserting that some warning was emitted.
 */
export function formatWarnings(subject: Subject, offenders: readonly Offender[]): string[] {
  const out: string[] = [];
  for (const o of offenders) {
    // `::warning::` with no `file=` -- the subject is a PR BODY, which is not a
    // file in the checkout, so a file/line annotation would point at whatever
    // path happened to be named and read as a source defect.
    //
    // BOTH body-derived fields go through `foldAnnotationText`, and they are
    // folded HERE, at the emitter, rather than where they are collected. An
    // earlier revision folded `text` only, in `scanBody`. `hits` is equally
    // body-derived -- `\s+` in the detector matches a CR, so
    // `scanBody('Closes<CR>(#1)')` yields `hits: ['Closes<CR>(#1)']` (measured)
    // -- and it reached this line raw. Not forgeable while the match tail is
    // structurally `(#N)`, but the header documents a widening to
    // `Closes ([#502](url))` and `Closes (go-to-k/cdkd#502)`, whose `[^)]*`
    // would carry arbitrary bytes. Shipping the bound and its future exploit
    // together is not a trade worth making (go-to-k/cdkd#2736 round-2 review).
    out.push(
      `::warning title=Auto-close keyword in parens form::PR #${subject.number} body line ` +
        `${o.line}: ${foldAnnotationText(o.hits.join(', '))} does NOT auto-close on merge`,
    );
  }
  out.push('');
  out.push(`PR #${subject.number} spells an auto-close keyword with parentheses.`);
  out.push('GitHub only auto-closes on a parens-free reference:');
  out.push('');
  out.push('  Closes #502.     <- auto-close fires on merge');
  out.push('  Closes (#502).   <- silent no-op; the issue stays OPEN');
  out.push('');
  out.push('Offending lines:');
  for (const o of offenders) out.push(`  body:${o.line}: ${foldAnnotationText(o.text)}`);
  out.push('');
  out.push('Two fixes:');
  out.push('  1. The close IS intended -- drop the parens, then');
  out.push(`     gh pr edit ${subject.number} --body-file <file>`);
  out.push('  2. It was an incidental reference -- reword so no close keyword');
  out.push('     precedes it: "References (#502)." / "See also (#502)."');
  out.push('');
  out.push('This is a WARNING, not a failure: if it ships, one');
  out.push('`gh issue close <N>` after the merge repairs it. See go-to-k/cdkd#2717');
  out.push('for the stopping rule that decided this, and go-to-k/cdkd#2736 for why');
  out.push('the retired gate got a successor at all.');
  return out;
}

/**
 * Self-probe. A detector that has gone dead and a clean body produce the same
 * silence, so prove BOTH directions before reading the real subject.
 *
 * The samples are drawn from the deleted hook suite's 8 DETECTION cases, plus
 * two shapes that suite had no reason to carry: an inline code span (new here,
 * see the header) and a close keyword with no reference at all.
 *
 * `find` / `scan` are INJECTABLE so the probe itself is falsifiable. Without
 * them `expect(selfProbe()).toEqual([])` passes for a probe that has become
 * `return []` -- a liveness check with no way to go red is the thing it exists
 * to prevent, one level up (go-to-k/cdkd#2736 test review).
 */
export function selfProbe(
  find: (line: string) => string[] = findClosesParen,
  scan: (body: string) => Offender[] = scanBody,
): string[] {
  const failures: string[] = [];

  const mustFlag: Array<[string, string]> = [
    ['Closes (#N)', 'Closes (#502).'],
    ['Fixes (#N)', 'Fixes (#502).'],
    ['lowercase resolves (#N)', 'resolves (#502).'],
    ['mid-sentence "Also closes (#N)"', 'Also closes (#512).'],
  ];
  for (const [label, sample] of mustFlag) {
    if (find(stripInlineCode(sample)).length === 0) {
      failures.push(`detector did not flag ${label}`);
    }
  }

  const mustPass: Array<[string, string]> = [
    ['parens-free Closes #N', 'Closes #502.'],
    ['incidental (#N) with no keyword', 'See also (#502) for context.'],
    ['mixed: Closes #N plus References (#X)', 'Closes #502. References (#510) for context.'],
    ['inline code span', 'Never write it as `Closes (#502)` in a body.'],
    ['keyword with no reference at all', 'This closes the loop on the design.'],
  ];
  for (const [label, sample] of mustPass) {
    if (find(stripInlineCode(sample)).length > 0) {
      failures.push(`detector wrongly flagged ${label}`);
    }
  }

  const fenced = ['# body', '```', 'Closes (#502).', '```', 'Closes #502.'].join('\n');
  if (scan(fenced).length !== 0) {
    failures.push('fence tracking did not exempt a directive inside a fenced block');
  }
  if (scan('Closes (#502).').length !== 1) {
    failures.push('fence tracking wrongly exempted a line outside every fence');
  }

  return failures;
}

/**
 * Exit codes, and why there is no 1.
 *
 *   0 -- scanned; clean OR warned. This check never fails a PR (see header).
 *   2 -- could NOT scan. A checker that did not look has not passed, and
 *        collapsing that into 0 is the fail-open the retired hooks' own load
 *        guards existed to prevent.
 */
export function main(argv: readonly string[], log = console.log, err = console.error): number {
  const path = argv[0];
  if (!path) {
    err('usage: check-pr-closes-paren.ts <subject.json>');
    return 2;
  }

  const probeFailures = selfProbe();
  if (probeFailures.length > 0) {
    err('::error::the closes-paren detector failed its own self-probe:');
    for (const f of probeFailures) err(`  - ${f}`);
    return 2;
  }

  let subject: Subject;
  try {
    subject = parseSubject(readFileSync(path, 'utf8'));
  } catch (e) {
    err(`::error::check-pr-closes-paren: cannot read subject: ${(e as Error).message}`);
    return 2;
  }

  const offenders = scanBody(subject.body);
  if (offenders.length === 0) {
    log(`check-pr-closes-paren: PR #${subject.number} uses no parens-form close directive.`);
    return 0;
  }
  for (const line of formatWarnings(subject, offenders)) log(line);
  return 0;
}

/**
 * `import.meta.url === \`file://${process.argv[1]}\`` is WRONG in two ways that
 * both end in the script exiting 0 having done nothing -- Node resolves the main
 * module to its REALPATH while `argv[1]` keeps the symlink, and a path needing
 * percent-encoding never string-matches its file URL.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = main(process.argv.slice(2));
}
