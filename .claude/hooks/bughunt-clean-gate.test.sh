#!/usr/bin/env bash
# Smoke tests for bughunt-clean-gate.sh + bughunt-track.sh (parallel-safe
# per-owner sentinel + verb-scoped block decision, issue #1615).
#
# Part 1 sets up a throwaway git repo, arms the bug-hunt sentinel (legacy flat
# file OR the per-owner `.d/` directory — foreign-owner or own-owner files),
# runs the hook against simulated tool input, and asserts the expected
# pass (0) / block (2) behavior, plus the non-blocking stderr notice on the
# foreign-owner git-commit path.
#
# Part 2 drives bughunt-track.sh directly with distinct CDKD_BUGHUNT_OWNER
# values to prove the SPOF fix: one owner's `clear` must NOT release another
# owner's pending resources, and the gate must keep blocking `gh pr merge`
# repo-wide while ANY owner has pending stacks (while `git commit` from a
# non-owning tree passes, per issue #1615).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="${HERE}/bughunt-clean-gate.sh"
TRACK="${HERE}/../skills/hunt-bugs/bughunt-track.sh"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }

# ---------------------------------------------------------------------------
# Part 1 — gate hook pass/block behavior
#
# run <name> <arm:none|legacy|dir|owndir|envowner|emptydir> <cmd> <expect_exit> [<want_stderr_substr>]
#
# Arm modes:
#   legacy   - flat `.markgate-bughunt-pending` file (no owner attribution)
#   dir      - per-owner `.d/` with two FOREIGN owner files (owner_a, owner_b)
#   owndir   - per-owner `.d/` with the COMMITTING repo's OWN owner file
#              (key derived exactly as the hook / bughunt-track.sh derive it)
#   envowner - per-owner `.d/` with a file for CDKD_BUGHUNT_OWNER=agent-X;
#              the hook is invoked with that env var set (path-derived key
#              would NOT match, so a block proves the override is honored)
#   emptydir - `.d/` exists but holds no files
# When <want_stderr_substr> is given, the hook's stderr must contain it.
# ---------------------------------------------------------------------------
run() {
  local name="$1" arm="$2" cmd="$3" expect="$4" want_stderr="${5:-}"

  local tmp errfile
  tmp=$(mktemp -d)
  errfile=$(mktemp)
  pushd "$tmp" >/dev/null

  git init -q -b main
  git config user.email t@t
  git config user.name t
  : > seed
  git add -A
  git commit -q -m init

  local hook_env=""
  case "$arm" in
    legacy)
      printf 'CdkdBughuntFoo\nCdkdBughuntBar\n' > "$tmp/.markgate-bughunt-pending"
      ;;
    dir)
      mkdir -p "$tmp/.markgate-bughunt-pending.d"
      printf 'CdkdBughuntFoo\n' > "$tmp/.markgate-bughunt-pending.d/owner_a"
      printf 'CdkdBughuntBar\n' > "$tmp/.markgate-bughunt-pending.d/owner_b"
      ;;
    owndir)
      # Same derivation as the hook: toplevel of the committing tree (git
      # canonicalizes symlinks, e.g. /var -> /private/var on macOS), then the
      # bughunt-track.sh sanitizer.
      local top key
      top="$(git -C "$tmp" rev-parse --show-toplevel)"
      key="$(printf '%s' "$top" | sed 's#[^A-Za-z0-9._-]#_#g')"
      mkdir -p "$tmp/.markgate-bughunt-pending.d"
      printf 'CdkdBughuntOwn\n' > "$tmp/.markgate-bughunt-pending.d/${key}"
      ;;
    envowner)
      mkdir -p "$tmp/.markgate-bughunt-pending.d"
      printf 'CdkdBughuntEnv\n' > "$tmp/.markgate-bughunt-pending.d/agent-X"
      hook_env="agent-X"
      ;;
    emptydir)
      mkdir -p "$tmp/.markgate-bughunt-pending.d"
      ;;
    none) ;;
  esac

  local payload exit_code
  payload="{\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)},\"cwd\":\"$tmp\"}"
  # An empty CDKD_BUGHUNT_OWNER is treated as unset by the hook's `${...:-}`
  # expansion, so passing it unconditionally both injects the envowner
  # override AND shields the other cases from a value leaked in from the
  # outer environment.
  set +e
  printf '%s' "$payload" | CDKD_BUGHUNT_OWNER="$hook_env" bash "$HOOK" >/dev/null 2>"$errfile"
  exit_code=$?
  set -e

  popd >/dev/null
  rm -rf "$tmp"

  if [ "$exit_code" -ne "$expect" ]; then
    bad "$name (got $exit_code, expected $expect)"
  elif [ -n "$want_stderr" ] && ! grep -qF "$want_stderr" "$errfile"; then
    bad "$name (exit $exit_code ok, but stderr lacks '$want_stderr')"
  else
    ok "$name (exit $exit_code)"
  fi
  rm -f "$errfile"
}

# Disarmed: every command passes through.
run "disarmed + git commit passes"        none "git commit -m x"        0
run "disarmed + gh pr merge passes"       none "gh pr merge 5 --squash" 0

# Empty per-owner dir (no files): nothing pending → pass.
run "empty .d/ + git commit passes"       emptydir "git commit -m x"    0

# Armed via LEGACY flat file: no owner attribution → conservative, blocks
# git commit for every caller (and pr create/merge repo-wide).
run "legacy + git commit blocks"          legacy "git commit -m x"        2
run "legacy + git -C commit blocks"       legacy "git -C . commit -m x"   2
run "legacy + gh pr create blocks"        legacy "gh pr create --fill"    2
run "legacy + gh pr merge blocks"         legacy "gh pr merge 5 --squash" 2

# Armed via per-owner .d/ with FOREIGN owners only (issue #1615):
# git commit from a non-owning tree PASSES with a non-blocking stderr notice;
# gh pr create / merge keep blocking repo-wide.
run "foreign owners + git commit passes with notice" dir "git commit -m x" 0 "[bughunt-clean-gate notice]"
run "foreign owners + gh pr create blocks"           dir "gh pr create --fill"    2
run "foreign owners + gh pr merge blocks"            dir "gh pr merge 5 --squash" 2

# A chained command containing BOTH verbs takes the stricter pr path.
run "foreign owners + commit && pr create blocks"    dir "git commit -m x && gh pr create --fill" 2

# Armed via the committing tree's OWN owner file: git commit blocks.
run "own owner + git commit blocks"       owndir "git commit -m x"      2

# CDKD_BUGHUNT_OWNER override: owner file for agent-X + hook invoked with
# CDKD_BUGHUNT_OWNER=agent-X from a repo whose path-derived key differs →
# the override must win and the commit must block.
run "env-owner override + git commit blocks" envowner "git commit -m x" 2

# Armed: non-gated commands still pass.
run "dir + git status passes"             dir "git status"            0
run "dir + git push passes"               dir "git push origin main"  0

# Armed: quoted-body false positives must NOT block (line-start anchoring).
run "dir + echo mentioning git commit"    dir "echo 'run git commit later'"           0
run "dir + echo mentioning gh pr merge"   dir "echo 'remember to gh pr merge soon'"   0

# ---------------------------------------------------------------------------
# Part 2 — bughunt-track.sh per-owner isolation (the SPOF fix)
#
# Two owners arm the gate from the SAME repo (simulating two parallel agents
# in two worktrees). Owner A clears; the gate must still block `gh pr merge`
# because owner B still has a pending stack. This is the regression test for
# the old single-file `clear` that wiped everyone's entries.
#
# The repo-wide probe is `gh pr merge` (NOT `git commit`): since issue #1615
# the commit decision is owner-scoped, so a commit from the repo tree (which
# owns neither agent-A nor agent-B) passes — asserted explicitly below.
# ---------------------------------------------------------------------------
gate_blocks() {
  # gate_blocks <repo-dir> <cmd> → 0 if the gate blocks (exit 2), 1 otherwise
  local dir="$1" cmd="$2" payload ec
  payload="{\"tool_input\":{\"command\":\"$cmd\"},\"cwd\":\"$dir\"}"
  set +e
  printf '%s' "$payload" | CDKD_BUGHUNT_OWNER="" bash "$HOOK" >/dev/null 2>&1
  ec=$?
  set -e
  [ "$ec" -eq 2 ]
}

parallel_test() {
  local tmp
  tmp=$(mktemp -d)
  pushd "$tmp" >/dev/null
  git init -q -b main
  git config user.email t@t
  git config user.name t
  : > seed; git add -A; git commit -q -m init

  # bughunt-track.sh resolves its sentinel root from its OWN location
  # (SCRIPT_DIR -> git-common-dir). To exercise it against THIS temp repo (so
  # the tracker and the cwd-resolving gate agree on the same root), run a COPY
  # of the script placed inside the temp repo's skill path.
  local track="$tmp/.claude/skills/hunt-bugs/bughunt-track.sh"
  mkdir -p "$(dirname "$track")"
  cp "$TRACK" "$track"

  # Owner A and Owner B arm from the same repo (distinct owner keys).
  CDKD_BUGHUNT_OWNER="agent-A" bash "$track" add CdkdBughuntA1 >/dev/null
  CDKD_BUGHUNT_OWNER="agent-B" bash "$track" add CdkdBughuntB1 >/dev/null

  if gate_blocks "$tmp" "gh pr merge 5 --squash"; then ok "both owners armed -> pr merge blocks"; else bad "both owners armed -> pr merge blocks"; fi

  # Owner-scoped commit (issue #1615): the repo tree owns neither pending
  # file, so its commit passes even while both agents are armed.
  if gate_blocks "$tmp" "git commit -m x"; then bad "both owners armed -> non-owner git commit passes"; else ok "both owners armed -> non-owner git commit passes"; fi

  # Owner A clears. The dangerous old behavior would wipe B too.
  CDKD_BUGHUNT_OWNER="agent-A" bash "$track" clear >/dev/null

  if gate_blocks "$tmp" "gh pr merge 5 --squash"; then ok "after A clears, B still pending -> pr merge STILL blocks"; else bad "after A clears, B still pending -> pr merge STILL blocks (SPOF regression!)"; fi

  # A's own list should be empty; B's file must survive.
  if CDKD_BUGHUNT_OWNER="agent-A" bash "$track" list 2>/dev/null | grep -q "CdkdBughuntA1"; then
    bad "A's stacks gone after A clear"
  else
    ok "A's stacks gone after A clear"
  fi
  if [ -s "$tmp/.markgate-bughunt-pending.d/agent-B" ]; then
    ok "B's owner file survived A's clear"
  else
    bad "B's owner file survived A's clear"
  fi

  # Owner B clears -> no owners left -> gate releases.
  CDKD_BUGHUNT_OWNER="agent-B" bash "$track" clear >/dev/null
  if gate_blocks "$tmp" "gh pr merge 5 --squash"; then bad "after both clear -> gate releases"; else ok "after both clear -> gate releases"; fi

  popd >/dev/null
  rm -rf "$tmp"
}

parallel_test

echo
echo "bughunt-clean-gate: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
