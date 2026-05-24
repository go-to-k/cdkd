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
# separators. We intentionally do NOT match `git push origin :branch`
# (delete push) — see explicit deletion check below.
if ! printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?git[^|;&]*[[:space:]]push([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

# Resolve where the git command will actually run (cwd-aware, copied
# from branch-gate.sh — keep the two in sync if either gains new
# resolution shapes).
target_dir="${hook_cwd:-$PWD}"

# `cd <path>` at the start of the command shifts the target dir.
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

# `git -C <path>` beats any earlier cd; pick the LAST occurrence.
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
i=0
while [ "$i" -lt "${#tokens[@]}" ]; do
  tok="${tokens[$i]}"
  case "$tok" in
    # Skip the trailing `git push` itself if it sneaks in.
    push) ;;
    # Flags that take NO value — skip just this token.
    -u|--set-upstream|-f|--force|--force-with-lease|--force-if-includes|\
    -n|--dry-run|-v|--verbose|-q|--quiet|--all|--tags|--follow-tags|\
    --mirror|--prune|--delete|--atomic|--no-verify|--verify|--progress|\
    --no-progress|--ipv4|--ipv6|-4|-6|--thin|--no-thin|--signed|\
    --no-signed|--porcelain|--no-recurse-submodules)
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

# `git push origin :branch` (or `git push origin --delete branch`) is an
# explicit deletion request, not a content push — let it through.
# Likewise `git push origin <sha>:<branch>` (force-push from a specific
# sha) — we can't safely reason about whether the destination ref is
# the merged-PR's old head without parsing refspecs, so we pass through.
if [[ "$branch" == :* ]] || [[ "$branch" == *:* ]]; then
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
pr_json=$("${gh_bin}" pr list --head "$branch" --state merged --limit 1 \
            --json number,mergedAt,headRefName,title 2>/dev/null || true)

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
