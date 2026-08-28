#!/usr/bin/env bash
# gated-command-preamble-gate.sh
#
# PreToolUse hook. Blocks a Bash call that runs a SIDE-EFFECTING preamble in an
# earlier segment of the same call as a GATED command (`git commit`,
# `gh pr create`, `gh pr merge`).
#
# Why this is a hook rather than a sentence. A PreToolUse denial aborts the
# WHOLE call before any of it runs, so when the gate refuses, the preamble is
# silently discarded too. `.claude/skills/work-issues/references/gates-and-pr.md` section 6 has
# said so in prose for months, with three worked examples. It was violated
# twice in one run on 2026-08-25 by an agent that had read it:
#
#   mise exec -- markgate set docs && git add -A && git commit -F msg.txt
#     -> check-gate refused; BOTH `markgate set` calls were discarded, so the
#        retry hit the same refusal and read as "the marker will not stick".
#   cat > /tmp/commit-msg.txt <<'MSG' ... MSG && git commit -F /tmp/commit-msg.txt
#     -> refused; the file was never written, and the retry then failed with
#        `could not read log file ... No such file or directory`.
#
# The repo's own rule for this shape is `.claude/skills/work-issues/references/retro.md`
# section 10-b: when a rule is ALREADY in the text and gets violated anyway,
# that proves the sentence is not load-bearing, so escalate rather than restate.
#
# WHAT COUNTS as side-effecting here is narrower than "has an effect", and the
# discriminator is whether losing it is SILENT:
#
#   BLOCKED  `markgate set`      - you believe a marker is recorded; it is not.
#   BLOCKED  a write redirect    - you believe a file exists; a later `>>`
#                                  retry then appends to nothing and ships a
#                                  fragment (go-to-k/cdk-local#525 opened
#                                  carrying only its review section that way).
#   BLOCKED  `cp` / `mv`         - a restore that never ran leaves the tree
#                                  mid-probe, which reads as a real regression.
#   BLOCKED  interpreter one-liners (`python3 -c` / `node -e` / `perl -e` /
#            `ruby -e`, their clustered spellings like `perl -pi -e`, and the
#            stdin-script form `python3 - <<EOF`) ahead of a gated verb
#            (issue #2369). The code argument is a QUOTED span the stripper
#            removes, so the gate cannot see whether it writes -- and the
#            measured incident was exactly a `python3 -c` that rewrote the
#            gated command's own body file, discarded by a refusal, with the
#            retry re-presenting the same offending content and costing a
#            mis-diagnosis round (twice in one run, 2026-08-28). Treated as
#            an OPAQUE write conservatively: this family's stated trade is
#            that dropping too little leaves a loud, fixable false positive
#            while the alternative is the silent direction. Measured before
#            widening: ZERO shapes prescribed by this repo's skills/rules
#            combine an interpreter one-liner with a gated verb in one call,
#            so the false-refusal surface is ad-hoc behavior only, and the
#            remediation (split the calls) is the flow's own standing rule.
#            KNOWN LIMIT: `python3 script.py` (a script FILE that writes) is
#            not matched -- a filename is indistinguishable from any other
#            argument; the eval-flag and stdin forms are the incident
#            spellings and the ones agents actually write.
#
#   ALLOWED  `git add`           - loss is LOUD: the commit fails with
#                                  "nothing to commit", so nothing is believed.
#   ALLOWED  `cd <dir>`          - no effect to lose; SKILL.md section 6 requires
#                                  it on gated commands, so blocking it would
#                                  contradict the rule this gate enforces.
#   ALLOWED  reads               - `git status`, `grep`, `gh pr view`, ...
#
# KNOWN LIMIT: `eval "echo hi > /tmp/f" && git commit` is NOT caught -- the
# redirect lives inside a quoted span, which is exactly what the strip removes,
# and nothing can tell that string from data without running it. `bash -c "..."`
# IS caught, because the segmenter unwraps it. Recorded rather than chased:
# `eval` appears nowhere in this repo's agent flow.
#
# KNOWN LIMIT: two write spellings pass. `foo >& /tmp/f` (the bash-specific
# `>&word` form) falls in the class excluded after `>` so the fd-dup test can
# reject `2>&1`, and `foo >| /tmp/f` (noclobber override) is split by the
# segmenter on `|`. `&>` and `&>>` ARE caught. Recorded rather than fenced:
# both are rare, and widening the write test toward `&` risks the `2>&1` false
# positive that class exists to prevent.
#
# KNOWN LIMIT: the gated set is `git commit` / `gh pr create` / `gh pr merge`
# only -- three of the roughly eight verbs some hook in this repo can refuse.
# `git push` (branch-gate), `git merge` (integ-local-gate), `gh pr edit` and
# `gh issue create` (issue-dup-check-gate) can all be refused with a
# side-effecting preamble in the same call, and that preamble is then silently
# lost exactly as it is here. Recorded rather than widened, deliberately: this
# gate REFUSES, so every verb added is a new false-refusal surface on a very
# common call, and the three covered here are the ones the 2026-08-25 incident
# actually lost work to. Widen only with cases in BOTH directions per verb.
#
# Order matters: only segments BEFORE the gated command are considered. A write
# AFTER it (`gh pr merge ... > /tmp/out`) is that command's own output and is
# lost only if the command was refused anyway.

set -u

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# shellcheck source=lib/command-match.sh
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/command-match.sh"
# Fail CLOSED, matching every other gate in this directory.
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unreadable, so gated-command-preamble-gate cannot evaluate the command." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib"
# BOTH helpers AND the three constants below. `strip_noncommand_spans` became a
# hard dependency when the matching moved off raw text, and a truncated library
# defining one but not the other would strip every segment to EMPTY and the gate
# would exit 0 in silence -- a gate that stops gating with no sign it stopped.
#
# The CONSTANTS are the half a first cut of this guard missed, and they are the
# half that matters, because the library declares them AFTER both functions
# (`strip_noncommand_spans` and `gate_segments` sit hundreds of lines earlier).
# So the truncation this guard originally fenced -- one function without the
# other -- is the shape a tail truncation cannot produce, while the shape it CAN
# produce (both functions present, constants gone) went unchecked: `set -u` then
# aborts on the first `GATE_RE_*` read with rc=1, and per
# `.claude/rules/hooks.md` a non-2 exit propagates as a non-blocking error and
# turns a block into a PASS. `issue-dup-check-gate.sh` guards its constant
# alongside its `declare -F` checks; this now matches it.
#
# The INVARIANT this rests on, stated because it is not self-evident and a
# library reorder would break it silently: a truncation is a PREFIX cut, so
# guarding the highest-line symbol the hook needs covers every symbol below it.
# `GATE_RE_GH_PR_MERGE` is currently that symbol. Several others the hook
# reaches only INDIRECTLY sit between the two functions and the constants --
# `GATE_QUOTED_VALUE`, which `gate_strip_prefix` reads, is one -- and they are
# covered by that ordering rather than by any clause here. Move the constant
# block earlier in the library and this guard silently under-covers again.
if ! declare -F gate_segments >/dev/null 2>&1 ||
  ! declare -F strip_noncommand_spans >/dev/null 2>&1 ||
  [ -z "${GATE_RE_GIT_COMMIT:-}" ] ||
  [ -z "${GATE_RE_GH_PR_CREATE:-}" ] ||
  [ -z "${GATE_RE_GH_PR_MERGE:-}" ]; then
  echo "Blocked: .claude/hooks/lib/command-match.sh loaded but gate_segments / strip_noncommand_spans / GATE_RE_GIT_COMMIT / GATE_RE_GH_PR_CREATE / GATE_RE_GH_PR_MERGE is undefined or empty (truncated file?)." >&2
  exit 2
fi

GATED_RE="${GATE_RE_GIT_COMMIT}|${GATE_RE_GH_PR_CREATE}|${GATE_RE_GH_PR_MERGE}"

# A write redirect: `>` or `>>` that is NOT a file-descriptor duplication
# (`2>&1`, `>&2`). The `[0-9]?` allows `1>` / `2>` to a real path, which writes
# a file just as much as a bare `>` does.
#
# These are matched against the segment with QUOTED SPANS AND HEREDOC BODIES
# STRIPPED (`strip_noncommand_spans`), not against the raw text. Matching raw
# text reads DATA as a redirect, and in a TypeScript repo the data routinely
# contains one: `grep -n '=>' src/x.ts && git commit -m x` was refused, as were
# an `awk '$3 > 5'`, a `jq '.a > 1'` and a `--body "old > new"`. The hook's own
# header lists `grep` as allowed, so the raw form contradicted its contract.
WRITE_REDIRECT_RE='(^|[^0-9>&])[0-9]?>>?[[:space:]]*[^&>[:space:]]'
# `>/dev/null` and `2>/dev/null` write nothing that can be lost, and suppressing
# noise before a gated command is the commonest idiom in this repo -- including
# `markgate verify check >/dev/null 2>&1 && git commit`, which the header names
# as allowed.
# Discarding redirects are REMOVED before the write test rather than matched as
# a whole-segment shape. The shape form admitted exactly ONE of them: its tail
# class `([[:space:]]|$|[0-9>&])*` cannot contain `/`, so the second `/dev/null`
# in `markgate verify check >/dev/null 2>/dev/null && git commit` fell out of
# the exemption and the gate REFUSED a legitimate call (measured 2026-08-26).
# Stripping is count- and order-independent, so no future spelling re-opens it.
DEVNULL_REDIRECT_RE='[0-9]?>>?[[:space:]]*/dev/null([[:space:]]|$)'
# The right boundary is load bearing: without it `foo > /dev/nullx` and
# `foo >/dev/null.bak` -- real writes to real files -- stripped to nothing and
# passed. Stripping can DESTROY a write, not only reveal one.
# `2>&1`, `>&2`, `2>&-`: file-descriptor duplications, never a file write.
FD_DUP_RE='[0-9]?>&[0-9-]'
MARKGATE_SET_RE='(^|[[:space:]])markgate[[:space:]]+set([[:space:]]|$)'
# `sed -i` / `tee` / `touch` are the same SILENT-loss class as `cp` / `mv`: each
# leaves you believing a file was written or restored when it was not.
COPY_RE='^(cp|mv|tee|touch)([[:space:]]|$)|(^|[[:space:]])sed[[:space:]]+([^[:space:]]+[[:space:]]+)*(-[a-zA-Z]*i[^[:space:]]*|--in-place)([[:space:]]|=|$)'
# The `[^[:space:]]*` suffix and the leading option-cluster are both load
# bearing: `sed -i.bak` (the portable GNU+BSD spelling) and `sed -E -i ''`
# were missed without them.
# Interpreter one-liners (issue #2369; see the header entry). Two arms:
#   1. an eval-flag token -- a short-option cluster containing c/e/E
#      (`-c`, `-e`, `-pe`, `-pi -e`, `-0pi`) or the long `--eval` -- after
#      any number of other flag tokens;
#   2. the stdin-script form: a bare `-` argument (`python3 - <<'EOF'`),
#      where the heredoc body is the code and is already stripped.
# The cluster class deliberately matches MORE spellings than the canonical
# `-c`/`-e` (`node -pe`, `python3 -Bc`): every such invocation runs code the
# stripper removed, which is the opaque-write shape, and over-matching inside
# these four interpreter names costs a loud split-the-calls message at worst.
# The two arms anchor DIFFERENTLY, on purpose: the eval-flag arm allows a
# mid-segment position (`time python3 -c ...`), while the bare-`-` arm is
# segment-START only -- a lone `-` after a word is common as an ordinary
# argument (`grep python3 - <file>` reads stdin), so the loose anchor would
# read an interpreter NAME appearing as an argument as an invocation.
INTERPRETER_EVAL_RE='(^|[[:space:]])(python3?|node|perl|ruby)([[:space:]]+-[^[:space:]]+)*[[:space:]]+(-[a-zA-Z0-9]*[ceE][a-zA-Z0-9]*|--eval)([[:space:]]|$|<)'
INTERPRETER_STDIN_RE='^(python3?|node|perl|ruby)([[:space:]]+-[^[:space:]]+)*[[:space:]]+-([[:space:]]|$|<)'

# Newline-delimited rather than an array: this must run under macOS bash 3.2.
# TWO lists, deliberately. `preambles` is annotated for the diagnosis and
# `preambles_raw` holds the segments verbatim for the copy-pasteable `run:`
# lines. An earlier revision kept one list and re-parsed it with
# `sed 's/    <- .*$//'`, which truncates at the LEFTMOST match -- so a preamble
# whose own text contained `    <- ` came out mangled into an unrunnable
# command. That is the third time in this gate's short history that guidance
# broke when followed verbatim; not re-parsing at all is the fix that cannot
# recur, because the raw text is never encoded and decoded in the first place.
preambles=""
preambles_raw=""
while IFS= read -r segment; do
  # Quoted spans and heredoc bodies are DATA, never a redirect or a verb.
  stripped=$(strip_noncommand_spans "$segment")
  if [[ "$stripped" =~ $GATED_RE ]]; then
    # A gated command with nothing pending is fine; keep scanning rather than
    # exiting, so a preamble sitting BETWEEN two gated commands is still seen
    # (`gh pr create --fill && cp a b && git commit -m x` used to pass).
    if [ -z "$preambles_raw" ]; then
      continue
    fi
    cat >&2 <<EOF
Blocked by gated-command-preamble-gate: this call runs a side-effecting
preamble in the same Bash call as a GATED command.

$(printf '%s' "$preambles")
  gated command: $segment

A PreToolUse denial aborts the WHOLE call, so if the gate below refuses, the
preamble is discarded with it -- silently. You then retry believing the marker
was recorded / the file was written, and the second failure looks unrelated to
the first.

Split it into separate calls, running EACH preamble on its own first:

$(printf '%s' "$preambles_raw")
  then: $segment

Every preamble is listed, not just the last. An earlier revision printed only
the last one, so an agent following it verbatim would have skipped the others --
which is precisely the \`markgate set check && markgate set docs && git commit\`
incident this gate exists to prevent.

Reads (\`git status\`, \`grep\`, \`gh pr view\`) and \`cd <dir> &&\` are fine in the
same call -- there is nothing to lose. \`git add\` is fine too: losing it fails
the commit loudly rather than silently.

See .claude/skills/work-issues/references/gates-and-pr.md section 6.
EOF
    exit 2
  fi
  # Record EVERY side-effecting preamble seen before the gated command.
  kind=""
  if [[ "$stripped" =~ $MARKGATE_SET_RE ]]; then
    kind="marker write"
  elif [[ "$stripped" =~ $COPY_RE ]]; then
    kind="file copy/move/in-place edit"
  elif [[ "$stripped" =~ $INTERPRETER_EVAL_RE ]] || [[ "$stripped" =~ $INTERPRETER_STDIN_RE ]]; then
    kind="interpreter one-liner (opaque write)"
  else
    # Remove every discarding redirect, then ask whether a write redirect
    # survives. The ORDER of the two strips is inconsequential -- measured, and
    # stated because an earlier revision of this comment claimed fd-dups had to
    # go first "so `2>&1` cannot leave a bare `>`". A devnull match needs the
    # literal `/dev/null`, so it can only overlap an fd-dup's leading digit and
    # leaves `N>&`, which never matches the write test. Swapping them keeps the
    # suite green and no input distinguishes them.
    redirect_residue=$(printf '%s' "$stripped" | sed -E "s#${FD_DUP_RE}##g; s#${DEVNULL_REDIRECT_RE}##g")
    if [[ "$redirect_residue" =~ $WRITE_REDIRECT_RE ]]; then
      kind="file write"
    fi
  fi
  if [ -n "$kind" ]; then
    preambles="${preambles}  $segment    <- $kind
"
    preambles_raw="${preambles_raw}  run: $segment
"
  fi
done < <(gate_segments "$cmd")

exit 0
