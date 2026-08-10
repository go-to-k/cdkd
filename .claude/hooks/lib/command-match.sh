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
      res = ""; st = 0; esc = 0; emitted = 0
      n = length(out)
      for (k = 1; k <= n; k++) {
        c = substr(out, k, 1)
        if (esc) { esc = 0; if (st == 0) res = res c; continue }
        if (st == 0) {
          if (c == "\\") { esc = 1; res = res c; continue }
          if (c == "\047") { st = 1; emitted = 0; continue }
          if (c == "\"") { st = 2; emitted = 0; continue }
          res = res c
        } else if (st == 1) {
          if (c == "\047") { st = 0; if (!emitted) { res = res ph; emitted = 1 } }
          else if (c == "\n") { if (!emitted) { res = res ph; emitted = 1 } res = res c }
        } else {
          if (c == "\\") { esc = 1; continue }
          if (c == "\"") { st = 0; if (!emitted) { res = res ph; emitted = 1 } }
          else if (c == "\n") { if (!emitted) { res = res ph; emitted = 1 } res = res c }
        }
      }
      # An unterminated quote still contributes its placeholder.
      if (st != 0 && !emitted) res = res ph
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
  local cmd="$1" verb="$2" stripped
  # Capture first, then feed grep from a here-string. A `... | grep -q`
  # pipeline exits 141 (SIGPIPE) on a large command under `set -o pipefail`,
  # which a caller reads as "no match" — a silent gate miss.
  stripped="$(strip_noncommand_spans "$cmd")"
  grep -qE "(^|[|;&][[:space:]]*)[[:space:]]*${verb}" <<< "$stripped"
}

# cmd_last_cd_target <command> [base-dir]
#
# Print the working directory the command ends up in, following every `cd` in
# command position in order, or nothing when there is no `cd`.
#
# The gates use this to resolve which working tree the guarded command runs
# in — which decides whose per-worktree markgate markers get consulted.
#
# Matching only a LEADING `cd` was consistent while the verb matcher was
# line-start anchored, because a command with a mid-chain `cd` did not fire
# the gate at all. Now that `git push && cd /w && gh pr merge 1` DOES fire,
# reading only the leading one would consult the wrong tree's markers and
# could produce a spurious PASS.
#
# Chained RELATIVE cds compose (`cd /abs/one && cd sub` -> `/abs/one/sub`),
# which is why the base dir is a parameter rather than the caller resolving a
# single returned segment.
cmd_last_cd_target() {
  local cmd="$1" base="${2:-}" stripped cur="" seen=0 idx=0 __p
  local -a raw_paths
  raw_paths=()
  stripped="$(strip_noncommand_spans "$cmd")"

  # Quoted paths were replaced by the placeholder, so recover them, in order,
  # from the RAW command. Safe to read raw only for paths whose `cd` the
  # stripped pass has already proven to be in command position.
  #
  # A read loop rather than `mapfile`: macOS ships bash 3.2 as /bin/bash and
  # has no `mapfile`, so under it the array would silently stay empty and a
  # quoted cd path would resolve to the wrong directory. No other hook in
  # this tree requires bash 4+, so this helper must not be the first.
  while IFS= read -r __p; do
    raw_paths+=("$__p")
  done < <(printf '%s' "$cmd" | grep -oE "cd[[:space:]]+(\"[^\"]*\"|'[^']*')" | sed -E "s/^cd[[:space:]]+//; s/^[\"']//; s/[\"']$//")

  cur="$base"
  while IFS= read -r seg; do
    [ -n "$seg" ] || continue
    if [[ "$seg" == *"$CMD_MATCH_PLACEHOLDER"* ]]; then
      seg="${raw_paths[$idx]:-}"
      idx=$((idx + 1))
      [ -n "$seg" ] || continue
    fi
    seen=1
    if [[ "$seg" == /* ]]; then cur="$seg"; else cur="${cur:+$cur/}$seg"; fi
  done < <(printf '%s' "$stripped" | awk '
    {
      n = split($0, seg, /[|;&]+/)
      for (k = 1; k <= n; k++) {
        s = seg[k]
        sub(/^[ \t]+/, "", s)
        if (s ~ /^cd([ \t]|$)/) {
          sub(/^cd[ \t]*/, "", s)
          sub(/[ \t].*$/, "", s)
          if (s != "") print s
        }
      }
    }
  ')

  [ "$seen" = "1" ] && printf '%s' "$cur"
}
