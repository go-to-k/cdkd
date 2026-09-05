#!/usr/bin/env bash
# PostToolUse: after ANY Bash call, check that every shell file under
# `.claude/hooks/**` still parses.
#
# WHY A POST-HOOK AND NOT A GATE. `awk-apostrophe-gate` refuses the shape at
# Edit/Write time, where the resulting content is knowable. A Bash call that
# writes the same file through `python3`/`perl`/`sed`/a heredoc is not
# statically resolvable -- the content lives inside an interpreter this hook
# cannot run -- and that is exactly how the third lockout of go-to-k/cdkd#2650
# happened: the gate was in place, the write went through `python3 - <<PY`, and
# the gate never saw it. A static sniff of the command text would be another
# guess; running `bash -n` on the RESULT is not a guess.
#
# It cannot block (PostToolUse never can), and blocking is not what is needed.
# What was missing is IMMEDIACY: a broken library is silent until the next
# command, by which time every hook fails closed and Edit, Write and Bash are
# all gone at once, so the session cannot repair what it just broke. Reported at
# the moment of the write, the fix is one edit away instead of one human away.
#
# Cheap by construction: `bash -n` on ~60 small files, and only after a Bash
# call whose text mentions the hooks directory at all.
set -u

input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
case "$cmd" in
  *".claude/hooks"*) ;;
  *) exit 0 ;;
esac

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd) || exit 0
broken=""
for f in "$root"/.claude/hooks/*.sh "$root"/.claude/hooks/lib/*.sh; do
  [ -f "$f" ] || continue
  err=$(bash -n "$f" 2>&1) || broken="${broken}  ${f#"$root"/}: $(printf '%s' "$err" | head -1)"$'\n'
done
[ -n "$broken" ] || exit 0

msg=$(
  echo "A hook file under .claude/hooks/ no longer parses:"
  echo ""
  printf '%s' "$broken"
  echo ""
  echo "FIX IT NOW, BEFORE THE NEXT COMMAND. Every gate sources"
  echo ".claude/hooks/lib/command-match.sh and fails CLOSED when it cannot load,"
  echo "and main-tree-edit-gate matches Edit|Write|Bash -- so once you move on,"
  echo "all three tools are refused and only a human-typed command can recover"
  echo "the repository. That happened three times in go-to-k/cdkd#2650."
  echo ""
  echo "The usual cause: an apostrophe inside the single-quoted awk program,"
  echo "including inside an awk COMMENT. Write the prose without one, or spell a"
  echo "literal quote \\047 as strip_noncommand_spans does."
)

# EMITTED AS `additionalContext`, NOT AS STDERR. Both sibling PostToolUse
# detectors (`main-tree-dirty-detector.sh`, `main-tree-git-cwd-detector.sh`) use
# this shape for a reason: at exit 0 neither stdout nor stderr reaches the
# model, so a warning written the obvious way is invisible to the one party who
# can act on it. This hook`s entire value is IMMEDIACY -- telling the session
# now, rather than letting it discover at the next command that every tool is
# refused -- so a message it cannot see buys nothing at all.
#
# Also kept on stderr, where a human running the hook by hand or reading a
# transcript will find it.
ctx=$(printf '%s' "$msg" | jq -Rs . 2>/dev/null) || ctx=""
[ -n "$ctx" ] && printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' "$ctx"
printf '%s\n' "$msg" >&2
exit 0
