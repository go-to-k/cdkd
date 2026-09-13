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
  || ! declare -F gate_matches >/dev/null \
  || ! declare -F gate_target_dir_strict >/dev/null \
  || ! declare -F gate_refuse_unresolved_target >/dev/null \
  || ! declare -F gate_resolve_marker_gate >/dev/null \
  || ! declare -F gate_refuse_no_equivalent_marker >/dev/null \
  || ! declare -F gate_refuse_stale_alias_marker >/dev/null \
  || ! declare -F gate_refuse_unevaluable_marker >/dev/null \
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

# go-to-k/cdkd#2729: the load guard above covers the FUNCTIONS this hook calls
# and CANNOT see a missing CONSTANT. Reading one the library does not define
# aborts under `set -u` with exit 1, and per .claude/rules/hooks.md any exit
# that is not 2 propagates as a NON-BLOCKING error -- i.e. a PASS. Refuse
# instead, unconditionally and before the first constant is read, naming every
# GATE_* constant read below. NOT yet fenced as a class -- the fence was split
# out of this change and is tracked by go-to-k/cdkd#2826, so nothing
# mechanical notices a hook that reads a constant without this call.
if ! declare -F gate_require_const >/dev/null 2>&1; then
  # The helper itself is missing, so nothing below can be trusted either.
  echo "Blocked: .claude/hooks/lib/command-match.sh loaded but does not define" >&2
  echo "gate_require_const, so this gate cannot verify the constants it reads." >&2
  exit 2
fi
gate_require_const GATE_RE_GH_PR_MERGE GATE_RE_GIT_MERGE

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
# BOTH guarded verbs, from the library constants: a hand-copied spelling here
# is what let `-C "/a b"` and `-C "$(...)"` past every gate (go-to-k/cdkd#2027
# review). Built by stripping each constant's `^` and re-anchoring once.
__verb_ere="^(${GATE_RE_GH_PR_MERGE#^}|${GATE_RE_GIT_MERGE#^})"
if ! gate_matches "$cmd" "$__verb_ere"; then
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
# `__verb_ere` is the one defined at the matcher above -- both verbs, from the
# library constants. Resolving against a DIFFERENT spelling than the one that
# matched is how a `-C` goes unread.
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

# A PATH regex cannot see the change most certain to move local-execution
# behaviour: a `cdk-local` VERSION bump. cdk-local IS the local-execution
# engine -- `src/local/**` is largely shims over it -- so a bump changes what
# `cdkd local` does with zero lines under any path above. Measured on
# go-to-k/cdkd#3053 (0.147.7 -> 0.148.4): two user-visible deltas, an ECR-host
# partition fix and a withheld resolver error text, and the diff was
# `package.json` / `pnpm-lock.yaml` / tests / a rule file -- out of scope, so
# the merge was ungated (go-to-k/cdkd#3040).
#
# `bumps_cdk_local <unified diff>` answers whether that diff CHANGES the
# `cdk-local` dependency line of a `package.json`: a `-` line AND a `+` line
# both carrying `"cdk-local":`, inside a `package.json` file block. Both
# polarities, like integ-schema-migration-gate's version-bump test, so a
# comment or an unrelated hunk in the manifest does not fire it; the
# `package.json` restriction so the lockfile's own `cdk-local:` rows (a
# different, unquoted shape) and any prose mentioning the string do not either.
# Precise rather than `^package\.json$` in the scope regex on purpose: that
# would fire on every dependabot PR in the repo, which is the shape that gets a
# gate disabled rather than obeyed.
#
# KNOWN LIMIT, chosen rather than overlooked: a lockfile-only re-resolve inside
# the caret range (`pnpm update cdk-local` moving 0.148.4 -> 0.148.9 with no
# manifest edit) is a cdk-local change this does not see. The lockfile's
# `version:` row carries the PEER resolution as a suffix
# (`0.148.4(aws-cdk-lib@2.268.0(...))`), so it also changes when aws-cdk-lib
# or constructs move -- keying on it would fire on every bump of those, which
# is the same disabling shape. Dependabot edits the manifest for this repo's
# direct dependencies -- measured on its own go-to-k/cdkd#2725 (cdk-local) and
# go-to-k/cdkd#2498 (archiver), both of which moved the `package.json` range --
# so the shape that reaches `main` unattended is covered; the by-hand in-range
# update is the residue, and it is named here so nobody reads the manifest
# test as complete.
bumps_cdk_local() {
  printf '%s\n' "$1" | awk '
    /^diff --git / { in_pkg = ($0 ~ /^diff --git a\/(.*\/)?package\.json b\/(.*\/)?package\.json$/) ; next }
    in_pkg && /^-[[:space:]]*"cdk-local":/ { minus = 1 }
    in_pkg && /^\+[[:space:]]*"cdk-local":/ { plus = 1 }
    END { exit (minus && plus) ? 0 : 1 }
  '
}

# The SHARED matcher, not a local grep. The hand-rolled copy absorbed only a
# `-C` with an unquoted value, so `gh -C "/a b" pr merge <N>` and
# `gh -R <repo> pr merge <N>` skipped the PR-diff scope check below and took the
# `git merge` branch instead (go-to-k/cdkd#2027 review round 4).
if gate_matches "$cmd" "$GATE_RE_GH_PR_MERGE"; then
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
    # No local-execution FILE in the PR diff. Before passing through, ask the
    # question the path list cannot answer: does the diff bump `cdk-local`?
    # Same infra fail-open as the file list above -- an unrelated gh outage
    # must not block merges -- but a diff that IS readable and carries the bump
    # arms the gate exactly as a `src/local/**` edit would. `--color never`
    # is pinned: `gh pr diff` defaults to `--color auto`, and under
    # `GH_FORCE_TTY` (or a real terminal) the header and every `-`/`+` line
    # arrive wrapped in SGR escapes, so the anchored `^diff --git ` and
    # `^[-+]` keys in `bumps_cdk_local` match nothing -- a silent fail-open.
    if [ "$touches_local" -eq 0 ]; then
      if pr_diff=$(gh pr diff "$pr_number" --color never 2>/dev/null); then
        if bumps_cdk_local "$pr_diff"; then
          touches_local=1
        fi
      else
        printf 'integ-local-gate: gh pr diff %s failed; scope decided from the file list alone (infra fail-open)\n' "$pr_number" >&2
      fi
    fi
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
if gate_matches "$cmd" "$GATE_RE_GIT_MERGE" \
  && ! gate_matches "$cmd" "$GATE_RE_GH_PR_MERGE"; then
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
    # `--no-relative` on BOTH readers: with `diff.relative=true` a `git diff`
    # run from a subdirectory drops every path outside it, so a merge issued
    # from `tests/` would see no `src/local/**` and no root `package.json` at
    # all (measured, git 2.49: 0 lines from `sub/`, the root manifest back
    # with the flag). The hook runs in the payload cwd, which is wherever
    # the agent happened to be.
    if incoming=$(git diff --no-relative --name-only "HEAD...${merge_ref}" 2>/dev/null); then
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
      # Same second question as the `gh pr merge` branch, over the incoming
      # range's own diff. A `git diff` that fails leaves `touches_local` at 0,
      # which is the existing pass-through for an unreadable range.
      if [ "$touches_local" -eq 0 ]; then
        # The prefixes and the colour are PINNED, because `bumps_cdk_local`
        # keys on the `diff --git a/... b/...` header and on `^-` / `^+`, and
        # a bare `git diff` inherits the user's config. Measured on git
        # 2.x (code review of go-to-k/cdkd#3040): `diff.noprefix=true`
        # prints `diff --git package.json package.json` for a commit range;
        # `diff.mnemonicPrefix=true` does NOT touch a commit-range header
        # (its `i/ w/` prefixes are for a worktree diff), so it is not the
        # threat here, but `--src-prefix` / `--dst-prefix` cost nothing and
        # settle both; and `color.ui=always` (or `color.diff=always`) wraps
        # the header and every changed line in SGR escapes EVEN INTO A PIPE,
        # so without `--no-color` this branch alone goes fail-open. `gh pr
        # diff` is API output with no git config behind it; its own colour
        # flag is pinned at the call above. (`diff.srcPrefix` / `dstPrefix`,
        # git 2.45+, rewrite the header too and are settled by the same two
        # flags.)
        if incoming_diff=$(git diff --no-relative --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ "HEAD...${merge_ref}" 2>/dev/null) \
          && bumps_cdk_local "$incoming_diff"; then
          touches_local=1
        fi
      fi
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

# --- which marker to ask about in THIS target repo (go-to-k/cdkd#2236) ---
# This hook fires on merges targeting a SIBLING repo too, by design. Asking a
# sibling about a gate named `integ-local` when it names the same Docker
# local-execution gate `integ` made the merge UNSATISFIABLE: markgate exits 1
# for an undeclared gate exactly as it does for a stale marker, so no amount of
# legitimate verification could clear it (hit live merging go-to-k/cdk-local#558
# with cdk-local's own `integ` marker fresh). The resolver keeps `integ-local`
# whenever the target declares it AND whenever definedness cannot be
# determined, so the cdkd path here is unchanged.
__plan=$(gate_resolve_marker_gate "$target_dir" integ-local)
__mode=$(printf '%s' "$__plan" | cut -f1)
__gate=$(printf '%s' "$__plan" | cut -f2)
__gate_fix=$(printf '%s' "$__plan" | cut -f3)

if [ "$__mode" = "none" ]; then
  # NOT a pass-through: cdkd's policy is that local-execution code is verified
  # against real Docker wherever it lands. What changes is that the refusal
  # names something the reader can actually do, instead of a gate that cannot
  # exist in that repo.
  gate_refuse_no_equivalent_marker "integ-local-gate" "integ-local" "$target_dir" \
    "local-execution code (src/local/**, src/cli/commands/local-*.ts, tests/integration/local-*)"
fi

"${markgate[@]}" verify "$__gate" >/dev/null 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

# markgate exit 2 is "could not EVALUATE", not "stale", and the remedies are
# OPPOSITE. This MUST come before the alias refusal below: the one alias that
# exists is a `hash: diff` gate whose NORMAL verdict from a base tree is exit 2,
# and the alias refusal would tell the reader to go run an integ, which cannot
# clear it (go-to-k/cdkd#2236 review, items 1 + 2).
if [ "$status" -eq 2 ]; then
  gate_refuse_unevaluable_marker "integ-local-gate" "$__gate" "$target_dir"
fi

if [ "$__mode" = "alias" ]; then
  gate_refuse_stale_alias_marker "integ-local-gate" "integ-local" "$target_dir" \
    "$__gate" "$__gate_fix" \
    "local-execution code (src/local/**, src/cli/commands/local-*.ts, tests/integration/local-*)"
fi

# Extract the parenthesized reason from `markgate status integ-local` so
# the error message tells the user *why* the gate is stale. With markgate
# 0.3+ the gate carries `ttl: 14d`, so a stale marker is either "(digest
# differs)" (a local-execution-relevant file changed) or "(expired by
# ttl: 14d, marker is Nd old)" (the marker simply aged out and the
# Docker / RIE behavior it verified is no longer plausibly current).
# Distinguishing the two avoids the "but I didn't change anything" confusion.
# Fails open to a generic message when extraction fails.
reason=$("${markgate[@]}" status "$__gate" 2>/dev/null \
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
