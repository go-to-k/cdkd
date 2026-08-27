#!/usr/bin/env bash
# VENDORED: lib/command-match.sh as of 84480c414b3573ef70e3b01b8afd769bb65f7ddf,
# i.e. the PRE-2156 trigger (that sha was the go-to-k/cdkd#2156 lane's merge
# base when taken; the lane has been rebased since, and the sha stays because
# what matters is the CONTENT, not the graph position). Read by
# command-match-differential.test.sh to enforce the SUPERSET invariant.
# Vendored rather than read with `git show` because CI shallow-clones; pinned
# to a sha rather than to `origin/main` because origin/main moves and would
# eventually contain this very change, making the comparison vacuous.
# VENDORED CONTENT BEGINS
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
# A flag VALUE may embed a quoted span containing spaces -- `git -c
# user.name="Jane Doe" commit` is the everyday shape. The value alternative
# stops at the first space, so the flag loop ends mid-value and the verb is
# never reached: measured on origin/main, `git commit -m x` on `main` gives
# branch-gate rc=2 while `git -c user.name="Jane Doe" commit -m x` gives rc=0 --
# a commit straight to main, ungated, and the same hole in EVERY gate keyed on
# GATE_FLAGS.
#
# FIXED, go-to-k/cdkd#2200. Both halves were needed and the first attempt
# shipped only one: widening the value alternative adds CAPTURE GROUPS, and
# callers used to index them positionally (`dirty-path-restore-gate.sh` read
# `BASH_REMATCH[4]`), so the widening alone made that gate stop blocking
# `git checkout -- <dirty path>` in 7 of its 18 cases and the class fence
# reported it "gone quiet". Trading a `git -c` bypass for a `git checkout --`
# bypass is not a fix, so that attempt was reverted.
#
# The durable half is that NO caller indexes into this pattern any more. The two
# that did now strip the matched prefix by LENGTH via `gate_verb_rest` /
# `gate_pr_selector`, so the group count is internal to this file and the next
# widening cannot shift anything. Fence 4 of unresolved-target-class.test.sh
# keeps that true: it refuses any hook that builds its own match from a shared
# GATE_ constant and then reads a numbered group out of it, so a change here
# fails with a message naming this paragraph rather than silently re-opening a
# gate.
#
# A flag TOKEN and a flag VALUE both embed quoted spans now, so
# `--author="Jane Doe"` and `-c user.name="Jane Doe"` are each a single token.
# A value still may not BEGIN with `-`: without that restriction
# `git -C /tmp -q commit` reads `-q` as `-C`'s value.
# One shell word that may EMBED quoted spans: `user.name="Jane Doe"` is one
# token, `"Jane Doe"` is one token, and a bare space still ends it.
# `\"` is an escaped quote wherever it appears -- INSIDE a double-quoted span it
# does not end the span, and OUTSIDE one it is an ordinary character rather than
# an opener. Both alternatives are needed and the second is easy to forget: an
# earlier version of this change added the in-span form and, in the same commit,
# narrowed the blind fallback to exclude `"`, which is what used to cover the
# out-of-span case. Nothing matched `\"` any more, and
# `git -c user.name=O\"Brien checkout -- f.txt` went from rc=2 to rc=0 --
# a bypass introduced by the commit that was closing one. Removing a false
# POSITIVE and removing a match are the same edit from the pattern's side.
# Without the escape alternative `git -c k="a\" b" commit -m x` gave branch-gate
# rc=0 on `main` while the plain form gave rc=2 -- the same bypass this whole
# change is about, one escape deeper (found in review of go-to-k/cdkd#2200).
# Single quotes take no escapes in shell, so only the double-quoted span needs
# one.
_GATE_WORD_CHAR='("([^"\\]|\\.)*"|'"'"'[^'"'"']*'"'"'|\\.|[^[:space:]"'"'"'])'
# The same, but the FIRST character may not be `-`, so a following flag is never
# swallowed as the previous flag's value.
_GATE_WORD_CHAR_NODASH='("([^"\\]|\\.)*"|'"'"'[^'"'"']*'"'"'|\\.|[^[:space:]"'"'"'-])'
# Each half keeps the OLD quote-blind alternative as a fallback, and it is
# load-bearing rather than belt-and-braces: the embedding form treats a bare
# `'"'"'` as opening a quoted span, so a path with an UNBALANCED apostrophe
# (`git -C /tmp/o'"'"'neill/repo commit`) stops matching entirely. Dropping it
# cost exactly the two apostrophe cases go-to-k/cdkd#2199 added, which is how
# this was caught. The two forms are not ranked -- POSIX leftmost-longest is
# about the WHOLE match, so a command can legitimately take the blind parse even
# with balanced quotes (`git -c foo="x commit -m y" status` does). That is fine
# here because the blind form covers whatever the strict one cannot parse.
#
# Do NOT rewrite this as "the strict form wins when quotes balance" (it does
# not), and do NOT reason that these alternatives are a strict SUPERSET of the
# old pattern so the change can only ADD matches. An earlier version of this
# comment said exactly that, three lines above a change that narrowed the blind
# form -- and that claim is precisely what makes a reviewer skip checking for
# LOST matches. Every edit here needs the differential fence run in both
# directions.
# The blind form deliberately excludes `"`. Allowing it made the fallback able
# to parse HALF of a double-quoted token, and POSIX leftmost-longest then
# PREFERS that reading whenever it produces a match the strict reading does not:
# `git -c alias.x="run commit later" status` matched GATE_RE_GIT_COMMIT, taking
# the `commit` inside the quoted value as the verb. A gate firing on an
# unrelated command is far less dangerous than a bypass -- it refuses with an
# actionable message -- but it is still wrong, and it was found by a polarity
# control rather than reasoned about. Apostrophes stay in, because the whole
# reason this alternative exists is an UNBALANCED one (`/tmp/o'neill/repo`);
# double quotes have the strict form to fall back on.
_GATE_WORD_BLIND='[^[:space:]"]*'
_GATE_WORD_BLIND_NODASH='[^[:space:]"-][^[:space:]"]*'
GATE_FLAGS="([[:space:]]+-(${_GATE_WORD_CHAR}+|${_GATE_WORD_BLIND})([[:space:]]+(${_GATE_WORD_CHAR_NODASH}${_GATE_WORD_CHAR}*|${_GATE_WORD_BLIND_NODASH}))?)*"
# Every gh GLOBAL FLAG before the subcommand, not just `-C`. The `-C`-only form
# meant a repo flag ahead of the verb made the verb unreachable, so
# `gh -R owner/repo pr merge 1 --squash` matched NOTHING and walked past every
# merge gate while the same command without `-R` was refused (measured on
# verify-pr-gate / integ-destroy-gate / pr-review-gate; go-to-k/cdkd#2027 review
# round 4). `gate_leading_c_value` already treated `-R` / `--repo` as gh flags,
# so the two halves of this file disagreed with each other. Same shape as
# GATE_FLAGS, and like it its group count is nobody else's business.
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
# The two halves of GATE_RE_GIT_CHECKOUT_RESTORE, separately. A caller that
# needs the ARGUMENT TAIL has to know which verb fired -- `git checkout` is a
# path restore only when `--` is present, while `git restore` is path-scoped by
# default -- so it cannot use the combined form.
GATE_RE_GIT_CHECKOUT="^git${GATE_FLAGS}[[:space:]]+checkout([[:space:]]|$)"
GATE_RE_GIT_RESTORE="^git${GATE_FLAGS}[[:space:]]+restore([[:space:]]|$)"
GATE_RE_GIT_CHECKOUT_RESTORE="^git${GATE_FLAGS}[[:space:]]+(checkout|restore)([[:space:]]|$)"
GATE_RE_GH_PR_CREATE_OR_MERGE="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+(create|merge)([[:space:]]|$)"
# non-english-text-gate guards every way PR prose reaches GitHub.
GATE_RE_GH_PR_MERGE_OR_EDIT="^gh${GATE_GH_C}[[:space:]]+pr[[:space:]]+(merge|edit)([[:space:]]|$)"
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
# issue-classification-label-gate: the CLAIM site. `/work-issues` section 3
# says most open bodies are still in the old packed shape and are upgraded to
# the four-line shape when the issue is claimed, so `edit` -- not `create` -- is
# where `Severity` first exists for the bulk of the backlog. `comment` stays
# absent: a comment is not the issue's classification.
GATE_RE_GH_ISSUE_EDIT="^gh${GATE_GH_C}[[:space:]]+issue[[:space:]]+edit([[:space:]]|$)"
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

# gate_pr_selector <command> <verb-ere>
#
# The first non-flag token AFTER the matched verb, taken from the segment that
# actually matched. Empty when there is none.
#
# WHY THIS EXISTS. Three gates hand-rolled `args="${cmd##*gh pr merge}"` — a
# longest-prefix strip on the LITERAL string. Once `GATE_GH_C` was widened to
# absorb `-R <owner/repo>`, those gates began to FIRE on the flagged spelling
# while still failing to strip it: the literal `gh pr merge` does not appear in
# `gh -R go-to-k/cdkd pr merge 2195`, so `##*` matches nothing and returns the
# WHOLE command, and whatever runs next reads the wrong thing out of it.
# Measured 2026-08-25 against the shipped hooks:
#
#   gh pr merge 2195 --squash                        -> pr-review-gate: PR #2195
#   sleep 30 && gh -R go-to-k/cdkd pr merge 2195 ...  -> pr-review-gate: PR #30
#
# i.e. an unrelated PR's size decided the review tier, and for
# closes-paren-form-gate the selector came back empty and the gate exited 0.
# Widening the flag absorber was NECESSARY AND NOT SUFFICIENT: it moved the
# bypass one step later rather than closing it. The same pair of defects was
# found independently in cdk-local and cdk-real-drift.
#
# The regexes are anchored at `^`, so the match always starts at offset 0 and
# its LENGTH is a safe strip — `${segment#${BASH_REMATCH[0]}}` is not, because
# the matched text is then treated as a glob pattern.
# gate_verb_rest <command> <verb-ere>
# Everything AFTER the matched verb, for callers that run their own token walk.
# Same rationale and the same anchored-match strip as gate_pr_selector.
gate_verb_rest() {
  local cmd="$1" re="$2" segment
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] || continue
    printf '%s' "${segment:${#BASH_REMATCH[0]}}"
    return 0
  done < <(gate_segments "$cmd")
  return 0
}

# gate_verb_rest_each <command> <verb-ere>
#
# Every matching segment's tail, one per line, instead of only the first.
#
# The FIRST-ONLY form is a trap for any gate whose verdict depends on the
# arguments, and dirty-path-restore-gate fell into it during review of
# go-to-k/cdkd#2200: it probed `checkout`, got segment 1 of
# `git checkout main && git checkout -- f.txt`, saw no `--`, and exited 0 --
# never looking at the segment that actually discards the file. The raw-command
# match it replaced had a greedy `(.*)$` that ran past the operator, so it still
# saw the later `--`. Measured old-vs-new on a repo with a dirty `f.txt`:
#
#   git checkout main && git checkout -- f.txt    BLOCK -> pass
#   git checkout -b wip && git restore -- f.txt   BLOCK -> pass
#   git checkout main; git restore -- f.txt       BLOCK -> pass
#
# So a gate that ASKS A QUESTION ABOUT THE ARGUMENTS must use this and consider
# every segment; `gate_verb_rest` is only safe when the first match settles the
# answer (resolving one PR number, say).
gate_verb_rest_each() {
  local cmd="$1" re="$2" segment
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] || continue
    printf '%s\n' "${segment:${#BASH_REMATCH[0]}}"
  done < <(gate_segments "$cmd")
  return 0
}

# gate_pr_selector_ate_number <command> <verb-ere>
#
# Exit 0 when the walk CONSUMED a numeric token as some flag's value.
#
# It reports what the WALK did, NOT that the selector is empty -- and the two
# differ: `gh pr merge -t 42 552` yields selector `552` AND ate=YES, because 42
# was eaten by `-t` and 552 was still found. A caller must therefore check
# emptiness FIRST and consult this only then; treating ate=YES alone as a
# refusal would reject valid commands. An earlier version of this comment said
# "the selector is empty because a flag ate it", which is false in exactly that
# case.
#
# A separate FUNCTION, not a variable, and that is forced rather than stylistic:
# every caller reads the selector as `$(gate_pr_selector …)`, and a subshell
# assignment cannot reach the parent. Measured while adding it -- the flag read
# back empty at every call site.
#
# The distinction matters because a corrected COMMENT does not close the hole
# for the next unlisted flag. `gh pr merge --squash` -> empty, and falling back
# to the current branch is right. `gh pr merge --future-flag 552` -> empty
# because 552 was eaten, and falling back there is how a sibling repo's
# ci-green-gate merged past red CI.
gate_pr_selector_ate_number() {
  local out
  out=$(_gate_sel_want_ate=1 gate_pr_selector "$1" "$2")
  [ "$out" = "ate" ]
}

gate_pr_selector() {
  local cmd="$1" re="$2" segment rest tok
  while IFS= read -r segment; do
    [[ "$segment" =~ $re ]] || continue
    rest="${segment:${#BASH_REMATCH[0]}}"
    # Globbing OFF around the split: an unquoted `*` in the tail would
    # otherwise expand against the hook's cwd and a stray filename could become
    # the selector (measured: with files `77` and `aaa` present,
    # `gh pr merge --some-flag * 552` yielded 77).
    # Tokenise with GATE_EMBEDDING_TOKEN so a QUOTED flag value is ONE token.
    # A plain word-split makes `--subject "chore: x" 2195` three tokens, the
    # flag consumes `"chore:` and the walk then sees `x"` -- non-numeric, so the
    # selector comes back empty. Empty is the safe direction, but it is still a
    # miss, and it is the same tokenisation defect that let a `-C` inside a
    # quoted value become a target.
    # Save the caller's noglob setting rather than forcing it off: an
    # unconditional `set +f` below turned globbing ON for a caller that had it
    # off.
    local _gate_noglob=off
    case "$-" in *f*) _gate_noglob=on ;; esac
    set -f
    # shellcheck disable=SC2086
    set --
    while [[ "$rest" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN([[:space:]]+(.*))?$ ]]; do
      set -- "$@" "${BASH_REMATCH[1]}"
      rest="${BASH_REMATCH[4]}"
      [ -n "$rest" ] || break
    done
    [ "$_gate_noglob" = "on" ] || set +f
    while [ $# -gt 0 ]; do
      case "$1" in
        # VALUELESS flags are enumerated; everything else that looks like a flag
        # is assumed to TAKE a value and consumes the next token.
        #
        # The polarity is the whole point, and the opposite one was tried and
        # measured wrong. Enumerating VALUE-TAKERS instead goes stale in the
        # DANGEROUS direction: an unlisted value-taking flag leaves its value in
        # place, so `gh pr merge -R go-to-k/cdkd 552` yields the repo SLUG and
        # `gh pr merge -t 42 552` yields 42 -- a gate then judges a different PR
        # and blocks or passes on its verdict. Enumerating VALUELESS flags goes
        # stale the SAFE-ER way: an unlisted valueless flag eats the number and
        # the selector comes back EMPTY.
        #
        # Be precise about what EMPTY costs, because an earlier version of this
        # comment overstated it. Empty does NOT mean "the caller refuses". It
        # means the caller resolves the CURRENT BRANCH's PR instead
        # (`gh pr checks` with no argument), which is right when the command
        # runs from the PR's own worktree and WRONG from anywhere else. A
        # sibling repo measured a worse version of the same thing: there, an
        # empty selector reached a `no pull requests found` fail-open arm and
        # the gate PASSED, so `gh pr merge -s 2195` merged past red CI.
        #
        # So the polarity argument is real but bounded: wrong-PR is severe and
        # deterministic, empty-PR is a fallback whose safety depends on the
        # caller. That is why this list carries BOTH spellings of every flag
        # rather than relying on the direction of staleness to save it, and why
        # callers should shape-check the selector independently.
        # BOTH spellings. `gh help pr merge` documents `-s/--squash`,
        # `-m/--merge`, `-r/--rebase`, `-d/--delete-branch`; listing only the
        # long forms sent every short one down the value-consuming arm, which
        # ATE the PR number: `gh pr merge -s 2195` returned an empty selector.
        # `--flag=value` carries its value INSIDE the token, so it must not
        # also consume the next one -- `gh pr merge --repo=go-to-k/cdkd 552`
        # returned empty before this arm. The hand-walk this helper replaced
        # had it; dropping it was a regression the replacement introduced.
        --*=*)
          shift; continue ;;
        --squash|-s|--merge|-m|--rebase|-r|--delete-branch|-d)
          # `-m` COLLIDES across the two verbs this list serves: it is
          # `--merge` (valueless) for `gh pr merge` and `--milestone`
          # (value-TAKING) for `gh pr edit`. Listed valueless, deliberately.
          # On `pr merge`, treating it as value-taking loses the PR number --
          # the blocker this list exists for. On `pr edit`, `-m "Q3 plan" 42`
          # leaves a quoted non-numeric token that the numeric guard below
          # drops, so the selector is EMPTY: a fallback, not a wrong PR. Only
          # a milestone literally NAMED a number, in first position, could
          # mis-resolve. Found by a sibling repo re-deriving this list from
          # `gh help` rather than copying it.
          shift; continue ;;
        --remove-milestone|--help)
          shift; continue ;;
        --auto|--disable-auto|--admin)
          shift; continue ;;
        -*)
          shift
          if [ $# -gt 0 ]; then
            # Did this flag swallow something that LOOKED like the PR number?
            # That is the case the caller must not treat as a plain absence.
            case "$1" in
              ''|*[!0-9]*) ;;
              *) [ -n "${_gate_sel_want_ate:-}" ] && { printf 'ate'; return 0; } ;;
            esac
            shift
          fi
          continue ;;
      esac
      # And a final guard: the callers all want a PR NUMBER. A non-numeric
      # token (a branch name, a URL, a repo slug that slipped through) is not
      # one, and handing it on is how the flag-value bugs above became
      # wrong-PR verdicts rather than harmless misses.
      case "$1" in
        ''|*[!0-9]*)
          # A non-numeric first positional means we consumed something that
          # was not the PR number. Record it: the caller must be able to tell
          # "no selector was given" from "a flag ATE the selector", because a
          # corrected comment does not close the hole for the NEXT unlisted
          # flag. `gh pr merge --squash` -> empty and safe to fall back;
          # `gh pr merge --future-flag 552` -> empty because 552 was eaten,
          # and falling back there is how a sibling's ci-green merged past red
          # CI. One walk answers both so the two cannot drift apart.
          return 0 ;;
      esac
      printf '%s' "$1"
      return 0
    done
    return 0
  done < <(gate_segments "$cmd")
  return 0
}

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
# A token that may EMBED quoted spans, e.g. `core.pager="less -C /evil"`.
# `GATE_PATH_TOKEN` is a quoted span OR a bare run of non-space, so it splits
# that at the first space and the tail `-C /evil"` is then read as a fresh
# `-C` flag. Measured on origin/main (pre-existing, not introduced by the
# selector work): `git -c core.pager="less -C /evil" commit -m y` resolved the
# target to `/evil`, and through the real hook with the repo on `main`,
# `git commit -m x` gives rc=2 while the same command with that `-c` prefix
# gives rc=0 -- a branch-gate BYPASS driven entirely by a flag VALUE.
GATE_EMBEDDING_TOKEN='(("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]"'"'"'])+)'

gate_leading_c_value() {
  local seg="$1" tok rest val=""
  # Strip the leading command word; anything else is not a git/gh invocation.
  [[ "$seg" =~ ^[[:space:]]*(git|gh)[[:space:]]+(.*)$ ]] || return 1
  rest="${BASH_REMATCH[2]}"
  while [ -n "$rest" ]; do
    # Embedding token first; fall back to the plain one when it cannot match.
    # The embedding class excludes bare quote characters, so an UNBALANCED
    # apostrophe -- a path like `/tmp/o'neill/repo`, or `user.name=O'Brien` --
    # made the whole token fail and this function returned NOTHING. Measured:
    # `git -C /tmp/o'neill/repo commit` resolved the target on origin/main and
    # fell back to the session cwd here, and `gate_target_dir_strict` cannot
    # refuse it because it cannot tell "no -C" from "unparsable -C". That is
    # the silent-fallback class go-to-k/cdkd#2200 was reverted for.
    if [[ "$rest" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN([[:space:]]+(.*))?$ ]]; then
      tok="${BASH_REMATCH[1]}"
      rest="${BASH_REMATCH[4]}"
    elif [[ "$rest" =~ ^[[:space:]]*($GATE_PATH_TOKEN)([[:space:]]+(.*))?$ ]]; then
      tok="${BASH_REMATCH[1]}"
      rest="${BASH_REMATCH[4]}"
    else
      break
    fi
    case "$tok" in
      -C)
        # The next token is the value, whatever it looks like.
        if [[ "$rest" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN([[:space:]]+(.*))?$ ]]; then
          val="${BASH_REMATCH[1]}"; rest="${BASH_REMATCH[4]}"
        elif [[ "$rest" =~ ^[[:space:]]*($GATE_PATH_TOKEN)([[:space:]]+(.*))?$ ]]; then
          val="${BASH_REMATCH[1]}"; rest="${BASH_REMATCH[4]}"
        else break; fi
        ;;
      -c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|-R|--repo)
        # Flags that consume the following token; skip it so a value is never
        # mistaken for the verb.
        if [[ "$rest" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN([[:space:]]+(.*))?$ ]]; then
          rest="${BASH_REMATCH[4]}"
        elif [[ "$rest" =~ ^[[:space:]]*($GATE_PATH_TOKEN)([[:space:]]+(.*))?$ ]]; then
          rest="${BASH_REMATCH[4]}"
        fi
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

# =============================================================================
# Cross-repo marker naming (go-to-k/cdkd#2236)
# =============================================================================
#
# These hooks fire on EVERY Bash call the session makes, including ones that
# target a SIBLING repository -- deliberate policy (CLAUDE.md: "cdkd's gate
# policy is applied to that repo's commands ... never route around it"). The
# integ gates then `cd` to the resolved target tree and ask markgate about a
# gate named for cdkd: `integ-local`, `integ-destroy`, `integ-broad`,
# `integ-schema-migration`. A repo that spells the same gate differently --
# cdk-local names its Docker local-execution gate `integ` -- fails that verify
# NO MATTER WHAT, so the merge became unsatisfiable by any legitimate action.
#
# Measured 2026-08-26 with markgate 0.4.1: NO PER-GATE query distinguishes
# "this repo does not declare that gate" from "the marker is stale".
# `verify <undeclared>` exits 1 with no output, and `status <undeclared>` exits
# 1 printing `state: no marker` -- byte-identical to a declared-but-unset gate.
# That is the decisive fact, because a gate hook asks about ONE named gate.
#
# markgate is not blind to definedness in general: BARE `markgate status` lists
# every gate and tags the declared ones `(configured)` (rc=1, ~2s on this repo).
# It is not used here for two reasons -- it is a whole extra subprocess on every
# gated merge in a PreToolUse hook, and it needs markgate resolvable in the
# target repo before the definedness question can even be asked, whereas reading
# the config does not. Do not repeat the earlier, wider claim that markgate
# "cannot answer definedness at all": it can, just not per-gate, and a future
# author who finds `markgate status` should not conclude this rationale was
# sloppy. `gate_markgate_declares` reads `.markgate.yml` directly.
#
# WHY AN EXPLICIT PER-REPO TABLE RATHER THAN DISCOVERY. Discovering "the gate
# that means the same thing" from the target's `.markgate.yml` needs a property
# that separates it from the repo's other gates, and none exists: cdk-local's
# `integ` include is `src/**` + `tests/integration/**`, a strict SUPERSET of its
# `check` gate's `src/**`, and both `check` and `integ` would match any
# scope-overlap heuristic. `ttl:` + `hash: diff` is not a discriminator either
# -- cdk-real-drift's `integ` gate carries both and is a READ-ONLY AWS gate with
# no Docker in it. Every heuristic's failure mode is a false ACCEPT: merging on
# the strength of a marker that attests to something else, which is exactly the
# defect `markgate-gate-name-class.test.sh` exists to refuse. So the mapping is
# DECLARED, keyed on the target repo as well as the gate name, and an unknown
# repo gets a refusal rather than a guess.
#
# GATE_MARKER_ALIASES rows: <host>/<owner>/<repo>|<cdkd gate>|<that repo's gate>|<how to refresh it there>
# The slug carries the HOST on purpose -- see gate_repo_slug.
#
# Only same-PURPOSE pairs belong here. `integ-destroy` / `integ-broad` /
# `integ-schema-migration` deliberately have NO row: neither sibling has a
# destroy path, a broad real-AWS matrix, or a state schema, so mapping any of
# them onto cdk-local's Docker `integ` (or cdk-real-drift's read-only one) would
# accept a marker that never exercised the code being gated.
GATE_MARKER_ALIASES='
github.com/go-to-k/cdk-local|integ-local|integ|/run-integ local-<test> (cdk-local'"'"'s /run-integ sets its integ marker after a clean Docker run with an empty container / network sweep)
'

# gate_markgate_declares <repo-top> <gate-name>
#
# Exit 0  the repo DECLARES that gate under `gates:` in its `.markgate.yml`.
# Exit 1  the repo positively does NOT declare it (a `gates:` block was parsed
#         and the name is absent, or there is no `.markgate.yml` at all).
# Exit 2  UNDETERMINABLE -- the file exists but no `gates:` block with at least
#         one entry could be parsed. Callers must fail CLOSED on 2 and keep the
#         cdkd gate name, so a config this parser does not understand can never
#         route a merge onto some other repo's marker.
gate_markgate_declares() {
  local top="$1" want="$2" file names
  file="$top/.markgate.yml"
  # No config at the repo top is how every other hook in this repo decides a
  # checkout is not a markgate repo (branch-gate.sh, check-gate.sh). Nothing is
  # declared there, so the answer is a definite "no", not "cannot tell".
  [ -f "$file" ] || return 1
  names=$(gate_markgate_declared_gates "$file") || return 2
  case "
$names
" in
    *"
$want
"*) return 0 ;;
  esac
  return 1
}

# gate_markgate_declared_gates <markgate-yml-path>
#
# Prints the first-level keys of the `gates:` block, one per line. Exit 2 (and
# no output) when no such block with at least one entry is found.
gate_markgate_declared_gates() {
  awk '
    { line = $0; sub(/\r$/, "", line) }
    line ~ /^[ \t]*$/  { next }
    line ~ /^[ \t]*#/  { next }
    !in_gates {
      if (line ~ /^gates:[ \t]*(#.*)?$/) { in_gates = 1 }
      next
    }
    # Any other column-0 key ends the block.
    line ~ /^[^ \t]/ { in_gates = 0; next }
    {
      match(line, /^[ \t]+/)
      indent = RLENGTH
      if (ref == 0) ref = indent
      if (indent != ref) next
      rest = substr(line, indent + 1)
      # A trailing value or comment is tolerated (`check: {}`, `check: # x`):
      # a key that only ever matched a bare `name:` would report a declared gate
      # as ABSENT, and that direction routes the merge somewhere else.
      if (rest ~ /^[A-Za-z0-9_.-]+:([ \t].*)?$/) {
        sub(/:.*$/, "", rest)
        print rest
        found = 1
      }
    }
    END { exit (found ? 0 : 2) }
  ' "$1"
}

# gate_repo_slug <dir>
#
# Prints `<host>/<owner>/<name>` for the checkout's `origin` remote, or exits 1
# when there is no origin, or when the URL carries no HOST (a local-path remote
# such as `/srv/mirrors/go-to-k/cdk-local`, or a bare relative path).
#
# THE HOST IS PART OF THE KEY, and dropping it reopened the exact hole this
# table exists to close: `https://gitlab.com/go-to-k/cdk-local.git` and a local
# clone at `/x/go-to-k/cdk-local` both reduce to `go-to-k/cdk-local`, so an
# unrelated repository that merely shares a path tail would inherit cdk-local's
# alias and be merged on its marker. An unkeyable remote returns 1, which
# degrades to "no alias declared" -- a refusal, never a guess.
#
# Handles the three spellings git actually produces:
#   https://github.com/o/r(.git)      scp-like  git@github.com:o/r(.git)
#   ssh://git@github.com/o/r(.git)
gate_repo_slug() {
  local url host path rest
  url=$(git -C "$1" config --get remote.origin.url 2>/dev/null) || return 1
  [ -n "$url" ] || return 1
  url="${url%.git}"
  url="${url%/}"

  case "$url" in
    *://*)
      rest="${url#*://}"
      host="${rest%%/*}"
      path="${rest#*/}"
      [ "$path" = "$rest" ] && return 1
      ;;
    *:*/*)
      host="${url%%:*}"
      path="${url#*:}"
      ;;
    *)
      # No host at all: a local filesystem path. NOT keyable.
      return 1
      ;;
  esac

  host="${host#*@}"          # strip any user@
  host="${host%%:*}"         # strip any :port
  case "$host" in
    ""|*/*|*" "*) return 1 ;;
    *.*) ;;
    localhost) ;;
    *) return 1 ;;
  esac

  path="${path#/}"
  # The WHOLE path, not its last two segments. Collapsing to `<owner>/<name>`
  # is the same conflation the host fix targets, one level up: it keys
  # `github.com/o/r/sub/deep` as `github.com/sub/deep`, and it makes the GitLab
  # subgroups `gitlab.com/a/x/repo` and `gitlab.com/b/x/repo` IDENTICAL. Inert
  # today (no non-flat-forge row exists), but the whole point of this key is
  # that two different repositories can never share one.
  #
  # The "at least two segments" test is STRUCTURAL. It used to be spelled
  # `[ "$owner" != "$name" ]`, which refuses any repo whose name equals its
  # owner -- measured: `https://github.com/prettier/prettier.git` returned 1,
  # and the caller then printed "origin remote missing or not host-qualified",
  # which is simply false for that remote. Fail-closed, so never a hazard, but a
  # wrong diagnosis sends the next reader hunting the wrong thing.
  case "$path" in
    */*) ;;
    *) return 1 ;;
  esac
  case "$path" in
    *//*|*" "*) return 1 ;;
  esac
  printf '%s/%s' "$host" "$path"
}

# gate_resolve_marker_gate <target-dir> <cdkd-gate>
#
# Decides WHICH marker the calling gate must verify in <target-dir>, and prints
# one tab-separated line:
#
#   canonical<TAB><cdkd-gate><TAB>
#   alias<TAB><that repo's gate><TAB><how to refresh it there>
#   none<TAB><TAB>
#
# `canonical` is returned whenever the target declares the cdkd gate AND
# whenever definedness cannot be determined, so the cdkd repo's own path is
# unchanged in every case. Always exits 0; the caller decides what `none` means.
gate_resolve_marker_gate() {
  # `row_*` are the loop's read targets and MUST be declared here: without it
  # they leak into the caller's shell as globals.
  local dir="$1" gate="$2" top slug alias_gate alias_fix rc
  local row_slug row_gate row_alias row_fix
  alias_gate=""
  alias_fix=""
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || top=""
  if [ -z "$top" ]; then
    printf 'canonical\t%s\t\n' "$gate"
    return 0
  fi
  # `if`, not a bare call + `rc=$?`: this file's convention (see gate_matches /
  # cmd_last_cd_target) is that a non-zero return must never escape to a caller
  # running under `set -e`.
  if gate_markgate_declares "$top" "$gate"; then
    rc=0
  else
    rc=$?
  fi
  # 0 = declared, 2 = undeterminable. Both keep the cdkd name (fail closed).
  if [ "$rc" -ne 1 ]; then
    printf 'canonical\t%s\t\n' "$gate"
    return 0
  fi
  slug=$(gate_repo_slug "$dir" 2>/dev/null) || slug=""
  if [ -n "$slug" ]; then
    while IFS='|' read -r row_slug row_gate row_alias row_fix; do
      [ -n "$row_slug" ] || continue
      [ "$row_slug" = "$slug" ] || continue
      [ "$row_gate" = "$gate" ] || continue
      alias_gate="$row_alias"
      alias_fix="$row_fix"
      break
    # A quoted here-string, NOT a heredoc. Review asked for `<<'GATE_ALIAS_EOF'`
    # so a row carrying `$` / a backtick / a backslash cannot be expanded --
    # right intent, wrong mechanism: the heredoc BODY here is the single token
    # `$GATE_MARKER_ALIASES`, so quoting the delimiter stops the table variable
    # expanding at all and the loop reads the literal name. `<<< "$VAR"`
    # expands the variable exactly once and passes its CONTENT through
    # uninterpreted, which is what was actually wanted. Not a pipe, so the loop
    # still runs in this shell and its assignments survive.
    done <<< "$GATE_MARKER_ALIASES"
  fi
  # The alias must itself be DECLARED there; a table row that has gone stale
  # against the sibling's config must not send the merge to a marker that does
  # not exist either.
  if [ -n "${alias_gate:-}" ] && gate_markgate_declares "$top" "$alias_gate"; then
    printf 'alias\t%s\t%s\n' "$alias_gate" "${alias_fix:-}"
    return 0
  fi
  printf 'none\t\t\n'
  return 0
}

# gate_refuse_no_equivalent_marker <gate-name> <cdkd-gate> <target-dir> <what-the-diff-touches>
#
# The refusal for the `none` case. It must NEVER tell the reader to refresh the
# cdkd gate: in this repo that gate cannot exist, which is the whole defect of
# go-to-k/cdkd#2236. It names the mapping row to add instead. EXITS the hook (2).
gate_refuse_no_equivalent_marker() {
  local gate="$1" cdkd_gate="$2" dir="$3" scope="$4" top slug slug_shown row_key
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || top="$dir"
  # Two different strings on purpose. `slug_shown` is prose and may say why
  # there is no slug; `row_key` is pasted into a config row, so when the remote
  # is unkeyable it must be a PLACEHOLDER, not a sentence -- splicing
  # "no origin remote" there produced an unusable row the reader would copy.
  if slug=$(gate_repo_slug "$dir" 2>/dev/null); then
    slug_shown="$slug"
    row_key="$slug"
  else
    slug_shown="origin remote missing or not host-qualified"
    row_key="<host>/<owner>/<repo>"
  fi
  {
    echo "Blocked by $gate: this merge touches $scope, which cdkd requires to be"
    echo "verified before it reaches main -- but the repository this command targets"
    echo "declares no gate for that verification, so there is no marker to refresh."
    echo ""
    echo "  target repo : $top ($slug_shown)"
    echo "  cdkd gate   : $cdkd_gate -- NOT declared in $top/.markgate.yml"
    echo ""
    echo "cdkd's gate policy deliberately applies to commands this session runs"
    echo "against another repository, so re-running this from somewhere else is not"
    echo "the fix. Do ONE of:"
    echo ""
    echo "  1. That repo already verifies this under a DIFFERENT gate name: record"
    echo "     the mapping once, in GATE_MARKER_ALIASES in"
    echo "     .claude/hooks/lib/command-match.sh, as one row"
    echo "       $row_key|$cdkd_gate|<that repo's gate>|<command that refreshes it>"
    echo "     then run that command in that repo and retry the merge."
    echo "  2. That repo does not verify this at all: add the gate and its setter"
    echo "     skill there first -- the change is genuinely unverified."
    echo "  3. The matched files are genuinely unrelated to this gate's subject:"
    echo "     narrow this gate's scope pattern in .claude/hooks/$gate.sh."
    echo ""
    echo "Do NOT set any marker by hand to get past this."
  } >&2
  exit 2
}

# gate_refuse_stale_alias_marker <gate-name> <cdkd-gate> <target-dir> <alias-gate> <remediation> <what-the-diff-touches>
#
# The refusal for the `alias` case: the target repo DOES declare an equivalent
# gate, and it is not fresh. Unlike the canonical refusal this one is
# SATISFIABLE -- it names the gate that repo actually has and the command that
# refreshes it. EXITS the hook (2).
#
# Shared by all four integ gates so they cannot drift into naming a cdkd-only
# gate at a sibling. Today only `integ-local` has an alias row, so the other
# three reach this through the table rather than through their own text; adding
# a row is then the whole change, with no per-hook message to write.
gate_refuse_stale_alias_marker() {
  local gate="$1" cdkd_gate="$2" dir="$3" alias_gate="$4" fix="$5" scope="$6"
  {
    echo "Blocked by $gate: this merge touches $scope, and the gate that"
    echo "repository declares for it is not fresh."
    echo ""
    echo "  target repo : $dir"
    echo "  its gate    : $alias_gate (cdkd calls the same gate $cdkd_gate)"
    echo ""
    echo "Required action, IN THAT REPOSITORY -- no exceptions:"
    echo "  ${fix:-run the verification that repository declares for this gate, then retry}"
    echo ""
    echo "Do NOT run 'markgate set' by hand to get past this, and do not re-run the"
    echo "merge from another checkout: cdkd applies this policy to whichever tree the"
    echo "command targets, precisely so an unverified code path cannot reach main."
  } >&2
  exit 2
}

# gate_refuse_unevaluable_marker <gate-name> <gate> <target-dir> [diagnose-cmd-prefix]
#
# markgate exit 2 is "could not EVALUATE this gate", NOT "the marker is stale",
# and the two need OPPOSITE remedies. Under `hash: diff` it fires when
# `origin/main` will not resolve (never fetched, shallow clone, no merge base)
# or when the branch has no delta against the merge base at all -- and
# `markgate set` fails on exactly the same condition, so the ordinary
# "go run the integ" advice burns a real Docker / AWS run and leaves the merge
# blocked anyway. `markgate status` also errors here and prints no `state:`
# line, so a reason extraction downstream comes back empty and silently
# degrades to the wrong message.
#
# THIS MUST BE CONSULTED BEFORE THE ALIAS REFUSAL, in every gate. The one alias
# that exists (cdk-local's `integ`) is a `hash: diff` gate, so exit 2 is its
# NORMAL verdict when the command runs from that repo's base tree -- measured
# 2026-08-26: `markgate verify integ` there exits 2 with "no delta against
# merge-base(origin/main, HEAD)". Reporting that as "not fresh -- go run
# /run-integ local-<test>" is the precise mistake integ-destroy-gate has
# documented as wrong since it grew its own exit-2 branch. EXITS the hook (2).
# NOTE (recorded, not fixed): the 4th `diagnose` parameter currently has no
# caller, and its default can disagree with a gate's own markgate resolution
# (`mise exec -- markgate` vs a bare `markgate` from the `elif command -v`
# branch). Inherited from the destroy gate's original text. Untangling it means
# threading each gate's resolved `markgate` array in here, which widens this
# diff for no behavioural gain, so it is left as-is deliberately.
gate_refuse_unevaluable_marker() {
  local gate="$1" mgate="$2" dir="$3" diagnose="${4:-mise exec -- markgate}" top
  # Name the repo the SAME way the sibling refusal does. This printed the
  # resolved cwd while gate_refuse_no_equivalent_marker printed the toplevel, so
  # from a subdirectory the two refusals named different paths for one repo.
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || top="$dir"
  {
    echo "Blocked by $gate: markgate could not EVALUATE the \`$mgate\` gate"
    echo "(exit 2). This is NOT a stale marker, and running the integ will NOT fix"
    echo "it -- \`markgate set\` fails on the very same condition."
    echo ""
    echo "  target repo : $top"
    echo "  gate        : $mgate"
    echo ""
    echo "Likely cause and remedy:"
    echo "  * \`origin/main\` missing or stale in this worktree"
    echo "      git fetch origin"
    echo "  * shallow clone with no merge base against origin/main"
    echo "      git fetch --unshallow"
    echo "  * this branch has no delta against merge-base(origin/main, HEAD)"
    echo "      commit the work first, or run from a branch that is ahead of main"
    echo "    (a \`hash: diff\` gate CANNOT be evaluated on the base branch itself)"
    echo ""
    echo "Diagnose with:"
    echo "  $diagnose status $mgate"
  } >&2
  exit 2
}
