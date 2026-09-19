---
description: The PR-CONTENT CI checks and their shared annotation fold
paths:
  - 'scripts/annotation-text.ts'
  - 'scripts/check-pr-non-english-text.ts'
  - 'scripts/check-pr-internal-labels.ts'
  - 'scripts/check-pr-closes-paren.ts'
  - 'scripts/non-english-allowlist.txt'
  - '.github/workflows/pr-content-checks.yml'
  - 'tests/unit/scripts/annotation-text.test.ts'
  - 'tests/unit/scripts/pr-closes-paren.test.ts'
  - 'tests/unit/scripts/pr-non-english-text.test.ts'
  - 'tests/unit/scripts/pr-internal-labels.test.ts'
---

# The PR-CONTENT CI checks

Three checks in one job (`pr-content-checks.yml`) over a pull request's diff or
body; conventions in [layout-ci-checks.md](layout-ci-checks.md).

**`annotation-text.ts`** — every emitter folds attacker-controlled text through
it before an `::error` / `::warning` annotation: the runner treats a line
beginning `::` as a workflow command, so a forged line break makes
`::stop-commands::` injectable. The class is `\r \n U+2028 U+2029 U+0085 \v \f`;
TAB and NUL are KEPT, and the fold is to a SPACE, not a deletion.

**The diff checks** — `check-pr-non-english-text.ts` (+ its allow-list) and
`check-pr-internal-labels.ts`.

- The Unicode class must stay identical to `check-gh-body-english.ts`'s:
  hiragana U+3040-309F, katakana U+30A0-30FF, CJK U+4E00-9FFF, Hangul
  U+AC00-D7AF, CJK punctuation U+3000-303F. Typography passes: the subject is
  writing systems.
- WHOLE-FILE, not added lines — hence the allow-list. Entries match EXACTLY,
  resolve from the script's directory, and a STALE entry fails.
- Describe the characters, never reproduce them: `String.fromCodePoint` /
  `\uXXXX`.
- Every branch fails CLOSED, and an empty `BASE_SHA` / `HEAD_SHA` refuses to run
  rather than reporting a vacuous green.
- `internal-pr-labels`' three scope exclusions fence nothing today but become
  load-bearing if an include arm (root `README.md`, `docs/**.md`) widens.

**`check-pr-closes-paren.ts`** — `Closes (#502).` does not auto-close.

- It WARNS and exits 0; returning 1 would make it a gate.
- Exit 2 is the only failure and means "could not look"; collapsing it into 0
  is a fail-open.
- Backtick fences and inline spans are exempt; a `gh` transport failure SKIPS.
- The body is fetched SERVER-SIDE (`gh pr view --json` -> `subject.json`), never
  `${{ github.event.pull_request.body }}`. The job declares `pull-requests:
  read` AND restates `contents: read`, since a job-level block REPLACES the
  workflow-level one.
