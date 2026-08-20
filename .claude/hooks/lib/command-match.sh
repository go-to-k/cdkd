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
# =============================================================================
# The SEGMENT MATCHER (issue #2129 / #2093)
# =============================================================================
#
# Everything above is the ORIGINAL neutralising stripper, kept verbatim because
# `vp-run-test-path-gate.sh` and `main-tree-git-cwd-detector.sh` parse its output
# directly. Nothing below feeds it; the two live side by side on purpose.
#
# WHY the matcher itself was replaced. The #1455 anchor
# `(^|[|;&][[:space:]]*)` treats only a control operator as opening a command
# position, so three shapes were invisible and their gates never fired
# (issue #2093, measured against `main-tree-git-cwd-detector.sh`):
#
#   (git commit -m x)              subshell
#   true && (git commit -m x)      subshell after a chain
#   out=$(git commit -m x)         command substitution
#
# and a fourth, measured for issue #2129 against `branch-gate.sh` on a checkout
# sitting on `main`, where each of these exited 0 and reached git:
#
#   GIT_EDITOR=true git commit -m x        env assignment
#   env / command / nohup git commit …     wrapper
#
# The model that fixes all of them: a Bash tool call is a COMMAND LIST. Segment
# it — on `&&`, `||`, `;`, `|`, a bare `&`, a newline, a subshell or brace group,
# a `$(...)` or backtick substitution — and ask whether any SEGMENT IS the gated
# command, with the verb anchored at the segment START.
#
# Quoting is handled by NEUTRALISING the separator CHARACTERS inside quoted spans
# rather than blanking the span, then swapping them back, so segments carry their
# ORIGINAL text. Blanking was tried first in the sibling repos and erased the
# PATH in `cd "<worktree>" && git commit` and `git -C "<path>" commit`, so
# target-dir resolution silently fell back to the payload cwd and the gate passed
# a commit it should have blocked (review of go-to-k/cdk-local#542). A verb
# inside a string still does not match, because the regexes anchor at the
# segment start and a quoted span never starts one.
#
# This engine is kept in lockstep with `_command-match.sh` in cdk-local and
# cdk-real-drift. Two cdkd-specific properties travel with it, both recorded
# below where they are implemented: heredoc openers count only when TERMINATED,
# and segments are emitted through an `if`, never a `&&`.
# Placeholders for separators that live inside quoted spans (never in real input).
# Distinct from CMD_MATCH_PLACEHOLDER above: the two engines never exchange
# data, but one file must not spell two different sentinels the same byte.
GATE_SEP_AMP=$'\021'
GATE_SEP_SEMI=$'\022'
GATE_SEP_PIPE=$'\023'
GATE_SEP_SUBST=$'\024'


# Segment the command list. One awk program, run over the WHOLE input:
#   - join `\`-continuations;
#   - blank heredoc BODIES, but only for an opener whose delimiter is actually
#     TERMINATED later and which is not itself inside a quoted span;
#   - neutralise separator CHARACTERS inside quoted spans;
#   - turn every real separator into a newline, `$(...)` and backticks included
#     (the text inside one RUNS, so `echo "$(git commit -m x)"` is a commit).
gate_segments_raw() {
  awk '
    # Does <t> appear as a bare line at or after <from>? A heredoc opener whose
    # delimiter never arrives is not an opener: latching onto it blanks every
    # remaining line, so a real verb after `cat <<EOF` + prose read as NO MATCH.
    # That is fail-open, the direction that silently disables a gate, and it is
    # why this program buffers instead of streaming (issue #1455, kept through
    # the #2129 convergence and shared with cdk-local / cdk-real-drift).
    function terminated(t, from,   j, u) {
      for (j = from; j <= total; j++) {
        u = lines[j]
        gsub(/^[ \t]+|[ \t]+$/, "", u)
        if (u == t) return j
      }
      return 0
    }
    # `q` is deliberately GLOBAL across lines: a quoted span survives a newline,
    # and a `--body "…multi-line…"` argument is ONE span. Resetting it per line
    # split a PR body into segments and matched a `&& git commit` inside the
    # prose (review of go-to-k/cdk-local#542).
    function flush_line(line,   i, n, c, res, rest, d) {
      res = ""; n = length(line); pending_tag = ""
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (q == "") {
          if ((c == "\"" || c == "'"'"'") && c != ignore_q) { q = c; res = res c; continue }
          if (c == "$" && substr(line, i + 1, 1) == "(") { res = res "\n"; i++; continue }
          if (c == "`") { res = res "\n"; continue }
          if (c == "&" || c == ";" || c == "|") { res = res "\n"; continue }
          if (c == "<" && substr(line, i + 1, 1) == "<") {
            # `<<<` is a here-string, not a heredoc opener.
            if (substr(line, i + 2, 1) == "<") { res = res "<<<"; i += 2; continue }
            rest = substr(line, i)
            if (match(rest, /^<<-?[ \t]*("[^"]+"|'"'"'[^'"'"']+'"'"'|[A-Za-z_][A-Za-z0-9_]*)/)) {
              d = substr(rest, RSTART, RLENGTH)
              sub(/^<<-?[ \t]*/, "", d)
              gsub(/["'"'"']/, "", d)
              if (d != "") pending_tag = d
            }
            res = res c
            continue
          }
          res = res c
          continue
        }
        # inside a quoted span: separators are DATA, not structure
        if (c == "\\" && q == "\"") { res = res c substr(line, i + 1, 1); i++; continue }
        if (c == q) { q = ""; res = res c; continue }
        if (c == "&") { res = res SEP_AMP; continue }
        if (c == ";") { res = res SEP_SEMI; continue }
        if (c == "|") { res = res SEP_PIPE; continue }
        if (c == "$" && substr(line, i + 1, 1) == "(") { res = res SEP_SUBST "("; i++; continue }
        res = res c
      }
      return res
    }
    # One full pass. Runs twice at most: see the END rule.
    function run(   i, line, t, acc) {
      q = ""; tag = ""; pending = ""; acc = ""
      for (i = 1; i <= total; i++) {
        line = lines[i]
        if (tag != "") {                  # inside a heredoc body: data, not commands
          t = line
          gsub(/^[ \t]+|[ \t]+$/, "", t)
          if (t == tag) tag = ""
          acc = acc "\n"
          continue
        }
        if (pending != "") { line = pending line; pending = "" }
        if (line ~ /\\$/) {               # `\`-continuation: join with the next line
          sub(/\\$/, "", line)
          pending = line
          continue
        }
        acc = acc flush_line(line) "\n"
        if (pending_tag != "" && terminated(pending_tag, i + 1) > 0) tag = pending_tag
      }
      if (pending != "") acc = acc flush_line(pending) "\n"
      return acc
    }
    { line = $0; sub(/\r$/, "", line); lines[NR] = line }
    END {
      total = NR
      ignore_q = ""
      acc = run()
      # An UNTERMINATED quote swallowed the rest of the command: `echo don'"'"'t;
      # git commit -m y` opened a span at the apostrophe and every later segment
      # became data, so the gate went quiet (issue #2093 records this landing in
      # the same place as the subshell gap). Re-run treating that character as
      # literal — a real shell would not accept the command anyway, and a gate
      # must fail LOUD, not open.
      if (q != "") { ignore_q = q; acc = run() }
      printf "%s", acc
    }
  ' SEP_AMP="$GATE_SEP_AMP" SEP_SEMI="$GATE_SEP_SEMI" SEP_PIPE="$GATE_SEP_PIPE" \
    SEP_SUBST="$GATE_SEP_SUBST" <<< "$1"
}

# Leading words that introduce a command without being one: env assignments,
# wrappers, and the keywords that open a compound statement.
gate_strip_prefix() {
  local s="$1"
  # Trim first: a segment split off after a separator starts with a space, and
  # every verb regex is anchored at the segment start.
  s="${s#"${s%%[![:space:]]*}"}"
  # `bash -c "<cmd>"` RUNS its argument, so a gated verb inside it is a gated
  # command (go-to-k/cdk-local#542 review).
  if [[ "$s" =~ ^(bash|zsh|ksh|sh)[[:space:]]+-[a-z]*c[[:space:]]+[\"\'](.*)[\"\'][[:space:]]*$ ]]; then
    s="${BASH_REMATCH[2]}"
  fi
  while [[ "$s" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|command|nohup|time|timeout[[:space:]]+[^[:space:]]+|exec|then|do|else|elif|\{|\()[[:space:]]+(.*)$ ]]; do
    s="${BASH_REMATCH[2]}"
  done
  # Any remaining grouping punctuation at either end (nested subshells).
  while [[ "$s" =~ ^[[:space:]]*[\(\{][[:space:]]*(.*)$ ]]; do s="${BASH_REMATCH[1]}"; done
  while [[ "$s" =~ ^(.*[^[:space:]])[[:space:]]*[\)\}][[:space:]]*$ ]]; do s="${BASH_REMATCH[1]}"; done
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Print one command segment per line, in the ORIGINAL text (placeholders restored).
gate_segments() {
  local segment
  while IFS= read -r segment; do
    segment="${segment//"$GATE_SEP_AMP"/&}"
    segment="${segment//"$GATE_SEP_SEMI"/;}"
    segment="${segment//"$GATE_SEP_PIPE"/|}"
    segment="${segment//"$GATE_SEP_SUBST"/$}"
    segment=$(gate_strip_prefix "$segment")
    # An `if`, not `[ -n … ] && printf`: under a caller's `set -e` a trailing
    # false test aborts the function and every remaining segment is silently
    # dropped — a gate that stops matching with no sign it stopped.
    if [ -n "$segment" ]; then
      printf '%s\n' "$segment"
    fi
  done < <(gate_segments_raw "$1")
}

# gate_matches <cmd> <extended-regex>
# 0 when any segment matches. Bash-native `=~` rather than a `grep` per segment:
# these hooks run on every matching Bash tool call, and the fork per segment per
# gate was measured at ~5x the whole gate suite's latency in review of
# go-to-k/cdk-local#542.
gate_matches() {
  local cmd="$1" re="$2" segment
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] && return 0
  done < <(gate_segments "$cmd")
  return 1
}

# A path token: a quoted span (either quote character) or a bare run of
# non-space. Held in a variable because a literal `[[ =~ ]]` pattern cannot carry
# both quote characters inside one bracket expression.
GATE_PATH_TOKEN='("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]+)'

# The regexes, kept here so every gate spells its verb the same way. Each is
# anchored at the START of a segment; `git -C <path>` / `git -c k=v` and
# `gh -C <path>` are absorbed — including a QUOTED path containing spaces, which
# an earlier version could not parse, so `git -C "/a b" commit` matched nothing
# and ran ungated (go-to-k/cdk-local#542 review).
GATE_FLAGS='([[:space:]]+-[^[:space:]]+([[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]-][^[:space:]]*))?)*'
GATE_GH_C='([[:space:]]+-C[[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]+))?'
GATE_RE_GIT_COMMIT="^git${GATE_FLAGS}[[:space:]]+commit([[:space:]]|$)"
GATE_RE_GIT_PUSH="^git${GATE_FLAGS}[[:space:]]+push([[:space:]]|$)"
GATE_RE_GH_PR_CREATE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
GATE_RE_GH_PR_EDIT="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+edit([[:space:]]|$)"
GATE_RE_GH_PR_MERGE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)"

# --- verbs cdkd gates that the sibling repos do not --------------------------
GATE_RE_GIT_COMMIT_OR_PUSH="^git${GATE_FLAGS}[[:space:]]+(commit|push)([[:space:]]|$)"
GATE_RE_GIT_MERGE="^git${GATE_FLAGS}[[:space:]]+merge([[:space:]]|$)"
GATE_RE_GIT_SWITCH="^git${GATE_FLAGS}[[:space:]]+(switch|checkout)([[:space:]]|$)"
GATE_RE_GIT_CHECKOUT_RESTORE="^git${GATE_FLAGS}[[:space:]]+(checkout|restore)([[:space:]]|$)"
GATE_RE_GH_PR_CREATE_OR_MERGE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+(create|merge)([[:space:]]|$)"
# non-english-text-gate guards every way PR prose reaches GitHub.
GATE_RE_GH_PR_WRITE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+(create|edit|merge)([[:space:]]|$)"
# gh-label-validity-gate: the two commands that can carry --label / --add-label.
GATE_RE_GH_LABEL_CARRIER="^gh${GATE_GH_C}[[:space:]]+(issue|pr)[[:space:]]+(create|edit)([[:space:]]|$)"
GATE_RE_GH_API="^gh${GATE_GH_C}[[:space:]]+api([[:space:]]|$)"
# pr-body-item-number-gate: everything that can post a body containing `#N`.
GATE_RE_GH_BODY_CARRIER="^gh${GATE_GH_C}[[:space:]]+(pr[[:space:]]+(create|edit)|issue[[:space:]]+(create|comment)|api)([[:space:]]|$)"
GATE_RE_VP_RUN_TEST='^vp[[:space:]]+run[[:space:]]+test([[:space:]]|$)'
# Deploy/destroy-shaped verbs (integ + bug-hunt cleanup gates).
GATE_RE_CDK_DEPLOY="^(npx[[:space:]]+)?cdk${GATE_FLAGS}[[:space:]]+deploy([[:space:]]|$)"
GATE_RE_CDK_DESTROY="^(npx[[:space:]]+)?cdk${GATE_FLAGS}[[:space:]]+destroy([[:space:]]|$)"
GATE_RE_DELSTACK='^delstack([[:space:]]|$)'

# Strip one layer of surrounding quotes from a path token.
gate_unquote() {
  local p="$1"
  p="${p%\"}"; p="${p#\"}"
  p="${p%\'}"; p="${p#\'}"
  printf '%s' "$p"
}

# gate_target_dir <cmd> <fallback> <extended-regex>
# The working tree the gated command will actually run in:
#   1. a `-C <path>` inside the MATCHED segment wins (git -C / gh -C), else
#   2. the last `cd <path>` segment BEFORE the matched one, else
#   3. the fallback (the hook payload's cwd).
# Quoted paths survive: segments carry their original text (see the header).
gate_target_dir() {
  local cmd="$1" fallback="$2" re="$3"
  local target="$fallback" segment cd_target c_target remaining
  while IFS= read -r segment; do
    if [[ "$segment" =~ ^cd[[:space:]]+$GATE_PATH_TOKEN ]]; then
      cd_target=$(gate_unquote "${BASH_REMATCH[1]}")
      [ -z "$cd_target" ] && continue
      [[ "$cd_target" != /* ]] && cd_target="$target/$cd_target"
      target="$cd_target"
      continue
    fi
    [[ "$segment" =~ $re ]] || continue
    # Last `-C <path>` in this segment wins over any earlier cd.
    if [[ "$segment" =~ (git|gh)[[:space:]]+-C[[:space:]]+$GATE_PATH_TOKEN ]]; then
      c_target=""
      remaining="$segment"
      while [[ "$remaining" =~ (git|gh)[[:space:]]+-C[[:space:]]+$GATE_PATH_TOKEN ]]; do
        c_target="${BASH_REMATCH[2]}"
        remaining="${remaining#*"${BASH_REMATCH[0]}"}"
      done
      c_target=$(gate_unquote "$c_target")
      if [ -n "$c_target" ]; then
        [[ "$c_target" != /* ]] && c_target="$target/$c_target"
        target="$c_target"
      fi
    fi
    break
  done < <(gate_segments "$cmd")
  printf '%s' "$target"
}

# =============================================================================
# Compatibility API — the spelling the 18 pre-#2129 gates already call
# =============================================================================
#
# These are thin wrappers so those gates needed no edit to gain subshell,
# command-substitution and prefix positions. Their contract is unchanged:
# `cmd_matches_verb` takes a verb ERE that matches from the VERB ONWARD and
# carries its own trailing boundary, and `cmd_last_cd_target` prints nothing
# when there is no `cd` before the verb.

# cmd_matches_verb <command> <verb-ere>
#
# Exit 0 when <verb-ere> appears in command position within <command>. The verb
# is anchored at the START of a segment, which is what "command position" means
# now that segmentation understands subshells and substitutions.
cmd_matches_verb() {
  gate_matches "$1" "^($2)"
}

# cmd_last_cd_target <command> [base-dir] [verb-ere]
#
# Print the working directory the guarded command runs in — following every `cd`
# in command position BEFORE the verb — or nothing when there is no such `cd`.
#
# Two properties are load-bearing, and both were review findings:
#
#   - Only cds BEFORE the verb count. Following every cd let a trailing one
#     hijack the lookup: `gh pr merge N --squash --delete-branch && cd <repo> &&
#     git pull` — the standing post-merge step — silently redirected all seven
#     markgate gates to the main tree's store.
#   - Chained RELATIVE cds compose (`cd /abs/one && cd sub` -> `/abs/one/sub`),
#     which is why the base dir is a parameter.
#
# A cd whose path was entirely QUOTED used to resolve to nothing, because the
# stripper had replaced it with a placeholder and the caller fell back to the
# payload cwd. Segments now carry their original text, so `cd "/a b"` resolves
# properly and that carve-out is gone.
cmd_last_cd_target() {
  local cmd="$1" base="${2:-}" verb="${3:-}" cur="" seen=0 segment cd_target
  # `cur="$base"` on the `local` line would expand $base against the CALLER's
  # scope (bash expands every word of `local` before assigning any of them), so
  # under a caller's `set -u` it aborts with "base: unbound variable".
  cur="$base"
  while IFS= read -r segment; do
    if [ -n "$verb" ] && [[ "$segment" =~ ^($verb) ]]; then
      break
    fi
    if [[ "$segment" =~ ^cd[[:space:]]+$GATE_PATH_TOKEN ]]; then
      cd_target=$(gate_unquote "${BASH_REMATCH[1]}")
      if [ -n "$cd_target" ]; then
        seen=1
        if [[ "$cd_target" == /* ]]; then
          cur="$cd_target"
        else
          cur="${cur:+$cur/}$cd_target"
        fi
      fi
    fi
  done < <(gate_segments "$cmd")
  # An `if`, not a `&&`: a trailing false test would make the function return 1,
  # which a caller running under `set -e` reads as a failure.
  if [ "$seen" = "1" ]; then
    printf '%s' "$cur"
  fi
}
