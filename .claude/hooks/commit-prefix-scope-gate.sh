#!/usr/bin/env bash
# commit-prefix-scope-gate.sh
#
# PreToolUse hook. Blocks `git commit` when the commit message uses
# a `feat:` or `fix:` conventional-commit prefix but NO file under
# `src/**` is staged.
#
# WHY: semantic-release on main maps commit prefixes to version bumps:
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

# Only gate git commit — anything else passes through.
if ! printf '%s' "$cmd" | grep -qE '\bgit[^|;&]*\bcommit\b'; then
  exit 0
fi

target_dir="${hook_cwd:-$PWD}"

# Leading `cd <path> && ...` shifts the target dir.
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

# Last `git -C <path>` wins.
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
    c_target="${BASH_REMATCH[1]}"
    remaining="${remaining#*"${BASH_REMATCH[0]}"}"
  done
  c_target="${c_target%\"}"; c_target="${c_target#\"}"
  c_target="${c_target%\'}"; c_target="${c_target#\'}"
  if [[ "$c_target" != /* ]]; then
    c_target="$target_dir/$c_target"
  fi
  target_dir="$c_target"
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
  msg_file=""
  if [[ "$cmd" =~ [[:space:]]-F[[:space:]]+([^[:space:]\"\'\;\&\|]+) ]]; then
    msg_file="${BASH_REMATCH[1]}"
  elif [[ "$cmd" =~ [[:space:]]-F[[:space:]]+\"([^\"]+)\" ]]; then
    msg_file="${BASH_REMATCH[1]}"
  elif [[ "$cmd" =~ [[:space:]]-F[[:space:]]+\'([^\']+)\' ]]; then
    msg_file="${BASH_REMATCH[1]}"
  elif [[ "$cmd" =~ [[:space:]]--file[[:space:]]*=[[:space:]]*([^[:space:]\"\'\;\&\|]+) ]]; then
    msg_file="${BASH_REMATCH[1]}"
  elif [[ "$cmd" =~ [[:space:]]--file[[:space:]]+([^[:space:]\"\'\;\&\|]+) ]]; then
    msg_file="${BASH_REMATCH[1]}"
  fi
  if [[ -n "$msg_file" ]]; then
    # Resolve relative path against target_dir.
    if [[ "$msg_file" != /* ]]; then
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
  # commits enforce the shape via semantic-release's commit-analyzer
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
  echo "Commit prefix '${prefix}:' triggers a semantic-release version bump"
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
