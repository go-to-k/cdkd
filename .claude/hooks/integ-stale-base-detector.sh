#!/usr/bin/env bash
# integ-stale-base-detector.sh — PreToolUse hook (matcher: Bash), NON-BLOCKING.
#
# Warns, before a real-AWS integ fixture is spent, that the branch is behind
# `origin/main` — because a rebase after the run moves the merge base and can
# stale the very marker the run was spent to earn.
#
# WHY (measured 2026-09-04, go-to-k/cdkd#2589):
#
#   `.claude/skills/work-issues/references/verify.md` section 8-b already
#   states the ordering — "dispatch reviewers -> apply EVERY finding including
#   nits -> rebase -> integ", and "A rebase can stale a `hash: diff` marker on
#   its own -- the merge base moves. Rebase BEFORE the integ."
#
#   That run followed it and still paid twice. The reason is that the rule is
#   written as a SEQUENCE while the real shape is a LOOP: six review rounds ran
#   over ~2 h, `main` advanced during them, and the integs (`drift-revert-vpc`,
#   `lambda`) had already been run and their markers set. The rebase onto the
#   advanced `main` moved the merge base past go-to-k/cdkd#2565, which touches
#   `src/provisioning/providers/**`; `markgate verify integ-destroy` went
#   `mismatch`, and `lambda` was re-run against real AWS to re-earn it.
#
#   The re-run was CORRECT — a stateful-guard change arriving from `main`
#   genuinely interacts with the destroy path. What was wrong is that nothing
#   said so at the moment the run was STARTED. The signal appeared later, as a
#   gate refusal that reads like a marker expiring at random.
#
# WHY HERE AND NOT AT `markgate set`
#
#   The obvious placement is next to the marker write, and it is the wrong one:
#   by then the AWS run is already spent, so the warning can only tell you the
#   money is gone. This hook fires on the fixture INVOCATION, which is the last
#   moment a rebase is still free.
#
# WHY NON-BLOCKING
#
#   A maintainer-driven run on a deliberately old base is legitimate (bisecting
#   a regression, reproducing an issue against a released tree), and a hard
#   refusal there would cost more than the waste it prevents. This hook is a
#   discipline aid, not a safety boundary — it exits 0 always, and its only
#   effect is text on stderr. Compare `integ-destroy-gate.sh`, which DOES block:
#   that one guards the merge, where being wrong is unrecoverable.
#
# NOISE CONTROL
#
#   Only fires for a command that actually runs an integ fixture. `git` /
#   `grep` / editor commands exit immediately, and so does a `verify.sh`
#   mentioned inside a heredoc or an `echo`.

set -u

input=$(cat 2>/dev/null || true)

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[ "$tool" = "Bash" ] || exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# The invocation shapes /run-integ actually uses. Deliberately narrow: a
# `verify.sh` named in prose, in an `echo`, or as a `grep` target must not
# trigger this. Requiring the fixture-running verbs (`bash`/`sh`, or a
# `tests/integration/` path) is what keeps it quiet.
printf '%s' "$cmd" | grep -qE '(bash|sh)[[:space:]]+[^|;&]*verify\.sh|tests/integration/[^[:space:]]*/verify\.sh' || exit 0
# `grep -n verify.sh`, `cat .../verify.sh`, `ls`: reading a fixture is not
# running one.
printf '%s' "$cmd" | grep -qE '^[[:space:]]*(grep|rg|cat|less|head|tail|ls|wc|sed -n)[[:space:]]' && exit 0

cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
[ -n "$cwd" ] || cwd=$PWD
[ -d "$cwd" ] || exit 0

# Opt-in: only in a repo that uses markgate, matching issue-dup-check-gate.sh's
# convention. Without markgate there is no `hash: diff` marker to stale, so the
# warning would be noise.
top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$top" ] || exit 0
[ -f "$top/.markgate.yml" ] || exit 0

# NO `git fetch` here. A PreToolUse hook runs on every matching Bash call and
# must stay fast and side-effect-free; a fetch would add network latency to the
# critical path and mutate refs behind the user. The trade is that this reads
# the LAST-FETCHED `origin/main`, so it under-reports when the local ref is
# itself stale — under-reporting is the safe direction for a non-blocking
# nudge, and the run that motivated this had fetched minutes earlier.
git -C "$cwd" rev-parse --verify --quiet origin/main >/dev/null 2>&1 || exit 0

behind=$(git -C "$cwd" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
case "$behind" in ''|*[!0-9]*) exit 0 ;; esac
[ "$behind" -gt 0 ] || exit 0

branch=$(git -C "$cwd" branch --show-current 2>/dev/null || true)
[ -n "$branch" ] || branch='(detached HEAD)'

# In-scope commits are what make this expensive rather than merely untidy: a
# doc-only advance on main will not stale an integ marker. Naming them turns a
# generic nudge into a judgement the reader can make.
scope_re='^src/provisioning/providers/|^src/provisioning/(cloud-control-provider|region-check)\.ts$|^src/cli/commands/(destroy|destroy-runner|deploy)\.ts$|^src/deployment/(deploy-engine|retry|retryable-errors|rollback-executor|intrinsic-function-resolver)\.ts$|^src/analyzer/(dag-builder|template-parser|implicit-delete-deps|lambda-vpc-deps)\.ts$|^src/provisioning/register-providers\.ts$'
in_scope=$(git -C "$cwd" diff --name-only HEAD...origin/main 2>/dev/null | grep -cE "$scope_re" || true)
case "$in_scope" in ''|*[!0-9]*) in_scope=0 ;; esac

{
  echo "NOTE integ-stale-base-detector: '$branch' is $behind commit(s) behind origin/main."
  if [ "$in_scope" -gt 0 ]; then
    echo "  $in_scope of those commits touch integ-gate scope (providers / destroy / deploy-engine / analyzer)."
    echo "  A rebase after this run WILL move the merge base and can stale the"
    echo "  integ-destroy / integ-broad marker this run is about to earn, costing"
    echo "  a second real-AWS run. Rebase FIRST, then run this once."
  else
    echo "  None of them touch integ-gate scope, so the marker will probably survive"
    echo "  a rebase — but the suite and the built binary are still from an older base."
  fi
  echo "  See .claude/skills/work-issues/references/verify.md section 8-b."
  echo "  Deliberately running against an older base (a bisect, a repro)? Ignore this."
} >&2

exit 0
