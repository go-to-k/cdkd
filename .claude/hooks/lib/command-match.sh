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
#   1. STRIP the spans that are DATA rather than executable code — heredoc
#      bodies and quoted spans — which removes the false-positive source
#      directly rather than relying on position to dodge it; then
#   2. match the verb in COMMAND POSITION — line start OR just after a
#      `&&` / `||` / `;` / `|` control operator — instead of line start only.
#
# Note the `cd <path> &&` special case disappears from the pattern: `cd X &&
# gh pr create` is just a verb in command position after `&&`. Hooks that
# need the cd TARGET still parse it from the raw command themselves; this
# helper only answers "does the guarded verb run here?".
#
# ── Failure direction is the whole design ──────────────────────────────────
#
# A stripper bug has two very different costs. Dropping too much text makes a
# gate SILENTLY NOT FIRE, which is indistinguishable from "no problem found"
# and is exactly the class of defect this file exists to remove. Dropping too
# little merely leaves a false positive, which is loud and fixable. So every
# ambiguous case below resolves toward KEEPING text.
#
# The first cut of this helper got that backwards and review caught it: its
# heredoc scanner treated `<<<` here-strings and a `<<EOF` mentioned inside
# quoted prose as real openers, and never checked that the delimiter was ever
# terminated — so `in_heredoc` latched on and every remaining line was
# dropped, turning all six merge-time gates off for that command. The rules
# below are written against those three cases specifically.

# Remove the spans of a command that are DATA rather than executable code.
#
# Order is heredocs first, then quotes, and that order is load-bearing: a
# heredoc body is prose and routinely contains an unbalanced apostrophe
# ("don't"), which a quote scanner run first would treat as an opening quote
# and use to swallow everything up to the next quote — including a real
# command after the heredoc. Removing verified heredoc bodies first means the
# quote scanner never sees that prose.
#
# Heredoc rules, each closing a reviewed false-negative:
#   - `<<<` (here-string) is NOT an opener. The naive pattern matched the
#     inner `<<` of `<<<`, so `grep -q a <<< "$v"` swallowed the rest.
#   - an opener only counts when its delimiter is actually TERMINATED later
#     in the command. An unterminated one (or a `<<EOF` merely mentioned in
#     prose) leaves every following line intact.
#   - the opening line itself is KEPT: it carries the real command
#     (`git commit -F - <<'EOF'`).
#
# Quote stripping is a character state machine over the WHOLE remaining text,
# not a per-line regex. A quoted argument can span newlines — a commit
# message passed as `-m "line1\n\nline2"` is the common case — and a per-line
# `sed` leaves every line after the first, which review showed producing a
# NEW hard block on `git commit -m "...\n\nrun: git push && gh pr merge 5"`.
# The machine also gets nesting-by-context right for free: an apostrophe
# inside a double-quoted span is literal, not an opener.
#
# Still out of scope, unchanged from the old line-start anchor so neither is
# a regression: backslash-escaped quotes, and an inner shell
# (`bash -c "<verb> ..."`), which would need real parsing to detect.
strip_noncommand_spans() {
  printf '%s' "$1" | awk '
    { lines[NR] = $0 }
    END {
      # ---- pass 1: heredoc bodies, only when verifiably terminated -------
      out = ""
      i = 1
      while (i <= NR) {
        line = lines[i]
        out = out line "\n"
        delim = ""

        # Find `<<` that is NOT part of `<<<`, i.e. not preceded by `<` and
        # not followed by `<`. Scan from the line start so an earlier
        # here-string cannot shadow a later real opener.
        rest = line
        offset = 0
        while (match(rest, /<<-?[ \t]*("[^"]+"|\047[^\047]+\047|[A-Za-z_][A-Za-z0-9_]*)/)) {
          start = offset + RSTART
          before = (start > 1) ? substr(line, start - 1, 1) : ""
          # substr(line,start,2) is "<<"; the char after decides here-string.
          after2 = substr(line, start + 2, 1)
          if (before != "<" && after2 != "<") {
            d = substr(rest, RSTART, RLENGTH)
            sub(/^<<-?[ \t]*/, "", d)
            gsub(/["\047]/, "", d)
            if (d != "") { delim = d }
            break
          }
          offset = offset + RSTART + RLENGTH - 1
          rest = substr(line, offset + 1)
        }

        if (delim != "") {
          # Only strip when the delimiter is actually terminated later.
          found = 0
          for (j = i + 1; j <= NR; j++) {
            t = lines[j]
            sub(/^[ \t]+/, "", t)
            if (t == delim) { found = j; break }
          }
          if (found > 0) { i = found + 1; continue }
        }
        i++
      }

      # ---- pass 2: quoted spans, whole-text char state machine ----------
      res = ""
      st = 0          # 0 = code, 1 = inside single quotes, 2 = inside double
      n = length(out)
      for (k = 1; k <= n; k++) {
        c = substr(out, k, 1)
        if (st == 0) {
          if (c == "\047") st = 1
          else if (c == "\"") st = 2
          else res = res c
        } else if (st == 1) {
          if (c == "\047") st = 0
          else if (c == "\n") res = res c   # keep line structure
        } else {
          if (c == "\"") st = 0
          else if (c == "\n") res = res c
        }
      }
      printf "%s", res
    }
  '
}

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

# cmd_last_cd_target <command>
#
# Print the path of the LAST `cd <path>` in command position, or nothing.
#
# The gates use this to resolve which working tree the guarded command will
# actually run in — which decides whose per-worktree markgate markers get
# consulted. It has to be the LAST one, because that is the directory in
# effect by the time the verb runs, and it mirrors how the hooks already take
# the last `gh -C` / `git -C`.
#
# Matching only a LEADING `cd` was safe while the verb matcher itself was
# line-start anchored: a command with a mid-chain `cd` did not fire the gate
# at all. Now that `git push && cd /w && gh pr merge 1` DOES fire, reading
# only a leading `cd` would resolve the wrong tree and consult the wrong
# markers — which can produce a spurious PASS, the same class of hole this
# file exists to close.
cmd_last_cd_target() {
  local cmd="$1" out
  # Segment the QUOTE-STRIPPED text, so a `cd` mentioned inside a quoted body
  # (`echo "then cd /tmp/w"`) is never seen as a command. A segment counts
  # only when it STARTS with `cd`, which is what makes that safe.
  out="$(strip_noncommand_spans "$cmd" | awk '
    {
      n = split($0, seg, /[|;&]+/)
      for (k = 1; k <= n; k++) {
        s = seg[k]
        sub(/^[ \t]+/, "", s)
        if (s ~ /^cd([ \t]|$)/) {
          sub(/^cd[ \t]*/, "", s)
          sub(/[ \t].*$/, "", s)
          # A path that was entirely quoted is gone by now; record that a cd
          # WAS in command position so the caller can recover it from the raw
          # command rather than silently resolving to nothing.
          last = (s == "") ? "\001quoted" : s
        }
      }
    }
    END { if (last != "") print last }
  ')"

  if [ "$out" = $'\001quoted' ]; then
    # Recover a quoted path (`cd "/tmp/a b"`) from the RAW command. Safe to
    # read raw here precisely because the pass above already established that
    # a `cd` occupies command position — prose can never reach this branch.
    out="$(printf '%s' "$cmd" | sed -n 's/.*cd[[:space:]]*"\([^"]*\)".*/\1/p; s/.*cd[[:space:]]*'"'"'\([^'"'"']*\)'"'"'.*/\1/p' | tail -n 1)"
  fi
  [ -n "$out" ] && printf '%s' "$out"
}
