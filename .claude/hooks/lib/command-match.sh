#!/usr/bin/env bash
# Shared command-matching helpers for the PreToolUse gate hooks.
#
# WHY THIS EXISTS (issue #1455). Every gate used to decide "is this the
# command I guard?" with a LINE-START-anchored regex that tolerated exactly
# one chained shape, an optional leading `cd <path> &&`:
#
#   ^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?gh ... pr (create|merge)
#
# So `git push && gh pr create` — the natural way to push a branch and open
# its PR in one step, and what a session reached for unprompted — did not
# match, and the gate never fired. The same hole existed in all six
# merge-time gates, which is strictly worse: those are what stand between an
# unverified destroy path and `main`.
#
# The anchoring was deliberate, not an oversight: it kept a mention of the
# verb inside a quoted argument (`echo "next step: gh pr merge"`) from
# false-positiving into a hard block. Simply removing the anchor would
# reopen that. So the fix is two-part:
#
#   1. STRIP quoted spans before matching, which removes the false-positive
#      source directly rather than relying on position to dodge it; then
#   2. match the verb in COMMAND POSITION — line start OR just after a
#      `&&` / `||` / `;` / `|` control operator — instead of line start only.
#
# Net effect vs the old behaviour: strictly more real invocations caught,
# and no new false positives (a quoted mention is now removed outright,
# where before it was merely out of anchor range).
#
# Note the `cd <path> &&` special case disappears from the pattern: `cd X &&
# gh pr create` is just a verb in command position after `&&`. Hooks that
# need the cd TARGET still parse it from the raw command themselves; this
# helper only answers "does the guarded verb run here?".

# Blank out single- and double-quoted spans so a verb mentioned inside an
# argument body cannot be read as an invocation.
#
# Heredoc bodies are stripped FIRST, then quoted spans within what remains.
#
# Handling heredocs is not optional, and skipping it is not a theoretical
# gap: the very commit that introduced this helper was blocked by
# integ-broad-gate, because its `git commit -F -` message body explained the
# bug by quoting a chained merge command. A heredoc body is NOT shell-quoted,
# so quote-stripping alone leaves it in place, and command-position matching
# then reads prose as an invocation. Commit messages and PR bodies routinely
# describe the very commands they are about, so this shape is common rather
# than exotic — and a gate that fires on prose is worse than one that misses
# a rare invocation, because the first teaches people to bypass it.
#
# Still deliberately out of scope, unchanged from the old line-start anchor
# so neither is a regression: escaped quotes inside quoted spans, and an
# inner shell (`bash -c "<verb> ..."`), which would need real parsing.
strip_noncommand_spans() {
  # Drop heredoc bodies. The line that OPENS the heredoc is KEPT — it carries
  # the real command — and every line up to and including the terminator is
  # dropped. `<<-` allows an indented terminator, so the comparison trims
  # leading whitespace before matching.
  printf '%s' "$1" | awk '
    {
      if (in_heredoc) {
        t = $0
        sub(/^[ \t]+/, "", t)
        if (t == delim) in_heredoc = 0
        next
      }
      if (match($0, /<<-?[ \t]*("[^"]+"|\047[^\047]+\047|[A-Za-z_][A-Za-z0-9_]*)/)) {
        d = substr($0, RSTART, RLENGTH)
        sub(/^<<-?[ \t]*/, "", d)
        gsub(/["\047]/, "", d)
        if (d != "") { delim = d; in_heredoc = 1 }
      }
      print
    }
  ' | sed "s/'[^']*'/''/g; s/\"[^\"]*\"/\"\"/g"
}

# Back-compat alias for the original name.
strip_quoted_spans() { strip_noncommand_spans "$@"; }

# cmd_matches_verb <command> <verb-ere>
#
# Exit 0 when <verb-ere> appears in command position within <command>.
# <verb-ere> must match from the verb onward (e.g. 'gh[[:space:]]+pr[[:space:]]+merge')
# and should carry its own trailing boundary.
cmd_matches_verb() {
  local cmd="$1" verb="$2"
  strip_noncommand_spans "$cmd" \
    | grep -qE "(^|[|;&][[:space:]]*)[[:space:]]*${verb}"
}
