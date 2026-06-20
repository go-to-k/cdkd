#!/usr/bin/env bash
#
# bughunt-track.sh — arm / verify / release the bug-hunt cleanup gate.
#
# The /hunt-bugs skill deploys real AWS resources. To make "always destroy them"
# a structural guarantee (not a matter of remembering), every deployed stack is
# tracked in a gitignored sentinel file. The `bughunt-clean` markgate gate
# (.claude/hooks/bughunt-clean-gate.sh) blocks `git commit` / `gh pr create` /
# `gh pr merge` while that sentinel is non-empty — so a bug-hunt session cannot
# land any commit until its resources are destroyed and verified gone.
#
# Subcommands:
#   add <Stack> [<Stack> ...]   Record stacks about to be deployed (arms gate).
#   verify [--state-bucket B] [--region R]
#                               Assert each tracked stack's state.json is GONE
#                               from S3 (i.e. destroy succeeded). Non-zero exit
#                               if any remain. Does NOT clear the sentinel.
#   clear                       Empty the sentinel (releases the gate). Run ONLY
#                               after destroy + orphan-zero is verified.
#   list                        Print the currently-tracked stacks.
#
# The sentinel lives at the repo root so the gate (which runs from the main
# tree) and this script agree on its path regardless of cwd.

set -euo pipefail

# Resolve the sentinel at the SHARED main-tree root so the deploy-time tracker
# (often run from the main tree) and the gate hook (which may run from a feature
# worktree where the fix is committed) agree on one path. `--git-common-dir`
# points every linked worktree at the main `.git`, so its parent is the main
# working tree root regardless of which worktree this runs in.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_COMMON_DIR="$(git -C "${SCRIPT_DIR}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "${GIT_COMMON_DIR}" ]; then
  REPO_ROOT="$(dirname "${GIT_COMMON_DIR}")"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
SENTINEL="${REPO_ROOT}/.markgate-bughunt-pending"

cmd="${1:-}"
shift || true

case "${cmd}" in
  add)
    if [ "$#" -eq 0 ]; then
      echo "usage: bughunt-track.sh add <Stack> [<Stack> ...]" >&2
      exit 2
    fi
    touch "${SENTINEL}"
    for stack in "$@"; do
      if ! grep -qxF "${stack}" "${SENTINEL}" 2>/dev/null; then
        echo "${stack}" >>"${SENTINEL}"
      fi
    done
    echo "tracked $# stack(s); bughunt-clean gate is now ARMED"
    ;;

  list)
    if [ -s "${SENTINEL}" ]; then
      cat "${SENTINEL}"
    else
      echo "(no tracked stacks)"
    fi
    ;;

  verify)
    state_bucket=""
    region="${AWS_REGION:-us-east-1}"
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --state-bucket) state_bucket="$2"; shift 2 ;;
        --region) region="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
      esac
    done
    if [ -z "${state_bucket}" ]; then
      account="$(aws sts get-caller-identity --query Account --output text)"
      state_bucket="cdkd-state-${account}"
    fi
    if [ ! -s "${SENTINEL}" ]; then
      echo "no tracked stacks — nothing to verify"
      exit 0
    fi
    fail=0
    while IFS= read -r stack; do
      [ -z "${stack}" ] && continue
      key="cdkd/${stack}/${region}/state.json"
      if aws s3api head-object --bucket "${state_bucket}" --key "${key}" >/dev/null 2>&1; then
        echo "STILL PRESENT: s3://${state_bucket}/${key} — stack ${stack} not destroyed" >&2
        fail=1
      else
        echo "ok: ${stack} state.json is gone"
      fi
    done <"${SENTINEL}"
    if [ "${fail}" -ne 0 ]; then
      echo "verify FAILED — destroy the remaining stacks before clearing the gate" >&2
      exit 1
    fi
    echo "verify OK — every tracked stack's state.json is gone"
    ;;

  clear)
    rm -f "${SENTINEL}"
    echo "sentinel cleared; bughunt-clean gate is now RELEASED"
    ;;

  *)
    echo "usage: bughunt-track.sh {add|verify|clear|list} ..." >&2
    exit 2
    ;;
esac
