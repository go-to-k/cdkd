#!/usr/bin/env bash
# ci-green-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` unless EVERY GitHub Actions
# check on the target PR is green (`pass`) or `skipping`. A `fail`,
# `pending`, `queued`, or "no checks reported" state blocks the merge.
#
# Why: PR #1231 (2026-07-27) was merged while `check-build-test` was
# FAILED — the merge command was chained after a `gh pr checks`
# DISPLAY, so the red status was printed but nothing gated on it, and
# main went red until fix-forward PR #1232. Every other merge-critical
# invariant here is enforced by a gate (markgate markers for
# verify-pr / pr-review / integ-*); CI greenness was the one
# merge-blocking fact left to eyeballs. CI status is LIVE external
# state, so this is a stateless live-query hook (like
# pr-review-gate.sh), not a digest-bound markgate marker — a marker
# would go stale the moment a new commit lands, but could never
# capture "the checks that exist RIGHT NOW all pass".
#
# Pending is blocked (not just fail): merging before checks settle is
# exactly the #1231 shape. Wait for CI (`gh pr checks <N> --watch`),
# then re-run the merge.
#
# Escape hatch: CDKD_SKIP_CI_GREEN_GATE=1 in the command environment
# (for a repo with genuinely no CI configured, where "no checks
# reported" would block forever). Do not use it to merge a red PR.
#
# Infra posture: `gh` transport errors fail OPEN (an unrelated GitHub
# outage should not block merges); a successful `gh pr checks` answer
# is enforced strictly.

# Shared command-position matcher (issue #1455): catches the guarded verb
# after ANY chained command (`git push && gh pr create`), not just after an
# optional leading `cd`. See .claude/hooks/lib/command-match.sh.
# shellcheck source=lib/command-match.sh
__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash verify-pr-gate.sh` from inside the hooks dir), which would look for
# `<script-name>/lib/...`. Fall back to the cwd in that case.
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F strip_noncommand_spans >/dev/null; then
  # FAIL CLOSED. Without the helper `cmd_matches_verb` is undefined, the
  # `if ! cmd_matches_verb ...` guard below sees exit 127 (truthy for `!`),
  # and the hook would `exit 0` -- silently disabling the gate, which is the
  # exact failure mode this file exists to prevent. Refuse instead.
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unloadable," >&2
  echo "so this gate cannot evaluate the command. Restore the file; do not" >&2
  echo "work around the gate." >&2
  exit 2
fi

set -u

input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! cmd_matches_verb "$cmd" '(CDKD_SKIP_CI_GREEN_GATE=1[[:space:]]+)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

# Documented escape hatch for no-CI repos.
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])CDKD_SKIP_CI_GREEN_GATE=1([[:space:]]|$)'; then
  echo "ci-green-gate: CDKD_SKIP_CI_GREEN_GATE=1 set; skipping CI-green enforcement" >&2
  exit 0
fi

# Resolve the directory the gh command will run in (cwd-aware, #559).
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
__verb_ere='(CDKD_SKIP_CI_GREEN_GATE=1[[:space:]]+)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])'
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "ci-green-gate" "${hook_cwd:-$PWD}"
fi

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi
cd "$target_dir" 2>/dev/null || exit 0

# --- Parse the PR number (same token walk as pr-review-gate.sh). -------
pr_number=""
args="${cmd##*gh pr merge}"
# shellcheck disable=SC2086
set -- $args
while [ $# -gt 0 ]; do
  case "$1" in
    --*=*) shift; continue ;;
    --auto|--admin|--delete-branch|--squash|--merge|--rebase)
      shift; continue ;;
    -*)
      shift
      [ $# -gt 0 ] && shift
      continue
      ;;
    *)
      if printf '%s' "$1" | grep -qE '^[0-9]+$'; then
        pr_number="$1"
        break
      fi
      shift
      ;;
  esac
done

# --- Query live check status. ------------------------------------------
# `gh pr checks` exit codes: 0 = all passed, 1 = some failed/skipped,
# 8 = checks pending, other = infra/arg errors. We inspect the tab-
# separated status column instead of relying on the exit code so
# `skipping` rows (exit 1 territory) don't false-block.
if [ -n "$pr_number" ]; then
  checks_out=$(gh pr checks "$pr_number" 2>&1)
else
  checks_out=$(gh pr checks 2>&1)
fi
checks_rc=$?

if printf '%s' "$checks_out" | grep -qiE 'no checks reported'; then
  cat >&2 <<EOF
Blocked by ci-green-gate: no CI checks are reported on this PR yet.

Merging before checks register is the PR #1231 failure shape (merged
while check-build-test was red; main stayed red until fix-forward
#1232). Wait for CI to start, watch it finish, then merge:

  gh pr checks ${pr_number:-<PR>} --watch
  # merge only after every check reports pass/skipping

If this repo genuinely has no CI, bypass explicitly:
  CDKD_SKIP_CI_GREEN_GATE=1 gh pr merge ${pr_number:-<PR>} --squash --delete-branch
EOF
  exit 2
fi

# Infra fail-open: transport/auth errors (not a parsable checks table).
if [ "$checks_rc" -gt 1 ] && [ "$checks_rc" -ne 8 ]; then
  printf 'ci-green-gate: gh pr checks failed (rc=%s); allowing merge (infra fail-open)\n' "$checks_rc" >&2
  exit 0
fi

# Status is column 2 of the tab-separated output.
not_green=$(printf '%s\n' "$checks_out" | awk -F'\t' 'NF >= 2 && $2 != "pass" && $2 != "skipping" {print $1 " -> " $2}')

if [ -n "$not_green" ]; then
  cat >&2 <<EOF
Blocked by ci-green-gate: PR ${pr_number:-(current branch)} has checks that are not green:

$not_green

Merging with red or pending CI is the PR #1231 incident shape (merged
while check-build-test was FAILED; main went red until fix-forward
#1232). Required action:

  gh pr checks ${pr_number:-<PR>} --watch   # wait for every check to settle
  # if a check FAILED: fix it on the branch (or fix-forward is no longer
  # needed - the merge never happened), push, wait for green, then merge.

Do NOT chain the merge after a checks DISPLAY - this gate exists
because the printed red status was scrolled past once already.
EOF
  exit 2
fi

exit 0
