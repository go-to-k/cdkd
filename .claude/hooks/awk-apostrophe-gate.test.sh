#!/usr/bin/env bash
# Smoke test for awk-apostrophe-gate.sh.
#
# The subject is a shape, not a file, so the fixture is a small stand-in with
# the same structure as the real `command-match.sh`: an awk program embedded as
# one single-quoted shell word, containing comments. Using the real library
# would tie this suite to that file's line numbers.
set -u
GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/awk-apostrophe-gate.sh"
TMPDIR_T="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_T"' EXIT INT TERM

HOOKDIR="$TMPDIR_T/.claude/hooks/lib"
mkdir -p "$HOOKDIR"
FIX="$HOOKDIR/fixture.sh"
APO=$(printf '\047')
SPLICE="${APO}\"${APO}\"${APO}"
cat > "$FIX" <<FIXTURE
#!/usr/bin/env bash
outside_the_awk_word() {
  : "a comment with an apostrophe here is harmless"
}
scan() {
  awk -v x="1" '
    # A comment INSIDE the awk word.
    function f(a) { return a }
    { print f(\$0) }
  ' <<< "\$1"
}
FIXTURE
bash -n "$FIX" || { echo "not ok fixture does not parse"; exit 1; }

pass=0; fail=0
run() { # <expected rc> <desc> <old_string> <new_string>
  local want="$1" desc="$2" old="$3" new="$4" rc
  printf '%s' "$(jq -nc --arg fp "$FIX" --arg o "$old" --arg n "$new" \
    '{tool_name:"Edit", tool_input:{file_path:$fp, old_string:$o, new_string:$n}}')" \
    | bash "$GATE" >/dev/null 2>&1
  rc=$?
  if [ "$rc" = "$want" ]; then pass=$((pass+1)); echo "ok   (exit $rc) $desc"
  else fail=$((fail+1)); echo "not ok (exit $rc, want $want) $desc"; fi
}
runw() { # <expected rc> <desc> <whole new content>
  local want="$1" desc="$2" content="$3" rc
  printf '%s' "$(jq -nc --arg fp "$FIX" --arg c "$content" \
    '{tool_name:"Write", tool_input:{file_path:$fp, content:$c}}')" | bash "$GATE" >/dev/null 2>&1
  rc=$?
  if [ "$rc" = "$want" ]; then pass=$((pass+1)); echo "ok   (exit $rc) $desc"
  else fail=$((fail+1)); echo "not ok (exit $rc, want $want) $desc"; fi
}

# THE SHAPE THAT COST TWO LOCKOUTS. An apostrophe in an awk-internal comment
# closes the single-quoted word; the file stops parsing; every hook sourcing it
# fails closed; and because main-tree-edit-gate matches Edit|Write|Bash the
# session loses all three tools and cannot repair what it just broke.
run 2 "Edit: apostrophe in an awk-internal comment" \
  '    # A comment INSIDE the awk word.' \
  "    # A comment INSIDE the awk word, this line${APO}s own."
# The same edit with the apostrophe removed must pass, or the gate is refusing
# the position rather than the character.
run 0 "Edit: the same comment without the apostrophe" \
  '    # A comment INSIDE the awk word.' \
  '    # A comment INSIDE the awk word, on its own line.'
# The splice is how a literal quote is written here: it closes and REOPENS the
# word, so the program survives. Flagging it would make the gate unusable on the
# file it exists to protect -- the first revision did exactly that on four
# pre-existing lines.
run 0 "Edit: a legal quote SPLICE in an awk-internal comment" \
  '    # A comment INSIDE the awk word.' \
  "    # A comment INSIDE the awk word, the body${SPLICE}s own."
# Outside the awk word an apostrophe is ordinary shell prose.
run 0 "Edit: apostrophe in a comment OUTSIDE the awk word" \
  'outside_the_awk_word() {' \
  "# the caller${APO}s cwd is untouched"$'\n''outside_the_awk_word() {'
# Write is the other way in, and the whole-file content path must reach the
# same verdict as the Edit path for the same result.
runw 2 "Write: apostrophe in an awk-internal comment" \
  "$(sed "s/    # A comment INSIDE the awk word./    # A comment INSIDE the awk word, this line${APO}s own./" "$FIX")"
runw 0 "Write: the same content with the apostrophe removed" "$(cat "$FIX")"
# Scope. A path outside .claude/hooks is none of this gate's business, and both
# path spellings must be recognised -- a relative file_path slipping through was
# a real fail-open in the first revision.
printf '%s' "$(jq -nc --arg fp "$TMPDIR_T/elsewhere.sh" --arg o a --arg n "b${APO}c" \
  '{tool_name:"Edit", tool_input:{file_path:$fp, old_string:$o, new_string:$n}}')" | bash "$GATE" >/dev/null 2>&1
if [ $? = 0 ]; then pass=$((pass+1)); echo "ok   (exit 0) a file outside .claude/hooks is ignored"
else fail=$((fail+1)); echo "not ok a file outside .claude/hooks must be ignored"; fi
# THE BASH ARM. An interpreter write to a hooks file is the vector that got
# through WITH this gate already registered: no Edit/Write payload exists for
# it, so the resulting content cannot be inspected and the gate refuses the
# shape rather than guessing at it. Three bounds accompany the refusal, because
# a blocking gate with false positives is a gate people route around: the same
# interpreter aimed elsewhere, a READ that merely names the path, and an
# ordinary command.
bashcase() { # <expected rc> <desc> <command>
  local want="$1" desc="$2" c="$3" rc
  printf '%s' "$(jq -nc --arg c "$c" '{tool_name:"Bash", tool_input:{command:$c}}')" | bash "$GATE" >/dev/null 2>&1
  rc=$?
  if [ "$rc" = "$want" ]; then pass=$((pass+1)); echo "ok   (exit $rc) $desc"
  else fail=$((fail+1)); echo "not ok (exit $rc, want $want) $desc"; fi
}
bashcase 2 "Bash: perl -pi on a hooks lib file is refused" \
  "perl -pi -e s/a/b/ .claude/hooks/lib/command-match.sh"
bashcase 2 "Bash: a python heredoc writing a hooks file is refused" \
  "python3 - .claude/hooks/lib/command-match.sh <<PY"
bashcase 0 "Bash: the same interpreter aimed OUTSIDE .claude/hooks passes" \
  "python3 -c x > /tmp/other.sh"
bashcase 0 "Bash: reading a hooks file with grep is not a write" \
  "grep -n foo .claude/hooks/lib/command-match.sh"
bashcase 0 "Bash: an ordinary command is not this gate's business" \
  "ls /tmp"
# THE FOUR SHAPES THE WHOLE-COMMAND SNIFF REFUSED. Each was measured blocking a
# reviewer's own analysis command while this gate was live, and none of them
# writes a hook file. They are cases rather than a note because a blocking gate
# with this false-positive rate does not get fixed -- it gets routed around,
# which is the failure its own header warns about. The first two put the
# interpreter and the hooks path in DIFFERENT segments; the third names no
# interpreter at all and matched only because `node_modules` contains `node`;
# the fourth is a prose mention redirected into a notes file.
bashcase 0 "Bash: interpreter and hooks path in different segments (read then run)" \
  "grep -c . .claude/hooks/lib/command-match.sh > /tmp/x && python3 /tmp/analyze.py"
bashcase 0 "Bash: a hooks path READ by python, output redirected elsewhere" \
  "python3 /tmp/a.py .claude/hooks/lib/command-match.sh > /tmp/o"
bashcase 0 "Bash: no interpreter at all -- node_modules is not node" \
  "ls node_modules && cat .claude/hooks/lib/command-match.sh > /tmp/c"
bashcase 0 "Bash: a prose mention of a hooks path appended to a notes file" \
  "echo 'see .claude/hooks/lib/command-match.sh' >> notes.md && node -v"
# THE CONTROL FOR THE REDIRECT REFINEMENT. The four cases above pass because a
# redirect is judged by its TARGET; this one must still be refused, or that
# refinement would have bought its quiet by disabling the arm. Both polarities
# of the same test, which is what the previous round found two cases lacking.
bashcase 2 "Bash: a redirect INTO a hooks file is still refused" \
  "python3 -c x > .claude/hooks/lib/command-match.sh"
# THE FOUR VECTORS AN INTERPRETER LIST DOES NOT COVER. An earlier revision
# armed only on `python|perl|ruby|node` as the command word, and a reviewer
# measured all four of these sailing through — they are the shapes an agent
# reaches for FIRST, and `sed` is named as a vector in the sibling detector's
# own header. A list of interpreters enumerates the wrong thing; what decides
# it is whether the segment writes the file.
bashcase 2 "Bash: sed -i rewriting a hooks lib file" \
  "sed -i '' 's/a/b/' .claude/hooks/lib/command-match.sh"
bashcase 2 "Bash: a cat heredoc redirected into a hooks lib file" \
  "cat > .claude/hooks/lib/command-match.sh <<'EOF'"
bashcase 2 "Bash: printf redirected into a hooks lib file" \
  "printf 'x' > .claude/hooks/lib/command-match.sh"
bashcase 2 "Bash: tee naming a hooks lib file as its target" \
  "tee .claude/hooks/lib/command-match.sh < /tmp/new"
bashcase 0 "Bash: sed -i on a file OUTSIDE .claude/hooks" \
  "sed -i '' s/a/b/ /tmp/other.sh"

echo "----"
echo "  total: $((pass+fail))  fail: $fail"
[ "$fail" -eq 0 ]
