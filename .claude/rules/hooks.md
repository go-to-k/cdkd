---
description: cdkd PreToolUse safety hooks (commit / PR / push guards beyond the markgate gate family)
paths:
  - '.claude/hooks/**'
  - '.claude/settings.json'
  - '.markgate.yml'
---

# Running the hook suites

```bash
vp run test:hooks     # or: bash .claude/hooks/run-tests.sh
```

- **44 of the 45 hooks ship a `*.test.sh` suite** (`run-tests.sh` is the
  runner; only `post-merge-sync-reminder` has none — `stop-warn` got one via
  issue #2396). `.claude/hooks/` holds 46 `*.test.sh` files:
  `markgate-gate-name-class` and `unresolved-target-class` are CLASS fences
  with no same-named `.sh`. **Recount rather than trusting this sentence** —
  it has been stale twice: `ls .claude/hooks/*.sh | grep -v '\.test\.sh$'`.
- **The runner executes every suite under BOTH bashes** — PATH `bash`
  (Homebrew 5.x) and `/bin/bash` (macOS system **3.2**). Hooks are
  `#!/usr/bin/env bash`, so without newer bash first on PATH they run under
  3.2, where bash-4+ syntax (`mapfile`, `declare -A`, `${var^}`, `${var,,}`)
  is a runtime error (#1458 shipped exactly that into `lib/command-match.sh`;
  #1477 found `provider-integ-gate.test.sh` failing 3 of 17 cases there —
  neither detectable from a bash-5-only run).
- **A suite that exits 0 while printing a non-zero `fail: N` tally is a
  failure** — tally-not-exit-code is how the 3.2 breakage stayed invisible.
- **Deliberately NOT part of `vp run check` / `vp run verify`** (throwaway
  git repos, ~6 min). `.github/workflows/hooks.yml` runs it on `macos-latest`
  (the only runner image with bash 3.2) on any `.claude/hooks/**` PR.

# Why every Bash gate stays unconditional

**Every Bash-targeting `PreToolUse` entry in `.claude/settings.json` uses the
coarse `Bash` matcher AND no per-hook `if:` condition.** The absent `if:` is
the load-bearing half: each gate parses the command itself, which is what
lets gates catch the `cd <path> && ...` and `gh -C <path>` spellings.

The `if:` fields silently never fired (go-to-k/cdkd#1455 / #1476 — see "The
`if:` layer is GONE" below). Their removal also immunises cdkd against the
go-to-k/cdk-real-drift#1788 bypass class (measured 2026-08-19 via
go-to-k/cdkd#2016: that repo's matcher was the coarse `Bash` too — the
asymmetry was per-hook `if:` conditions; cdkd carries 0 `if:` fields across
35 Bash hooks, and `check-gate` / `verify-pr-gate` answer rc=2 for the bare
and the `cd <wt> && ...` spellings alike). This matters because
`/work-issues` writes commands in exactly that form. **Fenced by
`tests/unit/scripts/settings-bash-matcher-coverage.test.ts`**: fails on any
per-hook `if:`, any command-narrowed `Bash(...)` matcher, and the removal of
`check-gate` / `verify-pr-gate` / `non-english-text-gate` from the coarse
entry, with a parser floor so "found nothing" cannot pass as "everything
matches".

# Other PreToolUse safety hooks

Twenty additional one-shot hooks block known foot-guns at the source.

- **`.claude/hooks/commit-msg-heredoc-gate.sh`** blocks
  `git commit -m "$(cat <<'EOF' ... EOF)"`-style invocations — outer-shell
  quote tracking miscounts on apostrophes / backticks; use `git commit -F
  <file>`.

- **`.claude/hooks/closes-paren-form-gate.sh`** blocks `gh pr merge <N>` when
  the PR body uses `Closes (#N)` / `Fixes (#N)` / `Resolves (#N)` — GitHub's
  auto-close grammar needs parens-free `#N`, so the parens form leaves the
  issue OPEN after merge (the PR #509-#514 trap). **Fail-open on `gh pr view`
  non-zero exit, but with a LOUD stderr warning** — the old `|| true` swallow
  let PR #671 merge with `Closes (#668).` undetected. Empty body passes
  silently. Smoke test: `closes-paren-form-gate.test.sh` (13 cases).

- **`.claude/hooks/gh-pr-edit-deprecation-gate.sh`** blocks
  `gh pr edit --title` / `--body` — they fail SILENTLY on a GraphQL
  Projects-classic deprecation; use
  `gh api -X PATCH repos/<o>/<r>/pulls/<N> -f title=... -F body=@<file>`.

- **`.claude/hooks/provider-docs-gate.sh`** blocks `git commit` when staged
  `src/provisioning/register-providers.ts` adds a new
  `registry.register('AWS::Service::Type', ...)` call whose type is not in
  **both** `docs/supported-resources.md` and `docs/import.md` (PRs #210-#216
  shipped 7 undocumented types).

- **`.claude/hooks/pr-body-item-number-gate.sh`** blocks `gh pr create` /
  `gh pr edit` / `gh issue create` / `gh issue comment` /
  `gh api -X PATCH .../pulls|issues/...` whose body file (`--body-file <FILE>`
  or `-F`/`--field body=@<FILE>`) contains bare `#N` that GitHub auto-links
  (the "review-fix #4 → linked to unrelated PR #4" trap, PR #237).
  Allow-listed: `closes #N`, `(#N)`, fenced code blocks, GitHub URLs, backtick
  spans, and the cross-repo `owner/repo#N` form (both slug segments must
  contain a letter so `step 1/2#3` stays blocked).
  **A body file the command has not written yet no longer passes silently**
  (#2397): in the one-call `heredoc -> file -> --body-file` shape the path is
  absent at PreToolUse time and `[[ ! -f ]] && continue` was a silent PASS. The
  siblings' whole-command fallback was tried and REJECTED (this gate objects to
  content it FINDS — measured, an item number in a `--title` took an ordinary
  command from 0 to 2); it extracts the HEREDOC BODIES that write the named
  path instead (same extraction and known limit as `gh-body-english-gate.sh`).
  A file that EXISTS is also scanned from the command when the command REWRITES
  it — otherwise the gate judges the PREVIOUS body. **The FIFTH site of the `GATE_PERL_WORD` root cause** (see
  below): a quoted `--body-file` path with a SPACE, a quoted `-F body=@<p>`,
  and the glued `-Fbody=@<p>` all extracted NOTHING, so no body was scanned —
  measured rc=0 where the plain spelling gave 2. Still a KNOWN LIMIT here: a
  bare `-F <path>` is not read at all (the four siblings do read it, but they
  scope to the gh SEGMENT; this gate scans the whole command, so a bare `-F`
  arm would also read `git commit -F <msg>` and turn a `#4` in a commit
  message into a false refusal). Smoke test:
  `pr-body-item-number-gate.test.sh` (50 cases; blocking cases fail against
  the pre-#2397 hook, controls pass there. `exit 0` stub 27, `exit 2` 23,
  `$GW` reverted 19; per-fence tallies in the suite header).

- **`.claude/hooks/internal-pr-labels-gate.sh`** blocks `git commit` when
  staged `README.md` / `docs/*.md` add `(PR 8b)` / `(PR 6 of #224)` style
  internal dev labels in diff lines (the PR #251 leak of agent-dispatch
  prose into user-facing docs). `CLAUDE.md` and `tests/integration/**/README.md`
  are excluded; fenced code blocks and backtick spans allow-listed. Smoke
  test: `internal-pr-labels-gate.test.sh`.

- **`.claude/hooks/cmd-parse-stub-gate.sh`** blocks `git commit` when a staged
  `tests/**/*.test.ts` calls Commander's `cmd.parse([...])` without a nearby
  `.action(() => {})` stub (60-line lookback) — Node 24 escalates the real
  action handler's `process.exit(...)` unhandled rejection to a process exit
  AFTER the assertion passed (PR #266). `cmd.parseAsync(...)`, test files
  without `cmd.parse(...)`, and `src/**` pass. Smoke test:
  `cmd-parse-stub-gate.test.sh`.

- **`.claude/hooks/commit-prefix-scope-gate.sh`** blocks `git commit` with a
  `feat:` / `fix:` prefix when NO `src/**` file is staged — a
  `feat(review-pr):` commit on `.claude/skills/**` triggered a misleading
  minor release (PR #346 / v0.97.0; release-please consumes the same prefixes
  today). Reads `-F <file>` / `--message=` / `--message ` too; `revert:`,
  `--amend`, and bare `git commit` (editor) pass. The error lists staged files
  and suggests the right prefix. Smoke test:
  `commit-prefix-scope-gate.test.sh` (49 cases).
  **The `-F` / `--file` path is a shell WORD (`GATE_PERL_WORD`)**: five arms
  enumerating quote positions left `--file "$VAR"` and a glued `-F<path>`
  unextracted, so a `fix:` commit with no `src/**` change reached a release. An
  UNRESOLVABLE path (`$`, backtick, `*`, `?`, `[`, `~user`) REFUSES; `~/` is
  resolved, not refused.

- **`.claude/hooks/pr-title-prefix-scope-gate.sh`** — PR-title counterpart:
  blocks `gh pr create --title "feat:|fix:..."` and
  `gh api -X PATCH .../pulls/<N> -f title="feat:|fix:..."` when
  `git diff origin/main...HEAD --name-only` (3-dot, matching `gh pr diff`'s
  view) has no `src/**` file. Closes PR #562 / v0.145.1 (2026-05-24,
  cdkd#565): commits were `chore:` but the PR title `fix(hooks):` fed the
  squash subject into the release automation. `gh pr create` without
  `--title` (editor mode) and title-less PATCH calls pass. Same
  suggested-prefix heuristic. Smoke test: `pr-title-prefix-scope-gate.test.sh`
  (22 cases — every `--title` / `-f`/`-F`/`--field`/`--raw-field title=`
  shape plus quoted-body false-positive avoidance).

- **`.claude/hooks/integ-coverage-matrix-gate.sh`** blocks `git commit` when
  staged files touch the integ-coverage matrix's source scope
  (`tests/integration/<name>/{lib,bin}/*.ts` or
  `src/provisioning/register-providers.ts`) AND `vp run integ-coverage` would
  produce a different `docs/integ-coverage.md` /
  `docs/_generated/integ-coverage.json` than the working tree — pre-hook the
  only enforcement fired after push (CI hard-fail). Runs the real regenerator
  (~0.1s) and **restores the originals before blocking** so the tree is not
  silently modified; the user runs `vp run integ-coverage` + `git add`
  themselves. Comment-only refactors pass. Smoke test:
  `integ-coverage-matrix-gate.test.sh` (12 cases).

- **`.claude/hooks/non-english-text-gate.sh`** blocks `gh pr create` /
  `gh pr edit` / `gh pr merge` (and their `cd <path> && ...` forms — NOT
  `gh -C <path>`, which is not a thing, see below) when the resolved PR diff
  (or local `origin/main..HEAD` when no PR exists) contains non-English
  writing-system characters — hiragana (U+3040-U+309F), katakana
  (U+30A0-U+30FF), CJK ideographs (U+4E00-U+9FFF), Hangul (U+AC00-U+D7AF),
  CJK punctuation (U+3000-U+303F). Closes the PR #521 gap. Per-PR, not
  per-commit, by design (~100-250ms once vs ~30-150ms per commit;
  `gh pr merge` is the one funnel every commit lands through).
  Detection via `perl -CSD -ne` (BSD `grep` lacks PCRE).
  **INERT until 2026-08-25, and its own suite certified it as working**: `gh`
  has NO `-C` flag (measured, gh 2.89.0: exit 1, `unknown shorthand flag`),
  so the "gh missing, fail open" guard fired unconditionally and the hook
  returned 0 before scanning anything. **The suite sat at 15/15 because its
  `$GH_BIN` stub STRIPPED `-C`** — a mock more permissive than production
  CERTIFIES a defect as fixed, strictly worse than no test. The stub now
  REJECTS `-C` as real gh does (fails 9 of 17 against the shipped hook); the
  hook's gh calls run in a subshell that `cd`s to the target (`git -C` is
  untouched — git has the flag).
  **Sidecar allow-list `.claude/hooks/non-english-allowlist.txt`**: the gate
  reads each changed file's WHOLE content at the PR head, so a file that
  legitimately CONTAINS the characters blocks every PR touching it (measured
  2026-08-31: exactly three tracked files; two listed because the characters
  ARE the subject under test, the third was prose, translated instead). Three
  load-bearing properties: paths match EXACTLY (never prefix/glob); the file
  resolves absolute from the HOOK's own directory (a target repo cannot ship
  exemptions); the list is NOT on itself, so its comments must DESCRIBE
  content, never reproduce it (the first draft quoted the word and blocked its
  own PR). An absent/unreadable list scans everything — the safe direction.
  Skips binary / lockfile / asset extensions; fails open when
  `gh` is missing or unauthenticated; em-dashes / curly quotes / box-drawing
  / arrows pass (writing systems only). **No bypass marker — translate the
  text.** Smoke test: `non-english-text-gate.test.sh` (30 cases, stub strict
  about `-C`; drives only 2 of the hook's 5 `gh` call sites — the PR-branch
  sites were verified by hand, tracked as go-to-k/cdkd#2197 with the two
  failed attempts in the test header).

- **`.claude/hooks/state-destroy-force-gate.sh`** blocks `git commit` when a
  staged `tests/integration/**/*.sh` adds `cdkd state destroy ... --force` —
  that subcommand rejects `--force` (`--yes` only). The trap is three sibling
  flag sets: top-level `cdkd destroy` accepts BOTH `--yes` and `--force`;
  `cdkd state destroy` accepts `--yes` only; `cdkd state orphan` accepts
  `--force` (lock bypass). The bug hides under `>/dev/null 2>&1` cleanup traps
  and bites only a FAILED deploy (trap is then the only cleanup path). The
  2026-05-30 sweep verified all 12 named offenders were already fixed; the
  hook prevents the regression. Scope: `tests/integration/**/*.sh` only;
  top-level `destroy --force` / `state orphan --force` and comments pass.
  Smoke test: `state-destroy-force-gate.test.sh` (10 cases). No bypass — the
  fix is a one-character swap.

- **`.claude/hooks/ref-segment-audit-gate.sh`** blocks `git commit` when
  staged `src/deployment/intrinsic-function-resolver.ts` adds a NEW bare
  `'AWS::Service::Type'` entry to `REF_RETURNS_SEGMENT_AFTER_PIPE` without a
  matching unit test under `tests/unit/deployment/` referencing the literal.
  A wrong/omitted entry leaks a whole compound `<parent>|<child>` id through
  `Ref` (the `AWS::Cognito::UserPoolResourceServer` bug, PR #930, found by
  `/hunt-bugs`). The hook enforces the unit-test half mechanically; its block
  message restates the judgmental family-audit half (`describe-type
  primaryIdentifier` + AWS-docs `Ref` classification). Detection is on the
  bare-array-element line shape; refactor-only diffs pass (`comm -23`). Smoke
  test: `ref-segment-audit-gate.test.sh` (8 cases). No bypass.

- **`.claude/hooks/gh-body-english-gate.sh`** blocks `gh pr create` /
  `pr edit` / `pr comment` / `pr review` / `gh issue create` / `comment` /
  `edit` / `gh release create` / `edit` / `gh api` when the BODY, TITLE or
  NOTES being published contains non-English writing-system characters — the
  body-side twin of `non-english-text-gate.sh` (that one's subject is the PR
  **diff**, which structurally cannot see a body or title); the Unicode class
  is kept character-for-character identical in both. Closes issue #1993:
  the English-only rule's old "files that land in the repository" clause put
  issue bodies OUTSIDE the rule while `/work-issues` and `/hunt-bugs` file
  them as a normal step (seen live in cdk-local).
  **The design is "no shell parsing" — the load-bearing decision.** Every
  matched flag is gh-defined (`--body-file` / `--notes-file` / `-F <p>` /
  `-F`-`--field`-`--raw-field` `body|title|notes=@<p>`; `--body` /
  `--title` / `--notes` + `gh api` field forms), so a match anywhere belongs
  to the gh invocation. **Short flags `-b` / `-t` / `-n` are deliberately
  NOT scanned** (collide with `echo -n` / `grep -n` / `sed -n` / `sort -t`;
  attributing them is shell parsing). Six review rounds are the evidence: a
  hand-rolled quote/separator scanner shipped a defect per round — deleting
  the scanner deleted the class.
  The trade runs in the FALSE-POSITIVE direction (documented): a later non-gh
  command with a literal `--body` and non-English text blocks; `-F` is not
  gh-unique (`git commit -F`, `awk -F`) — the file-existence check plus the
  character-class test keep it safe.
  Reads pass (verb must be publishing AND a body flag present: `gh api ...
  --jq .body`, `gh issue list --search` pass). Relative paths resolve
  against payload `cwd` + leading `cd`; gh global flags before the verb are
  absorbed by the shared `GATE_GH_C` (go-to-k/cdkd#2156 — a local
  enumeration had lost `gh --template "a b" issue create` and
  Known limits, all measured: the short flags; run-time-assembled text
  (`--body "$(cat jp.txt)"`); `gh api --input <file>` / `--body-file -`. Two
  former SHARED-matcher limits — a gh call nested in a substitution/subshell,
  an unbalanced apostrophe swallowing the rest — are FIXED by the #2129
  convergence (issue #2093), as is a verb behind `xargs` / `sudo` / `if` /
  `while` / a `case` arm; kept as blocking cases with controls. An unquoted
  value now STOPS at an unquoted shell metacharacter (where the shell ends
  the word) and adjacent quoted chunks are spanned — both were limits, both
  fail-open.
  Two pinned traps, each of which made the hook silently pass everything:
  **`perl -CSD`** (not `grep -P`; without it perl decodes latin-1 and the
  `\x{3000}` ranges never match) and **`perl -0777`** whole-text extraction
  (a multi-line quoted body is the NORMAL inline shape). The class test runs
  INSIDE the extraction perl — one spawn per value cost 3.8s for 500 values,
  past the hook's own 15s timeout, and a timeout is, for a gate, a silent pass
  (0.09s after the fix).
  **The body file the command is about to WRITE is now scanned** (#2397) —
  NOT via the siblings' whole-command fallback (a body file under a
  Japanese-named directory is a documented PASS case, which that fallback
  turns into a block). It extracts the HEREDOC BODIES that write the named
  path — both orders, quoted/unquoted delimiters, `<<-`'s TAB-only
  terminator, every chunk, the tight `>f<<EOF` / `>f;` / `>f&&` spellings —
  and scans exactly the text published. It arms when the path is
  unreadable OR the command WRITES it;
  the FILE is still read unless the command TRUNCATES it (an APPEND leaves
  existing content as the first half of the body). Heredoc-found is reported
  by STATUS — an empty body prints nothing, and inferring "no heredoc" from
  that FALSE-BLOCKED an empty rewrite. The same precision keeps `-F` safe
  (`awk -F ,` names a path never written — stays a skip).
  **Five header-declared "known limits" were live BYPASSES and are fixed**
  (2026-09-05, shared `GATE_PERL_WORD` — see "One value class for the SIX
  gates that extract with perl" below), each measured rc=0 on a Japanese body where the plain
  spelling gave 2: a quoted `--body-file` path with a SPACE; the glued
  `-F<path>` / `-fbody=<text>` shorthands; a glued `-F<path>` on a SHORT-flag-
  only command, which never even ARMED; a path followed by an unquoted `;`;
  and ANSI-C `$'…'`. A limit line is not a licence.
  No bypass marker — translate the text. Smoke test:
  `gh-body-english-gate.test.sh` (129 cases, bash 5.x AND macOS 3.2;
  `HOOK_BASH=<path>` runs the HOOK under that bash too). The
  japanese-in-the-PATH pass case is LOAD-BEARING (fails if the extraction is
  replaced by a whole-command scan), paired with a
  japanese-path-plus-english-heredoc-body case and an English body at a
  Review-round regressions are each verified red against the corresponding
  PRE-FIX hook (16 in the latest round alone); each Unicode range covered in
  ISOLATION; plus known-limit, quoted-body false-positive and registration
  Re-probed on the 129-case suite: `exit 0` stub 86, `exit 2` 42, `$GW`
  reverted 32. Per-fence tallies live in the suite header.

- **`.claude/hooks/gated-command-preamble-gate.sh`** blocks a Bash call that
  runs a SIDE-EFFECTING preamble in an earlier segment than a GATED command
  (`git commit`, `gh pr create`, `gh pr merge`) — a PreToolUse denial aborts the
  WHOLE call, so a refusal silently discards the preamble. Violated TWICE in one
  run on 2026-08-25 by an agent that had read the prose rule (`markgate set`
  discarded → retry read as "the marker will not stick") — a written rule
  violated anyway is escalated, not restated (§10-b).
  **Side-effecting means losing it is SILENT**: `markgate set`, a write
  redirect (a `>>` retry appends to nothing — go-to-k/cdk-local#525 lost its
  `Closes` line), `cp` / `mv` / `tee` / `touch` / `sed -i`, and — since #2369
  — interpreter one-liners (`python3 -c` / `node -e` / `perl -e` / `ruby -e`,
  clusters like `perl -pi -e`, the stdin-script `python3 - <<EOF` form): the
  code argument is a quoted span the stripper removes, so the gate cannot see
  whether it writes (measured 2026-08-28, twice in one run). Treated as an
  OPAQUE write; measured before widening, ZERO prescribed shapes combine an
  interpreter one-liner with a gated verb. Known limit: `python3 script.py`
  (a writing script FILE) is not matched. Deliberately ALLOWED:
  `cd <dir> &&` (required on gated commands), reads, `git add` (its loss is
  LOUD — "nothing to commit"), `>/dev/null`, any write AFTER the gated
  command. Matches against `strip_noncommand_spans`, not raw text — the
  first revision refused `grep -n '=>' ... && git commit`, `awk '$3 > 5'`,
  `jq '.a > 1'` and `--body "old > new"`, all now regression cases. The
  remediation lists EVERY preamble, not the last. Fails CLOSED on an
  unloadable matcher. Smoke test: `gated-command-preamble-gate.test.sh`
  (60 cases, both polarities; the six interpreter BLOCK cases fail against
  the pre-#2369 hook; bash 5.x + 3.2). Declared a non-verifier in
  `markgate-gate-name-class.test.sh` (it carries `markgate set` as a regex
  literal by trade).

- **`.claude/hooks/flatten-before-rebase-gate.sh`** blocks
  `git rebase <upstream>` when the branch carries 2+ commits AND its diff
  touches an APPEND-SHAPED generated file — `docs/changelog-cdkd.md` or
  `docs/_generated/integ-last-run.tsv` (they conflict on nearly every
  parallel-lane rebase, once PER COMMIT; the repo squash-merges, so
  flattening loses nothing). **An ESCALATION, not a new rule**: ship.md §9's
  "FLATTEN BEFORE YOU REBASE" was skipped on FIVE lanes across TWO runs
  (2026-08-25 ×3; 2026-09-02 go-to-k/cdkd#2428 / go-to-k/cdkd#2450, where
  flattening turned four conflicts into one). **Scope is narrow in three
  independent ways**, each alone a pass: only a rebase naming an UPSTREAM
  (`--continue` / `--abort` / `--skip` / `--quit` / `--edit-todo` — the ways
  OUT of a conflicted rebase — are never blocked, pinned case-by-case); only
  at 2+ commits since the merge base; only when an append-shaped file is in
  the branch diff. `--onto` is left alone. The working tree comes from the
  shared `gate_verb_rest_each_dir` (`cd <lane> && git rebase main` and
  `git -C <lane> rebase main` both read correctly — the hook's own cwd would
  judge the main checkout in exactly the case `-C` was added for). **FAILS
  OPEN** on an unreadable target dir, unresolvable upstream, or any git
  error — deliberately the opposite of the branch/merge gates: a wrong
  refusal can wedge a caller mid-rebase, a miss costs one avoidable
  conflict. The LIBRARY load still fails closed. Bypass
  `CDKD_SKIP_FLATTEN_GATE=1`, honored from the environment or the command
  text, for a deliberate history-preserving rebase. The file list is
  duplicated by necessity (hook decides FIRING, ship.md §9 carries the recipe)
  — `tests/unit/scripts/flatten-gate-file-list-sync.test.ts` fences both
  directions. Smoke test: `flatten-before-rebase-gate.test.sh` (62 cases
  against real git fixtures; each pins its own payload `cwd`). One case pins a
  KNOWN limitation:
  `gate_leading_c_value` reads `-C <path>` but not git's equally valid
  `-C<path>`, inherited by every gate on the shared matcher
  (go-to-k/cdkd#2455).

- **`.claude/hooks/vp-run-test-path-gate.sh`** blocks `vp run test <path>`
  and steers to `vp test run <path>`. The task runner USED TO cache `test`,
  so a repeat REPLAYED the previous result — for a MUTATION PROBE the worst
  hazard: the replayed verdict predates the mutation (measured 2026-08-20;
  one reviewer had FOUR probes report PASS without executing). **Closed at
  the root as of 2026-08-30** — every task in `vite.config.ts` carries
  `cache: false`, fenced by `tests/unit/scripts/vite-task-cache.test.ts` — so
  this is now a CONVENTION gate and the cache must not be cited as a live
  hazard. The steer stands on the one cache-independent reason:
  `vp test run <path>` is the delegated command invoked directly, nothing
  between caller and verdict (the TTY/reporter rationale did not survive:
  re-measured 2026-08-31, 651 B vs 617 B). Scope: only the form carrying a
  PATH argument — bare
  `vp run test`, other tasks, flags, and value-taking flags' values pass;
  the ERE requires `test` to END the task name (a `\b` fired on
  `vp run test:once-leak`). Shared command-position matcher; fails CLOSED
  when the library is unloadable. No bypass — the replacement is a
  word-order change running the same command. Smoke test:
  `vp-run-test-path-gate.test.sh` (51 cases, bash 5.x + 3.2). **Two false
  greens ride the same command that this hook does NOT close** — read output
  as well as rc: a suite can report `skipped` rather than `passed` (the
  `version` test (`tests/unit/cli/version.test.ts`) `skipIf`s itself when
  `dist/` is absent), and an all-pass
  run can still exit non-zero (the `Errors  20 errors` case in
  `/work-issues` references/gates-and-pr.md §6).

- **`.claude/hooks/issue-dup-check-gate.sh`** blocks `gh issue create` — and
  `gh api repos/<o>/<r>/issues`, the REST mint — when the body carries no
  `Dup-check:` line recording that the OPEN issue list was searched for this
  root cause. Born from measurement (2026-08-25): 115 open, median
  time-to-close **0.17 d**, p90 0.96 d — the COUNT is what fails to converge;
  13 of 115 are umbrella-shaped, as are all four of the oldest. The unit of an
  issue had drifted from one ROOT CAUSE to one affected SITE; §5-f's "N sites
  of one root cause is ONE issue" had no duplicate check on the mid-lane
  filing path — registration is not execution; this is the execution half.
  **`gh issue edit` / `gh issue comment` are deliberately NOT gated** —
  folding into an existing issue is the outcome the gate steers toward.
  **And it is not a filing threshold** (§10-0: an unfiled finding is
  strictly worse than a filed one); what changes is WHERE a finding is
  written. Two marker spellings, split load-bearing: in a body FILE the
  marker is anchored at line start (list item allowed — a mid-sentence
  mention must not satisfy it); in the raw COMMAND the scan is unanchored
  and deliberately loose (an inline `--body` is one line). The threat model
  is FORGETTING the search, not defeating the gate. **An unreadable
  `--body-file` BLOCKS** — that fail-open shape made twelve sibling gates
  inert (#2027). Shared command-position matcher; fails CLOSED when the
  library is unloadable or predates `GATE_RE_GH_ISSUE_CREATE`. No bypass —
  the search plus one line is the entire ask.
  **Repo opt-in** (issue #1259's scoping): fires only when the resolved CWD's
  repo root carries `.markgate.yml`. The CWD decides, not `-R` — `-R` names
  where the issue LANDS, the cwd whose policy applies; §10-c's mirror flow is
  itself a documented duplicate GENERATOR, exactly the filings to check.
  **Both scans are scoped to the SEGMENT that is the `gh issue create`** —
  unscoped, `-F` (also `git commit`'s flag) read the COMMIT MESSAGE and found
  the marker there, in either order (commit messages quote the lines they
  describe — the commit introducing this gate carries `Dup-check:`). A second
  fail-open sat in the opt-in check's `cd` resolution (a bare `gh` verb ERE
  broke at the FIRST gh segment, so the prescribed
  search-then-`cd`-then-file chain never saw the `cd`); the verb ERE is now
  DERIVED from `GATE_RE_GH_ISSUE_CREATE`, which also keeps `GATE_FLAGS`'
  quoted alternative (`gh -C "/a b" issue create`, the cdk-local#542 class).
  **One cross-segment read survives, deliberately**:
  `heredoc -> file -> --body-file` is the mandated publishing shape FOR
  `gh issue create` (the preamble gate does not cover that verb), and at
  PreToolUse time the body file does not exist yet — so an UNREADABLE body
  file (and only then) falls back to scanning the whole command with the
  ANCHORED marker (heredoc bodies have real line structure). Smoke test:
  `issue-dup-check-gate.test.sh` (60 cases, bash 5.x + 3.2 — every
  `--body-file` spelling both directions, the mid-sentence marker,
  unreadable-path and unexpanded-`$VAR` blocks, the `cd` chain, ungated
  verbs, the `gh api` mint, subshell / `-R` / substitution spellings,
  fail-closed library, the heredoc window, registration, cdkd#563
  quoted-body cases, spaced/glued body-file paths, the prelude guard).
  **Every fence is mutation-probed and every number re-taken each round**,
  because the old ones were from a ~29-case run and had gone stale: on the
  60-case suite, `exit 0` stub 29, `exit 2` 34, `$GW` reverted 21,
  short-flag 1, prelude guard 0 (this gate already fails CLOSED, so the
  guard is redundant HERE — wired anyway, since that coincidence is what
  hid the original bug). Per-fence tallies live in the suite header.

- **`.claude/hooks/issue-classification-label-gate.sh`** blocks
  `gh issue create` / `gh issue edit` when the body states a `Severity:` or
  `Effort:` value the issue's LABELS do not carry. Prose is invisible to the
  queries triage actually uses — `gh issue list --label severity:high` is one
  call vs one `gh issue view` per candidate — so the two fields with a CLOSED
  token set are mirrored: `severity:high|medium|low`,
  `effort:small|medium|large`. Only those two (`Session-fit` is re-decided at
  claim time — a label silently disagreeing with the body is worse than none;
  `Estimate` is free-form). The prefixed full words are the "no bare tokens" rule as a label: the scales
  share `medium`, and `L` collides dangerously (severity *low* vs effort
  *large*). The `gh api repos/<o>/<r>/issues` REST mint is gated too.
  **`edit` is gated and `comment` is not — the opposite split from
  `issue-dup-check-gate.sh`, deliberately**: `edit` is the CLAIM site where
  `Severity` first exists for the bulk of the backlog. On `edit` the gate asks
  gh what labels the issue already carries (a re-edit of a labelled issue is
  untaxed); an unresolvable issue number or gh failure FAILS OPEN — a transient
  gh error must not stop a body edit.
  **Precedence, then the space rule.** Body text is read in descending
  specificity: a readable `--body-file` / `-F <path>`; else the WHOLE command
  when such a path was named but does not exist yet (the mandated heredoc
  shape); else an inline `--body` value; else the whole segment —
  load-bearing: with the segment concatenated in front, a
  `--title 'Severity: high pages fail'` outranked a body stating
  `Severity: low`. On the last-resort segment path the scan requires at least
  one SPACE after the key: the label spelling is `severity:high`, the body form
  `Severity: high` — without it a `--label severity:high` would satisfy its own
  requirement (a no-op gate). An old packed `Effort: ~1-3 h` matches no token,
  so no label is demanded.
  **The FOURTH site of the `GATE_PERL_WORD` root cause** (see below), found by
  the sibling note the other three carry: a quoted `--body-file` path with a
  SPACE, and the glued `-F<path>`, extracted nothing, the precedence chain
  ended at the whole SEGMENT — which carries the PATH, not the body — and NO
  label was demanded. Measured rc=0 where the plain spelling gave 2. Smoke
  test: `issue-classification-label-gate.test.sh` (46 cases, bash 5.x + 3.2).
  Re-probed on the 46-case suite: `exit 0` stub 18, `exit 2` 43, `$GW`
  reverted 38. Per-fence tallies live in the suite header.

- **`.claude/hooks/issue-deferral-criteria-gate.sh`** blocks `gh issue create`
  (and the `gh api repos/<o>/<r>/issues` mint) when the body's
  `Session-fit: next` line defers the work for a PR-SHAPED reason — `own PR`,
  `separate PR`, `shar(e|ing) a PR`, `(independent|separate) review surface`,
  `unreviewable`, `own review`, case-insensitively. **An ESCALATION, not a new
  rule**: `Session-fit` decides whether the work is finished in THIS session
  and none of its criteria is about the pull request — splitting across
  several PRs is normal and costs no session. Written down three times
  (`/work-issues` §3-b, §5-f, [session-report.md](session-report.md)) and on
  2026-09-04 an agent deferred THREE findings on that reasoning anyway
  (go-to-k/cdkd#2587 / #2588 / #2590), all later re-classified `now` and
  finished in the same session. Retro §10-b: a rule violated anyway escalates
  to a MECHANISM.
  **Not a ritual** — an earlier design asked for a "criteria audit" line,
  which boilerplate satisfies; this refuses the specific defect and leaves
  every legitimate `next` (a NEW fixture, external input, an independent
  subsystem) untouched. **Only `next` is gated**: a `now` line is never
  refused, and a body with no `Session-fit` line passes — filing hygiene
  belongs to the sibling issue gates. `gh issue edit` / `comment` are NOT
  gated: re-classification is the outcome this gate steers toward. The reason is read across WRAPPED lines (a 76-column body
  puts "needs its own PR" on the next line), bounded by a blank line, a
  heading, a list item, or the next NAMED field (`Session-fit` / `Severity` /
  `Effort` / `Estimate` / `Notes` / `Dup-check`) — mutation-probed, that
  boundary is what keeps a sibling `Notes:` line out of the reason, and the
  bullet case is what stopped a legitimate reason followed by a PR-mentioning
  bullet from folding it in. A FENCED CODE BLOCK is stripped first (``` and
  `~~~`), so a body quoting the refused line to argue ABOUT the rule is not
  blocked by its own quotation — the first `Session-fit:` match wins, and
  without the strip a quoted line beat the body's real `now`. Bold is accepted
  on the KEY and on the VALUE alike. Repo opt-in (`.markgate.yml`), shared
  command-position matcher, fails CLOSED when the library is unloadable.
  **It reads the body the command is about to WRITE**, porting
  `gh-body-english-gate`'s #2397 heredoc extraction: precedence is the heredoc
  body this command writes, then the file on disk (unless a TRUNCATING write
  superseded it — an APPEND still reads it), then the whole command, then an
  inline `--body`. Without that the one-call shape was a FAIL-OPEN whenever
  the target path already existed: the gate judged the PREVIOUS body and
  passed (measured — stale file present rc=0, file absent rc=2). Unlike
  `issue-dup-check-gate`, an UNREADABLE `--body-file` still does not block:
  this gate objects to content it FINDS, so a refusal would be unclearable.
  **What it catches** — state the PREDICATE or the number is unreproducible,
  and the `--limit 300` window MOVES (255 → 259 in one day, 66 → 65 fires in
  another). Latest reading: of 300 bodies, 259 carry an anchored
  `Session-fit: next` FIELD LINE and it fires on **65** (25%), every hit on a
  literal vocabulary term. It does NOT catch reasoning that never names a PR:
  of its own three motivating deferrals it fires on go-to-k/cdkd#2590 but not
  #2587 ("its own real-AWS run and review round") or #2588 ("its own blast
  radius across future PRs"). The needle was deliberately NOT widened to chase
  those (implement.md: three spellings in three rounds means change
  instrument) — [session-report.md](session-report.md) no longer OFFERS a
  PR-shaped `next` criterion to cite. Bypass
  `CDKD_SKIP_DEFERRAL_CRITERIA_GATE=1`, from the env or a leading assignment
  in the command text (#2368), for an INLINE quote of PR-shaped reasoning.
  Smoke test: `issue-deferral-criteria-gate.test.sh` (105 cases, bash 5.x +
  Re-probed on the 105-case suite: `exit 0` 60, `exit 2` 50, `$GW` reverted
  36, short-flag 3, prelude guard 1. Per-fence tallies (the boundary, the
  six `key_re` field names, segment scoping, the fence strip, the heredoc
  arms) live in the suite header, which is re-measured wholesale each round.
  
  `(independent|separate)` → `independent` 1. **Three silent passes closed**:
  a BOLDED `next` VALUE (the key accepted `[*_]*`, the value did not);
  `separate review surface`, which cdk-local's port already refused while cdkd
  passed it; and a reason WRAPPING onto a line that merely contains a colon
  (`entirely:` ended the continuation) — the boundary now pins the NAMED
  fields. All three are LATENT: pre-fix and post-fix fire on the IDENTICAL 65
  of the 259, 0 corpus instances of any shape. No drift. The fence STRIP
  needed a second round: latching on any opener with no look-ahead made an
  UNCLOSED fence blank the rest of the body (rc=0 where the pre-strip hook
  said 2) — the heredoc latch class one construct over; it now opens only when
  the SAME marker recurs later.

**One value class for the SIX gates that extract with perl (`GATE_PERL_WORD`,
2026-09-05).** The english / dup-check / deferral / classification /
pr-body-item-number / commit-prefix-scope gates pull a `--body-file` or `-F`
path and an inline `--body` value out of RAW command text with `perl` (a global
scan over a slurp, which `[[ =~ ]]` cannot do). All five
spelled it `(["\x27]?)([^"\x27\s]+)\1`, which ENUMERATES where a quote may sit
instead of taking one shell WORD. That lost SIX families at once, each
measured, each fail-OPEN wherever polarity allowed: a quoted path containing a
SPACE; `-f body='<text>'` (quote INSIDE the value); the glued `-F<path>` /
`-fbody=<text>`; a glued `-F<path>` on a SHORT-flag-only command, which never
even ARMED; a path followed by an unquoted `;`; and ANSI-C `$'…'`, read as
literal ASCII while bash sends the decoded bytes. The worst was the first:
english-gate rc=0 on a JAPANESE body where the plain spelling gave 2, i.e. the
English-only rule bypassable by a directory name with a space. **The
per-shape table, the measured rc for each, and the shell-word grammar live in
`lib/command-match.sh` beside the constant** — sites four and five were found
only by the sibling note the others carry, the last three only by a review
round, so the notes and the constant are the thing to keep current.

Also converted: the redirect-target matchers, which compared RAW command text
against an already-unquoted path, so a heredoc writing `> /a\ b/x.md` was
invisible and the gate read the STALE file on disk. `issue-dup-check-gate` was
ACCIDENTALLY safe (no path extracted means it BLOCKS), so its miss was a FALSE
BLOCK; fixed anyway — that safety is a polarity a later edit could reverse.

**A non-empty test is only HALF the guard.** A prelude that is present and
does NOT COMPILE is just as silent as a missing one, because every extraction
runs `perl … 2>/dev/null` — measured, one broken literal disarmed four gates at
once with zero stderr. So each gate also calls `gate_perl_word_or_die <name> ||
exit 2`: a functional probe, once, AFTER arming and at **TOP LEVEL** — the
extraction helpers run inside `$( )`, where `exit 2` ends only the substitution
subshell, so an in-function guard PRINTED its refusal and the hook still
returned 0. Fenced by `tests/unit/scripts/gate-perl-word-consumers.test.ts`,
which also pins the consumer COUNT against the library header — that sentence
said "three gates" while five files consumed the constant.

All twenty produce actionable error messages with the exact replacement
command.

## Bug-hunt cleanup safety

- **`.claude/hooks/bughunt-clean-gate.sh`** — blocks `git commit`,
  `gh pr create`, and `gh pr merge` (incl. `cd <path> &&` / `gh -C <path>`
  forms) while `/hunt-bugs` still has un-destroyed AWS resources tracked in
  the sentinel. The skill records every deployed stack via
  `.claude/skills/hunt-bugs/bughunt-track.sh add <Stack>...`; only
  `bughunt-track.sh clear` releases the gate, run ONLY after destroy +
  orphan-zero verification (`bughunt-track.sh verify`).
  **Parallel-safe per-owner sentinel (the SPOF fix)**: a directory
  `.markgate-bughunt-pending.d/` with ONE file per owner (owner key =
  `$CDKD_BUGHUNT_OWNER` if set, else the per-worktree toplevel). `add` /
  `verify` / `clear` touch ONLY the caller's own file, so one agent's `clear`
  can NEVER release another agent's pending resources (the old single-file
  `rm -f` could).
  **The block decision is verb-scoped (issue #1615)**: `gh pr create` /
  `gh pr merge` AGGREGATE across all owner files (plus the legacy flat
  `.markgate-bughunt-pending`) — merging publishes a shared artifact, so
  cross-owner contention fails toward over-block, never premature release.
  `git commit` blocks ONLY on the CALLER's own file (a commit creates no AWS
  resources, and blocking a third party hands them a remediation they must
  not follow — destroying stacks they do not own is cross-session trespass);
  other owners' pending stacks get a NON-blocking notice on stderr. The
  legacy flat sentinel has no owner attribution, so it conservatively blocks
  `git commit` for every caller; a chained `git commit && gh pr create` takes
  the stricter repo-wide path. No file locking (each owner writes only its
  own file; append is atomic — also dodges macOS's missing `flock`). The
  directory lives at the **shared main-tree root**
  (`git rev-parse --path-format=absolute --git-common-dir`), so a
  feature-worktree commit still sees a main-tree-armed sentinel; keep one
  hunt's calls in the same worktree (or set `CDKD_BUGHUNT_OWNER`). Shared
  command-position matcher; a plain sentinel-file gate, not a markgate
  marker (pending-resource state is not content-digest-based). Smoke test:
  `bughunt-clean-gate.test.sh` (23 cases, incl. the per-owner isolation
  scenario: two owners arm → pr merge blocks while a non-owner commit passes →
  A clears → pr merge STILL blocks on B → both clear → releases).

## Branch / push safety

**Repo opt-in scope (issue #1259).** The five main-tree / branch hooks here
(`branch-gate.sh`, `main-tree-branch-gate.sh`, `main-tree-edit-gate.sh`,
`main-tree-dirty-detector.sh`, `main-tree-git-cwd-detector.sh`) fire ONLY in
repos carrying `.markgate.yml` at the repo root — a cdkd session regularly
touches unrelated personal repos where committing to main is the normal
single-writer workflow (2026-07-27: `main-tree-edit-gate` blocked a
user-requested append to a personal blog draft).
`post-merge-orphan-push-gate.sh` is deliberately NOT scoped this way:
re-creating a deleted merged branch is a hazard in any repo with PRs, and it
already fails open without `gh`.

- **`.claude/hooks/branch-gate.sh`** — blocks `git commit` and `git push`
  when the **target git working tree** is on `main` / `master`, and (since
  issue [#2402](https://github.com/go-to-k/cdkd/issues/2402)) when the MAIN
  checkout is on a DETACHED HEAD; a detached LINKED worktree still passes
  (the lane-clearing state `stop-unmerged-lane-warn.sh` prescribes). **The
  full entry is in [hooks-branch-gate.md](hooks-branch-gate.md)** (moved
  2026-09-03: this file is loaded WHOLE on every `.claude/hooks/**` touch and
  was at its byte cap; that entry is only wanted when the gate itself is
  under the knife).

- **`.claude/hooks/main-tree-branch-gate.sh`** — blocks branch-switching
  commands in the MAIN worktree so concurrent agents do not race on the
  shared checkout slot; inside any `.claude/worktrees/<x>/` subtree
  everything passes. **The full entry — allowed/blocked spellings, the
  measured before/after tables, the retired `git checkout <sha>` rationale —
  is in [hooks-main-tree-branch.md](hooks-main-tree-branch.md)** (moved
  2026-09-01, same byte-cap reason).

- **`.claude/hooks/post-merge-orphan-push-gate.sh`** — blocks
  `git push <remote> <branch>` (incl. `-u` / `--set-upstream` /
  `git -C <path> push`) when `<remote>` is `origin` AND
  `gh pr list --head <branch> --state merged` returns a matching
  `headRefName`. Closes the PR #263 incident: merge → GitHub's
  `delete_branch_on_merge` removes the branch → a near-simultaneous
  `git push` SUCCEEDS by re-creating it as an orphan ref no PR tracks, so
  the commits silently never reach main. Cwd-aware; branch parsed from the
  command line or derived from `symbolic-ref --short HEAD` against the
  resolved target. Scope guards: ONLY the MERGED state (closed-not-merged
  passes — the branch may be revived), ONLY `origin`, ONLY `git push`. Fails
  open when `gh` is missing or unauthenticated (stderr note). **It took the
  LEFTMOST ` push` in the whole command until 2026-08-31** — a greedy
  `(.*)$` made the first occurrence win; measured, a quoted MENTION steered
  the branch to `feat/x"` and a two-push chain was judged on the first. It
  now parses each push from the SEGMENT that matched and judges EVERY push.
  Smoke test: `post-merge-orphan-push-gate.test.sh` (26 cases via `$GH_BIN`
  mock, six through a HEAD-AWARE mock recording which branch was asked about —
  an exit code alone cannot say which push was judged; three fail against the
  pre-fix hook). The block names the merged PR and prints the "replay on a
  fresh branch" recipe.

- **`.claude/hooks/main-tree-edit-gate.sh`** — blocks *mutating a
  git-tracked file* in a worktree currently on `main` / `master` (matcher
  `Edit|Write|Bash`) — the gap `branch-gate.sh` (commit/push only) and
  `main-tree-branch-gate.sh` (switch/checkout only) both leave open. The
  2026-06-21 incident: a `/run-integ` campaign rewrote the committed ledger
  `docs/_generated/integ-last-run.tsv` in the main tree on `main`, blocking
  the user's `git pull --ff-only`. Fires only when the target's branch is
  `main`/`master` AND the file is tracked (or is a NEW file under `src/` /
  `tests/` / `docs/` / `scripts/` / `.claude/`, excluding
  `.claude/worktrees/*`). Edit/Write read `tool_input.file_path`; Bash
  best-effort-scans for LITERAL write targets (`> f`, `>> f`, `tee [-a] f`,
  `sed -i ... f`). **Known gap**: variable-indirected Bash targets
  (`mv "$tmp" "$LEDGER"`) cannot be resolved statically — the worktree-first
  process is the real guard; this arm is defense-in-depth. Feature worktrees
  always pass. macOS-safe (`cd && pwd -P`). Smoke test:
  `main-tree-edit-gate.test.sh` (10 cases, incl. 2 non-opted-in passes). The
  block names file + worktree + branch and prints the `git worktree add`
  recipe (incl. the /run-integ ledger note). See memory
  `feedback_main_tree_tracked_edit_gate.md`.

- **`.claude/hooks/main-tree-dirty-detector.sh`** — PostToolUse (`Bash`),
  REACTIVE, **non-blocking** backstop for exactly the variable-indirected gap
  above: after a command, when the MAIN worktree is on `main`/`master` and
  now has dirty TRACKED files (`git status --porcelain` minus `??`), it emits
  a loud `additionalContext` warning naming the files + the worktree recipe.
  Noise control: runs the git check only when the command contains a
  write-ish token (`>` / `>>` / `tee` / `mv` / `cp` / `sed -i` / `dd` /
  `truncate`); always exit 0 (PostToolUse cannot block). Smoke test:
  `main-tree-dirty-detector.test.sh` (8 cases, incl. 1 non-opted-in quiet
  case).

- **`.claude/hooks/main-tree-git-cwd-detector.sh`** — PostToolUse (`Bash`)
  REACTIVE backstop for the cwd-RACE class: a command whose verdict is taken
  as evidence running in the MAIN tree while feature worktrees are active.
  Full entry (three command families, the #2094 `vp run build` exemption,
  the unresolvable-`cd` silence, suite notes) in
  [hooks-cwd-detector.md](hooks-cwd-detector.md).

## CI-green merge gate (live-query, not markgate)

**`ci-green-gate.sh` blocks `gh pr merge` unless EVERY GitHub Actions check on
the target PR reports `pass` or `skipping`** — `fail`, `pending`, or "no checks
reported" exits 2 with the failing check names. Born from PR #1231
(2026-07-27): the merge was chained after a `gh pr checks` DISPLAY, the
printed `check-build-test fail` scrolled past, main went red until fix-forward
#1232. CI status is LIVE external state, so this is a stateless live-query
hook like `pr-review-gate.sh`. Same cwd-aware resolution + PR-number token
walk as `pr-review-gate.sh`. `gh` transport errors fail OPEN (a GitHub outage
must not block merges); a parsable checks answer is enforced strictly. `CDKD_SKIP_CI_GREEN_GATE=1` is the documented bypass for a repo with no CI —
never for merging a red PR. Smoke test:
`ci-green-gate.test.sh` (stubbed `gh` for all-pass / skipping / fail /
pending / no-checks / infra-error + the cdkd#563 quoted-body cases).

## Integ base freshness (non-blocking)

**`.claude/hooks/integ-stale-base-detector.sh`** — PreToolUse (`Bash`),
**never blocks**. Warns, before a real-AWS integ fixture is spent, that the
branch is behind `origin/main`, because a rebase after the run moves the merge
base and can stale the very marker the run was spent to earn.

An ESCALATION, not a new rule: verify.md §8-b already says "Rebase BEFORE the
integ", and go-to-k/cdkd#2589 followed it and still paid twice — six review
rounds ran over ~2 h, `main` advanced, and the rebase moved the merge base past
go-to-k/cdkd#2565 (`src/provisioning/providers/**`), flipping `integ-destroy`
to `mismatch` after two integs had run. The re-run was CORRECT; nothing said so
when the run STARTED. The rule reads as a sequence; the shape is a loop.

**Placement is the design**: beside `markgate set` the run is already spent, so
this fires on the fixture INVOCATION — the last moment a rebase is free.
**Non-blocking on purpose**, unlike `integ-destroy-gate.sh`: a deliberate run
on an old base (a bisect, a repro) is legitimate and a wrong refusal costs more
than the waste. It guards a SPEND, not a merge.

Two arms with opposite advice: when main's advance touches integ-gate scope it
names the FILE count and says rebase first, else it says the marker will
probably survive. It counts FILES and SAYS files — an earlier revision printed
"N of those COMMITS", so one commit touching five provider files read as "5 of
those commits" under "1 commit(s) behind". It scopes with `HEAD...origin/main`
(three dots — the question is what MAIN brought), and does NOT `git fetch`, so
it under-reports on a stale ref — the safe direction for a nudge.

**It arms on BOTH invocation shapes** — `verify.sh` AND the standard
`node dist/cli.js deploy` flow. Requiring a `verify.sh` left it silent for
`bench-cdk-sample` / `microservices` / `multi-resource` / `multi-stack-deps`,
the four broad-set fixtures that have none — exactly the runs that refresh
`integ-broad`. **BOTH halves of the decision are PER SEGMENT** (`gate_segments`,
2026-09-05): arming and read-verb suppression used to scan the WHOLE command,
so one read verb anywhere `exit 0`ed the lot and `git status && bash
.../verify.sh`, `echo start && …`, `cat README.md && …` and `ls && node
…/cli.js deploy` were all SILENT — every one a shape a real run writes, and a
warn hook quiet on those is indistinguishable from a working one. A read verb
now suppresses only its own segment. Two nits fixed with it: the `&&` branch of
`(^|[|;&]|&&)` was DEAD (`[|;&]` matches the second `&` first), and `(bash|sh)`
was unanchored so `finish verify.sh` armed. A path inside an arbitrary quoted
string is a documented false positive costing a stray note, not a block. Repo
opt-in; an unloadable library exits 0 here rather than 2, since this hook
refuses nothing; declared unexercisable in `unresolved-target-class.test.sh`.

Smoke test: `integ-stale-base-detector.test.sh` (22 cases, real git fixtures,
honouring `HOOK_BASH` so the HOOK runs under 3.2 — it ignored it at first, and
`HOOK_BASH=/nonexistent` still reported 11/11). Probed, all re-taken
2026-09-05 with BOTH halves of each tally: silent stub 9 pass / 10 fail,
alarming-arm-only 8 / 11, both-arms 10 / 9; 3-dot-to-2-dot fails exactly the
lane-carries-its-own-commit case, which the suite could not see until that
fixture existed (it survived at 11/11 before); read-verb test deleted fails
exactly the 4 silence cases; read-verb test back to PER-COMMAND fails exactly
the 4 earlier-segment cases; `(bash|sh)` unanchored fails exactly 1.

## Markgate gate hooks (cwd-aware)

The seven markgate-backed gates (`check-gate.sh`, `verify-pr-gate.sh`,
`integ-destroy-gate.sh`, `integ-broad-gate.sh`, `integ-local-gate.sh`,
`integ-schema-migration-gate.sh`, `pr-review-gate.sh`) are **cwd-aware**
post-#559: each reads the payload's `cwd`, parses leading `cd <path>` and the
last `git -C` / `gh -C` flag, and `cd`s to the resolved target before
`markgate verify` — restoring per-worktree marker isolation (pre-#559 every
gate landed in the main tree, the root cause in
`feedback_cross_agent_main_tree_contention.md`).

**A hand-typed `markgate` is not the one the hooks run.** `.mise.toml` pins
0.4.1 and every gate resolves it through mise, but a Homebrew `markgate` 0.2.0
earlier on `PATH` wins for a bare invocation and cannot parse this repo's
`hash: diff` gates: `markgate verify check` exits 2 with
`unknown hash "diff"` against a perfectly fresh marker (measured 2026-09-04).
That is a false BLOCK, and it reads as a stale marker. Spell any hand check
`mise exec -- markgate ...`.

**An unreadable target directory is a REFUSAL in every blocking gate** (issue
[#2027](https://github.com/go-to-k/cdkd/issues/2027)). A hook receives command
TEXT, not the shell's expansion, so `git -C "$W" add -A && git -C "$W" commit
-F <file>` arrives with `$W` UNEXPANDED — the gates were weakest on precisely
the spelling this repo's own instructions prescribe. Measured on
`check-gate.sh`: that payload exited 0, the literal-path twin 2. (The issue's
leading theory was wrong: `mise exec` on an untrusted `.mise.toml` exits
**1**, not 0 — the untrusted worktree was never the fail-open.)

**One root cause, 24 sites, three flavours** (measured across all 38 hooks,
each a literal-path control that blocks paired with the respelled twin; the
per-gate roll-call is in the #2027 issue thread, all fixed):

- **Silent bail — 12 blocking gates**: a hand-rolled `-C <path>` scan with no
  `$`/backtick guard turned `"$W"` into a literal path, the gate's own
  `rev-parse` probe failed, exit 0 over a tree it never looked at.
- **Silent wrong-tree judgement — 11 gates** via the library's
  `gate_target_dir`, which DROPS an unreadable token and falls back to the
  payload cwd (its comment claimed "fails CLOSED"; measured not:
  `provider-docs-gate` exits 2 for `git -C <abs> commit`, **0** for
  `git -C "$W" commit` with the violation staged in the target).
- **No target reading at all — `bughunt-clean-gate`** (resolved only a `cd`,
  never `-C`).
- **Non-blocking, deliberately left falling back — `restore-backup`**: it
  refuses nothing, and a snapshot silently NOT TAKEN is worse than a
  wrong-tree one.
- **Correctly out of scope**: `worktree-owner-gate` (already-expanded
  `file_path`), `post-merge-sync-reminder` (no directory),
  `gh-body-english-gate` (ignores `-C` for `--body-file` resolution — RIGHT:
  `-C` changes gh's repo, not the shell's cwd), the two PostToolUse detectors
  (silent pass on unresolvable target is documented intent).

**A WIDER hole sat on top: the verb regexes were hand-copied too**, with no
quoted flag-value alternative — `git -C "/path/my worktree" commit`,
`git -C "$(git rev-parse --show-toplevel)" commit` and ``git -C `pwd` commit``
matched NO VERB in any gate, exit 0: a fully determinate commit on `main` with
zero markers. `lib/command-match.sh` had recorded that shape as fixed once
before (go-to-k/cdk-local#542); the per-gate copies reintroduced it. Every
gate now takes its verb from the library constants, and the loader guards
refuse when `gate_matches` is undefined — a missing library returns 127, which
`if !` reads as "no match". Three more space-path instances only the class
fence found: `git worktree list --porcelain | awk '{print $2}'` truncates such
a path (3 hooks), `main-tree-branch-gate`'s token walker read `dir` as the
subcommand, and `dirty-path-restore-gate` / `non-english-text-gate` carried
their own quoted-alternative-less `-C` patterns.

**The fix is one shared resolver, not 24 conditionals**:
`gate_target_dir_strict` (returns 2 instead of guessing when the target
carries a `$` or backtick) + `gate_refuse_unresolved_target`. Four shapes
must NOT be refused, each found by a red test: an **absolute** `-C` moots an
earlier unreadable `cd`; an **absolute `cd`** likewise; a `cd` **after** the
verb never steered the command (the standing `git commit … && cd <repo> &&
git pull`); a literal `~` is expanded — only when LEADING (no shell expands
`/tmp/~/x`). The `-C` scan is ANCHORED to the segment's leading flags, so
argument prose is not read as a target (before that, `git commit -m "repro:
git -C $W commit failed"` was refused with a remedy that could not clear it).
**The segmenter DUAL-EMITS**: splitting at `$(` / backtick truncated the
ENCLOSING command (`git -C $(git rev-parse --show-toplevel) commit` became
`git -C `, no verb, exit 0); now the span stays inline (neutralised, wrapped
as one quoted token) while the body is queued for its own pass, so
`out=$(git commit)` still fires. **The opt-in bound is answered from the
hook's OWN checkout** (`${BASH_SOURCE[0]}`, cwd fallback for a vendored
copy) rather than the payload cwd — which consulted the cwd precisely when
the target was unknown. This does not reintroduce
[#559](https://github.com/go-to-k/cdkd/issues/559): the marker STORE is
still resolved from the payload cwd, and each worktree carries its own
`.claude/hooks` and `.markgate.yml` (verified).

**`check-gate.sh` fails closed on three MORE conditions**: a target that
resolves but is not a git repo or cannot be entered; a markgate failing a
`--version` probe; and `markgate verify` exiting **>= 2** — its "could not
read the config" code, distinct from 1 = stale (verified on markgate 0.2.0 and
0.4.1: stale marker, absent gate and empty config are all 1; only malformed
YAML is 2). The `--version` probe makes #2027's environment legible: in a
fresh untrusted worktree `mise exec` exits 1 and the old hook said
`run /check first` — a remedy through the same untrusted mise. The message
names a VERIFICATION command rather than `mise trust` alone, because
`mise trust` as an agent Bash call can abort inside this environment's
shell-snapshot wrapper. The permissions branch has **no test case**: the state
is not constructible without root, and a fabricated case would fence nothing.

`main-tree-git-cwd-detector` carried the same hand-rolled scan and it was
**unreachable** (its `GIT_VERB` requires every token between `git` and the
verb to start with `-`; the `-C` VALUE broke the match). The dead branch was
removed, no behaviour change; the SEPARATE gap (no warning on
`git -C <main-tree> commit`) remains a different change.

**Fenced at the CLASS level, not per hook** — see
[hooks-class-fences.md](hooks-class-fences.md) for the three fences, their
populations and their floors.

**"Scope" is TWO lists per gate, and they can disagree silently** (issue
[#2042](https://github.com/go-to-k/cdkd/issues/2042)): `.markgate.yml`'s
`include` decides what makes the MARKER stale; the hook's activation patterns
decide whether `gh pr merge` consults it at all. Include-only = an
invalidated marker no hook reads; hook-only = **FAIL-OPEN** (gate activates,
the digest never saw the file, `markgate verify` returns 0, the merge
proceeds unverified) — the dangerous direction, indistinguishable from a
working gate. `destroy-runner.ts` / `region-check.ts` sat in that state, and
the retry pair plus `rollback-executor.ts` were in neither list, until
#2042's audit. Both directions fenced by
`tests/unit/scripts/cross-cutting-list-sync.test.ts`; per-gate file lists
live in CLAUDE.md's `integ-destroy` / `integ-broad` entries.

**PR-diff scope guards (integ-destroy / integ-broad / integ-local).** The
three integ gates first check whether the merged PR's diff touches their
scope (via `gh pr view <N> --json files`) before consulting the marker —
`integ-destroy-gate` against its delete-logic patterns, `integ-broad-gate`
against `CROSS_CUTTING_REGEX`, `integ-local-gate` against
`^src/local/|^src/cli/commands/local-*\.ts$|^tests/integration/local-`. A PR
touching none of a gate's scope passes even with a stale marker — the integ
markers carry a 14d TTL, so without the guard an expired marker would block
EVERY merge. The three are scoped by different mechanisms: `integ-destroy` by
this branch's delta against `origin/main` (markgate 0.4 `hash: diff`);
`integ-local` by its file-scope content; `integ-broad` by a sentinel file a
pull cannot touch. `integ-local-gate` — the only gate also firing on
`git merge` — additionally scope-checks `git merge [flags] <ref>` (issue
#1204) via `git diff --name-only HEAD...<ref>`, so the routine post-squash
`git merge --ff-only origin/main` passes even with a stale marker; the
merge-ref parse is a token walk and bails to the unconditional verify on
`--abort` / `--continue` / `--quit`, octopus (2+ refs), or an unresolvable
ref. Number-less `gh pr merge` falls through to the unconditional verify.

**Convention shift (post-#559)**: run `markgate set <gate>` from the same
worktree (cwd) where the gated command will be invoked — each worktree has its
own markgate state dir (`<worktree>/.git/worktrees/<name>/markgate/`; main tree
`<main>/.git/markgate/`), so parallel agents no longer collide. Main-tree-only
workflows behave as before; the old "set marker from main tree, merge from
anywhere" pattern no longer works.

Smoke tests at `.claude/hooks/<gate>.test.sh` cover cwd-aware resolution
against fixture worktrees (markgate mocked via a PATH shim with a
`$CWD_TRACE_FILE` asserting the hook cd'd to the correct target). **Every
gate test file carries 2 quoted-body false-positive cases per cdkd#563**
(`gh issue create --body "...<trigger>..."` / `echo "..."` shapes) — proof
the matcher does not fire on a trigger inside an argument body.

**The `if:` layer is GONE (issue #1455, reopened): project-settings hooks
carrying `if:` never fired at all.** The #1476 verification measured that
EVERY Bash-entry hook with an `if:` was never invoked — `git commit` /
`gh pr merge` ran with no gate consulted — while no-`if:` entries in the SAME
file fired normally, and the same `if:` strings DID work via the
`settings.local.json` hot-reload path (the poisoning variable was never
pinned). `if:` was removed from all 29 hooks in the Bash entry; the in-script
matcher is the SOLE filter. **Do NOT reintroduce `if:` without the
restart-verified protocol**: change the setting → FRESH session → run the
#1476 probe shapes → only then trust it. A hot-reload measurement does NOT
transfer to project settings.

Historical probe (hot-reload path, gitignored `settings.local.json`): on
`true && echo "... gh pr merge 999 ..."`, `Bash(*gh pr merge*)` FIRED and
`Bash(gh pr merge*)` did not. `if:` matching was purely TEXTUAL and
quote-blind — a contains pattern fired inside a quoted `echo` string; that is
why the in-script matcher became the precision filter it now is alone.

**Command-position matching (issue #1455 — supersedes the line-start
anchoring).** The old line-start anchor (tolerating one leading
`cd <path> &&`) dodged the quoted false positive by POSITION at the cost of a
false NEGATIVE of the same shape: any command in front (`echo done; gh pr
merge`) and the gate never fired — PR #1451's own `gh pr create` slipped past
`verify-pr-gate` exactly that way, and the same hole sat in all six
merge-time gates. The fix:
`cmd_matches_verb <command> <verb-ere>` in `.claude/hooks/lib/command-match.sh`
(1) NEUTRALISES the spans that are DATA — heredoc bodies, then quoted spans —
then (2) matches the verb in COMMAND POSITION (line start or immediately
after a `&&` / `||` / `;` / `|` control operator). `<(…)` / `>(…)` process
substitution is a segment opener too, so a verb inside one arms the gates.

- **A neutralised quoted span leaves a PLACEHOLDER, not a deletion** — the
  verb EREs carry value sub-patterns, so deleting a quoted value made
  `gh -C "$WT" pr merge` (the documented worktree shape) fail to match in
  **nine** gates (the round-2 blocker).
- **Failure direction is the whole design**: dropping too much makes a gate
  SILENTLY NOT FIRE; dropping too little is a loud, fixable false positive.
  Review rounds caught the dangerous direction repeatedly: `<<<` here-strings
  and a quoted `<<EOF` mention treated as real openers with no terminator
  check (state latched, every remaining line dropped, all six merge-time gates
  off); per-line quote stripping turning a multi-line quoted argument into a
  NEW hard block; deleted-not-placeheld spans; an escaped `\"` desyncing the
  quote state machine. So the implementation rejects `<<<`, ignores `<<X`
  inside a quoted span, strips a heredoc only when its terminator is actually
  found, honours backslash escapes, and runs a whole-text quote state machine.
  Heredocs are removed BEFORE quotes — a heredoc body is prose and routinely
  holds an unbalanced apostrophe.
- The quote pass emits kept stretches as runs (char-at-a-time was quadratic:
  ~3s on a 200 KB command, twice per gate; now 28ms at 2 KB, ~2s at 200 KB).
  And it captures the stripped text before grepping rather than piping into
  `grep -q` — under `set -o pipefail` a large command surfaces `grep -q`'s
  early exit as SIGPIPE (141), read as "no match", another silent miss.
- **Heredoc bodies are stripped too — required, not a refinement**: the commit
  introducing the helper was itself blocked by `integ-broad-gate` because its
  `git commit -F -` body quoted a chained merge command. The stripper keeps
  the OPENING line and drops through the terminator, handling `<<-` and
  quoted / unquoted delimiters.
- The `cd <path> &&` special case disappears — it is just a verb after `&&`.

**Two gaps in the old anchor — issue
[#2093](https://github.com/go-to-k/cdkd/issues/2093), CLOSED by the #2129
convergence.** The anchor `(^|[|;&][[:space:]]*)` lacked `(`, so a verb in
**subshell** or **command-substitution** position never armed any gate; and an
**unbalanced apostrophe** (`echo don't; git commit -m y`) swallowed the rest
of the command. Severity was NOT uniform: a missed warning in the two
detectors, a **gate bypass** in the eleven blocking gates — `(git commit -m
x)` committed ungated. Deliberately not fixed in the measuring PR (adding `(`
strictly widens every sourcing hook); #2129 paid the named price — every suite
re-run under bash 5.x AND 3.2, plus a never-match mutant over all 32
suite-carrying gates (zero survivors).

**The mechanism that replaced the anchor.** A Bash tool call is a COMMAND
LIST, so it is SEGMENTED — on `&&`, `||`, `;`, `|`, a bare `&`, a newline, a
subshell or brace group, and a `$(...)` or backtick substitution (a backtick
in a DOUBLE-quoted span runs and was unsegmented until go-to-k/cdkd#2339; in
SINGLE quotes it does not run, unsegmented by design) — with the verb
anchored at the START of a segment. Leading `VAR=value` assignments and
`env` / `command` / `nohup` / `time` / `timeout` / `exec` / `then` / `do`
wrappers are stripped first, and `bash -c "<cmd>"` is unwrapped. Separator
characters inside quoted spans are NEUTRALISED and swapped back rather than
the span being blanked, so segments carry their ORIGINAL text and
`cd "<worktree>" && git commit` / `git -C "/a b" commit` keep their paths
(blanking was tried in the siblings and erased exactly those — target-dir
resolution fell back to the payload cwd, fail-open). Measured on
`branch-gate.sh` against a checkout on `main`, every one of these went
rc 0 -> 2: `(git commit -m x)`, `true && (git commit -m x)`,
`out=$(git commit -m x)`, the backtick form, `echo don't; git commit -m y`,
`bash -c "git commit -m x"`, `GIT_EDITOR=true git commit -m x`, and the
`env` / `command` / `nohup` wrappers.

Two load-bearing properties: a heredoc opener counts only when its delimiter
actually appears later (look-ahead) — latching onto any `<<WORD` blanks every
remaining line, fail open; and an UNTERMINATED quote makes the segmenter
re-run treating that character as literal (what turns `echo don't; git commit
-m y` from silence into a block). Segments are emitted through an `if`, never
`[ -n … ] && printf` — under a caller's `set -e` the trailing false test
aborts the function and drops every remaining segment.

The shared matcher has its own suite at
`.claude/hooks/lib/command-match.test.sh` (its own `CASE_FLOOR` is the count;
the number was carried here stale through three changes and is no longer
restated). **Every gate that sources the helper fails
CLOSED when it cannot load** (`exit 2`, with a `declare -F gate_matches`
check for a truncated file — the liveness check covers all three exported
functions); the three non-blocking detectors skip instead (a missed backup /
reminder / warning is a smaller harm than refusing an operation they only
observe). The path is derived with pure-bash `${BASH_SOURCE[0]%/*}` rather
than `dirname` (no PATH lookup), `.` fallback for the no-slash case. Count
the sharing hooks with
`grep -l 'lib/command-match.sh' .claude/hooks/*.sh | grep -v test | wc -l`
rather than trusting a number here. Two smoke cases that
previously asserted the chained shape was an "accepted false-negative"
(`branch-gate.test.sh`, `pr-review-gate.test.sh`) now assert it is CAUGHT.

**`cmd_last_cd_target` resolves the target worktree the same way.** It
follows every `cd` in command position **that precedes the verb**, against a
caller-passed base dir, so chained relative cds compose
(`cd /abs/one && cd sub` → `/abs/one/sub`). Stopping at the verb is
load-bearing: following trailing cds let one hijack the lookup —
`gh pr merge <N> --squash --delete-branch && cd <repo> && git pull`, the
standing post-merge step, silently redirected all seven markgate gates to the
main tree's store. A `cd` whose path is entirely quoted resolves to NOTHING
and the caller falls back to the payload cwd — recovering it from the raw
command was tried and removed (pairing quoted mentions by order resolved the
WRONG directory).

One consequence of neutralising: a pattern needing a quoted VALUE must read
the raw command after the verb is confirmed in command position —
`pr-title-prefix-scope-gate` does exactly that for the `gh api …/pulls/<N>`
endpoint (matching `pulls/[0-9]+` against neutralised text found only a
placeholder, letting a mislabelled `fix:` title edit through — the PR #562
incident).

See `feedback_cross_agent_main_tree_contention.md` for the motivating session
history; cdkd#562 for the original anchoring fix; cdkd#1455 for its
replacement.

## Working on a sibling repo from a cdkd session (issue 1961)

The hooks a session runs come from ONE repo's `.claude/settings.json` —
whichever repo the session started in — and fire on **every** Bash call,
including commands targeting another repository. Post-#559 the marker lookup
is target-correct while the POLICY stays session-correct; the two disagree
exactly where the gate scripts have diverged (cdkd 41 hook scripts, cdk-local
19, cdk-real-drift 11).

**A cdkd session working in cdk-local or cdk-real-drift gets cdkd's policy
applied to it — expected, not a bug in the target** (cdk-real-drift's
`verify-pr-gate` exempts a no-`src/**` PR; cdkd's blocks unconditionally).
**When it happens: complete the TARGET repo's own checklist and set its
markers legitimately, then retry. Never route around the block, and do not
"fix" the target repo to match cdkd.**

**Do not port cdkd's stricter gates down to a sibling, or a sibling's
exemptions up into cdkd.** The obvious convergence — give cdkd the
docs/tooling exemption — is demonstrably wrong: a `.claude/hooks/**`-only PR
touches no `src/**`, so that exemption would have waived `/verify-pr` for the
change that introduced a remote-code-execution path. cdkd's agent-instruction
files are load-bearing in a way a sibling's are not — which is why
`CLAUDE.md`, `.claude/rules/**`, `.claude/skills/**` (all skills since issue
#2364), `.claude/hooks/**` and `docs/**` (both since issue #2381) sit inside
cdkd's gate scopes at all.

**Delegation was tried and abandoned (PR 1970).** Each gate handing its
decision to `<target-repo>/.claude/hooks/<same-name>` works — and introduces
arbitrary code execution: the target directory is named by the command itself
(a `cd`, a `-C` flag, the payload `cwd`), so any directory the agent can be
induced to touch that carries an executable at that path gets it run with the
session's environment. Reproduced with a planted hook and a plain
`git checkout`, which read `AWS_*` / `GH_TOKEN`-shaped variables. Not
patchable from inside the design — every trust signal from the target repo is
forgeable; trust would need a maintainer-maintained allow-list. Read the
closed PR before proposing delegation again; it records two more defects (an
exit status of 128+N from a signal-killed hook propagates as a non-blocking
error and turns a block into a pass; `git -C ""` silently resolves the hook
process's own cwd).

The cross-repo gate-aliasing design — why a sibling took a refusal it could
never clear, why the mapping is a declared per-repo table rather than
discovery, and how `gate_resolve_marker_gate` chooses between the canonical
gate, an alias and a refusal — is in
[gate-sibling-repos.md](gate-sibling-repos.md), which loads when you touch
any of the four `integ-*` gate scripts or their suites.

## Class fences

Two suites whose subject is EVERY hook at once — the
unresolved-target-directory sweep (issue 2027) and the gate-name fence
(issue 2198) — live in [hooks-class-fences.md](hooks-class-fences.md), loaded
when you touch one of them or the shared matcher.

## Stop hooks

`stop-warn.sh` (uncommitted work) and `stop-unmerged-lane-warn.sh` (committed
but unmerged) fire on `Stop` rather than on a tool call. The output-channel
table, the shared nudge-cadence rule and the per-hook entries are in
[hooks-stop.md](hooks-stop.md), which loads when you touch either hook or its
suite.

## Uncommitted-work safety (multi-session)

Two hooks added after the 2026-08-09 two-sessions-one-worktree incident: the
second session found ~228 lines of uncommitted changes it had not written and
ran `git checkout --` on them — the first session's finished, tested provider
fix plus its regression tests. `git checkout --` writes no reflog entry and
creates no stash, so nothing in git held a copy. The two hooks address two
INDEPENDENT layers; either alone would have prevented the loss.

- **`.claude/hooks/dirty-path-restore-gate.sh`** — PreToolUse (`Bash`),
  **blocking**, wired immediately BEFORE `restore-backup.sh`. Refuses
  `git checkout -- <path>` / `git restore <path>` when a NAMED path
  currently has uncommitted changes — `restore-backup.sh` makes the
  operation RECOVERABLE, this one makes it DELIBERATE. Born from PR #1700
  (2026-08-12): undoing a mutation probe with `git checkout -- <file>` also
  discarded ~200 lines of finished, unrelated review fixes in
  the same file — intent and effect are indistinguishable in the command,
  and the effect is silent. Scope deliberately narrow: ONLY path-scoped
  restores (a branch switch / `-b` never matches — no `--`), ONLY when a
  named path is actually dirty, and `git restore --staged` passes (index
  only). `git reset --hard` / `git clean -f` / `git stash` are NOT gated here
  — their blast radius is evident and `restore-backup.sh` snapshots them; this
  gate targets the one spelling whose blast radius is wider than it looks. The
  refusal names the offending paths, the scratch-copy alternative, and the
  `wipe-backups` recovery command.
  **Bypass `CDKD_ALLOW_DIRTY_RESTORE=1`, honored from BOTH channels since
  issue #2368**: the hook's process env AND a leading assignment in the
  command text — an agent's Bash call can only deliver it as TEXT, since a
  PreToolUse hook is spawned with the session env and a `VAR=1` prefix never
  reaches its process; pre-#2368 the advertised remediation silently failed
  and the suite CERTIFIED the failure. The text channel goes through
  `strip_noncommand_spans` + command position (a quoted mention does not
  bypass), the value must be exactly `1`, and `restore-backup.sh` still
  snapshots under either channel. Cwd-aware — the first draft's pre-filter
  matched the literal `git checkout`, silently skipping every
  `git -C <path> checkout`. Smoke test:
  `dirty-path-restore-gate.test.sh` (64 cases against real throwaway
  repos — no git mocking; the two text-channel cases fail against the
  pre-#2368 hook).

- **`.claude/hooks/restore-backup.sh`** — PreToolUse (`Bash`),
  **non-blocking**. Before `git checkout -- <path>` / `git checkout .`,
  `git restore`, `git reset --hard`, `git clean -f*`, or `git stash`,
  snapshots the working tree into
  `<resolved git dir>/wipe-backups/<UTC ts>-<verb>/` (`tracked.patch` from
  `git diff HEAD --binary`, `COMMAND`, plus `untracked.tar` for `clean`,
  whose targets a diff cannot capture). Always exits 0 and never prompts;
  skips entirely when `git status --porcelain` is empty. Cwd-aware; snapshots
  land in the **per-worktree** git dir (`.git/worktrees/<name>/`), matching
  markgate's marker store. Deliberately does NOT match `git checkout <branch>`
  / `-b` (a branch switch is not a restore — `main-tree-branch-gate.sh`'s
  territory). **Recovery**:
  `git apply --include=<path> <snap>/tracked.patch` for one file, or
  `git apply --3way <snap>/tracked.patch` for the tree — the plain
  `git apply` form fails with "patch does not apply" once any other change in
  the whole-tree patch is still present, so the hook prints the two forms
  that were verified against a real wipe-and-recover replay. Smoke test:
  `restore-backup.test.sh` (14 cases against a real throwaway repo, incl. the
  end-to-end wipe-then-recover proof and the cdkd#563 quoted-body cases).

- **`.claude/hooks/worktree-owner-gate.sh`** — PreToolUse
  (`Edit|Write|NotebookEdit`), **blocking**. Each LINKED worktree gets one
  owning session: the first file write claims it by recording
  `<session_id> <UTC time>` in `<worktree git dir>/session-owner`; a write
  from a different `session_id` exits 2 naming the owner, the worktree, and
  the release command. Scope: only linked worktrees (the main tree is
  `main-tree-edit-gate.sh`'s); only file-writing tools (Bash write targets
  cannot be resolved statically, and read-only Bash must never block); repo
  opt-in via `.markgate.yml` at the TARGET's own toplevel. Fails OPEN on
  anything unresolvable (no `session_id`, path outside a repo, unreadable) —
  it catches an honest mistake, not a security boundary. An owner idle
  longer than `CDKD_WORKTREE_OWNER_TTL_HOURS` (default 12) is taken over
  silently. `CDKD_SKIP_WORKTREE_OWNER_GATE=1` is the deliberate hand-off
  bypass. Smoke test: `worktree-owner-gate.test.sh` (24 cases).

  **The sentinel is itself gated (2026-08-10).** `session-owner` lives INSIDE
  the git dir, which has no work tree, so `git rev-parse --show-toplevel`
  failed on it, the opt-in check fell through, and a Write targeting the
  sentinel passed unguarded — taking another session's worktree was a single
  `Write`. That is exactly how it went wrong: a session judged from a recent
  claim plus a stale-looking diff that the owner had been `/clear`-ed,
  overwrote the file, and drove a lane a LIVE agent was working. The fix
  recovers the worktree root from `<git dir>/gitdir` so the opt-in consults
  the WORKTREE's own `.markgate.yml`; the ordinary ownership branch then
  applies to the sentinel like any other file. The refusal states that
  writing the file IS taking the worktree, that a claim younger than the TTL
  means the owner is **presumed LIVE**, that a live session and a dead one
  produce identical evidence (a recent claim, an unfamiliar diff, a `/clear`
  you did not observe), and that the operator must ASK THE MAINTAINER before
  handing off — especially when `git -C <worktree> status --short` is
  non-empty. **Never infer that an owning session is dead** (memory rule
  `feedback_never_infer_dead_worktree_owner.md`).
