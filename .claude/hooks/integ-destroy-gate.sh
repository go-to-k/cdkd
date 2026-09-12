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
gate_require_const GATE_RE_GH_PR_MERGE

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
if ! gate_matches "$cmd" "$GATE_RE_GH_PR_MERGE"; then
  exit 0
fi

# Resolve where the gh command will actually run (cwd-aware; mirrors
# verify-pr-gate.sh / integ-broad-gate.sh).
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
__verb_ere="$GATE_RE_GH_PR_MERGE"
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
#   rollback-executor.ts, provider-registry.ts): any change at all is
#   delete-touching. These are small high-stakes analyzer files where a
#   typical addition is an array entry like `'AWS::Foo': ['AWS::Bar']`
#   whose text does NOT contain the delete-symbol vocabulary, so the
#   hunk filter would miss it. Keep strict. The retry pair joined this
#   group for the same reason (issue #2042): a typical change there adds
#   an HTTP status code or an error name to a classifier list, text that
#   carries none of the delete vocabulary, while `withRetry` wraps every
#   provider's delete() and `destroy-runner.ts` consults the classifier
#   directly.
#   `rollback-executor.ts` is here because its every path is a DELETE or
#   a re-CREATE of a real resource, so the hunk filter buys nothing.
#   `provider-registry.ts` joined for the same reason (issue #2720): its
#   `getProviderFor` picks the provider that DELETES a resource --
#   `deploy-engine.ts`'s plain delete and its replacement old-delete,
#   `destroy-runner.ts`, and seven sites in `rollback-executor.ts` all
#   read it -- so one routing change reroutes DELETE for every resource
#   in a template. Hunk-filtering it was measured to be a fail-open: five
#   realistic routing edits across three shapes (a type added to
#   `STICKY_CC_MIGRATION_EXEMPT`, the sticky predicate replaced, a
#   returned `provisionedBy` flipped) matched `delete_symbol_pattern` 0
#   times, while a control line naming `deleteProvider` matched.
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

# A FAILED diff and an empty one are the same string, and they mean opposite
# things. `origin/main` can resolve while sharing no history with HEAD -- a
# shallow clone, or an unrelated-history checkout -- and then this exits 128
# with empty stdout. Read as "nothing changed" that sets `delete_touch=0` and
# the hook exits 0 with `rollback-executor.ts` rewritten: the gate disabled by
# the one condition its own header calls out as needing exit 2 (the "shallow
# clone with no merge base" branch below was unreachable because this ran
# first). So the rc decides, and a failed diff falls through to markgate, which
# is this file's stated tie-break: a false positive costs an integ run, a false
# negative costs a broken main.
if [ -n "$diff_base" ]; then
  # `--no-renames`, and it is load-bearing rather than tidy. With rename
  # detection ON -- git's default -- `--name-only` prints only the DESTINATION
  # path, so `git mv src/deployment/rollback-executor.ts <anywhere>` produces a
  # changed-file list with no strict path in it: `delete_touch` stays 0 and the
  # hook exits 0 having never consulted markgate, on a branch markgate would
  # have called stale. Measured. It also aligns this list with what markgate
  # actually digests -- its `DiffFrom` runs `--no-renames` too, so without the
  # flag the gate and the marker disagree about which files moved.
  if ! changed_files=$(git diff --name-only --no-renames "$diff_base"...HEAD 2>/dev/null); then
    diff_base=""
  fi
fi

if [ -n "$diff_base" ]; then
  delete_touch=0
  # Strict files — any change triggers (small high-stakes analyzer
  # files plus the retry classifier / rollback executor; see header
  # comment for rationale).
  strict_delete='^src/analyzer/(dag-builder|implicit-delete-deps|lambda-vpc-deps)\.ts$|^src/deployment/(retry|retryable-errors|rollback-executor)\.ts$|^src/provisioning/provider-registry\.ts$'
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
      # No `--no-renames` here, unlike the name list above, and that asymmetry
      # is measured rather than an oversight: this diff is restricted to ONE
      # path, so the other endpoint of the rename is outside the pathspec and
      # git has nothing to pair with -- it reports the whole file as added or
      # deleted either way. Adding the flag changed no verdict in the
      # suite, including the renamed-provider case below it -- an unfenced flag
      # whose comment claims it is load-bearing is the defect this file keeps
      # finding, so it is left off.
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

# --- which marker to ask about in THIS target repo (go-to-k/cdkd#2236) ---
# Same structural defect as integ-local-gate: this hook also fires on merges
# whose target is a SIBLING repo, and `integ-destroy` is a cdkd-only gate name,
# so a sibling took a refusal it could never clear. Unlike integ-local there is
# deliberately NO alias row for this gate -- neither sibling has a destroy path,
# so mapping it onto their Docker / read-only `integ` gate would accept a marker
# that never exercised a delete. A repo with no equivalent therefore gets a
# refusal that names what to add, not a gate it cannot have.
__plan=$(gate_resolve_marker_gate "$target_dir" integ-destroy)
__mode=$(printf '%s' "$__plan" | cut -f1)
__gate=$(printf '%s' "$__plan" | cut -f2)
__gate_fix=$(printf '%s' "$__plan" | cut -f3)

if [ "$__mode" = "none" ]; then
  gate_refuse_no_equivalent_marker "integ-destroy-gate" "integ-destroy" "$target_dir" \
    "deletion logic (provider delete(), destroy.ts, dag-builder, rollback-executor)"
fi

"${markgate[@]}" verify "$__gate" >/dev/null 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

# markgate 0.4's `hash: diff` adds a THIRD outcome: exit 2 is a hard
# evaluation error, not a stale marker. It fires when `origin/main`
# cannot be resolved (never fetched, shallow clone with no merge base)
# or when this branch has no delta against the merge base at all.
# Neither is fixed by running an integ -- `markgate set` fails on exactly
# the same condition, so the generic "/run-integ" advice below would burn
# a real-AWS run and leave the merge blocked anyway.
#
# THIS MUST STAY ABOVE THE ALIAS REFUSAL. It used to sit below it, which was
# latent only because no `integ-destroy` alias row exists yet: adding one would
# have silently routed every exit-2 verdict into the alias refusal's
# "go run the integ" advice -- a trap laid for the next author
# (go-to-k/cdkd#2236 review, item 2). The message is the SHARED one so all four
# gates say the same thing, and it names `$__gate`, which is the alias when one
# is in play rather than a cdkd gate name the target repo does not have.
if [ "$status" -eq 2 ]; then
  gate_refuse_unevaluable_marker "integ-destroy-gate" "$__gate" "$target_dir"
fi

if [ "$__mode" = "alias" ]; then
  gate_refuse_stale_alias_marker "integ-destroy-gate" "integ-destroy" "$target_dir" \
    "$__gate" "$__gate_fix" \
    "deletion logic (provider delete(), destroy.ts, dag-builder, rollback-executor)"
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
reason=$("${markgate[@]}" status "$__gate" 2>/dev/null \
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

# ACTION FIRST. The diagnostic below is what makes a wrong refusal legible, but
# the refusal is read at the moment of a blocked merge, so the thing to DO must
# not sit under fifty lines of explanation.
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

Narrowing CAN clear a `(digest differs)` refusal with no integ run
-- which makes it a scope decision to review, not a per-merge
escape. It cannot clear a TTL expiry or a missing marker, and
`(digest differs)` is reported AHEAD of an expired TTL, so a
marker older than the TTL stays refused after narrowing.

EOF

cat >&2 <<'EOF'
What put this branch in scope — read this rather than hand-expanding the
`include:` globs in `.markgate.yml`:
EOF
# Emitted rather than hard-coded so the advice is copy-pasteable in the
# environment the refusal happened in: `$target_dir` is the tree this gate
# actually checked, which a `cd` / `-C` in the blocked command can make
# different from the caller's cwd, and markers are per-worktree; and
# `${markgate[*]}` is the same resolution this hook used, so the line stays
# runnable where mise is absent and the hook fell back to a bare `markgate`.
# `%q` on the path: this tree can sit under a directory with a space or an
# apostrophe, and an unquoted `cd` there either takes two arguments or leaves
# the reader's shell at a continuation prompt. A no-op for an ordinary path; a
# non-ASCII one renders as `$'...'` under 3.2 and literally under 5.x, which
# both `eval` correctly but are not byte-identical -- do not restate that as
# "same rendering".
printf '  cd %q && %s status integ-destroy --explain\n\n' \
  "$target_dir" "${markgate[*]}" >&2
cat >&2 <<'EOF'
Read BOTH streams. markgate writes the `scope:` block — the exact file list it
digests for this gate — to stderr, while `merge base:` goes to stdout, so
piping stdout alone loses the half you came for. (`state:` is printed on both.)
`merge base:` appears only when a marker exists, and is the base that marker was
SET against, which is not necessarily the live one.

Run the command as printed. The binary in it is the one this gate resolved;
retyping it as a bare `markgate` can pick up an older build on PATH that cannot
parse this repo's `hash: diff` gates at all.

EOF

# The paragraph below says what a DIGEST mismatch means, and it is true of
# nothing else, so it is printed for nothing else. This gate also carries
# `ttl: 14d`, and an expired marker is stale while the branch sat perfectly
# still -- telling that reader "an in-scope file moved on this branch" is false
# and sends them to `--explain` for a file that never changed. The reason-less
# fallback above is an unknown cause, so it is excluded on the same ground.
# The `--explain` command itself stays UNCONDITIONAL: seeing the gate's real
# scope is the right first step under any staleness, and the reason-less path is
# exactly the one a user reaches with an odd or older markgate -- the audience
# this block was written for.
case "$reason" in
*"digest differs"*)
  cat >&2 <<'EOF'
`hash: diff` digests this branch's WORKING-TREE delta from
merge-base(origin/main, HEAD) — uncommitted edits, mode changes and untracked
non-ignored files all count, so `git diff origin/main...HEAD` can show nothing
in scope while the digest has moved. A peer's merge landing on `origin/main`
does not stale this marker by itself: it does not move that merge base.

What does: an in-scope file changing in THIS WORKING TREE; merging
`origin/main` into this branch, or rebasing this branch onto it, when the
incoming change touches an in-scope file this branch also modified, which keeps
that file in the delta while its base side moves under it; and editing this
gate's `include:` / `exclude:` list so that it starts or stops matching a path
that is IN the delta, which changes WHICH files are digested with no file
changing at all — widening onto paths this branch has not touched does nothing,
measured. `--explain` narrows it to the files actually digested.
Its `merge base:` is recorded at `set` time, so comparing it against
`git merge-base origin/main HEAD` is a ONE-WAY test: equal rules the second
cause out, unequal says only that the base moved at some point, not that the
move is what staled the marker.

An EMPTY `scope:` next to `(digest differs)` is not a broken gate either — it
means the in-scope delta emptied AFTER the marker was set. Ways it does: the
change was reverted; the `include:` / `exclude:` list stopped matching the file
you changed, which is what narrowing the scope does; or the change landed
upstream AND this branch then merged or rebased `origin/main`, moving the merge
base past it — landing alone is not enough, for the reason above. The digest was
taken over a non-empty delta and no longer matches the empty one.

EOF
  ;;
esac
exit 2
