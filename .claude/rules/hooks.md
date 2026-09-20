---
description: cdkd hooks — when one may block, the roster, authoring invariants
paths:
  - '.claude/hooks/**'
  - '.claude/settings.json'
  - '.markgate.yml'
---

# When a hook may BLOCK, and when it may exist at all

**A gate may block only when the harm completes at the moment of the action AND
lands irreversibly on a THIRD PARTY's artifact, on ANOTHER SESSION's work, or on
the MAINTAINER's AWS account.** Everything else becomes a sentence in AGENTS.md,
a CI unit test, or nothing. Ask the two clauses separately — is the harm
reversible, and whose artifact does it land on — never one about severity:
irreversibility alone would block a duplicate issue, the filer's own artifact.

**A hook that fails OPEN on an exotic shell shape is accepted as-is.** Quoting,
heredocs, substitutions and redirections can all steer a command past a matcher.
They steer a COOPERATIVE agent away from foot-guns and are not a security
boundary; `main` is protected server-side by a GitHub ruleset.

# The roster

## Third-party artifacts

- **`ci-green-gate.sh`** — blocks `gh pr merge` unless EVERY GitHub Actions
  check on the target PR reports `pass` or `skipping`; `fail`, `pending` and
  "no checks reported" exit 2. A LIVE query, not a marker.
  `CDKD_SKIP_CI_GREEN_GATE=1` is the bypass for a repo with no CI, never a red
  PR. **A PR NUMBER DOES NOT NAME A PULL REQUEST** (go-to-k/cdkd#3273): `42`
  exists in every repository, so a query with no `-R`
  judges whatever repo the SHELL is in. The gate resolves the slug with
  `gate_gh_repo_slug` — either flag slot, and after the verb — and FORWARDS
  `-R <slug>`; an unreadable or ambiguous slug (a variable, a bare trailing
  `-R`, two DISTINCT slugs) REFUSES rather than mirroring gh's last-wins rule.
  A transport failure fails OPEN only while no repo is named; with one, an
  unreadable answer BLOCKS. The query runs under `gate_bounded` with
  **`GATE_BOUNDED_KEEP_STDERR=1`, on the perl-absent degraded arm too**:
  `gh pr checks` exits 1 both for "a check failed" and for "no checks
  reported", and only the stderr text separates them, so a hardcoded
  `2>/dev/null` there is a live fail-open. A hook KILLED by its registered
  timeout emits no exit 2 at all and silently passes the merge — which is what
  the bound exists to prevent.

- **`post-merge-orphan-push-gate.sh`** — blocks `git push origin <branch>` when
  `gh pr list --head <branch> --state merged` matches: the branch is gone, so
  the push would re-create an orphan ref no PR tracks. ONLY the merged state,
  ONLY `origin`, ONLY `git push`, and it judges EVERY push in the command, not
  just the first. Fails open without `gh`; not repo-opt-in-scoped.

## The maintainer's AWS account

- **`integ-destroy-gate.sh`** — blocks `gh pr merge` until `/run-integ` has
  recorded a real-AWS run whose destroy finished with 0 errors and 0 orphans.
  Markgate-backed; its scope, `hash: diff` mode and 14-day TTL live in
  `.markgate.yml`, and a PR outside that scope passes on a stale marker.

- **`integ-schema-migration-gate.sh`** — blocks `gh pr merge` for a PR whose
  diff really changes the `StateSchemaVersion` union or the
  `STATE_SCHEMA_VERSION_CURRENT` constant in `src/types/state.ts`, until
  `/run-integ` has recorded a clean `schema-v<N>-to-v<N+1>-migration` run. The
  harm is a THIRD PARTY's: a migration writes to state documents that live in
  USERS' S3 buckets and there is no way back. A non-bump edit to that file
  (JSDoc, a helper, a comment) passes. Markgate-backed, `hash: files`, 14-day
  TTL; a FOREIGN target declaring no equivalent gate is relaxed.

- **`bughunt-clean-gate.sh`** — blocks `git commit`, `gh pr create` and
  `gh pr merge` while `/hunt-bugs` has un-destroyed AWS resources in its
  sentinel; only `bughunt-track.sh clear`, after destroy + orphan-zero
  verification, releases it. Sentinels are per-owner: `git commit` blocks on the
  CALLER's file alone, the `gh` verbs on all of them.

## Another session's work

- **`worktree-owner-gate.sh`** — PreToolUse (`Edit|Write|NotebookEdit`). Each
  LINKED worktree gets one owning session, recorded in
  `<worktree git dir>/session-owner`; a write from another session exits 2, and
  the SENTINEL ITSELF is gated — writing that file IS taking the worktree. **A
  claim younger than `CDKD_WORKTREE_OWNER_TTL_HOURS` (default 12) means the
  owner is presumed LIVE** — NEVER infer a dead owner, since a live and a dead
  session look identical; ask the maintainer before a hand-off. Bypass
  `CDKD_SKIP_WORKTREE_OWNER_GATE=1`. Fails OPEN on anything unresolvable.

- **`dirty-path-restore-gate.sh`** — blocks `git checkout -- <path>` /
  `git restore <path>` when a NAMED path has uncommitted changes. Path-scoped
  restores only, and `--staged` passes. Bypass `CDKD_ALLOW_DIRTY_RESTORE=1`,
  read from the process env AND from a leading assignment in the command.

- **`restore-backup.sh`** — PreToolUse, **non-blocking**, always exits 0. Before
  a `checkout`/`restore` of a path, `reset --hard`, `clean -f*` or `stash`,
  snapshots the tree into
  `<resolved git dir>/wipe-backups/<UTC ts>-<verb>/`; recover with `git apply
  --include=<path> <snap>/tracked.patch`, or `--3way` for a tree.

- **`branch-gate.sh`** — blocks `git commit` / `git push` when the TARGET
  working tree is on `main` / `master`, and when the MAIN checkout is on a
  DETACHED HEAD; a detached LINKED worktree keeps passing. The printed remedy
  follows the operation in progress, read from git's own state.

- **`broad-process-kill-gate.sh`** — blocks a machine-wide `pkill` / `killall`,
  which reaches other agents' processes.

**Repo opt-in.** `branch-gate.sh` fires ONLY in a repo carrying `.markgate.yml`
at its root.

# Authoring a hook

**Every Bash-targeting `PreToolUse` entry uses the coarse `Bash` matcher and no
per-hook `if:` condition.** The absent `if:` is the load-bearing half: each gate
parses the command itself, which is what catches the `cd <path> && …` and
`gh -C <path>` spellings this repo prescribes. `if:` in project settings never
fired at all. Do NOT reintroduce it. Fenced by
`tests/unit/scripts/settings-bash-matcher-coverage.test.ts`.

**A refusal message printed with `cat >&2 <<EOF` is an UNQUOTED heredoc**, so
`$( )`, backticks and `$var` in the body EXECUTE at refusal time instead of
printing: a gate RUNS the worked example it meant to print
(go-to-k/cdkd#2630). QUOTE THE DELIMITER (`<<'EOF'`) and interpolate the few
live values with a separate `printf`. Assert the RENDERED message in the suite,
never a restatement of it.

**A blocking gate that cannot load the shared matcher exits 2**; a non-blocking
hook (`restore-backup`) skips instead. **An unreadable target
directory is likewise a REFUSAL**: a hook receives command TEXT, not the shell's
expansion, so `git -C "$W" commit` arrives unexpanded and
`gate_target_dir_strict` returns 2 rather than guessing. These shapes must NOT
be refused: an absolute `-C` or `cd` mooting an earlier unreadable one, a `cd`
AFTER the verb, and a leading literal `~`.

Hooks must be bash 3.2 compatible; `run-tests.sh` exports `HOOK_BASH` so the
HOOK, not just the suite, runs under it.

# The shared matcher (`.claude/hooks/lib/command-match.sh`)

Every Bash gate parses its command through this one library.

- Heredoc bodies and quoted spans are **NEUTRALISED to a placeholder, never
  deleted** — the verb EREs carry value sub-patterns and need the positions.
- **No non-empty command may segment to ZERO**, or every gate considers nothing
  and all of them exit 0 at once. A bare `gh` is the single excluded case, named
  explicitly so the exclusion cannot widen.
- **Over-approximate the TRIGGER, stay strict on RESOLUTION.** `GATE_FLAGS`
  enumerates no flag spellings, so an unlisted one WIDENS the match rather than
  losing it; a bare token in FIRST position stops the walk, because that IS the
  subcommand. `gh` takes `-R` in two slots and both are absorbed.
- **`gate_dequote_structural` dequotes POSITIONS, not everything** — the command
  word, the leading global-flag NAMES and the SUBCOMMAND slot, nothing after the
  verb. Quoting is a load-bearing brake on the over-approximation above, so a
  blanket dequote turns ordinary read-only work into refusals. The walk is
  bounded by `GATE_STRUCT_MAXTOK`: a killed hook emits no exit 2, disarming every
  gate at once. `_gate_struct_next` refuses to split after an ODD trailing
  backslash — `cd\ /tmp` is ONE shell word bash never acts on.
- **Heredoc latch.** Inside an open `$( )` the opener scan reads the PHYSICAL
  line, is QUOTE-AWARE with a per-depth stack, skips `${…}` / `$((…))` and `#`
  comments whole, and BAILS to "no opener" on a line it cannot read to the end.
  It latches **QUOTED DELIMITERS ONLY**; an unquoted body is read as commands —
  a false refusal, never a miss. At TOP level an unquoted-delimiter
  body is dropped entirely, a known fail-open, so the two paths differ.

# Markgate and sibling repos

**Markgate markers are per-worktree**, in
`<worktree>/.git/worktrees/<name>/markgate/`, so parallel lanes can verify and
commit concurrently; run `markgate set` from the worktree where the gated command
will be invoked. Spell a hand check `mise exec -- markgate …`: a bare `markgate`
is not the version `.mise.toml` pins for the gates.

The hooks a session runs come from ONE repo's `.claude/settings.json` and fire on
**every** Bash call, including ones targeting another repository: the marker
lookup is target-correct while the POLICY stays session-correct. **A cdkd session
working in a sibling repo gets cdkd's policy applied to it: expected, not a bug
in the target.** Complete the TARGET repo's checklist, set its markers
legitimately, then retry — never route around the block, and **never converge the
two repos' policies.**

**Cross-repo gate aliasing** (go-to-k/cdkd#2236). Asking markgate about a gate
named for cdkd makes a sibling's merge UNSATISFIABLE when that sibling spells
the gate differently, and no per-gate query separates "undeclared" from
"declared but unset". So `gate_markgate_declares` reads the target's own
`.markgate.yml` and `gate_resolve_marker_gate` answers:

- **canonical** — the target declares the cdkd gate, or definedness is
  undeterminable; behaviour unchanged.
- **alias** — it declares an equivalent under its own name, so THAT marker is
  verified and a stale one refused by naming the target's gate and the command
  that refreshes it there.
- **none** — nothing equivalent: REFUSAL, exit 2, naming the mapping row to add.
  `integ-destroy` takes no carve-out here. `integ-schema-migration` does, and it
  is the one exception: a FOREIGN target at `none` PASSES, because a schema
  contract only cdkd defines is only cdkd's to gate, and refusing there is
  unclearable by any action that repo can take.

That mapping is **DECLARED per (repo, cdkd gate), never discovered**, since
every heuristic's failure mode is a false ACCEPT; an EMPTY table is valid. It is
keyed by `gate_repo_slug`, which keeps the WHOLE `<host>/<path>`, folds only
`ssh.github.com` / `www.github.com` and strips a case-insensitive `.git` —
normalising further REMOVES a refusal here rather than adding a match.
Resolution **fails closed on UNDETERMINABLE**: only a parsed `gates:` block with
the name absent counts as "not declared". **markgate rc=2 is "could not
EVALUATE", not staleness**, so its branch sits ABOVE the alias refusal: rc 0 →
pass, rc 2 → unevaluable, alias → alias refusal, else canonical.
