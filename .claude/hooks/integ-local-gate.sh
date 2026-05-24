#!/usr/bin/env bash
# integ-local-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` (including --auto) and
# `git merge` unless the `integ-local` markgate marker is fresh for
# the current content state. The gate's scope (see .markgate.yml)
# covers every code path that participates in the `cdkd local *`
# family (Lambda RIE containers, ECS task emulation, HTTP server,
# container pool, etc.); editing any of them invalidates the marker
# and forces a successful Docker-based `/run-integ local-*` run
# before the PR can be merged.
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
