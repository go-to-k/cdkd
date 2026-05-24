#!/usr/bin/env bash
# pr-title-prefix-scope-gate.sh
#
# PreToolUse hook. Blocks `gh pr create --title "..."` and the
# working `gh api -X PATCH .../pulls/<N> -f title=...` form when the
# title uses a `feat:` or `fix:` conventional-commit prefix but the
# branch's diff against `origin/main` contains NO file under `src/**`.
#
# WHY: this is the PR-title side of `commit-prefix-scope-gate.sh`.
# `gh pr merge --squash` uses the PR title as the squashed commit
# subject, and semantic-release on main parses that subject to decide
# version bumps + CHANGELOG entries. So a PR whose LOCAL commits are
# all `chore:` (correctly typed by the per-commit gate) can still
# trigger a misleading release if the PR TITLE uses `fix:` or `feat:`.
#
# Concrete incident (2026-05-24 / cdkd#565): PR #562 (`.claude/**`-only
# diff: 7 markgate gate hooks made cwd-aware) was titled
# `fix(hooks): make markgate gate hooks cwd-aware (#559)`. Local
# commits were correct, but the PR title's `fix:` prefix shipped a
# misleading v0.145.1 patch release with the CHANGELOG entry
# `**hooks:** make markgate gate hooks cwd-aware` — readable as a
# user-facing cdkd hooks bug fix when the actual diff was internal
# Claude Code agent tooling only.
#
# Rule: if the PR title prefix is `feat:` or `fix:`, the branch diff
# (`git diff origin/main...HEAD --name-only`, 3-dot = merge-base
# style; matches what `gh pr diff` shows the user) must include at
# least one path under `src/**`. Anything else suggests internal dev
# tooling, docs, tests, or build infrastructure — none of which
# should trigger a user-facing release entry.
#
# Allowed prefixes for non-src-changing PRs (mirror commit-side gate):
#   chore:    build / tooling / .claude/** / hooks / skills / settings
#   docs:     README.md / CLAUDE.md / docs/**
#   test:     tests/** only
#   refactor: internal restructuring with no behavior change
#   perf, style, ci, build, revert: per conventional-commits
#
# Scope resolution mirrors check-gate.sh / branch-gate.sh: parse
# `cd <path>` and `gh -C <path>` from the command line, fall through
# to the hook's reported cwd. Silently skipped when the target dir
# is not a git repo (matches commit-prefix-scope-gate.sh's behavior
# on freshly-cloned trees with nothing staged).

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr create` and the `gh api -X PATCH .../pulls/...` form
# carrying a title= field. Anything else passes through. Line-start
# anchored per memory rule feedback_hook_command_match_line_start.md so
# this hook does not false-positive on commands that mention the
# trigger string in a quoted arg body.
is_pr_create=0
is_api_patch=0
if printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'; then
  is_pr_create=1
fi
if printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+api[[:space:]].*pulls/[0-9]+'; then
  is_api_patch=1
fi
if [[ "$is_pr_create" -eq 0 && "$is_api_patch" -eq 0 ]]; then
  exit 0
fi

# For api PATCH, require a title= field in the command (otherwise it's
# a body-only edit and we don't care about prefix).
if [[ "$is_api_patch" -eq 1 ]]; then
  if ! printf '%s' "$cmd" | grep -qE '[[:space:]](-f|-F|--field|--raw-field)[[:space:]]+title='; then
    exit 0
  fi
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

# Last `gh -C <path>` wins.
if [[ "$cmd" =~ gh[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ gh[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
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

# --- Extract title from the command ---
#
# `gh pr create` shapes (first match wins):
#   gh pr create --title "subject"
#   gh pr create --title 'subject'
#   gh pr create --title=subject       (rare; single token)
#
# `gh api` shapes (with -X PATCH + a -f title= / --field title= field):
#   gh api ... -f title="subject"
#   gh api ... -F title="subject"
#   gh api ... --field title="subject"
#   gh api ... --raw-field title="subject"
title=""

if [[ "$is_pr_create" -eq 1 ]]; then
  if [[ "$cmd" =~ [[:space:]]--title[[:space:]]+\"([^\"]+)\" ]]; then
    title="${BASH_REMATCH[1]}"
  elif [[ "$cmd" =~ [[:space:]]--title[[:space:]]+\'([^\']+)\' ]]; then
    title="${BASH_REMATCH[1]}"
  elif [[ "$cmd" =~ [[:space:]]--title=\"([^\"]+)\" ]]; then
    title="${BASH_REMATCH[1]}"
  elif [[ "$cmd" =~ [[:space:]]--title=\'([^\']+)\' ]]; then
    title="${BASH_REMATCH[1]}"
  elif [[ "$cmd" =~ [[:space:]]--title=([^[:space:]\;\&\|]+) ]]; then
    title="${BASH_REMATCH[1]}"
  fi
fi

if [[ "$is_api_patch" -eq 1 && -z "$title" ]]; then
  # -f / -F / --field / --raw-field title=...
  if [[ "$cmd" =~ [[:space:]](-f|-F|--field|--raw-field)[[:space:]]+title=\"([^\"]+)\" ]]; then
    title="${BASH_REMATCH[2]}"
  elif [[ "$cmd" =~ [[:space:]](-f|-F|--field|--raw-field)[[:space:]]+title=\'([^\']+)\' ]]; then
    title="${BASH_REMATCH[2]}"
  elif [[ "$cmd" =~ [[:space:]](-f|-F|--field|--raw-field)[[:space:]]+title=([^[:space:]\;\&\|]+) ]]; then
    title="${BASH_REMATCH[2]}"
  fi
fi

# No title found (e.g. `gh pr create` opens an editor without --title,
# or `gh api ... pulls/<N>` with no title field — body-only edit). Pass.
if [[ -z "$title" ]]; then
  exit 0
fi

# --- Identify the prefix ---
prefix=""
if [[ "$title" =~ ^([a-z]+)(\([^\)]+\))?!?:[[:space:]] ]]; then
  prefix="${BASH_REMATCH[1]}"
fi

if [[ -z "$prefix" ]]; then
  # Not a conventional-commit shape — pass. semantic-release skips
  # non-conforming subjects anyway.
  exit 0
fi

case "$prefix" in
  feat|fix) ;;        # subject to the scope check below
  revert)   exit 0 ;; # inner prefix carries; pass through
  *)        exit 0 ;; # chore / docs / test / refactor / perf / etc.
esac

# --- Check branch diff against origin/main for any src/** path ---
#
# Use a 3-dot diff so we look at what THIS branch adds on top of the
# merge-base with origin/main (matches the semantic-release "what does
# this PR ship" view). Fail open if origin/main is missing locally —
# the hook should not block on transient `git fetch` issues.
if ! git -C "$target_dir" rev-parse origin/main >/dev/null 2>&1; then
  exit 0
fi

diff_files=$(git -C "$target_dir" diff --name-only origin/main...HEAD 2>/dev/null || true)
if [[ -z "$diff_files" ]]; then
  # No diff against main — nothing to ship. The `gh pr create` itself
  # will fail with its own clearer error.
  exit 0
fi

has_src=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    src/*) has_src=1; break ;;
  esac
done <<< "$diff_files"

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

# Suggest the right prefix based on the diff mix (mirrors
# commit-prefix-scope-gate.sh's heuristic).
all_docs=1
all_tests=1
all_claude=1
all_deps=1
has_docs=0
has_tests=0
has_claude=0
has_deps=0

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    docs/*|README.md|CLAUDE.md|*/README.md) has_docs=1 ;;
    *) all_docs=0 ;;
  esac
  case "$f" in
    tests/*) has_tests=1 ;;
    *) all_tests=0 ;;
  esac
  case "$f" in
    .claude/*) has_claude=1 ;;
    *) all_claude=0 ;;
  esac
  case "$f" in
    package.json|pnpm-lock.yaml) has_deps=1 ;;
    *) all_deps=0 ;;
  esac
done <<< "$diff_files"

suggested="chore"
if [[ "$all_docs" -eq 1 && "$has_docs" -eq 1 ]]; then
  suggested="docs"
elif [[ "$all_tests" -eq 1 && "$has_tests" -eq 1 ]]; then
  suggested="test"
elif [[ "$all_claude" -eq 1 && "$has_claude" -eq 1 ]]; then
  suggested="chore"
elif [[ "$all_deps" -eq 1 && "$has_deps" -eq 1 ]]; then
  suggested="chore(deps)"
fi

{
  echo "${RED_BOLD}Blocked by pr-title-prefix-scope-gate:${RESET}"
  echo
  echo "PR title prefix '${prefix}:' triggers a semantic-release version"
  echo "bump AND lands in the user-facing CHANGELOG, but the branch diff"
  echo "against origin/main contains no file under src/**. The change is"
  echo "internal (dev tooling / docs / tests / build), not a cdkd CLI"
  echo "behavior change, and would mislead users reading the release notes."
  echo
  echo "Branch diff files (none in src/**):"
  count=0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    echo "  - $f"
    count=$((count + 1))
    if [[ "$count" -ge 20 ]]; then
      echo "  ...truncated (>20 files)"
      break
    fi
  done <<< "$diff_files"
  echo
  echo "Suggested title prefix: ${suggested}:"
  echo
  echo "Mapping:"
  echo "  src/**                                 -> feat: or fix:"
  echo "  docs/** / README.md / CLAUDE.md        -> docs:"
  echo "  tests/** only                          -> test:"
  echo "  .claude/** (hook / skill / agent)      -> chore:"
  echo "  package.json + pnpm-lock.yaml only     -> chore(deps):"
  echo "  build / CI / .gitignore / config       -> chore:"
  echo
  echo "Fix on an open PR with:"
  echo "  gh api -X PATCH repos/<owner>/<repo>/pulls/<N> -f title=\"${suggested}: ...\""
  echo
  echo "(Note: \`gh pr edit --title\` is blocked by gh-pr-edit-deprecation-gate;"
  echo " use the gh api form above.)"
  echo
  echo "Memory: ~/.claude/projects/-Users-goto-pc-github-cdkd/memory/feedback_pr_title_prefix_scope_match.md"
} >&2

exit 2
