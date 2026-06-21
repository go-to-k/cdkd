#!/usr/bin/env bash
# Smoke tests for bughunt-clean-gate.sh + bughunt-track.sh (parallel-safe
# per-owner sentinel).
#
# Part 1 sets up a throwaway git repo, arms the bug-hunt sentinel (legacy flat
# file OR the per-owner `.d/` directory), runs the hook against simulated tool
# input, and asserts the expected pass (0) / block (2) behavior.
#
# Part 2 drives bughunt-track.sh directly with distinct CDKD_BUGHUNT_OWNER
# values to prove the SPOF fix: one owner's `clear` must NOT release another
# owner's pending resources, and the gate must keep blocking while ANY owner
# has pending stacks.

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
# run <name> <arm:none|legacy|dir|emptydir> <cmd> <expect_exit>
# ---------------------------------------------------------------------------
run() {
  local name="$1" arm="$2" cmd="$3" expect="$4"

  local tmp
  tmp=$(mktemp -d)
  pushd "$tmp" >/dev/null

  git init -q -b main
  git config user.email t@t
  git config user.name t
  : > seed
  git add -A
  git commit -q -m init

  case "$arm" in
    legacy)
      printf 'CdkdBughuntFoo\nCdkdBughuntBar\n' > "$tmp/.markgate-bughunt-pending"
      ;;
    dir)
      mkdir -p "$tmp/.markgate-bughunt-pending.d"
      printf 'CdkdBughuntFoo\n' > "$tmp/.markgate-bughunt-pending.d/owner_a"
      printf 'CdkdBughuntBar\n' > "$tmp/.markgate-bughunt-pending.d/owner_b"
      ;;
    emptydir)
      mkdir -p "$tmp/.markgate-bughunt-pending.d"
      ;;
    none) ;;
  esac

  local payload exit_code
  payload="{\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)},\"cwd\":\"$tmp\"}"
  set +e
  printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1
  exit_code=$?
  set -e

  popd >/dev/null
  rm -rf "$tmp"

  if [ "$exit_code" -eq "$expect" ]; then
    ok "$name (exit $exit_code)"
  else
    bad "$name (got $exit_code, expected $expect)"
  fi
}

# Disarmed: every command passes through.
run "disarmed + git commit passes"        none "git commit -m x"        0
run "disarmed + gh pr merge passes"       none "gh pr merge 5 --squash" 0

# Empty per-owner dir (no files): nothing pending → pass.
run "empty .d/ + git commit passes"       emptydir "git commit -m x"    0

# Armed via LEGACY flat file: gated commands block.
run "legacy + git commit blocks"          legacy "git commit -m x"        2
run "legacy + git -C commit blocks"       legacy "git -C . commit -m x"   2
run "legacy + gh pr create blocks"        legacy "gh pr create --fill"    2
run "legacy + gh pr merge blocks"         legacy "gh pr merge 5 --squash" 2

# Armed via per-owner .d/ directory (two owners): gated commands block.
run "dir + git commit blocks"             dir "git commit -m x"        2
run "dir + gh pr create blocks"           dir "gh pr create --fill"    2
run "dir + gh pr merge blocks"            dir "gh pr merge 5 --squash" 2

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
# in two worktrees). Owner A clears; the gate must still block because owner B
# still has a pending stack. This is the regression test for the old
# single-file `clear` that wiped everyone's entries.
# ---------------------------------------------------------------------------
gate_blocks() {
  # gate_blocks <repo-dir> → 0 if the gate blocks (exit 2), 1 otherwise
  local dir="$1" payload ec
  payload="{\"tool_input\":{\"command\":\"git commit -m x\"},\"cwd\":\"$dir\"}"
  set +e
  printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1
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

  if gate_blocks "$tmp"; then ok "both owners armed -> gate blocks"; else bad "both owners armed -> gate blocks"; fi

  # Owner A clears. The dangerous old behavior would wipe B too.
  CDKD_BUGHUNT_OWNER="agent-A" bash "$track" clear >/dev/null

  if gate_blocks "$tmp"; then ok "after A clears, B still pending -> gate STILL blocks"; else bad "after A clears, B still pending -> gate STILL blocks (SPOF regression!)"; fi

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
  if gate_blocks "$tmp"; then bad "after both clear -> gate releases"; else ok "after both clear -> gate releases"; fi

  popd >/dev/null
  rm -rf "$tmp"
}

parallel_test

echo
echo "bughunt-clean-gate: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
