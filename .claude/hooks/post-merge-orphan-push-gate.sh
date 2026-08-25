#!/usr/bin/env bash
# post-merge-orphan-push-gate.sh
#
# PreToolUse hook. Blocks `git push <remote> <branch>` (also `git push -u`,
# `git push --set-upstream`, `git -C <path> push ...`) when the target
# branch is the head ref of an already-MERGED PR on origin. This closes
# the structural gap exposed by PR #263 (see memory
# feedback_post_merge_orphan_push.md):
#
#   1. `gh pr merge` lands the PR.
#   2. GitHub's `delete_branch_on_merge: true` deletes the source branch.
#   3. A follow-up `git push` to the same branch name SUCCEEDS — it just
#      re-creates the deleted branch as a fresh orphan ref no PR is
#      tracking. The change never reaches main and the assistant has no
#      signal anything is wrong.
#
# This hook detects step 3 and refuses the push, telling the user how to
# replay the orphan commits on a fresh branch off `main`.
#
# Scope guard — fires ONLY when ALL of the following hold:
#   - target remote is `origin` (the only GitHub remote we know how to
#     check; other remotes pass through)
#   - `gh pr list --head <branch> --state merged` returns a PR whose
#     `headRefName` matches `<branch>` exactly (defensive against
#     unexpected GitHub-side matching behavior)
#   - the PR's state is MERGED (not CLOSED-not-merged — a closed PR
#     might be reopened or its branch revived, both legitimate)
#
# When `gh` is not installed or not authenticated, we pass through with a
# stderr debug warning — failing closed would block every push on a fresh
# machine. The gate is defense-in-depth, not the load-bearing safety.
#
# Mock strategy for the smoke test: $GH_BIN, if set, overrides the
# resolved `gh` binary. The test injects a per-case shell script that
# emits the desired `gh pr list ... --json ...` response.

# Shared command-position matcher (issue #1455): catches the guarded verb
# after ANY chained command (`git push && gh pr create`), not just after an
# optional leading `cd`. See .claude/hooks/lib/command-match.sh.
# shellcheck source=lib/command-match.sh
__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash verify-pr-gate.sh` from inside the hooks dir), which would look for
# `<script-name>/lib/...`. Fall back to the cwd in that case.
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null \
  || ! declare -F gate_matches >/dev/null \
  || ! declare -F gate_target_dir_strict >/dev/null \
  || ! declare -F gate_refuse_unresolved_target >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F strip_noncommand_spans >/dev/null; then
  # FAIL CLOSED. Without the helper `cmd_matches_verb` is undefined, the
  # `if ! cmd_matches_verb ...` guard below sees exit 127 (truthy for `!`),
  # and the hook would `exit 0` -- silently disabling the gate, which is the
  # exact failure mode this file exists to prevent. Refuse instead.
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unloadable," >&2
  echo "so this gate cannot evaluate the command. Restore the file; do not" >&2
  echo "work around the gate." >&2
  exit 2
fi

set -u

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd. Reading via two separate jq invocations would consume stdin
# twice and the second read would see nothing.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `git push` — any other command passes through. Line-start
# anchored (per memory rule feedback_hook_command_match_line_start.md)
# so `git push` substrings inside quoted argument bodies
# (`gh issue create --body "remember to git push"`) do NOT
# false-positive into a hard block. The optional leading
# `cd <path> &&` prefix preserves the worktree-aware
# `cd <side> && git push` chain shape, mirroring check-gate.sh
# (PR #562 fix pattern). `[^|;&]*` matches any flag/value pairs
# between `git` and the subcommand without crossing pipeline
# separators. We intentionally do NOT gate deletion pushes — both the
# `git push origin :branch` refspec form and the `--delete` / `-d` flag
# form — see the explicit deletion check below.
if ! gate_matches "$cmd" "$GATE_RE_GIT_PUSH"; then
  exit 0
fi

# Resolve where the git command will actually run (cwd-aware, copied
# from branch-gate.sh — keep the two in sync if either gains new
# resolution shapes).
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
__verb_ere="$GATE_RE_GIT_PUSH"
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "post-merge-orphan-push-gate" "${hook_cwd:-$PWD}"
fi

# Parse `git push [...] <remote> <branch>` out of the command. We strip
# the `git ... push` prefix (incl. any `-C <path>` between `git` and
# `push`) and then walk the remaining tokens, skipping known flags that
# do not take a positional value (-u, --set-upstream, --force, etc.) and
# flag-with-value pairs (--repo <r>, -o <opt>, --push-option <opt>).
#
# We only need to recognise enough flags to land on the (remote, branch)
# pair for the common shapes; ambiguous / exotic forms fall through to
# the safe "pass through" branch.
push_args=""
# Find `push` and everything after it. The pattern intentionally tolerates
# the `git -C <path> push` form by ignoring the leading `git -C <path>`.
if [[ "$cmd" =~ [[:space:]]push([[:space:]]+(.*))?$ || "$cmd" =~ ^push([[:space:]]+(.*))?$ ]]; then
  # BASH_REMATCH[2] contains the post-`push` portion or empty.
  push_args="${BASH_REMATCH[2]:-}"
fi

# Strip trailing shell-redirection / chain noise (`>x`, `2>&1`,
# `&& foo`, `; foo`, `| foo`) so they do not pollute positional
# extraction. Whatever's after the first chain separator can't be a
# push arg anyway.
push_args="${push_args%%|*}"
push_args="${push_args%%;*}"
push_args="${push_args%%&&*}"
push_args="${push_args%%>*}"

# Tokenise. We use read -a so single-quoted args stay together by best
# effort; an exotic case like `git push origin "feature/x y"` (literal
# space in branch name) is rare enough that we accept missing it — the
# gate degrades to pass-through rather than mis-fire.
# shellcheck disable=SC2206
tokens=($push_args)

remote=""
branch=""
delete_push=0
i=0
while [ "$i" -lt "${#tokens[@]}" ]; do
  tok="${tokens[$i]}"
  case "$tok" in
    # Skip the trailing `git push` itself if it sneaks in.
    push) ;;
    # Flags that take NO value — skip just this token.
    -u|--set-upstream|-f|--force|--force-with-lease|--force-if-includes|\
    -n|--dry-run|-v|--verbose|-q|--quiet|--all|--tags|--follow-tags|\
    --mirror|--prune|--atomic|--no-verify|--verify|--progress|\
    --no-progress|--ipv4|--ipv6|-4|-6|--thin|--no-thin|--signed|\
    --no-signed|--porcelain|--no-recurse-submodules)
      ;;
    # DELETION, not a content push. Valueless like the group above, but it
    # inverts what the command MEANS, so it is recorded rather than skipped.
    # It sat in that group until 2026-08-25, which made the deletion check
    # below a claim the code did not implement: its comment already said
    # `git push origin --delete branch` passes through, while the code tested
    # only the `:branch` refspec form. So the gate refused the routine
    # post-merge `git push origin --delete <merged-branch>` -- naming the very
    # PR whose merge is the reason the branch should go -- and the advice it
    # printed (cherry-pick onto a new branch, open a new PR) was the opposite
    # of what the user wanted.
    -d|--delete)
      delete_push=1
      ;;
    # Flags that DO take a value — skip this token AND the next.
    # `--foo=bar` (single token, captured by *=*) — no extra skip.
    # `--foo bar` (two tokens) — skip the next token too.
    # `--recurse-submodules` has BOTH a flag-only form and a
    # `--recurse-submodules <mode>` form; we peek at the next token
    # before deciding to consume it.
    --repo|-o|--push-option|--receive-pack|--exec|--repo=*|\
    --push-option=*|-o=*|--receive-pack=*|--exec=*|--recurse-submodules|\
    --recurse-submodules=*)
      case "$tok" in
        *=*) ;;
        --recurse-submodules)
          next="${tokens[$((i + 1))]:-}"
          case "$next" in
            check|on-demand|only|no)
              i=$((i + 1))
              ;;
          esac
          ;;
        *)
          i=$((i + 1))
          ;;
      esac
      ;;
    # Any other --flag we don't know about — skip just this token, on
    # the assumption it's flag-only. False negatives (missing the gate
    # because of a flag we didn't model) are cheaper than blocking
    # legitimate pushes.
    -*) ;;
    # First positional → remote. Second positional → branch (refspec).
    *)
      if [ -z "$remote" ]; then
        remote="$tok"
      elif [ -z "$branch" ]; then
        branch="$tok"
      fi
      ;;
  esac
  i=$((i + 1))
done

# Default remote when omitted (e.g. `git push`).
if [ -z "$remote" ]; then
  remote="origin"
fi

# Bail out early when the remote isn't `origin`. The rule applies only
# to the GitHub origin remote — other remotes pass through.
if [ "$remote" != "origin" ]; then
  exit 0
fi

# `git push origin :branch` and `git push origin --delete branch` are
# explicit deletion requests, not content pushes — let them through.
# Likewise `git push origin <sha>:<branch>` (force-push from a specific
# sha) — we can't safely reason about whether the destination ref is
# the merged-PR's old head without parsing refspecs, so we pass through.
if [ "$delete_push" -eq 1 ] || [[ "$branch" == :* ]] || [[ "$branch" == *:* ]]; then
  exit 0
fi

# When the branch wasn't specified positionally (e.g. `git push origin`
# alone, or `git push -u origin` with no branch), derive the current
# branch from the resolved target dir.
if [ -z "$branch" ]; then
  branch=$(git -C "$target_dir" symbolic-ref --short HEAD 2>/dev/null || echo "")
fi

# If we still don't have a branch (detached HEAD, non-git dir), there's
# nothing to gate.
if [ -z "$branch" ]; then
  exit 0
fi

# Detached-HEAD-style refspecs like `HEAD` aren't a static branch name
# the user mistakenly re-pushed, so pass through.
case "$branch" in
  HEAD|refs/*) exit 0 ;;
esac

# Locate the gh binary. $GH_BIN, when set and executable, wins — this is
# the mock injection point for the smoke test. Otherwise look up on
# PATH. When gh is missing, pass through with a stderr debug note rather
# than failing closed.
if [ -n "${GH_BIN:-}" ] && [ -x "${GH_BIN}" ]; then
  gh_bin="${GH_BIN}"
elif command -v gh >/dev/null 2>&1; then
  gh_bin="$(command -v gh)"
else
  echo "post-merge-orphan-push-gate: gh not installed; skipping check." >&2
  exit 0
fi

# Query GitHub for any MERGED PR with this head ref. We use --limit 1
# because branch names are unique per repo (a branch can only have ever
# been the head ref of one PR at a time; if multiple PRs ever shared the
# name, the most-recently-merged one is the relevant one — that's the
# default ordering anyway).
#
# `gh pr list` exits non-zero on auth failure / network error. We treat
# that as "couldn't check" and pass through with a debug note — same
# fail-open posture as the missing-gh branch.
#
# The `cd` is load-bearing and its absence was a live CROSS-REPO FALSE POSITIVE.
# `gh` resolves the repo from its CWD, and it has no `-C` flag, so an unwrapped
# call here read THIS SESSION's repo rather than the push target. Measured
# 2026-08-25: a push to cdk-real-drift, whose PR go-to-k/cdk-real-drift#1815 was
# OPEN, was refused citing go-to-k/cdkd#2195 -- a different repo's MERGED PR
# that merely shared the branch name. These three repos name branches by
# convention (`chore/issue-dup-check` existed in both simultaneously), so the
# collision is the normal case, not a coincidence. The gate resolved
# `target_dir` correctly all along and then did not use it.
pr_json=$( (cd "$target_dir" 2>/dev/null && "${gh_bin}" pr list --head "$branch" --state merged --limit 1 \
            --json number,mergedAt,headRefName,title) 2>/dev/null || true)

if [ -z "$pr_json" ] || [ "$pr_json" = "null" ]; then
  echo "post-merge-orphan-push-gate: gh pr list failed or returned empty; skipping check." >&2
  exit 0
fi

# jq across an empty array returns "null" for `.[0]` — safe to query
# scalar fields directly with `// empty` as a defensive default.
pr_number=$(printf '%s' "$pr_json" | jq -r '.[0].number // empty' 2>/dev/null || echo "")
pr_head=$(printf '%s' "$pr_json" | jq -r '.[0].headRefName // empty' 2>/dev/null || echo "")
pr_merged_at=$(printf '%s' "$pr_json" | jq -r '.[0].mergedAt // empty' 2>/dev/null || echo "")
pr_title=$(printf '%s' "$pr_json" | jq -r '.[0].title // empty' 2>/dev/null || echo "")

# No PR matching this branch → nothing to gate.
if [ -z "$pr_number" ]; then
  exit 0
fi

# Defensive: the API returned a PR but its head ref doesn't match the
# branch we asked about. Could happen if `--head` matches loosely on a
# future GitHub-side change. Pass through rather than mis-fire.
if [ "$pr_head" != "$branch" ]; then
  exit 0
fi

# Block the push.
cat >&2 <<EOF
Blocked by post-merge-orphan-push-gate: branch '$branch' is the head ref
of MERGED PR #$pr_number (merged $pr_merged_at).

  PR title: $pr_title

GitHub's \`delete_branch_on_merge: true\` cleared the upstream branch
after merge; pushing now creates a fresh orphan ref no PR is tracking,
so the commits never reach main.

If the change should land on main:
  1. git switch main && git pull
  2. git switch -c <new-branch-off-main>
  3. cherry-pick or replay the commits from '$branch'
  4. push the new branch + open a new PR

If you genuinely want to re-create the deleted branch as an orphan ref
(rare — \`--no-verify\` is for git commit, not git push), push under a
different branch name and open a new PR for it, or temporarily disable
this hook in .claude/settings.json.
EOF
exit 2
