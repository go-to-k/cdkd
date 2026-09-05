import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `.github/workflows/pr-inherit-issue-labels.yml` copies a closed issue's
 * labels onto the PR that closes it. Its whole body is an inline `run:` block,
 * and it CANNOT be extracted to a script file: the workflow runs on
 * `pull_request_target` with nothing checked out, so there is no repo file for
 * it to call. An inline block is otherwise unreachable by any test -- it only
 * ever executes on GitHub, on a real PR, where a mistake shows up as labels
 * silently not appearing.
 *
 * So this suite EXTRACTS the block and runs it against a PATH-stubbed `gh`.
 * The stub answers the three reads (`gh pr view --json title,body`,
 * `gh issue view --json labels`, `gh pr view --json labels`) and echoes the
 * payload of the one write, so every case asserts the exact label set the
 * workflow would POST.
 *
 * WHAT EACH CASE FENCES -- these are the ways the copy goes wrong quietly:
 *   - the deny list, so a `released` label (applied by semantic-release, the pre-release-please automation, AFTER
 *     the fix ships) never lands on a PR that has not merged
 *   - label names CONTAINING SPACES (`good first issue`), which a built-up
 *     `-f labels[]=...` argument string splits mid-name -- the reason the
 *     payload is JSON
 *   - `Closes (#N)`, the paren form, which does NOT auto-close and which
 *     `.claude/hooks/closes-paren-form-gate.sh` refuses at merge. Matching it
 *     here would paper over that gate
 *   - a closing reference to a PULL REQUEST number, filtered by `gh issue
 *     view` failing on it rather than by a second API call
 *   - a full issue URL in THIS repo (matched) vs one in another repo (not),
 *     because the other repo's label may not exist here
 *   - the WRITE target, not just the label set: re-pointing the POST at another
 *     repo left every earlier case green
 *   - dedup across two issues sharing a label neither is already on the PR --
 *     the earlier overlap case confounded `sort -u` with the `have` filter
 *   - each deny-list entry individually, including the per-channel
 *     `released on @<channel>` form semantic-release actually emitted
 *
 * Mutation-probed 2026-08-26: removing the deny list fails 7 of 17; dropping
 * `sort -u`, re-pointing the POST, accepting the `Closes (#N)` paren form, and
 * narrowing the deny list back to a fixed `released on @experimental` each fail
 * exactly 1.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = join(repoRoot, '.github', 'workflows', 'pr-inherit-issue-labels.yml');

/** The `run: |` block, dedented by its own indentation. */
function extractRunBlock(): string {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const marker = '        run: |\n';
  // UNIQUENESS is asserted, not assumed. The slice runs to EOF, so a second
  // step appended after this one would be spliced into the script and executed
  // as bash by every case below -- or, if it came first, would be the thing
  // tested while the real block went unexercised.
  expect(yml.split(marker).length, 'the workflow must carry exactly one `run: |` block').toBe(2);
  const at = yml.indexOf(marker);
  return yml
    .slice(at + marker.length)
    .split('\n')
    .map((l) => (l.startsWith(' '.repeat(10)) ? l.slice(10) : l))
    .join('\n');
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-inherit-labels-'));
  writeFileSync(join(dir, 'script.sh'), extractRunBlock());
  // Labels are `|`-separated in the fixture env and split to ONE PER LINE here,
  // because that is what `gh --json labels -q '.labels[].name'` emits. An
  // earlier stub emitted them space-separated and reported `good first issue`
  // as three labels -- a stub artefact that would have read as a real defect.
  const stub = [
    '#!/usr/bin/env bash',
    'case "$1 $2" in',
    '  "pr view")',
    '    if printf %s "$*" | grep -q "title,body"; then',
    '      printf "%s\\n" "$PR_TITLE"; printf "%s\\n" "$PR_BODY"',
    '    else',
    '      [ -n "${PR_LABELS:-}" ] && printf %s "$PR_LABELS" | tr "|" "\\n"',
    '    fi ;;',
    '  "issue view")',
    '    v=$(eval "printf %s \\"\\${ISSUE_$3:-__MISSING__}\\"")',
    '    [ "$v" = "__MISSING__" ] && exit 1',
    '    printf %s "$v" | tr "|" "\\n" ;;',
    '  "api "*|"api")',
    // The one WRITE had an unasserted target: re-pointing the POST at another
    // repo's `pulls/1/labels` left every case green. The argv is echoed so a
    // case can pin WHERE the labels land, not just which ones.
    '    echo "API-ARGV: $*"; echo "API-PAYLOAD:"; cat ;;',
    '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'gh'), stub);
  chmodSync(join(dir, 'gh'), 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the extracted block and returns the labels it would POST, sorted. */
function run(env: Record<string, string>): { out: string; posted: string[]; target: string } {
  const out = execFileSync('bash', [join(dir, 'script.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      REPO: 'go-to-k/cdkd',
      PR_NUMBER: '99',
      PR_LABELS: '',
      ...env,
    },
  });
  const at = out.indexOf('API-PAYLOAD:');
  if (at === -1) return { out, posted: [], target: '' };
  const header = out.slice(0, at).split('\n').filter((l) => l.startsWith('API-ARGV:')).pop() ?? '';
  const payload = JSON.parse(out.slice(at + 'API-PAYLOAD:'.length));
  return { out, posted: [...payload.labels].sort(), target: header.replace('API-ARGV:', '').trim() };
}

describe('pr-inherit-issue-labels workflow', () => {
  it('copies the issue labels and drops the release-management ones', () => {
    const { posted } = run({
      PR_TITLE: 'fix(iam): drop the phantom property',
      PR_BODY: 'Closes #12',
      ISSUE_12: 'bug|severity:high|effort:large|released',
    });
    expect(posted).toEqual(['bug', 'effort:large', 'severity:high']);
  });

  it('keeps a label name that contains spaces intact', () => {
    const { posted } = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Fixes #7 and resolves #8',
      ISSUE_7: 'good first issue|severity:low',
      ISSUE_8: 'severity:low|effort:small',
      PR_LABELS: 'severity:low',
    });
    // `severity:low` is already on the PR, so only the two new ones are posted.
    expect(posted).toEqual(['effort:small', 'good first issue']);
  });

  it('does not match the `Closes (#N)` paren form', () => {
    const { out, posted } = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes (#12)',
      ISSUE_12: 'bug|severity:high',
    });
    expect(posted).toEqual([]);
    expect(out).toContain('No closing reference');
  });

  it('ignores a reference that is not a closing keyword', () => {
    const { posted } = run({ PR_TITLE: 'chore: tidy', PR_BODY: 'Refs #12', ISSUE_12: 'bug' });
    expect(posted).toEqual([]);
  });

  it('skips a closing reference that names a pull request, not an issue', () => {
    const { out, posted } = run({ PR_TITLE: 'fix: x', PR_BODY: 'Closes #500' });
    expect(posted).toEqual([]);
    expect(out).toContain('#500 is not an issue');
  });

  it('matches a full issue URL in THIS repo but not in another', () => {
    const mine = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Resolves https://github.com/go-to-k/cdkd/issues/33',
      ISSUE_33: 'severity:medium',
    });
    expect(mine.posted).toEqual(['severity:medium']);

    const theirs = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes https://github.com/other/repo/issues/12',
      ISSUE_12: 'bug',
    });
    expect(theirs.posted).toEqual([]);
  });

  it('matches the `owner/repo#N` form for THIS repo (issue go-to-k/cdkd#2661)', () => {
    // The repo's own convention asks for the qualified `owner/repo#N` spelling
    // in published artifacts, so this is the form most PR bodies actually
    // carry. Measured on 2026-09-05: three of four merged PRs inherited NO
    // labels because the regex accepted only a bare `#N` or a full URL.
    const { posted } = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes go-to-k/cdkd#41',
      ISSUE_41: 'severity:medium|effort:small',
    });
    expect(posted).toEqual(['effort:small', 'severity:medium']);
  });

  it('does NOT harvest an `owner/repo#N` reference to ANOTHER repo', () => {
    // The failure a naive widening introduces: cdkd PR bodies routinely close
    // a cdkd issue while CITING an upstream one, so labelling this PR from
    // `go-to-k/cdk-local#699` would be labelling from a different tracker.
    const { posted } = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes go-to-k/cdk-local#699',
      ISSUE_699: 'bug',
    });
    expect(posted).toEqual([]);
  });

  it('still matches the LITERAL form of a repo name containing a metachar', () => {
    // The positive twin of the case below, and the one that discriminates.
    // The negative alone is one-sided: an OVER-escape that breaks matching
    // outright also passes it. Shipped review round 1 emitted `\\.` (a literal
    // backslash then a wildcard), so a dotted repo matched nothing at all --
    // and the pre-existing URL branch regressed with it -- while every
    // assertion stayed green.
    const { posted } = run({
      REPO: 'go-to-k/cd.d',
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes go-to-k/cd.d#5',
      ISSUE_5: 'bug',
    });
    expect(posted).toEqual(['bug']);
  });

  it('still matches a full issue URL when the repo name contains a metachar', () => {
    const { posted } = run({
      REPO: 'go-to-k/cd.d',
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes https://github.com/go-to-k/cd.d/issues/5',
      ISSUE_5: 'bug',
    });
    expect(posted).toEqual(['bug']);
  });

  it('treats a metachar as a literal in the URL branch too', () => {
    // The negative twin for the URL branch specifically. Round 2 measured that
    // escaping the qualified branch while interpolating the RAW `$REPO` into
    // the URL branch left all 23 other cases green -- the same one-sided gap
    // round 1 found, one branch over. The case at 'matches a full issue URL in
    // THIS repo but not in another' cannot catch it, because it uses
    // `go-to-k/cdkd`, where the escaped and raw spellings are identical.
    const { posted } = run({
      REPO: 'go-to-k/cd.d',
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes https://github.com/go-to-k/cdXd/issues/5',
      ISSUE_5: 'bug',
    });
    expect(posted).toEqual([]);
  });

  it('treats a regex metachar in the repo name as a literal', () => {
    // `$REPO` is interpolated into an ERE. Unescaped, the `.` here is a
    // wildcard and `go-to-k/cdXd#5` passes as this repo -- a near-miss repo
    // harvesting labels into ours. Nothing covered this before go-to-k/cdkd#2661.
    const { posted } = run({
      REPO: 'go-to-k/cd.d',
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes go-to-k/cdXd#5',
      ISSUE_5: 'bug',
    });
    expect(posted).toEqual([]);
  });

  it('does NOT treat a repo whose name PREFIXES this one as this repo', () => {
    const { posted } = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes go-to-k/cdkd-extra#77',
      ISSUE_77: 'bug',
    });
    expect(posted).toEqual([]);
  });

  it('posts to THIS PR\'s labels endpoint, not somewhere else', () => {
    const { target } = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes #12',
      ISSUE_12: 'severity:high',
    });
    expect(target).toContain('repos/go-to-k/cdkd/issues/99/labels');
    expect(target).toContain('--method POST');
  });

  it('deduplicates a label two closed issues share', () => {
    // Without `sort -u` this posts the same label twice. The earlier cases
    // could not see it: their overlap was also already on the PR, so the
    // `have` filter removed the duplicate for an unrelated reason.
    const { posted } = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes #7 and closes #8',
      ISSUE_7: 'severity:high|bug',
      ISSUE_8: 'severity:high|effort:small',
    });
    expect(posted).toEqual(['bug', 'effort:small', 'severity:high']);
  });

  it.each([
    ['released', 'released'],
    ['duplicate', 'duplicate'],
    ['wontfix', 'wontfix'],
    ['invalid', 'invalid'],
    // Not a fixed string: semantic-release emitted one per release channel, so a
    // hardcoded `released on @experimental` breaks the moment a channel is added.
    ['a per-channel released label', 'released on @next'],
  ])('drops %s', (_name, label) => {
    const { posted } = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes #12',
      ISSUE_12: `${label}|severity:high`,
    });
    expect(posted).toEqual(['severity:high']);
  });

  it('finds a closing keyword that appears only in the title', () => {
    const { posted } = run({
      PR_TITLE: 'fix(iam): drop the phantom property, fixes #12',
      PR_BODY: 'No reference in the body at all.',
      ISSUE_12: 'severity:medium',
    });
    expect(posted).toEqual(['severity:medium']);
  });

  it('posts nothing when every label is already on the PR', () => {
    const { out, posted } = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes #12',
      ISSUE_12: 'bug|severity:high',
      PR_LABELS: 'bug|severity:high',
    });
    expect(posted).toEqual([]);
    expect(out).toContain('already carries every label');
  });

  it('posts nothing when the issue carries only denied labels', () => {
    const { out, posted } = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Closes #12',
      ISSUE_12: 'released|wontfix',
    });
    expect(posted).toEqual([]);
    expect(out).toContain('after the deny list');
  });

  it('finds a lower-case keyword on its own line in a multi-line body', () => {
    const { posted } = run({
      PR_TITLE: 'fix: x',
      PR_BODY: 'Some text\ncloses #12\n\nmore',
      ISSUE_12: 'severity:high|effort:small',
    });
    expect(posted).toEqual(['effort:small', 'severity:high']);
  });
});
