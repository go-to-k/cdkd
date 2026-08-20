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
  || ! declare -F cmd_matches_verb >/dev/null 2>&1 \
  || ! declare -F strip_noncommand_spans >/dev/null 2>&1; then
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

# Parse the NEUTRALISED text, not the raw command: a heredoc body routinely
# describes the very command it is about (this repo's own commit messages do),
# and re-reading the raw text would undo the neutralisation the matcher just
# performed and fire on prose. The cost is a quoted path (`vp run test
# "tests/x.test.ts"`) becoming a placeholder and NOT being recognised — a false
# NEGATIVE, i.e. the pre-hook status quo, which is the direction to err in here.
neutralised=$(strip_noncommand_spans "$cmd")

# Collapse runs of spaces / tabs so the literal split below agrees with the ERE
# above, which accepts `[[:space:]]+`. NEWLINES are preserved: they end an
# argument list and are relied on as a separator further down.
# Join backslash-continued lines FIRST. A `\`-continuation is one logical
# command, so truncating at its newline (below) would drop the arguments that
# follow — regressing to a false negative on `vp run test \` + an indented path.
neutralised=$(printf '%s' "$neutralised" | sed -e ':a' -e '/\\$/{N;s/\\\n/ /;ba' -e '}')
neutralised=$(printf '%s' "$neutralised" | tr '\t' ' ' | sed 's/  */ /g')

# Walk EVERY occurrence rather than only the last. Taking the last one lets a
# later SIBLING task hide a real hit (`vp run test tests/a.test.ts && vp run
# test:hooks` splits inside `:hooks` and bails), which is a false negative but
# a needless one.
rest=$neutralised
found_path=0
while [ "${rest#*vp run test}" != "$rest" ]; do
  tail_text=${rest#*vp run test}
  rest=$tail_text

  # The split can land inside a LONGER task name (`vp run test:once-leak` ->
  # `:once-leak`), so anything not starting with whitespace is a different task.
  case "$tail_text" in
    '' | [[:space:]]*) ;;
    *) continue ;;
  esac

  # Truncate at anything that ENDS this command's argument list. A NEWLINE is a
  # separator too — a multi-line Bash call is the norm here, and omitting it
  # read the next line's command as this one's arguments. `#` starts a comment.
  tail_text=${tail_text%%&&*}
  tail_text=${tail_text%%||*}
  tail_text=${tail_text%%;*}
  tail_text=${tail_text%%|*}
  tail_text=${tail_text%%&*}
  tail_text=${tail_text%%$'\n'*}
  tail_text=${tail_text%%#*}

# **A token counts as a path only if it looks like a TEST path.** The inverse
# rule ("anything that is not a flag") loses a race it cannot win: redirections,
# backgrounding, comments and every value-taking flag not on a hand-kept list
# all present as bare tokens, so the whole-suite form blocked — including
# `vp run test > /tmp/out 2>&1; rc=$?`, the shape this repo's own skills
# instruct. A hand-kept flag list cannot close that, because the next unlisted
# flag re-opens it.
#
# The positive test is available because the argument this gate cares about has
# exactly one meaning: `vp run test <path>` filters the suite, so its path is a
# `tests/**` entry or a `*.test.ts` file. Requiring THAT rather than "not a
# flag" makes an ordinary non-path token — a reporter name, a comment word, an
# output file outside `tests/` — a non-match by construction rather than by
# enumeration, and the residual failure direction is a false NEGATIVE.
#
# It is NOT a claim about every flag VALUE: a value that is itself under
# `tests/` still reads as a path (`--outputFile tests/out.json` blocks). Only
# REDIRECT targets are skipped, by the operator case below. Accepted, because
# writing a run's output INTO the test tree is not a shape this repo uses, and
# the alternative is the flag deny-list this inversion exists to remove.
#
# `set -f` because the loop is unquoted: without it a token containing a glob is
# expanded against the hook's cwd.
  set -f
  skip_next=0
  for tok in $tail_text; do
    if [ "$skip_next" = "1" ]; then
      skip_next=0
      continue
    fi
    case "$tok" in
      # A bare redirection operator takes the NEXT token as its target; skip it
      # so a target that happens to sit under `tests/` cannot arm the gate.
      '>' | '>>' | '<' | '2>' | '2>>' | '1>' | '1>>' | '&>' | '&>>' | '>|') skip_next=1 ;;
      tests/* | ./tests/* | */tests/* | *.test.ts | *.test.tsx | *.test-d.ts)
        found_path=1
        break
        ;;
    esac
  done
  set +f

  [ "$found_path" = "1" ] && break
done

[ "$found_path" = "1" ] || exit 0

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
