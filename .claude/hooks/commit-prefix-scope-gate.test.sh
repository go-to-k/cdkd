#!/usr/bin/env bash
# Smoke test for commit-prefix-scope-gate.sh.
#
# Spins up a throwaway git repo per case, stages the requested file
# set, and runs the hook against a synthetic git-commit invocation.
# Exit 0 = allow, exit 2 = block.
#
# Run from the repo root:
#   bash .claude/hooks/commit-prefix-scope-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/commit-prefix-scope-gate.sh"

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <prefix> <files-csv> [<commit_arg_shape>]
# files-csv: comma-separated list of paths to create + stage (use
#            'NONE' to stage nothing)
# commit_arg_shape: 'm' (default) for `git commit -m "..."`, 'F' for
#            `git commit -F /tmp/msg.txt`, 'amend' for `git commit --amend`,
#            'plain' for bare `git commit` (no -m / -F).
run_case() {
  local name="$1"; local want="$2"; local subject="$3"; local files_csv="$4"
  local shape="${5:-m}"

  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" RETURN

  ( cd "$tmpdir" && git init -q && git config user.email t@t && git config user.name t ) >/dev/null 2>&1

  if [[ "$files_csv" != "NONE" ]]; then
    IFS=',' read -ra files <<< "$files_csv"
    for f in "${files[@]}"; do
      mkdir -p "$tmpdir/$(dirname "$f")"
      echo "test content" > "$tmpdir/$f"
      ( cd "$tmpdir" && git add "$f" ) >/dev/null 2>&1
    done
  fi

  local cmdstr
  case "$shape" in
    m)
      cmdstr=$(printf 'git -C %q commit -m "%s"' "$tmpdir" "$subject")
      ;;
    F)
      local msgfile="$tmpdir/msg.txt"
      echo "$subject" > "$msgfile"
      cmdstr=$(printf 'git -C %q commit -F %q' "$tmpdir" "$msgfile")
      ;;
    Fdash)
      # `git commit -F -` + heredoc: the message never touches disk, so the
      # subject has to be read out of the command string itself. This shape
      # used to fall through the path parser (resolving to a nonexistent
      # "<dir>/-") and silently skip the whole gate.
      cmdstr=$(printf "git -C %q commit -q -F - <<'MSGEOF'\n%s\n\nbody\nMSGEOF" "$tmpdir" "$subject")
      ;;
    Fvar)
      # The `-F` path held in a SHELL VARIABLE -- the ordinary way to carry a
      # long message path, and what the hook actually sees is the text `$MSG`.
      # It cannot read the file, so it cannot see the prefix; falling through
      # made that a SILENT PASS and let a `fix:` commit touching only
      # `.claude/**` reach a release. The message file is written so the case
      # is about UNRESOLVABILITY, not about a missing file.
      local msgfile="$tmpdir/msg.txt"
      echo "$subject" > "$msgfile"
      cmdstr=$(printf 'MSG=%q; git -C %q commit -F "$MSG"' "$msgfile" "$tmpdir")
      ;;
    Fglob)
      local msgfile="$tmpdir/msg.txt"
      echo "$subject" > "$msgfile"
      cmdstr=$(printf 'git -C %q commit -F %q/msg*.txt' "$tmpdir" "$tmpdir")
      ;;
    Fbracket)
      # `[...]` is the THIRD POSIX glob metacharacter and the first cut of the
      # unresolvable predicate listed only `*` and `?`. bash expands it, git
      # reads the subject, and the hook -- seeing the literal bracketed text --
      # found no readable file and passed.
      local msgfile="$tmpdir/m1.txt"
      echo "$subject" > "$msgfile"
      cmdstr=$(printf 'git -C %q commit -F %q/m[0-9].txt' "$tmpdir" "$tmpdir")
      ;;
    FileVar)
      # The `--file` twin of the `$VAR` hole. Its spellings had no QUOTED
      # alternatives at all, so the path never got extracted and the
      # unresolvable refusal was not even consulted -- the fix for `-F "$VAR"`
      # left this one live, exactly one flag spelling over.
      local msgfile="$tmpdir/msg.txt"
      echo "$subject" > "$msgfile"
      cmdstr=$(printf 'MSG=%q; git -C %q commit --file "$MSG"' "$msgfile" "$tmpdir")
      ;;
    FileVarSq)
      local msgfile="$tmpdir/msg.txt"
      echo "$subject" > "$msgfile"
      cmdstr=$(printf 'git -C %q commit --file \x27$MSG/msg.txt\x27' "$tmpdir")
      ;;
    Fspace)
      # A quoted path containing a SPACE -- the shape the whole value-class
      # change is about, here too.
      mkdir -p "$tmpdir/sp ace"
      local msgfile="$tmpdir/sp ace/msg.txt"
      echo "$subject" > "$msgfile"
      cmdstr=$(printf 'git -C %q commit -F "%s"' "$tmpdir" "$msgfile")
      ;;
    Fglued)
      local msgfile="$tmpdir/msg.txt"
      echo "$subject" > "$msgfile"
      cmdstr=$(printf 'git -C %q commit -F%q' "$tmpdir" "$msgfile")
      ;;
    Ftilde)
      # A leading `~/` is deliberately NOT unresolvable: HOME is expanded
      # correctly, so refusing it would be a false refusal.
      cmdstr=$(printf 'git -C %q commit -F ~/definitely-absent-%s.txt' "$tmpdir" "$$")
      ;;
    amend)
      cmdstr=$(printf 'git -C %q commit --amend -m "%s"' "$tmpdir" "$subject")
      ;;
    plain)
      cmdstr=$(printf 'git -C %q commit' "$tmpdir")
      ;;
    # Command-matching shapes (issue #2129): the verb after a chain operator
    # must be seen, and a quoted mention of it must not fire.
    compound)
      cmdstr=$(printf 'git add -A && git -C %q commit -m "%s"' "$tmpdir" "$subject")
      ;;
    quoted)
      cmdstr=$(printf 'echo "then git -C %q commit -m %s"' "$tmpdir" "$subject")
      ;;
    *)
      echo "internal test error: unknown shape '$shape'" >&2
      return 1
      ;;
  esac

  local payload
  payload=$(jq -cn --arg c "$cmdstr" '{tool_input:{command:$c}}')

  local got
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?

  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  subject: $subject\n  files: $files_csv\n  cmd: $cmdstr\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- ALLOW: feat/fix with src/** present ---

run_case "feat: with src/** allowed" 0 \
  "feat: add new flag" "src/cli/options.ts"

run_case "feat(scope): with src/** allowed" 0 \
  "feat(cli): add new flag" "src/cli/options.ts"

run_case "fix: with src/** allowed" 0 \
  "fix: handle null case" "src/utils/foo.ts"

run_case "feat: with src/** + tests/** + docs/** allowed (src dominant)" 0 \
  "feat: add new flag" "src/cli/options.ts,tests/unit/foo.test.ts,docs/cli-reference.md"

run_case "feat!: breaking marker with src/** allowed" 0 \
  "feat!: rename API" "src/index.ts"

run_case "feat(scope)!: breaking with scope + src/** allowed" 0 \
  "feat(cli)!: rename --flag" "src/cli/options.ts"

# --- ALLOW: non-feat/fix prefixes regardless of files ---

run_case "chore: with .claude/** only allowed" 0 \
  "chore(review-pr): update bias bucket" ".claude/skills/review-pr/SKILL.md"

run_case "docs: with docs/** only allowed" 0 \
  "docs: tighten state-management note" "docs/state-management.md"

run_case "test: with tests/** only allowed" 0 \
  "test: cover edge case" "tests/unit/foo.test.ts"

run_case "refactor: without src/** allowed (no version bump)" 0 \
  "refactor: rename helper" ".claude/hooks/foo.sh"

run_case "perf: without src/** allowed" 0 \
  "perf: streamline" ".claude/hooks/foo.sh"

run_case "style: without src/** allowed" 0 \
  "style: format" "docs/state-management.md"

run_case "ci: without src/** allowed" 0 \
  "ci: update workflow" ".github/workflows/main.yml"

run_case "build: without src/** allowed" 0 \
  "build: bump tsdown" "package.json"

# --- ALLOW: pass-through cases ---

run_case "non-conventional subject allowed (no prefix)" 0 \
  "just a plain message" ".claude/hooks/foo.sh"

run_case "non-git command always allowed" 0 \
  "feat: bogus" "src/foo.ts"  # but we'll override with a non-git cmd below
# overwrite manually to test non-git
{
  payload=$(jq -cn --arg c 'ls -la' '{tool_input:{command:$c}}')
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  if [[ "$?" == "0" ]]; then pass=$((pass + 1)); printf 'OK   non-git ls allowed (exit 0)\n'
  else fail=$((fail + 1)); printf 'FAIL non-git ls (want 0, got %s)\n' "$?"; fi
}

run_case "git status (not commit) allowed" 0 \
  "feat: bogus" "src/foo.ts"
{
  payload=$(jq -cn --arg c 'git status' '{tool_input:{command:$c}}')
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  if [[ "$?" == "0" ]]; then pass=$((pass + 1)); printf 'OK   git status allowed (exit 0)\n'
  else fail=$((fail + 1)); printf 'FAIL git status (want 0, got %s)\n' "$?"; fi
}

run_case "amend (skip subject inspection) allowed" 0 \
  "feat: anything" "tests/unit/foo.test.ts" "amend"

run_case "plain git commit (editor will open, no subject available) allowed" 0 \
  "" "tests/unit/foo.test.ts" "plain"

# --- ALLOW: revert: passes through regardless ---

run_case "revert: feat with no src/** allowed" 0 \
  "revert: feat(review-pr): add bucket entry" ".claude/skills/review-pr/SKILL.md"

# --- ALLOW: -F file shape with src/** present ---

run_case "feat via -F file with src/** allowed" 0 \
  "feat: add flag" "src/cli/options.ts" "F"

# --- BLOCK: feat/fix without src/** ---

run_case "feat: with .claude/** only BLOCKED" 2 \
  "feat(review-pr): add bucket entry" ".claude/skills/review-pr/SKILL.md"

run_case "feat: with docs/** only BLOCKED" 2 \
  "feat: document new pattern" "docs/cli-reference.md"

run_case "feat: with tests/** only BLOCKED" 2 \
  "feat: cover the case" "tests/unit/foo.test.ts"

run_case "fix: with .claude/** only BLOCKED" 2 \
  "fix(hook): pattern bug" ".claude/hooks/foo.sh"

run_case "fix: with docs/** only BLOCKED" 2 \
  "fix: docs typo" "docs/troubleshooting.md"

run_case "feat(scope): with mixed non-src BLOCKED" 2 \
  "feat(review-pr): bump tier" ".claude/skills/review-pr/SKILL.md,docs/cli-reference.md"

run_case "feat: with package.json only BLOCKED" 2 \
  "feat: add dep" "package.json"

run_case "feat!: breaking, no src/** BLOCKED" 2 \
  "feat!: rename skill" ".claude/skills/review-pr/SKILL.md"

# --- BLOCK: via -F file shape ---

run_case "feat: via -F file, .claude/** only BLOCKED" 2 \
  "feat(review-pr): add bucket entry" ".claude/skills/review-pr/SKILL.md" "F"

# --- BLOCK / PASS: via `-F -` heredoc shape (the #1455 blind spot) ---
#
# `-F -` matched the path parser, resolved to a nonexistent "<dir>/-", left
# the subject empty and fell through to the pass-through. It let a
# `fix(hooks):` commit touching only `.claude/**` land -- on the very commit
# that fixed #1455. The heredoc form is what commit-msg-heredoc-gate.sh
# steers people toward, so it is the common shape here, not a rare one.

run_case "fix: via -F - heredoc, .claude/** only BLOCKED" 2 \
  "fix(hooks): match verbs in command position" ".claude/hooks/verify-pr-gate.sh" "Fdash"

run_case "chore: via -F - heredoc, .claude/** only passes" 0 \
  "chore(hooks): match verbs in command position" ".claude/hooks/verify-pr-gate.sh" "Fdash"

run_case "feat: via -F - heredoc with src/** passes" 0 \
  "feat(cli): add flag" "src/cli/options.ts" "Fdash"

# --- BLOCK: variant subject formats ---

run_case "feat: with --message= form BLOCKED" 2 \
  "feat: bogus" ".claude/hooks/foo.sh"
{
  files=".claude/hooks/foo.sh"
  tmpdir=$(mktemp -d)
  ( cd "$tmpdir" && git init -q && git config user.email t@t && git config user.name t ) >/dev/null 2>&1
  mkdir -p "$tmpdir/$(dirname "$files")"
  echo x > "$tmpdir/$files"
  ( cd "$tmpdir" && git add "$files" ) >/dev/null 2>&1
  cmdstr=$(printf 'git -C %q commit --message="feat: bogus"' "$tmpdir")
  payload=$(jq -cn --arg c "$cmdstr" '{tool_input:{command:$c}}')
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  if [[ "$?" == "2" ]]; then pass=$((pass + 1)); printf 'OK   --message= form blocked (exit 2)\n'
  else fail=$((fail + 1)); printf 'FAIL --message= form (want 2, got %s)\n' "$?"; fi
  rm -rf "$tmpdir"
}

# --- Command matching (issue #2129) -----------------------------------------
# The gate must see its verb wherever it sits in the command list, and must NOT
# fire on a quoted MENTION of it. Both directions, or the matcher is untested.
run_case "compound: git add -A && git commit still blocks" 2 \
  "feat: document new pattern" "docs/cli-reference.md" compound
run_case "quoted mention of git commit does not fire" 0 \
  "feat: document new pattern" "docs/cli-reference.md" quoted

echo
# --- an UNRESOLVABLE -F path must fail CLOSED -------------------------------
# Measured on the real repo before this: `git commit -F "$S/msg.txt"` carrying a
# `fix(hooks):` subject with nothing under `src/**` staged went through at rc=0,
# while the identical commit with a LITERAL path gave rc=2. A gate that can be
# switched off by writing the path into a variable first is not a gate. The
# PREFIX is irrelevant to the refusal -- the hook cannot read the message at
# all -- so the `chore:` case expects 2 as well, and that is the point rather
# than an oversight.
run_case "fix: via -F \$VAR (unreadable) BLOCKED" 2 \
  "fix(hooks): x" ".claude/hooks/a.sh" Fvar
run_case "chore: via -F \$VAR (unreadable) BLOCKED too" 2 \
  "chore(hooks): x" ".claude/hooks/a.sh" Fvar
run_case "feat: via -F <glob> BLOCKED" 2 \
  "feat(hooks): x" ".claude/hooks/a.sh" Fglob
# The carve-out: `~/` IS resolved, so an absent file there stays a pass-through
# exactly as an absent literal path does -- git will report it itself.
run_case "-F ~/absent file passes through" 0 \
  "fix(hooks): x" ".claude/hooks/a.sh" Ftilde
run_case "fix: via -F <bracket glob> BLOCKED" 2 \
  "fix(hooks): x" ".claude/hooks/a.sh" Fbracket
run_case "fix: via --file \$VAR BLOCKED" 2 \
  "fix(hooks): x" ".claude/hooks/a.sh" FileVar
run_case "fix: via --file '\$VAR' BLOCKED" 2 \
  "fix(hooks): x" ".claude/hooks/a.sh" FileVarSq
# The other two shapes the shared word class buys, both previously unreachable
# by the five-arm enumeration. These are FAIL-OPEN closures, not refusals of an
# unreadable path: the file exists and is read, and the prefix is judged.
run_case "fix: via -F <quoted path with a space> BLOCKED" 2 \
  "fix(hooks): x" ".claude/hooks/a.sh" Fspace
run_case "fix: via glued -F<path> BLOCKED" 2 \
  "fix(hooks): x" ".claude/hooks/a.sh" Fglued
run_case "chore: via -F <quoted path with a space> allowed" 0 \
  "chore(hooks): x" ".claude/hooks/a.sh" Fspace

echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
