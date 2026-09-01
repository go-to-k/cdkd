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
# No bypass marker — the fix is trivial (translate the text). The one
# exception is the sidecar allow-list this header used to describe as
# unbuilt: `.claude/hooks/non-english-allowlist.txt`, added once the
# window it exists for actually closed on a lane. The gate reads each
# changed file's WHOLE content at the PR head, not just the added
# lines, so a file that legitimately CONTAINS the characters blocks
# every PR that touches it, for a reason unrelated to the change. Two
# files qualify and both are ones where the characters ARE the subject
# (this gate's body-side twin's own suite; a docker-argument fixture);
# see that file for why each is there and why prose does not qualify.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate gh pr create / edit / merge — anything else passes through.
# Recognition goes through the shared matcher (.claude/hooks/lib/command-match.sh,
# issue #2129): heredoc bodies and quoted spans are neutralised, then the verb
# is matched in COMMAND POSITION with a `VAR=value` / `env` / `command` /
# `nohup` prefix skipped. So `git push && gh pr create --fill` fires, while a
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
  || ! declare -F gate_refuse_unresolved_target >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/lib/command-match.sh loaded but its API is incomplete (truncated file?)." >&2
  exit 2
fi
gate_matches "$cmd" "$GATE_RE_GH_PR_WRITE" || exit 0

# Where the gh command actually runs: the last `gh -C <path>` wins, else the
# last `cd <path>` in ANY segment before the verb (the previous form saw only a
# LEADING cd), else the payload cwd.
# FAIL CLOSED on a target this parser cannot read (go-to-k/cdkd#2027).
# gate_target_dir would DROP an unexpanded `-C "$W"` and judge the payload
# cwd instead -- measured as a silent pass when the violation lived in the
# target tree and the cwd was clean.
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GH_PR_WRITE"); then
  gate_refuse_unresolved_target "non-english-text-gate" "${hook_cwd:-$PWD}"
fi

# If the resolved target dir is not a git repo, silently pass.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# gh missing or unauthenticated — fail open.
#
# NOTE: `gh` has NO `-C` flag. `gh -C <dir> auth status` exits 1 with
# `unknown shorthand flag: 'C' in -C` (measured, gh 2.89.0), so the guard below
# used to fire UNCONDITIONALLY and this hook exited 0 before scanning anything —
# the OSS English-only rule had no diff-side enforcement at all. The suite did
# not see it because the injected `$GH_BIN` stub STRIPPED `-C`: a mock strictly
# more permissive than production, which is what hid the defect rather than
# exposing it. `gh` takes its repo from the CWD, so every call runs in a
# subshell that cds there. Found while porting a different gate to a sibling
# repo, where the same shape had made the same hook inert.
if ! command -v "${GH_BIN:-gh}" >/dev/null 2>&1; then
  exit 0
fi
GH="${GH_BIN:-gh}"
# ONE top-level cd, then bare `gh` calls -- the convention pr-review-gate.sh,
# integ-broad-gate.sh and ci-green-gate.sh already use. Five per-call subshells
# worked but gave the next editor five places to get wrong.
cd "$target_dir" 2>/dev/null || exit 0
if ! "$GH" auth status >/dev/null 2>&1; then
  exit 0
fi

# Resolve target PR number.
#
#   `gh pr merge <N>` / `gh pr edit <N>` — N is the explicit arg.
#   `gh pr create` / `gh pr merge` (no arg) — current branch's PR.
pr_number=""
# `gate_pr_selector` rather than a local `=~` with a positional BASH_REMATCH
# index. The hand-rolled `-C` pattern this replaced could not read a quoted path
# and stopped at `-C`, so `gh -R <repo> pr merge <N>` hid the number; moving to
# `$GATE_GH_C` fixed that but made the number `BASH_REMATCH[5]` -- an index into
# a SHARED pattern, which the go-to-k/cdkd#2200 widening shifts. The selector
# walks flags itself and returns the first non-flag token after the verb, so it
# also handles `gh pr merge --squash 552` and `gh pr merge -t 42 552`, which the
# old adjacent-token regex read as no number at all.
pr_number="$(gate_pr_selector "$cmd" "$GATE_RE_GH_PR_MERGE_OR_EDIT")"

if [[ -z "$pr_number" ]]; then
  pr_number=$("$GH" pr view --json number -q .number 2>/dev/null || true)
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
  changed_files=$("$GH" pr diff "$pr_number" --name-only 2>/dev/null || true)
fi

if [[ -z "$changed_files" ]]; then
  exit 0
fi

# The sidecar allow-list, read ONCE into a newline-delimited string rather than
# per file. Resolved against this hook's OWN directory, not the target repo: the
# list is part of the gate's definition, and a vendored copy of the hook in some
# other tree must not be able to widen it.
# The list is resolved to an ABSOLUTE path from this hook's own directory, and
# both halves of that are load-bearing.
#
# From THIS hook's directory, because the list is part of the gate's DEFINITION:
# resolving it relative to the target repo would let any repo the agent is
# induced to touch ship its own `non-english-allowlist.txt` and exempt whatever
# it likes. Measured: with the relative form, invoking the hook as
# `bash ./.claude/hooks/non-english-text-gate.sh` against a target repo carrying
# its own list took that list and returned 0.
#
# ABSOLUTE, because the scan `cd`s into the target directory further down. A
# relative `${BASH_SOURCE[0]%/*}` is relative to the ORIGINAL cwd, and
# settings.json registers this hook as `${CLAUDE_PROJECT_DIR:-.}/...`, so an
# unset variable makes BASH_SOURCE relative in the first place.
#
# The no-slash fallback tests the DIRECTORY, not the already-suffixed path: a
# path with no slash leaves `%/*` unchanged, so the old comparison against
# BASH_SOURCE could never be equal and the fallback was dead code -- the list
# then resolved under a directory named after the script and was silently
# absent (over-block, the safe direction, but inert).
_allow_dir="${BASH_SOURCE[0]%/*}"
[[ "$_allow_dir" == "${BASH_SOURCE[0]}" ]] && _allow_dir="."
_allow_dir="$(cd "$_allow_dir" 2>/dev/null && pwd -P)" || _allow_dir=""
ALLOWLIST_FILE=""
[[ -n "$_allow_dir" ]] && ALLOWLIST_FILE="${_allow_dir}/non-english-allowlist.txt"
ALLOWED=""
if [[ -n "$ALLOWLIST_FILE" && -r "$ALLOWLIST_FILE" ]]; then
  # Only a WHOLE-LINE comment is stripped. A trailing `s/#.*$//` would truncate
  # a path legitimately containing `#` to a prefix, and a prefix is exactly what
  # this list must never match on.
  ALLOWED=$(grep -v '^[[:space:]]*#' "$ALLOWLIST_FILE" | sed -e 's/[[:space:]]*$//' | grep -v '^$' || true)
fi

# Skip binary / lockfile / asset extensions, and the allow-listed paths.
should_scan() {
  local f="$1"
  # Exact match, never a glob: an entry must not silently widen to a directory.
  local entry
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    [[ "$f" == "$entry" ]] && return 1
  done <<<"$ALLOWED"
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
  pr_head_sha=$("$GH" pr view "$pr_number" --json headRefOid -q .headRefOid 2>/dev/null || true)
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
    "$GH" api "repos/{owner}/{repo}/contents/$f?ref=${pr_head_sha:-HEAD}" -q .content 2>/dev/null | base64 -d 2>/dev/null
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
  echo "Memory: ~/.claude/projects/-Users-goto-github-cdkd/memory/feedback_oss_english_only.md"
} >&2

exit 2
