#!/usr/bin/env bash
# integ-local-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` (including --auto) and
# `git merge` when the merged PR actually touches local-execution code
# AND the `integ-local` markgate marker is not fresh. The gate's scope
# (see .markgate.yml) covers every code path that participates in the
# `cdkd local *` family (Lambda RIE containers, ECS task emulation,
# HTTP server, container pool, etc.); editing any of them invalidates
# the marker and forces a successful Docker-based `/run-integ local-*`
# run before the PR can be merged.
#
# IMPORTANT — PR-diff scope guard (see below): for `gh pr merge <N>`
# the hook first checks whether the PR's file list actually touches
# local-execution scope. A PR that touches NO local code passes
# through even when the marker is stale, mirroring integ-destroy-gate
# / integ-broad-gate (which already scope-check). Without this guard a
# stale marker (14d TTL expiry, or an unrelated src/local change
# already on main) would block EVERY merge, including pure
# src/provisioning PRs — the over-fire this guard fixes.
#
# This is the structural counterpart for local-execution changes,
# mirroring `integ-destroy-gate.sh` for deletion logic.
#
# WHY the cwd-aware resolution matters: this repo is regularly worked
# in via `git worktree`. Mirroring branch-gate.sh / integ-destroy-gate.sh,
# we read the actual git working tree the command will run against
# (via `git -C` or leading `cd <path>`) before consulting markgate.
#
# Resolution order for "where will the git/gh command actually run":
#   1. Explicit `git -C <path> merge` — last `-C` wins.
#   2. Leading `cd <path> && ...` — the cd target.
#   3. The hook input's `cwd` field.
#   4. The hook process's own $PWD.

set -u

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it. Reading via two separate jq invocations would
# consume stdin twice and the second read would see nothing.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge` and `git merge`. `gh pr create` is
# intentionally NOT gated — opening a PR for review should be allowed
# even when the local integ marker is stale; the gate only fires at
# merge time, mirroring the integ-destroy gate's policy.
#
# Line-start anchored (per memory rule
# feedback_hook_command_match_line_start.md) so `gh pr merge` /
# `git merge` substrings inside quoted argument bodies
# (`echo "remember to gh pr merge later"`) do NOT false-positive
# into a hard block. The optional leading `cd <path> &&` prefix
# preserves the worktree-aware `cd <side> && gh pr merge` /
# `cd <side> && git merge` chain shapes, mirroring check-gate.sh
# (PR #562 fix pattern). `[^|;&]*` matches flags / values between
# `gh`/`git` and the subcommand without crossing pipeline separators.
# Tolerate an optional `gh -C <path>` between `gh` and `pr`.
if ! printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])|^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?git[^|;&]*[[:space:]]merge([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

# Start from the Bash session's persisted cwd; fall back to the hook
# process's own cwd if the payload did not include a `cwd` field.
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

# Last `gh -C <path>` wins (gh's "run as if from <path>" flag).
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

# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see (mirrors branch-gate.sh).
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

# --- PR-diff scope check (mirrors integ-destroy-gate.sh / integ-broad-gate.sh) ---
# The markgate scope (.markgate.yml) is file-level, but markgate `verify`
# cannot tell whether THIS PR's diff actually touches local-execution code.
# Without this guard a stale `integ-local` marker (14d TTL expiry, or an
# unrelated src/local change already on main) blocks EVERY merge — including
# PRs that touch no local code at all (e.g. a pure src/provisioning fix).
# The sibling gates integ-destroy / integ-broad already scope-check their
# diff and pass non-matching PRs through; integ-local must do the same.
#
# Only applies to `gh pr merge <N>` where we can fetch the PR's file list.
# `git merge` and number-less `gh pr merge` fall through to the
# unconditional verify below (conservative — those are rarer and we
# cannot cheaply enumerate the incoming diff).
LOCAL_SCOPE_REGEX='^src/local/|^src/cli/commands/local-[A-Za-z0-9_-]*\.ts$|^tests/integration/local-'

if printf '%s' "$cmd" | grep -qE 'gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge'; then
  pr_number=""
  args="${cmd#*merge}"
  # shellcheck disable=SC2086
  set -- $args
  while [ $# -gt 0 ]; do
    case "$1" in
      --*=*) shift; continue ;;
      --auto|--admin|--delete-branch|--squash|--merge|--rebase) shift; continue ;;
      -*) shift; [ $# -gt 0 ] && shift; continue ;;
      *)
        if printf '%s' "$1" | grep -qE '^[0-9]+$'; then
          pr_number="$1"
          break
        fi
        shift
        ;;
    esac
  done

  if [ -n "$pr_number" ]; then
    # Pass-through on any gh error so an unrelated infra outage does not
    # block merges (mirrors integ-broad-gate.sh / pr-review-gate.sh).
    pr_json=$(gh pr view "$pr_number" --json files 2>/dev/null) || {
      printf 'integ-local-gate: gh pr view %s failed; allowing merge (infra fail-open)\n' "$pr_number" >&2
      exit 0
    }
    paths=$(printf '%s' "$pr_json" | jq -r '.files[].path' 2>/dev/null || echo "")
    touches_local=0
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      if printf '%s' "$f" | grep -qE "$LOCAL_SCOPE_REGEX"; then
        touches_local=1
        break
      fi
    done <<EOF_FILES
$paths
EOF_FILES
    # No local-execution file in the PR diff -> this gate does not apply.
    if [ "$touches_local" -eq 0 ]; then
      exit 0
    fi
  fi
fi

# Prefer the `.mise.toml`-pinned version via `mise exec --` so the repo's
# canonical markgate wins over an older PATH binary; see check-gate.sh for
# the schema-bump rationale (0.3.0 markers are silently invisible to 0.3.1).
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by integ-local-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify integ-local >/dev/null 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

# Extract the parenthesized reason from `markgate status integ-local` so
# the error message tells the user *why* the gate is stale. With markgate
# 0.3+ the gate carries `ttl: 14d`, so a stale marker is either "(digest
# differs)" (a local-execution-relevant file changed) or "(expired by
# ttl: 14d, marker is Nd old)" (the marker simply aged out and the
# Docker / RIE behavior it verified is no longer plausibly current).
# Distinguishing the two avoids the "but I didn't change anything" confusion.
# Fails open to a generic message when extraction fails.
reason=$("${markgate[@]}" status integ-local 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

if [ -n "$reason" ]; then
  printf "Blocked by integ-local-gate: this PR touches local-execution code and the \`integ-local\` marker is stale %s.\n\n" "$reason" >&2
else
  cat >&2 <<'EOF_HEAD'
Blocked by integ-local-gate: this PR touches local-execution code
(src/local/**, src/cli/commands/local-*.ts, or
tests/integration/local-*) and the `integ-local` marker is stale.

EOF_HEAD
fi

cat >&2 <<'EOF'
Required action — no exceptions:
  /run-integ local-invoke           # or local-start-api / local-run-task /
                                    # local-invoke-container / local-invoke-from-state /
                                    # local-invoke-layers / local-invoke-python /
                                    # local-invoke-ruby / local-invoke-java /
                                    # local-invoke-dotnet / local-invoke-provided

The skill is the ONLY legitimate setter of this marker. It runs the
Docker-based `cdkd local *` test (no AWS deploy needed for most
local-* tests) and only calls `markgate set integ-local` if BOTH of
the following hold:
  - the local-integ run exited cleanly
  - 0 orphan containers / networks after the post-run docker sweep

Do NOT call `markgate set integ-local` directly from a shell to
bypass this hook. The whole point of the gate is that an unverified
local code path cannot reach main; setting the marker by hand defeats
it. If you believe the file in scope is genuinely unrelated to local
execution, the right fix is to narrow `.markgate.yml` integ-local
scope, not to bypass the marker.
EOF
exit 2
