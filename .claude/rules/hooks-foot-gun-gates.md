---
description: cdkd one-shot foot-gun PreToolUse gates - the per-hook roster (commit-msg heredoc, provider docs, PR body item numbers, cmd.parse stub, integ coverage matrix, state destroy --force, ref segment audit, gated-command preamble, flatten-before-rebase, broad process kill)
paths:
  - '.claude/hooks/commit-msg-heredoc-gate.sh'
  - '.claude/hooks/commit-msg-heredoc-gate.test.sh'
  - '.claude/hooks/provider-docs-gate.sh'
  - '.claude/hooks/provider-docs-gate.test.sh'
  - '.claude/hooks/pr-body-item-number-gate.sh'
  - '.claude/hooks/pr-body-item-number-gate.test.sh'
  - '.claude/hooks/cmd-parse-stub-gate.sh'
  - '.claude/hooks/cmd-parse-stub-gate.test.sh'
  - '.claude/hooks/integ-coverage-matrix-gate.sh'
  - '.claude/hooks/integ-coverage-matrix-gate.test.sh'
  - '.claude/hooks/state-destroy-force-gate.sh'
  - '.claude/hooks/state-destroy-force-gate.test.sh'
  - '.claude/hooks/ref-segment-audit-gate.sh'
  - '.claude/hooks/ref-segment-audit-gate.test.sh'
  - '.claude/hooks/gated-command-preamble-gate.sh'
  - '.claude/hooks/gated-command-preamble-gate.test.sh'
  - '.claude/hooks/flatten-before-rebase-gate.sh'
  - '.claude/hooks/flatten-before-rebase-gate.test.sh'
  - '.claude/hooks/broad-process-kill-gate.sh'
  - '.claude/hooks/broad-process-kill-gate.test.sh'
---

# The one-shot foot-gun gates

Split out of [hooks.md](hooks.md) when the go-to-k/cdkd#3040 rounds took the
`.claude/hooks/lib/command-match.sh` payload past its 120,000 B cap once
projected onto `origin/main`. Nothing here is summarised or deleted -- the ten
entries are moved verbatim, and the split is what funds the matcher
documentation rather than a trim of someone else's entry.

The glob is the ten gates and their suites, which is the whole audience: each
entry is that hook's own vocabulary, incident and case tally, and a lane
editing a different hook (or the shared matcher these gates source) never
needs it. The STOPPING RULE that decides whether a new gate may exist at all
stays in hooks.md, where it is read before one is written.

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
