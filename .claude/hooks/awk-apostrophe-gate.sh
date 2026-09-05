#!/usr/bin/env bash
# Refuses a write that would leave a shell file under `.claude/hooks/**`
# unparseable.
#
# WHY THIS EXISTS. `.claude/hooks/lib/command-match.sh` embeds its awk program
# as ONE single-quoted shell word. An apostrophe anywhere inside it -- including
# inside an awk COMMENT, where it reads as ordinary prose -- closes that word,
# and every following line is parsed as shell. The file then fails `bash -n`,
# every hook that sources it fails CLOSED, and because `main-tree-edit-gate`
# matches `Edit|Write|Bash`, the session loses all three tools at once and
# cannot repair the file it just broke. Recovery needs a human-typed command.
#
# That happened three times in go-to-k/cdkd#2650 -- the second time AFTER a
# comment saying "NO APOSTROPHE APPEARS IN THIS COMMENT" had been added to the
# very function involved, and the third time WITH the first revision of this
# gate already registered, through a `python3` heredoc inside a Bash call that
# no Edit/Write payload described. A warning in prose does not survive the next
# edit, and a gate that only watches two tools does not watch the third.
#
# THE CHECK IS EXACT, NOT A SNIFF. The first revision looked for an apostrophe
# in a comment that appeared to sit inside a single-quoted awk word. That
# heuristic had false positives immediately -- a test file carrying an awk
# fixture inside a heredoc tripped it -- and false positives on a blocking gate
# are how a gate gets bypassed. So this one BUILDS the post-edit content and
# runs `bash -n` on it. That is the same question the failure asks, answered the
# same way, with no pattern to be wrong about: it catches every syntax break,
# not only the apostrophe class.
#
# It refuses only when the edit is what breaks the file: a file that ALREADY
# fails to parse is passed through, because refusing there would block the
# repair.
set -u

input=$(cat 2>/dev/null || true)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")

case "$tool" in
  Edit|Write) ;;
  Bash)
    # AN INTERPRETER WRITE IS THE OTHER WAY IN, and it is the one that got
    # through. The content is not knowable here -- it lives inside the
    # interpreter -- so this arm does not try to judge it. It refuses the shape
    # and names the tool that IS checkable. `hook-lib-parse-detector.sh` is the
    # PostToolUse companion for everything this cannot see.
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
    # SEGMENT-SCOPED, because a whole-command sniff is a false-positive machine.
    # The first revision asked three questions of the ENTIRE command text -- is
    # an interpreter named anywhere, is a hooks path named anywhere, is there a
    # write-ish token anywhere -- and any three unrelated commands in one call
    # satisfied all three. Measured, it refused four of a reviewer`s own
    # commands, including `cat <hook> > /tmp/c` with NO interpreter in it at all
    # (`node_modules` matched `*node*`) and a prose mention redirected into a
    # notes file. False positives on a BLOCKING gate are the route-around
    # pressure this file`s own header warns about, so the three questions are
    # now asked of ONE segment.
    # LOADED TOLERANTLY, and that is not the usual fail-closed shape. This gate
    # is the one that catches an unparseable library, so it must keep working
    # when the library is exactly that. A failed load leaves `gate_segments`
    # undefined, the loop below falls back to treating the whole command as one
    # segment, and the gate answers as its first revision did -- more refusing,
    # never less.
    # PARSED BEFORE IT IS SOURCED, and that order is the whole point. This gate
    # exists because an unparseable library turns the rest of the file into
    # shell -- so sourcing one EXECUTES that mangled tail. Measured: a `touch`
    # placed after the broken quote in a copy of the library ran. Every other
    # gate sources it too, but each then `exit 2`s; this one carries on, which
    # would make the gate that catches the accident a way of triggering it.
    __hd="${BASH_SOURCE[0]%/*}"; [ "$__hd" = "${BASH_SOURCE[0]}" ] && __hd="."
    if bash -n "$__hd/lib/command-match.sh" 2>/dev/null; then
      . "$__hd/lib/command-match.sh" 2>/dev/null || true
    fi

    __hit=0
    while IFS= read -r __seg; do
      [ -n "$__seg" ] || continue
      case "$__seg" in *.claude/hooks/*.sh*) ;; *) continue ;; esac
      # The interpreter must be the COMMAND WORD of this segment, not a
      # substring of some argument -- `node_modules` in an unrelated argument is
      # what made the whole-command sniff refuse a plain `cat`. Env assignments
      # and wrappers come off first.
      declare -F gate_strip_prefix >/dev/null && __seg=$(gate_strip_prefix "$__seg")
      # THE COMMAND WORD LIST IS NOT THE GATE. An earlier revision armed only on
      # `python|perl|ruby|node`, and a reviewer measured the four shapes an
      # agent actually reaches for first sailing through: `sed -i '' s/a/b/
      # <lib>`, `cat > <lib> <<EOF`, `printf x > <lib>` and `tee <lib>`. A list
      # of interpreters is an enumeration of the wrong thing -- what matters is
      # whether the segment WRITES the file, whatever ran. `sed` is named in the
      # sibling detector as a vector and was missing here.
      #
      # The list survives only to catch a write this file cannot see INSIDE an
      # interpreter (a heredoc body calling `open()`), where the command word is
      # the only signal available. Everything else is decided by the write test
      # below, which reads the redirect TARGET.
      __interp=0
      case "${__seg%%[[:space:]]*}" in
        python|python3|perl|ruby|node|*/python|*/python3|*/perl|*/ruby|*/node) __interp=1 ;;
      esac
      # A read is not a write. The in-place flag is matched by REGEX, not by a
      # `" -i"` glob: perl takes it CLUSTERED, and `perl -pi -e s/a/b/ <file>`
      # -- the exact command that repaired the third lockout, and would equally
      # have caused a fourth -- contains no ` -i` substring. The alternation
      # covers `-i`, `-pi` and `-i.bak` alike.
      # A REDIRECT IS JUDGED BY ITS TARGET, not by the presence of `>`.
      # `python3 /tmp/a.py <hook> > /tmp/o` READS a hook and writes somewhere
      # else; refusing it taught the reader that this gate fires on mentions.
      # The other tokens stay unconditional: `-i`, `open(` and a heredoc body
      # can all write the file the segment names, and none of them says where.
      # An in-place edit names no target separately -- the file it rewrites is
      # the one on the line -- so these arm regardless of who ran them.
      case "$__seg" in
        *"--in-place"*) __hit=1; break ;;
      esac
      [[ "$__seg" =~ (^|[[:space:]])-[a-zA-Z]*i([[:space:]]|$|\.) ]] && { __hit=1; break; }
      # Inside an interpreter the write is invisible from here, so its own
      # vocabulary is the only signal.
      if [ "$__interp" = 1 ]; then
        case "$__seg" in
          *"open("*|*"write"*|*"<<"*) __hit=1; break ;;
        esac
      fi
      # `tee` NAMES its targets as ordinary words rather than after a `>`.
      if [[ "$__seg" =~ (^|[[:space:]])tee([[:space:]]|$) ]]; then
        case "$__seg" in *.claude/hooks/*.sh*) __hit=1; break ;; esac
      fi
      # A REDIRECT IS JUDGED BY ITS TARGET, not by the presence of `>`.
      # `python3 /tmp/a.py <hook> > /tmp/o` READS a hook and writes somewhere
      # else; refusing it taught the reader that this gate fires on mentions.
      # Reading the target is also what lets `cat > <lib> <<EOF` and
      # `printf x > <lib>` be caught without arming on every `>` in the segment.
      __rest="$__seg"
      while [[ "$__rest" =~ \>\>?[[:space:]]*([^[:space:]\<\>\|\&\;\(\)]+) ]]; do
        case "${BASH_REMATCH[1]}" in *.claude/hooks/*) __hit=1; break ;; esac
        __rest="${__rest#*"${BASH_REMATCH[0]}"}"
      done
      [ "$__hit" = 1 ] && break
      [[ "$__seg" =~ (^|[[:space:]])-[a-zA-Z]*i([[:space:]]|$|\.) ]] && { __hit=1; break; }
    done < <(gate_segments "$cmd" 2>/dev/null || printf '%s\n' "$cmd")
    [ "$__hit" = 1 ] || exit 0
    {
      echo "Blocked by awk-apostrophe-gate: this Bash call runs an interpreter"
      echo "against a file under .claude/hooks/, and the content it would write"
      echo "cannot be inspected from here."
      echo ""
      echo "Use the Edit or Write tool for these files. Those payloads carry the"
      echo "resulting content, so this gate can run bash -n on it before the"
      echo "write lands -- and an unparseable file here takes away Edit, Write"
      echo "and Bash together, leaving only a human-typed command to recover."
      echo "That happened three times in go-to-k/cdkd#2650, the third time with"
      echo "this gate already registered, through exactly this vector."
    } >&2
    exit 2
    ;;
  *) exit 0 ;;
esac

fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
case "$fp" in
  # BOTH SPELLINGS. `*/.claude/hooks/*.sh` alone requires a leading slash, so a
  # RELATIVE file_path slipped through silently, and a gate that only sees
  # absolute paths has a fail-open.
  */.claude/hooks/*.sh|.claude/hooks/*.sh) ;;
  *) exit 0 ;;
esac

tmp=$(mktemp) || exit 0
trap 'rm -f "$tmp"' EXIT INT TERM

if [ "$tool" = Write ]; then
  printf '%s' "$input" | jq -r '.tool_input.content // ""' > "$tmp" 2>/dev/null || exit 0
else
  [ -f "$fp" ] || exit 0
  # A file that is ALREADY broken is passed through: refusing there would block
  # the repair, which is the one edit that must always be possible.
  bash -n "$fp" 2>/dev/null || exit 0
  old=$(printf '%s' "$input" | jq -r '.tool_input.old_string // ""' 2>/dev/null) || exit 0
  new=$(printf '%s' "$input" | jq -r '.tool_input.new_string // ""' 2>/dev/null) || exit 0
  [ -n "$old" ] || exit 0
  OLD="$old" NEW="$new" python3 - "$fp" "$tmp" <<'PY' 2>/dev/null || exit 0
import io, os, sys
src, dst = sys.argv[1], sys.argv[2]
s = io.open(src, encoding='utf-8', errors='replace').read()
old, new = os.environ['OLD'], os.environ['NEW']
# Only a UNIQUE match is resolvable; anything else is passed through rather
# than guessed at, since Edit itself refuses a non-unique old_string.
if s.count(old) != 1:
    sys.exit(1)
io.open(dst, 'w', encoding='utf-8').write(s.replace(old, new))
PY
fi

err=$(bash -n "$tmp" 2>&1) && exit 0

{
  echo "Blocked by awk-apostrophe-gate: after this write the file would not parse."
  echo ""
  echo "  ${fp}"
  printf '  %s\n' "$(printf '%s' "$err" | head -3 | sed "s#$tmp#<the file>#g")"
  echo ""
  echo "The file parses now, so this write is what breaks it. That matters more"
  echo "here than elsewhere: every gate sources"
  echo ".claude/hooks/lib/command-match.sh and fails CLOSED when it cannot load,"
  echo "and main-tree-edit-gate matches Edit|Write|Bash -- so an unparseable"
  echo "file takes away all three tools at once and only a human-typed command"
  echo "can recover the repository. That happened three times in"
  echo "go-to-k/cdkd#2650."
  echo ""
  echo "The usual cause is an apostrophe inside the single-quoted awk program,"
  echo "including inside an awk COMMENT, where it reads as ordinary prose but"
  echo "closes the shell word. Rewrite it without one:"
  echo "  \"this line's quoting\"  ->  \"the quoting on this line\""
  echo "For a literal quote in awk CODE, use the \\047 escape, as"
  echo "strip_noncommand_spans does."
} >&2
exit 2
