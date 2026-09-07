import { describe, it, expect, vi } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every case below SPAWNS a `.ts` entry point, paying Node startup plus type
// stripping per call. Vitest's default bound is 5 s and is an IN-PROCESS
// bound, so these pass locally and time out on a loaded CI runner -- the shape
// `.claude/rules/testing.md` records from go-to-k/cdkd#2553 (~2 s local, 5000 ms
// in CI), and the one that reads as flakiness rather than an under-declared
// bound. Measured here at up to 2088 ms locally during the go-to-k/cdkd#2717
// test review. The bound's job is to stop a HANG, not to police latency, so it
// is set generously.
vi.setConfig({ testTimeout: 60_000 });

import {
  FIELDS,
  TOKENS,
  classificationValue,
  conflicts,
  decide,
  formatConflictComment,
  labelFor,
  labelsToApply,
} from '../../../scripts/check-issue-classification-labels.js';

/**
 * Port of `.claude/hooks/issue-classification-label-gate.test.sh` (47 cases),
 * for the CI check that replaced the hook.
 *
 * ## What was dropped from the 47, and why
 *
 * 18 cases had shell parsing or the hook's PreToolUse plumbing as their WHOLE
 * subject: the `--label` / `--add-label` / `-l` extraction with comma-splitting
 * and metacharacter termination; `-F <p>`, glued `-F<p>`, `--body-file=`,
 * spaced-and-quoted paths; the `heredoc -> file -> --body-file` fallback; the
 * `cd`-into-the-opted-in-repo arming; the `.markgate.yml` opt-in and its
 * not-opted-in twin; the quoted-mention false positive; the empty command; the
 * non-Bash tool; the `GATE_PERL_WORD` load guard; and the whole `existing_labels`
 * family -- the `gh issue view` stub, the argv probes pinning WHICH issue and
 * WHICH `-R` repo was asked about, the `/issues/N`-URL hijack, the issue-URL
 * argument form, and the two FAIL-OPEN cases for a gh error. None of those
 * exist here: labels arrive as an array, from one server-side fetch the
 * workflow makes.
 *
 * Everything describing the DETECTION is here, including every case that pinned
 * a false positive (the space rule in both its forms, the `Effort: ~1-3 h`
 * duration carve-out, the title-does-not-outrank-the-body precedence), plus
 * cases the shell suite could not express: the `Session-fit` / `Estimate`
 * exclusions as assertions rather than as prose, the shared `medium` token, and
 * the new apply-vs-conflict split.
 *
 * Case count: 33 `it` blocks.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-issue-classification-labels.ts');

/** The canonical four-field body, as `/work-issues` writes one. */
const BODY_BOTH = [
  'The provider drops the field.',
  '',
  'Dup-check: searched open issues -- none covers this root cause',
  'Session-fit: next (not this session) -- needs a new fixture',
  'Severity: high -- deploy silently ships a resource missing the property',
  'Effort: large (L) -- a new integ fixture has to be written',
  'Estimate: ~3 h+ -- the fixture deploys a NAT gateway',
].join('\n');

/** The old packed shape, from before the five-field split. */
const BODY_PACKED = [
  'The old packed shape.',
  '',
  'Session-fit: next (not this session) -- Effort: ~1-3 h',
  'Severity: medium -- one provider is missing a property',
].join('\n');

function runCli(doc: unknown, ...flags: string[]): { status: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'issue-classification-'));
  const file = join(dir, 'subject.json');
  writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
  try {
    const stdout = execFileSync('node', [SCRIPT, file, ...flags], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '' };
  }
}

describe('the closed token sets', () => {
  it('mirrors ONLY severity and effort', () => {
    // `Session-fit` is re-decided at claim time and a stale label would be
    // worse than none; `Estimate` is a free-form duration with no closed set.
    // Asserted rather than left to a comment, because "only these two" is the
    // decision most likely to be widened by someone who read only the labels.
    expect(FIELDS).toEqual(['severity', 'effort']);
    expect(Object.keys(TOKENS).sort()).toEqual(['effort', 'severity']);
  });

  it('carries exactly the documented tokens', () => {
    expect(TOKENS.severity).toEqual(['high', 'medium', 'low']);
    expect(TOKENS.effort).toEqual(['small', 'medium', 'large']);
  });

  it('spells labels with the prefixed full word, never an initial', () => {
    // CLAUDE.md's "no bare tokens" applied to a label: the two fields share
    // `medium`, and their initials collide in the dangerous direction -- `L` is
    // severity *low*, the least urgent thing there is, and effort *large*.
    expect(labelFor('severity', 'low')).toBe('severity:low');
    expect(labelFor('effort', 'large')).toBe('effort:large');
  });

  it('does not confuse the shared `medium` token between the two fields', () => {
    const d = decide('Severity: medium -- x\nEffort: medium -- y', []);
    expect(d.map((x) => x.label)).toEqual(['severity:medium', 'effort:medium']);
  });
});

describe('classificationValue', () => {
  it('reads both fields out of the canonical body', () => {
    expect(classificationValue(BODY_BOTH, 'severity')).toBe('high');
    expect(classificationValue(BODY_BOTH, 'effort')).toBe('large');
  });

  it('is case-insensitive on the key and lower-cases the value', () => {
    expect(classificationValue('SEVERITY: HIGH -- x', 'severity')).toBe('high');
    expect(classificationValue('severity: High -- x', 'severity')).toBe('high');
  });

  it('accepts a tab after the colon', () => {
    // The hook's class was `[[:space:]]+`, which includes a tab.
    expect(classificationValue('Severity:\thigh -- x', 'severity')).toBe('high');
  });

  it('requires AT LEAST ONE space after the colon', () => {
    // THE SPACE RULE. In the hook this stopped the gate's own `--label
    // severity:low` argument -- which sits in the same command string -- from
    // satisfying its own requirement, making every command pass vacuously.
    expect(classificationValue('severity:high', 'severity')).toBeNull();
    expect(classificationValue('effort:large', 'effort')).toBeNull();
  });

  it('does not read a label SPELLING mentioned in the body as a classification', () => {
    // The half of the space rule that survives into CI, and the one a real body
    // hits: a body PROPOSING a label is not a body STATING a classification.
    // Relaxing `+` to `*` turns each of these into a label this check APPLIES.
    expect(classificationValue('add a `severity:high` label to the tracker', 'severity')).toBeNull();
    expect(
      classificationValue('run `gh issue edit 4 --add-label effort:large`', 'effort'),
    ).toBeNull();
  });

  it('requires a non-alphanumeric after the token', () => {
    // `Severity: highly unusual` states nothing. The hook spelled this
    // `([^[:alnum:]]|$)`; here it is a lookahead.
    expect(classificationValue('Severity: highly unusual behaviour', 'severity')).toBeNull();
    expect(classificationValue('Effort: smallish', 'effort')).toBeNull();
    expect(classificationValue('Effort: largely done', 'effort')).toBeNull();
  });

  it('accepts a token at end of line and end of string', () => {
    expect(classificationValue('Severity: low', 'severity')).toBe('low');
    expect(classificationValue('Severity: low\nmore text', 'severity')).toBe('low');
  });

  it('accepts the parenthesised effort shorthand', () => {
    expect(classificationValue('Effort: small (S) -- unit tests only', 'effort')).toBe('small');
    expect(classificationValue('Effort: large (L) -- a new fixture', 'effort')).toBe('large');
  });

  it('requires the key and its value to share a LINE', () => {
    // `grep` is line-based, so the hook could never match across a newline. A
    // JS regex can, so the space class excludes `\n` explicitly -- without that
    // this port would be silently more permissive than the hook.
    expect(classificationValue('Severity:\nhigh -- x', 'severity')).toBeNull();
  });

  it('takes the FIRST match, matching the hook\'s `head -1`', () => {
    expect(classificationValue('Severity: low -- x\nSeverity: high -- y', 'severity')).toBe('low');
  });

  it('reads no Effort from the old packed DURATION shape', () => {
    // `Effort: ~1-3 h` is a duration, not one of the three verification-cycle
    // kinds. Reading it as the new `Effort` is the misreading /work-issues
    // section 3 warns about, and this check must not force it.
    expect(classificationValue(BODY_PACKED, 'effort')).toBeNull();
    expect(classificationValue(BODY_PACKED, 'severity')).toBe('medium');
  });

  it('reads nothing from a body with no classification lines', () => {
    const body = 'Just a feature request, no classification lines.';
    expect(classificationValue(body, 'severity')).toBeNull();
    expect(classificationValue(body, 'effort')).toBeNull();
  });

  it('does not mirror Session-fit or Estimate', () => {
    // Neither key is in `TOKENS`, so neither can produce a decision. The body
    // below states values that LOOK like tokens for both.
    const body = 'Session-fit: now -- do it\nEstimate: ~3 h -- the fixture deploys a NAT gateway';
    expect(decide(body, [])).toEqual([]);
  });
});

describe('decide', () => {
  it('is satisfied when both labels are already present', () => {
    const d = decide(BODY_BOTH, ['bug', 'severity:high', 'effort:large']);
    expect(d.map((x) => x.action)).toEqual(['satisfied', 'satisfied']);
    expect(labelsToApply(d)).toEqual([]);
    expect(conflicts(d)).toEqual([]);
  });

  it('applies both when the issue carries neither', () => {
    const d = decide(BODY_BOTH, ['bug']);
    expect(labelsToApply(d)).toEqual(['severity:high', 'effort:large']);
    expect(conflicts(d)).toEqual([]);
  });

  it('applies only the missing one', () => {
    const d = decide(BODY_BOTH, ['severity:high']);
    expect(labelsToApply(d)).toEqual(['effort:large']);
  });

  it('REPORTS rather than overwrites when a label contradicts the body', () => {
    // The one case where applying is wrong: someone deliberately chose that
    // label. This is the whole difference between this check and a label bot.
    const d = decide(BODY_BOTH, ['severity:low', 'effort:large']);
    const bad = conflicts(d);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.field).toBe('severity');
    expect(bad[0]!.stated).toBe('high');
    expect(bad[0]!.existing).toEqual(['severity:low']);
    // ...and the contradicting label is NOT in the apply list.
    expect(labelsToApply(d)).toEqual([]);
  });

  it('never removes a label, even a contradicting one', () => {
    // There is no removal path at all. Asserted structurally so a future
    // "fix the label" convenience cannot be added without this going red.
    const d = decide(BODY_BOTH, ['severity:low', 'effort:small']);
    expect(Object.keys(d[0]!)).not.toContain('remove');
    expect(d.every((x) => x.action !== 'apply')).toBe(true);
  });

  it('treats a case-variant family label as a conflict, not a second label', () => {
    // Family membership is case-insensitive while satisfaction is exact, and
    // the asymmetry always errs toward NOT writing: adding `severity:high`
    // beside someone's `Severity:High` would be a near-duplicate nobody asked
    // for.
    const d = decide('Severity: high -- x', ['Severity:High']);
    expect(d[0]!.action).toBe('conflict');
    expect(labelsToApply(d)).toEqual([]);
  });

  it('decides nothing for a body that states nothing', () => {
    expect(decide('Just a feature request.', ['bug'])).toEqual([]);
    expect(decide('', [])).toEqual([]);
  });

  it('handles one field stated and the other not', () => {
    const d = decide('Severity: low -- tidiness only', []);
    expect(d).toHaveLength(1);
    expect(d[0]!.label).toBe('severity:low');
  });
});

describe('the conflict comment', () => {
  it('names both sides and states that nothing was changed', () => {
    const d = decide(BODY_BOTH, ['severity:low']);
    const comment = formatConflictComment(d);
    expect(comment).toContain('Severity: high');
    expect(comment).toContain('severity:low');
    expect(comment).toContain('was NOT changed');
    expect(comment).toContain('Session-fit');
    expect(comment).toContain('Estimate');
    expect(comment).toContain('CLAUDE.md');
  });

  it('does not tell the author which side is right', () => {
    // The check cannot know: the body may post-date triage, or the label may
    // encode more than the body says.
    const comment = formatConflictComment(decide(BODY_BOTH, ['severity:low']));
    expect(comment).toContain('whichever is stale');
  });
});

describe('the CLI, as the workflow invokes it', () => {
  it('exits 1 on a real contradiction', () => {
    const { status, stdout } = runCli(
      { kind: 'issue', number: 4, title: 'x', body: BODY_BOTH, labels: ['severity:low'] },
      '--json',
    );
    expect(status).toBe(1);
    expect(JSON.parse(stdout).conflicts).toHaveLength(1);
  });

  it('exits 0 and lists the labels to apply', () => {
    const { status, stdout } = runCli(
      { kind: 'issue', number: 4, title: 'x', body: BODY_BOTH, labels: [] },
      '--json',
    );
    expect(status).toBe(0);
    expect(JSON.parse(stdout).apply).toEqual(['severity:high', 'effort:large']);
  });

  it('does not read the TITLE as a classification', () => {
    // PRECEDENCE, in the form that survives the port. The hook was measured
    // REFUSING a command whose `--title 'Severity: high pages fail'` outranked
    // a body stating `Severity: low` -- quoting a value the body never states.
    const { status, stdout } = runCli(
      {
        kind: 'issue',
        number: 4,
        title: 'Severity: high pages fail on retry',
        body: 'Severity: low -- tidiness only',
        labels: ['severity:low'],
      },
      '--json',
    );
    expect(status).toBe(0);
    expect(JSON.parse(stdout).apply).toEqual([]);
    expect(JSON.parse(stdout).conflicts).toEqual([]);
  });

  it('prints nothing in --comment mode when there is no conflict', () => {
    // An empty file makes `gh api -F body=@` fail loudly rather than post an
    // empty comment.
    const { status, stdout } = runCli(
      { kind: 'issue', number: 4, title: 'x', body: BODY_BOTH, labels: [] },
      '--comment',
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('prints the conflict comment in --comment mode', () => {
    const { status, stdout } = runCli(
      { kind: 'issue', number: 4, title: 'x', body: BODY_BOTH, labels: ['effort:small'] },
      '--comment',
    );
    expect(status).toBe(1);
    expect(stdout).toContain('effort:small');
  });

  it('exits 2, never 0, when the subject cannot be read', () => {
    expect(runCli('{ not json').status).toBe(2);
  });
});
