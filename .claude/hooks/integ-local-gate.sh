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
# The same scope guard applies to `git merge [flags] <ref>` (issue
# #1204): the incoming diff is enumerated locally via the merge-base
# three-dot form (`git diff --name-only HEAD...<ref>`), so the routine
# post-squash-merge `git merge --ff-only origin/main` sync of a
# non-local range passes through even when the marker is stale.
# Unparsable shapes (`--abort` / `--continue` / octopus / unresolvable
# refs) still fall through to the unconditional verify.
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
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! { cmd_matches_verb "$cmd" 'gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])' \
     || cmd_matches_verb "$cmd" 'git[^|;&]*[[:space:]]merge([[:space:]]|$|[|;&`)])'; }; then
  exit 0
fi

# Start from the Bash session's persisted cwd; fall back to the hook
# process's own cwd if the payload did not include a `cwd` field.
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
# BOTH guarded verbs, or the `-C` of the one left out would go unread: this
# hook is the only gate that fires on `git merge` as well as `gh pr merge`.
__verb_ere='(gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])|git[^|;&]*[[:space:]]merge([[:space:]]|$|[|;&`)]))'
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "integ-local-gate" "${hook_cwd:-$PWD}"
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
# Applies to `gh pr merge <N>` (file list via `gh pr view <N> --json
# files`) AND to `git merge [flags] <ref>` (incoming range enumerated
# locally, see the git-merge branch below; issue #1204). Number-less
# `gh pr merge` falls through to the unconditional verify below
# (conservative — we cannot cheaply enumerate the incoming diff there).
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

# --- git-merge incoming-diff scope check (issue #1204) ---
# For `git merge [flags] <ref>` the incoming diff IS cheaply enumerable
# locally: `git diff --name-only HEAD...<ref>` (merge-base three-dot).
# The most frequent main-tree `git merge` is the post-squash-merge
# `git merge --ff-only origin/main` sync, which the previous
# unconditional verify blocked whenever the main tree's marker was
# stale — the steady state, since local-* integs only run in feature
# worktrees. That block bought nothing (`git pull` / `git rebase` are
# not gated, so the equivalent command side-stepped it); pure friction.
# Parse the merge ref and apply the same LOCAL_SCOPE_REGEX check as the
# `gh pr merge <N>` path above. Bail conservatively (fall through to
# the unconditional verify) on `--abort` / `--continue` / `--quit`,
# octopus (2+ refs), a ref we cannot resolve, or an unparsable shape.
if cmd_matches_verb "$cmd" 'git[^|;&]*[[:space:]]merge([[:space:]]|$|[|;&`)])' \
  && ! printf '%s' "$cmd" | grep -qE 'gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge'; then
  merge_ref=""
  parse_ok=1
  # Locate the `merge` subcommand token by walking the git invocation's
  # tokens (a naive `${cmd#*merge}` slice would cut inside a path
  # component containing "merge", e.g. a worktree named .../x-merge).
  # Strip a leading `cd <path> && ` prefix first, then truncate at the
  # first pipeline / chain separator.
  git_seg="$cmd"
  if [[ "$git_seg" =~ ^[[:space:]]*cd[[:space:]]+[^[:space:]]+[[:space:]]*\&\&[[:space:]]*(.*)$ ]]; then
    git_seg="${BASH_REMATCH[1]}"
  fi
  git_seg="${git_seg%%[;|&\`]*}"
  merge_args=""
  seen_merge=0
  # shellcheck disable=SC2086
  set -- $git_seg
  if [ "${1:-}" = "git" ]; then
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        -C|-c|--git-dir|--work-tree|--namespace|--exec-path)
          # Value-taking git global options.
          shift; [ $# -gt 0 ] && shift ;;
        merge)
          shift; seen_merge=1; merge_args="$*"; break ;;
        -*)
          shift ;;
        *)
          # Unexpected bare token before `merge` — not a git-merge
          # shape we can parse; bail to the unconditional verify.
          break ;;
      esac
    done
  fi
  if [ "$seen_merge" -eq 0 ]; then
    parse_ok=0
  fi
  # shellcheck disable=SC2086
  set -- $merge_args
  while [ $# -gt 0 ]; do
    case "$1" in
      --abort|--continue|--quit)
        # In-progress-merge control commands; no incoming range exists.
        parse_ok=0; break ;;
      -m|-F|--file|-X|--strategy-option|-s|--strategy|-S|--gpg-sign|--cleanup|--into-name)
        # Value-taking flags: skip the value too. A quoted multi-word
        # value word-splits into stray tokens, which the octopus guard
        # below then rejects conservatively.
        shift; [ $# -gt 0 ] && shift ;;
      --*=*|-*)
        shift ;;
      *)
        if [ -n "$merge_ref" ]; then
          # Two+ refs = octopus merge — fall through to the verify.
          parse_ok=0; break
        fi
        merge_ref="$1"
        shift ;;
    esac
  done

  if [ "$parse_ok" -eq 1 ] && [ -n "$merge_ref" ] \
    && git rev-parse --verify --quiet "${merge_ref}^{commit}" >/dev/null 2>&1; then
    if incoming=$(git diff --name-only "HEAD...${merge_ref}" 2>/dev/null); then
      touches_local=0
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        if printf '%s' "$f" | grep -qE "$LOCAL_SCOPE_REGEX"; then
          touches_local=1
          break
        fi
      done <<EOF_INCOMING
$incoming
EOF_INCOMING
      # No local-execution file in the incoming range -> gate does not apply.
      if [ "$touches_local" -eq 0 ]; then
        exit 0
      fi
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
  printf "Blocked by integ-local-gate: this merge touches local-execution code and the \`integ-local\` marker is stale %s.\n\n" "$reason" >&2
else
  cat >&2 <<'EOF_HEAD'
Blocked by integ-local-gate: this merge touches local-execution code
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
