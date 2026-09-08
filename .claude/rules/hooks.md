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

- **Every hook but `post-merge-sync-reminder` ships a `*.test.sh` suite**
  (`run-tests.sh` is the runner; `stop-warn` got one via issue #2396), plus
  two CLASS fences with no same-named `.sh` — `markgate-gate-name-class` and
  `unresolved-target-class`. The counts that used to sit here went stale
  twice and are gone: `ls .claude/hooks/*.sh | grep -v '\.test\.sh$' | wc -l`.
- **The runner executes every suite under BOTH bashes** — PATH `bash`
  (Homebrew 5.x) and `/bin/bash` (macOS system **3.2**). Hooks are
  `#!/usr/bin/env bash`, so without newer bash first on PATH they run under
  3.2, where bash-4+ syntax (`mapfile`, `declare -A`, `${var^}`, `${var,,}`)
  is a runtime error (#1458 shipped exactly that into `lib/command-match.sh`;
  #1477 found `provider-integ-gate.test.sh` failing 3 of 17 cases there —
  neither detectable from a bash-5-only run).
- **Running the SUITE under 3.2 does not run the HOOK under 3.2** — the hooks
  are `#!/usr/bin/env bash`, so a bare `bash "$HOOK"` takes whatever comes
  first on PATH. `run-tests.sh` exports `HOOK_BASH` alongside each shell for
  exactly this; a suite ignoring it advertises 3.2 coverage of its test rather
  than of its subject. That hid a live fail-open until CI, the only runner
  with 3.2 as both `bash` and `/bin/bash`: the two engines disagreed about a
  bracket expression in `gate_strip_prefix` (go-to-k/cdkd#2650; the class is
  written up in [hooks-class-fences.md](hooks-class-fences.md)). Reproduce the
  runner by putting 3.2 FIRST on PATH, not by invoking the suite with
  `/bin/bash`. go-to-k/cdkd#2715 lists the suites still missing the shim.
- **A suite that exits 0 while printing a non-zero `fail: N` tally is a
  failure** — tally-not-exit-code is how the 3.2 breakage stayed invisible.
- **Deliberately NOT part of `vp run check` / `vp run verify`** (throwaway
  git repos, ~6 min). `.github/workflows/hooks.yml` runs it on `macos-latest`
  (the only runner image with bash 3.2) on any `.claude/hooks/**` PR.

Authoring a hook — why every Bash gate stays unconditional, and why an unquoted `cat >&2 <<EOF` EXECUTES the advice it means to print: [hooks-authoring.md](hooks-authoring.md).

# When a check may BLOCK at PreToolUse, and when it belongs in CI

**A PreToolUse gate may block only when the harm completes at the moment of the
action AND lands on a THIRD PARTY's artifact, where the actor cannot undo it.
Everything else goes to CI, or nowhere.**

Both clauses are load-bearing, and the second is the one that was missing. The
earlier wording already said "the actor cannot undo it" -- irreversibility was
never implicit -- and a first attempt to add the second clause only restated it
("lands SOMEWHERE the actor cannot undo it"), which reads as the same test with
a location noun and still yields the wrong answer below. The discriminator has
to name WHOSE artifact, and it now does. Irreversibility ALONE gets
`issue-dup-check` wrong: you
cannot un-mint an issue number or un-send its notifications, so by that test it
should BLOCK, and it correctly moved to CI instead. What separates it from
`pr-body-item-number` is WHOSE artifact carries the residue. A duplicate issue
is the filer's own and closes cleanly; a bare `#N` writes a permanent
`referenced` event on a THIRD PARTY's issue. The spec review of
go-to-k/cdkd#2717 caught that second test deciding a disposition while only the
first was written down.

That is the stopping rule go-to-k/cdkd#2717 was opened for. The guard layer had
reached 19% of the size of the product it guards, with 42 of 47 hooks blocking,
and every single one defensible on its own — 37 cite a concrete incident in
their own header. What was missing was not justification for any one hook but a
predicate that can say NO to the next one before it is written.

Read the rule as two questions -- is the harm reversible, and whose artifact
does it land on -- rather than as one about severity or how annoying the
mistake is:

- A bare `#N` in a published body writes a `referenced` event on a THIRD
  PARTY's issue and sends them a notification. Editing your body afterwards
  retracts neither. **Blocks** (`pr-body-item-number-gate`).
- A missing `severity:` label is added later with no residue. **CI** — and CI
  does better than the gate could, because it can APPLY the label where a hook
  could only refuse.
- A `feat:` title on a PR touching no `src/**` is caught before merge either
  way. **CI**, which additionally re-checks on every push; the hook fired once,
  at `gh pr create`, and never saw a web-UI retitle at all.

Applying it retired nine gates in one change (go-to-k/cdkd#2717): **two
deleted outright** — `closes-paren-form` and `vp-run-test-path` — and seven
moved to `.github/workflows/`: `non-english-text`, `commit-prefix-scope` and
`pr-title-prefix-scope` (the last two are one check now, since squash-only
merging makes the PR title the release subject), `internal-pr-labels`,
`issue-classification-label`, `issue-dup-check` and `gh-body-english`.

**One of the two deletions got a CI successor afterwards, and the correction is
worth reading before applying the rule again.** `closes-paren-form` was deleted
on the criterion and the criterion holds — but what the deletion LEFT was a
prose row in `.claude/skills/verify-pr/SKILL.md`, and a skill step is exactly
the instruction that gets skipped under time pressure, which is the argument the
gate's own header made for existing. go-to-k/cdkd#2736 gave it
`scripts/check-pr-closes-paren.ts`, which WARNS from `pr-content-checks.yml` and
never fails a PR on what it FINDS — it still exits 2, and reds, when it could
not look at all. So the rule's third option — "or nowhere" — is the one to reach for
last: a class measured live four times (go-to-k/cdkd#509 through #514) needs
something mechanical even when it does not deserve a gate. `vp-run-test-path`
took the other answer and stands: its own suite is what catches the mistake.

**`gh-pr-edit-deprecation-gate` was deleted on a MEASUREMENT, not on the tier.**
It blocked `gh pr edit --title` / `--body` because a Projects-classic GraphQL
deprecation made them exit non-zero with the mutation silently unapplied. MEASURED 2026-09-07 on gh 2.92.0 against a live PR: `gh pr edit --body` exited 0 AND the body was actually replaced. The Projects-classic GraphQL deprecation that made it fail silently is FIXED upstream. **`--title` was NOT measured** -- it is inferred from sharing the same `updatePullRequest` mutation, which is why the retraction says so rather than claiming both arms were observed.
The gate was guarding history, exactly as its own header allowed for ("If a
future gh release fixes the deprecation, this gate can be removed"). Every
sentence in this repo saying that spelling fails silently was retracted in the
same change — do not reinstate one from an old transcript.

**One more is on the settled DELETE list and is still present**, deliberately,
so do not read its survival as the rule passing it:
`issue-deferral-criteria-gate`, whose removal must edit a `REACH_FLOORS` row
that go-to-k/cdkd#2711 holds. It goes when that clears.

Two consequences worth carrying forward:

- **A CI check cannot go silently inert the way a hook can.** `non-english-text-gate`
  spent months returning 0 before scanning anything while its own suite
  certified it green, because the suite's `gh` stub was more permissive than
  real `gh`. A workflow step that does not run is a missing check on the PR.
- **Moving a check to CI deletes the shell parsing, which was most of the
  code.** These gates were large because a PreToolUse hook receives command
  TEXT and had to find the artifact inside it — heredocs, `--body-file`, `-F`,
  glued flags, quoting. CI is handed the artifact. `gh-body-english-gate` alone
  was 1,467 lines whose own header called "no shell parsing" its load-bearing
  decision after six review rounds each shipped a defect.

**Do not read this as "hooks were a mistake."** The blocking gates below have
prevented measured incidents and should keep doing so. The rule bounds the SET,
it does not disparage the members.
# The bash-first experiment must stay OFF (`env.CLAUDE_CODE_THRIFTY_SONIC`)

`.claude/settings.json` pins `env.CLAUDE_CODE_THRIFTY_SONIC: "0"`. It is
load-bearing for this harness, not a preference. With the flag ON, Claude Code
appends a system-reminder telling the agent to read AND write files through
`cat` / `sed -i` / heredocs rather than the Read / Edit / Write tools. Three
surfaces are keyed to those tools and go silently inert:

- **`worktree-owner-gate.sh`** (matcher `Edit|Write|NotebookEdit`) stops firing
  entirely — a Bash heredoc write claims no worktree and is refused by nothing,
  which is the multi-session uncommitted-work guard gone.
- the **PostToolUse `Write|Edit` → `vp run lint:fix`** entry never runs, so a
  `.ts` written through Bash surfaces its formatting breakage at `/check`.
- **every `paths:`-scoped file in this directory, this one included** — a
  rule loads when a matching file enters context through the file tools, so
  a `cat`-read subsystem gets none of its notes. No count is quoted here:
  `grep -l '^paths:' .claude/rules/*.md | wc -l`, for the same reason the
  counts at the top of this file are gone.

`main-tree-edit-gate.sh` survives (its matcher lists `Bash`) but degrades to the
best-effort literal-path scan its own header describes. The 2026-08-09
uncommitted-work class loses its SNAPSHOT too, not only its owner claim:
`restore-backup.sh` and `dirty-path-restore-gate.sh` are scoped to git VERBS
(`git checkout -- <path>`, `git restore`, `git reset --hard`), so an overwrite
spelled `cat > f` or `sed -i` never reaches either one.

Two properties of the pin worth stating rather than discovering. It is a repo
**DEFAULT, not an unescapable one**: `.claude/settings.local.json` outranks the
committed file and the fence never reads it, so a contributor who wants the
experiment can take it locally — what the pin removes is the SILENT version,
where a server-side cohort decides it and nobody chose anything. That file is listed in
`.gitignore` for the same reason the pin is committed: a CHECKED-IN
`settings.local.json` carrying `"1"` would beat the pin for everyone with the
fence still green, which is a local escape hatch turning into a silent
repo-wide one. And `env` exports the variable into **every Bash subprocess this
session spawns**, a nested `claude` and CI scripts included, not just the
session itself — and it BEATS an inherited value rather than merely defaulting
one: measured 2026-09-07, launching with `CLAUDE_CODE_THRIFTY_SONIC=1` in the
environment answers ABSENT inside a directory pinning `"0"`, while the same
launch from a directory with no project settings answers PRESENT.

Measured on Claude Code 2.1.263: the native binary parses the variable as a
tri-state bool, and an explicitly set value SHORT-CIRCUITS the server-side
cohort assignment — `if (env.CLAUDE_CODE_THRIFTY_SONIC !== undefined) return it`
sits ahead of the `forced` / `cohort` branches. So pinning it in the REPO's
settings decides the question for every clone and every contributor, which a
maintainer's `~/.claude/settings.json` cannot do. Probe it by flipping the value
to `"1"` and running `claude -p` with a prompt that asks whether the phrase
`Do your work through the Bash tool` is in context: `"1"` answers PRESENT,
`"0"` and the unset baseline answer ABSENT. **The unset baseline is not the
discriminator** — only the `"1"` arm is.

`tests/unit/scripts/settings-bash-first-optout.test.ts` fences the pin and the
reason, but it asserts a JSON string and can never assert vendor behavior: a
rename, a default flip, or removal of that short-circuit turns the pin into a
no-op with the fence still green. So its VERSION case pins the Claude Code line
the measurement was taken on (issue
[#2737](https://github.com/go-to-k/cdkd/issues/2737)) — **when the installed
MAJOR.MINOR moves off the recorded one, re-run BOTH probe arms above and update
the two constants together.** It is a REMINDER, not a detector: only running the
probe observes the vendor's behavior, and what a test can do is refuse to let
the measurement go quietly out of date. Compared at MAJOR.MINOR because patches
land often enough that an exact pin would red an unrelated commit most weeks,
and a red that frequent gets discharged by editing the constant instead of
re-probing; the bound that buys is a behavior change shipped inside a patch
release, which passes silently. Where no `claude` binary answers — CI — there is
no installed version to disagree with, so the case asserts that the receipt is
well-formed AND that this file still names the same version: bumping one copy of
the measurement without the other reds even there (`CDKD_CLAUDE_BIN` is the seam
that probes that arm).

# Other PreToolUse safety hooks

These one-shot hooks block known foot-guns at the source.

- **`.claude/hooks/commit-msg-heredoc-gate.sh`** blocks
  `git commit -m "$(cat <<'EOF' ... EOF)"`-style invocations — outer-shell
  quote tracking miscounts on apostrophes / backticks; use `git commit -F
  <file>`.

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
  path instead (the extraction and its known limit came from
  `gh-body-english-gate.sh`, retired to CI by go-to-k/cdkd#2717 — this gate is
  now its only surviving user, so the limit is documented HERE rather than by
  reference to a file that no longer exists).
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

- **`.claude/hooks/cmd-parse-stub-gate.sh`** blocks `git commit` when a staged
  `tests/**/*.test.ts` calls Commander's `cmd.parse([...])` without a nearby
  `.action(() => {})` stub (60-line lookback) — Node 24 escalates the real
  action handler's `process.exit(...)` unhandled rejection to a process exit
  AFTER the assertion passed (PR #266). `cmd.parseAsync(...)`, test files
  without `cmd.parse(...)`, and `src/**` pass. Smoke test:
  `cmd-parse-stub-gate.test.sh`.

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
  touches an APPEND-SHAPED generated file — `docs/_generated/integ-last-run.tsv`
  (it gains a row at the same place on every lane that ran an integ, so it
  conflicts on nearly every parallel-lane rebase, once PER COMMIT; the repo
  squash-merges, so flattening loses nothing). `docs/changelog-cdkd.md` WAS the
  other one and was the reason this hook exists; issue go-to-k/cdkd#2779 retired
  it by removing the shared anchor — entries live one-per-file under
  `changelog.d/` and the shipped document is assembled and gitignored, so no
  branch diff can contain it and an entry here could never match. **An ESCALATION, not a new rule**: ship.md §9's
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

- **`.claude/hooks/broad-process-kill-gate.sh`** blocks the bare and
  path-qualified `pkill` / `killall` command words. Both kill by NAME,
  machine-wide, while this machine runs parallel lanes and backgrounded
  `/run-integ` fixtures — a killed integ leaves AWS resources standing with no
  teardown and no attribution (measured 2026-09-06: a lane self-reported
  `pkill -f vitest` repo-wide with sibling lanes live). The steer is the
  question kill-by-name skips: `pgrep -laf` → `ps -p <pid>` → `kill <pid>`.
  **It is a STEER, not a boundary, and the passing set is UNBOUNDED** — the
  hook's header names the three mechanisms rather than listing members,
  because four successive revisions of that list were measured incomplete.
  The one worth knowing here: the verb is only caught after a prefix
  `gate_strip_prefix` KNOWS, so `nice` / `npx` / `setsid` / `busybox` /
  `find -exec` pass while `sudo` / `env` / `nohup` / `timeout` block —
  widening that belongs in `lib/command-match.sh`, where every gate gains it
  at once. Lookups (`command -v` / `which` / `type`) are reads and pass; an
  early revision refused them, and the relaxation fixing THAT opened a bypass
  until its argument class excluded `$`, `(` and a backtick, so the blanker
  now carries both polarities as cases. Library-load failure is CLOSED; a
  missing `jq` or `awk` degrades to a pass, as in every sibling. Suite runs
  under both bashes via `HOOK_BASH`.

- **`.claude/hooks/issue-deferral-criteria-gate.sh`** blocks `gh issue create`
  (and the `gh api repos/<o>/<r>/issues` mint) when the body's
  `Session-fit: next` line defers the work for a PR-SHAPED reason. **An
  ESCALATION, not a new rule**: `Session-fit` decides whether the work is
  finished in THIS session and none of its criteria is about the pull request.
  Only `next` is gated; `gh issue edit` / `comment` are not. The vocabulary,
  the body CHANNELS it reads and their precedence, the reason boundary, the
  bypass, and every measured number live in
  [hooks-deferral-criteria.md](hooks-deferral-criteria.md), whose `paths:`
  glob loads it only when that gate or its suite is open.

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
  `Edit|Write|Bash`), and **`main-tree-dirty-detector.sh`** is its
  non-blocking PostToolUse backstop for the write targets a static scan
  cannot resolve. Full entries — the detection model, the Bash arm's literal
  targets, the go-to-k/cdkd#2614 move to the shared `cd` resolver, the
  go-to-k/cdkd#2650 ordered walk over `gate_segments_marked` with its two input
  bounds, and all three suites (including the differential ORACLE, which
  executes its corpus and compares the gate against what bash actually did) —
  in [hooks-main-tree-edit.md](hooks-main-tree-edit.md), which loads when you
  touch either hook, either suite, the oracle, or the shared matcher.

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
2026-09-06 with BOTH halves of each tally: silent stub 11 pass / 11 fail,
`in_scope` forced true 20 / 2, forced false 20 / 2. The numbers here said
9/10, 8/11 and 10/9 — none of which sums to the 22 cases named one sentence
earlier, which is the cheapest way to catch a stale tally: read it against the
case count beside it. The SUITE header had the right ones throughout, so prefer
it; 3-dot-to-2-dot fails exactly the
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

### Two gates bind their marker to a COMMIT, and the binding lives in the hook

`pr-review` and `verify-pr` each write a gitignored root sentinel
(`.markgate-pr-review-sha`, `.markgate-verify-pr-sha`) and compare it in the
hook. **That comparison is the enforcement — `markgate verify` does not do it.**
`verify` digests the gate's SCOPE, so REWRITING a sentinel stales the marker,
but a sentinel nobody rewrote keeps its digest whatever the branch moved to:
`verify` reports `match` for a sentinel naming a different commit entirely
(measured, issue [#2681](https://github.com/go-to-k/cdkd/issues/2681), whose
whole subject is a comment that claimed the opposite and would have made
deleting the real check look like a safe simplification).

Why each needs it:

- `pr-review` — bound to the PR's `headRefOid`, so a new push invalidates it.
- `verify-pr` — bound to the LOCAL HEAD, because this gate also guards
  `gh pr create`, where there is no PR to ask yet. Added by issue
  [#2686](https://github.com/go-to-k/cdkd/issues/2686): the parent has no
  `include:` of its own, so once set in a worktree it never stales by itself —
  it is only MASKED by a stale child, and `/check` + `/check-docs` un-mask it.
  In the IN-PLACE worktree mode CLAUDE.md prescribes, lane N inherited lane
  N-1's green. Measured twice, a day apart, in different worktrees: a parent an
  hour older than children four minutes old, `verify` rc=0, `gh pr create`
  unblocked.

**The ORDER in `/verify-pr`'s final step is forced from two directions, and
getting either wrong deadlocks or false-blocks.** `check-gate` refuses the
commit unless `check` and `docs` are fresh, so those two are set FIRST — after
the commit is too late for exactly the runs that produced changes to commit, and
an agent facing a blocking gate starts improvising around it. The sentinel and
`markgate set verify-pr` come LAST, after the push: written before the commit,
HEAD moves past the binding and the next `gh pr create` refuses a PR that is
genuinely ready. Both halves were live defects in the change that added the
binding. The commit itself is guarded (`git diff --cached --quiet ||`) because a
CLEAN tree is the normal case on a re-run after a rebase, where a bare
`commit && push` chain exits 1 and never pushes.

**It is ONE `&&` chain, and unchaining it re-opens the class**: if a gate
refuses the commit, unchained execution continues, the push sends nothing, and
the bind records the OLD head — a green for work that was never committed.

The re-bind after a rebase is written out as the two COMMANDS rather than cited
as "the last N lines". A count into a wrapped `&&` block goes stale the moment
anyone reflows it, and the miscount executes: `> <sentinel> && markgate set
verify-pr` is a bare redirect bash accepts, which TRUNCATES the sentinel to zero
bytes, exits 0, and lets the marker be set — a block whose cause is off-screen.
Measured (go-to-k/cdkd#2686 round-5 review).

The sentinel is written from the repo TOP (`$(git rev-parse --show-toplevel)/…`):
the cwd-relative spelling run from a subdirectory writes a file the hook never
reads, and `.gitignore`'s entry has no leading slash, so the stray copy is
invisible — a permanent block with an off-screen cause.

Anything that moves HEAD afterwards invalidates the binding by design, including
the flatten / rebase / force-push `work-issues/references/ship.md` prescribes
before merge.

The read uses `git rev-parse --verify HEAD`, not the bare form: in a repo with
no commits the bare spelling prints the literal string `HEAD` on STDOUT, which
would make the emptiness guard beside it dead code and let a sentinel containing
`HEAD` compare equal. Both halves are pinned by
`.claude/hooks/verify-pr-gate.test.sh`, which also carries the case the issue
asked for — a FRESH marker plus a FOREIGN sha must BLOCK, and must say so
rather than reporting staleness the children do not have.

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
  `gh-body-english-gate` (ignored `-C` for `--body-file` resolution — RIGHT:
  `-C` changes gh's repo, not the shell's cwd; retired to CI by
  go-to-k/cdkd#2717, kept in this roll-call because the roll-call is a RECORD of
  what the #2027 audit examined, and rewriting history to match the current
  hook set would make the audit unreproducible), the two PostToolUse detectors
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
subcommand, and `dirty-path-restore-gate` / `non-english-text-gate` (the
latter retired to CI by go-to-k/cdkd#2717) carried their own
quoted-alternative-less `-C` patterns.

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
observe). **One gate fails closed for `Bash` and not for its other arms** —
`main-tree-edit-gate`, whose matcher also takes Edit and Write, so a LOAD-time
refusal took away the tools the library is repaired with (go-to-k/cdkd#2717;
[hooks-main-tree-edit.md](hooks-main-tree-edit.md) has it). A carve-out for a
MATCHER, not a softening: a Bash-only gate still refuses outright, and so does
that gate's `Bash` arm.
The path is derived with pure-bash `${BASH_SOURCE[0]%/*}` rather
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
the raw command after the verb is confirmed in command position.
`pr-title-prefix-scope-gate` was the worked example — it did exactly that for
the `gh api …/pulls/<N>` endpoint, because matching `pulls/[0-9]+` against
neutralised text found only a placeholder and let a mislabelled `fix:` title
edit through (the PR #562 incident). **That gate is retired to CI
(go-to-k/cdkd#2717) and the CONSEQUENCE is not**: it is a property of the
matcher, not of any one caller, so the next gate needing a quoted value has to
re-derive it. The example is kept for that reason rather than replaced with a
live one, since no surviving gate currently reads a quoted value this way.

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
