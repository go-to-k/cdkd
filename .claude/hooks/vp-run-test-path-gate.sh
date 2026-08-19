#!/usr/bin/env bash
# vp-run-test-path-gate.sh
#
# PreToolUse hook. Blocks `vp run test <path>` and steers the caller to
# `vp test run <path>`.
#
# WHY: `vp run test` goes through the Vite+ TASK runner, and the `test`
# task participates in `run.cache.tasks`. A repeat invocation with the
# same inputs REPLAYS the previous result instead of executing, printing
# `◉ cache hit, replaying` and the earlier run's counts and duration.
# For an ordinary test run that is a feature. For a MUTATION PROBE it is
# a correctness hazard of the worst kind: the probe edits a file the task
# hash does not cover, the runner replays the pre-mutation verdict, and
# the probe reports PASS having executed nothing. A probe that cannot
# fail is indistinguishable from a guard that works, so the failure is
# silent by construction.
#
# Measured in this repo 2026-08-20 (issue #2050 / #2006 / #1975 lanes):
# a reviewer's four probes reported PASS without executing, and a repeat
# of `vp run test tests/unit/cli/version.test.ts` printed
# `$ vp test run tests/unit/cli/version.test.ts ◉ cache hit, replaying`
# with byte-identical counts and a byte-identical 122ms duration.
#
# `vp test run <path>` is the command the task delegates to, invoked
# directly, so it bypasses the task cache and always executes.
#
# SCOPE: only the form carrying a PATH ARGUMENT. A bare `vp run test`
# (the whole suite, which the gate flow legitimately runs and caches)
# passes through, as does any other `vp run <task>`. Flags alone are not
# paths — `vp run test --coverage` passes.
#
# There is no bypass marker: the replacement is a word-order change and
# runs the same underlying command.

set -u

# shellcheck source=lib/command-match.sh
LIB_DIR="${BASH_SOURCE[0]%/*}"
[ "$LIB_DIR" = "${BASH_SOURCE[0]}" ] && LIB_DIR="."
if ! . "$LIB_DIR/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null 2>&1; then
  # Fail CLOSED, matching the blocking gates: a missing library must not
  # silently disable the check.
  echo "Blocked by vp-run-test-path-gate: cannot load lib/command-match.sh" >&2
  exit 2
fi

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# Command-position match only, so a quoted mention of the command in a
# commit message or a PR body does not fire the gate.
# `test` must END the task name. `\b` would treat `:` as a boundary and
# fire on the SIBLING task `vp run test:once-leak`, which is a different
# task and is not cached the same way — caught by this hook's own suite.
if ! cmd_matches_verb "$cmd" 'vp[[:space:]]+run[[:space:]]+test([[:space:]]|$)'; then
  exit 0
fi

# Re-read the matched invocation from the RAW command: the neutralised
# text replaces quoted spans with a placeholder, and a quoted path would
# then look like a bare token. Take the text after the LAST occurrence,
# which is the one a chained command ends on.
tail_text=${cmd##*vp run test}

# The split above can land inside a LONGER task name (`vp run test:once-leak`
# splits to `:once-leak`), so anything not starting with whitespace is a
# different task and never this gate's business.
case "$tail_text" in
  '' | [[:space:]]*) ;;
  *) exit 0 ;;
esac

# Stop at the first control operator so a following command's arguments
# are not mistaken for this one's.
tail_text=${tail_text%%&&*}
tail_text=${tail_text%%||*}
tail_text=${tail_text%%;*}
tail_text=${tail_text%%|*}

# A PATH argument is any token that is not a flag and not a flag VALUE.
# `--reporter json` must not read `json` as a path, so a token following
# a value-taking flag is skipped.
has_path=0
skip_next=0
for tok in $tail_text; do
  if [ "$skip_next" = "1" ]; then
    skip_next=0
    continue
  fi
  case "$tok" in
    --*=*) ;;
    -*)
      # Conservatively assume a long flag may take a separate value.
      case "$tok" in
        --reporter | --outputFile | --config | --root | --shard | --project) skip_next=1 ;;
      esac
      ;;
    *)
      has_path=1
      break
      ;;
  esac
done

[ "$has_path" = "1" ] || exit 0

cat >&2 <<'EOF'
Blocked by vp-run-test-path-gate: `vp run test <path>` REPLAYS a cached
result instead of executing.

`vp run test` goes through the Vite+ task runner, and the `test` task is
cached, so a repeat invocation prints `◉ cache hit, replaying` with the
previous run's counts and duration. A mutation probe edits a file the
task hash does not cover, so the replayed verdict is the PRE-mutation
one and the probe reports PASS having run nothing — a probe that cannot
fail looks exactly like a guard that works.

Use the command the task delegates to, invoked directly:

  vp test run <path>

and read the EXIT CODE, not the summary text.

Bare `vp run test` (the whole suite) is unaffected and still allowed.
EOF
exit 2
