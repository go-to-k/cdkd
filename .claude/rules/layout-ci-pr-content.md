---
description: cdkd PR-CONTENT CI checks - the non-English diff scan, the internal-PR-label scan and the auto-close-form body check, plus the pr-content-checks.yml job that runs all three
paths:
  - 'scripts/annotation-text.ts'
  - 'tests/unit/scripts/annotation-text.test.ts'
  - 'scripts/check-pr-non-english-text.ts'
  - 'scripts/check-pr-internal-labels.ts'
  - 'scripts/check-pr-closes-paren.ts'
  - 'scripts/non-english-allowlist.txt'
  - '.github/workflows/pr-content-checks.yml'
  - 'tests/unit/scripts/pr-closes-paren.test.ts'
  - 'tests/unit/scripts/pr-non-english-text.test.ts'
  - 'tests/unit/scripts/pr-internal-labels.test.ts'
---

# The PR-CONTENT CI checks

Split out of [layout-ci-checks.md](layout-ci-checks.md) by issue
[#2736](https://github.com/go-to-k/cdkd/issues/2736), which took that file past
its path band's 20,000 B ceiling.

Precisely: the auto-close entry alone took it to 19,672 B, still UNDER the
ceiling; the review round that followed pushed it to 20,839. An earlier wording
here credited the entry with the whole overrun -- worth correcting rather than
rounding off, because "one entry blew the cap" and "an entry plus its review
round did" prescribe different responses next time.

**Why these three.** They share ONE job (`pr-content-checks.yml`) and one
subject: the content of a PULL REQUEST, its diff or its body. The parent keeps
the PR-TITLE check (subject: the squash subject release-please parses) and the
ISSUE / COMMENT checks (a different workflow, a different event set).

**Read the parent first** for the stopping rule that put all of these in CI
rather than `.claude/hooks/**`, and for the conventions they share.

- **scripts/annotation-text.ts** - the shared line-break fold every check in this family routes attacker-controlled text through before putting it in a `::error` / `::warning` annotation. Unit-tested by `tests/unit/scripts/annotation-text.test.ts` (19 cases).
  - **The failure it prevents.** The Actions runner reads WORKFLOW COMMANDS out of a step's own output: it splits into lines, trims each, and treats one beginning `::` as a command. Every echoed line here is prefixed (`  body:12: `, `::error file=...::`), so a payload cannot reach column 0 — unless it can forge a LINE BREAK, after which everything following is a fresh line the runner parses on its own terms and `::stop-commands::` / `::add-mask::` become injectable.
  - **Why shared.** Measured 2026-09-07 the four emitters disagreed four ways: `check-pr-closes-paren.ts` folded one of its two body-derived fields, `check-pr-non-english-text.ts` stripped only a TRAILING carriage return, and `check-pr-internal-labels.ts` and `check-pr-title-prefix-scope.ts` stripped nothing. One rule in one place is what stops the next sibling inventing a fifth answer.
  - **The FOURTH emitter was found by the fence, not by hand** — `check-pr-title-prefix-scope.ts` interpolates the fork PR's own FILE PATHS, and git permits a carriage return in a filename. It is in a different workflow and a different subject family, which is exactly why a hand-written list missed it; the case that catches it is DERIVED from `scripts/check-{pr,issue,gh}-*.ts`.
  - **The class is `\r \n U+2028 U+2029 U+0085 \v \f`, spelled as escapes.** CR and LF are what the runner's splitter actually breaks on; the rest are folded so this property does not depend on a runner internal. TAB and NUL are deliberately KEPT — neither can break a line, and a checker that REPORTS a finding must not silently rewrite it further. Folded to a SPACE, not deleted, so the quoted line stays honest.
- **scripts/check-pr-non-english-text.ts** + **scripts/non-english-allowlist.txt**, **scripts/check-pr-internal-labels.ts** - PR-DIFF content checks, run from `.github/workflows/pr-content-checks.yml`. CI ports of `non-english-text-gate.sh` and `internal-pr-labels-gate.sh`, retired by issue [#2717](https://github.com/go-to-k/cdkd/issues/2717). Unit-tested by `tests/unit/scripts/pr-non-english-text.test.ts` (78 cases) and `pr-internal-labels.test.ts` (56).
  - **The Unicode class is unchanged and must stay identical to `check-gh-body-english.ts`'s**: hiragana U+3040-309F, katakana U+30A0-30FF, CJK ideographs U+4E00-9FFF, Hangul U+AC00-D7AF, CJK punctuation U+3000-303F. Em-dashes, curly quotes, box-drawing and arrows PASS — the subject is writing systems, not typography. The two checks split by SUBJECT (this one the diff, the other a published body), which is why both exist and why the class drifting apart would be a silent hole.
  - **The WHOLE-FILE semantic was kept, not narrowed to added lines**, and that is why the allow-list exists at all: a file that legitimately contains the characters would otherwise block every PR touching it. Entries match EXACTLY (never prefix or glob) and the file resolves from the script's own directory, so a target repo cannot ship its own exemptions. A STALE entry naming a deleted path now FAILS the check — the same ratchet `ci.yml` applies to `tests/aws-client-defaults-allowlist.json`.
  - **The list shrank 2 -> 1** when #2717 deleted `gh-body-english-gate.test.sh`. The surviving discipline is stated in `pr-non-english-text.test.ts` and pinned by a case over all five files in the family: **describe the characters, never reproduce them** — build fixtures with `String.fromCodePoint` or `\uXXXX`. A test that pastes them in would correctly block every PR touching it, so the fence fails there instead.
  - **Every fail-OPEN branch the hook carried was INVERTED to fail-closed**, with cases pinning it, and the check refuses to run at all when `BASE_SHA` / `HEAD_SHA` are empty rather than scanning nothing and reporting a vacuous green. (`non-english-text-gate.sh` spent months inert while its own suite certified it green, because the suite's `gh` stub accepted a flag real `gh` rejects — the specific failure this guard exists for.)
  - **`internal-pr-labels`'s three scope EXCLUSIONS (`.claude/*`, any `CLAUDE.md`, `tests/integration/**/README.md`) were measured to fence nothing** — its include arms are root `README.md` plus `docs/**.md`, so every excluded path already falls through as out-of-scope, and deleting all three left the suite green. Preserved verbatim anyway: they are the documented contract and become load-bearing the moment an include arm widens. The measurement is recorded at `shouldScan()`.
- **scripts/check-pr-closes-paren.ts** - PR-BODY auto-close-form check, run from `.github/workflows/pr-content-checks.yml` alongside the two diff checks. The CI successor to `closes-paren-form-gate.sh`, which issue [#2717](https://github.com/go-to-k/cdkd/issues/2717) deleted outright and issue [#2736](https://github.com/go-to-k/cdkd/issues/2736) gave a mechanism back. Unit-tested by `tests/unit/scripts/pr-closes-paren.test.ts` (64 cases), which SPAWNS the real entry point as well as calling `main()` in process -- without that, muting `isMainModule()` left every case green while the CI step did nothing.
  - **It WARNS and exits 0 — the only check here that does.** GitHub auto-closes on a parens-free `#N`, so `Closes (#502).` is a silent no-op and the issue stays OPEN after the merge; the class was measured live four times (go-to-k/cdkd#509 through #514, every merged PR leaving its issue open). By the stopping rule that harm lands on the author's own artifact and is repaired by one `gh issue close`, so it does not justify a gate — but the deletion left only a prose row in `/verify-pr` step 11 (`.claude/skills/verify-pr/references/wrap-up.md`), which is the instruction the gate's own header said gets skipped. A `::warning::` annotation is mechanical without being a gate. **If it ever returns 1 the check has silently become one**, which is why a case pins the 0 and a sibling proves a warning was actually emitted for it.
  - **Exit 2 is the only failure, and it means "could not look"** — a missing argument, an unreadable subject, or a failed SELF-PROBE. Collapsing that into 0 is the fail-open the retired hooks' own load guards existed to prevent.
  - **The code-span and fence exemption is NEW, not ported.** The hook read the raw body, so a PR whose body DOCUMENTS this rule tripped its own check — and this one's does. Backtick fences and inline spans are exempt; `~~~` fences are not recognised, which can only produce a false warning, never a miss.
  - **What was dropped**: every shape that existed to find a PR inside a shell command — `gate_matches` against `$GATE_RE_GH_PR_MERGE`, `gate_pr_selector`'s number extraction, and the whole `-R` / `cd` / `git -C` REPO RESOLUTION half added after a measured 2026-08-25 cross-repo false positive. The deleted suite had **18** cases; **8 are DETECTION and all 8 have successors**, the other 10 asserted that machinery. (An earlier revision said "13 cases, six ported" — copied from the issue body rather than re-derived. `grep -cE '^(run|run_case_repo|run_gh_fail) '` against `git show 5c9eff4f5^:.claude/hooks/closes-paren-form-gate.test.sh` settles it.)
  - **The hook's OFFLINE FAIL-OPEN arm was NOT dropped** — the workflow keeps it, so a `gh` transport failure warns and SKIPS while a present-but-unreadable subject still exits 2. That distinction, and the detector's three known MISS bounds (multi-reference, linked and cross-repo paren forms, all inherited from the hook so none a regression), are stated at the head of `scripts/check-pr-closes-paren.ts` beside the code that implements them, per CLAUDE.md's rule that a mechanism lives at its module and a rule file carries the pointer. An earlier revision of THIS bullet copied both out, which is how it blew the 20,000 B per-file cap and put two copies of one claim in the tree.
  - **The body is fetched SERVER-SIDE** with `gh pr view --json` and handed over as a `subject.json`, per `gh-subject.ts`'s contract — `${{ github.event.pull_request.body }}` is written nowhere. That is why the job declares `pull-requests: read`. It is declared at the JOB because a job-level block REPLACES the workflow-level one rather than merging, so `contents: read` is restated beside it or the two diff checks lose git access. It does NOT scope the widening — there is one job, and all four of its steps run under the same token. An earlier revision of this sentence said it did; the claim was retracted in the workflow's own comment and then carried back in verbatim when this file was split out of the parent, which is how a corrected security model comes back to life in an agent-instruction file.
