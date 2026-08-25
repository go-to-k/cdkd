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
    # The index just past the `)` closing a `$(` that starts at `from`, or 0 when
    # it is unbalanced. Depth-counted so `$(a $(b) c)` is one span.
    function close_paren(line, from,   j, depth, c) {
      depth = 1
      for (j = from; j <= length(line); j++) {
        c = substr(line, j, 1)
        if (c == "(") depth++
        else if (c == ")") { depth--; if (depth == 0) return j }
      }
      return 0
    }
    # Separators inside a substitution span are DATA to the ENCLOSING command,
    # so neutralise them the same way a quoted span does. The body of the span is
    # emitted separately (see `extra`), which is what keeps `out=$(git commit)`
    # firing while `git -C $(pwd) commit` also stays one command.
    # The span is re-emitted WRAPPED IN DOUBLE QUOTES, which is what makes an
    # unquoted substitution parse as ONE argument token. Without that,
    # `git -C $(git rev-parse --show-toplevel) commit` still failed to match:
    # the flag-value alternative stops at the first space, so `rev-parse` looked
    # like a bare word and the verb was never reached. An inner double quote is
    # rewritten to a single quote so the wrapper cannot be unbalanced -- the
    # copy queued in `extra` keeps the original text, so nothing is lost for the
    # pass that scans the body as a command.
    function neutralise(s,   k, c, out) {
      out = ""
      for (k = 1; k <= length(s); k++) {
        c = substr(s, k, 1)
        if (c == "&") out = out SEP_AMP
        else if (c == ";") out = out SEP_SEMI
        else if (c == "|") out = out SEP_PIPE
        else if (c == "$") out = out SEP_SUBST
        else if (c == "`") out = out SEP_SUBST
        else if (c == "\"") out = out "'"'"'"
        else out = out c
      }
      return "\"" out "\""
    }
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
          # An escaped character outside quotes is LITERAL: `echo a\; git commit`
          # is ONE echo, and splitting on that `;` blocked it (go-to-k/cdkd#2130
          # test review).
          if (c == "\\") { res = res c substr(line, i + 1, 1); i++; continue }
          if ((c == "\"" || c == "'"'"'") && c != ignore_q && ignore_q != "BOTH") { q = c; res = res c; continue }
          if (c == "$" && substr(line, i + 1, 1) == "(") {
            # DUAL-EMIT (go-to-k/cdkd#2027 review). Splitting here truncated the
            # enclosing command: `git -C $(git rev-parse --show-toplevel) commit`
            # became the segment `git -C `, matched no verb, and EVERY blocking
            # gate exited 0 on a fully determinate commit. Keep the span inline
            # (neutralised, so it cannot split) and queue the body for its own
            # pass, so `out=$(git commit)` still fires too.
            cp = close_paren(line, i + 2)
            if (cp > 0) {
              extra = extra substr(line, i + 2, cp - i - 2) "\n"
              res = res neutralise(substr(line, i, cp - i + 1))
              i = cp
              continue
            }
            res = res "\n"; i++; continue
          }
          # Process substitution runs its body too: `diff <(git commit) …`.
          if ((c == "<" || c == ">") && substr(line, i + 1, 1) == "(") { res = res "\n"; i++; continue }
          if (c == "`") {
            bt = index(substr(line, i + 1), "`")
            if (bt > 0) {
              extra = extra substr(line, i + 1, bt - 1) "\n"
              res = res neutralise(substr(line, i, bt + 1))
              i = i + bt
              continue
            }
            res = res "\n"; continue
          }
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
        if (c == "$" && substr(line, i + 1, 1) == "(") {
          # Queue the body here as well as on the unquoted branch: a command
          # substitution RUNS whatever it contains, quoted or not, so
          # `echo "$(git commit -m x)"` is a commit (go-to-k/cdkd#2027 review
          # round 4 -- the header of this file already said so, while only the
          # unquoted branch acted on it).
          cp = close_paren(line, i + 2)
          if (cp > 0) extra = extra substr(line, i + 2, cp - i - 2) "\n"
          res = res SEP_SUBST "("; i++; continue
        }
        res = res c
      }
      return res
    }
    # One full pass. Runs twice at most: see the END rule.
    function run(   i, line, t, acc, rounds, batch, elines, nlines, ei, __seg) {
      q = ""; tag = ""; pending = ""; acc = ""; extra = ""
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
        # A line that ends INSIDE a quoted span is not a segment boundary: the
        # span continues. Emitting "\n" here promoted every line of a quoted
        # `--body "…"` to a segment START, so prose in a PR body or an issue
        # comment was read as a command -- `gh issue comment 1 --body "we ran:
        # <newline> git -C $W commit -F f"` refused with a remedy naming a `-C`
        # the invocation does not carry (go-to-k/cdkd#2027 review round 4).
        # Newline inside a quoted span is DATA, so it joins as a space.
        __seg = flush_line(line)
        if (q != "") acc = acc __seg " "
        else acc = acc __seg "\n"
        if (pending_tag != "" && terminated(pending_tag, i + 1) > 0) tag = pending_tag
      }
      if (pending != "") acc = acc flush_line(pending) "\n"
      # If the input ended INSIDE a quoted span, the join above left `acc`
      # without a trailing separator and the reader dropped the whole tail.
      # Terminate it (go-to-k/cdkd#2027 review round 5, blocker 1).
      if (acc != "" && substr(acc, length(acc), 1) != "\n") acc = acc "\n"
      # Drain the substitution bodies queued by flush_line, so a command
      # SUBSTITUTION is still scanned as a command in its own right. Bounded:
      # a body can queue more (nested substitutions), so cap the rounds rather
      # than trusting the input to terminate.
      # Bounded so a pathological input cannot spin. Hitting the cap DROPS the
      # remaining bodies, i.e. stops scanning commands, so it is announced on
      # stderr rather than swallowed -- a silent drop here is the fail-open
      # direction this file exists to avoid (go-to-k/cdkd#2027 review round 4).
      rounds = 0
      while (extra != "" && rounds < 8) {
        batch = extra; extra = ""; q = ""
        nlines = split(batch, elines, "\n")
        for (ei = 1; ei <= nlines; ei++) {
          if (elines[ei] == "") continue
          acc = acc flush_line(elines[ei]) "\n"
        }
        rounds++
      }
      if (extra != "") {
        printf "gate_segments: substitution nesting deeper than 8; %d byte(s) of command text were NOT scanned\n", length(extra) > "/dev/stderr"
      }
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
      # Retry treating the offending quote character as literal. TWO passes, and
      # over BOTH characters: text carrying one unbalanced apostrophe AND one
      # unbalanced double quote never cleared `q` with a single retry, so every
      # segment stayed data and the command vanished entirely -- zero segments,
      # every gate disarmed (go-to-k/cdkd#2027 review round 5, blocker 1).
      if (q != "") { ignore_q = q; acc = run() }
      if (q != "") { ignore_q = (ignore_q == "\"") ? "\047" : "\""; acc = run() }
      if (q != "") { ignore_q = "BOTH"; acc = run() }
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
  # Strip leaders until stable: a `case <word> in` opener, a `<pattern>)` arm
  # label, compound keywords, wrappers and env assignments nest
  # (`case a in a) sudo git commit`). `if|while|until|!|sudo|xargs` were missing,
  # so `if <verb>; then …`, `! <verb>` and `sudo <verb>` ran UNGATED — a
  # regression for every gate that traded an unanchored grep for this matcher.
  local prev=""
  while [ "$s" != "$prev" ]; do
    prev="$s"
    # A leading assignment whose value is QUOTED, consumed whole -- including
    # when it is the WHOLE segment, which the general alternation below cannot
    # do because it requires a trailing space. Without this,
    # `MSG="$(echo git commit -m x)"` shed only `MSG="$(echo` and the residue
    # matched the verb (go-to-k/cdkd#2027 review round 4).
    # The boundary after the closing quote is load-bearing. Without it the rule
    # matched the quoted PREFIX of a CONCATENATED value and dropped the rest, so
    # `D="$HOME"/wt git commit -m x`, `FOO="bar"baz …` and `MSG="a"'"'"'b'"'"' …`
    # stopped matching their verb entirely. Requiring whitespace-or-end means a
    # concatenated value falls through to the bare alternation, exactly as it did
    # before (go-to-k/cdkd#2027 review round 5, blocker 2).
    if [[ "$s" =~ ^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=$GATE_QUOTED_VALUE([[:space:]]+(.*))?$ ]]; then
      s="${BASH_REMATCH[3]}"
    fi
    if [[ "$s" =~ ^[[:space:]]*case[[:space:]]+[^[:space:]]+[[:space:]]+in[[:space:]]+(.*)$ ]]; then
      s="${BASH_REMATCH[1]}"
    fi
    if [[ "$s" =~ ^[[:space:]]*[^\(\)\|\;\&[:space:]]+\)[[:space:]]*(.*)$ ]]; then
      s="${BASH_REMATCH[1]}"
    fi
    # The QUOTED-value form of an assignment is handled by the dedicated rule
    # above; this alternation keeps the original bare-value shape ON PURPOSE.
    # Adding a group here shifted every later capture index and silently stopped
    # stripping `VAR=value <verb>`, so `GH_PAGER=cat gh pr edit …` and
    # `CDKD_ALLOW_DIRTY_RESTORE=1 git checkout -- …` stopped matching their verbs
    # (caught by their own suites, go-to-k/cdkd#2027 review round 4).
    if [[ "$s" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|command|nohup|time|timeout[[:space:]]+[^[:space:]]+|exec|then|do|else|elif|if|while|until|!|sudo|xargs|-[A-Za-z][^[:space:]]*|\{|\()[[:space:]]+(.*)$ ]]; then
      s="${BASH_REMATCH[2]}"
    fi
    s="${s#"${s%%[![:space:]]*}"}"
  done
  # Any remaining grouping punctuation at either end (nested subshells).
  while [[ "$s" =~ ^[[:space:]]*[\(\{][[:space:]]*(.*)$ ]]; do s="${BASH_REMATCH[1]}"; done
  while [[ "$s" =~ ^(.*[^[:space:]])[[:space:]]*[\)\}][[:space:]]*$ ]]; do s="${BASH_REMATCH[1]}"; done
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Print one command segment per line, in the ORIGINAL text (placeholders restored).
# Strip one surrounding quote pair from a whole argument (the `bash -c` body).
gate_unquote_span() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

gate_segments() {
  local segment
  # `|| [ -n "$segment" ]`: `read` returns non-zero on a final line with no
  # trailing newline and would DISCARD it. Belt and braces with the terminator
  # added in the awk END rule -- either alone fixes the zero-segment case, and a
  # reader that silently drops its last line is the wrong thing to leave armed
  # (go-to-k/cdkd#2027 review round 5, blocker 1).
  while IFS= read -r segment || [ -n "$segment" ]; do
    # NOT `${segment//"$GATE_SEP_AMP"/&}`: since bash 5.2 an `&` in the
    # replacement means the MATCHED TEXT, so the placeholder survived and a
    # quoted path containing `&` came back corrupted — the gate then failed to
    # resolve the tree and exited 0. macOS bash 3.2 masks it.
    while [[ "$segment" == *"$GATE_SEP_AMP"* ]]; do
      segment="${segment%%"$GATE_SEP_AMP"*}&${segment#*"$GATE_SEP_AMP"}"
    done
    segment="${segment//"$GATE_SEP_SEMI"/;}"
    segment="${segment//"$GATE_SEP_PIPE"/|}"
    segment="${segment//"$GATE_SEP_SUBST"/$}"
    segment=$(gate_strip_prefix "$segment")
    # `bash -c "<cmd>"` RUNS its argument, and that argument is a command LIST:
    # matching it as ONE segment missed `bash -c "cd /w && git commit"`
    # (go-to-k/cdkd#2130 test review). Recurse ONLY here — re-segmenting every
    # segment would split a quoted `--body` whose prose contains `&&`.
    if [[ "$segment" =~ ^(bash|zsh|ksh|sh)[[:space:]]+-[a-z]*c[[:space:]]+(.*)$ ]]; then
      gate_segments "$(gate_unquote_span "${BASH_REMATCH[2]}")"
      continue
    fi
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

# A QUOTED value alone (no bare alternative). Held in a variable for the same
# reason as GATE_PATH_TOKEN: the `'"'"'` idiom that embeds a single quote only
# works in assignment context, and writing it inline inside a function produced
# a pattern that silently never matched (go-to-k/cdkd#2027 review round 4).
GATE_QUOTED_VALUE='("[^"]*"|'"'"'[^'"'"']*'"'"')'

# The regexes, kept here so every gate spells its verb the same way. Each is
# anchored at the START of a segment; `git -C <path>` / `git -c k=v` and
# `gh -C <path>` are absorbed — including a QUOTED path containing spaces, which
# an earlier version could not parse, so `git -C "/a b" commit` matched nothing
# and ran ungated (go-to-k/cdk-local#542 review).
GATE_FLAGS='([[:space:]]+-[^[:space:]]+([[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]-][^[:space:]]*))?)*'
# Every gh GLOBAL FLAG before the subcommand, not just `-C`. The `-C`-only form
# meant a repo flag ahead of the verb made the verb unreachable, so
# `gh -R owner/repo pr merge 1 --squash` matched NOTHING and walked past every
# merge gate while the same command without `-R` was refused (measured on
# verify-pr-gate / integ-destroy-gate / pr-review-gate; go-to-k/cdkd#2027 review
# round 4). `gate_leading_c_value` already treated `-R` / `--repo` as gh flags,
# so the two halves of this file disagreed with each other. Same shape as
# GATE_FLAGS, and like it this contributes THREE capture groups.
GATE_GH_C="$GATE_FLAGS"
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
# issue-dup-check-gate: the one verb that MINTS a new issue. `edit` and
# `comment` are deliberately absent -- folding a finding into an issue that
# already exists is the outcome this gate exists to steer toward, so gating it
# would tax the cheap path and leave the expensive one untouched.
GATE_RE_GH_ISSUE_CREATE="^gh${GATE_GH_C}[[:space:]]+issue[[:space:]]+create([[:space:]]|$)"
# The same mint through the REST verb. `gh api repos/<o>/<r>/issues` with a
# `title=` field creates an issue; the path must NOT continue past `issues`,
# which is what separates it from `/issues/<n>/comments` (a comment) and
# `/issues/<n>` (an edit) -- neither of which mints anything. Sibling
# GATE_RE_GH_BODY_CARRIER already carries `api` for exactly this reason; this
# gate omitting it left the trigger under-approximated, against the
# "over-approximate the TRIGGER, be strict on RESOLUTION" rule in
# .claude/rules/hooks.md.
GATE_RE_GH_API_ISSUE_CREATE="^gh${GATE_GH_C}[[:space:]]+api([[:space:]]|$).*repos/[^[:space:]/]+/[^[:space:]/]+/issues([[:space:]]|$|\")"
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

# gate_expand_tilde <token>
# A `~` reaches a hook as a literal character: it reads the command TEXT, and no
# shell has expanded anything. Expand a LEADING `~/` only, which is the one form
# a shell expands -- rewriting a mid-path `/tmp/~/x` would invent a path no
# shell would ever produce (go-to-k/cdkd#2027 review nit).
gate_expand_tilde() {
  local p="$1"
  if [ -n "${HOME:-}" ]; then
    case "$p" in
      "~") p="$HOME" ;;
      "~/"*) p="$HOME/${p#\~/}" ;;
    esac
  fi
  printf '%s' "$p"
}

# gate_leading_c_value <segment>
#
# The value of the LAST `-C` among the segment's LEADING FLAGS -- the ones
# between the `git`/`gh` word and the verb -- or nothing. Printed with its
# quoting intact so the caller can tell `"$W"` from a literal path.
#
# ANCHORING is the point (go-to-k/cdkd#2027 review, minor 4). The scan this
# replaces was an unanchored search of the whole segment for `(git|gh) -C
# <token>`, taking the last hit, while segments deliberately carry their
# original quoted text. So ARGUMENT PROSE was read as the target:
#
#   git commit -m "repro: git -C $W commit failed"
#
# refused with a message claiming the command "names its target working tree
# with an unexpanded shell variable" when it names no `-C` at all, and told the
# author to re-run with a literal path, which cannot clear it. The body of THIS
# PR contains that exact string. Walking only the leading flags cannot see into
# an argument, and stops at the verb.
#
# It also fixes `git -C /one -C /two commit`, which the unanchored scan resolved
# to `/one` (only the first `-C` sits next to the command word) while git itself
# uses `/two`. Last-wins, like git.
gate_leading_c_value() {
  local seg="$1" tok rest val=""
  # Strip the leading command word; anything else is not a git/gh invocation.
  [[ "$seg" =~ ^[[:space:]]*(git|gh)[[:space:]]+(.*)$ ]] || return 1
  rest="${BASH_REMATCH[2]}"
  while [ -n "$rest" ]; do
    [[ "$rest" =~ ^[[:space:]]*($GATE_PATH_TOKEN)([[:space:]]+(.*))?$ ]] || break
    tok="${BASH_REMATCH[1]}"
    rest="${BASH_REMATCH[4]}"
    case "$tok" in
      -C)
        # The next token is the value, whatever it looks like.
        [[ "$rest" =~ ^[[:space:]]*($GATE_PATH_TOKEN)([[:space:]]+(.*))?$ ]] || break
        val="${BASH_REMATCH[1]}"
        rest="${BASH_REMATCH[4]}"
        ;;
      -c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|-R|--repo)
        # Flags that consume the following token; skip it so a value is never
        # mistaken for the verb.
        [[ "$rest" =~ ^[[:space:]]*($GATE_PATH_TOKEN)([[:space:]]+(.*))?$ ]] && rest="${BASH_REMATCH[4]}"
        ;;
      -*) : ;;
      *) break ;;   # the verb: leading flags are over
    esac
  done
  [ -n "$val" ] && printf '%s' "$val"
  return 0
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
      # An UNEXPANDED path is not a path. `cd "$WT" && …` is the spelling
      # /work-issues mandates; resolving it literally gave `<cwd>/$WT`, which no
      # `git -C` can read, so the gate could not resolve a tree and exited 0.
      # Falling back to the payload cwd fails CLOSED (go-to-k/cdkd#2130 review).
      case "$cd_target" in *'$'*|*'`'*) continue ;; esac
      [ -z "$cd_target" ] && continue
      [[ "$cd_target" != /* ]] && cd_target="$target/$cd_target"
      target="$cd_target"
      continue
    fi
    [[ "$segment" =~ $re ]] || continue
    # Last `-C <path>` among the LEADING FLAGS wins over any earlier cd. Only
    # the leading flags, so argument prose mentioning `-C` is not read as a
    # target (see gate_leading_c_value).
    c_target=$(gate_unquote "$(gate_leading_c_value "$segment")")
    case "$c_target" in *'$'*|*'`'*) c_target="" ;; esac
    if [ -n "$c_target" ]; then
      c_target=$(gate_expand_tilde "$c_target")
      [[ "$c_target" != /* ]] && c_target="$target/$c_target"
      target="$c_target"
    fi
    break
  done < <(gate_segments "$cmd")
  printf '%s' "$target"
}

# gate_target_dir_strict <cmd> <fallback> <extended-regex>
#
# Same resolution as gate_target_dir, with one difference that is the whole
# point: when the command carries a target expression this parser CANNOT read
# -- an unexpanded `$VAR` or a backtick in a `cd` before the verb, or in the
# matched segment's `-C` flag -- it prints nothing and returns 2 instead of
# quietly resolving to something else.
#
# WHY a second function rather than changing gate_target_dir (go-to-k/cdkd#2027).
# The two callers want opposite things from the same unknown:
#
#   - A BLOCKING gate must REFUSE. It is about to decide whether a command is
#     safe; "I could not tell which tree this runs in" is not a pass. Measured
#     on the pre-#2027 tree, the two ways of getting this wrong were equally
#     silent: a hook that hand-rolled its own `-C` parse resolved `"$W"` to the
#     literal `<cwd>/$W`, failed its `git -C ... rev-parse` probe and exited 0
#     (12 hooks), while a hook that called gate_target_dir dropped the token and
#     judged the PAYLOAD CWD instead -- so `git -C "$W" commit` from a clean
#     worktree passed a staged violation that lived in the target tree
#     (measured on provider-docs-gate and provider-integ-gate: exit 2 for the
#     literal `-C <abs>` spelling, exit 0 for the `"$W"` one).
#   - A NON-BLOCKING detector must stay QUIET, and a snapshotter (restore-backup)
#     is better off snapshotting the fallback than snapshotting nothing. Those
#     keep calling gate_target_dir.
#
# So the fallback behaviour is still available and still correct for its
# callers; what changed is that a gate can now tell "resolved to the fallback"
# from "could not resolve at all", which is the distinction the old single
# return value could not carry.
gate_target_dir_strict() {
  local cmd="$1" fallback="$2" re="$3"
  local target="$fallback" segment cd_target c_target remaining unresolved_cd=0
  while IFS= read -r segment; do
    if [[ "$segment" =~ ^cd[[:space:]]+$GATE_PATH_TOKEN ]]; then
      cd_target=$(gate_unquote "${BASH_REMATCH[1]}")
      # Only a cd BEFORE the verb steers the command; the loop breaks at the
      # verb, so the standing `git commit ... && cd <repo> && git pull` form
      # never reaches here and is not refused. An unreadable one is REMEMBERED
      # rather than refused on the spot, because an absolute `-C` in the verb
      # segment can still make it moot -- see below.
      # A GLOB, a brace expansion or a `~user` prefix is exactly as unreadable as
      # a variable: the shell expands it and the command lands in a real repo,
      # while this parser cannot say which one. `~/` and a bare `~` stay
      # readable, because HOME is expanded here correctly
      # (go-to-k/cdkd#2027 review round 5, minor 3).
      case "$cd_target" in
        *'$'*|*'`'*|*'*'*|*'?'*|*'{'*) unresolved_cd=1; continue ;;
        '~'|'~/'*) : ;;
        '~'*) unresolved_cd=1; continue ;;
      esac
      [ -z "$cd_target" ] && continue
      cd_target=$(gate_expand_tilde "$cd_target")
      if [[ "$cd_target" == /* ]]; then
        # An ABSOLUTE cd decides the working directory outright, so an earlier
        # unreadable one no longer matters: `cd "$W" && cd /abs/wt && git commit`
        # is fully determinate. Same argument the `-C` branch already made
        # (go-to-k/cdkd#2027 review, minor 6).
        target="$cd_target"
        unresolved_cd=0
      else
        target="$target/$cd_target"
      fi
      continue
    fi
    [[ "$segment" =~ $re ]] || continue
    c_target=$(gate_leading_c_value "$segment")
    if [ -n "$c_target" ]; then
      c_target=$(gate_unquote "$c_target")
      case "$c_target" in
        *'$'*|*'`'*|*'*'*|*'?'*|*'{'*) return 2 ;;
        '~'|'~/'*) : ;;
        '~'*) return 2 ;;
      esac
      c_target=$(gate_expand_tilde "$c_target")
      if [ -n "$c_target" ]; then
        if [[ "$c_target" == /* ]]; then
          # An ABSOLUTE -C decides where the command runs whatever any earlier
          # cd did, so an unreadable cd before it is no longer a reason to
          # refuse. Refusing here would reject `cd "$W" && git -C /abs commit`,
          # which is perfectly determinate.
          target="$c_target"
          unresolved_cd=0
        else
          # A RELATIVE -C is resolved against wherever the cds left us, so it
          # inherits their uncertainty rather than curing it.
          target="$target/$c_target"
        fi
      fi
    fi
    break
  done < <(gate_segments "$cmd")
  [ "$unresolved_cd" = 1 ] && return 2
  printf '%s' "$target"
}

# gate_refuse_unresolved_target <gate-name> <fallback-dir> [extra-line ...]
#
# The refusal half of gate_target_dir_strict, shared so every gate says the same
# thing and names the same fix. EXITS the calling hook: 2 to refuse, or 0 when
# this gate has no standing (below).
#
# BOUNDED BY THE REPO OPT-IN, and the bound is answered from THIS HOOK's own
# checkout -- NOT from the payload cwd, which is what it used to consult. These
# hooks fire on every git/gh command the agent runs ANYWHERE, so the bound still
# matters; what changed is who answers it. Asking the cwd "is this a gating
# repo?" is asking the drifted thing, precisely when the target is unknown, and
# it produced a silent pass on the very command this refusal exists for. The
# payload cwd survives only as a fallback for a copy of these hooks vendored
# somewhere without a `.markgate.yml`.
gate_refuse_unresolved_target() {
  local gate="$1" base="${2:-$PWD}" own line
  shift 2 2>/dev/null || shift $#
  # The opt-in is answered from THIS HOOK's own checkout, not from the payload
  # cwd (go-to-k/cdkd#2027 review, minor 5). Asking the cwd "is this a gating
  # repo?" is asking the drifted thing whether to enforce: measured, a session
  # whose cwd had wandered out of the worktree got rc=0 and a silent pass on the
  # very command this refusal exists for -- #2027 surviving inside its own fix.
  # A hook only runs because it was loaded from a repo that installs it, so its
  # own root answers the policy question without depending on where the shell
  # happens to be.
  #
  # This does NOT reintroduce go-to-k/cdkd#559, which was about the marker
  # STORE: #559 removed BASH_SOURCE from the resolution of WHERE `markgate
  # verify` runs, because that has to follow the worktree the command targets.
  # Callers still resolve that from the payload cwd; only the "does this gate
  # apply at all" question is answered here, and each worktree carries its own
  # `.claude/hooks` and `.markgate.yml` (verified), so this stays per-worktree.
  # lib/command-match.sh -> <repo>/.claude/hooks/lib, so the root is three up.
  own="${BASH_SOURCE[0]%/*}/../../.."
  if [ ! -f "$own/.markgate.yml" ]; then
    # Fall back to the payload cwd rather than refusing everywhere: a copy of
    # these hooks vendored somewhere without a `.markgate.yml` has no standing.
    local top
    top=$(git -C "$base" rev-parse --show-toplevel 2>/dev/null) || top=""
    if [ -z "$top" ] || [ ! -f "$top/.markgate.yml" ]; then
      exit 0
    fi
  fi
  echo "Blocked by $gate: this command names its target working tree with an" >&2
  echo "expression the hook cannot read -- an unexpanded shell variable, or a" >&2
  echo "backtick. The hook sees the command TEXT, not your shell's expansion of" >&2
  echo "it, so it cannot tell which tree this would run in, and it will not pass" >&2
  echo "a command it could not evaluate (go-to-k/cdkd#2027)." >&2
  echo "" >&2
  echo "  Re-run with a literal absolute path:" >&2
  echo "    git -C /abs/path/to/worktree <verb> ..." >&2
  echo "    cd /abs/path/to/worktree && <verb> ..." >&2
  for line in "$@"; do
    printf '%s\n' "$line" | sed 's/^\(.\)/  \1/' >&2
  done
  exit 2
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
      # An UNEXPANDED path is not a path: `cd "$WT" && …` must be SKIPPED, not
      # resolved to `<cwd>/$WT`, which no `git -C` can read — the callers then
      # exited 0 over a tree they never checked (go-to-k/cdkd#2130 review). The
      # `has_cd_before_verb` companion is what tells "unresolvable" from "absent".
      case "$cd_target" in *'$'*|*'`'*) cd_target="" ;; esac
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
