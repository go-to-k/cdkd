---
description: cdkd CI checks that replaced PreToolUse gates - the PR-diff, PR-title and issue/comment/body checkers under scripts/, and the three workflows that run them
paths:
  - 'scripts/check-pr-*.ts'
  - 'scripts/check-issue-*.ts'
  - 'scripts/check-gh-body-english.ts'
  - 'scripts/gh-subject.ts'
  - 'scripts/non-english-allowlist.txt'
  - '.github/workflows/pr-title-check.yml'
  - '.github/workflows/pr-content-checks.yml'
  - '.github/workflows/issue-conventions.yml'
  - 'tests/unit/scripts/pr-title-prefix-scope.test.ts'
  - 'tests/unit/scripts/pr-non-english-text.test.ts'
  - 'tests/unit/scripts/gh-body-english.test.ts'
  - 'tests/unit/scripts/issue-classification-labels.test.ts'
  - 'tests/unit/scripts/workflow-registration.test.ts'
  - 'tests/unit/scripts/non-english-class-sync.test.ts'
---

# The CI checks that replaced PreToolUse gates

These take a GITHUB ARTIFACT — a PR title, a changed-file list, an issue body —
and report by failing a workflow job. That is a different subject and a different
failure mode from the `src/`-analysing generators in
[layout-scripts.md](layout-scripts.md). The stopping rule that decides which side
a new check belongs on is in [hooks.md](hooks.md), and **both of its clauses have
to be stated when applying it**: harm completing at the moment of the action, AND
landing on a THIRD PARTY's artifact.

## scripts/check-pr-title-prefix-scope.ts

Run from `pr-title-check.yml` on `opened` / `edited` / `synchronize` /
`reopened`; unit-tested by `pr-title-prefix-scope.test.ts`.

- **What it enforces**: a `feat:` / `fix:` PR title feeds a release-please
  version bump, so it must be backed by at least one changed file under `src/**`
  OR a `changelog.d/entries/**` fragment. The second arm exists because `src/**`
  cannot see a bump to a runtime dependency cdkd BUNDLES — `cdk-local` ships
  inside the binary, so its version bump is user-visible with no `src/**` diff
  ([#3548](https://github.com/go-to-k/cdkd/issues/3548)). The fragment is the
  author's affirmative claim, per AGENTS.md's rule that only a user-visible
  change writes one; the filename is validated with the ASSEMBLER's own
  `ENTRY_NAME`, so `.gitkeep` and a malformed name do not count.
  `revert:` and every non-release type pass. The grammar is
  `^([a-z]+)(\([^)]+\))?!?: ` — lowercase-only type and a REQUIRED space after
  the colon, so `Fix:`, `feat2:` and `fix:x` are not release prefixes.
- **Why ONE title check replaces two hooks**: the repo squash-merges, so the PR
  title becomes the squash subject release-please parses and branch commit
  subjects never reach `main` as their own objects. That is a claim about GitHub
  SETTINGS: `allow_merge_commit: false`, `allow_rebase_merge: false`,
  `squash_merge_commit_title: PR_TITLE`, `squash_merge_commit_message: BLANK`.
  All four matter — under `COMMIT_OR_PR_TITLE` a single-commit PR squashes under
  that commit's subject, and `COMMIT_MESSAGES` would put branch commit bodies in
  front of release-please's footer parser.
- **The premise is ASSERTED, not assumed**: `--check-settings
  <repo-settings.json>` re-reads those toggles as a second workflow step and
  fails naming which precondition broke. A `gh` TRANSPORT failure warns instead —
  an unreachable API is not evidence a setting changed; the CHECK itself never
  fails open that way.
- **The settings audit cannot run in CI, and that is a permission boundary.**
  GitHub returns the merge settings only to an ADMIN token, and it is
  all-or-nothing over the four fields read: if any is missing the step emits
  `::warning:: NOT VERIFIED`, exits 0, and says nothing was checked — never a
  success line. The real audit runs in `/verify-pr` with a maintainer's token.
- **Fail-open surfaces, each closed deliberately**: the changed-file list comes
  from `gh api repos/{o}/{r}/pulls/{n}/files --paginate`, not a local `git diff`
  (`actions/checkout` fetches depth 1, so a 3-dot diff would be silently wrong,
  and a wrong file list passes); `--paginate` because the endpoint pages at 100;
  the step runs under `set -euo pipefail` so a `gh` failure reds it instead of
  feeding an empty list.
- **Local use**: `--git-diff` takes the list from
  `git diff --name-only origin/main...HEAD`. Read its OUTPUT, not just its exit
  code — on a branch with no commits the diff is empty and every title passes
  through the `no-diff` arm at rc=0. Probe with `--files-from <path>`.
- What CI buys over the hook: it re-runs on `synchronize` (a title that stops
  being correct when a later push drops the last `src/**` file) and on `edited`
  (a web-UI retitle, invisible to a `gh`-shaped hook in principle).

## The issue / comment / PR-body checks

`check-gh-body-english.ts`, `check-issue-classification-labels.ts` and the
shared `gh-subject.ts`, run from `issue-conventions.yml` on `issues` /
`issue_comment` / `pull_request`.

- **`pull_request`, NOT `pull_request_target`, and that is a security
  decision.** These checks only have to say no, so a failing check run is the
  whole output and no write token is needed; `pull_request_target` would hand a
  fork PR's author-controlled body a workflow with write permissions and
  base-repo secrets for zero extra capability. The usual `pull_request` residual
  — a fork shipping a modified copy of the checker — is closed by checking out
  `base.sha` while fetching the body from the API.
- **`issue-classification-labels` REPAIRS where the hook could only refuse**: it
  reads `Severity:` / `Effort:` off the body and APPLIES the matching label. It
  REPORTS instead of applying when body and an existing family label contradict —
  silently overwriting a deliberate human label is the one case where applying is
  wrong. `unlabeled` is deliberately NOT a trigger: a removal is
  indistinguishable from a label never applied, so it would be re-applied.
  `Session-fit` and `Estimate` stay out.
- **Timing is the structural loss**: a PreToolUse gate refused BEFORE the
  artifact existed; a workflow speaks after it is public, so for an issue or
  comment the check reports on text every reader can already see.
- **Two things got stronger**: the web UI and any non-`gh` client are covered,
  and the `-b` / `-t` / `-n` short-flag blind spot is gone.
- **Coverage losses, not recoverable here**: a workflow sees only its own
  repository's events, so cross-repo filing needs a copy in each sibling repo;
  and subscribing to `issues` / `issue_comment` / `pull_request` leaves PR REVIEW
  comments, commit comments, discussions, gists and `gh release create|edit
  --notes` uncovered — think in terms of the EVENT SET, not the verb set.
- **The Bot-sender filter lives in BOTH halves, and the script is the
  authority.** Two of these jobs POST comments, and a comment is itself an
  `issue_comment: created` event, so without the filter the check scans its own
  output and fails on it the moment a report QUOTES an offending body back.
  `isBotSender` decides; the workflow `if:` stays as a runner-saving filter, and
  `workflow-registration.test.ts` pins that the two agree (no test can read a
  workflow `if:`, so deleting it alone is silent). `english-issue` passes
  `SENDER_TYPE`; `english-pr` deliberately does not, and that negative is
  asserted. An ABSENT `SENDER_TYPE` means SCAN — defaulting to skip would disable
  the check for any caller that forgot the variable.
- **A sibling script is imported with a `.ts` extension, not `.js`.** Node's type
  stripping resolves specifiers literally, so a `.js` specifier for
  `scripts/gh-subject.ts` fails under `node scripts/check-gh-body-english.ts`.
  AGENTS.md's `.js` rule governs bundled `src/**`, which these are not.

## The PR-CONTENT check

`check-pr-non-english-text.ts` (+ `scripts/non-english-allowlist.txt`), run
from `pr-content-checks.yml` over the PR DIFF. Detail:
[layout-ci-pr-content.md](layout-ci-pr-content.md).
