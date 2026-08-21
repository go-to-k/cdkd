#!/usr/bin/env bash
# integ-destroy-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` (including --auto) unless the
# `integ-destroy` markgate marker is fresh for THIS BRANCH'S DELTA
# against origin/main. The gate's scope (see .markgate.yml) covers
# every code path that participates in real-AWS resource destruction;
# a change this branch makes to any of them invalidates the marker and
# forces a successful `/run-integ` destroy run before the PR can be
# merged. A change to one of them arriving FROM main does not — the
# gate runs on markgate 0.4's `hash: diff` mode, so an already-gated
# change someone else merged no longer costs a real-AWS re-run.
#
# This is the structural counterpart to the CLAUDE.md rule "Never
# merge a PR whose destroy path is unverified". The rule said it; the
# hook enforces it.
#
# WHY the cwd-aware resolution matters (cdkd #559): this repo is
# regularly worked in via `git worktree`, and markgate stores marker
# state per-worktree at `<git rev-parse --absolute-git-dir>/markgate/`.
# The pre-#559 implementation derived REPO from `BASH_SOURCE` and
# always landed on the main working tree, defeating markgate's
# per-worktree isolation and forcing every parallel agent to converge
# on the main tree's view (see memory rule
# feedback_cross_agent_main_tree_contention.md). We now resolve the
# target working tree from the PreToolUse payload's `cwd` field +
# leading `cd <path>` + last `gh -C <path>` flag.

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
# and .cwd from it.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge` invocations -- any other command passes
# through. Match both `gh pr merge` and `gh pr merge --auto`. Tolerate
# an optional `gh -C <path>` between `gh` and `pr`. Line-start
# anchored (per memory rule feedback_hook_command_match_line_start.md)
# so `gh pr merge` substrings inside quoted argument bodies
# (`echo "remember to gh pr merge later"`) do NOT false-positive
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! cmd_matches_verb "$cmd" 'gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

# Resolve where the gh command will actually run (cwd-aware; mirrors
# verify-pr-gate.sh / non-english-text-gate.sh).
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
__verb_ere='gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])'
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "integ-destroy-gate" "${hook_cwd:-$PWD}"
fi

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

# Decide whether the diff actually touches deletion logic. The markgate
# scope (.markgate.yml) is file-level, so it can't tell apart a real
# delete-method change from an unrelated edit in the same file (e.g.
# adding `provider.import` to every provider in PR #67 invalidated the
# marker even though no provider's `delete` was modified). Use git diff
# vs origin/main to look at the actual hunks: if no delete-touching
# symbol is added or removed, skip the gate entirely.
#
# Heuristic:
# - "strict-delete" files (dag-builder.ts, implicit-delete-deps.ts,
#   lambda-vpc-deps.ts, retry.ts, retryable-errors.ts,
#   rollback-executor.ts): any change at all is delete-touching. These
#   are small high-stakes analyzer files where a typical addition is an
#   array entry like `'AWS::Foo': ['AWS::Bar']` whose text does NOT
#   contain the delete-symbol vocabulary, so the hunk filter would
#   miss it. Keep strict. The retry pair joined this group for the same
#   reason (issue #2042): a typical change there adds an HTTP status
#   code or an error name to a classifier list, text that carries none
#   of the delete vocabulary, while `withRetry` wraps every provider's
#   delete() and `destroy-runner.ts` consults the classifier directly.
#   `rollback-executor.ts` is here because its every path is a DELETE or
#   a re-CREATE of a real resource, so the hunk filter buys nothing.
# - "filtered-delete" files (destroy.ts, destroy-runner.ts,
#   deploy-engine.ts): considered delete-touching ONLY when the diff
#   hunks add/remove a delete-related symbol — same filter as provider
#   files. These are larger files that mix delete logic with UX
#   strings, command wiring, log messages, etc. Pure UX-string edits
#   here have no behavioral effect on the destroy path (e.g. PR #84
#   fixed a `--region` → `--stack-region` error message in destroy.ts);
#   the old strict rule made such trivial PRs un-mergeable until
#   /run-integ was re-run, even though no destroy code changed.
# - provider files: only delete-touching when the diff hunks add/remove
#   a delete-related symbol (delete*, IMPLICIT_DELETE, ENI/hyperplane,
#   DependencyViolation).
# - everything else: not delete-touching.
#
# When in doubt, fall through to verifying the marker — false positives
# cost an integ-test run; false negatives cost a broken main.
diff_base=""
if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  diff_base="origin/main"
fi

if [ -n "$diff_base" ]; then
  changed_files=$(git diff --name-only "$diff_base"...HEAD 2>/dev/null)
  delete_touch=0
  # Strict files — any change triggers (small high-stakes analyzer
  # files plus the retry classifier / rollback executor; see header
  # comment for rationale).
  strict_delete='^src/analyzer/(dag-builder|implicit-delete-deps|lambda-vpc-deps)\.ts$|^src/deployment/(retry|retryable-errors|rollback-executor)\.ts$'
  # Hunk-filtered files — only delete-symbol changes trigger.
  filtered_delete='^(src/cli/commands/destroy(-runner)?\.ts|src/deployment/deploy-engine\.ts)$'
  provider_pattern='^src/provisioning/(providers/.*\.ts|cloud-control-provider\.ts|region-check\.ts)$'
  # Match a delete-touching symbol on an added/removed line, but NOT inside
  # a single-line comment. This avoids the false positives PR #73 hit
  # (e.g. an ECS provider doc-comment containing the words "delete/update"
  # tripped the gate even though the diff didn't change any delete code).
  #
  #   ^[-+]                  added or removed line
  #   [^-+]                  one non-+/- char so we don't match the diff header `+++`/`---`
  #   [[:space:]]*           leading indent
  #   (?!//|\*|#)            negative lookahead — but POSIX grep -E doesn't
  #                          support lookahead. Workaround: filter comment
  #                          lines with a second grep -v pass below.
  # `rollback` is included so a refactor that changes the order of
  # `partial state → rollback → final state` in `deploy-engine.ts`
  # (which would leak orphans on failure) trips the gate even when
  # the diff doesn't textually mention the literal CRUD verbs.
  #
  # Word boundaries (\b) are dropped so camelCase identifiers match:
  # `performRollback`, `deleteResource`, `detachVpc` should all hit
  # the gate. Combined with `grep -i` below, this matches `Rollback`,
  # `rollback`, `ROLLBACK`, etc. The trade-off is occasional false
  # positives on substrings (e.g. an unrelated word containing `eni`)
  # — which only cost an integ-test run, vs false negatives that
  # cost a broken main.
  delete_symbol_pattern='^[-+][^-+].*(delete|rollback|IMPLICIT_DELETE|hyperplane|DependencyViolation|ENI|detach)'
  # Lines we consider "comment only" — drop them before the symbol grep.
  # Matches an added/removed line whose first non-whitespace content is
  # a JS/TS/SH comment introducer (`//`, `/*`, `*` mid-block, `#`).
  comment_line_pattern='^[-+][^-+][[:space:]]*(\*|/\*|//|#)'

  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Strict-delete files: any change at all is delete-touching.
    if printf '%s' "$f" | grep -qE "$strict_delete"; then
      delete_touch=1
      break
    fi
    # Filtered-delete files (command/orchestration) and provider files
    # share the same hunk filter: only mark the gate as delete-touching
    # when the diff lines add or remove a delete-related symbol. A file
    # in either group with only string / log / typing edits passes
    # through.
    if printf '%s' "$f" | grep -qE "$filtered_delete|$provider_pattern"; then
      # `-i` so identifier names like `performRollback` (camelCase) and
      # `Delete`/`DELETE` (mixed case in CFN-style constants) match the
      # lowercase patterns. Word boundaries (\b) keep matches scoped to
      # whole words / camelCase boundaries; `EnigmaFoo` is safe.
      if git diff "$diff_base"...HEAD -- "$f" \
         | grep -vE "$comment_line_pattern" \
         | grep -qiE "$delete_symbol_pattern"; then
        delete_touch=1
        break
      fi
    fi
  done <<EOF_FILES
$changed_files
EOF_FILES

  if [ "$delete_touch" -eq 0 ]; then
    # No delete-touching changes → gate is irrelevant. Skip.
    exit 0
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
  echo "Blocked by integ-destroy-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify integ-destroy >/dev/null 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

# markgate 0.4's `hash: diff` adds a THIRD outcome: exit 2 is a hard
# evaluation error, not a stale marker. It fires when `origin/main`
# cannot be resolved (never fetched, shallow clone with no merge base)
# or when this branch has no delta against the merge base at all.
# Neither is fixed by running an integ -- `markgate set integ-destroy`
# fails on exactly the same condition, so the generic "/run-integ"
# advice below would burn a real-AWS run and leave the merge blocked
# anyway. `markgate status` also errors on this path and prints no
# `state:` line, so the reason extraction below would come back empty
# and silently degrade to the wrong message. Name the real remedy.
if [ "$status" -eq 2 ]; then
  cat >&2 <<'EOF_ERR'
Blocked by integ-destroy-gate: markgate could not EVALUATE the
`integ-destroy` gate (exit 2). This is not a stale marker, and
/run-integ will NOT fix it -- `markgate set` fails the same way.

Likely cause and remedy:
  * `origin/main` missing or stale in this worktree
      git fetch origin
  * shallow clone with no merge base against origin/main
      git fetch --unshallow
  * this branch has no delta against merge-base(origin/main, HEAD)
      commit the work first, or run from a branch that is ahead of main

Diagnose with:
  mise exec -- markgate status integ-destroy
EOF_ERR
  exit 2
fi

# Extract the parenthesized reason from `markgate status integ-destroy` so
# the error message tells the user *why* the gate is stale. With markgate
# 0.3+ the gate carries `ttl: 14d`, so a stale marker is either "(digest
# differs)" (real-AWS-relevant code changed on this branch) or "(expired
# by ttl: 14d, marker is Nd old)" (the marker simply aged out and the
# AWS-side behavior it verified is no longer plausibly current).
# Distinguishing the two avoids the "but I didn't change anything"
# confusion. Fails open to the pre-0.3 generic message when extraction
# fails — which is also what happens on the exit-2 path below, where
# `markgate status` itself errors and prints no `state:` line.
reason=$("${markgate[@]}" status integ-destroy 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

if [ -n "$reason" ]; then
  printf "Blocked by integ-destroy-gate: this PR touches deletion logic and the \`integ-destroy\` marker is stale %s.\n\n" "$reason" >&2
else
  cat >&2 <<'EOF_HEAD'
Blocked by integ-destroy-gate: this PR touches deletion logic
(provider delete(), destroy.ts, dag-builder, IMPLICIT_DELETE_DEPENDENCIES,
or similar) and the `integ-destroy` marker is stale.

EOF_HEAD
fi

cat >&2 <<'EOF'
Required action — no exceptions:
  /run-integ <test-name>      # e.g. /run-integ bench-cdk-sample

The skill is the ONLY legitimate setter of this marker. It will run
deploy + destroy against real AWS and only call
`markgate set integ-destroy` if BOTH of the following hold:
  - destroy completed with 0 errors
  - 0 orphan resources after the post-destroy verification

Do NOT call `markgate set integ-destroy` directly from a shell to
bypass this hook. The whole point of the gate is that an unverified
destroy cannot reach main; setting the marker by hand defeats it. If
you believe the file in scope is genuinely unrelated to deletion
behavior, the right fix is to narrow `.markgate.yml` integ-destroy
scope, not to bypass the marker.
EOF
exit 2
