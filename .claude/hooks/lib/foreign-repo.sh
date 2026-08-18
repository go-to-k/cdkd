#!/usr/bin/env bash
# lib/foreign-repo.sh — cross-repo gate delegation (issue #1961).
#
# A session's hooks come from ONE repo's .claude/settings.json (whichever
# repo the session was started in), but they fire on EVERY Bash call —
# including commands whose target is a different repository. The gates
# already resolve the TARGET working tree correctly (issue #559, which is
# why `markgate verify` consults the right per-worktree marker store), but
# the hook SCRIPT is still the session's own copy, so the marker lookup is
# target-correct while the policy around it is session-correct. Those two
# disagree exactly when the repos' gate scripts have diverged, which they
# have — each repo's gates evolved separately.
#
# Observed twice on 2026-08-18 while landing the markgate `hash: diff`
# adoption across three repos: a `gh pr create` for cdk-real-drift was
# refused by cdkd's copy of verify-pr-gate, because cdkd's copy has no
# docs/tooling exemption while cdk-real-drift's own copy does and would
# have exempted the diff. The agent correctly refused to route around the
# block and hand-ran cdk-real-drift's checklist instead — right behavior,
# pure waste.
#
# WHY DELEGATE RATHER THAN EARLY-EXIT. The obvious fix is "exit 0 when the
# target is a foreign repo". It is wrong, and the reason is easy to miss:
# the foreign repo's hooks are NOT registered in this session. Silencing
# our copy therefore leaves the command with NO gate at all, which on the
# two incidents above would have skipped the verify-pr requirement rather
# than applying the wrong one — strictly weaker than the status quo. This
# helper instead hands the decision to the target repo's own counterpart
# when it has one, and otherwise keeps current behavior. On no path is it
# weaker than not having this file.

# hook_delegate_if_foreign <target_dir> <hook_basename> <payload>
#
# Returns 1 (caller proceeds with its own policy) when the target is this
# same repo, when the target's repo cannot be determined, or when the
# target has no counterpart for this hook. EXITS the calling script with
# the counterpart's status when it does delegate.
hook_delegate_if_foreign() {
  target_dir="$1"
  hook_name="$2"
  payload="$3"

  # Already one level deep: the counterpart we invoked is itself asking.
  # Refuse to delegate again rather than risk a loop, and let it apply its
  # own policy (it IS the target repo's hook, so that is correct).
  if [ -n "${CDKD_HOOK_DELEGATED:-}" ]; then
    return 1
  fi

  # Identify "this repo" from the library's own location rather than from
  # the cwd, which is the thing under dispute.
  __lib_dir="${BASH_SOURCE[0]%/*}"
  [ "$__lib_dir" = "${BASH_SOURCE[0]}" ] && __lib_dir="."

  # Compare by GIT COMMON DIR, not by toplevel: two worktrees of the same
  # repo have different toplevels but one common dir, and a hook running
  # from `.claude/worktrees/<branch>/` against the main tree (or the other
  # way round) is ordinary same-repo work, not a foreign target.
  own_common=$(git -C "$__lib_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  tgt_common=$(git -C "$target_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)

  # Unknown on either side -> not established as foreign. Fall through to
  # our own policy; never silently pass.
  if [ -z "$own_common" ] || [ -z "$tgt_common" ]; then
    return 1
  fi
  if [ "$own_common" = "$tgt_common" ]; then
    return 1
  fi

  tgt_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null)
  if [ -z "$tgt_top" ]; then
    return 1
  fi

  counterpart="$tgt_top/.claude/hooks/$hook_name"
  if [ ! -x "$counterpart" ]; then
    echo "[${hook_name%.sh}] target repo $tgt_top has no counterpart for this hook;" >&2
    echo "  applying THIS repo's policy to a foreign target (see cdkd issue 1961)." >&2
    return 1
  fi

  # Same file reached by another path (a symlinked checkout): not foreign
  # in any meaningful sense, and exec'ing it would loop.
  if [ "$counterpart" -ef "${BASH_SOURCE[1]:-}" ] 2>/dev/null; then
    return 1
  fi

  echo "[${hook_name%.sh}] target is $tgt_top — delegating to that repo's own copy." >&2
  printf '%s' "$payload" | CDKD_HOOK_DELEGATED=1 "$counterpart"
  __rc=$?

  # 126/127 mean we could not actually run it (not executable after all,
  # bad interpreter). That is not a verdict, so do not report it as one —
  # fall back to our own policy.
  if [ "$__rc" -eq 126 ] || [ "$__rc" -eq 127 ]; then
    echo "[${hook_name%.sh}] counterpart could not be executed (exit $__rc); applying this repo's policy." >&2
    return 1
  fi
  exit "$__rc"
}
