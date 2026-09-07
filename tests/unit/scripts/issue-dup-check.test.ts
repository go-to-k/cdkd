import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vite-plus/test';
import {
  MARKER_RE_LINE,
  MARKER_RE_LOOSE,
  diagnose,
  formatComment,
  formatMidLineHint,
  isMintEvent,
} from '../../../scripts/check-issue-dup-check.js';
import { parseSubject } from '../../../scripts/gh-subject.js';

/**
 * Port of `.claude/hooks/issue-dup-check-gate.test.sh` (60 cases), for the CI
 * check that replaced the hook.
 *
 * ## What was dropped from the 60, and why
 *
 * 38 cases had shell parsing or the hook's PreToolUse plumbing as their WHOLE
 * subject: every `--body-file` / `-F <p>` / glued `-F<p>` / `--body-file=` /
 * `--field body=@` / `--raw-field` / spaced-and-quoted-path spelling; the
 * relative and `cd`-resolved path forms; the `heredoc -> file -> --body-file`
 * fallback in all three of its shapes; the SEGMENT SCOPING cases (`git commit
 * -F <msg> && gh issue create ...` in both orders, and `grep -F dup-check:`),
 * which existed because `-F` is `git commit`'s flag too and the unscoped
 * extraction read the COMMIT MESSAGE and found the marker there; the chained /
 * subshell / command-substitution / `-R` spellings; the two mandated
 * quoted-mention false positives; the `.markgate.yml` opt-in and its
 * not-opted-in and outside-any-repo twins; the REST-mint-vs-comment-vs-edit
 * verb discrimination; the unreadable-path and unexpanded-`$VAR` refusal arms;
 * the empty command; the non-Bash tool; the library and `GATE_PERL_WORD` load
 * guards; and the settings.json registration check (restored in CI form by `tests/unit/scripts/workflow-registration.test.ts`).
 *
 * The verb discrimination is not lost, only relocated: `gh issue create` was
 * the only gated verb, and `isMintEvent` is where that now lives -- asserted
 * below in all four directions.
 *
 * Every case describing the MARKER is here, including the one the hook's own
 * header called load-bearing (the mid-sentence mention, which fenced the
 * anchor: with the anchor swapped for the loose form that suite was 29/29
 * green, so the split had no discriminating case at all).
 *
 * Case count: 34 `it` blocks.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-issue-dup-check.ts');

const SEARCHED = 'searched open issues for `observedProperties` -- none covers this root cause';

function runCli(doc: unknown): { status: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'issue-dup-check-'));
  const file = join(dir, 'subject.json');
  writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
  try {
    const stdout = execFileSync('node', [SCRIPT, file], {
      encoding: 'utf8',
      // PINNED, not inherited. These cases predate the mint wiring, so without
      // this they take whatever EVENT_NAME / ACTION the surrounding shell
      // happens to carry -- and under a non-mint value the script now stands
      // down at exit 0, which would turn every one of them green for the wrong
      // reason (go-to-k/cdkd#2717 fix-delta review).
      env: { ...process.env, EVENT_NAME: 'issues', ACTION: 'opened' },
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '' };
  }
}

describe('the anchored marker', () => {
  it('accepts a Dup-check line at the start of a line', () => {
    expect(diagnose(`Some defect.\n\nDup-check: ${SEARCHED}\n`)).toBe('present');
  });

  it('rejects a body with no marker at all', () => {
    expect(diagnose('Some defect.\n\nSession-fit: next (not this session)\n')).not.toBe('present');
  });

  it('accepts every list-item and blockquote prefix', () => {
    for (const prefix of ['- ', '* ', '+ ', '> ']) {
      expect(diagnose(`Some defect.\n\n${prefix}Dup-check: ${SEARCHED}\n`)).toBe('present');
    }
  });

  it('accepts capitalisation variants', () => {
    // `-i` rather than a `[Dd]` class: refusing a capitalisation variant
    // teaches people the check is capricious, and nothing is gained.
    for (const spelling of ['Dup-check:', 'dup-check:', 'Dup-Check:', 'DUP-CHECK:']) {
      expect(diagnose(`Some defect.\n\n${spelling} ${SEARCHED}\n`)).toBe('present');
    }
  });

  it('accepts leading whitespace before the marker', () => {
    expect(diagnose(`Some defect.\n\n   Dup-check: ${SEARCHED}\n`)).toBe('present');
    expect(diagnose(`Some defect.\n\n\t- Dup-check: ${SEARCHED}\n`)).toBe('present');
  });

  it('REJECTS the marker mid-sentence', () => {
    // THE case the hook's header called load-bearing. With the anchor swapped
    // for the loose form, that suite was 29/29 green -- the split the header
    // described as deliberate had no discriminating case at all.
    expect(diagnose('Some defect.\n\nWe ran a dup-check: nothing turned up, honest.\n')).not.toBe('present');
  });

  it('rejects the word without its colon', () => {
    expect(diagnose('Some defect.\n\nDup-check was done.\n')).not.toBe('present');
  });

  it('accepts the marker on the first line and on an unterminated last line', () => {
    expect(diagnose(`Dup-check: ${SEARCHED}\n\nSome defect.`)).toBe('present');
    expect(diagnose(`Some defect.\n\nDup-check: ${SEARCHED}`)).toBe('present');
  });

  it('rejects an empty body', () => {
    expect(diagnose('')).not.toBe('present');
  });

  it('does not let a blank line stand in for the space after the colon', () => {
    // `[ \t]` rather than the hook's `[[:space:]]`: the bash class includes a
    // newline but `grep` is line-based, so it could never match one. In a JS
    // regex with `m` it could, which would be silently more permissive.
    expect(diagnose('Some defect.\n\n  \nDup-checkX: no\n')).not.toBe('present');
  });

  it('is not a global regex', () => {
    // A `g` flag makes `.test()` stateful via `lastIndex`, so repeated calls on
    // the same body would alternate true / false.
    expect(MARKER_RE_LINE.global).toBe(false);
    expect(MARKER_RE_LOOSE.global).toBe(false);
    const body = `Dup-check: ${SEARCHED}`;
    expect(diagnose(body)).toBe('present');
    expect(diagnose(body)).toBe('present');
  });

  it('is multiline, or only the first line could ever carry the marker', () => {
    expect(MARKER_RE_LINE.multiline).toBe(true);
  });
});

describe('the two marker spellings', () => {
  it('separates "absent" from "present but mid-sentence"', () => {
    // The loose spelling existed in the hook because an inline `--body 'Bug.
    // Dup-check: ...'` is ONE line, so the anchor could never match there. A CI
    // subject always has real line structure, so the anchored form applies
    // universally -- STRICTLY STRONGER on inline-authored bodies, where a
    // mid-sentence mention used to satisfy the gate. The loose form is kept as
    // a DIAGNOSIS, which is the only job it still has.
    expect(diagnose(`Dup-check: ${SEARCHED}`)).toBe('present');
    expect(diagnose('We ran a dup-check: nothing turned up.')).toBe('mid-line');
    expect(diagnose('Some defect, nothing else.')).toBe('absent');
  });

  it('appends the mid-line hint only for the mid-line diagnosis', () => {
    expect(formatMidLineHint()).toContain('START a line');
    expect(formatComment()).not.toContain('START a line');
  });
});

describe('which events mint an issue', () => {
  // `gh issue create` was the ONLY gated verb. `gh issue edit` and `gh issue
  // comment` were deliberately NOT gated -- folding a finding into an existing
  // issue is the outcome this steers toward, and taxing it would penalise the
  // cheap path while leaving the costly one free. That discrimination now lives
  // here rather than in a command matcher.
  it('gates issues/opened', () => {
    expect(isMintEvent('issues', 'opened')).toBe(true);
  });

  it('does not gate issues/edited', () => {
    expect(isMintEvent('issues', 'edited')).toBe(false);
  });

  it('does not gate a comment', () => {
    expect(isMintEvent('issue_comment', 'created')).toBe(false);
    expect(isMintEvent('issue_comment', 'edited')).toBe(false);
  });

  it('does not gate a pull request', () => {
    expect(isMintEvent('pull_request', 'opened')).toBe(false);
  });
});

describe('the comment', () => {
  it('carries the fold recipe with its load-bearing chaining and -s test', () => {
    // The redirect truncates `$U` before `gh` runs, so an unchained recipe
    // whose `view` fails replaces the umbrella's WHOLE body with the single new
    // row -- destroying every previously folded finding through the very
    // procedure meant to preserve them.
    const c = formatComment();
    expect(c).toContain('U=$(mktemp)');
    expect(c).toContain('[ -s "$U" ]');
    expect(c).toContain('gh issue edit <hit> --body-file "$U"');
    expect(c).toContain('load-bearing');
  });

  it('states that it never asks for a finding to be dropped', () => {
    // /work-issues section 10-0: `filed <= closed` is not a target, and an
    // unfiled finding is strictly worse than a filed one.
    const c = formatComment();
    expect(c).toContain('never asks you to drop a finding');
    expect(c).toContain('filed <= closed');
    expect(c).toContain('one unresolved root cause');
  });

  it('asks for a fold-and-CLOSE, not a fold-instead-of-file', () => {
    // The shape change the port forces: the issue already exists by the time
    // this runs, so the hook's "do not create" is not available.
    expect(formatComment()).toContain('CLOSE this one');
  });

  it('cites the rule it enforces', () => {
    expect(formatComment()).toContain('filing.md');
    expect(formatComment()).toContain('N sites of one root cause');
  });

  it('shows the search before the fix', () => {
    const c = formatComment();
    expect(c).toContain('gh issue list --state open');
    expect(c).toContain('Dup-check: searched open issues for <terms>');
  });
});

describe('CRLF, which the hook never saw', () => {
  it('accepts a marker in a CRLF body', () => {
    // GitHub returns bodies with `\r\n`. Without normalisation the anchor still
    // matches, but a `\r` would end up inside the captured line -- and the
    // classification check's line-wise scan would be affected too, so it is
    // normalised once in `parseSubject` for all three.
    const s = parseSubject(
      JSON.stringify({ kind: 'issue', number: 1, body: `Some defect.\r\n\r\nDup-check: none\r\n` }),
    );
    expect(diagnose(s.body)).toBe('present');
  });
});

describe('the CLI, as the workflow invokes it', () => {
  it('exits 1 and prints the comment when the line is missing', () => {
    const { status, stdout } = runCli({
      kind: 'issue',
      number: 12,
      title: 'x',
      body: 'Some defect, nothing else.',
    });
    expect(status).toBe(1);
    expect(stdout).toContain('no `Dup-check:` line');
    expect(stdout).toContain('CLOSE this one');
  });

  it('appends the mid-line hint when the marker is there but mid-sentence', () => {
    const { status, stdout } = runCli({
      kind: 'issue',
      number: 12,
      title: 'x',
      body: 'We ran a dup-check: nothing turned up.',
    });
    expect(status).toBe(1);
    expect(stdout).toContain('START a line');
  });

  it('exits 0 when the line is present', () => {
    const { status } = runCli({
      kind: 'issue',
      number: 12,
      title: 'x',
      body: `Some defect.\n\nDup-check: ${SEARCHED}\n`,
    });
    expect(status).toBe(0);
  });

  it('exits 2, never 0, when the subject cannot be read', () => {
    expect(runCli('{ not json').status).toBe(2);
  });
});

describe('the mint rule runs in the SHIPPED path, not only in the workflow `if:`', () => {
  // go-to-k/cdkd#2717 test review: `isMintEvent` was exported and asserted in
  // four directions while having NO call site. Those unit cases passed whatever
  // the workflow did, and the rule that actually ran was an `if:` expression no
  // test reads -- so retriggering the job on `issue_comment` would have spammed
  // every comment with the whole suite green. These cases drive the BINARY, so
  // they fail if the wiring is removed again.
  const SCRIPT = fileURLToPath(new URL('../../../scripts/check-issue-dup-check.ts', import.meta.url));
  const subject = (body: string): string => {
    const f = join(mkdtempSync(join(tmpdir(), 'dupchk-')), 'subject.json');
    writeFileSync(f, JSON.stringify({ kind: 'issue', number: 1, title: 't', body, labels: [] }));
    return f;
  };
  const run = (eventName: string, action: string, body: string) =>
    spawnSync(process.execPath, [SCRIPT, subject(body)], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, EVENT_NAME: eventName, ACTION: action },
    });

  it('asks for the line when an issue is OPENED without one', () => {
    const r = run('issues', 'opened', 'no marker here');
    expect(r.signal).toBeNull();
    expect(r.status).toBe(1);
  }, 60_000);

  it.each([
    ['issue_comment', 'created'],
    ['issue_comment', 'edited'],
    ['issues', 'edited'],
    ['pull_request', 'opened'],
  ])('stands down on %s/%s, which mints nothing', (eventName, action) => {
    const r = run(eventName, action, 'no marker here');
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('does not MINT an issue');
  }, 60_000);

  it('still passes an OPENED issue that carries the line', () => {
    const r = run('issues', 'opened', `Some defect.\n\nDup-check: ${SEARCHED}\n`);
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
  }, 60_000);
});
