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
#   Only fires for a command that actually runs an integ fixture, and BOTH
#   halves of that decision are made PER SEGMENT, through the shared
#   `gate_segments`. A whole-command version of this shipped first and had a
#   measured hole in the disarming direction: the read-verb test matched a read
#   ANYWHERE in the command and then `exit 0`ed the WHOLE command, so an
#   ordinary chained invocation went silent (measured 2026-09-05, all four
#   against a fixture behind by one in-scope commit):
#
#     bash tests/integration/demo/verify.sh                 WARN   (correct)
#     git status && bash tests/integration/demo/verify.sh   SILENT (wrong)
#     echo start && bash tests/integration/demo/verify.sh   SILENT (wrong)
#     cat README.md && bash .../verify.sh                   SILENT (wrong)
#     ls && node ../../../dist/cli.js deploy --all          SILENT (wrong)
#
#   Every one of those is a shape a real run writes, and a warn hook that goes
#   quiet on the commands people actually type is indistinguishable from one
#   that is working. So: WARN when ANY segment runs a fixture, and let a read
#   verb suppress only the SEGMENT it leads. `git diff .../verify.sh` and
#   `cat .../verify.sh` still stay silent, alone or chained, because there the
#   reading segment is the only one that arms.
#
#   The segmenter is the shared one rather than a local splitter -- it already
#   handles quoted spans, heredoc bodies, `$(...)` and `bash -c`, and it strips
#   leading `env` / `time` / `sudo` wrappers, so the read-verb test can anchor
#   at the segment start instead of hunting for command position. A path inside
#   an arbitrary quoted string remains a KNOWN false positive costing a stray
#   note, not a block.

set -u

# The library is loaded for `gate_segments`. NON-BLOCKING even here: unlike the
# gates, this hook refuses nothing, so `exit 2` on an unloadable library would
# stop a run it only observes. Exiting 0 loses a nudge, which is the same cost
# as the hook not existing.
__hook_dir="${BASH_SOURCE[0]%/*}"
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
# shellcheck source=lib/command-match.sh
. "$__hook_dir/lib/command-match.sh" 2>/dev/null || exit 0
declare -F gate_segments >/dev/null || exit 0

input=$(cat 2>/dev/null || true)

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[ "$tool" = "Bash" ] || exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# The invocation shapes /run-integ actually uses. There are TWO, and covering
# only the first left the hook silent for four of the nine broad-set fixtures:
#
#   verify.sh flow -- `bash tests/integration/<name>/verify.sh`
#   STANDARD flow  -- `node ../../../dist/cli.js deploy ...`, for a fixture with
#                     no verify.sh at all: bench-cdk-sample, microservices,
#                     multi-resource, multi-stack-deps (re-derive with
#                     `ls tests/integration/<n>/verify.sh`, do not trust this list)
#
# Those four are exactly the runs that refresh `integ-broad`, the marker this
# hook exists to protect, so arming only on `verify.sh` missed the cases with
# the most to lose.
# `(^|[[:space:]])` before `(bash|sh)`, not a bare `(bash|sh)`: unanchored, the
# `sh` alternative matched the TAIL of an unrelated word, so
# `./scripts/finish verify.sh` armed the hook. `(^|[[:space:]])` on `(node|cdkd)`
# for the same reason.
#
# The last alternative was `(^|[|;&]|&&)[[:space:]]*cdkd ...` and is now a plain
# `^`. Two things changed: a segment has no separators left in it, and the `&&`
# branch was DEAD anyway -- ERE alternation tries `[|;&]` first, which matches a
# single `&`, and the second `&` of a `&&` is itself a valid start, so `&&` was
# never reached.
ARM_RE='(^|[[:space:]])(bash|sh)[[:space:]]+[^|;&]*verify\.sh'
ARM_RE="$ARM_RE"'|tests/integration/[^[:space:]]*/verify\.sh'
ARM_RE="$ARM_RE"'|(^|[[:space:]])(node|cdkd)[[:space:]]+[^|;&]*(dist/)?cli\.js[[:space:]]+(deploy|destroy)'
ARM_RE="$ARM_RE"'|^cdkd[[:space:]]+(deploy|destroy)([[:space:]]|$)'

# Reading a fixture is not running one -- but only in the SEGMENT that reads it.
# `sed -n` is in the list because an earlier revision kept two read-verb lines
# and only the `^`-anchored one reached it, so `cd x && sed -n 1,5p .../verify.sh`
# WARNED while the bare form was silent. Anchored at the segment start, which
# `gate_strip_prefix` has already cleared of `env` / `time` / `sudo` wrappers
# and leading whitespace.
# `git commit` is in the list for a different reason than the others: a commit
# MESSAGE routinely names the fixture the commit is about
# (`git commit -m "run tests/integration/x/verify.sh"`), and ARM_RE's bare-path
# alternative matches inside it, so the hook printed a NOTE about a run that is
# not happening. Noise only -- this hook never blocks -- but a warn hook that
# cries wolf is one people stop reading.
READ_RE='^(grep|rg|cat|less|head|tail|ls|wc|echo|sed[[:space:]]+-n|git[[:space:]]+(diff|log|show|add|status|commit))([[:space:]]|$)'

# Both tests are written as `if`, never `<cmd> && continue`: a trailing false
# test as the last statement of a loop body is the shape that aborts the whole
# construct under a caller's `set -e`, and this file documents that class for
# `gate_segments` itself.
armed=0
while IFS= read -r seg; do
  if ! printf '%s' "$seg" | grep -qE "$ARM_RE"; then
    continue
  fi
  if printf '%s' "$seg" | grep -qE "$READ_RE"; then
    continue
  fi
  armed=1
  break
done < <(gate_segments "$cmd")
[ "$armed" = "1" ] || exit 0

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

# In-scope FILES are what make this expensive rather than merely untidy: a
# doc-only advance on main will not stale an integ marker. Naming them turns a
# generic nudge into a judgement the reader can make.
#
# This counts FILES, not commits, and the message says so -- an earlier
# revision computed `--name-only | grep -c` and then printed "N of those
# COMMITS", so one commit touching five provider files reported "5 of those
# commits" against a "1 commit(s) behind" line one line above.
scope_re='^src/provisioning/providers/|^src/provisioning/(cloud-control-provider|region-check)\.ts$|^src/cli/commands/(destroy|destroy-runner|deploy)\.ts$|^src/deployment/(deploy-engine|retry|retryable-errors|rollback-executor|intrinsic-function-resolver)\.ts$|^src/analyzer/(dag-builder|template-parser|implicit-delete-deps|lambda-vpc-deps)\.ts$|^src/provisioning/register-providers\.ts$'
in_scope=$(git -C "$cwd" diff --name-only HEAD...origin/main 2>/dev/null | grep -cE "$scope_re" || true)
case "$in_scope" in ''|*[!0-9]*) in_scope=0 ;; esac

{
  echo "NOTE integ-stale-base-detector: '$branch' is $behind commit(s) behind origin/main."
  if [ "$in_scope" -gt 0 ]; then
    echo "  $in_scope in-scope file(s) arrive with them (providers / destroy / deploy-engine / analyzer)."
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
