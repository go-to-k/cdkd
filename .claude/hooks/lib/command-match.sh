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
    # Does a substitution stay OPEN at end of line? Net unclosed `$(` depth,
    # counted the naive way close_paren counts (quotes ignored, `\x` skipped),
    # OR an odd number of unescaped backticks. Either means the substitution
    # CONTINUES on the next line.
    #
    # WHY (go-to-k/cdkd#2156). close_paren scans within ONE line, so a
    # substitution written across lines returned 0 and flush_line fell to its
    # `res = res "\n"` arm, which SPLITS. Measured on origin/main,
    # `git -C $(<nl>  echo /a/b<nl>) commit -m x` segmented to `git -C`,
    # `echo /a/b` and `) commit -m x`: no segment matched any verb, so
    # branch-gate and check-gate both exited 0 on a determinate commit. That is
    # the round-1 truncation surviving for the multi-line spelling, and it is
    # the last known bypass recorded by go-to-k/cdkd#2027.
    #
    # Joined with `;` rather than a space, and that choice is load-bearing: a
    # NEWLINE separates commands inside a substitution body, so a space would
    # fuse `$(<nl>cd /x<nl>git commit<nl>)` into one segment `cd /x git commit`
    # and the commit would stop matching. `;` is the same separator in a form
    # that survives being put on one line, and the enclosing command is
    # unaffected because neutralise() turns it into a placeholder there anyway.
    function subst_open(line,   i, n, c, depth, bt) {
      depth = 0; bt = 0; n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (c == "\\") { i++; continue }
        # BACKTICK PARITY, tracked SEPARATELY from the paren depth
        # (go-to-k/cdkd#2156 review round 1). The first version of this function
        # counted only `$(`, so the backtick spelling of the same multi-line
        # substitution still fell to the splitting arm and stayed a full bypass:
        # measured with the repo on `main`, `git -C `<nl> echo <wt> <nl>` commit`
        # gave branch-gate rc=0 while its `$( )` twin gave rc=2 -- and both the
        # PR body and .claude/rules/hooks-class-fences.md called the class
        # CLOSED, which is worse than not claiming it.
        #
        # PARITY, NOT DEPTH, and that is forced rather than stylistic: backticks
        # do not nest, so an inner one CLOSES rather than descends. Feeding them
        # to `depth` would make the second backtick of an ordinary
        # `git -C `pwd` commit` read as another opener and hold the line open
        # forever.
        if (c == "`") { bt = 1 - bt; continue }
        if (c == "$" && substr(line, i + 1, 1) == "(") { depth++; i++; continue }
        if (c == "(" && depth > 0) { depth++; continue }
        if (c == ")" && depth > 0) { depth--; continue }
      }
      return (depth > 0 || bt)
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
        # A BACKTICK substitution runs its body exactly as `$(` does, and this
        # branch had no arm for it, so the body was never scanned as a command
        # and reached the shell with no gate armed (go-to-k/cdkd#2339). Measured
        # on origin/main against GATE_RE_GIT_CHECKOUT, the three spellings of one
        # command disagreed:
        #
        #   echo "r: `git -C /wt checkout -- f.txt`"   NOMATCH  <-- ran, ungated
        #   echo "r: $(git -C /wt checkout -- f.txt)"  MATCH
        #   echo `git -C /wt checkout -- f.txt`        MATCH
        #
        # Through the gates that is dirty-path-restore-gate -- the
        # go-to-k/cdkd#1700 data-loss gate -- returning 0 on a command that
        # discards uncommitted work.
        #
        # DOUBLE quotes only, unlike the `$(` arm above, and that asymmetry is
        # measured rather than stylistic. A backtick inside SINGLE quotes does
        # not run, so there is no bypass to close there, and firing anyway costs
        # real false refusals: a review measured
        # `gh issue comment 1 --body '"'"'Run `git push` first'"'"'` -- a markdown code
        # span in a single-quoted body, this repo'"'"'s commonest issue/PR shape --
        # being REFUSED by branch-gate. The survey put the single-quoted share at
        # 36 of 139 newly-considered cells over 400 real commit messages and PR
        # bodies. The `$(` arm'"'"'s own quote-blindness is a pre-existing
        # over-approximation, not a contract to copy.
        #
        # Backticks do not nest, so the closer is simply the next one -- no depth
        # counting, unlike close_paren.
        if (c == "`" && q == "\"") {
          bt = index(substr(line, i + 1), "`")
          if (bt > 0) {
            extra = extra substr(line, i + 1, bt - 1) "\n"
            # Collapse the span to the placeholder: the enclosing text is DATA
            # either way, and leaving the body inline would let a `;` or `&&`
            # inside it reach the enclosing segment as structure.
            res = res SEP_SUBST
            i = i + bt
            continue
          }
          # Unterminated on this line: the backtick PARITY tracked by subst_open
          # has already joined the continuation, so an odd backtick here means
          # the span was genuinely never closed. Neutralise it and keep scanning
          # rather than latching -- dropping the rest is the fail-open direction.
          res = res SEP_SUBST
          continue
        }
        res = res c
      }
      return res
    }
    # One full pass. Runs twice at most: see the END rule.
    function run(   i, line, t, acc, rounds, batch, elines, nlines, ei, __seg, psub) {
      q = ""; tag = ""; pending = ""; acc = ""; extra = ""; psub = ""
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
        # A `$(` still open at end of line CONTINUES on the next one; join so
        # close_paren can see the closer. See subst_open above.
        if (psub != "") { line = psub ";" line; psub = "" }
        if (subst_open(line)) { psub = line; continue }
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
      # An unterminated `$(` at end of INPUT: flush what was held rather than
      # dropping it. Dropping is the fail-open direction -- the held text is the
      # command.
      if (psub != "") {
        if (pending != "") { psub = psub ";" pending; pending = "" }
        acc = acc flush_line(psub) "\n"
        psub = ""
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


# gate_dequote_structural <segment>   -> sets GATE_STRUCT_SEG
#
# <segment> with shell QUOTING removed from its STRUCTURAL tokens ONLY -- the
# command word, the leading global-flag NAMES, and the SUBCOMMAND position --
# and every other byte reproduced exactly as it arrived. When nothing is
# rewritten, which is what almost every segment does, GATE_STRUCT_SEG is the
# input string itself.
#
# WHY (go-to-k/cdkd#2333). The trigger matches the VERB and the leading `-` as
# LITERAL text, so QUOTING or ESCAPING either one evades every gate while the
# command still runs the gated verb:
#
#   git "commit" -m x   git 'commit' -m x   git c"o"mmit -m x   git \commit -m x
#   git "-C" /tmp commit   git \-C /tmp commit   gh "pr" merge 1   gh pr "merge" 1
#
# WHY IT IS NOT A WHOLE-SEGMENT UNQUOTE, which is the shape that was BUILT,
# reviewed four rounds and WITHDRAWN (the findings are on go-to-k/cdkd#2333).
# Two independent reasons, both measured rather than reasoned about:
#
#  1. QUOTING IS A LOAD-BEARING BRAKE ON THE OVER-APPROXIMATING TRIGGER.
#     `GATE_FLAGS` accepts "one flag token, then ANY tokens", so after a `-C`
#     any LATER token can occupy the verb slot. Today a QUOTED later token
#     happens not to match, and that accident is the only thing keeping
#     ordinary read-only work out of the gates. Dequoting every token took 16
#     measured shapes from rc=0 to rc=2 -- `git -C <dir> log --grep "commit"`,
#     `git -C <dir> show "commit"`, `git -C <dir> grep -n "commit" -- src` and
#     thirteen siblings, `check-gate` blocking them on a feature worktree
#     whenever markers are stale, which is the normal mid-lane state.
#  2. CONSUMERS PARSE THE SEGMENT TEXT THEMSELVES. Normalising the stream whole
#     turned `dirty-path-restore-gate`'s `'f\.txt'` (a backslash literal inside
#     single quotes) into `f\.txt` (a backslash that escapes), so it resolved a
#     different path and exited 0; and it made `gated-command-preamble-gate`
#     read the `=>` of `grep -n '=>' x.ts && git commit` as a redirect.
#
# So the rewrite is POSITIONAL, and the position is DETERMINATE rather than
# guessed: this walks the same grammar `gate_leading_c_value` already walks --
# command word, then global flags (a value-consuming one skips its value
# WITHOUT reading it), then the FIRST token that is not a flag, which git's own
# syntax says IS the subcommand. The scan STOPS there. Nothing after the verb
# is ever touched, so an argument, a path, a `--body` and a `--grep` pattern
# all reach their consumer byte-identical, and both failure classes above are
# unreachable by construction rather than by care.
#
# THE SCAN IS BOUNDED THREE WAYS, and NONE of them is padding-proof. An earlier
# revision of this paragraph said a token cap "cannot be padded past, because
# padding lives INSIDE a token" -- false, and it was the reasoning that let a
# real bypass ship: padding lives in the NUMBER of tokens as readily as inside
# one. Every bound here is chosen for COST, each leaves a recorded residue, and
# the residues are enumerated below rather than argued away. Reaching any bound
# abandons the rewrite WHOLE rather than emitting a half-rewritten segment. The
# reasoning for each value is on the constants themselves.
#
# AND IT FAILS TO "UNCHANGED", NEVER TO "PARTLY REWRITTEN". Every abandon path
# -- unknown command word, unparseable token, unsafe dequote, cap reached --
# leaves GATE_STRUCT_SEG as the ORIGINAL segment. The worst case is therefore
# today's behaviour, so no abandon path can introduce a false refusal.
#
# LATENCY, RE-MEASURED because the withdrawn round's cap existed to bound it
# and this replaces that cap. `check-gate` end to end, mean of 3, this machine
# (bash 5.3.9), before -> after:
#
#   ordinary command            100 B    0.028 -> 0.027 s
#   400 segments of quoted prose 206 KB  3.546 -> 3.742 s
#   one 48 KB flag VALUE         48 KB   0.316 -> 0.818 s
#
# The PreToolUse timeout is 10 s and a KILLED hook cannot emit exit 2, which
# disarms every gate at once -- so the headroom is the point, not the ratio.
# Both worst cases are the ones the withdrawn implementation broke (it took the
# 48 KB argument to 9-12 s and the 400-segment corpus to 10.8 s); they stay
# under a second and under four respectively because the walk never scans a
# token it is not classifying: a flag VALUE is copied whole, and the scan stops
# at the verb.
#
# THE RESIDUES, measured and recorded rather than claimed closed. Every one
# fails in the SAME direction as today -- a spelling that stays unmatched, not
# a new refusal -- and every one is strictly narrower than the gap
# go-to-k/cdkd#2333 filed, which needed no flag, no padding and no unusual
# quoting at all.
#
#  1. An UNENUMERATED value-consuming global flag makes its VALUE look like the
#     subcommand, so the scan stops one token early and a QUOTED verb after it
#     is not dequoted: `git --unknown-opt someval "commit" -m x` matches
#     nothing while its literal-verb twin matches through `GATE_FLAGS`.
#  2. A `gh` GROUP absent from the second-verb-token list (`gh <group> <verb>`)
#     leaves its verb undequoted. Deliberately the safe side: consuming a token
#     that is an ARGUMENT is the failure the list exists to prevent.
#  3. A structural token past `GATE_STRUCT_MAXTOKLEN` is left alone, and this
#     is a WORKING bypass rather than inert padding: empty quoted pairs do not
#     change the word, so `git c<254 x "">ommit -m x` -- 523 bytes, measured,
#     argv `[commit] [-m] [x]` -- really runs `git commit`. A bound is
#     unavoidable: without one a 12 KB command took 154 s through
#     `gate_segments` and killed the hook, which disarms every gate at once.
#  4. More than `GATE_STRUCT_MAXTOK` tokens before the verb, likewise, and its
#     floor is far lower than a `--no-pager` example suggests: git accepts the
#     short `-P`, so `git -P x24 "commit" -m x` is EIGHTY-NINE bytes.
#  5. ANSI-C and locale quoting: `git $'commit' -m x` and `git $"commit" -m x`
#     both really run `git commit`, and the walk cannot read either (it sees
#     `$` plus a quoted span). They ABANDON rather than emitting a mangled
#     `$commit`. Pre-existing on origin/main, which matches them no better.
#
# WHAT THIS CHANGE IS AND IS NOT WORTH, stated because the residue list makes
# it answerable rather than left to impression. The cheapest residue that
# really runs the verb is `git $'commit' -m x` at EIGHTEEN bytes, against the
# SEVENTEEN of the `git "commit"` this closes. So against an adversary who
# picks their spelling, this buys one byte and nothing else. What it does buy
# is the incidental case: an agent, or an instruction an agent was given, that
# quotes a verb for ordinary reasons -- and that is what these gates are for.
# They are guardrails on a process that can already run any command it likes,
# not a boundary against a local attacker. Do not let a future round argue for
# a wider, slower or riskier rewrite on the strength of "closing the bypass":
# the bypass class is not closable by this route, and three rounds of trying
# produced two denial-of-service regressions.
#
# HOOK-LOCAL PARSERS, audited rather than assumed (go-to-k/cdkd#2333 acceptance
# criterion 3). The population is hooks that read `.tool_input.command` and do
# NOT go through this library -- derived, not remembered:
#
#   for f in .claude/hooks/*.sh; do
#     case "$f" in *.test.sh) continue ;; esac
#     grep -q 'tool_input.command' "$f" || continue
#     grep -qE 'gate_matches|gate_segments|cmd_matches_verb|gate_verb_rest|gate_pr_selector|gate_target_dir|gate_tokens|gate_argv|strip_noncommand_spans' "$f" \
#       || echo "NO SHARED MATCHER: $f"
#   done
#
# It returns TWO. `main-tree-dirty-detector.sh` is a non-blocking PostToolUse
# observer keyed on write-ish tokens, with no verb grammar -- out of scope.
# `main-tree-edit-gate.sh` is NOT: it carries its own
# `^[[:space:]]*cd[[:space:]]+` regex (line 61) that a quoted `"cd"` does not
# match, so the base directory for a relative write target is not updated.
# Filed rather than fixed here -- porting that hook to this library is its own
# change with its own risk, and the criterion's named target
# (`main-tree-branch-gate.sh`'s `QUOTEDSPAN` sed) no longer exists: that hook
# reads the shared stream now, and a repo-wide grep for that marker returns
# only this paragraph -- which is why the marker is not spelled here a second
# time as a runnable command: a claim that a string is absent must not itself
# supply the string.
# The git / gh GLOBAL FLAGS that consume the FOLLOWING token as their value.
# ONE copy, used by `gate_dequote_structural` and by `gate_leading_c_value`,
# because the two halves of this file have already disagreed about exactly this
# list once: `gate_leading_c_value` knew `-R` / `--repo` were gh flags while the
# trigger did not, so `gh -R owner/repo pr merge 1 --squash` matched NOTHING and
# walked past every merge gate (go-to-k/cdkd#2027 review round 4). A second
# hand-maintained copy is the same bug waiting.
#
# A FUNCTION rather than a pattern variable, and that is not a style choice.
# `case "$tok" in $VAR)` does NOT alternate: bash parses `|` as the pattern
# separator at SYNTAX time, before the expansion, so an expanded `-C|-c|...`
# is matched as ONE literal string and every arm silently stops firing. Caught
# here by the padded-verb case in command-match.test.sh, which is exactly the
# shape a hand-check would call obviously fine.
#
# IT IS AN ENUMERATION, and this file's whole thesis is that enumerations go
# stale (go-to-k/cdkd#2156). The cost is bounded and recorded rather than
# hidden: an UNENUMERATED value-consuming global (`--super-prefix`,
# `--attr-source`) makes its VALUE look like the subcommand, so
# `gate_dequote_structural` stops there and a QUOTED verb after it is not
# dequoted. That is a residue of go-to-k/cdkd#2333, not a regression -- the
# LITERAL-verb spelling still matches through the over-approximating trigger,
# which is what `GATE_FLAGS` is for.
_gate_is_value_flag() {
  case "$1" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|-R|--repo) return 0 ;;
  esac
  return 1
}

# THE THREE BOUNDS, and each answers a different attack. A hook killed by the
# 10 s PreToolUse timeout cannot emit exit 2, which disarms every gate AT ONCE,
# so a cost bound here is a security property and not a nicety.
#
#   MAXTOKLEN / MAXSPAN bound ONE token's dequote. The span walk in
#   `_gate_struct_rewrite` copies the remaining token on every stop character,
#   so its cost is quadratic in token LENGTH and in QUOTE COUNT together.
#   Measured before this bound, `gate_segments` on a single input, new vs
#   `origin/main`: `--o="a"` x400 x24 tokens (28.9 KB) 6.31 s vs 0.11 s, and
#   57.7 KB 45.3 s vs 0.29 s -- end to end `branch-gate` 12.96 s and
#   `check-gate` 12.87 s, past the timeout. The attack needs no gated verb at
#   all: `git --o="a"x400 ...x24 ; git commit -m x` burns the budget in segment
#   ONE, the hook dies, and segment TWO commits with every gate disarmed. That
#   is a WORSE outcome than the bypass this whole change closes.
#
#   MAXTOK bounds the token COUNT, and it is a COST bound, not a security one.
#   The outer walk is quadratic too, and for the same reason: `_gate_struct_next`
#   ERE-matches the ENTIRE remaining string on every token. Measured with
#   quote-free 508-byte tokens, N = 32 / 64 / 128 / 256 -> 0.116 / 0.378 /
#   0.816 / 2.756 s, and 256 dense tokens cost 16.4 s. Raising this from 24 to
#   256 in an earlier revision multiplied the worst case ~114x and re-opened
#   the timeout DoS BELOW origin/main's cost: at 164 KB, `branch-gate` took
#   4.43 s on main and was KILLED at 10 s on that revision, so the following
#   `git commit -m x` ran with every gate disarmed. It is back at 24, where the
#   walk adds nothing measurable (262 KB: 5.20 s against main's 5.34 s).
#
#   SO THE CAP IS A RESIDUE, and this is what the previous revision of this
#   comment got wrong twice -- first claiming a token cap "cannot be padded
#   past, because padding lives INSIDE a token" (false: padding lives in the
#   NUMBER of tokens too, measured `git --no-pager x24 "commit"` rc=0 while its
#   literal twin was rc=2), then trying to fix that by raising the cap, which
#   traded a bypass for a killed hook. There is no value that is neither: the
#   cap is set for COST and the bypass it leaves is enumerated with the other
#   residues below. A killed hook disarms EVERY gate at once, so a bounded
#   walk with one recorded unmatched spelling is the cheaper failure.
GATE_STRUCT_MAXTOK=24
GATE_STRUCT_MAXTOKLEN=512
GATE_STRUCT_MAXSPAN=16
GATE_STRUCT_SEG=""
_GATE_DQ=""
_GATE_DQ_CHANGED=0
_GATE_STRUCT_TOK=""
_GATE_STRUCT_REST=""

# One shell token off the front of <text>, quoted spans kept WHOLE. Same two
# patterns, in the same order, as `gate_leading_c_value`: the embedding class
# excludes bare quote characters, so an UNBALANCED apostrophe (`/tmp/o'neill`)
# fails it and falls to the path token rather than losing the whole walk.
_gate_struct_next() {
  local r="$1"
  if [[ "$r" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN([[:space:]]+(.*))?$ ]]; then
    _GATE_STRUCT_TOK="${BASH_REMATCH[1]}"; _GATE_STRUCT_REST="${BASH_REMATCH[4]}"; return 0
  fi
  if [[ "$r" =~ ^[[:space:]]*($GATE_PATH_TOKEN)([[:space:]]+(.*))?$ ]]; then
    _GATE_STRUCT_TOK="${BASH_REMATCH[1]}"; _GATE_STRUCT_REST="${BASH_REMATCH[4]}"; return 0
  fi
  return 1
}

# _gate_struct_rewrite <token> -> _GATE_DQ (what to emit) + _GATE_DQ_CHANGED
#
# The dequoted token when that is SAFE, the token itself otherwise. It never
# fails: an unsafe token is emitted verbatim, which is exactly today's
# behaviour for it.
#
# THE SAFETY RULE, both halves bought by a measured regression in the withdrawn
# round. A result carrying WHITESPACE means the quoted span was how the shell
# passes ONE argument containing spaces, so its content is DATA and dequoting
# it reddened three false-refusal cases. A result carrying a QUOTE CHARACTER is
# the `\"` case: outside a span it dequotes to a bare `"`, which the
# quote-AWARE `_GATE_WORD` alternatives then read as an OPENING quote, and
# three gates STOPPED firing (`git -c user.name=O\"Brien commit` and two
# siblings) -- a bypass introduced by the change closing one. A surviving
# BACKSLASH is refused for the same reason one direction over.
_gate_struct_rewrite() {
  local w="$1" orig="$1" rest="$1" out="" chunk q="" c spans=0
  _GATE_DQ="$w"; _GATE_DQ_CHANGED=0
  case "$w" in *[\"\'\\]*) ;; *) return 0 ;; esac
  # A command word, a global-flag NAME and a subcommand are all short by
  # construction, so anything longer is not a structural token and is not worth
  # the walk. Returning the token verbatim is an ABANDON -- exactly today's
  # behaviour for it, never a refusal.
  #
  # THIS IS NOT THE WITHDRAWN ROUND'S BYTE CAP, and the difference is the whole
  # point. That one bounded the WHOLE SEGMENT, so 400 bytes of `-c` value
  # pushed a later verb past it (`git -c user.name=<400 x> -C <repo> "commit"`
  # was rc=0 while its literal twin was rc=2). This bounds ONE TOKEN, so the
  # padding would have to sit INSIDE the verb itself.
  [ "${#w}" -le "$GATE_STRUCT_MAXTOKLEN" ] || return 0
  # COLLAPSE PROVABLY-EMPTY QUOTED PAIRS FIRST, in one O(L) pass each, and do it
  # AFTER the length check so the check still measures the token the caller
  # actually typed.
  #
  # An empty pair contributes nothing to the word -- `c""""..""ommit` really
  # runs `git commit` -- so it is FREE PADDING, and the walk must not pay for
  # it. Two earlier revisions each got half of this: charging empty spans made
  # 32 pairs (79 bytes) exhaust the span budget and abandon, re-opening this
  # issue's own bypass; not charging them stopped the bypass but still ran a
  # full O(remaining) chunk extraction per pair, so 24 tokens of 253 pairs --
  # 49 KB, an ordinary-looking command line -- took 11.5 s against origin/main's
  # 0.49 s and killed the hook. A killed hook cannot emit exit 2, which disarms
  # every gate at once. Deleting the pairs outright is the only move that pays
  # neither price.
  #
  # THE COST IS A FALSE REFUSAL ON ONE ABSURD SHAPE, and it is the loud
  # direction: `git 'com""mit'` runs a subcommand git does not have, and now
  # dequotes to `commit`, so the gates fire on a command that commits nothing.
  # A structural token -- a command word, a global-flag name, a subcommand --
  # never legitimately contains an empty pair, and a flag VALUE is copied
  # verbatim and never reaches here, so no real command line takes this.
  while :; do
    case "$w" in
      *'""'*|*"$GATE_SQ$GATE_SQ"*) ;;
      *) break ;;
    esac
    w="${w//\"\"/}"
    w="${w//$GATE_SQ$GATE_SQ/}"
  done
  rest="$w"
  # The walk advances by SPANS, not characters, for the reason recorded on
  # GATE_NOT_INERT_GLOB: `${s:i:1}` in a UTF-8 locale walks to offset `i` every
  # time, so a per-character loop here is quadratic. It removes only THAT
  # quadratic -- the walk still copies the remaining token per stop character,
  # which is why the two bounds below exist.
  while [ -n "$rest" ]; do
    # The SECOND bound, and it is the one the length bound cannot supply: cost
    # rises with the NUMBER of stop characters independently of length. A real
    # structural token carries a handful -- `c"o"mmit` has two, and a
    # maximally split one (`"c""o""m""m""i""t"`) twelve.
    #
    # ONLY A SPAN THAT CONSUMED CHARACTERS IS CHARGED, and that is the whole
    # correctness of this bound rather than a refinement. An EMPTY quoted pair
    # is free padding that does not change the word: `c""""..""ommit` really
    # runs `git commit`. Charging it let 32 pairs -- SEVENTY-NINE BYTES --
    # exhaust the budget and abandon, which re-opened the exact bypass this
    # change closes, cheaper and quieter than the original. Measured on the
    # revision that charged them: 31 pairs MATCH, 32 pairs NOMATCH, argv
    # `[commit] [-m] [x]` under `eval printf` either way.
    [ "$spans" -gt "$GATE_STRUCT_MAXSPAN" ] && return 0
    if [ -z "$q" ]; then
      chunk="${rest%%$GATE_CHUNK_STOP*}"
      [ -n "$chunk" ] && spans=$((spans + 1))
      out="$out$chunk"
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"
      c="${rest%"${rest#?}"}"
      rest="${rest#?}"
      case "$c" in
        '\') out="$out${rest%"${rest#?}"}"; rest="${rest#?}" ;;
        '"') q='"' ;;
        "$GATE_SQ") q="$GATE_SQ" ;;
        *) out="$out$c" ;;
      esac
    elif [ "$q" = "$GATE_SQ" ]; then
      # Inside a SINGLE-quoted span every character is literal, including a
      # backslash -- only the closer has to be found.
      chunk="${rest%%$GATE_SQ*}"
      [ -n "$chunk" ] && spans=$((spans + 1))
      out="$out$chunk"
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"; rest="${rest#?}"; q=""
    else
      chunk="${rest%%$GATE_CHUNK_STOP_DQ*}"
      [ -n "$chunk" ] && spans=$((spans + 1))
      out="$out$chunk"
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"
      c="${rest%"${rest#?}"}"
      rest="${rest#?}"
      case "$c" in
        '\')
          # INSIDE a double-quoted span a backslash escapes only `$`, a
          # backtick, `"`, `\` and a newline; before anything else it is a
          # LITERAL backslash. Consuming it unconditionally made
          # `git "com\mit"` dequote to `commit`, so the gates fired on a
          # command that runs no gated verb at all -- a false refusal, the loud
          # direction, but still a wrong rewrite. Emitting the backslash makes
          # the safety rule below refuse the token, which abandons to today's
          # behaviour.
          c="${rest%"${rest#?}"}"
          case "$c" in
            '"'|'\'|'$'|'`') out="$out$c"; rest="${rest#?}" ;;
            *) out="$out\\" ;;
          esac
          ;;
        '"') q="" ;;
      esac
    fi
  done
  # A quote still open means the word cannot be split into shell words at all.
  [ -z "$q" ] || return 0
  case "$out" in
    '') return 0 ;;
    *[[:space:]]*) return 0 ;;
    *[\"\'\\]*) return 0 ;;
    # SHELL METACHARACTERS, and this arm is not defensive tidiness. Without it
    # `git "a>b"` was rewritten to `git a>b`, putting a live REDIRECT into the
    # stream every reader parses -- a probe of it actually created the file --
    # and `git "com;mit"` grew a bare `;` the segmenter splits on. That is the
    # argument-corruption class that withdrew the previous attempt, one
    # character wide. `$` is listed for a second reason: it makes
    # `git $'commit' -m x` ABANDON instead of emitting the mangled `$commit`
    # (the walk reads `$'...'` as `$` plus a quoted span, which is not what
    # bash does). ANSI-C quoting stays a recorded residue -- a wrong rewrite is
    # worse than none.
    *[\<\>\;\&\|\(\)\`\$]*) return 0 ;;
  esac
  # Against the ORIGINAL token, not the collapsed one: the empty-pair collapse
  # above rewrites `w`, so comparing to it reports "nothing changed" for
  # exactly the padding shapes the collapse exists to see through.
  [ "$out" = "$orig" ] && return 0
  _GATE_DQ="$out"; _GATE_DQ_CHANGED=1
  return 0
}

gate_dequote_structural() {
  local seg="$1" rest tok d out="" changed=0 n=0 kind="" extra=0
  GATE_STRUCT_SEG="$seg"
  # Cheap stop 1: with no quote and no backslash anywhere there is nothing to
  # dequote. One glob, and it is the shape of nearly every command.
  case "$seg" in *[\"\'\\]*) ;; *) return 0 ;; esac
  # Cheap stop 2: a segment whose FIRST WORD is neither a command word this
  # function knows a grammar for, nor quoted/escaped in a way that could be
  # hiding one, is left alone before any tokenising happens. This is what keeps
  # `grep -n '=>' x.ts` byte-exact -- and it is a property of the FIRST WORD,
  # not of the segment, so a quoted argument later on cannot drag an unrelated
  # command into the walk.
  tok="${seg%%[[:space:]]*}"
  case "$tok" in
    git|gh|cd|bash|sh|zsh|ksh|cdk|npx|vp|delstack) ;;
    *[\"\'\\]*) ;;
    *) return 0 ;;
  esac

  rest="$seg"
  _gate_struct_next "$rest" || return 0
  tok="$_GATE_STRUCT_TOK"; rest="$_GATE_STRUCT_REST"
  _gate_struct_rewrite "$tok"
  out="$_GATE_DQ"; d="$_GATE_DQ"
  [ "$_GATE_DQ_CHANGED" = 1 ] && changed=1

  # `npx cdk deploy`: the command word this file's patterns key on is the
  # SECOND token, so read one more and carry on with its grammar.
  if [ "$d" = npx ]; then
    _gate_struct_next "$rest" || return 0
    tok="$_GATE_STRUCT_TOK"; rest="$_GATE_STRUCT_REST"
    _gate_struct_rewrite "$tok"
    out="$out $_GATE_DQ"; d="$_GATE_DQ"
    [ "$_GATE_DQ_CHANGED" = 1 ] && changed=1
  fi

  case "$d" in
    # WHICH GRAMMAR the walk uses. `gh pr merge` and `vp run test` put the verb
    # in TWO tokens; `git commit` and `cdk deploy` in one -- but for `gh` that
    # is a property of the FIRST verb token, not of `gh`, so the decision is
    # deferred to the subcommand arm rather than taken here. An earlier
    # revision consumed a second token unconditionally, which rewrote an
    # ARGUMENT for every one-token gh verb: `gh api "repos/o/r/pulls/1"` came
    # back dequoted and `gh api "repos/o/r/x;y"` grew a bare `;`. That is the
    # withdrawn design's failure class appearing inside the fix for it.
    git|cdk) kind=git ;;
    gh)      kind=gh ;;
    vp)      kind=vp ;;
    # `bash -c "<list>"` is re-segmented by the caller, and the flag it keys on
    # can be quoted too. Its BODY is deliberately not a structural token: the
    # caller strips that span with `gate_unquote_span` and re-segments it, so
    # each inner segment reaches this function on its own.
    bash|sh|zsh|ksh)
      # ONLY the `-c` FLAG, never the token after it and never a script PATH.
      # `bash "scripts/foo.sh"` has to come back untouched: that second token
      # is an ARGUMENT, and dequoting it is the same overreach as the gh `api`
      # case above.
      if [ -n "$rest" ] && _gate_struct_next "$rest"; then
        _gate_struct_rewrite "$_GATE_STRUCT_TOK"
        case "$_GATE_DQ" in
          -*)
            out="$out $_GATE_DQ"; rest="$_GATE_STRUCT_REST"
            [ "$_GATE_DQ_CHANGED" = 1 ] && changed=1
            ;;
        esac
      fi
      kind=stop ;;
    # A bare command word with no verb: the PATH after `cd` stays quoted,
    # because `gate_target_dir` reads it with `gate_unquote` and a rewrite here
    # would be the whole-segment normalisation this function exists to avoid.
    cd|delstack) kind=stop ;;
    *) return 0 ;;
  esac

  while [ "$kind" != stop ] && [ -n "$rest" ]; do
    n=$((n + 1))
    # Reaching the cap abandons the rewrite WHOLE. A half-rewritten segment
    # would be a stream nobody has measured; the original is today's behaviour.
    [ "$n" -gt "$GATE_STRUCT_MAXTOK" ] && return 0
    _gate_struct_next "$rest" || break
    tok="$_GATE_STRUCT_TOK"; rest="$_GATE_STRUCT_REST"
    _gate_struct_rewrite "$tok"
    d="$_GATE_DQ"
    if _gate_is_value_flag "$d"; then
      out="$out $_GATE_DQ"
      [ "$_GATE_DQ_CHANGED" = 1 ] && changed=1
      # The VALUE is copied VERBATIM and never classified. Reading it is what
      # would let a `-C <dir>` whose directory is named `commit` decide a verb,
      # and rewriting it is what broke `split_paths` in the withdrawn round.
      _gate_struct_next "$rest" || break
      out="$out $_GATE_STRUCT_TOK"; rest="$_GATE_STRUCT_REST"
      continue
    fi
    case "$d" in
      -*)
        out="$out $_GATE_DQ"
        [ "$_GATE_DQ_CHANGED" = 1 ] && changed=1
        ;;
      *)
        # THE SUBCOMMAND POSITION. The only non-flag token this function ever
        # rewrites, and the scan stops at it.
        out="$out $_GATE_DQ"
        [ "$_GATE_DQ_CHANGED" = 1 ] && changed=1
        # A SECOND verb token, only for the groups that actually have one.
        # The list is an enumeration and it is allowed to be INCOMPLETE: a
        # group missing from it is simply not dequoted at its second position,
        # which is today's behaviour. Being wrong the other way -- consuming a
        # token that is an ARGUMENT -- is the failure this list exists to
        # prevent, so a name goes in only when `<group> <verb>` is the real
        # grammar.
        extra=0
        case "$kind" in
          gh)
            case "$d" in
              pr|issue|release|repo|run|workflow|cache|secret|variable|label|project|ruleset|org|search|gist|codespace|extension|alias|config|auth|attestation)
                extra=1 ;;
            esac
            ;;
          vp)
            case "$d" in run) extra=1 ;; esac
            ;;
        esac
        if [ "$extra" = 1 ] && [ -n "$rest" ] && _gate_struct_next "$rest"; then
          _gate_struct_rewrite "$_GATE_STRUCT_TOK"
          rest="$_GATE_STRUCT_REST"
          out="$out $_GATE_DQ"
          [ "$_GATE_DQ_CHANGED" = 1 ] && changed=1
        fi
        break
        ;;
    esac
  done

  [ "$changed" = 1 ] || return 0
  if [ -n "$rest" ]; then GATE_STRUCT_SEG="$out $rest"; else GATE_STRUCT_SEG="$out"; fi
  return 0
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
    # Dequote the STRUCTURAL tokens only -- the command word, the leading
    # global-flag names and the subcommand position (go-to-k/cdkd#2333). Here
    # rather than in each reader because EVERY reader that decides a gate
    # outcome from a segment takes THIS stream, and each unpatched one would be
    # an independent live bypass; narrow enough to be safe here because nothing
    # after the verb is touched. Do not restate the reader COUNT -- the
    # go-to-k/cdkd#2333 findings said eight and
    # `grep -c '\[\[ "\$segment" =~' ` says nine; the property is what holds,
    # and a number here is one refactor from being wrong. Before the `bash -c`
    # test below on purpose: a quoted `"bash" -c` / `bash "-c"` has to reach it
    # spelled the way that test reads.
    gate_dequote_structural "$segment"
    segment="$GATE_STRUCT_SEG"
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

# ── A shell WORD, for the gates that extract with PERL ─────────────────────
#
# `GATE_PATH_TOKEN` and `_GATE_WORD_CHAR` are bash EREs, usable only from
# `[[ =~ ]]`. FIVE gates -- issue-deferral-criteria, gh-body-english,
# issue-dup-check, issue-classification-label and pr-body-item-number -- pull a
# `--body-file` path or an inline `--body` value out of RAW command text with
# `perl -0777` instead, because they need a GLOBAL scan over a multi-line slurp
# and `[[ =~ ]]` gives neither. Derive the list rather than trusting this
# sentence -- `grep -l GATE_PERL_WORD .claude/hooks/*-gate.sh` -- because an earlier
# revision of THIS comment said "three" while five files consumed it, which is
# the same stale-sibling-note class the constant exists to end.
# All of them spelled the value class `(["']?)([^"'\s]+)\1`, and that shape had
# THREE MEASURED holes, all fail-OPEN (go-to-k/cdkd, 2026-09-05):
#
#   gh issue create --body-file "<dir with space>/x.md"
#     The bare class cannot span the space, and with the optional quote group
#     unset it cannot start on the quote either, so NOTHING is extracted and
#     the gate judges an empty body. Measured: issue-deferral-criteria-gate
#     rc=0 on a PR-shaped deferral where the unquoted spelling gave 2, and
#     gh-body-english-gate rc=0 on a JAPANESE body where the unquoted spelling
#     gave 2 -- the English-only rule was bypassable by putting the body file
#     in a directory whose name contains a space.
#
#   gh api repos/O/R/issues -f body='<text>'
#     gh's OWN documented spelling puts the quote INSIDE the value, after the
#     `body=`. An alternation tried AFTER the literal `body=` falls through to
#     `\S+` and captures `body='a`. Measured on issue-deferral-criteria-gate:
#     rc=0, where `-f 'body=<text>'` (quote OUTSIDE, the only shape its suite
#     covered) gave 2.
#
# So the value class is defined ONCE, here, rather than a fourth time in the
# next hook that needs it. `GATE_PERL_WORD` is a perl PRELUDE, not a regex: a
# caller prefixes it to its own program --
#
#   perl -0777 -ne "$GATE_PERL_WORD"'
#     while (/--body-file[=\s]+($GW)/g) { print gate_unq($1), "\n"; }'
#
# -- and it defines two names:
#
#   $GW        ONE shell word that may EMBED quoted spans: the perl twin of
#              `_GATE_WORD_CHAR`. `body='a b c'` is one word, `"/a b/x.md"` is
#              one word, and a bare run still stops at whitespace.
#   gate_unq   the shell's own unquoting of such a word, so a caller gets the
#              string gh actually receives: spans unwrapped, and `\X` unescaped
#              exactly where the shell would unescape it (inside a
#              double-quoted span only for `\ " $` and a backtick; never inside
#              a single-quoted one, which takes no escapes).
#
# UNBALANCED quotes are not a regression risk here: `$GW`'s bare alternative
# excludes both quote characters, so a word like `/tmp/o'neill/x.md` stops at
# the apostrophe -- which is exactly where the old class stopped too.
#
# A hook using this MUST also assert `GATE_PERL_WORD` is non-empty in its
# library-load guard. Left undefined, `$GW` interpolates as the EMPTY string,
# `($GW)` then matches empty at every position, and the extraction yields empty
# values that every caller skips -- a silent fail-open, which is the exact
# class this constant closes.
#
# The apostrophes below are spelled `\x27` -- a PERL escape, valid in a regex
# and in a substitution alike -- because this is a bash SINGLE-QUOTED string
# and a literal apostrophe would end it. The `'"'"'` idiom used elsewhere in
# this file would work too, and is unreadable at this density.
GATE_PERL_WORD='
  # ANSI-C quoting is the FIRST alternative on purpose. `$` is an ordinary
  # character to the bare class below, so without this arm `$\x27...\x27` was
  # split into a bare `$` plus a plain single-quoted span -- which took the body
  # LITERALLY, so `--body $\x27日本語\x27` reached the English-only
  # gate as the ASCII text `$日本語` and passed, while bash sent
  # Japanese. Its inner `\\.` also differs from the plain single-quote arm:
  # inside `$\x27...\x27` a backslash ESCAPES, so `\\\x27` does not close it.
  my $GW = qr/(?:\$\x27(?:[^\x27\\]|\\.)*\x27|"(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27|\\.|[^\s"\x27;|&()<>\x60])+/;
  # ANSI-C escape decoding, used only by the `$\x27...\x27` arm of gate_unq.
  # Returns CHARACTERS, not bytes, and that is measured rather than stylistic.
  # The callers run under mixed `-C` settings -- the path extraction has none,
  # the non-English body scan uses `-CSD` -- and under `-CSD` the input string
  # is ALREADY decoded, so splicing utf8-ENCODED bytes into it made the two
  # halves of one value disagree: `--body $\x27\\u65e5\\u672c\\u8a9e\x27` came back as
  # Latin-1 mojibake that `NON_ENGLISH_RE` did not match, and the gate passed a
  # Japanese body (rc=0 where the literal spelling gave 2). Characters keep the
  # value uniform; on the byte-mode callers perl encodes a wide character to
  # UTF-8 on output anyway (with a warning, and their stderr is discarded), so
  # the bytes that reach the caller are the same either way.
  sub gate_ansi_c {
    my ($v) = @_;
    my %simple = ("a"=>"\a","b"=>"\b","e"=>"\e","E"=>"\e","f"=>"\f",
                  "n"=>"\n","r"=>"\r","t"=>"\t","v"=>"\013",
                  "\\\\"=>"\\\\","\x27"=>"\x27","\""=>"\"","?"=>"?");
    my $o = "";
    while (length $v) {
      if ($v =~ s/^\\x([0-9A-Fa-f]{1,2})//)        { $o .= chr(hex($1)); }
      elsif ($v =~ s/^\\u([0-9A-Fa-f]{1,4})//)     { my $c = pack("U", hex($1)); utf8::encode($c); $o .= $c; }
      elsif ($v =~ s/^\\U([0-9A-Fa-f]{1,8})//)     { my $c = pack("U", hex($1)); utf8::encode($c); $o .= $c; }
      elsif ($v =~ s/^\\([0-7]{1,3})//)            { $o .= chr(oct($1)); }
      elsif ($v =~ s/^\\c(.)//)                    { $o .= chr(ord(uc $1) ^ 64); }
      elsif ($v =~ s/^\\(.)//s)                    { $o .= exists $simple{$1} ? $simple{$1} : "\\" . $1; }
      elsif ($v =~ s/^([^\\]+)//s)                 { $o .= $1; }
      else                                          { $v =~ s/^(.)//s; $o .= $1; }
    }
    # BUILT AS BYTES, HANDED BACK AS CHARACTERS. The two escape families differ
    # in bash: `\\xHH` and `\\NNN` emit raw BYTES while `\\uXXXX` emits a CHARACTER,
    # so the only representation both agree on is the byte string bash would
    # actually pass -- hence `\\u` is encoded above rather than left wide.
    # Decoding once at the end then makes the result uniform for the `-CSD`
    # caller. Measured before this: `$\x27\\xe6\\x97\\xa5\x27` (the UTF-8 bytes of a
    # Japanese character, which is how a shell user writes it) decoded to three
    # Latin-1 characters, `NON_ENGLISH_RE` did not match, and the gate passed a
    # Japanese body at rc=0.
    # A value that is NOT valid UTF-8 is left exactly as built: utf8::decode
    # returns false and does not modify the string, which is the right answer
    # for a genuinely binary `\\xNN` payload.
    utf8::decode($o);
    return $o;
  }
  sub gate_unq {
    my ($t) = @_;
    my $o = "";
    while (length $t) {
      if ($t =~ s/^"((?:[^"\\]|\\.)*)"//s) {
        my $s = $1; $s =~ s/\\([\\"\$`])/$1/gs; $o .= $s;
      } elsif ($t =~ s/^\$\x27((?:[^\x27\\]|\\.)*)\x27//s) { $o .= gate_ansi_c($1);
      } elsif ($t =~ s/^\x27([^\x27]*)\x27//s) { $o .= $1;
      } elsif ($t =~ s/^\\(.)//s)              { $o .= $1;
      } elsif ($t =~ s/^([^"\x27\\]+)//s)      { $o .= $1;
      } else { $t =~ s/^(.)//s; $o .= $1; }
    }
    return $o;
  }
'

# `GATE_PERL_WORD` is one shared literal that five blocking gates interpolate,
# so its failure mode is the one this whole mechanism must not have: every
# consumer runs `perl ... 2>/dev/null`, so a prelude that is PRESENT but does
# not COMPILE produces no output, no stderr, and no exit-code change -- the
# gates simply extract nothing and pass. Measured: a non-empty, non-compiling
# prelude silently disarmed four gates at once (a Japanese body, a PR-shaped
# deferral, an unlabelled `Severity: high`, and a bare `#4` all reached rc=0).
#
# `[ -n "$GATE_PERL_WORD" ]` cannot see that, so it is not the guard -- it is
# only the cheap first half. This is the second half: run the prelude on a
# known input and require the known answer. Call it AFTER a gate has armed, not
# at library-load: the library is sourced by every hook on every Bash call,
# while an armed gate is already about to fork perl anyway.
#
# Returns 0 when the prelude is usable, 1 otherwise. Callers must fail CLOSED.
# Memoised fail-closed wrapper: probe once per process, at the first point a
# gate is actually about to extract, then remember. `$1` is the gate's own name
# so the refusal says which one refused.
gate_perl_word_or_die() {
  if [ "${__GATE_PW_OK:-}" != "1" ]; then
    if gate_perl_word_ok; then
      __GATE_PW_OK=1
    else
      echo "Blocked by $1: .claude/hooks/lib/command-match.sh defines GATE_PERL_WORD," >&2
      echo "but running it does not return the expected value -- the prelude is missing," >&2
      echo "outdated, or does not compile. Every extraction in this gate runs perl with" >&2
      echo "stderr discarded, so a broken prelude would silently extract NOTHING and the" >&2
      echo "gate would PASS whatever it was meant to refuse. Refusing instead." >&2
      echo "Fix the library (or restore it from origin/main) and retry." >&2
      return 1
    fi
  fi
  return 0
}

gate_perl_word_ok() {
  [ -n "${GATE_PERL_WORD:-}" ] || return 1
  # Two assertions in one probe: `$GW` spans a quoted value containing a space
  # (the bug this prelude was written for), and `gate_unq` strips the quotes.
  [ "$(printf '%s' 'x --body-file "/a b/p.md"' \
        | perl -0777 -ne "$GATE_PERL_WORD"'
            while (/--body-file[=\s]+($GW)/g) { print gate_unq($1) }' 2>/dev/null)" \
    = '/a b/p.md' ]
}

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
# This paragraph used to add "a value still may not BEGIN with `-`, or
# `git -C /tmp -q commit` reads `-q` as `-C`'s value". That rule is GONE with
# the enumerating prefix (go-to-k/cdkd#2156): it only means anything while the
# pattern is trying to decide WHICH token is a value, and the over-approximating
# prefix deliberately does not decide -- it walks past both readings to the verb.
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
# There used to be a NODASH twin of each of these -- "the first character may
# not be `-`, so a following flag is never swallowed as the previous flag's
# value". Both are gone with the enumerating prefix (go-to-k/cdkd#2156): the
# rule they enforced only makes sense when the pattern is trying to decide WHICH
# token is a value, and the over-approximating prefix deliberately does not.
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
#
# THE TRIGGER IS NOW OVER-APPROXIMATED, AND THE RESOLVER IS STILL STRICT
# (go-to-k/cdkd#2156). Everything above describes four rounds of WIDENING this
# pattern one flag spelling at a time -- a quoted value, a value containing a
# space, an escaped quote, `gh -R`. Each fix was right for the spelling it
# addressed and none of them BOUNDED the problem, because shell grammar is not
# regular: the set of spellings an enumerating pattern misses is unbounded, and
# every miss exits 0, which is indistinguishable from a pass on the merits.
#
# So the enumeration is gone. The prefix between the command word and the verb
# is now: EITHER the verb sits immediately after the command word, OR the
# command word is followed by at least one FLAG (a token beginning with `-`),
# after which ANY tokens may follow up to the verb. Nothing about a flag's VALUE
# has to parse -- how many values it takes, whether they are quoted, whether the
# quoting is balanced -- so the next unlisted spelling widens the match rather
# than losing it.
#
# WHAT STOPS THE SCAN is a bare token in FIRST position. `git log --grep commit`
# must not arm the commit gates, and `git` syntax says the first token that is
# not a flag IS the subcommand, so a bare first token settles it with no list of
# subcommand names to go stale. A bare token AFTER a flag is deliberately NOT a
# stopper -- it may be that flag's value -- which is what keeps
# `git -C log commit` (a worktree directory named `log`) matching.
#
# Do NOT read that as "a bare first token is the ONLY thing that stops it"; an
# earlier version of this paragraph said so and it is false. QUOTING the verb or
# the flag stops it too, measured on this branch AND on origin/main, so these
# are pre-existing rather than introduced -- and each really is the subcommand
# and each reaches git ungated:
#
#   git "commit" -m x      git 'commit' -m x      git c"o"mmit -m x
#   git \commit -m x       git "-C" /tmp commit   gh "pr" merge 1
#
# The same holds one level up: this pattern still enumerates exactly ONE flag
# spelling, the literal `-` that must open the first prefix token, so
# `git \-C /tmp commit -m x` and `gh "-R" o/r pr merge 42` also matched nothing.
#
# CLOSED, go-to-k/cdkd#2333, and NOT by touching this pattern. All eight shapes
# above are now MATCHED, because `gate_dequote_structural` rewrites the segment
# before any reader sees it -- dequoting the command word, the leading
# global-flag NAMES and the SUBCOMMAND position, and nothing else. Read that
# function's header for why the obvious fix (dequote the whole segment) was
# built, reviewed four rounds and WITHDRAWN: quoting is a load-bearing BRAKE on
# the over-approximating prefix here, so a blanket dequote turns 16 measured
# read-only commands into refusals. What remains is one narrower residue,
# recorded there.
#
# STRICT SUPERSET, and it is checkable rather than asserted. The old pattern
# required every prefix token to begin with `-` and allowed each at most one
# value; the new one drops both constraints and adds no new requirement, so any
# segment the old pattern matched the new one matches. The differential fence
# (lib/command-match-differential.test.sh) therefore treats any lost match as an
# undeclared regression: the cells THIS work adds to its table are all
# `WIDE_TRIGGER` / `MLSUBST` / `MLBACKTICK` / `LATERQ` and every one is 0 -> 1
# (bar the single enumerated loss), so a cell going the other
# way is unenumerated and fails. (The table's two `NOW_MISS` rows predate this
# and belong to go-to-k/cdkd#2027, measured against the vendored baseline rather
# than against origin/main.)
#
# The cost is a wider FALSE-REFUSAL surface, which is the cheap direction (a
# gate refuses with an actionable message) but is still a cost, so it was
# MEASURED rather than reasoned about -- see the corpus measurement recorded in
# .claude/rules/hooks.md. Do NOT narrow this back to "flags only" to shave that
# number: narrowing the trigger is the failure mode this whole comment exists
# for, and it fails silently.
#
# The INTERIOR tokens are split into the FIRST one (a flag's value) and the
# LATER ones, and each gets a different apostrophe rule. All of it came from
# measurement; the reasoning that produced the first version was WRONG and is
# recorded here so it is not re-derived.
#
# `_GATE_WORD_BLIND` already excludes `"` everywhere for the documented reason:
# POSIX leftmost-longest PREFERS a blind reading that parses half of a quoted
# token whenever that yields a longer match. Dropping the "flags only"
# constraint gave the same preference a way in through the SINGLE quote, so
# `gh -R o/r pr create -b '"'"'x pr merge y'"'"'` began matching GATE_RE_GH_PR_MERGE.
#
# The first fix restricted only the FIRST CHARACTER of a blind token, justified
# by "a quoted span can only be split if some token starts at its opening
# quote". THAT SENTENCE IS FALSE, and review round 1 measured two counter-
# examples that split a span whose opening quote is INTERIOR to a token:
#
#   gh ... issue comment 42 --body '"'"'we can'"'"'\'"'"''"'"'t pr merge 99 until CI is green'"'"'
#   gh ... issue comment 1  --body='"'"'next: pr merge 5'"'"'      (also -b'"'"'...'"'"' and =$'"'"'...'"'"')
#
# The first tiles through `_GATE_WORD_CHAR`'s single-quoted-span alternative
# (`'"'"'we can'"'"'` is a legal span, `\'"'"'` a legal escape), the second through the
# blind TAIL. `'"'"'...'"'"'\'"'"''"'"'...'"'"'` is THE shell idiom for an apostrophe inside a
# single-quoted string -- this repo's own CLAUDE.md uses it -- so every English
# body with a contraction takes that shape, and on the first version a plain
# `gh issue comment` drew integ-broad-gate rc=2 and pr-review-gate rc=2 (the
# latter off querying PR #99). Both are rc=0 on origin/main: a NEW false refusal.
#
# What actually separates the two populations is measured, not assumed:
#   * the LOST-match case that forced apostrophes to stay legal at all is an
#     unbalanced one in a PATH (`/tmp/o'"'"'neill/repo`, go-to-k/cdkd#2199), and a
#     path never starts with `-`;
#   * every false refusal above needs a token that DOES start with `-`
#     (`--body='"'"'next:`, `-b'"'"'next:`) or that starts at a span's opening quote.
# So a LATER word may carry an apostrophe only when it is bare-led, a dash-led
# one may not, and the single-quoted-span alternative is dropped for later words
# (it is what tiles the first counterexample). The FIRST interior word keeps the
# fully permissive form, so `-c core.pager='"'"'less -S'"'"'` and `gh --template '"'"'a b'"'"'`
# are unaffected.
#
# Four candidates were probed against an 18-case battery before this one; three
# are recorded because each looks right:
#   B  forbid `'"'"'` in the blind tail everywhere -- breaks all three apostrophe-
#      path cases AND does not fix the `'"'"'...'"'"'\'"'"''"'"'...'"'"'` idiom (4 wrong).
#   A1 apostrophes only in the FIRST interior word -- leaves the idiom matching
#      and loses `git -c a=b -C /tmp/o'"'"'neill/repo commit` (2 wrong).
#   A2 A1 plus dropping the span alternative later -- still loses that same
#      LATER-word path (1 wrong).
# Only the split below is 0 wrong, and it loses no cell of the differential
# corpus against origin/main.
_GATE_WORD_BLIND_NOQUOTE='[^[:space:]"'"'"'][^[:space:]"]*'
_GATE_WORD_CHAR_NOSQ='("([^"\\]|\\.)*"|\\.|[^[:space:]"'"'"'])'
# A single-quoted span is legal as a token SUFFIX: `core.pager='"'"'less -S'"'"'` and a
# bare `'"'"'a b'"'"'` end at their span, while the quote-close-escape-reopen idiom
# (`'"'"'we can'"'"'\'"'"''"'"'t pr merge 99'"'"'`) has its span MID-token, so no tiling of it can
# leave ` pr merge` outside a span.
_GATE_WORD_SPANSUF='[^[:space:]"'"'"']*('"'"'[^'"'"']*'"'"')?'
_GATE_WORD_BLIND_BARE='[^[:space:]"'"'"'-][^[:space:]"]*'
# A DASH-LED token may carry a LOOSE apostrophe too. Round 3 forbade this and
# priced it as "two cells on `commit`". The price was wrong: measured through
# the shipped hooks, the same token shape with `checkout` / `restore` /
# `pr merge` took dirty-path-restore-gate (the go-to-k/cdkd#1700 data-loss gate)
# and BOTH merge gates from rc=2 to rc=0, on `--work-tree=/x/o'"'"'brien` and
# `--template=/a/o'"'"'neill`. The apostrophe alone flipped them; the
# apostrophe-free twins stayed rc=2.
#
# Admitting it costs three FALSE REFUSALS (`--body='"'"'next: pr merge 5'"'"'` and its
# `-b'"'"'...'"'"'` / `=$'"'"'...'"'"'` spellings) and that is the better trade, because a false
# refusal is LOUD -- visible, diagnosable, one rephrase away -- while a bypass is
# SILENT and destroys uncommitted work saying nothing. Measured on a 30-case
# battery: this shape 3 wrong, all false refusals; forbidding it 4 wrong, all
# bypasses; dropping the split entirely 4 wrong, all false refusals.
_GATE_WORD_LOOSE_FLAG='-[^[:space:]"'"'"']*'"'"'[^[:space:]"'"'"']*'
_GATE_WORD_FIRST="(${_GATE_WORD_CHAR}+|${_GATE_WORD_BLIND_NOQUOTE})"
# And finally the ORIGINAL quote-blind fallback, restored for later words.
# Rounds 2, 3 and 4 each removed a little more of it to keep one false refusal
# out, and round 5 measured what that cost: a LATER token that is not
# double-quote-parseable AND carries MORE THAN ONE apostrophe matched NOTHING.
# Every alternative above rules it out -- NOSQ has no `'"'"'` at all, SPANSUF takes
# one span that must END the token, BLIND_BARE cannot start with `-` or `'"'"'`,
# LOOSE_FLAG takes exactly ONE apostrophe. `'"'"'O'"'"''"'"''"'"'Brien'"'"'` has five.
#
# Measured against the merge base, same hook binary and payload:
#
#   git -C <wt> --exec-path='"'"'/opt/git'"'"'/libexec commit -m x
#      branch-gate              rc=2 -> rc=0
#   git -C <wt> --exec-path='"'"'/opt/git'"'"'/libexec checkout -- f.txt
#      dirty-path-restore-gate  rc=2 -> rc=0   (the go-to-k/cdkd#1700 data-loss gate)
#   gh -R go-to-k/cdkd --jq='"'"'.a'"'"''"'"''"'"'b'"'"' pr merge 2330 --squash
#      pr-review-gate           rc=2 -> rc=0
#
# `--exec-path` / `--work-tree` / `--namespace` / `--config-env` are ordinary
# git global flags and all regressed. What made it REACHABLE is the
# `git -C <worktree>` form this repo mandates: `-C` consumes the FLAG and FIRST
# slots, so every later flag lands in the restricted position.
#
# Do NOT answer this by widening LOOSE_FLAG to two apostrophes. That is the
# fifth fix in one direction and the sixth case is
# `--author='"'"'O'"'"''"'"''"'"'Brien-D'"'"''"'"''"'"'Arcy'"'"'`. The blind form is quote-BLIND by
# construction, so no apostrophe count can outrun it. Its cost is a wider false
# refusal surface, which is the LOUD direction, and the differential prices it
# exactly: three cells on corpus id 174 become a fourth ACCEPTED_FR row.
_GATE_WORD="(${_GATE_WORD_CHAR_NOSQ}+|${_GATE_WORD_SPANSUF}|${_GATE_WORD_BLIND_BARE}|${_GATE_WORD_LOOSE_FLAG}|${_GATE_WORD_BLIND})"
GATE_FLAGS="([[:space:]]+-(${_GATE_WORD_CHAR}+|${_GATE_WORD_BLIND})([[:space:]]+${_GATE_WORD_FIRST})?([[:space:]]+${_GATE_WORD})*)?"
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
# `switch` alone, for the same reason `checkout` is separate: a caller that
# judges the ARGUMENT TAIL has to know which verb fired -- `-c` creates a branch
# under `switch` and is a config override under `checkout` -- so the combined
# GATE_RE_GIT_SWITCH cannot answer it. main-tree-branch-gate reads both.
GATE_RE_GIT_SWITCH_ONLY="^git${GATE_FLAGS}[[:space:]]+switch([[:space:]]|$)"
GATE_RE_GIT_RESTORE="^git${GATE_FLAGS}[[:space:]]+restore([[:space:]]|$)"
# A STRICT prefix, for the one gate whose verb is ALSO an ordinary English word
# that shows up as an argument. `GATE_FLAGS` deliberately over-approximates --
# one flag token then ANY words -- which is right where the verb is unambiguous
# and wrong where it is not: measured 2026-09-02, `git -C <lane> log --grep
# rebase main` matched `^git${GATE_FLAGS}[[:space:]]+rebase`, and the gate
# reading it refused a READ-ONLY query while prescribing `reset --soft`. So the
# prefix here is an ALLOWLIST of git's real global flags, and the verb must be
# the actual subcommand. An unrecognised global flag simply fails to match,
# which suits a gate whose miss is cheaper than its false block; do NOT reach
# for this shape in a gate that must fail closed.
#
# It lives HERE rather than in the hook because `unresolved-target-class.test.sh`
# fence 1 forbids any hook outside this library from spelling a `-C` scan, and
# it is right to: a second copy of that shape is how go-to-k/cdkd#2455 (the
# attached `-C<path>` form going unread) stays hard to fix in one place.
# `_GATE_GIT_GLOBAL_VALUE` accepts a QUOTED value, because `git -C "<path>"` is
# the spelling this repo's own flow prints and a lane path can contain a space.
# A bare `[^[:space:]]+` stopped at the quote and the whole pattern failed to
# match, standing the gate down on exactly the form it documents.
_GATE_GIT_GLOBAL_VALUE="(\"[^\"]*\"|'[^']*'|[^[:space:]]+)"
GATE_GIT_GLOBAL="(-C[[:space:]]*${_GATE_GIT_GLOBAL_VALUE}|-c[[:space:]]*${_GATE_GIT_GLOBAL_VALUE}|--git-dir=${_GATE_GIT_GLOBAL_VALUE}|--work-tree=${_GATE_GIT_GLOBAL_VALUE}|--namespace=${_GATE_GIT_GLOBAL_VALUE}|--exec-path=${_GATE_GIT_GLOBAL_VALUE}|-p|--paginate|-P|--no-pager|--bare|--no-optional-locks|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-replace-objects)"
# flatten-before-rebase-gate. `rebase` is a common word in commit messages, PR
# bodies and `--grep` arguments, which is why this one takes the strict prefix.
GATE_RE_GIT_REBASE="^git([[:space:]]+${GATE_GIT_GLOBAL})*[[:space:]]+rebase([[:space:]]|$)"
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
# gh-body-english-gate: every gh verb that PUBLISHES prose. UNANCHORED, because
# that hook feeds the same ERE to `cmd_matches_verb` (which wraps it in `^(...)`)
# and to `cmd_last_cd_target` (which needs the bare verb). The terminator is
# spelled out rather than `\b`: cmd_last_cd_target feeds this to AWK, where
# `\b` is a BACKSPACE, so the "stop following cds at the verb" guard would
# silently never match and a trailing `cd` would hijack the target dir.
#
# SHARED rather than hand-rolled (go-to-k/cdkd#2156). The local copy enumerated
# `(-C|-R|--repo)([[:space:]]+|=)[^[:space:]]+` -- three flag names and one
# unquoted value shape -- so `gh --template "a b" issue create --body <text>`
# reached gh with the gate never armed. That is the under-approximated TRIGGER
# this issue is about, in the one hook that still had its own.
GATE_RE_GH_PROSE_CARRIER="gh${GATE_GH_C}[[:space:]]+(pr[[:space:]]+(create|edit|comment|review)|issue[[:space:]]+(create|comment|edit)|release[[:space:]]+(create|edit)|api)([[:space:]]|\$|[|;&\`)])"
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
# gate_verb_span <segment> <extended-regex>
#
# The LENGTH of the SHORTEST `^`-anchored match, i.e. the span ending at the
# LEFTMOST occurrence of the verb. Exit 1 (and no output) when the segment does
# not match at all.
#
# WHY THIS EXISTS (go-to-k/cdkd#2156 review round 1). POSIX `=~` is leftmost-
# LONGEST, and once GATE_FLAGS stopped enumerating flag spellings ("one flag,
# then ANY tokens") the engine gained a legal parse that swallows the REAL verb
# into the PREFIX and anchors on a LATER one in the same segment. The boolean
# readers do not care -- the answer is still "yes, this is a checkout". The
# three LENGTH-strip helpers below care completely, because they re-apply the
# matched span to the segment and read what follows.
#
# Measured on the first attempt at this widening, through the shipped hooks
# against a repo with a dirty `f.txt`:
#
#   git -C <wt> checkout -- f.txt # undo probe, then git checkout main
#      gate_verb_rest -> `main`  (origin/main: `-- f.txt # undo probe, ...`)
#      dirty-path-restore-gate   rc=2 on origin/main -> rc=0 here
#   gh -R o/r pr merge 2195 --squash --delete-branch # then gh pr merge 9
#      gate_pr_selector -> 9     (origin/main: 2195)
#
# The `--` vanished from the tail, so the go-to-k/cdkd#1700 data-loss gate read
# a branch switch and PASSED, on the `git -C <worktree>` spelling this repo
# MANDATES; and three merge gates judged the wrong PR. THE STRICT RESOLVER DOES
# NOT CATCH EITHER: resolution succeeds, on the wrong arguments.
#
# The fix is here rather than in the pattern, and the alternatives were probed:
# re-narrowing GATE_FLAGS reopens the whole bypass class this work exists to
# close; bash has no lazy quantifier (POSIX ERE); and cutting at the first `pr`
# / `checkout` TOKEN mis-cuts `git -C /repo/pr pr merge 42`, whose first `pr` is
# a path component. Asking the REGEX for its shortest match keeps the verb
# grammar in one place and cannot mis-cut on a PATH COMPONENT, because a prefix
# only matches when the whole anchored pattern does -- `git -C /repo/pr pr merge`
# cuts correctly.
#
# It CAN still mis-cut when a flag VALUE is the bare verb word itself, and the
# earlier "cannot mis-cut" here was too strong. Measured:
# `git -C commit commit -m x` cuts at the `-C` value, so the tail comes back as
# `commit -m x` rather than `-m x`. Shortest-match cannot tell that reading from
# the right one -- both are legal parses, and the wrong one is genuinely
# shorter. Filed rather than fixed: a worktree directory named exactly `commit`
# is the only way to reach it, and the tail is WIDER than the truth, so a gate
# that scans it for danger sees more rather than less.
#
# Candidate ends are token boundaries only: every anchored match ends either on
# the whitespace its `([[:space:]]|$)` tail consumed, or at end of segment. So
# this costs one regex test per whitespace run BEFORE the leftmost verb, not one
# per character, and it stops at the first hit. The greedy match length bounds
# the walk, so a segment that does not match costs nothing extra.
gate_verb_span() {
  local seg="$1" re="$2" greedy i probe
  [[ "$seg" =~ $re ]] || return 1
  greedy=${#BASH_REMATCH[0]}
  # FAST PATH, and it is what keeps this from being quadratic. Drop the greedy
  # span's trailing whitespace and then its LAST CHARACTER, and re-test.
  #
  # THE LAST CHARACTER, not the last token -- an earlier version of this comment
  # said "token" and the code never did that: `${probe%[! <tab>]*}` removes the
  # SHORTEST suffix matching the pattern, which is one character
  # (`git -C /tmp commit ` -> `git -C /tmp commi`). Left uncorrected, the next
  # person to "fix" the code to match the comment would change the algorithm
  # blind.
  #
  # Why one character is sound: the verb patterns are anchored at `^` but NOT at
  # `$`, so truncating the tail can only destroy matches that END at the removed
  # character. If a shorter match exists it survives the truncation and the test
  # still passes, sending us to the walk. So a pass means "there may be an
  # earlier verb, go look" and a FAILURE means "the greedy end was the only
  # match", which is the shape of every ordinary command, at the cost of one
  # extra regex test.
  #
  # Measured, `git` + N `-c k=v` flags + `commit -m x`, match + rest + selector:
  #
  #        N      origin/main     walk only     walk + this pre-test
  #       160          25 ms        310 ms                    26 ms
  #       640          72 ms       4293 ms                    74 ms
  #
  # Without it the walk re-scans a growing prefix once per token, which a long
  # flag list turns into seconds inside a PreToolUse hook that runs on EVERY
  # Bash call. Realistic shapes were never the problem (a 400-word `--body`
  # measured +6 ms), but "realistic" is not a bound.
  probe="${seg:0:greedy}"
  probe="${probe%"${probe##*[! 	]}"}"    # drop trailing whitespace
  probe="${probe%[! 	]*}"                 # then ONE character (see above)
  if ! [[ "$probe" =~ $re ]]; then
    printf '%s' "$greedy"
    return 0
  fi
  # BOUNDED, because an unbounded walk is a FAIL-OPEN surface rather than a slow
  # one. The fast path above is defeated by a single repeated verb, and the walk
  # is then O(boundaries x span). Measured end-to-end through pr-review-gate.sh
  # on `gh -R o/r <N x -c k=v> pr merge 42 pr merge`: N=640 2565 ms, N=1280
  # 9518 ms, N=1600 14888 ms -- against the `timeout: 10` that pr-review-gate,
  # ci-green-gate, closes-paren-form-gate and non-english-text-gate carry. A
  # PreToolUse hook that TIMES OUT does not block, so the slow path hands an
  # attacker the whole gate rather than a wrong argument.
  #
  # The cap trades that for the pre-fix behaviour on adversarial input only:
  # past the cap we fall back to `greedy`, which is what shipped before
  # go-to-k/cdkd#2156 and which mis-reads the ARGUMENTS (a bad tail) rather than
  # dropping the gate entirely. A wrong tail is bounded and loud; a timed-out
  # hook is silent and total.
  #
  # 96 is chosen against the real distribution, not for roundness: the verb sits
  # within the first handful of tokens in every ordinary command, and the widest
  # shape this repo's own corpus produces is a `git -c k=v` chain of single
  # digits. A command needing more than 96 whitespace boundaries BEFORE its verb
  # and carrying a second occurrence of that verb is constructed, not typed.
  local cap=96
  for (( i=1; i < greedy && cap > 0; i++ )); do
    case "${seg:i-1:1}" in
      ' '|$'\t'|$'\n') ;;
      *) continue ;;
    esac
    cap=$((cap - 1))
    if [[ "${seg:0:i}" =~ $re ]]; then
      printf '%s' "$i"
      return 0
    fi
  done
  printf '%s' "$greedy"
  return 0
}

# gate_verb_rest <command> <verb-ere>
# Everything AFTER the matched verb, for callers that run their own token walk.
# Same rationale and the same anchored-match strip as gate_pr_selector.
gate_verb_rest() {
  local cmd="$1" re="$2" segment _gate_span
  while IFS= read -r segment; do
    _gate_span=$(gate_verb_span "$segment" "$re") || continue
    printf '%s' "${segment:$_gate_span}"
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
  local cmd="$1" re="$2" segment _gate_span
  while IFS= read -r segment; do
    _gate_span=$(gate_verb_span "$segment" "$re") || continue
    printf '%s\n' "${segment:$_gate_span}"
  done < <(gate_segments "$cmd")
  return 0
}

# gate_verb_rest_each_dir <command> <fallback-dir> <verb-ere>
#
# `gate_verb_rest_each` plus the working tree EACH matching segment runs in: one
# "<dir><TAB><rest-after-the-verb>" line per matching segment.
#
# WHY the tree has to come out of the SAME walk. Resolving it once per COMMAND
# -- `gate_target_dir_strict`, whose walk stops at the first matching segment --
# makes segment 1's tree decide the whole command, so a gate that then judges
# every segment judges them all against the wrong tree. Measured against both
# repos' real main checkouts and their real linked worktrees, driving
# main-tree-branch-gate with a payload cwd of the MAIN tree:
#
#   git -C <worktree> switch -c a && git switch -c b     rc=0, want 2  BYPASS
#   git switch main && git -C <worktree> switch -c a     rc=2, want 0  FALSE BLOCK
#
# The first is the `git fetch && git switch -c` bypass these gates exist to
# close, one operator further along: segment 1 resolves to a linked worktree,
# the gate stands down for the whole command, and segment 2 -- running in the
# SHARED main tree -- is never judged. The second refuses a branch creation in a
# linked worktree, which is exactly what the worktree convention mandates.
#
# An EMPTY <dir> means that segment names its tree with an expression this
# parser cannot read (an unexpanded `$VAR`, a backtick, a glob, a `~user`). It
# is `gate_target_dir_strict`'s `return 2` in a per-line channel, and a BLOCKING
# caller must refuse it the same way -- see gate_refuse_unresolved_target.
#
# Callers split the line with `${line%%<TAB>*}` / `${line#*<TAB>}`, NOT with
# `IFS=$'\t' read -r dir rest`: tab is IFS whitespace, so that spelling folds a
# TAB RUN inside the rest and silently drops an argument.
#
# The cd / `-C` reading is a deliberate COPY of gate_target_dir_strict's rather
# than a shared helper. That function is called by 24 gates and its walk BREAKS
# at the verb, which is the one thing this walk must not do; a shared helper
# would have to carry both behaviours and every one of those callers would ride
# on the flag. `command-match.test.sh` pins the two against each other on the
# single-segment shape instead, so the copy cannot drift silently.
gate_verb_rest_each_dir() {
  local cmd="$1" fallback="$2" re="$3"
  local target="$fallback" segment cd_target c_target unresolved_cd=0
  local seg_target seg_unres _gate_span
  while IFS= read -r segment; do
    if [[ "$segment" =~ ^cd[[:space:]]+$GATE_PATH_TOKEN ]]; then
      cd_target=$(gate_unquote "${BASH_REMATCH[1]}")
      # Same unreadable-expression set as gate_target_dir_strict, and an
      # unreadable cd is REMEMBERED rather than refused on the spot: a later
      # ABSOLUTE cd, or an absolute `-C` in the verb's own segment, still makes
      # it moot.
      case "$cd_target" in
        *'$'*|*'`'*|*'*'*|*'?'*|*'{'*) unresolved_cd=1; continue ;;
        '~'|'~/'*) : ;;
        '~'*) unresolved_cd=1; continue ;;
      esac
      [ -z "$cd_target" ] && continue
      cd_target=$(gate_expand_tilde "$cd_target")
      if [[ "$cd_target" == /* ]]; then
        target="$cd_target"
        unresolved_cd=0
      else
        target="$target/$cd_target"
      fi
      continue
    fi
    _gate_span=$(gate_verb_span "$segment" "$re") || continue
    # The running cd state is the SEGMENT's starting point; its own `-C` may
    # then override it. Neither is written back to `target`, because a `-C` is
    # scoped to its one command while a `cd` persists to the next segment.
    seg_target="$target"
    seg_unres="$unresolved_cd"
    c_target=$(gate_leading_c_value "$segment")
    if [ -n "$c_target" ]; then
      c_target=$(gate_unquote "$c_target")
      case "$c_target" in
        *'$'*|*'`'*|*'*'*|*'?'*|*'{'*) seg_unres=1; c_target="" ;;
        '~'|'~/'*) : ;;
        '~'*) seg_unres=1; c_target="" ;;
      esac
      if [ -n "$c_target" ]; then
        c_target=$(gate_expand_tilde "$c_target")
        if [[ "$c_target" == /* ]]; then
          # An ABSOLUTE `-C` decides where this command runs whatever any
          # earlier cd did, so an unreadable cd before it stops mattering.
          seg_target="$c_target"
          seg_unres=0
        else
          # A RELATIVE `-C` resolves against wherever the cds left us, so it
          # inherits their uncertainty rather than curing it.
          seg_target="$seg_target/$c_target"
        fi
      fi
    fi
    [ "$seg_unres" = 1 ] && seg_target=""
    printf '%s\t%s\n' "$seg_target" "${segment:$_gate_span}"
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
  local cmd="$1" re="$2" segment rest tok _gate_span
  while IFS= read -r segment; do
    _gate_span=$(gate_verb_span "$segment" "$re") || continue
    rest="${segment:$_gate_span}"
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

# gate_tokens <text>
#
# One shell token per line, with a QUOTED span kept WHOLE: `switch "my branch"`
# yields two tokens, not three. Callers unquote with `gate_unquote` when they
# want the bare value.
#
# It exists so a gate that must PARSE an argument list does not have to match
# `GATE_EMBEDDING_TOKEN` itself. Matching it in a hook is the go-to-k/cdkd#2200
# coupling: the hook reads a positional `${BASH_REMATCH[N]}` out of a pattern
# built from a SHARED constant, so widening that constant shifts the index and
# silently re-opens the gate. `unresolved-target-class.test.sh` fence 4 refuses
# that shape by name; the sanctioned answer is to pass the pattern to a helper,
# which is this. `gate_verb_rest` gives the same guarantee for the verb prefix.
#
# No `set -f` dance around the loop, unlike `gate_pr_selector`'s: that function
# feeds its tokens to `set --`, which word-splits and globs. This one only ever
# prints `"${BASH_REMATCH[1]}"`, and `[[ =~ ]]` does not glob, so a stray `*` in
# the text has nothing to expand against.
gate_tokens() {
  local rest="$1"
  while [[ "$rest" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN([[:space:]]+(.*))?$ ]]; do
    printf '%s\n' "${BASH_REMATCH[1]}"
    rest="${BASH_REMATCH[4]}"
    [ -n "$rest" ] || break
  done
  # TRUNCATION IS REPORTED, not swallowed. An UNBALANCED quote cannot be split
  # into words at all: `"[^"]*"` needs its closing quote and the bare-run
  # alternative excludes quote characters, so the pattern stops dead at the
  # opening one. Measured before this line existed: `gate_tokens "a'unbalanced"`
  # printed NOTHING and returned 0, and `gate_tokens "-b agent's-branch"`
  # printed only `-b` -- so a caller parsing an option grammar saw a command
  # with no arguments and allowed it. Silence is the one answer that is wrong
  # here; a caller can now refuse, or fall back to a coarser scan, but it can no
  # longer mistake a truncation for a short command line.
  [ -z "${rest//[[:space:]]/}" ]
}

# gate_word_is_literal <word>
#
# 0 when this shell WORD provably reaches the command as exactly the text it
# already carries; 1 when it does not, OR when this function cannot prove that
# it does. It is the SHELL-side twin of `main-tree-branch-gate.sh`'s "AN
# INCOMPLETE PARSE MAY NOT ALLOW": that gate refuses to relax a verdict on a GIT
# OPTION it cannot resolve, and this refuses to hand it a WORD whose expansion
# it cannot see.
#
# THE DEFAULT IS INVERTED, and that is the whole of this function. `gate_argv`
# below used to ENUMERATE the words the shell owns -- a redirection, a trailing
# `&`, a `#` comment -- and pass everything else through as an argument. Three
# rounds of fixes each added another spelling to that list, and each time the
# next round found the spelling still missing. Measured, in all three repos,
# with a branch that exists locally and the payload cwd set to the main tree:
#
#   git checkout <branch> $EMPTY            rc=0, want 2   HEAD MOVED
#   git checkout <branch> ${EMPTY}          rc=0, want 2   HEAD MOVED
#   git checkout <branch> {fd}>/dev/null    rc=0, want 2   HEAD MOVED
#   git checkout <branch> {fd}<f.txt        rc=0, want 2   HEAD MOVED
#
# An empty expansion VANISHES, so the gate counted a positional git never
# receives; bash's fd-variable redirection is a word git never receives at all.
# Both turned `git checkout <branch> <word>` into a two-positional FILE RESTORE
# and PASSED a command that really moves HEAD.
#
# So the question here is not "is this word one of the shell forms I know?" but
# "is every character in it one I can prove the shell leaves alone?".
#
# HOW A SHAPE NOBODY HAS THOUGHT OF LANDS ON REFUSE. Every shell construct is
# SPELLED, and spelled with characters. `GATE_INERT_CHARS` is a CLOSED list of
# characters that trigger no shell processing at all, so a construct built from
# anything else -- a syntax added to a future bash, one this file's author never
# met, one nobody has written down -- necessarily contains a character outside
# that list, and is refused without anyone having had to think of it. The only
# way a new construct could pass is by being spelled ENTIRELY in inert
# characters, which is a contradiction in terms: an inert character is one the
# shell does not act on. The list, not the construct catalogue, is therefore the
# thing to audit, and every member carries the reason it is inert.
#
# THE INERT SET, one character at a time. `A-Z a-z 0-9` need no argument.
#
#   _ - . / :   no shell meaning in any position. A leading `-` only makes the
#               word look like a flag, which is git's business, not the shell's.
#   @ +         special only as the extglob prefixes `@(...)` / `+(...)`, which
#               need `(`, and `(` is NOT inert.
#   ^           special only inside a `[^...]` bracket expression, which needs
#               `[`, and `[` is NOT inert. (History's `^old^new` is line-initial
#               and interactive-only.) `HEAD^` needs it.
#   %           special only as a JOB SPEC, and only as an argument to `jobs` /
#               `kill` / `fg` / `bg` -- never to `git`.
#   ,           special only inside a brace expansion, which needs `{`, and `{`
#               is NOT inert.
#   =           an assignment only in the COMMAND-word position, and every word
#               asked about here is an argument, past the verb. It must be here:
#               `--create=feat` is an ordinary long option.
#   #           a comment only as the FIRST character of a word, which is
#               rejected explicitly below. `has#hash` is a legal branch name and
#               the shell passes it through untouched.
#
# WHAT IS DELIBERATELY OUT, so the cost is visible rather than guessed. `$` and
# a backtick (an expansion this cannot see). `\` (an escape). `*` `?` `[` `]`
# (pathname expansion -- and under `nullglob` a non-matching pattern expands to
# NO words, the vanishing case again). `{` `}` (brace expansion, and the
# fd-variable redirection prefix `{fd}>`). `~` (tilde expansion). `!` (history
# expansion: off in a non-interactive shell, but this cannot see which shell it
# is). Every shell METACHARACTER -- `| & ; ( ) < >` and whitespace -- which the
# segmenter and tokenizer normally consume, so one arriving here is by
# definition unaccounted for. Two exclusions are strictly OVER-strict: `a~b` and
# `feat!` are literal to bash and this refuses them anyway. Over-strict means
# BLOCK, which is the direction this gate exists to fail in.
#
# QUOTING IS TRACKED, because it is what makes the punctuation above reachable.
# A word may EMBED quoted spans rather than BE one (see GATE_EMBEDDING_TOKEN),
# so the walk carries a quote state:
#   - inside a SINGLE-quoted span every character is literal, so nothing is
#     refused there;
#   - inside a DOUBLE-quoted span only `$`, a backtick and `\` stay active, so
#     only those three are refused;
#   - outside quotes the inert list decides.
# That is what keeps `git checkout -b 'feat$x'` an ordinary branch creation --
# a literal `$` in a branch name still behaves -- while an unquoted `$EMPTY` is
# refused.
#
# A word whose quote is still open at the end is refused too: it cannot be split
# into shell words at all, which is the same thing `gate_tokens` reports.
#
# WHAT THIS DOES NOT DECIDE: whether the word is an ARGUMENT. A redirection is
# spelled with `>` and would be refused here, yet it is perfectly accounted for
# -- `gate_argv` recognises it and drops it BEFORE asking this. Recognising a
# shell construct positively and proving a word literal are two different jobs,
# and only the second one has to fail closed.
GATE_INERT_CHARS='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./:@+%,^=#'
# The same set as a GLOB CLASS, so a whole SPAN is decided in one operation
# rather than one character at a time. That is not a micro-optimisation: a hook
# runs on EVERY Bash tool call, and a per-character walk here is quadratic,
# because `${s:i:1}` in a UTF-8 locale walks to offset `i` every time. Measured
# on this machine (bash 5.3.9, en_US.UTF-8), an index-only loop over a string:
# 1 000 chars 0.010 s, 4 000 chars 0.043 s, 16 000 chars 0.478 s -- 16x the
# input for 48x the time. The chunked form below is 0.032 s at 16 000.
#
# `-` is LAST and `^` is not first, which is what keeps both LITERAL inside a
# bracket expression; `!` negates.
GATE_NOT_INERT_GLOB='*[!A-Za-z0-9_./:@+%,^=#-]*'
# Active inside a DOUBLE-quoted span: an expansion, a command substitution, an
# escape. Written with `$'...'` so the backslash and the backtick survive.
GATE_DQ_ACTIVE_GLOB=$'*[\\\\$\140]*'
GATE_QUOTE_CLASS=$'["\047]'
GATE_SQ=$'\047'
# The characters that end a scanning chunk. `$'[\\\\"\047#]'` yields `[\\"'#]`,
# and that doubling is load-bearing: `[\"'#]` does NOT contain a backslash --
# there the backslash escapes the quote and the class silently loses it.
# Verified in BOTH bash 3.2.57 and 5.3.9 against `ab\cd`, `ab"cd`, `ab'cd`,
# `abc#d` and `abcd`.
GATE_CHUNK_STOP=$'[\\\\"\047#]'
GATE_CHUNK_STOP_DQ=$'[\\\\"]'

gate_word_is_literal() {
  local w="$1" rest="$1" chunk q=""
  [ -n "$w" ] || return 1
  # A word STARTING with `#` opens a comment: the shell discards it and every
  # word after it, so it reaches the command as nothing at all.
  case "$w" in '#'*) return 1 ;; esac
  # The walk advances by SPANS, not characters: everything up to the next quote
  # character is tested with one glob, so the number of iterations is the number
  # of quote characters in the word rather than its length.
  while [ -n "$rest" ]; do
    if [ -z "$q" ]; then
      chunk="${rest%%$GATE_QUOTE_CLASS*}"
      case "$chunk" in $GATE_NOT_INERT_GLOB) return 1 ;; esac
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"
      q="${rest%"${rest#?}"}"
      rest="${rest#?}"
    elif [ "$q" = "$GATE_SQ" ]; then
      # Inside a SINGLE-quoted span every character is literal, so there is
      # nothing to test -- only the closer to find.
      chunk="${rest%%$GATE_SQ*}"
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"
      rest="${rest#?}"
      q=""
    else
      chunk="${rest%%\"*}"
      case "$chunk" in $GATE_DQ_ACTIVE_GLOB) return 1 ;; esac
      [ "$chunk" = "$rest" ] && break
      rest="${rest#"$chunk"}"
      rest="${rest#?}"
      q=""
    fi
  done
  # A quote still open means the word cannot be split into shell words at all.
  [ -z "$q" ]
}

# gate_strip_comment <text>
#
# <text> truncated at the first `#` that opens a shell COMMENT -- one at a WORD
# START (the beginning of the text, or after a space or tab) and outside any
# quoted span. Prints the text unchanged when there is none.
#
# WHY IT RUNS BEFORE THE SPLIT, which is the bug it fixes. `gate_argv` used to
# ask `gate_tokens` to split the WHOLE text and refuse on an unbalanced quote,
# then drop the comment inside the walk. An apostrophe INSIDE the comment is
# therefore weighed as a quote, so
#
#   git checkout main # don't switch lanes
#
# came back as a truncation and the gate blocked it -- measured rc=2 against a
# command that leaves HEAD exactly where it was ("Already on 'main'"). The
# comment justifying that order claimed "the text is a shell syntax error in the
# first place, so nothing legitimate is lost". That claim is FALSE and is not
# repeated: `bash -n "git checkout main # don't switch lanes"` reports VALID
# syntax, because the apostrophe is inside a comment and bash never sees it as a
# quote either. Cutting the comment first makes this file agree with the shell.
#
# The unbalanced-quote refusal it is often confused with survives untouched:
# `-b agent's-branch` has no comment to cut, so the text reaches `gate_tokens`
# whole and is still refused.
#
# THE SECOND PASS is `gate_segments_raw`'s `ignore_q` trick, for the same reason
# and with the same shape. If the first walk reaches the end with a quote still
# open, that character may not have been a quote at all, so the walk is redone
# with it literal and a comment is looked for again. `'unbalanced # x` then cuts
# to `'unbalanced `, which `gate_tokens` still refuses -- correctly: bash calls
# that one "unexpected EOF while looking for matching `''".
GATE_COMMENT_CUT=""
GATE_COMMENT_OPENQ=""
_gate_comment_cut() {
  local s="$1" iq="$2" rest="$1" pos=0 chunk c q="" prev=" "
  GATE_COMMENT_CUT="$s"
  GATE_COMMENT_OPENQ=""
  # A text with NO `#` anywhere can carry no comment, and that is the shape
  # essentially every command has. Returning here keeps the walk below off the
  # hot path entirely -- measured, 16 000 characters go from 0.92 s to 0.002 s.
  case "$s" in *'#'*) ;; *) return 0 ;; esac
  # SPANS, not characters, for the reason recorded on GATE_NOT_INERT_GLOB above:
  # a per-character walk is quadratic here. Each iteration jumps to the next
  # quote / backslash / `#`, so the iteration count is the number of those
  # characters rather than the length of the text. Only the CUT OFFSET is
  # tracked; the text is sliced once, at the end.
  while [ -n "$rest" ]; do
    if [ -z "$q" ]; then
      chunk="${rest%%$GATE_CHUNK_STOP*}"
    elif [ "$q" = "$GATE_SQ" ]; then
      chunk="${rest%%$GATE_SQ*}"
    else
      chunk="${rest%%$GATE_CHUNK_STOP_DQ*}"
    fi
    [ "$chunk" = "$rest" ] && break
    if [ -n "$chunk" ]; then
      prev="${chunk#"${chunk%?}"}"
      pos=$((pos + ${#chunk}))
      rest="${rest#"$chunk"}"
    fi
    c="${rest%"${rest#?}"}"
    if [ -z "$q" ]; then
      case "$c" in
        # An escaped character outside quotes is LITERAL, `\#` included. The
        # slice is `${rest:2}` rather than `${rest#??}`: with ONE character left
        # the `##` form matches nothing, leaves `rest` unchanged, and the loop
        # never terminates.
        '\') pos=$((pos + 2)); rest="${rest:2}"; prev=x; continue ;;
        '#') case "$prev" in
               ' '|'	') GATE_COMMENT_CUT="${s:0:pos}"; return 0 ;;
             esac ;;
        '"') [ "$c" = "$iq" ] || q="$c" ;;
        *) [ "$c" = "$GATE_SQ" ] && { [ "$c" = "$iq" ] || q="$c"; } ;;
      esac
    else
      if [ "$c" = '\' ] && [ "$q" = '"' ]; then
        pos=$((pos + 2)); rest="${rest:2}"; prev=x; continue
      fi
      [ "$c" = "$q" ] && q=""
    fi
    prev="$c"
    pos=$((pos + 1))
    rest="${rest#?}"
  done
  GATE_COMMENT_CUT="$s"
  GATE_COMMENT_OPENQ="$q"
  [ -z "$q" ]
}

gate_strip_comment() {
  if _gate_comment_cut "$1" ""; then
    printf '%s' "$GATE_COMMENT_CUT"
    return 0
  fi
  _gate_comment_cut "$1" "$GATE_COMMENT_OPENQ"
  printf '%s' "$GATE_COMMENT_CUT"
  return 0
}

# gate_argv <text>
#
# The ARGV a shell would hand the command, one token per line: the SHELL's own
# words are dropped -- a comment and everything after it, a redirection and,
# when it is not glued, its target. Returns 1 having printed nothing when the
# text cannot be split into words at all (the `gate_tokens` truncation), so a
# caller can refuse rather than parse a fragment.
#
# WHY THIS IS A SEPARATE FUNCTION FROM `gate_tokens`, and why an option parse
# must call THIS one. A gate that reads an option grammar is reading ARGV -- the
# vector the command itself receives -- and a shell WORD is not an ARGUMENT.
# `2>/dev/null`, `>`, `/dev/null` and `# switch lane` are all words, and git
# never sees any of them. Measured against the gate that first parsed
# `gate_tokens` output directly, with a branch that existed locally:
#
#   git checkout <branch> 2>/dev/null      rc=0, want 2
#   git checkout <branch> >/dev/null 2>&1  rc=0, want 2
#   git checkout <branch> # switch lane    rc=0, want 2
#
# -- every one a command that really moves HEAD, waved through because the extra
# WORDS were counted as extra ARGUMENTS and the command therefore read as a file
# restore. Callers that genuinely want the shell's words (a `-C` scan, a heredoc
# probe) keep `gate_tokens`; callers that want git's argv use this.
#
# WHAT IT DOES NOT PROMISE, stated because an earlier revision's silence here is
# the defect round 4 fixed: a line printed by this function is a shell WORD that
# is not a redirection and not a comment. It is NOT a promise that the word
# reaches the command as the text printed. `$EMPTY` is printed and reaches the
# command as NOTHING; `{fd}>/dev/null` is printed and reaches it as nothing
# either. A caller that COUNTS these words, or compares one against a name, must
# put every word through `gate_word_is_literal` and refuse to relax its verdict
# on a word that fails -- which is exactly what `main-tree-branch-gate.sh` does
# with `parse_certain`. Enumerating more shell forms HERE is the losing move; it
# was tried three times.
#
# The comment strip is deliberately NOT in `gate_segments`: that splitter feeds
# every gate in this library, and widening it is a change to all of them. Here
# the effect is bounded to callers that asked for argv.
GATE_REDIR_TOKEN='^([0-9]*(>>|>[|]|>&|>|<<<|<<-|<<|<&|<)|&>>|&>)(.*)$'

gate_argv() {
  local words tok want_target=0 text
  # The comment goes FIRST, before the split, so an apostrophe inside one is
  # never weighed as a quote (see `gate_strip_comment`). That also makes the
  # in-loop `'#'*` arm this function used to carry unreachable, so it is gone
  # rather than left as a second spelling of the same rule.
  text=$(gate_strip_comment "$1")
  words=$(gate_tokens "$text") || return 1
  while IFS= read -r tok; do
    # `gate_tokens` never emits an empty token (its pattern needs one character
    # at least), so the single blank line a `printf` of empty output produces is
    # the only thing this skips.
    [ -n "$tok" ] || continue
    if [ "$want_target" -eq 1 ]; then
      # The spaced target of the redirection operator just seen (`> /dev/null`).
      # It is dropped WITHOUT asking `gate_word_is_literal`, deliberately: a
      # redirection target is never an argument whatever it expands to. An empty
      # expansion there makes bash refuse the command outright ("ambiguous
      # redirect"), and a multi-word one is the same error -- neither can put a
      # word into argv.
      want_target=0
      continue
    fi
    # A bare `&`. On the GATE's path this is dead -- `gate_segments_raw` has
    # already split on it -- and it is kept because a DIRECT caller (this
    # library's own suite, a future gate parsing a raw fragment) still meets it.
    # Labelled rather than removed so the next reader does not re-derive that.
    [ "$tok" = '&' ] && continue
    if [[ "$tok" =~ $GATE_REDIR_TOKEN ]]; then
      # `2>&1` and `>/dev/null` carry their target GLUED; a bare `>` or `2>`
      # takes the next word as its target.
      [ -n "${BASH_REMATCH[3]}" ] || want_target=1
      continue
    fi
    printf '%s\n' "$tok"
  done <<EOF
$words
EOF
  return 0
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
      *)
        # Flags that consume the following token; skip it so a value is never
        # mistaken for the verb. `_gate_is_value_flag` is the ONE copy of that
        # list, shared with `gate_dequote_structural` -- the two halves of this
        # file have already disagreed about exactly it once (go-to-k/cdkd#2027
        # review round 4: `-R` was a gh flag here and not in the trigger, so
        # `gh -R owner/repo pr merge 1 --squash` walked past every merge gate).
        if _gate_is_value_flag "$tok"; then
          if [[ "$rest" =~ ^[[:space:]]*$GATE_EMBEDDING_TOKEN([[:space:]]+(.*))?$ ]]; then
            rest="${BASH_REMATCH[4]}"
          elif [[ "$rest" =~ ^[[:space:]]*($GATE_PATH_TOKEN)([[:space:]]+(.*))?$ ]]; then
            rest="${BASH_REMATCH[4]}"
          fi
        else
          case "$tok" in
            -*) : ;;
            *) break ;;     # the verb: leading flags are over
          esac
        fi
        ;;
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
