#!/usr/bin/env bash
# Smoke tests for issue-dup-check-gate.sh
#
# The gate blocks `gh issue create` unless the body carries a `Dup-check:`
# line. Asserts, in both directions:
#   - PASS  when a --body-file / -F body=@ / inline --body carries the marker
#   - BLOCK when it does not, including when the named body file is unreadable
#   - PASS  for the verbs that are deliberately NOT gated (edit / comment),
#           which is the whole point: folding into an existing issue must stay
#           cheaper than minting a new one
#   - BLOCK for chained and `-R` / `cd` spellings, which is where the
#           line-start-anchored ancestors of this gate family leaked
#   - PASS  for a command that merely QUOTES the trigger (the mandated
#           cdkd#563 false-positive cases)
#   - PASS  in a repo that never opted in (no `.markgate.yml`), which is
#           issue #1259's scoping applied to the issue surface
#   - PASS  for a QUOTED `--body-file` path CONTAINING A SPACE whose body
#           carries the marker, and for the GLUED `-F<path>` spelling. This
#           gate was ACCIDENTALLY SAFE against the extraction bug that
#           fail-opens its two siblings: with no path extracted the loop body
#           never runs, `seg_has_marker` returns 1, and the gate BLOCKS -- so
#           the miss surfaced as a FALSE BLOCK on a compliant body. The
#           positive cases are the ones that go red against the pre-fix hook.
#
# MUTATION-PROBED rather than asserted, EVERY number re-taken on the 60-case
# suite after the review round that added the load-guard fence -- not carried
# forward. (An earlier header quoted 11 / 18 from a ~29-case suite; both were
# long stale, which is why this is re-taken wholesale each round.)
#
#   always-`exit 0` stub                  fails 29   (nothing passes vacuously)
#   always-`exit 2` stub                  fails 34   (nor blocks vacuously)
#   `$GW` -> the retired class (below)    fails 21
#   `gate_perl_word_ok` -> always true    fails  0   -- and that ZERO is the
#                                                      finding, not a gap. This
#                                                      gate fails CLOSED on an
#                                                      unreadable body (see the
#                                                      note above), so a broken
#                                                      prelude lands on the same
#                                                      refusal by accident. The
#                                                      guard is still wired here,
#                                                      because relying on that
#                                                      coincidence is what made
#                                                      this file's original bug
#                                                      invisible for a year.
#   short-flag `[=\s]*` -> `[=\s]+`        fails  1   -- the GLUED spellings
#                                                      (`-F<path>`), fenced apart
#                                                      from the quoting fix
#
# THE `$GW` REVERT NUMBER DEPENDS ON THE SPELLING, so the spelling is stated
# rather than the intent. A review measured three faithful-looking reverts of
# the same idea and got three different tallies, because the retired class
# CAPTURED (`(["\x27]?)([^"\x27\s]+)\1`) while call sites now write `($GW)` --
# any capture inside the prelude shifts `$1` everywhere. The number below is
# for exactly this one-line prelude edit, which is backref-free and so
# reproducible:
#
#     my $GW = qr/["\x27]?[^"\x27\s]+["\x27]?/;
#
#   short-flag `[=\s]*` -> `[=\s]+`       fails  1   -- exactly the glued
#                                                      `-F<path>` case

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/issue-dup-check-gate.sh"
PASS=0
FAIL=0
# Two fixture trees, because the gate is repo-opt-in (issue #1259's scoping):
#   $TMPROOT  -- a git repo carrying `.markgate.yml`, so the gate fires
#   $NOOPTIN  -- a git repo without it, so the gate must stay silent
# Real repos rather than mocks: the opt-in decision is exactly what
# `git rev-parse --show-toplevel` reports, so mocking it would test nothing.
TMPBASE=$(mktemp -d)

# `HOOK_BASH=/bin/bash` runs the HOOK under that interpreter too, not just this
# suite. Without it, `/bin/bash <suite>` measures the SUITE under 3.2 while the
# subject keeps running whatever `bash` the shebang finds first on PATH --
# Homebrew 5.x on a dev Mac -- so a 3.2 run reported a pass the hook never
# earned. This gate gained new code in this change and had NO such run.
#
# The path is resolved ABSOLUTE first: `HOOK_BASH=bash` would make
# `ln -sf bash <shim>/bash` point at itself, and every hook invocation would
# then die on ELOOP -- a suite-wide red with a cause nowhere near the hook.
if [ -n "${HOOK_BASH:-}" ]; then
  HOOK_BASH_BIN="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")"
  case "$HOOK_BASH_BIN" in /*) ;; *) HOOK_BASH_BIN="$PWD/$HOOK_BASH_BIN" ;; esac
  HOOK_BASH_SHIM="$TMPBASE/bash32-shim"
  mkdir -p "$HOOK_BASH_SHIM"
  ln -sf "$HOOK_BASH_BIN" "$HOOK_BASH_SHIM/bash"
  PATH="$HOOK_BASH_SHIM:$PATH"
  export PATH
fi
trap 'rm -rf "$TMPBASE"' EXIT
TMPROOT="$TMPBASE/optin"
NOOPTIN="$TMPBASE/no-optin"
for d in "$TMPROOT" "$NOOPTIN"; do
  mkdir -p "$d"
  git -C "$d" init -q 2>/dev/null
done
printf 'gates: {}\n' > "$TMPROOT/.markgate.yml"

# run_msg <name> <command> <cwd> <expected-exit> <substring the stderr must carry>
# Both refusal arms exit 2, so the exit code alone cannot tell them apart --
# deleting one arm's message left the suite green until this was added.
run_msg() {
  local name="$1" command="$2" cwd="$3" expect="$4" needle="$5"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ] && printf '%s' "$out" | grep -qF "$needle"; then
    echo "PASS: $name (exit $rc, message matched)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect carrying '"'"'$needle'"'"')"
    printf '%s\n' "$out" | sed 's/^/      /' | head -4
    FAIL=$((FAIL + 1))
  fi
}

# run <name> <command> <cwd> <expected-exit>
run() {
  local name="$1" command="$2" cwd="$3" expect="$4"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then
    echo "PASS: $name (exit $rc)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect)"
    echo "$out" | sed 's/^/      /' | head -5
    FAIL=$((FAIL + 1))
  fi
}

# run_nonbash <name> <expected-exit>
run_nonbash() {
  local payload out rc
  payload=$(jq -n '{tool_name:"Edit", tool_input:{file_path:"/tmp/x"}}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$2" ]; then echo "PASS: $1 (exit $rc)"; PASS=$((PASS + 1))
  else echo "FAIL: $1 (exit $rc, expected $2)"; FAIL=$((FAIL + 1)); fi
}

WITH="$TMPROOT/with.md"
WITHOUT="$TMPROOT/without.md"
LIST="$TMPROOT/list.md"
LOWER="$TMPROOT/lower.md"
printf 'Some defect.\n\nDup-check: searched open issues for `observedProperties` -- none covers this root cause\n' > "$WITH"
printf 'Some defect.\n\nSession-fit: next (not this session) -- needs a new fixture\n' > "$WITHOUT"
printf 'Some defect.\n\n- Dup-check: searched open issues for `maskDeep` -- none covers this\n' > "$LIST"
printf 'Some defect.\n\ndup-check: searched open issues -- none covers this root cause\n' > "$LOWER"
MIDLINE="$TMPROOT/midline.md"
PLUSLIST="$TMPROOT/plus.md"
COMMITMSG="$TMPBASE/commit-msg.txt"
# The marker only mid-sentence. This is what fences MARKER_RE_LINE's ANCHOR:
# with the anchor swapped for the loose form the suite was 29/29 green, so the
# split the header calls load-bearing had no discriminating case at all.
printf 'Some defect.\n\nWe ran a dup-check: nothing turned up, honest.\n' > "$MIDLINE"
printf 'Some defect.\n\n+ Dup-Check: searched open issues -- none covers this\n' > "$PLUSLIST"
# A commit message that QUOTES the marker, which is the realistic shape: the
# commit introducing this gate carries `Dup-check:` in its own body.
# The marker at LINE START, which is the realistic shape -- a commit message
# quoting the line it requires. Mid-sentence would make this fixture pass for
# the WRONG reason: MARKER_RE_LINE's anchor rejects it regardless of scoping,
# so the case would stay green with the scoping removed and fence nothing.
printf 'chore: add the gate\n\nThe body must carry a line of this form:\n\nDup-check: searched open issues -- none covers this root cause\n' > "$COMMITMSG"

# --- the two directions, file-borne -----------------------------------------
run "body-file carries Dup-check"        "gh issue create --title t --body-file $WITH"    "$TMPROOT" 0
run "body-file lacks Dup-check"          "gh issue create --title t --body-file $WITHOUT" "$TMPROOT" 2
run "marker as a list item"              "gh issue create --title t --body-file $LIST"    "$TMPROOT" 0
run "marker lowercased"                  "gh issue create --title t --body-file $LOWER"   "$TMPROOT" 0
run "-F body=@ form carries marker"      "gh issue create -F body=@$WITH"                 "$TMPROOT" 0
run "-F body=@ form lacks marker"        "gh issue create -F body=@$WITHOUT"              "$TMPROOT" 2
run "bare -F <file> carries marker"      "gh issue create -F $WITH"                       "$TMPROOT" 0

# An unreadable body file must BLOCK, not pass. This is the fail-open shape
# that made twelve sibling gates inert (go-to-k/cdkd#2027): "cannot read" was
# being treated as "nothing to object to".
run "body-file path does not exist"      "gh issue create --body-file $TMPROOT/nope.md"   "$TMPROOT" 2

# Relative --body-file resolves against the payload cwd, and against a `cd` in
# command position before the verb.
run "relative body-file via payload cwd" "gh issue create --body-file with.md"                     "$TMPROOT" 0
run "relative body-file via leading cd"  "cd $TMPROOT && gh issue create --body-file with.md"      "/"        0
run "relative body-file, cd, no marker"  "cd $TMPROOT && gh issue create --body-file without.md"   "/"        2

# --- the two directions, inline ---------------------------------------------
run "inline --body carries marker"       "gh issue create --title t --body 'Bug. Dup-check: searched open issues -- none covers this'" "$TMPROOT" 0
run "inline --body lacks marker"         "gh issue create --title t --body 'Bug. Nothing else.'"                                       "$TMPROOT" 2

# --- verbs deliberately NOT gated -------------------------------------------
# Folding a finding into an existing issue is the outcome the gate steers
# toward, so these must never be taxed.
run "gh issue edit passes"               "gh issue edit 12 --body-file $WITHOUT"          "$TMPROOT" 0
run "gh issue comment passes"            "gh issue comment 12 --body-file $WITHOUT"       "$TMPROOT" 0
run "gh pr create passes"                "gh pr create --body-file $WITHOUT"              "$TMPROOT" 0
run "gh issue list passes"               "gh issue list --state open --search foo"        "$TMPROOT" 0

# --- spellings the line-start-anchored ancestors leaked ---------------------
run "chained after && blocks"            "git push && gh issue create --body-file $WITHOUT" "$TMPROOT" 2
run "chained after ; blocks"             "echo done; gh issue create --body-file $WITHOUT"  "$TMPROOT" 2
run "gh -R <repo> issue create blocks"   "gh -R go-to-k/cdkd issue create --body-file $WITHOUT" "$TMPROOT" 2
run "gh -R <repo> with marker passes"    "gh -R go-to-k/cdkd issue create --body-file $WITH"    "$TMPROOT" 0
run "subshell blocks"                    "(gh issue create --body-file $WITHOUT)"           "$TMPROOT" 2
run "command substitution blocks"        "URL=\$(gh issue create --body-file $WITHOUT)"     "$TMPROOT" 2

# --- mandated quoted-body false-positive cases (cdkd#563) -------------------
# A command that merely NAMES the trigger must not fire the gate.
run "quoted mention in commit message"   "git commit -m 'docs: explain gh issue create --body-file flow'" "$TMPROOT" 0
run "quoted mention in echo"             "echo 'run: gh issue create --body-file x.md'"                   "$TMPROOT" 0

# --- repo opt-in scope (issue #1259) ----------------------------------------
# A repo that never opted in must not inherit this repo's filing discipline --
# the 2026-07-27 shape, where a main-tree hook refused a user-requested edit in
# a personal repo. The control directly above it is what keeps this from
# passing because the gate is simply broken.
run "no .markgate.yml: not gated"        "gh issue create --body-file $NOOPTIN/x.md"       "$NOOPTIN" 0
run "outside any git repo: not gated"    "gh issue create --body-file $TMPBASE/x.md"       "$TMPBASE" 0
run "-R sibling from an opted-in cwd"    "gh -R go-to-k/cdk-local issue create --body-file $WITHOUT" "$TMPROOT" 2

# --- the marker must be a LINE in a body file, not a passing mention --------
run "body-file marker only mid-sentence" "gh issue create --body-file $MIDLINE"  "$TMPROOT" 2
run "+ list prefix and odd caps accepted" "gh issue create --body-file $PLUSLIST" "$TMPROOT" 0

# --- the scans are scoped to the gh SEGMENT --------------------------------
# `-F` is `git commit`'s flag as well as gh's short `--body-file`, so an
# unscoped extraction read the COMMIT MESSAGE and found the marker there. Both
# orderings, because scoping only "after the verb" fixes just one of them.
run "commit -F before, gh after"  "git commit -F $COMMITMSG && gh issue create --body-file $WITHOUT" "$TMPROOT" 2
run "gh before, commit -F after"  "gh issue create --body-file $WITHOUT && git commit -F $COMMITMSG" "$TMPROOT" 2
run "grep -F pattern is not a body" "grep -F dup-check: $COMMITMSG && gh issue create --body-file $WITHOUT" "$TMPROOT" 2

# --- the opt-in `cd` must survive an EARLIER gh ----------------------------
# `cmd_last_cd_target` breaks at the verb it is given, so passing a bare `gh`
# made it stop at the first gh segment and miss the `cd`. That is exactly the
# search-then-file chain this gate's own message prescribes.
run "search, cd, then file (no marker)" "gh issue list --state open --search x && cd $TMPROOT && gh issue create --body-file without.md" "$TMPBASE" 2
run "search, cd, then file (marker)"    "gh issue list --state open --search x && cd $TMPROOT && gh issue create --body-file with.md"    "$TMPBASE" 0

# --- the REST mint --------------------------------------------------------
run "gh api issues POST, no marker" "gh api repos/go-to-k/cdkd/issues -f title=t -f body=x"                  "$TMPROOT" 2
run "gh api issues POST, marker"    "gh api repos/go-to-k/cdkd/issues -f title=t -f 'body=x Dup-check: none'" "$TMPROOT" 0
run "gh api comments is not a mint" "gh api repos/go-to-k/cdkd/issues/5/comments -f body=x"                   "$TMPROOT" 0
run "gh api issue edit is not a mint" "gh api -X PATCH repos/go-to-k/cdkd/issues/5 -f body=x"                 "$TMPROOT" 0

# --- more body-file spellings ----------------------------------------------
run "--body-file=<p> form"          "gh issue create --body-file=$WITH"        "$TMPROOT" 0
run "--body-file=<p> without"       "gh issue create --body-file=$WITHOUT"     "$TMPROOT" 2
run "quoted --body-file path"       "gh issue create --body-file \"$WITHOUT\"" "$TMPROOT" 2
run "--field body=@ without"        "gh issue create --field body=@$WITHOUT"   "$TMPROOT" 2
run "--raw-field body=@ with"       "gh issue create --raw-field body=@$WITH"  "$TMPROOT" 0

# --- both refusal arms carry their own message ------------------------------
run_msg "missing-marker message"    "gh issue create --body-file $WITHOUT" "$TMPROOT" 2 "carries no"
run_msg "unreadable-path message"   "gh issue create --body-file $TMPROOT/nope.md" "$TMPROOT" 2 "No readable --body-file"
# An unexpanded variable is refused through its OWN arm: a bare "check the path"
# is unclearable when the file does carry the line (issue #2027's shape, as a
# false BLOCK rather than a false pass).
run_msg "unexpanded \$VAR message"  "gh issue create --body-file \"\$BODY\"" "$TMPROOT" 2 "unexpanded variable"

# --- the library guard must FAIL CLOSED ------------------------------------
# Swapping the whole guard for `. lib || exit 0` left the suite 29/29 green.
lib_fail_closed() {
  local tmp out rc
  tmp=$(mktemp -d)
  cp "$HOOK" "$tmp/gate.sh"          # no lib/ beside it
  chmod +x "$tmp/gate.sh"
  out=$(jq -n '{tool_name:"Bash", tool_input:{command:"gh issue create --body-file /nope.md"}, cwd:"/"}' \
        | "$tmp/gate.sh" 2>&1) && rc=0 || rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qF "command-match.sh"; then
    echo "PASS: unloadable library fails CLOSED (exit $rc)"; PASS=$((PASS + 1))
  else
    echo "FAIL: unloadable library should exit 2 naming the library (got $rc)"; FAIL=$((FAIL + 1))
  fi
}
lib_fail_closed

# --- the hook is actually REGISTERED ---------------------------------------
# The suite invokes the hook directly, so it would not otherwise notice the
# hook being dropped from .claude/settings.json.
registration_check() {
  local settings
  settings="$(cd "$(dirname "$0")/../.." && pwd)/.claude/settings.json"
  if [ -f "$settings" ] && grep -q 'issue-dup-check-gate.sh' "$settings"; then
    echo "PASS: registered in .claude/settings.json"; PASS=$((PASS + 1))
  else
    echo "FAIL: not registered in .claude/settings.json"; FAIL=$((FAIL + 1))
  fi
}
registration_check

# --- heredoc -> file -> --body-file in ONE command --------------------------
# The file does not exist at PreToolUse time. This is the repo's mandated
# publishing shape, so it must PASS when the heredoc body carries the marker at
# line start -- and still BLOCK when it does not.
HD_OK="cat > $TMPROOT/hd.md <<'EOF'
Some defect.

Dup-check: searched open issues -- none covers this root cause
EOF
gh issue create --body-file $TMPROOT/hd.md"
HD_NO="cat > $TMPROOT/hd2.md <<'EOF'
Some defect, nothing else.
EOF
gh issue create --body-file $TMPROOT/hd2.md"
run "heredoc body carries the marker" "$HD_OK" "$TMPROOT" 0
run "heredoc body lacks the marker"   "$HD_NO" "$TMPROOT" 2
# The fallback uses the ANCHORED marker, so a passing mention does not satisfy it.
HD_MID="cat > $TMPROOT/hd3.md <<'EOF'
We ran a dup-check: nothing turned up.
EOF
gh issue create --body-file $TMPROOT/hd3.md"
run "heredoc body mentions it mid-line" "$HD_MID" "$TMPROOT" 2

# --- the quoted-value holes (2026-09-05) ------------------------------------
# This gate was ACCIDENTALLY SAFE against the extraction bug its two siblings
# fail-open on, and the cases below pin the direction the accident actually
# produced. The old value class `(["\x27]?)([^"\x27\s]+)\1` could not span a
# QUOTED PATH CONTAINING A SPACE, so it extracted no path at all -- and here,
# uniquely, "no path" reaches `return 1`, which this gate reads as "no marker"
# and BLOCKS. So the miss surfaced as a FALSE BLOCK on a fully compliant body
# (measured against the pre-fix hook: rc=2 here, rc=0 for the unquoted twin),
# never as a pass. The safety came from an UNRELATED design choice one function
# up, so the two positive cases are the ones that fail pre-fix; the negative
# twins are controls that were already right and must stay right.
DUPSPACEDIR="$TMPROOT/dir with space"
mkdir -p "$DUPSPACEDIR"
cp "$WITH" "$DUPSPACEDIR/with.md"
cp "$WITHOUT" "$DUPSPACEDIR/without.md"
run "spaced --body-file path carries Dup-check" \
  "gh issue create --title t --body-file \"$DUPSPACEDIR/with.md\"" "$TMPROOT" 0
run "spaced --body-file path lacks Dup-check" \
  "gh issue create --title t --body-file \"$DUPSPACEDIR/without.md\"" "$TMPROOT" 2
run "spaced bare -F <path> carries Dup-check" \
  "gh issue create --title t -F \"$DUPSPACEDIR/with.md\"" "$TMPROOT" 0
# The GLUED short-flag spelling gh accepts as readily as the spaced one.
run "glued -F<path> carries Dup-check"   "gh issue create --title t -F$WITH"    "$TMPROOT" 0
run "glued -F<path> lacks Dup-check"     "gh issue create --title t -F$WITHOUT" "$TMPROOT" 2

run "empty command passes" "" "$TMPROOT" 0

run_nonbash "non-Bash tool passes" 0

# --- the GATE_PERL_WORD load guard, fenced ----------------------------------
# The cheap `[ -z ]` half cannot see a prelude that is PRESENT but does not
# COMPILE, and every extraction runs perl with stderr discarded -- so the gate
# would extract nothing and PASS what it exists to refuse. The payload below is
# one this gate NORMALLY PASSES, so a resulting exit 2 can only come from the
# guard, not from the gate's ordinary refusal.
BROKEN_DIR="$TMPBASE/brokenlib"
mkdir -p "$BROKEN_DIR/lib"
cp "$HOOK" "$BROKEN_DIR/"
sed "s|^  my \$GW = qr/.*|  my \$GW = qr/(((unclosed/;|" \
  "$(dirname "$HOOK")/lib/command-match.sh" > "$BROKEN_DIR/lib/command-match.sh"
if grep -q 'unclosed' "$BROKEN_DIR/lib/command-match.sh" \
   && ! grep -q 'my \$GW = qr/(?:' "$BROKEN_DIR/lib/command-match.sh"; then
  bl_rc=0
  jq -n --arg c "gh issue create --title t --body-file '"'"'$WITH'"'"'" --arg d "$TMPROOT" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}' \
    | "$BROKEN_DIR/$(basename "$HOOK")" >/dev/null 2>&1 || bl_rc=$?
  if [ "$bl_rc" = "2" ]; then
    echo "PASS: a non-compiling GATE_PERL_WORD fails CLOSED (exit 2)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: a non-compiling GATE_PERL_WORD returned $bl_rc, expected 2"
    FAIL=$((FAIL + 1))
  fi
else
  # A probe that silently does not run is the failure mode this file is about.
  echo "FAIL: could not stage a broken GATE_PERL_WORD (sed anchor drifted)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]
