#!/usr/bin/env bash
#
# bughunt-track.sh — arm / verify / release the bug-hunt cleanup gate.
#
# The /hunt-bugs skill deploys real AWS resources. To make "always destroy them"
# a structural guarantee (not a matter of remembering), every deployed stack is
# tracked in a gitignored sentinel. The `bughunt-clean` markgate gate
# (.claude/hooks/bughunt-clean-gate.sh) blocks `git commit` / `gh pr create` /
# `gh pr merge` while ANY tracked stack remains — so a bug-hunt session cannot
# land any commit until its resources are destroyed and verified gone.
#
# PARALLEL-SAFE DESIGN (per-owner files):
#   The sentinel is NOT a single shared file. It is a directory
#   `.markgate-bughunt-pending.d/` containing ONE file per owner
#   (`<owner-key>`), each listing that owner's pending stacks. This makes
#   concurrent bug hunts (multiple agents / worktrees) safe:
#     * `add` / `verify` / `clear` operate ONLY on the caller's own owner file,
#       so one agent's `clear` can NEVER release another agent's pending
#       resources (the old single-file `rm -f` wiped everyone's — a real SPOF).
#     * The gate blocks while ANY owner file is non-empty (conservative: a
#       shared repo should not accept a commit while any hunt has live
#       resources). So if owners cross-contend, the failure mode is over-block
#       (safe), never premature release (dangerous).
#   No file locking is needed: each owner writes only its own file, and append
#   (`>>`) is atomic for the small writes involved. This also dodges the macOS
#   lack of `flock` (see feedback_macos_bsd_grep_date_portability).
#
# OWNER KEY:
#   Derived from $CDKD_BUGHUNT_OWNER if set (explicit override — use this to pin
#   one identity across add/verify/clear when they may run from different
#   working trees), else from the per-worktree toplevel path
#   (`git rev-parse --show-toplevel`). Parallel agents working in their own
#   `.claude/worktrees/<branch>/` worktrees therefore get distinct owners
#   automatically. Keep all of one hunt's add/verify/clear calls in the SAME
#   working tree (or set CDKD_BUGHUNT_OWNER) so they agree on the owner.
#
# Subcommands:
#   add <Stack> [<Stack> ...]   Record stacks about to be deployed (arms gate).
#   verify [--state-bucket B] [--region R]
#                               Assert each of THIS OWNER's tracked stacks'
#                               state.json is GONE from S3 (i.e. destroy
#                               succeeded). Non-zero exit if any remain. Does
#                               NOT clear the sentinel.
#   clear                       Remove THIS OWNER's stacks (releases the gate
#                               once no owner has pending stacks). Run ONLY
#                               after destroy + orphan-zero is verified.
#   list [--all]                Print this owner's tracked stacks (or, with
#                               --all, every owner's, prefixed by owner key).
#
# The sentinel dir lives at the SHARED main-tree root so the gate (which may run
# from a feature worktree) and this script agree on its path regardless of cwd.

set -euo pipefail

# Resolve the sentinel dir at the SHARED main-tree root so the deploy-time
# tracker and the gate hook (which may run from a feature worktree where the fix
# is committed) agree on one path. `--git-common-dir` points every linked
# worktree at the main `.git`, so its parent is the main working tree root
# regardless of which worktree this runs in.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_COMMON_DIR="$(git -C "${SCRIPT_DIR}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "${GIT_COMMON_DIR}" ]; then
  REPO_ROOT="$(dirname "${GIT_COMMON_DIR}")"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
PENDING_DIR="${REPO_ROOT}/.markgate-bughunt-pending.d"
# Legacy single-file sentinel (pre per-owner). Still honored by the gate and
# cleared by this owner's `clear` so an in-flight upgrade does not strand it.
LEGACY_SENTINEL="${REPO_ROOT}/.markgate-bughunt-pending"

# Resolve this caller's owner key. Explicit override wins; else the per-worktree
# toplevel (distinct per parallel worktree). Sanitize to a safe filename.
owner_raw="${CDKD_BUGHUNT_OWNER:-}"
if [ -z "${owner_raw}" ]; then
  owner_raw="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
OWNER_KEY="$(printf '%s' "${owner_raw}" | sed 's#[^A-Za-z0-9._-]#_#g')"
OWNER_FILE="${PENDING_DIR}/${OWNER_KEY}"

cmd="${1:-}"
shift || true

case "${cmd}" in
  add)
    if [ "$#" -eq 0 ]; then
      echo "usage: bughunt-track.sh add <Stack> [<Stack> ...]" >&2
      exit 2
    fi
    mkdir -p "${PENDING_DIR}"
    for stack in "$@"; do
      if ! grep -qxF "${stack}" "${OWNER_FILE}" 2>/dev/null; then
        echo "${stack}" >>"${OWNER_FILE}"
      fi
    done
    echo "tracked $# stack(s) under owner '${OWNER_KEY}'; bughunt-clean gate is now ARMED"
    ;;

  list)
    if [ "${1:-}" = "--all" ]; then
      found=0
      if [ -d "${PENDING_DIR}" ]; then
        for f in "${PENDING_DIR}"/*; do
          [ -e "${f}" ] || continue
          [ -s "${f}" ] || continue
          found=1
          while IFS= read -r stack; do
            [ -z "${stack}" ] && continue
            echo "$(basename "${f}")	${stack}"
          done <"${f}"
        done
      fi
      if [ -s "${LEGACY_SENTINEL}" ]; then
        found=1
        while IFS= read -r stack; do
          [ -z "${stack}" ] && continue
          echo "(legacy)	${stack}"
        done <"${LEGACY_SENTINEL}"
      fi
      [ "${found}" -eq 0 ] && echo "(no tracked stacks)"
    else
      if [ -s "${OWNER_FILE}" ]; then
        cat "${OWNER_FILE}"
      else
        echo "(no tracked stacks for owner '${OWNER_KEY}')"
      fi
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
    if [ ! -s "${OWNER_FILE}" ]; then
      echo "no tracked stacks for owner '${OWNER_KEY}' — nothing to verify"
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
    done <"${OWNER_FILE}"
    if [ "${fail}" -ne 0 ]; then
      echo "verify FAILED — destroy the remaining stacks before clearing the gate" >&2
      exit 1
    fi
    echo "verify OK — every tracked stack's state.json is gone for owner '${OWNER_KEY}'"
    ;;

  clear)
    # Remove ONLY this owner's pending file — never other owners' (the whole
    # point of the per-owner design). Also drop the legacy single-file sentinel
    # if present, since in a single-agent upgrade it is this owner's.
    rm -f "${OWNER_FILE}" "${LEGACY_SENTINEL}"
    # Tidy the dir if no owners remain (cosmetic; gate treats empty/absent same).
    if [ -d "${PENDING_DIR}" ] && [ -z "$(ls -A "${PENDING_DIR}" 2>/dev/null)" ]; then
      rmdir "${PENDING_DIR}" 2>/dev/null || true
    fi
    echo "cleared owner '${OWNER_KEY}'; bughunt-clean gate releases once no owner has pending stacks"
    ;;

  *)
    echo "usage: bughunt-track.sh {add|verify|clear|list} ..." >&2
    exit 2
    ;;
esac
