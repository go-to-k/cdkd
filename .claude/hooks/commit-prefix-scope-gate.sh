#!/usr/bin/env bash
# commit-prefix-scope-gate.sh
#
# PreToolUse hook. Blocks `git commit` when the commit message uses
# a `feat:` or `fix:` conventional-commit prefix but NO file under
# `src/**` is staged.
#
# WHY: release-please on main maps commit prefixes to version bumps:
#   feat:   -> minor bump (e.g. v0.96 -> v0.97)
#   fix:    -> patch bump
#   chore:  -> no bump
#   docs/test/refactor/perf/style/ci/build: no bump
# AND adds matching CHANGELOG entries that users read as cdkd CLI
# changes. PR #346 (2026-05-13) committed a `/review-pr` skill update
# (.claude/skills/review-pr/SKILL.md, internal Claude Code dev tooling)
# with prefix `feat(review-pr): ...`, which triggered a v0.97.0 release
# whose CHANGELOG line "Features: review-pr: add **/*.md to pure-docs
# down-bias bucket" reads to users as a new cdkd CLI feature — but it
# is invisible to anyone running the cdkd binary. The release tag and
# changelog entry are unrecoverable once published.
#
# Rule: if commit prefix is `feat:` or `fix:` (with optional `(scope)`
# and optional `!` for breaking), at least one staged file must live
# under `src/**`. Anything else suggests the change is internal dev
# tooling, docs, tests, or build infrastructure — none of which
# should trigger a user-facing release entry.
#
# Allowed prefixes for non-src-changing commits:
#   chore:    build / tooling / .claude/** / hooks / skills / settings
#   docs:     README.md / CLAUDE.md / docs/**
#   test:     tests/** only (no src change)
#   refactor: internal restructuring with no behavior change
#   perf, style, ci, build, revert: per conventional-commits
#
# Scope resolution mirrors branch-gate.sh / internal-pr-labels-gate.sh:
# parse `cd <path>` and `git -C <path>` from the command line, fall
# through to the hook's reported cwd. The check is silently skipped
# when the target dir is not a git repo, so worktree-add or freshly
# cloned trees don't trip the gate before they have anything staged.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate git commit — anything else passes through. Recognition goes through
# the shared matcher (.claude/hooks/lib/command-match.sh, issue #2129): heredoc
# bodies and quoted spans are neutralised, then the verb is matched in COMMAND
# POSITION with any `VAR=value` / `env` / `command` / `nohup` prefix skipped. So
# `git add -A && git commit` and `GIT_EDITOR=true git commit` fire, while
# `echo "git commit"` — which the previous unanchored `\bgit...\bcommit\b`
# shellcheck source=lib/command-match.sh
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/command-match.sh"
# Fail CLOSED: a gate that cannot evaluate the command must not wave it through.
# `|| exit 0` silently disabled the gate whenever the library was unreadable or
# truncated, while ten of these files carried a comment claiming the opposite
# (go-to-k/cdkd#2130 review). The 18 gates that predate this convergence already
# exit 2 here; these now match them.
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unreadable, so this gate cannot evaluate the command." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib"
# Guard EVERY helper this hook calls, not just the first one. A truncated
# library that still defined `gate_matches` left `gate_target_dir_strict`
# undefined, and an undefined function exits 127 -- which the caller reads as
# "could not resolve" and refuses, so that one fails safe, while an undefined
# `gate_matches` exits 127 into an `if !` and passes. The window is exactly what
# this guard exists to close (go-to-k/cdkd#2027 review round 4).
if ! declare -F gate_matches >/dev/null 2>&1 \
  || ! declare -F gate_target_dir_strict >/dev/null 2>&1 \
  || ! declare -F gate_perl_word_or_die >/dev/null 2>&1 \
  || ! declare -F gate_segments >/dev/null 2>&1 \
  || ! declare -F gate_refuse_unresolved_target >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/lib/command-match.sh loaded but its API is incomplete (truncated file?)." >&2
  exit 2
fi
gate_matches "$cmd" "$GATE_RE_GIT_COMMIT" || exit 0

# The message extraction below runs the shared prelude, and a prelude that is
# present but does not COMPILE is silent (`perl ... 2>/dev/null`): `msg_file`
# would come back empty and the gate would pass whatever prefix it was given.
# Probed AFTER the verb check, so an ordinary Bash call pays nothing.
gate_perl_word_or_die commit-prefix-scope-gate || exit 2

# Where the git command actually runs: the last `git -C <path>` wins, else the
# last `cd <path>` in ANY segment before the verb (the previous form saw only a
# LEADING cd, so `git add -A && cd <wt> && git commit` resolved the wrong tree),
# else the payload cwd.
# FAIL CLOSED on a target this parser cannot read (go-to-k/cdkd#2027).
# gate_target_dir would DROP an unexpanded `-C "$W"` and judge the payload
# cwd instead -- measured as a silent pass when the violation lived in the
# target tree and the cwd was clean.
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GIT_COMMIT"); then
  gate_refuse_unresolved_target "commit-prefix-scope-gate" "${hook_cwd:-$PWD}"
fi

# If the resolved target dir is not a git repo, silently pass.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# --- Extract commit message subject from the command ---
#
# Supported shapes (order = first match wins):
#   git commit -m "subject"
#   git commit -m'subject'
#   git commit -m subject       (rare; single word)
#   git commit --message="..."
#   git commit --message "..."
#   git commit -F /path/to/file
#   git commit --file=/path
# The amend / no-edit / interactive paths are passed through (no
# subject to inspect without a heuristic on the existing HEAD message).
subject=""

if [[ "$cmd" =~ [[:space:]]--amend([[:space:]]|$) ]]; then
  exit 0
fi

# Parse -m / --message variants.
if [[ "$cmd" =~ [[:space:]]-m[[:space:]]*\"([^\"]+)\" ]]; then
  subject="${BASH_REMATCH[1]}"
elif [[ "$cmd" =~ [[:space:]]-m[[:space:]]*\'([^\']+)\' ]]; then
  subject="${BASH_REMATCH[1]}"
elif [[ "$cmd" =~ [[:space:]]--message[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]]; then
  subject="${BASH_REMATCH[1]}"
elif [[ "$cmd" =~ [[:space:]]--message[[:space:]]*=[[:space:]]*\'([^\']+)\' ]]; then
  subject="${BASH_REMATCH[1]}"
elif [[ "$cmd" =~ [[:space:]]--message[[:space:]]+\"([^\"]+)\" ]]; then
  subject="${BASH_REMATCH[1]}"
elif [[ "$cmd" =~ [[:space:]]--message[[:space:]]+\'([^\']+)\' ]]; then
  subject="${BASH_REMATCH[1]}"
fi

# Parse -F / --file file path. Read the first line of the file as
# the subject. Path may be quoted or bare. If the file is missing,
# silently pass (the git commit itself will fail with a clear error,
# no need to duplicate it here).
if [[ -z "$subject" ]]; then
  # ONE arm over the shared `$GW` shell WORD, not five arms enumerating quote
  # POSITIONS -- the same replacement this change makes in the body gates, for
  # the same reason. The five-arm shape had two measured holes, both of which
  # left `msg_file` EMPTY and so fell through to the pass-through meant for a
  # bare `git commit`:
  #
  #   git commit --file "$VAR/msg.txt"   rc=0   the `--file` spellings had no
  #   git commit --file '$VAR/msg.txt'   rc=0   quoted alternatives at all, so
  #                                             the unresolvable-path refusal
  #                                             below was never even consulted
  #
  # It also could not span a quoted path containing a SPACE, nor the GLUED
  # `-F<path>` git accepts as readily as `-F <path>`. `$GW` handles all of them
  # by taking one word; `gate_unq` removes the quoting.
  # SCOPED TO THE `git ... commit` SEGMENT, not the whole command. `-F` is a
  # flag on plenty of other commands -- `grep -F`, `awk -F`, `sort -F`, and gh's
  # own `-F` -- so a whole-command scan takes the FIRST `-F` in the line, which
  # is not necessarily the commit's. Measured, with only `.claude/**` staged and
  # a `fix(hooks):` message:
  #
  #   git commit -F <path>                          -> <path>       rc=2
  #   grep -Fq zzz f; git commit -F <path>          -> `q`          rc=0
  #   awk -F , x && git commit -F <path>            -> `,`          rc=0
  #   gh issue create -F b.md && git commit -F <p>  -> `b.md`       rc=0
  #
  # The first row is the regression this scoping closes: the five-arm extractor
  # this replaced required `-F<space>`, so a GLUED `-Fq` was skipped and it
  # found the real path. Widening to the glued spelling without scoping traded
  # one hole for a worse one. The `-F -` branch below already scopes with its
  # own `/git[^|;&]*commit/`, so the file was internally inconsistent too.
  commit_seg=""
  while IFS= read -r __seg; do
    if gate_matches "$__seg" "$GATE_RE_GIT_COMMIT"; then commit_seg="$__seg"; break; fi
  done < <(gate_segments "$cmd")
  # No segment matched: fall back to the whole command rather than to NOTHING.
  # An unreadable command is the fail-OPEN direction, and `gate_matches` has
  # already established that this IS a git commit -- see the verb check above.
  [ -n "$commit_seg" ] || commit_seg="$cmd"
  msg_file=$(printf '%s' "$commit_seg" | perl -0777 -ne "$GATE_PERL_WORD"'
    while (/(?:^|\s)(?:-F[=\s]*|--file[=\s]+)($GW)/g) {
      print gate_unq($1), "\n";
      last;
    }' 2>/dev/null)
  if [[ "$msg_file" == "-" ]]; then
    # `git commit -F -` reads the message from STDIN, which in practice is a
    # heredoc whose body is part of this very command string — so the subject
    # IS available at PreToolUse time, it just is not on disk.
    #
    # This was a silent blind spot: `-F -` matched the path parser, resolved
    # to a nonexistent "<dir>/-", left $subject empty, and fell through to the
    # pass-through below. It let a `fix(hooks):` commit touching only
    # `.claude/**` through — exactly the mislabelled-release shape this gate
    # exists to stop — and it did so on the commit that fixed issue #1455.
    # The `-F -` heredoc form is also what `commit-msg-heredoc-gate.sh` steers
    # people toward, so it is the COMMON shape here, not a rare one.
    #
    # Take the first non-empty line after the heredoc opener that belongs to
    # the `git ... commit` invocation — NOT merely the first heredoc anywhere
    # in the command. A command can open an unrelated heredoc first:
    #
    #   cat <<A > /tmp/f
    #   chore: unrelated
    #   A
    #   git commit -F - <<'EOF'
    #   fix(hooks): the real subject
    #   EOF
    #
    # Latching on the first opener returns "chore: unrelated" and lets the
    # mislabelled `fix:` through — the exact outcome this gate exists to stop.
    subject=$(printf '%s' "$cmd" | awk '
      seen { if ($0 != "") { print; exit } next }
      /git[^|;&]*commit/ && /<<-?[ \t]*("[^"]+"|\047[^\047]+\047|[A-Za-z_][A-Za-z0-9_]*)/ { seen = 1 }
    ')
  elif [[ -n "$msg_file" ]]; then
    # An UNRESOLVABLE path refuses instead of falling through. The shell
    # expands `$VAR`, a `$(...)`, a backtick, a glob or a `~user` before git
    # runs; this hook sees the text, so it cannot read the message and cannot
    # see the prefix. The fall-through made that a SILENT PASS -- measured on
    # this very repo, `git commit -F "$S/msg.txt"` with a `fix(hooks):` subject
    # and nothing under `src/**` staged went through at rc=0, while the same
    # commit with a LITERAL path gave rc=2. That is a mislabelled release, which
    # is the one thing this gate exists to stop, reachable by writing the path
    # into a variable first -- the ordinary way to hold a long message path.
    #
    # `~/` alone is NOT in the set: HOME is expanded correctly below, so
    # refusing it would be a false refusal (same carve-out as the shared
    # matcher makes for a leading `~/`).
    # `[` is the THIRD POSIX glob metacharacter and was missing from the first
    # cut. Measured: `-F <dir>/m[0-9].txt` expanded to `m1.txt`, git read the
    # `fix(hooks):` subject with only `.claude/**` staged, and the hook -- seeing
    # the literal bracketed text -- found no readable file and passed at rc=0.
    # `{` is brace expansion, the last of the four expansions the shell performs
    # on an unquoted word here. `$(...)`, backticks and `~+` / `~-` are already
    # covered by the `$` / backtick / `~`-not-`~/` arms; `!` history expansion is
    # interactive-only. Measured: `-F <dir>/msg{1,2}.txt` expanded and committed.
    if [[ "$msg_file" == *'$'* || "$msg_file" == *'`'* \
       || "$msg_file" == *'*'* || "$msg_file" == *'?'* || "$msg_file" == *'['* \
       || "$msg_file" == *'{'* \
       || ( "$msg_file" == '~'* && "$msg_file" != '~/'* ) ]]; then
      echo "Blocked by commit-prefix-scope-gate: the commit message is read from" >&2
      echo "a path this hook cannot resolve:" >&2
      echo "" >&2
      echo "  $msg_file" >&2
      echo "" >&2
      echo "The shell expands it before git runs; a PreToolUse hook sees only the" >&2
      echo "text, so the commit PREFIX cannot be checked. Passing anyway would let" >&2
      echo "a \`fix:\` / \`feat:\` commit with no \`src/**\` change trigger a release" >&2
      echo "version bump and a user-facing CHANGELOG entry for an internal change." >&2
      echo "" >&2
      echo "Use a literal path, or the heredoc form this repo prefers:" >&2
      echo "" >&2
      echo "  git commit -F - <<'MSG'" >&2
      echo "  <subject>" >&2
      echo "  MSG" >&2
      exit 2
    fi
    # Resolve relative path against target_dir.
    if [[ "$msg_file" == '~/'* ]]; then
      msg_file="${HOME:-/nonexistent}/${msg_file#\~/}"
    elif [[ "$msg_file" != /* ]]; then
      msg_file="$target_dir/$msg_file"
    fi
    if [[ -r "$msg_file" ]]; then
      subject=$(head -n 1 "$msg_file" 2>/dev/null || true)
    fi
  fi
fi

# No subject found (e.g. plain `git commit` without -m / -F — opens
# editor with COMMIT_EDITMSG, which we can't inspect at PreToolUse
# time). Pass through.
if [[ -z "$subject" ]]; then
  exit 0
fi

# --- Identify the prefix ---
#
# Conventional-commit grammar: `type(scope)?!?: subject`.
# Match types only; the rest (scope, breaking-`!`, subject) is
# allowed any shape.
#
# `revert:` is special — it carries the inner commit's prefix verbatim
# in the message body. We pass `revert:` through without checking the
# inner prefix (a feat-revert that has no src changes is itself
# unusual and worth the false-positive risk; treating `revert:` as
# always-allowed matches conventional-commit guidance).
prefix=""
if [[ "$subject" =~ ^([a-z]+)(\([^\)]+\))?!?:[[:space:]] ]]; then
  prefix="${BASH_REMATCH[1]}"
fi

if [[ -z "$prefix" ]]; then
  # Not a conventional-commit shape — pass. The repo's existing
  # commits enforce the shape via release-please's commit parsing
  # config; non-conforming commits get no release entry anyway.
  exit 0
fi

case "$prefix" in
  feat|fix) ;;        # subject to the scope check below
  revert)   exit 0 ;; # inner prefix carries; pass through
  *)        exit 0 ;; # chore / docs / test / refactor / perf / etc.
esac

# --- Check staged files for any src/** path ---
staged_files=$(git -C "$target_dir" diff --cached --name-only 2>/dev/null || true)
if [[ -z "$staged_files" ]]; then
  # No staged files — the git commit itself will fail with its own
  # clearer error ("nothing to commit"). Pass through.
  exit 0
fi

# Look for ANY path starting with `src/`. POSIX glob via case to avoid
# extglob portability concerns.
has_src=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    src/*) has_src=1; break ;;
  esac
done <<< "$staged_files"

if [[ "$has_src" -eq 1 ]]; then
  exit 0
fi

# --- Block ---
if [[ -t 2 ]]; then
  RED_BOLD=$'\033[1;31m'
  RESET=$'\033[0m'
else
  RED_BOLD=""
  RESET=""
fi

# Suggest the right prefix based on the staged file mix.
has_docs=0
has_tests_only=0
has_claude_only=0
has_deps_only=0

all_docs=1
all_tests=1
all_claude=1
all_deps=1

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    docs/*|README.md|CLAUDE.md|*/README.md) has_docs=1 ;;
    *) all_docs=0 ;;
  esac
  case "$f" in
    tests/*) has_tests_only=1 ;;
    *) all_tests=0 ;;
  esac
  case "$f" in
    .claude/*) has_claude_only=1 ;;
    *) all_claude=0 ;;
  esac
  case "$f" in
    package.json|pnpm-lock.yaml) has_deps_only=1 ;;
    *) all_deps=0 ;;
  esac
done <<< "$staged_files"

suggested="chore"
if [[ "$all_docs" -eq 1 && "$has_docs" -eq 1 ]]; then
  suggested="docs"
elif [[ "$all_tests" -eq 1 && "$has_tests_only" -eq 1 ]]; then
  suggested="test"
elif [[ "$all_claude" -eq 1 && "$has_claude_only" -eq 1 ]]; then
  suggested="chore"
elif [[ "$all_deps" -eq 1 && "$has_deps_only" -eq 1 ]]; then
  suggested="chore(deps)"
fi

{
  echo "${RED_BOLD}Blocked by commit-prefix-scope-gate:${RESET}"
  echo
  echo "Commit prefix '${prefix}:' feeds a release-please version bump"
  echo "AND lands in the user-facing CHANGELOG, but no file under src/** is"
  echo "staged. The change is internal (dev tooling / docs / tests / build),"
  echo "not a cdkd CLI behavior change, and would mislead users reading the"
  echo "release notes."
  echo
  echo "Staged files (none in src/**):"
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    echo "  - $f"
  done <<< "$staged_files"
  echo
  echo "Suggested prefix: ${suggested}:"
  echo
  echo "Mapping:"
  echo "  src/**                                 -> feat: or fix:"
  echo "  docs/** / README.md / CLAUDE.md        -> docs:"
  echo "  tests/** only                          -> test:"
  echo "  .claude/** (hook / skill / agent)      -> chore:"
  echo "  package.json + pnpm-lock.yaml only     -> chore(deps):"
  echo "  build / CI / .gitignore / config       -> chore:"
  echo
  echo "Memory: ~/.claude/projects/-Users-goto-pc-github-cdkd/memory/feedback_commit_prefix_scope.md"
} >&2

exit 2
