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
# its PR in one step — did not match, and the gate never fired. The same hole
# existed in all six merge-time gates, which is strictly worse: those are what
# stand between an unverified destroy path and `main`.
#
# The anchoring was deliberate: it kept a mention of the verb inside a quoted
# argument (`echo "next step: gh pr merge"`) from false-positiving into a hard
# block. Simply removing the anchor would reopen that. So the fix is two-part:
#
#   1. NEUTRALISE the spans that are DATA rather than executable code —
#      heredoc bodies and quoted spans — which removes the false-positive
#      source directly rather than relying on position to dodge it; then
#   2. match the verb in COMMAND POSITION — line start OR just after a
#      `&&` / `||` / `;` / `|` control operator — instead of line start only.
#
# ── Failure direction is the whole design ──────────────────────────────────
#
# A stripper bug has two very different costs. Losing text makes a gate
# SILENTLY NOT FIRE, which is indistinguishable from "no problem found" and is
# exactly the defect class this file exists to remove. Keeping too much merely
# leaves a false positive, which is loud and fixable. Every ambiguous case
# below therefore resolves toward KEEPING.
#
# Two review rounds found this getting it backwards, which is why the rules
# are spelled out rather than implied:
#
#   round 1 — `<<<` here-strings, a `<<EOF` mentioned in prose, and
#     unterminated heredocs were all treated as real openers, so the scanner
#     latched on and dropped every remaining line.
#   round 2 — quoted spans were DELETED rather than replaced, so a quoted
#     ARGUMENT VALUE vanished and patterns that need it stopped matching:
#     `gh -C "$WT" pr merge` (the documented worktree shape) failed to match
#     in nine gates. And an escaped `\"` desynced the quote state machine,
#     swallowing every following line.
#
# Hence: a neutralised quoted span leaves a PLACEHOLDER token behind, so
# `-C "<path>"` still looks like `-C <token>` to a `[^[:space:]]+`
# sub-pattern, while the CONTENT that could impersonate a command is gone.

# Placeholder standing in for a removed quoted span. Must be a single
# non-space, non-operator character so it satisfies `[^[:space:]]+` value
# sub-patterns without ever looking like a command separator.
CMD_MATCH_PLACEHOLDER=$'\002'

# Neutralise the spans of a command that are DATA rather than executable code.
#
# Heredocs first, then quotes, and that order is load-bearing: a heredoc body
# is prose and routinely contains an unbalanced apostrophe ("don't"), which a
# quote scanner run first would treat as an opening quote and use to swallow
# everything up to the next quote — including a real command after the
# heredoc.
#
# Heredoc rules, each closing a reviewed false negative:
#   - `<<<` (here-string) is NOT an opener;
#   - a `<<X` sitting inside a quoted span on its own line is NOT an opener;
#   - an opener counts only when its delimiter is actually TERMINATED later;
#   - the opening line itself is KEPT — it carries the real command.
#
# Quote rules:
#   - a whole-text character state machine, because a quoted argument can span
#     newlines (a `-m "line1\n\nline2"` commit message is the common case) and
#     a per-line regex leaves every line after the first;
#   - a backslash escapes the next character in code and in double quotes, so
#     `"a \" b"` does not desync the machine;
#   - inside single quotes a backslash is literal, matching the shell.
#
# Out of scope, as before: `$'...'` ANSI-C quoting, and an inner shell
# (`bash -c "<verb> ..."`), which would need real parsing.
strip_noncommand_spans() {
  printf '%s' "$1" | awk -v ph="$CMD_MATCH_PLACEHOLDER" '
    { lines[NR] = $0 }
    END {
      # ---- pass 1: heredoc bodies, only when verifiably terminated -------
      out = ""
      i = 1
      while (i <= NR) {
        line = lines[i]
        out = out line "\n"
        delim = ""

        # Per-line quote state, so a `<<X` inside quotes is not an opener.
        q = 0; esc = 0
        len = length(line)
        for (c = 1; c <= len; c++) {
          ch = substr(line, c, 1)
          if (esc) { esc = 0; continue }
          if (q == 0) {
            if (ch == "\\") { esc = 1; continue }
            if (ch == "\047") { q = 1; continue }
            if (ch == "\"") { q = 2; continue }
            if (ch == "<" && substr(line, c + 1, 1) == "<") {
              if (substr(line, c + 2, 1) == "<") { c = c + 2; continue }  # <<<
              if (c > 1 && substr(line, c - 1, 1) == "<") continue
              rest = substr(line, c)
              if (match(rest, /^<<-?[ \t]*("[^"]+"|\047[^\047]+\047|[A-Za-z_][A-Za-z0-9_]*)/)) {
                d = substr(rest, RSTART, RLENGTH)
                sub(/^<<-?[ \t]*/, "", d)
                gsub(/["\047]/, "", d)
                if (d != "") { delim = d; break }
              }
            }
          } else if (q == 1) {
            if (ch == "\047") q = 0
          } else {
            if (ch == "\\") { esc = 1; continue }
            if (ch == "\"") q = 0
          }
        }

        if (delim != "") {
          found = 0
          for (j = i + 1; j <= NR; j++) {
            t = lines[j]
            sub(/^[ \t]+/, "", t)
            sub(/\r$/, "", t)
            if (t == delim) { found = j; break }
          }
          if (found > 0) { i = found + 1; continue }
        }
        i++
      }

      # ---- pass 2: quoted spans -> placeholder ---------------------------
      #
      # Emitted as RUNS (substr of the kept stretch) rather than character by
      # character. `res = res c` in a loop is quadratic in most awks: measured
      # 0.21s at 50 KB and 3.0s at 200 KB, and every gate calls this twice, so
      # a large command turned each hook into seconds of latency.
      st = 0; esc = 0; emitted = 0; runstart = 1
      n = length(out)
      for (k = 1; k <= n; k++) {
        c = substr(out, k, 1)
        if (esc) { esc = 0; continue }
        if (st == 0) {
          if (c == "\\") { esc = 1; continue }
          if (c == "\047" || c == "\"") {
            # Flush the code run that ended just before this quote.
            if (k > runstart) printf "%s", substr(out, runstart, k - runstart)
            st = (c == "\047") ? 1 : 2
            emitted = 0
            continue
          }
        } else if (st == 1) {
          if (c == "\047") { st = 0; if (!emitted) { printf "%s", ph; emitted = 1 } runstart = k + 1 }
          else if (c == "\n") { if (!emitted) { printf "%s", ph; emitted = 1 } printf "%s", c }
        } else {
          if (c == "\\") { esc = 1; continue }
          if (c == "\"") { st = 0; if (!emitted) { printf "%s", ph; emitted = 1 } runstart = k + 1 }
          else if (c == "\n") { if (!emitted) { printf "%s", ph; emitted = 1 } printf "%s", c }
        }
      }
      if (st == 0) {
        if (n >= runstart) printf "%s", substr(out, runstart, n - runstart + 1)
      } else if (!emitted) {
        # An unterminated quote still contributes its placeholder.
        printf "%s", ph
      }
    }
  '
}

# What may sit BETWEEN the start of a command segment and the verb without
# changing which program runs: `VAR=value` environment assignments and the
# `env` / `command` / `nohup` wrappers, in any number.
#
# Issue #2129 measured the omission: with the segment start anchored directly
# against the verb, `GIT_EDITOR=true git commit -m x`, `env git commit -m x`,
# `nohup git commit -m x` and `command git push origin HEAD` all reached git
# with branch-gate.sh exiting 0 — ungated, and indistinguishable from a command
# that passed. `bash -c "<verb> ..."` stays out of scope, as before: that needs
# real parsing, not a prefix rule.
CMD_MATCH_PREFIX_ERE='(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|command|nohup)[[:space:]]+)*'

# cmd_matches_verb <command> <verb-ere>
#
# Exit 0 when <verb-ere> appears in command position within <command>.
# <verb-ere> must match from the verb onward (e.g. 'gh[[:space:]]+pr[[:space:]]+merge')
# and should carry its own trailing boundary.
cmd_matches_verb() {
  local cmd="$1" verb="$2" stripped
  # Capture first, then feed grep from a here-string. A `... | grep -q`
  # pipeline exits 141 (SIGPIPE) on a large command under `set -o pipefail`,
  # which a caller reads as "no match" — a silent gate miss.
  stripped="$(strip_noncommand_spans "$cmd")"
  grep -qE "(^|[|;&][[:space:]]*)[[:space:]]*${CMD_MATCH_PREFIX_ERE}${verb}" <<< "$stripped"
}

# cmd_last_cd_target <command> [base-dir] [verb-ere]
#
# Print the working directory the guarded command runs in — following every
# `cd` in command position that occurs BEFORE the verb — or nothing when
# there is no such `cd`.
#
# The gates use this to decide which working tree, and therefore whose
# per-worktree markgate markers, to consult.
#
# Two properties are load-bearing, and both were review findings:
#
#   - Only cds BEFORE the verb count. Following every cd in the command let a
#     trailing one hijack the lookup: `gh pr merge N --squash --delete-branch
#     && cd <repo> && git pull` — the standing post-merge step — silently
#     redirected all seven markgate gates to the main tree's store. Pass the
#     verb ERE so the scan stops there; without it, every cd is followed
#     (correct only for callers that have no verb, i.e. none today).
#   - Chained RELATIVE cds compose (`cd /abs/one && cd sub` -> `/abs/one/sub`),
#     which is why the base dir is a parameter rather than the caller
#     resolving a single returned segment.
#
# A cd whose path was entirely quoted (`cd "/a b"`) resolves to NOTHING, and
# the caller then falls back to the payload cwd. Recovering it from the raw
# command was tried and removed: the raw text still contains quoted `cd`
# mentions that the neutralised pass correctly ignored, so pairing the two by
# order silently resolved the WRONG directory. Falling back to the cwd matches
# what the pre-#1455 parser did for this shape and is the conservative half of
# an already-imperfect case.
cmd_last_cd_target() {
  local cmd="$1" base="${2:-}" verb="${3:-}" stripped cur="" seen=0 seg
  stripped="$(strip_noncommand_spans "$cmd")"

  cur="$base"
  while IFS= read -r seg; do
    [ -n "$seg" ] || continue
    seen=1
    if [[ "$seg" == /* ]]; then cur="$seg"; else cur="${cur:+$cur/}$seg"; fi
  done < <(printf '%s' "$stripped" | awk -v verb="$verb" -v ph="$CMD_MATCH_PLACEHOLDER" '
    {
      n = split($0, seg, /[|;&]+/)
      for (k = 1; k <= n; k++) {
        s = seg[k]
        sub(/^[ \t]+/, "", s)
        # Stop at the guarded verb: a cd after it cannot affect where it ran.
        if (verb != "" && s ~ verb) { stop = 1; break }
        if (s ~ /^cd([ \t]|$)/) {
          sub(/^cd[ \t]*/, "", s)
          sub(/[ \t].*$/, "", s)
          # A path that was entirely quoted is now just the placeholder; it
          # cannot be resolved, so skip it rather than resolve it wrongly.
          if (s != "" && index(s, ph) == 0) print s
        }
      }
      if (stop) exit
    }
  ')

  [ "$seen" = "1" ] && printf '%s' "$cur"
}
