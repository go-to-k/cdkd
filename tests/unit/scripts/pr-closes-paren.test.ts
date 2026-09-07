import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  CLOSE_KEYWORDS,
  collectScannableLines,
  findClosesParen,
  formatWarnings,
  main,
  scanBody,
  selfProbe,
  stripInlineCode,
} from '../../../scripts/check-pr-closes-paren.ts';
import type { Subject } from '../../../scripts/gh-subject.ts';

/**
 * `.claude/hooks/closes-paren-form-gate.sh` carried an **18**-case suite. It was
 * deleted with the hook (go-to-k/cdkd#2731) and this is the successor.
 *
 * EIGHT of the 18 are DETECTION cases and all eight have successors here. The
 * other ten asserted things a CI job cannot get wrong because it is never told
 * them: that a non-`gh pr merge` command passes, that a non-Bash tool passes,
 * that `gh -C <path> pr merge` resolves, that a Bash comment mentioning the verb
 * does not confuse the PR-number extraction, that a compound `&&` chain fires,
 * that a quoted MENTION does not, and the three repo-resolution cases added
 * after the 2026-08-25 cross-repo false positive. Every one was about locating
 * the artifact inside a shell command; a `pull_request` workflow is handed the
 * PR. The tenth, the offline `gh pr view` failure, DOES have a counterpart --
 * in the workflow, which fails open on the fetch. See the script header.
 *
 * An earlier revision of this comment said "13 cases, six ported", a figure
 * copied from the issue body rather than re-derived. Re-derive with
 * `grep -cE '^(run|run_case_repo|run_gh_fail) '` against
 * `git show 5c9eff4f5^:.claude/hooks/closes-paren-form-gate.test.sh`.
 *
 * What the port ADDS is the code-span and fence exemption, and it is not
 * cosmetic: the hook read the raw body, so a PR whose body documents this rule
 * tripped its own check. This PR's body documents this rule.
 */
const subj = (body: string): Subject => ({
  kind: 'pull_request',
  number: 2736,
  title: 'chore(ci): a title',
  body,
  labels: [],
});

describe('the closes-paren detector', () => {
  it('passes its own self-probe', () => {
    expect(selfProbe()).toEqual([]);
  });

  it('has a self-probe that CAN fail', () => {
    // Without this, the case above passes for `selfProbe() { return [] }` --
    // a CI liveness check with no way to go red, which is the exact failure
    // the probe exists to prevent one level up. The injected detector is dead
    // in the flagging direction only, so the failures must name the flag side.
    const failures = selfProbe(() => []);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => f.startsWith('detector did not flag'))).toBe(true);
  });

  it('has a self-probe that catches an OVER-flagging detector too', () => {
    // The other direction, or a probe checking only "did it find things" would
    // pass a detector that flags everything.
    const failures = selfProbe(() => ['forced']);
    expect(failures.some((f) => f.startsWith('detector wrongly flagged'))).toBe(true);
  });

  it('has a self-probe that catches a fence walk exempting NOTHING', () => {
    // An injected scan that always finds one offender. The real probe then
    // fails on its FENCED sample (which must yield nothing) and passes on its
    // unfenced one -- so exactly one failure, naming the exempt direction.
    //
    // A dead `() => []` scan does NOT discriminate: it leaves the fenced check
    // silent and only trips the unfenced one, which is also what a probe that
    // ignored the injection entirely produces. Measured -- that version of this
    // case survived reverting the first injection point.
    const one = () => [{ line: 1, hits: ['x'], text: 'x' }];
    const failures = selfProbe(findClosesParen, one);
    expect(failures).toEqual(['fence tracking did not exempt a directive inside a fenced block']);
  });

  it('has a self-probe that catches a fence walk exempting EVERYTHING', () => {
    const failures = selfProbe(findClosesParen, () => []);
    expect(failures).toEqual(['fence tracking wrongly exempted a line outside every fence']);
  });

  it.each(CLOSE_KEYWORDS.map((k) => [k] as const))(
    'flags the keyword %s, which the constant claims to cover',
    (keyword) => {
      // Driven off CLOSE_KEYWORDS itself. The equality case below pins the
      // CONSTANT; nothing pinned its USE, so filtering four of the nine out of
      // the regex join survived the whole suite AND the self-probe (measured,
      // go-to-k/cdkd#2736 test review).
      expect(findClosesParen(`This ${keyword} (#502).`)).toEqual([`${keyword} (#502)`]);
    },
  );

  it.each([
    ['Closes (#N)', 'Closes (#502).'],
    ['Fixes (#N)', 'Fixes (#502).'],
    ['lowercase resolves (#N)', 'resolves (#502).'],
    ['past tense closed (#N)', 'closed (#502) in the previous round.'],
    ['bare imperative fix (#N)', 'fix (#502)'],
    ['mid-sentence Also closes (#N)', 'Also closes (#512).'],
    ['multiple spaces before the paren', 'Closes   (#502).'],
  ])('flags %s', (_label, line) => {
    expect(findClosesParen(stripInlineCode(line))).not.toEqual([]);
  });

  it.each([
    ['the parens-free form GitHub honours', 'Closes #502.'],
    ['an incidental parenthetical with no keyword', 'See also (#502) for context.'],
    ['a good directive beside an incidental ref', 'Closes #502. References (#510) for context.'],
    ['a keyword with no issue reference at all', 'This closes the loop on the design.'],
    ['a keyword whose paren holds no issue number', 'Closes (see the design doc).'],
    ['a word merely ENDING in a keyword', 'The preclose (#502) hook ran first.'],
    ['no space between keyword and paren', 'closes(#502)'],
  ])('passes %s', (_label, line) => {
    expect(findClosesParen(stripInlineCode(line))).toEqual([]);
  });

  it('reports every offending line of a multi-line body, by line number', () => {
    // Case 10 of the deleted suite: a body with a GOOD directive and a BAD one
    // must still report. A detector that stopped at the first close keyword
    // would call this body clean.
    const body = ['## Summary', 'Some body text.', '', 'Closes #502.', 'Also closes (#512).'].join(
      '\n',
    );
    const offenders = scanBody(body);
    expect(offenders.map((o) => o.line)).toEqual([5]);
    expect(offenders[0]?.hits).toEqual(['closes (#512)']);
  });

  it('finds BOTH directives when one line carries two', () => {
    // The regex is built fresh per call. A module-level `/g` literal would keep
    // `lastIndex` across calls and silently under-report -- the direction that
    // reads as clean.
    expect(findClosesParen('Closes (#1) and fixes (#2).')).toEqual(['Closes (#1)', 'fixes (#2)']);
  });

  it('does not carry regex state from one line to the next', () => {
    // The same under-report, across CALLS: with a shared global regex the
    // second line's match starts from the first line's lastIndex and is missed.
    expect(findClosesParen('Closes (#1)')).toHaveLength(1);
    expect(findClosesParen('Fixes (#2)')).toHaveLength(1);
  });

  it("covers GitHub's documented keyword set exactly", () => {
    // The hook spelled this as `close[sd]?|fix(es|ed)?|resolve[sd]?`. Spelling
    // it out is only an improvement if the expansion is the same set.
    expect([...CLOSE_KEYWORDS].sort()).toEqual(
      ['close', 'closed', 'closes', 'fix', 'fixed', 'fixes', 'resolve', 'resolved', 'resolves'].sort(),
    );
  });
});

describe('code spans and fenced blocks are exempt', () => {
  it('exempts an inline code span', () => {
    expect(scanBody('Never write it as `Closes (#502)` in a body.')).toEqual([]);
  });

  it('exempts a fenced block, and resumes scanning after it', () => {
    const body = ['Intro.', '```', 'Closes (#502).', '```', 'Fixes (#503).'].join('\n');
    expect(scanBody(body).map((o) => o.line)).toEqual([5]);
  });

  it('skips the fence delimiter line itself', () => {
    // ```` ```Closes (#5)```` is an info string, not prose. Toggling the fence
    // AND skipping the line is what keeps it out.
    expect(collectScannableLines('```Closes (#5)\nx\n```\ny').map((l) => l.line)).toEqual([4]);
  });

  it('keeps an indented fence recognised', () => {
    const body = ['Intro.', '  ```', '  Closes (#502).', '  ```'].join('\n');
    expect(scanBody(body)).toEqual([]);
  });

  it('strips EVERY inline code span on a line, not just the first', () => {
    // Every other fixture has one span, so dropping the `/g` survived
    // (measured, go-to-k/cdkd#2736 test review).
    expect(scanBody('Use `x` and never write `Closes (#502)` here.')).toEqual([]);
  });

  it('treats an UNTERMINATED fence as ordinary text', () => {
    // A toggle-based walk reads an unclosed fence as running to end of body,
    // so one stray ``` hides every directive after it -- a SILENT UNDER-REPORT.
    // Measured on the previous implementation: this returned [].
    expect(scanBody(['```', 'x', 'Closes (#502).'].join('\n')).map((o) => o.line)).toEqual([3]);
  });

  it('scans an unpaired fence opener LINE, which is ordinary text', () => {
    // The discriminating case for the pairing bound. Every other unterminated
    // fixture puts the stray delimiter where excluding it changes nothing, so
    // mutating the loop bound survived them all (measured). Here the opener
    // itself carries the directive.
    expect(scanBody('```Closes (#1)\nmore text').map((o) => o.line)).toEqual([1]);
  });

  it('still pairs fences correctly when a later one IS closed', () => {
    // The control for the case above: pairing must not degrade into "never
    // exclude anything", which would satisfy it while deleting the exemption.
    const body = ['```', 'Closes (#1).', '```', 'Closes (#2).', '```', 'Closes (#3).'].join('\n');
    expect(scanBody(body).map((o) => o.line)).toEqual([4, 6]);
  });

  it('still scans a body with no fence at all', () => {
    // The control. Without it, a fence walk that swallowed EVERYTHING would
    // satisfy all three cases above.
    expect(scanBody('Closes (#502).').map((o) => o.line)).toEqual([1]);
  });
});

describe('the report', () => {
  it('emits ::warning:: annotations and never ::error::', () => {
    // The load-bearing property of this successor: go-to-k/cdkd#2717's stopping
    // rule says this harm does not justify blocking, so an annotation that
    // GitHub renders as a FAILURE would re-introduce the gate the retirement
    // deliberately removed.
    const out = formatWarnings(subj('Closes (#502).'), scanBody('Closes (#502).')).join('\n');
    expect(out).toContain('::warning title=');
    expect(out).not.toContain('::error');
  });

  it('reports EVERY offending line, not only the first', () => {
    // `formatWarnings` looping only over offenders[0] survived otherwise --
    // every other fixture has a single offender.
    const body = ['Closes (#1).', 'text', 'Fixes (#2).'].join('\n');
    const out = formatWarnings(subj(body), scanBody(body)).join('\n');
    expect(out).toContain('body line 1');
    expect(out).toContain('body line 3');
    expect((out.match(/::warning title=/g) ?? []).length).toBe(2);
  });

  it.each([
    ['CR', 0x0d],
    ['U+2028 LINE SEPARATOR', 0x2028],
    ['U+2029 PARAGRAPH SEPARATOR', 0x2029],
    ['U+0085 NEL', 0x85],
    ['vertical tab', 0x0b],
    ['form feed', 0x0c],
  ])('no %s in the body survives into the emitted lines', (_label, code) => {
    // THREE rounds of this case were wrong, so the shape is stated.
    //
    // The runner splits a step's output on CR, LF and CRLF, then treats a line
    // whose TRIMMED form starts with `::` as a workflow command. So the
    // assertion has to split the way the RUNNER does. An earlier revision
    // split on LF alone -- which cannot break on a CR -- and measured
    // `detected=false` for all seven characters WITH and WITHOUT the fold:
    // seven rows that could never fail, replacing a field-level assertion that
    // did work. Both the split and the `not.toContain` are needed: the split
    // covers the two characters the runner really breaks on, and the
    // containment covers the five folded as defence in depth, which the runner
    // does NOT break on and which a split-based assertion therefore cannot see.
    //
    // LF is absent from this table on purpose -- see the case below.
    const ch = String.fromCodePoint(code);
    const body = `Closes (#1) ${ch}::add-mask::hunter2`;
    const out = formatWarnings(subj(body), scanBody(body)).join('\n');

    expect(out.split(/\r\n|\r|\n/).some((l) => l.trimStart().startsWith('::add-mask::'))).toBe(
      false,
    );
    expect(out).not.toContain(ch);
    // Two controls, and both are needed. The warning proves the body was
    // SCANNED; the payload text proves it was QUOTED -- deleting the
    // `  body:N: ` echo line entirely satisfied the `not.toContain` rows
    // otherwise (measured, go-to-k/cdkd#2736 round-4 review).
    expect(out).toContain('::warning title=');
    expect(out).toContain('hunter2');
  });

  it('an LF in the body is a line separator before any of this, by construction', () => {
    // LF cannot reach an annotation at all: `collectScannableLines` splits the
    // body on it, so the payload lands on its own line -- which carries no
    // close directive and is therefore never reported. An earlier revision had
    // LF in the table above, where it passed for that reason rather than
    // because anything worked. Asserted directly instead of pretended.
    const body = `Closes (#1) \n::add-mask::hunter2`;
    const offenders = scanBody(body);
    expect(offenders.map((o) => o.line)).toEqual([1]);
    expect(offenders[0]?.text).not.toContain('::add-mask::');
  });

  it('the assertion above CAN fail -- an unfolded string is detected', () => {
    // Without this, every row is satisfied by a splitter that never splits.
    const raw = `  body:1: x${String.fromCodePoint(0x0d)}::add-mask::hunter2`;
    expect(raw.split(/\r\n|\r|\n/).some((l) => l.trimStart().startsWith('::add-mask::'))).toBe(
      true,
    );
  });

  it('folds a break inside the MATCHED text too, not only the echoed line', () => {
    // `\s+` in the detector matches a CR, so `hits` carries one --
    // `scanBody('Closes<CR>(#1)')` yields `['Closes<CR>(#1)']` (measured). It
    // is interpolated into the `::warning ...::` message, a different string
    // from the `  body:N: ` echo, and folding only the latter left it raw.
    const body = `Closes${String.fromCodePoint(0x0d)}(#1)`;
    const warning = formatWarnings(subj(body), scanBody(body))[0] ?? '';
    expect(warning).not.toContain(String.fromCodePoint(0x0d));
    expect(warning).toContain('does NOT auto-close');
  });

  it('names the PR number, the body line and the remediation', () => {
    const out = formatWarnings(subj('Closes (#502).'), scanBody('Closes (#502).')).join('\n');
    expect(out).toContain('PR #2736');
    expect(out).toContain('body line 1');
    expect(out).toContain('gh pr edit 2736 --body-file');
  });
});

describe('main() exit codes', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'closes-paren-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string): string => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };

  const silent = () => {};

  it('returns 0 on a clean body', () => {
    const p = write('clean.json', JSON.stringify({ ...subj('Closes #502.'), kind: 'pull_request' }));
    expect(main([p], silent, silent)).toBe(0);
  });

  it('returns 0 -- NOT 1 -- on a body that violates', () => {
    // The whole point of the successor. If this ever returns 1 the workflow
    // step reds and the check has silently become a gate again.
    const p = write('bad.json', JSON.stringify(subj('Closes (#502).')));
    expect(main([p], silent, silent)).toBe(0);
  });

  it('actually emits the warning it returned 0 for', () => {
    // Otherwise the case above is satisfied by a checker that does nothing.
    const p = write('bad2.json', JSON.stringify(subj('Closes (#502).')));
    const lines: string[] = [];
    expect(main([p], (m: string) => lines.push(m), silent)).toBe(0);
    expect(lines.join('\n')).toContain('::warning title=');
  });

  it('returns 2 when handed no subject path', () => {
    expect(main([], silent, silent)).toBe(2);
  });

  it('returns 2 when the subject file does not exist', () => {
    // A checker that could not look has NOT passed. Collapsing this into 0 is
    // the fail-open the retired hooks' own load guards existed to prevent.
    expect(main([join(dir, 'absent.json')], silent, silent)).toBe(2);
  });

  it('returns 2 when the subject file is not a valid subject', () => {
    const p = write('junk.json', '{"kind":"nonsense"}');
    expect(main([p], silent, silent)).toBe(2);
  });

  it('returns 2, not 0, when the subject body is missing entirely', () => {
    // `parseSubject` is deliberately total on a NULL body (that is a legitimate
    // empty PR body), so this must fail on the KIND, which is the field that
    // decides whether the document is a subject at all.
    const p = write('nobody.json', '{"number":1}');
    expect(main([p], silent, silent)).toBe(2);
  });

  it('treats an empty body as clean rather than as unreadable', () => {
    // Case 8 of the deleted suite. A PR with no body has nothing to match, and
    // conflating that with an unreadable subject would red every such PR.
    const p = write('empty.json', JSON.stringify({ ...subj(''), body: null }));
    expect(main([p], silent, silent)).toBe(0);
  });
});

describe('the real CLI entry point, as the workflow invokes it', () => {
  /**
   * `main()` is exercised in-process above; NOTHING executed the module's own
   * entry point. Mutating `if (isMainModule())` to `if (false)`, or dropping
   * the `process.exitCode =` assignment, left all 34 cases green while the CI
   * step exits 0 having done nothing -- which is the precise failure
   * `isMainModule`'s own docstring is about (go-to-k/cdkd#2736 test review).
   * Both sibling ports spawn the real binary; this one did not.
   */
  const SCRIPT = join(import.meta.dirname, '../../../scripts/check-pr-closes-paren.ts');

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'closes-paren-cli-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runCli = (args: string[]): { status: number; stdout: string } => {
    try {
      const stdout = execFileSync('node', ['--experimental-strip-types', SCRIPT, ...args], {
        encoding: 'utf8',
        // The env is INHERITED, not scrubbed -- `SENDER_TYPE` is pinned only
        // so this spawn cannot be affected by the variable the sibling
        // `check-gh-body-english.ts` reads, should the two ever share a
        // harness. This checker reads no environment at all today, so the pin
        // is documentation of that fact rather than protection.
        env: { ...process.env, SENDER_TYPE: '' },
      });
      return { status: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '' };
    }
  };

  const write = (name: string, doc: unknown): string => {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(doc));
    return f;
  };

  it('exits 0 and says so on a clean body', () => {
    const { status, stdout } = runCli([write('c.json', subj('Closes #502.'))]);
    expect(status).toBe(0);
    expect(stdout).toContain('uses no parens-form close directive');
  });

  it('exits 0 AND emits the warning on a violating body', () => {
    // Both halves. Asserting only the 0 is satisfied by an entry point that
    // never ran; asserting only the warning would not catch a return of 1.
    const { status, stdout } = runCli([write('b.json', subj('Closes (#502).'))]);
    expect(status).toBe(0);
    expect(stdout).toContain('::warning title=');
  });

  it('exits 2 when the subject file is missing', () => {
    expect(runCli([join(dir, 'nope.json')]).status).toBe(2);
  });

  it('exits 2 when handed no argument at all', () => {
    expect(runCli([]).status).toBe(2);
  });
}, 60_000);
