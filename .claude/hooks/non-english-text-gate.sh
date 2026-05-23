#!/usr/bin/env bash
# non-english-text-gate.sh
#
# PreToolUse hook. Blocks `gh pr create` / `gh pr edit` / `gh pr merge`
# when the PR diff contains non-ASCII writing-system characters:
# hiragana, katakana, CJK ideographs (kanji / Chinese), Hangul, or CJK
# punctuation. The repo is OSS and the workflow rule "English-only for
# committed files" forbids those.
#
# WHY: PR #521 (integ-schema-migration gate) shipped with verbatim
# Japanese session quotes embedded in `.markgate.yml` and the hook
# header comment. The English-only rule (memory
# `feedback_oss_english_only.md`) was honor-system at the time; nothing
# structural caught the violation, so the user had to spot it
# post-merge and we had to open PR #523 as a fix-up. This hook closes
# the gap.
#
# Why PR-level (not per-commit):
#   - Empirically violations are 1-2 files (PR #521 was 2). The pattern
#     is "verbatim paste of a session quote" or "intentional non-ASCII
#     text" — not the kind of mistake that accumulates across N commits.
#   - Per-commit scanning is also viable (~30-150ms / commit on
#     measured shapes) but compounds: a 30-commit PR pays the cost 30x.
#     PR-level scanning runs once (~234ms on PR #522's 29-file diff),
#     so the user-visible overhead is zero in the steady state.
#   - Strength-wise the gate is equivalent to a per-commit hook because
#     it blocks `gh pr merge` itself — every code path that lands a
#     commit on main goes through that one call.
#
# Scope:
#   - Triggers on `gh pr create` / `gh pr edit` / `gh pr merge` (and
#     their `gh -C <path> ...` forms). Everything else passes through.
#   - Detects the PR by `gh pr view --json number` from the resolved
#     target working tree (same cwd-resolution shape as branch-gate.sh
#     / internal-pr-labels-gate.sh).
#   - Walks every file in the PR diff (added or modified, not deleted)
#     via `gh pr diff <N> --name-only`. The post-PR file content is
#     fetched via `gh api repos/<owner>/<repo>/contents/<file>?ref=<sha>`
#     so the gate works even before the branch is checked out locally.
#   - Skips known binary / lockfile / asset extensions where the bytes
#     can legitimately carry non-ASCII content (PNGs / fonts / lockfile
#     author names / etc.).
#
# Detection: a single `grep -nP` run per touched file against the
# combined character class of:
#   U+3000-U+303F   CJK Symbols and Punctuation (Japanese quotes etc.)
#   U+3040-U+309F   Hiragana
#   U+30A0-U+30FF   Katakana
#   U+4E00-U+9FFF   CJK Unified Ideographs (kanji / Chinese)
#   U+AC00-U+D7AF   Hangul Syllables
# The ranges deliberately exclude general-purpose Unicode that the repo
# already uses (em-dashes, curly quotes, box-drawing chars in CLAUDE.md
# ASCII art, arrow glyphs in docs).
#
# Fails open when `gh` is missing or the PR cannot be resolved (matches
# post-merge-orphan-push-gate.sh's contract so a fresh machine still
# works).
#
# No bypass marker — the fix is trivial (translate the text). If a test
# fixture ever genuinely needs Japanese content (Unicode-handling
# tests), add a sidecar allow-list file like the integ-coverage gate
# uses; v1 ships without that mechanism.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate gh pr create / edit / merge — anything else passes through.
if ! printf '%s' "$cmd" | grep -qE '\bgh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+(create|edit|merge)\b'; then
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

# gh missing or unauthenticated — fail open.
if ! command -v "${GH_BIN:-gh}" >/dev/null 2>&1; then
  exit 0
fi
GH="${GH_BIN:-gh}"
if ! "$GH" -C "$target_dir" auth status >/dev/null 2>&1; then
  exit 0
fi

# Resolve target PR number.
#
#   `gh pr merge <N>` / `gh pr edit <N>` — N is the explicit arg.
#   `gh pr create` / `gh pr merge` (no arg) — current branch's PR.
pr_number=""
if [[ "$cmd" =~ gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+(merge|edit)[[:space:]]+([0-9]+) ]]; then
  pr_number="${BASH_REMATCH[3]}"
fi

if [[ -z "$pr_number" ]]; then
  pr_number=$("$GH" -C "$target_dir" pr view --json number -q .number 2>/dev/null || true)
fi

# No PR yet (typical `gh pr create` on a fresh branch) — fall back to
# scanning the local diff against the default base branch.
use_local_diff=0
if [[ -z "$pr_number" ]]; then
  use_local_diff=1
fi

# File-list resolution.
if [[ "$use_local_diff" -eq 1 ]]; then
  base_ref=$(git -C "$target_dir" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||')
  base_ref="${base_ref:-main}"
  merge_base=$(git -C "$target_dir" merge-base "origin/$base_ref" HEAD 2>/dev/null || true)
  if [[ -z "$merge_base" ]]; then
    # Can't establish a base — silently pass (CI / detached HEAD).
    exit 0
  fi
  changed_files=$(git -C "$target_dir" diff "$merge_base..HEAD" --name-only --diff-filter=AM 2>/dev/null || true)
else
  changed_files=$("$GH" -C "$target_dir" pr diff "$pr_number" --name-only 2>/dev/null || true)
fi

if [[ -z "$changed_files" ]]; then
  exit 0
fi

# Skip binary / lockfile / asset extensions.
should_scan() {
  local f="$1"
  case "$f" in
    *.png|*.jpg|*.jpeg|*.gif|*.svg|*.ico|*.webp|*.pdf) return 1 ;;
    *.woff|*.woff2|*.ttf|*.eot|*.otf) return 1 ;;
    *.zip|*.tar|*.gz|*.tgz|*.bz2|*.7z|*.xz) return 1 ;;
    *.mp3|*.mp4|*.wav|*.ogg|*.webm|*.mov) return 1 ;;
    pnpm-lock.yaml|package-lock.json|yarn.lock|Cargo.lock|go.sum) return 1 ;;
    *.lock) return 1 ;;
  esac
  return 0
}

# Matcher implemented in perl (not `grep -P`) because BSD `grep` on
# macOS does not support PCRE / `-P`. `perl -CSD` reads STDIN as UTF-8
# and writes STDOUT as UTF-8, so the Unicode ranges below work in
# either system.
NON_ENGLISH_PERL='print "$.:$_" if /[\x{3000}-\x{303F}\x{3040}-\x{309F}\x{30A0}-\x{30FF}\x{4E00}-\x{9FFF}\x{AC00}-\x{D7AF}]/'

declare -a OFFENDERS=()
MAX_REPORT=20

# For PR-mode we need each file's content at the PR HEAD sha. Fetch the
# sha once.
pr_head_sha=""
if [[ "$use_local_diff" -eq 0 ]]; then
  pr_head_sha=$("$GH" -C "$target_dir" pr view "$pr_number" --json headRefOid -q .headRefOid 2>/dev/null || true)
fi

read_file_content() {
  local f="$1"
  if [[ "$use_local_diff" -eq 1 ]]; then
    git -C "$target_dir" show "HEAD:$f" 2>/dev/null
  else
    if [[ -n "$pr_head_sha" ]]; then
      # Prefer local git when the PR sha is present locally — avoids a
      # network call per file.
      git -C "$target_dir" show "$pr_head_sha:$f" 2>/dev/null && return 0
    fi
    # Fall back to fetching from the API.
    "$GH" -C "$target_dir" api "repos/{owner}/{repo}/contents/$f?ref=${pr_head_sha:-HEAD}" -q .content 2>/dev/null | base64 -d 2>/dev/null
  fi
}

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if ! should_scan "$f"; then
    continue
  fi

  while IFS=: read -r ln content; do
    [[ -z "$ln" ]] && continue
    OFFENDERS+=("$f:$ln:$content")
    if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
      break 2
    fi
  done < <(read_file_content "$f" | perl -CSD -ne "$NON_ENGLISH_PERL" 2>/dev/null || true)
done <<< "$changed_files"

if [[ "${#OFFENDERS[@]}" -eq 0 ]]; then
  exit 0
fi

if [[ -t 2 ]]; then
  RED_BOLD=$'\033[1;31m'
  RESET=$'\033[0m'
else
  RED_BOLD=""
  RESET=""
fi

scope_label="PR #$pr_number"
[[ "$use_local_diff" -eq 1 ]] && scope_label="local diff (origin/$base_ref..HEAD)"

{
  echo "${RED_BOLD}Blocked by non-english-text-gate:${RESET}"
  echo
  echo "$scope_label contains non-English writing-system characters"
  echo "(hiragana / katakana / kanji / Chinese / hangul / CJK punctuation)."
  echo
  echo "This is an OSS repo. Every committed artifact must be English-only"
  echo "per the workflow rule: source code, shell scripts, hook messages,"
  echo "config files, docs, comments, commit messages, PR titles/bodies."
  echo "Conversation in chat may be in any language — this rule applies"
  echo "only to files that land in the repository."
  echo
  echo "Found:"
  for entry in "${OFFENDERS[@]}"; do
    file="${entry%%:*}"
    rest="${entry#*:}"
    ln="${rest%%:*}"
    content="${rest#*:}"
    echo "  $file:$ln: $content"
  done
  echo
  echo "Fix:"
  echo "  - Translate the offending text to English."
  echo "  - For docstrings / comments: rewrite in English."
  echo "  - For verbatim session quotes (PR #521 trap): rewrite as a"
  echo "    project-level contract statement, not as a quote."
  echo "  - Open a follow-up commit on the same branch and push; this"
  echo "    hook re-runs against the new HEAD."
  echo
  echo "Memory: ~/.claude/projects/-Users-goto-pc-github-cdkd/memory/feedback_oss_english_only.md"
} >&2

exit 2
