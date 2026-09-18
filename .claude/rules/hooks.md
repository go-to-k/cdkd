---
description: cdkd PreToolUse safety hooks — the blocking criterion and the surviving roster
paths:
  - '.claude/hooks/**'
  - '.claude/settings.json'
  - '.markgate.yml'
---

# When a hook may BLOCK, and when it may exist at all

**A PreToolUse gate may block only when the harm completes at the moment of the
action AND lands irreversibly on a THIRD PARTY's artifact, on ANOTHER SESSION's
work, or on the MAINTAINER's AWS account. Everything else becomes a sentence in
CLAUDE.md, a CI unit test, or nothing.**

Both clauses are load-bearing. Irreversibility ALONE gets the answer wrong: you
cannot un-mint an issue number or un-send its notifications, yet a duplicate
issue is the filer's own and closes cleanly, so it belongs in CI. A bare `#N` in
a published body writes a permanent `referenced` event on a THIRD PARTY's issue
— same irreversibility, different owner.

Read it as two questions — is the harm reversible, and whose artifact does it
land on — never as one about severity or how annoying the mistake is.

**A hook that fails OPEN on an exotic shell shape is accepted as-is.** Quoting,
heredocs, `$( )`, `bash -c`, `eval`, case arms and redirections can all steer a
command past a gate's matcher. That is a known and tolerated property: these
hooks steer a COOPERATIVE agent away from foot-guns, they are not a security
boundary, and `main` is protected server-side by a GitHub ruleset. A newly found
parser miss is NOT issue-worthy. If one bites twice in practice, record the
first occurrence in [../../docs/tooling-backlog.md](../../docs/tooling-backlog.md)
and fix it on the second.

**Adding tooling is not covered by "cost is not a tiebreaker".** That rule
governs verifying PRODUCT changes. A new hook, fence, rule paragraph or
test-of-prose is added only on the SECOND occurrence of the same failure; the
first goes to `docs/tooling-backlog.md`.

Authoring a hook — why every Bash gate stays unconditional, and why an unquoted
`cat >&2 <<EOF` EXECUTES the advice it means to print:
[hooks-authoring.md](hooks-authoring.md).

# Running the hook suites

```bash
vp run test:hooks     # or: bash .claude/hooks/run-tests.sh
```

- **EVERY hook ships a `*.test.sh` suite** (`run-tests.sh` is the runner), plus
  the CLASS fences with no same-named `.sh` — `markgate-gate-name-class` and
  `unresolved-target-class`. Count them rather than trusting a number here:
  `ls .claude/hooks/*.sh | grep -v '\.test\.sh$' | wc -l`.
- **The runner executes every suite under BOTH bashes** — PATH `bash`
  (Homebrew 5.x) and `/bin/bash` (macOS system **3.2**). Hooks are
  `#!/usr/bin/env bash`, so bash-4+ syntax (`mapfile`, `declare -A`, `${var^}`)
  is a runtime error under 3.2 and is not visible from a bash-5-only run.
- **Running the SUITE under 3.2 does not run the HOOK under 3.2.**
  `run-tests.sh` exports `HOOK_BASH` alongside each shell for exactly this; a
  suite ignoring it advertises 3.2 coverage of its test rather than of its
  subject.
- **A suite that exits 0 while printing a non-zero `fail: N` tally is a
  failure** — tally-not-exit-code is how a 3.2 breakage once stayed invisible.
- **Deliberately NOT part of `vp run check` / `vp run verify`** (throwaway git
  repos, ~6 min). `.github/workflows/hooks.yml` runs it on `macos-latest` (the
  only runner image with bash 3.2) on any `.claude/hooks/**` PR.

# The surviving roster

## Third-party artifacts

- **`ci-green-gate.sh`** — blocks `gh pr merge` unless EVERY GitHub Actions
  check on the target PR reports `pass` or `skipping`; `fail`, `pending` and
  "no checks reported" exit 2 with the failing names. A red `main` is a shared
  artifact every other lane then builds on. LIVE-query, not a marker, because
  CI status changes on every push. `gh` transport errors fail OPEN (an outage
  must not block merges), but not under an explicit `-R`.
  `CDKD_SKIP_CI_GREEN_GATE=1` is the documented bypass for a repo with no CI —
  never for merging a red PR. A PR NUMBER DOES NOT NAME A PULL REQUEST: the
  gate forwards a `-R` / `--repo` slug and REFUSES an unreadable one. Full
  entry in [hooks-merge-target.md](hooks-merge-target.md).

- **`post-merge-orphan-push-gate.sh`** — blocks `git push origin <branch>` when
  `gh pr list --head <branch> --state merged` matches. After a merge,
  `delete_branch_on_merge` removes the branch and a near-simultaneous push
  SUCCEEDS by re-creating it as an orphan ref no PR tracks, so the commits
  silently never reach main (the PR #263 incident). ONLY the merged state, ONLY
  `origin`, ONLY `git push`; judges EVERY push in the command, not the first.
  Fails open without `gh`. Deliberately NOT repo-opt-in-scoped — the hazard
  exists in any repo with PRs.

## The maintainer's AWS account

- **`integ-destroy-gate.sh`** — blocks `gh pr merge` until `/run-integ` has
  recorded a real-AWS run whose destroy finished with 0 errors and 0 orphans.
  Leaked AWS resources bill the maintainer and are not undone by reverting the
  PR. The only surviving markgate gate; scope and 14-day TTL in
  `.markgate.yml`. A PR touching none of its scope passes even with a stale
  marker (the TTL would otherwise block every merge).

- **`bughunt-clean-gate.sh`** — blocks `git commit`, `gh pr create` and
  `gh pr merge` while `/hunt-bugs` still has un-destroyed AWS resources in its
  sentinel. `.claude/skills/hunt-bugs/bughunt-track.sh add` records each
  deployed stack; only `clear` releases it, run after destroy + orphan-zero
  verification. Parallel-safe per-owner sentinel directory
  (`.markgate-bughunt-pending.d/`, one file per owner) at the shared main-tree
  root, so one agent's `clear` can never release another's pending resources.
  Verb-scoped: `gh pr create` / `gh pr merge` AGGREGATE across owners (merging
  publishes a shared artifact), `git commit` blocks only on the CALLER's file
  (a commit creates no AWS resources, and blocking a third party hands them a
  remediation they must not follow).

## Another session's work

- **`worktree-owner-gate.sh`** — PreToolUse (`Edit|Write|NotebookEdit`). Each
  LINKED worktree gets one owning session, recorded as `<session_id> <UTC time>`
  in `<worktree git dir>/session-owner`; a write from another session exits 2.
  The SENTINEL ITSELF is gated — writing that file IS taking the worktree. A
  claim younger than `CDKD_WORKTREE_OWNER_TTL_HOURS` (default 12) means the
  owner is **presumed LIVE**: a live session and a dead one produce identical
  evidence, so ASK THE MAINTAINER before any hand-off.
  `CDKD_SKIP_WORKTREE_OWNER_GATE=1` is the deliberate bypass. Fails OPEN on
  anything unresolvable.

- **`dirty-path-restore-gate.sh`** — blocks `git checkout -- <path>` /
  `git restore <path>` when a NAMED path has uncommitted changes. Born from a
  session that discarded ~228 lines another session had written; `git checkout
  --` writes no reflog entry and creates no stash, so nothing in git holds a
  copy. Narrow by design: only path-scoped restores, only when a named path is
  actually dirty, `--staged` passes. Bypass `CDKD_ALLOW_DIRTY_RESTORE=1`,
  honoured from the process env AND a leading assignment in the command text.

- **`restore-backup.sh`** — PreToolUse, **non-blocking**. Before
  `git checkout -- <path>`, `git restore`, `git reset --hard`, `git clean -f*`
  or `git stash`, snapshots the tree into
  `<resolved git dir>/wipe-backups/<UTC ts>-<verb>/`. Always exits 0. Recover
  with `git apply --include=<path> <snap>/tracked.patch` for one file or
  `git apply --3way <snap>/tracked.patch` for the tree — the plain form fails
  once any other change in the whole-tree patch is still present.

- **`main-tree-branch-gate.sh`** — blocks branch-switching commands in the MAIN
  worktree, a shared checkout slot other agents depend on; inside any
  `.claude/worktrees/<x>/` subtree everything passes. Full entry in
  [hooks-main-tree-branch.md](hooks-main-tree-branch.md).

- **`main-tree-edit-gate.sh`** — blocks mutating a git-tracked file in a
  worktree currently on `main` / `master` (matcher `Edit|Write|Bash`), with
  **`main-tree-dirty-detector.sh`** as its non-blocking PostToolUse backstop for
  the write targets a static scan cannot resolve. Full entry in
  [hooks-main-tree-edit.md](hooks-main-tree-edit.md).

- **`branch-gate.sh`** — blocks `git commit` / `git push` when the TARGET
  working tree is on `main` / `master`, and when the MAIN checkout is on a
  detached HEAD. Full entry in [hooks-branch-gate.md](hooks-branch-gate.md).

- **`broad-process-kill-gate.sh`** — blocks a machine-wide `pkill` / `killall`.
  A pattern kill reaches every other agent's processes on the same machine, and
  their work is gone at the moment the signal lands.

- **`main-tree-git-cwd-detector.sh`** — PostToolUse (`Bash`), **never blocks**.
  Reactive backstop for the cwd-RACE class: a command whose verdict is taken as
  evidence running in the MAIN tree while feature worktrees are active. It
  reports a FALSE GREEN the agent cannot otherwise see, which is why it is not
  a rule restatement. Full entry in
  [hooks-cwd-detector.md](hooks-cwd-detector.md).

**Repo opt-in scope.** The main-tree / branch hooks (`branch-gate.sh`,
`main-tree-branch-gate.sh`, `main-tree-edit-gate.sh`,
`main-tree-dirty-detector.sh`, `main-tree-git-cwd-detector.sh`) fire ONLY in
repos carrying `.markgate.yml` at the repo root — a cdkd session regularly
touches unrelated personal repos where committing to main is the normal
single-writer workflow.

Two non-hook entries complete `.claude/settings.json`: the PostToolUse
`Write|Edit` → `vp run lint:fix` runner, and an inline PreCompact `printf` that
asks for current work state to be recorded before compaction.

## The bash-first experiment must stay OFF

`.claude/settings.json` pins `env.CLAUDE_CODE_THRIFTY_SONIC: "0"`, and it is
load-bearing rather than a preference. With the flag ON, the agent is told to
read and WRITE files through `cat` / `sed -i` / heredocs, and three surfaces go
silently inert: `worktree-owner-gate.sh` (matcher `Edit|Write|NotebookEdit`)
stops firing entirely, the PostToolUse `vp run lint:fix` entry never runs, and
**every `paths:`-scoped file in this directory, this one included** goes unread
— a rule loads when a matching file enters context through the file tools.
`main-tree-edit-gate.sh` survives (its matcher lists `Bash`) but degrades to a
best-effort literal-path scan, and `restore-backup.sh` /
`dirty-path-restore-gate.sh` are scoped to git VERBS, so an overwrite spelled
`cat > f` reaches neither.

Measured on Claude Code 2.1.263: an explicitly set value SHORT-CIRCUITS the
server-side cohort assignment, so pinning it in the REPO's settings decides the
question for every clone — a maintainer's `~/.claude/settings.json` cannot.
Probe by flipping the value to `"1"` and running `claude -p` with a prompt
asking whether `Do your work through the Bash tool` is in context: `"1"` answers
PRESENT, `"0"` and the unset baseline answer ABSENT; only the `"1"` arm
discriminates. It is a repo DEFAULT, not unescapable —
`.claude/settings.local.json` outranks it and is gitignored.
`tests/unit/scripts/settings-bash-first-optout.test.ts` fences the pin and pins
the Claude Code MAJOR.MINOR the measurement was taken on; when the installed
version moves off it, re-run BOTH probe arms and update the two constants
together.

## Shared machinery

Every Bash gate parses the command itself through
`.claude/hooks/lib/command-match.sh`: heredoc bodies and quoted spans are
NEUTRALISED (to a placeholder, never deleted — the verb EREs carry value
sub-patterns), the command list is SEGMENTED on `&&`, `||`, `;`, `|`, a bare
`&`, newlines, subshells, brace groups and `$( )` / backtick substitutions, and
the verb is matched at the START of a segment with leading `VAR=value`
assignments and `env` / `command` / `nohup` / `time` / `timeout` / `exec`
wrappers stripped and `bash -c "<cmd>"` unwrapped. `gh` has TWO `-R` slots and
both are absorbed. Failure direction is the whole design: dropping too much
makes a gate SILENTLY NOT FIRE, dropping too little is a loud, fixable false
positive. The `$( )`-heredoc latch has its own write-up in
[hooks-command-match-heredoc.md](hooks-command-match-heredoc.md).

**Every Bash-targeting `PreToolUse` entry uses the coarse `Bash` matcher and no
per-hook `if:` condition.** The absent `if:` is the load-bearing half: each gate
parses the command itself, which is what lets it catch the `cd <path> && ...`
and `gh -C <path>` spellings. `if:` in project settings never fired at all, and
its matching was purely textual and quote-blind. Do NOT reintroduce it.

**Every gate that sources the helper fails CLOSED when it cannot load**
(`exit 2`, with `declare -F` liveness checks and `gate_require_const` for the
constants it reads); the non-blocking detectors and `restore-backup` skip
instead. **One gate takes a matcher carve-out** — `main-tree-edit-gate`, whose
`Edit` and `Write` arms must not be refused by a library failure, since those
are the tools the library is repaired with. Any future check added to that hook
belongs INSIDE the `Bash` arm.

**An unreadable target directory is a REFUSAL in every blocking gate.** A hook
receives command TEXT, not the shell's expansion, so `git -C "$W" commit`
arrives unexpanded — the gates were once weakest on exactly the spelling this
repo's instructions prescribe. `gate_target_dir_strict` returns 2 rather than
guessing; four shapes must NOT be refused (an absolute `-C` or `cd` moots an
earlier unreadable one, a `cd` AFTER the verb never steered the command, and a
LEADING literal `~` is expanded). `cmd_last_cd_target` follows every `cd` in
command position **that precedes the verb** — following trailing cds let the
standing `gh pr merge … && cd <repo> && git pull` redirect marker lookups to the
main tree.

**Markgate markers are per-worktree**, stored in
`<worktree>/.git/worktrees/<name>/markgate/`, so parallel lanes can verify and
commit concurrently; run `markgate set` from the worktree where the gated
command will be invoked. **A hand-typed `markgate` is not the one the hooks
run** — `.mise.toml` pins the version and every gate resolves it through mise,
so spell any hand check `mise exec -- markgate ...`.

The class fences whose subject is EVERY hook at once are in
[hooks-class-fences.md](hooks-class-fences.md) (unresolved-target sweep) and
[hooks-gate-name-fence.md](hooks-gate-name-fence.md) (gate names).

## Working on a sibling repo from a cdkd session

The hooks a session runs come from ONE repo's `.claude/settings.json` —
whichever repo the session started in — and fire on **every** Bash call,
including commands targeting another repository. The marker lookup is
target-correct while the POLICY stays session-correct.

**A cdkd session working in cdk-local or cdk-real-drift gets cdkd's policy
applied to it — expected, not a bug in the target. Complete the TARGET repo's
own checklist and set its markers legitimately, then retry. Never route around
the block, and do not "fix" the target repo to match cdkd.** Do not port cdkd's
stricter gates down to a sibling, or a sibling's exemptions up into cdkd.

**Delegation was tried and abandoned** (PR 1970). Each gate handing its decision
to `<target-repo>/.claude/hooks/<same-name>` introduces arbitrary code
execution: the target directory is named by the command itself, so any directory
the agent can be induced to touch that carries an executable at that path gets
it run with the session's environment — reproduced with a planted hook and a
plain `git checkout`, which read `AWS_*` / `GH_TOKEN`-shaped variables. Not
patchable from inside the design. Read the closed PR before proposing it again.

The cross-repo gate-aliasing design — why a sibling took a refusal it could
never clear, and how `gate_resolve_marker_gate` chooses between the canonical
gate, an alias and a refusal — is in
[gate-sibling-repos.md](gate-sibling-repos.md).
