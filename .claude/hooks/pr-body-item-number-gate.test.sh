#!/usr/bin/env bash
# Smoke test for pr-body-item-number-gate.sh.
#
# Mirrors branch-gate.test.sh structure: stdin JSON payload + exit
# code is the contract under test. Run from the repo root:
#
#   bash .claude/hooks/pr-body-item-number-gate.test.sh
#
# MUTATION-PROBED 2026-09-05 (49 cases): an always-`exit 0` stub fails 26 and
# an always-`exit 2` stub fails 23, so neither direction passes vacuously.
# Targeted mutants: the shared `$GW` value class reverted to the old
# `(["\x27]?)([^"\x27\s]+)\1` fails 4 (the three spaced-path cases plus the
# `--field body=@FILE` case, which the old class parsed differently); the
# short-flag separator `[=\s]*` back to `[=\s]+` fails exactly 1 (the glued
# `-Fbody=@<path>` case).

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pr-body-item-number-gate.sh"

# Per-run scratch dir; cleaned on EXIT.
TMPDIR_FIX="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_FIX"' EXIT

# bash 3.2 is NOT exercised on the HOOK by running THIS FILE under /bin/bash.
# The hook's shebang is `#!/usr/bin/env bash`, which resolves through PATH and
# finds whatever bash is first there -- Homebrew 5.x on a dev Mac -- so
# `/bin/bash <suite>` measured the SUITE under 3.2 and the SUBJECT under 5.x.
# `HOOK_BASH=/bin/bash` puts a `bash` shim first on PATH, so the shebang, the
# explicit `bash "$HOOK"` calls and any `bash` the hook itself spawns all run
# that interpreter instead. Run the suite BOTH ways; the tallies must match.
if [ -n "${HOOK_BASH:-}" ]; then
  # Resolved to an ABSOLUTE path first. `HOOK_BASH=bash` would otherwise make
  # `ln -sf bash <shim>/bash` a symlink pointing at ITSELF, and every hook
  # invocation would then die on ELOOP -- a suite-wide red with a cause nowhere
  # near the hook.
  HOOK_BASH_BIN="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")"
  case "$HOOK_BASH_BIN" in /*) ;; *) HOOK_BASH_BIN="$PWD/$HOOK_BASH_BIN" ;; esac
  HOOK_BASH_SHIM="$TMPDIR_FIX/bash32-shim"
  mkdir -p "$HOOK_BASH_SHIM"
  ln -sf "$HOOK_BASH_BIN" "$HOOK_BASH_SHIM/bash"
  PATH="$HOOK_BASH_SHIM:$PATH"
  export PATH
fi

write_file() {
  local name="$1"
  local content="$2"
  printf '%s' "$content" > "$TMPDIR_FIX/$name"
  echo "$TMPDIR_FIX/$name"
}

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <stdin_json>
run_case() {
  local name="$1"; local want="$2"; local payload="$3"
  local got out
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) || true
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  payload: $payload\n"
    fail_log+="  output : $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- Fixture body files ---

# A: bare-number item list (allowed).
A=$(write_file A.md "# Title

Must-fix 1: thing one
Must-fix 2: thing two
review-fix 3: another
")

# B: '#N' item-number patterns (blocked).
B=$(write_file B.md "# Title

Must-fix #1: thing one
review-fix #4: another
")

# C: mixed — has 'closes #234' (allowed) AND 'Must-fix #1' (blocked).
C=$(write_file C.md "# Title

closes #234
Must-fix #1: thing one
")

# D: 'review-fix #4' for the gh api PATCH path.
D=$(write_file D.md "# Title

review-fix #4: a thing
")

# E: blocked content but inside a fenced code block.
E=$(write_file E.md "# Title

Some prose.

\`\`\`
Must-fix #1
review-fix #4
\`\`\`

End of prose.
")

# F: parenthetical (#231) only — squash-merge style — allowed.
F=$(write_file F.md "# Title

Squashed from feat(...): subject (#231)
References: (#232) and closes #233
")

# G: URL containing /pull/4 — should not be flagged.
G=$(write_file G.md "# Title

See https://github.com/owner/repo/pull/4 for context.
And https://github.com/owner/repo/issues/99 too.
")

# H: bare '#N' in prose without an allowed prefix — blocked.
H=$(write_file H.md "# Title

This depends on the change in #4 to land first.
")

# I: code span with #N — should not be flagged.
I=$(write_file I.md "# Title

Use the literal token \`#1\` in your config.
")

# J: fully-qualified cross-repo refs, this repo and both siblings
# (allowed). This is the form /work-issues section 10-c mandates.
J=$(write_file J.md "# Title

Mirrored from go-to-k/cdk-local#533 and go-to-k/cdk-real-drift#1792.
Landed here as go-to-k/cdkd#1992.
The gate went inert (go-to-k/cdkd#1476) for that reason.
See [go-to-k/cdk-local#533] for the mirror.
")

# K: an item number written as a fraction (blocked). Pins that the
# owner/repo arm did not widen into the failure the gate exists for --
# 1/2 has no letter in either segment, so it is not a repo slug.
K=$(write_file K.md "# Title

step 1/2#3: the second half
")

# L: a code span sitting BETWEEN a slug-shaped token and the hit (blocked).
# Stripping the span must not close the gap and manufacture an adjacency the
# raw text never had -- GitHub renders every one of these as a live link.
# Found by the security review of go-to-k/cdkd#1992.
L=$(write_file L.md "# Title

Fixed the analyzer/resolver\`.ts\`#2 path.
Both cdk-local/cdk-real-drift\`(mirrored)\`#3 need it.
The lambda/vpc\`-deps\`#5 edge.
Item x/y\`the code\`#7 remains open.
")

# M: qualified cross-repo refs wrapped in markdown emphasis / quotes
# (allowed). A PR body writes a qualified ref bolded far more often than
# bare, and until 2026-08-29 the gate blocked exactly that while its own
# error message told the author to use the qualified form.
M=$(write_file M.md "# Title

- **go-to-k/cdkd#2367** — bolded, the shape that was blocked twice
- *go-to-k/cdk-local#533* — italic
- ~~go-to-k/cdk-real-drift#1792~~ — struck through
- _go-to-k/cdkd#2378_ — underscore emphasis
- \"go-to-k/cdkd#2374\" — double-quoted
|go-to-k/cdkd#2376|an unpadded table cell|
")

# N: the fraction item number, now wrapped in the same emphasis (blocked).
# Pins that widening the leading boundary did NOT widen the arm itself --
# 1/2 has no letter in either segment, bolded or not.
N=$(write_file N.md "# Title

**step 1/2#3**: the second half
*item 4/5#6*: and another
")

# --- ALLOW cases ---

# 1. PR create with bare-number body (A) → exit 0.
run_case "gh pr create with bare-numbers allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --title foo --body-file %s"}}' "$A")"

# 5. PR create with code-block #N (E) → exit 0.
run_case "gh pr create with #N inside code block allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$E")"

# 6. File doesn't exist → exit 0.
run_case "gh pr create with missing body file allowed (silent pass)" 0 \
  '{"tool_input":{"command":"gh pr create --body-file /tmp/does-not-exist-9999"}}'

# 7. Unrelated bash command → exit 0.
run_case "non-gh command allowed" 0 \
  '{"tool_input":{"command":"ls -la"}}'

# 8. Body with parenthetical (#231) only → exit 0.
run_case "gh pr create with parenthetical (#N) allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$F")"

# Extra: URL containing /pull/N → exit 0.
run_case "gh pr create with URL containing /pull/N allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$G")"

# Extra: code span `#1` → exit 0.
run_case "gh pr create with code-span #N allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$I")"

# Extra: gh pr create without --body-file (inline --body) → exit 0
# (the hook deliberately does not inspect inline bodies).
run_case "gh pr create with inline --body not inspected" 0 \
  '{"tool_input":{"command":"gh pr create --title foo --body \"Must-fix #1\""}}'

# Extra: gh other subcommand (e.g. gh pr view) → exit 0.
run_case "gh pr view not gated" 0 \
  '{"tool_input":{"command":"gh pr view 123"}}'

# Qualified cross-repo refs (owner/repo#N) are allowed -- go-to-k/cdkd#1992.
run_case "gh pr create with qualified owner/repo#N allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$J")"

# Emphasised / quoted qualified refs are allowed too (2026-08-29).
run_case "gh pr create with emphasised qualified owner/repo#N allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$M")"

# --- BLOCK cases ---

# 2. PR create with #N body (B) → exit 2.
run_case "gh pr create with #N item-numbers blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh pr create --title foo --body-file %s"}}' "$B")"

# 3. Mixed body (C): has both allowed `closes #234` and blocked
# `Must-fix #1` → exit 2 (only blocked entry surfaces).
run_case "gh pr create with mixed allowed+blocked → blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$C")"

# 4. gh api -X PATCH with --field "body=@<FILE>" form → exit 2.
run_case "gh api PATCH pulls with --field body=@FILE blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh api -X PATCH repos/owner/repo/pulls/123 --field \\"body=@%s\\""}}' "$D")"

# Extra: gh api PATCH with -F body=@<FILE> short form → exit 2.
run_case "gh api PATCH pulls with -F body=@FILE blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh api -X PATCH repos/owner/repo/pulls/123 -F body=@%s"}}' "$D")"

# Extra: gh issue create with #N body → exit 2.
run_case "gh issue create with #N body-file blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh issue create --title foo --body-file %s"}}' "$B")"

# Extra: gh issue comment with #N body → exit 2.
run_case "gh issue comment with #N body-file blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh issue comment 123 --body-file %s"}}' "$B")"

# Extra: bare '#N' in prose (no item-number prefix, no allow context) → exit 2.
run_case "gh pr create with bare #N in prose blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$H")"

# Extra: gh pr edit --body-file (deprecated form, but still possible) → exit 2.
# ...and the arm did not widen: a fraction-shaped item number stays blocked.
# A code span between a slug and the hit must not become an allow gadget.
run_case "gh pr create with code-span slug gadget still blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$L")"

run_case "gh pr create with fraction-shaped item number still blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$K")"

# ...and still blocked when wrapped in the emphasis the boundary now admits,
# which is what pins the 2026-08-29 widening to the BOUNDARY rather than the arm.
run_case "gh pr create with emphasised fraction-shaped item number still blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$N")"

run_case "gh pr edit with #N body-file blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh pr edit 123 --body-file %s"}}' "$B")"

# --- Command matching (issue #2129) -----------------------------------------
# The gate must see its verb wherever it sits in the command list, and must NOT
# fire on a quoted MENTION of it. Both directions, or the matcher is untested.
run_case "compound: git push && gh pr create with #N body-file blocked" 2 \
  "$(jq -cn --arg c "git push && gh pr create --body-file $B" '{tool_input:{command:$c}}')"
run_case "quoted mention of gh pr create allowed" 0 \
  "$(jq -cn --arg c "echo \"then gh pr create --body-file $B\"" '{tool_input:{command:$c}}')"

# --- go-to-k/cdkd#2397: the body file does not exist YET. The hook runs BEFORE
# the command, so in the one-call `heredoc -> file -> --body-file` shape the path
# is absent and the pre-fix `[[ ! -f "$f" ]] && continue` was a silent pass. Both
# sibling gates that hit this window already fall back to scanning the whole
# command; these pin the port. All four fail against the pre-#2397 hook, which
# exited 0 on every one.
ABSENT="$TMPDIR_FIX/never-written.md"
HEREDOC_BAD="cat > $ABSENT <<EOF
# Title

Must-fix #1: thing one
EOF
gh issue create --title t --body-file $ABSENT"
HEREDOC_OK="cat > $ABSENT <<EOF
# Title

Must-fix 1: thing one
EOF
gh issue create --title t --body-file $ABSENT"

run_case "one-call heredoc with #N in the body is blocked" 2 \
  "$(jq -cn --arg c "$HEREDOC_BAD" '{tool_input:{command:$c}}')"

# The false-BLOCK direction is what the siblings' comments warn about: this is
# the shape the rules PRESCRIBE, so a clean body written the same way must pass.
run_case "one-call heredoc with a clean body still passes" 0 \
  "$(jq -cn --arg c "$HEREDOC_OK" '{tool_input:{command:$c}}')"

# --- The other half of the same window: the path EXISTS, holding the PREVIOUS
# body, while the command rewrites it. Reading the file alone judges text nobody
# is submitting -- and does so while looking like a working gate, which is worse
# than the absent case.
STALE=$(write_file stale.md "# Title

Must-fix 1: clean
")
STALE_REWRITE="cat > $STALE <<EOF
# Title

Must-fix #7: rewritten
EOF
gh issue create --title t --body-file $STALE"
run_case "a stale body file is not trusted when the command rewrites it" 2 \
  "$(jq -cn --arg c "$STALE_REWRITE" '{tool_input:{command:$c}}')"

# The control that keeps the case above honest: the same clean file, NOT
# rewritten by the command, must still pass. Without it that case would also be
# satisfied by a hook that blocked whenever a body file was named at all.
run_case "a clean body file the command does not rewrite still passes" 0 \
  "$(jq -cn --arg c "gh issue create --title t --body-file $STALE" '{tool_input:{command:$c}}')"

# --- The CONTROLS for the fallback. The first attempt at go-to-k/cdkd#2397
# scanned the WHOLE COMMAND when the body file could not be read, copying
# `issue-dup-check-gate.sh`. That is safe for THAT gate and not for this one:
# it needs one anchored marker to be PRESENT, so extra text can only make it
# pass, while this gate objects to content it FINDS, so extra text makes it
# BLOCK. Both of these are ordinary commands and both went from 0 to 2 under
# that draft. They are what stops anyone reintroducing it.
run_case "an item number in the TITLE does not block an absent body file" 0 \
  "$(jq -cn --arg c "gh issue create --title 'follow-up to #2397 discussion' --body-file $ABSENT" '{tool_input:{command:$c}}')"

run_case "an item number in an earlier commit message does not block" 0 \
  "$(jq -cn --arg c "git commit -m 'address review #3' && gh pr create --body-file $ABSENT" '{tool_input:{command:$c}}')"

# --- The stale-file polarity the existing case does NOT cover. Above, a CLEAN
# file is rewritten by an OFFENDING heredoc and must block. Here the file on
# disk is the offending one and the heredoc replaces it with a clean body: the
# text being submitted is clean, so the gate must pass. A hook that reads the
# file whenever it exists blocks a body whose offending line the author cannot
# find, because it is not in what they are submitting.
STALE_BAD=$(write_file stale-bad.md "# Title

Must-fix #9: the PREVIOUS body
")
STALE_BAD_CLEANED="cat > $STALE_BAD <<EOF
# Title

Must-fix 9: the body actually being submitted
EOF
gh issue create --title t --body-file $STALE_BAD"
run_case "a stale OFFENDING file cleaned by the heredoc passes" 0 \
  "$(jq -cn --arg c "$STALE_BAD_CLEANED" '{tool_input:{command:$c}}')"

# --- The TIGHT redirect spelling. `cat >f<<EOF` with no spaces is the same
# shape as the case above and is what a terminator class of `(?:\s|$)` alone
# missed: the character after the path is `<`, not whitespace, so neither
# `cmd_writes_path` nor `heredoc_body_for` matched and the body went unscanned
# while the command still submitted it.
TIGHT_BAD="cat >$ABSENT<<EOF
# Title

Must-fix #2: written by a tight redirect
EOF
gh issue create --title t --body-file $ABSENT"
run_case "the tight >f<<EOF redirect is still extracted and blocked" 2 \
  "$(jq -cn --arg c "$TIGHT_BAD" '{tool_input:{command:$c}}')"

# --- KNOWN LIMIT, asserted in BOTH directions rather than left to be
# rediscovered. The extraction reads HEREDOC bodies; a one-call body written by
# anything else (`printf > f`, `python3 -c ... > f`) cannot be extracted.
#
#   path ABSENT  -> there is nothing to read at all, so the offending body
#                   passes. This is the gap, and pinning it is what stops it
#                   widening silently.
#   path EXISTS  -> the scan falls back to the FILE, so the same shape still
#                   blocks. That fallback is not decoration: a first revision
#                   skipped whenever no heredoc body was found, which made the
#                   gate WEAKER than the code it replaced.
PRINTF_ABSENT="printf '%s\\n' 'Must-fix #5: printf-written' > $ABSENT
gh issue create --title t --body-file $ABSENT"
run_case "known limit: a printf-written body at an ABSENT path is not extracted" 0 \
  "$(jq -cn --arg c "$PRINTF_ABSENT" '{tool_input:{command:$c}}')"

PRINTF_EXISTING="printf '%s\\n' 'Must-fix #5: printf-written' > $B
gh issue create --title t --body-file $B"
run_case "...but an EXISTING file is still read when printf rewrites it" 2 \
  "$(jq -cn --arg c "$PRINTF_EXISTING" '{tool_input:{command:$c}}')"

# --- An APPEND is NOT a rewrite, and treating it as one made this gate weaker
# than the code it replaced. `>>` / `tee -a` leave what is on disk in place: it
# is the FIRST HALF of the body being submitted, not a superseded copy. The
# first fix scanned the heredoc chunk INSTEAD of the file and the offender on
# disk went unread -- rc=0 where both the pre-#2397 hook and the first fix
# answered rc=2.
APPEND_BAD=$(write_file append-bad.md "# Title

Must-fix #8: already on disk
")
APPEND_OVER_BAD="cat >> $APPEND_BAD <<EOF
Must-fix 8: the appended half is clean
EOF
gh pr create --body-file $APPEND_BAD"
run_case "an append does not excuse the offending content already on disk" 2 \
  "$(jq -cn --arg c "$APPEND_OVER_BAD" '{tool_input:{command:$c}}')"

# The control that keeps it honest: a clean append over a clean file passes, so
# the case above is not satisfied by a hook that blocks on any append.
APPEND_OK=$(write_file append-ok.md "# Title

Must-fix 8: clean on disk
")
APPEND_OVER_OK="cat >> $APPEND_OK <<EOF
Must-fix 9: and clean appended
EOF
gh pr create --body-file $APPEND_OK"
run_case "a clean append over a clean file still passes" 0 \
  "$(jq -cn --arg c "$APPEND_OVER_OK" '{tool_input:{command:$c}}')"

# --- EVERY heredoc writing the path is extracted, not just the first. One
# command can write a body in two chunks, and stopping at the first left the
# second -- just as much of what is submitted -- unscanned.
TWO_CHUNKS="cat > $ABSENT <<A
# Title
A
cat >> $ABSENT <<B
Must-fix #6: in the SECOND chunk
B
gh issue create --title t --body-file $ABSENT"
run_case "an offender in the SECOND heredoc chunk is still found" 2 \
  "$(jq -cn --arg c "$TWO_CHUNKS" '{tool_input:{command:$c}}')"

TWO_CHUNKS_OK="cat > $ABSENT <<A
# Title
A
cat >> $ABSENT <<B
Must-fix 6: in the second chunk
B
gh issue create --title t --body-file $ABSENT"
run_case "...and two clean chunks still pass" 0 \
  "$(jq -cn --arg c "$TWO_CHUNKS_OK" '{tool_input:{command:$c}}')"

# --- An EMPTY heredoc body is legal, and is not the same thing as "no heredoc".
# Inferring the latter from empty OUTPUT made an empty heredoc REWRITING an
# offending file fall through to the stale file and FALSE-BLOCK, quoting a line
# that will not exist -- the unclearable block this whole change exists to end.
EMPTY_OVER_BAD=$(write_file empty-over-bad.md "# Title

Must-fix #9: the PREVIOUS body
")
EMPTY_REWRITE="cat > $EMPTY_OVER_BAD <<EOF
EOF
gh issue create --title t --body-file $EMPTY_OVER_BAD"
run_case "an EMPTY heredoc rewriting an offending file does not false-block" 0 \
  "$(jq -cn --arg c "$EMPTY_REWRITE" '{tool_input:{command:$c}}')"

# --- The other two widened terminator characters. Only `>f<<EOF` had a case, so
# narrowing the class back to `[\s<]` left the suite green for `>f;` and `>f&&`.
SEMI_BAD="cat <<EOF >$ABSENT; gh issue create --title t --body-file $ABSENT
# Title

Must-fix #3: semicolon right after the redirect
EOF"
run_case "the >f; redirect spelling is still extracted and blocked" 2 \
  "$(jq -cn --arg c "$SEMI_BAD" '{tool_input:{command:$c}}')"

AND_BAD="cat <<EOF >$ABSENT&& gh issue create --title t --body-file $ABSENT
# Title

Must-fix #4: && right after the redirect
EOF"
run_case "the >f&& redirect spelling is still extracted and blocked" 2 \
  "$(jq -cn --arg c "$AND_BAD" '{tool_input:{command:$c}}')"

# --- HEREDOC TERMINATOR MATCHING follows bash, not intuition, and both halves
# are load-bearing. The twin `gh-body-english-gate.test.sh` has carried these
# two and this suite had none, while both hooks advertise the extraction as
# deliberately identical -- so only the twin that HAS the case could detect a
# regression in the line they share.
#
# A plain `<<` needs the delimiter ALONE on its line, so an indented `  EOF`
# sitting INSIDE the body is body text. Stripping leading whitespace before the
# compare ends the extraction there and leaves everything after it unscanned
# while bash still submits it -- a silent miss, the direction a gate must not
# fail in.
INDENTED="$TMPDIR_FIX/indented-eof.md"
INDENTED_BAD="cat > $INDENTED <<EOF
# Title

  EOF

Must-fix #7: after an indented terminator
EOF
gh issue create --title t --body-file $INDENTED"
run_case "an indented EOF inside a plain << body does not end the extraction" 2 \
  "$(jq -cn --arg c "$INDENTED_BAD" '{tool_input:{command:$c}}')"

# ...and the converse: `<<-` DOES accept a TAB-indented terminator, so the body
# ends there and what follows is not part of what is being published. Without
# the tab strip the extraction runs on and swallows that text, blocking a body
# that is clean.
DASHED="$TMPDIR_FIX/dashed-eof.md"
DASHED_OK="cat > $DASHED <<-EOF
	Must-fix 1: clean body
	EOF
gh issue create --title t --body-file $DASHED && echo 'see #12'"
run_case "a tab-indented terminator DOES end a <<- body" 0 \
  "$(jq -cn --arg c "$DASHED_OK" '{tool_input:{command:$c}}')"

# ...and the STRIP IS TABS ONLY, which neither suite pinned. `<<-` removes
# leading TABS and nothing else, so a SPACE-indented delimiter is still body
# text. Widening the strip to `\s` ends the extraction at that line and leaves
# the rest of the submitted body unscanned. Measured through the real hooks with
# `s/^\t+//` widened to `s/^\s+//`: rc 2 -> rc 0 in both this gate and
# gh-body-english-gate, and every other case in both suites stayed green.
SPACED="$TMPDIR_FIX/spaced-eof.md"
SPACED_BAD="cat > $SPACED <<-EOF
	# Title
    EOF

Must-fix #8: after a SPACE-indented terminator
	EOF
gh issue create --title t --body-file $SPACED"
run_case "a SPACE-indented terminator does NOT end a <<- body" 2 \
  "$(jq -cn --arg c "$SPACED_BAD" '{tool_input:{command:$c}}')"


# --- the quoted-value holes (2026-09-05) --------------------------------
# The FIFTH site of one root cause (gh-body-english / issue-dup-check /
# issue-deferral-criteria / issue-classification-label are the others). The old
# value class `(["\x27]?)([^"\x27\s]+)\1` cannot span a QUOTED PATH
# CONTAINING A SPACE and requires a separator before a short flag's value, so
# nothing was extracted and NO BODY WAS SCANNED — the fail-open direction for
# this gate. Every blocking case below is rc=0 against the pre-fix hook while
# its plain-spelling twin gives 2.
PBIN_SPACEDIR="$TMPDIR_FIX/dir with space"
mkdir -p "$PBIN_SPACEDIR"
printf 'Review fixes:\n\n- item #4 was addressed\n' > "$PBIN_SPACEDIR/bad.md"
printf 'Review fixes:\n\nAll clean, closes #12\n' > "$PBIN_SPACEDIR/ok.md"
run_case "spaced --body-file path, double-quoted, blocks" 2 \
  "$(jq -cn --arg c "gh pr create --title t --body-file \"$PBIN_SPACEDIR/bad.md\"" '{tool_input:{command:$c}}')"
run_case "spaced --body-file path, single-quoted, blocks" 2 \
  "$(jq -cn --arg c "gh pr create --title t --body-file '$PBIN_SPACEDIR/bad.md'" '{tool_input:{command:$c}}')"
run_case "spaced -F body=@<path> blocks" 2 \
  "$(jq -cn --arg c "gh api -X PATCH repos/o/r/pulls/1 -F \"body=@$PBIN_SPACEDIR/bad.md\"" '{tool_input:{command:$c}}')"
printf 'Review fixes:\n\n- item #4 was addressed\n' > "$TMPDIR_FIX/pbin-bad.md"
run_case "glued -Fbody=@<path> blocks" 2 \
  "$(jq -cn --arg c "gh api -X PATCH repos/o/r/pulls/1 -Fbody=@$TMPDIR_FIX/pbin-bad.md" '{tool_input:{command:$c}}')"
# The polarity control: the same spelling with an allow-listed body must pass,
# so the blocks above are not satisfied by "any spaced path blocks".
run_case "spaced --body-file path, allow-listed body, passes" 0 \
  "$(jq -cn --arg c "gh pr create --title t --body-file \"$PBIN_SPACEDIR/ok.md\"" '{tool_input:{command:$c}}')"

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
