#!/usr/bin/env bash
# broad-process-kill-gate.sh
#
# PreToolUse hook (matcher: Bash). Blocks the bare and path-qualified
# `pkill` / `killall` command words.
#
# WHY. Both kill by NAME, machine-wide, and this machine runs several lanes
# of one `/work-issues` run at once plus backgrounded `/run-integ` fixtures.
# `pkill -f vitest` cannot tell this lane's suite from a peer's, and
# `pkill -f node` / `pkill -f cdkd` cannot tell a stuck process from a
# real-AWS deploy mid-flight -- whose death leaves the fixture's resources
# standing with no teardown and no error anyone can attribute. Measured
# 2026-09-06: a lane of the go-to-k/cdkd#2610 run self-reported running
# `pkill -f vitest` repo-wide while sibling lanes were live.
#
# The replacement is always available and is strictly better, because it
# answers the question the kill-by-name form skips -- IS THIS PROCESS MINE?
#
#   pgrep -laf '<pattern>'          # see the PIDs and their full argv
#   ps -o pid,lstart,args -p <pid>  # confirm it is yours before killing
#   kill <pid>                      # one PID, chosen deliberately
#
# WHAT THIS IS, STATED HONESTLY: a STEER against the spelling an agent
# actually writes, not a security boundary. Every revision of this comment
# that tried to bound the gap was measured false -- "no argument shape makes
# `pkill` safe, so there is no allow-list to get wrong", then "one KNOWN
# LIMIT", then a list of five, then a list of eight, then "every class that
# still passes". The passing set is NOT a list.
# It is unbounded, by three mechanisms, and naming those is the only form of
# this paragraph that cannot rot:
#
#   A. THE COMMAND WORD IS NOT THE VERB. Anything reaching a kill
#      indirectly passes: an assembled `pgrep`/`ps` -> `kill` pipeline or
#      loop; `kill` with a NEGATIVE pid (`kill -9 -1`, `kill -- -1`), which
#      is broader than `pkill`; a quoted or escaped word (`"pkill"`,
#      `\pkill`) -- the shared library replaces quoted spans with a
#      placeholder ON PURPOSE, since losing text makes a gate silently not
#      fire; a variable holding the name or its path; `eval`; a NON-shell
#      interpreter (`python3 -c`); or a script written to a file and then
#      run. A SHELL interpreter does NOT escape -- `bash -c` and `sh -c`
#      both block, measured.
#   B. THE PREFIX IS NOT ON THE STRIPPER'S ALLOW-LIST. `gate_strip_prefix`
#      in lib/command-match.sh knows `sudo`, `env`, `nohup`, `timeout`,
#      `command`, `xargs`, `VAR=value` and a few more -- every one of those
#      BLOCKS -- and knows nothing else. So `nice`, `npx`, `setsid`,
#      `stdbuf`, `ionice`, `busybox` and `find -exec` all pass, no flag
#      needed. Read that as a CLASS, not as seven more items: ANY prefix
#      nobody has taught the stripper works, and widening it belongs in the
#      shared library, where every gate would gain it at once.
#   C. THE HOOK NEVER RAN -- a missing tool or a timeout is a silent pass.
#      See FAIL DIRECTION below.
#
# So it stops the careless spelling and not a determined one. That is worth
# having -- the incident was the careless spelling -- but do not read a green
# Bash call as proof that no broad kill happened.
#
# FAIL DIRECTION. The shared-library load fails CLOSED (exit 2), pinned by
# this hook's suite. A missing TOOL does NOT: with `jq` absent the payload
# read degrades to an empty command, and with `awk` absent the shared
# matcher cannot run -- either way the hook exits 0. That is the repo-wide
# convention for every gate that parses `.tool_input.command`, not a
# property of this one, and it is stated here rather than left to be
# discovered because the paragraph above promises honesty about the gaps.
#
# COST. The `sed` above is the slowest path and scales with command length:
# a 1.4 MB command of repeated `type x ` tokens measured 10.62 s, past the
# 10 s PreToolUse timeout, and a timed-out hook is a SILENT PASS. Realistic
# commands are ~1 s. Named rather than engineered around -- the shape is
# inherited from every gate that scans the command text.
#
# There is no bypass marker: the replacement runs the same kill with one
# extra read. `killall "Docker Desktop"` -- the usual macOS Docker restart --
# is refused along with everything else; use the `pgrep` -> `kill <pid>`
# form, or quit the app through its own UI.

set -u

# shellcheck source=lib/command-match.sh
LIB_DIR="${BASH_SOURCE[0]%/*}"
[ "$LIB_DIR" = "${BASH_SOURCE[0]}" ] && LIB_DIR="."
if ! . "$LIB_DIR/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null 2>&1; then
  # Fail CLOSED: a missing library must not silently disable the check.
  echo "Blocked by broad-process-kill-gate: cannot load lib/command-match.sh" >&2
  exit 2
fi

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# A LOOKUP asks where a binary lives; it kills nothing. `gate_strip_prefix`
# sheds `command` and its `-v` flag, so without this `command -v pkill` --
# a pure read -- reached the verb match and was REFUSED (measured rc=2 in
# review). Blank the lookup's ARGUMENT rather than its verb, so a real kill
# later in the same command still matches.
#
# THE ARGUMENT CLASS EXCLUDES `$`, `(` and a backtick, and that is the whole
# safety of this line. A first cut used `[^[:space:];|&)]+`, which swallowed
# `$(pkill` and left `-f vitest)` -- so `echo type $(pkill -f vitest)` PASSED
# and the payload really ran, a bypass this hook created rather than
# inherited (measured; the pre-fix revision blocked it). A substitution is a
# COMMAND, never a lookup's argument, so it must never be eaten. Both
# polarities are pinned in the suite: the lookup passes, a kill inside a
# lookup's argument blocks.
probe=$(printf '%s' "$cmd" | sed -E \
  's/(^|[^[:alnum:]_-])(command[[:space:]]+-[vV]|type|which)[[:space:]]+[^[:space:];|&()$`]+/\1\2 CDKD_LOOKUP/g')

# Command-position match only, so a mention of the verb inside a commit
# message, an issue body or a heredoc does not fire the gate -- this repo's
# own rule text names both commands, and blocking a PR body that quotes the
# rule would make the gate refuse its own documentation.
#
# `([^[:space:]]*/)?` accepts a path-qualified word (`/usr/bin/pkill`,
# `./pkill`), which passed the first revision. The trailing boundary keeps a
# LONGER name out: `pkillsomething` and `killall5` (the Linux init helper)
# are not this verb, and neither is `/opt/x/pkillers`.
if ! cmd_matches_verb "$probe" '([^[:space:]]*/)?(pkill|killall)([[:space:]]|$)'; then
  exit 0
fi

cat >&2 <<'EOF'
Blocked by broad-process-kill-gate: `pkill` / `killall` kill by NAME,
machine-wide.

Parallel lanes and backgrounded `/run-integ` fixtures share this machine.
A name pattern cannot tell your process from a peer lane's, so the cost of
being wrong is another lane's suite reported as a false red, or a real-AWS
deploy killed mid-flight and its resources left standing with no teardown.

Find the process, CONFIRM IT IS YOURS, then kill that one PID:

  pgrep -laf '<pattern>'            # PIDs plus full argv -- read this
  ps -o pid,lstart,args -p <pid>    # started when? in which tree?
  kill <pid>                        # one PID, chosen deliberately

The confirm step is the point. Piping the first command straight into
`xargs kill` is the same machine-wide kill this gate refuses, spelled
differently -- it is not the way around this block.

Use `kill -9 <pid>` only after a plain `kill` has been given time. If the
process is a container or a background Bash task, stop it through its own
owner (`docker rm -f <name>`, the task's own stop) rather than by name.
EOF
exit 2
