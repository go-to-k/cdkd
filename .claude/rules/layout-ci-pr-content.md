---
description: The PR-CONTENT CI check and its annotation fold
paths:
  - 'scripts/annotation-text.ts'
  - 'scripts/check-pr-non-english-text.ts'
  - 'scripts/non-english-allowlist.txt'
  - '.github/workflows/pr-content-checks.yml'
  - 'tests/unit/scripts/annotation-text.test.ts'
  - 'tests/unit/scripts/pr-non-english-text.test.ts'
---

# The PR-CONTENT CI check

One check in one job (`pr-content-checks.yml`) over a pull request's diff;
conventions in [layout-ci-checks.md](layout-ci-checks.md).

**`annotation-text.ts`** — every emitter folds attacker-controlled text through
it before an `::error` / `::warning` annotation: the runner treats a line
beginning `::` as a workflow command, so a forged line break makes
`::stop-commands::` injectable. The class is `\r \n U+2028 U+2029 U+0085 \v \f`;
TAB and NUL are KEPT, and the fold is to a SPACE, not a deletion.

**The diff check** — `check-pr-non-english-text.ts` (+ its allow-list).

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
