#!/usr/bin/env bash
# verify-pr-gate.sh
#
# PreToolUse hook. Blocks `gh pr create` and `gh pr merge` (including
# --auto) unless the `verify-pr` markgate marker is fresh for the
# current content state. The gate's scope (see .markgate.yml) covers
# every code/test/doc path the /verify-pr skill inspects, so editing
# any of them invalidates the marker and forces a successful
# /verify-pr run before the PR can be opened or merged.
#
# This is the structural enforcement of the "PR readiness checklist"
# rule: live-test the changed behavior, walk all shared-utility
# callers, refresh PR title + body, and run the session retrospective
# (proposing new rules/hooks/skills for recurring patterns) BEFORE
# `gh pr create` / `gh pr merge`. The skill said it; the hook
# enforces it.
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
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F gate_target_is_foreign >/dev/null; then
  # `gate_target_is_foreign` REPLACES the five names this chain used to list
  # (`gate_segments`, `gate_segments_raw`, `gate_verb_span`, `gate_argv`,
  # `gate_word_is_literal`): since go-to-k/cdkd#3351 this hook calls none of
  # them directly -- they are that function's internals -- and it is defined
  # LATER in the library than any of them, so requiring it is a STRICTLY
  # STRONGER truncation check than requiring the five.
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
gate_require_const GATE_RE_GH_PR_CREATE_OR_MERGE

set -u

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr create` and `gh pr merge` invocations -- any other
# command passes through. Match both `gh pr merge` and
# `gh pr merge --auto`. Tolerate an optional `gh -C <path>` between
# `gh` and `pr` so `gh -C <path> pr create` is also recognised.
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! gate_matches "$cmd" "$GATE_RE_GH_PR_CREATE_OR_MERGE"; then
  exit 0
fi

# Resolve where the gh command will actually run (cwd-aware; mirrors
# integ-local-gate.sh).
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
__verb_ere="$GATE_RE_GH_PR_CREATE_OR_MERGE"
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "verify-pr-gate" "${hook_cwd:-$PWD}"
fi

# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Repo opt-in scope (mirrors branch-gate.sh, issue #1259): this gate protects
# repos that follow the markgate convention. A session rooted in such a repo can
# still run git / gh against OTHER repos (a dotfiles checkout, a scratch clone)
# that have no markers at all, and blocking there is pure friction — the gate
# would demand a marker the repo cannot have. Opt-in signal: a `.markgate.yml`
# at the resolved target repo's top level. Repos without it pass through.
target_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$target_top" || ! -f "$target_top/.markgate.yml" ]]; then
  exit 0
fi

# REPO IDENTITY (go-to-k/cdkd#3209) -- computed HERE, before the `cd -P` below,
# because `$__hook_dir` CAN BE RELATIVE and would then name the wrong directory
# once this process has changed its cwd. Two ways it is relative, and the first
# revision of this comment named only the second: `.claude/settings.json` invokes
# this hook as `${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/verify-pr-gate.sh`, which
# is `./.claude/hooks/...` whenever that variable is unset -- the PRODUCTION
# spelling, not an edge case; and `${BASH_SOURCE[0]%/*}` falls back to `.` when
# the script is invoked with a bare name.
#
# THE PLACEMENT IS FENCED BY A CASE, and an earlier revision of this paragraph
# described that case wrongly in BOTH halves. It is not enough for the hook to
# be invoked relatively: the case must ALSO target a directory that is not the
# process's cwd, or `./.claude/hooks` resolves identically before and after the
# `cd -P` and the block can be moved with the suite still green. And the flip is
# passing -> REFUSING, not the reverse: from inside a foreign target the hook's
# own repo becomes unresolvable, the identity fails CLOSED, and a sibling PR
# that should clear is refused -- go-to-k/cdkd#3209's original false block,
# coming back. Measured by moving the block: 78 green, that one case red.
#
# The SHA BINDING further down is a cdkd-ONLY device: `/verify-pr` writes
# `.markgate-verify-pr-sha`, and no sibling repo defines the file. This gate
# fires on commands targeting ANY repo carrying a `.markgate.yml` (the opt-in
# above), and cdk-local and cdk-real-drift both carry one -- so a `gh pr create`
# there was refused for a sentinel those repos never write, by a refusal NO
# legitimate action could clear. `.claude/rules/hooks.md`'s prescribed remedy
# (complete the target's own checklist, set its markers, retry) does not reach
# it, because what is missing is a FILE FORMAT rather than a marker, and writing
# cdkd's sentinel into a sibling is the second half of the same sentence: "do
# not fix the target repo to match cdkd". It blocked a step
# `.claude/skills/work-issues/references/retro.md` 10-c MANDATES -- the session
# that finds a lesson lands the mirror PR in all three repos.
#
# So: require the BINDING only in the repo that DEFINES it, and keep requiring
# `markgate verify verify-pr` everywhere. cdkd's POLICY still applies to a
# sibling target; cdkd's MECHANISM stops being demanded of a repo that has none.
#
# WHY `BASH_SOURCE` IS RIGHT FOR THIS AND WAS WRONG FOR THE MARKER LOOKUP.
# The header above records that the pre-#559 implementation derived the marker
# store from `BASH_SOURCE`, and that doing so defeated markgate's per-worktree
# isolation. These are DIFFERENT QUESTIONS and the next reader will assume they
# are the same one. "Which marker store?" is PER-WORKTREE -- markgate keys it on
# `--absolute-git-dir`, which differs in every linked worktree -- so only the
# payload `cwd` can answer it, and `BASH_SOURCE` answered a question it was not
# asked. "Which REPOSITORY is this?" is the opposite: deliberately
# worktree-INVARIANT. So resolving it from `BASH_SOURCE` does not reintroduce
# #559: the marker lookup below still comes from the payload cwd.
#
# HOW the question is answered -- the common-dir comparison, why a different
# CHECKOUT is not a different REPOSITORY, the slug test across every remote,
# the `cd` + `pwd -P` canonicalisation, and the allowlist -- lives on
# `gate_target_is_foreign` in `lib/command-match.sh`, which is the only copy
# (go-to-k/cdkd#3351). It is deliberately NOT restated here: an earlier
# revision of this block described the mechanism beside the call, the mechanism
# then moved, and the description stayed -- in a change whose whole rationale
# was that there should be one copy.
#
# FAIL CLOSED: if the identity cannot be resolved, the sentinel stays required.
# An unresolvable identity never relaxes.
#
# KNOWN BOUNDS, stated rather than chased:
#   - For a foreign target, `verify-pr` is `requires: [...]` with no `include:`
#     of its own THERE too, so a marker stale by INHERITANCE can pass -- the
#     very hole the binding closes here. That is the sibling repo's own design,
#     and `.claude/rules/hooks.md` forbids porting cdkd's stricter gate down to
#     fix it.
#   - A second CLONE of cdkd used to be foreign by this test and take the
#     relaxed path. It no longer is: go-to-k/cdkd#3351 settled identity on the
#     repo SLUG across every remote, so a clone whose `origin` (or `upstream`)
#     names cdkd is recognised as THIS repository in a different directory. The
#     bound is recorded as CLOSED rather than deleted, because this file is
#     where the next reader will look for it -- and because that same bound,
#     copied verbatim into a gate that EXITS 0 on the answer, was a total
#     bypass there while being merely a lost optimisation here. A bound is only
#     as acceptable as what its caller does with the answer.
#   - "FAIL CLOSED" covers an UNRESOLVABLE identity, not a RESOLVABLE WRONG one.
#     If this file is reached through a symlinked `.claude` (or `.claude/hooks`)
#     whose physical location sits inside a DIFFERENT repository, `git -C` follows
#     the symlink, the hook's "own" repo becomes that other one, and every cdkd
#     target is then classified foreign -- the go-to-k/cdkd#2686 binding silently
#     dropped. Not this repo's shape (both are real directories in the main tree
#     and in every worktree), and it needs write access to the checkout, which is
#     already game over. Stated because the phrase above reads as if only the
#     unresolvable case can go wrong.
#
# Computed HERE, before the `cd -P` further down: `$__hook_dir` is relative in
# production, so resolving it from inside the target makes the hook's own repo
# the TARGET and every target then classifies as cdkd.
target_is_foreign=0
if gate_target_is_foreign "$__hook_dir" "$target_dir" "$cmd" "$__verb_ere"; then
  target_is_foreign=1
fi
__vpg_retract="$GATE_FOREIGN_RETRACT"

# Fail CLOSED, matching `check-gate.sh`'s `cannot_evaluate`. A gate that cannot
# enter the tree it is judging has not cleared it. This was `|| exit 0` -- a
# fail-open the delta's `git -C "$target_dir"` was working around rather than
# closing (go-to-k/cdkd#2686 review).
# `-P`, physical: bash's LOGICAL `cd` resolves `..` textually, so a path with a
# `..` after a symlink can land in a DIFFERENT existing directory than the
# physical chdir `git -C` did at the repo probe above -- `markgate verify` would
# then run in one tree while `target_top` and the sentinel come from another (measured,
# go-to-k/cdkd#2686 round-3 review). The refusal below is near-unreachable for
# that reason -- that probe already proved the chdir works -- but it fails CLOSED
# like `check-gate.sh`'s `cannot_evaluate` rather than passing a tree it could
# not enter.
if ! cd -P "$target_dir" 2>/dev/null; then
  echo "Blocked by verify-pr-gate: cannot enter $target_dir to evaluate the marker." >&2
  exit 2
fi

# Prefer the `.mise.toml`-pinned version via `mise exec --` so the repo's
# canonical markgate wins over an older PATH binary; see check-gate.sh for
# the schema-bump rationale (0.3.0 markers are silently invisible to 0.3.1).
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by verify-pr-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify verify-pr >/dev/null 2>&1
status=$?

# SHA BINDING (go-to-k/cdkd#2686).
#
# A fresh marker is not enough. `verify-pr` is declared `requires: [check,
# docs]` with NO `include:` of its own, so once set in a worktree it never
# stales by itself -- it is only ever MASKED by a stale child. Running `/check`
# and `/check-docs` un-masks it, and the gate that is supposed to physically
# block `gh pr create` / `gh pr merge` for a PR whose live behaviour was never
# exercised goes green for a PR `/verify-pr` has never seen.
#
# That is invisible in a single-PR session and NOT invisible in the IN-PLACE
# worktree mode CLAUDE.md prescribes, where lane N inherits lane N-1's parent
# marker. Measured twice, in different worktrees a day apart: a parent an hour
# older than children four minutes old, `markgate verify verify-pr` rc=0, and
# `gh pr create` unblocked.
#
# THIS COMPARISON IS THE ENFORCEMENT, not a nicer error string. `markgate
# verify` digests the gate's SCOPE; a sentinel nobody rewrote keeps its digest
# whatever the branch moved to, so `verify` reports `match` for a sentinel
# naming a different commit entirely (measured on the sibling gate,
# go-to-k/cdkd#2681 -- whose whole subject is a comment that claimed the digest
# enforced it, and which would have made deleting this look like a safe
# simplification). Do not remove it on the strength of the digest.
#
# Bound to the LOCAL HEAD, not to the PR's `headRefOid` as `pr-review-gate.sh`
# is: this gate also guards `gh pr create`, where there is no PR to ask. The
# local HEAD exists at both moments and is exactly what distinguishes one lane
# from the next.
# Read from the repo TOP, not the cwd: `gh pr create` run from a subdirectory
# would otherwise find no sentinel and be refused for a reason that has nothing
# to do with the marker. `target_top` is already resolved above.
recorded_sha=""
if [ -f "$target_top/.markgate-verify-pr-sha" ]; then
  # SIZE first, then read WHOLE, then check the SHAPE. The order matters and
  # two weaker spellings were measured wrong before this one:
  #
  #   `head -c 100` alone -- a sentinel of `<sha><60 spaces><junk>` reads as the
  #   bare sha under the cap and as sha+junk without it, so the CAP decides the
  #   verdict, not the comparison. An earlier comment here claimed truncation
  #   "cannot turn a non-match into a match"; it is exactly what it does.
  #
  #   cap + shape check -- same hole: the truncated read IS a well-formed sha.
  #   Raising the cap only moves the padding length that defeats it.
  #
  # What actually closes the truncation hole is reading the file WHOLE: the junk
  # then lands in `recorded_sha` and the comparison fails. The size cap is a
  # RESOURCE bound (a legitimate sentinel is one sha and a newline -- 41 bytes,
  # 65 for sha256), and the shape check rejects malformed content early.
  #
  # Measured, and CORRECTED after a reviewer checked the claim I made here:
  #
  #   - the SIZE CAP is load-bearing on its own. `<sha><100 spaces>` (140 B)
  #     refuses today and PASSES with the cap widened, because `tr` strips the
  #     padding and what is left is a well-formed sha. An earlier revision of
  #     this comment said removing the cap "changes no verdict" -- an untrue
  #     claim of exactly the form this gate exists to stop, written twice in one
  #     PR. The divergence is in the safe direction; the claim was still false.
  #   - the HEX and LENGTH checks genuinely are redundant with the comparison:
  #     `head_sha` is always lowercase 40-hex, so a malformed `recorded_sha`
  #     can never compare equal. Removing either, or both, changes no verdict.
  #     They stay because they make the REASON legible in the block message.
  #
  # KNOWN BOUNDS, stated rather than chased: the read FOLLOWS a symlink (an
  # attacker who can plant one in your worktree can do worse), and a sentinel
  # whose sha is followed by a NUL passes: `tr` now strips NUL so bash no longer
  # warns about it on stderr, but the remaining bytes still read as the sha.
  # Neither is reachable from the documented flow, which writes the file with
  # `git rev-parse`.
  sentinel_bytes=$(wc -c < "$target_top/.markgate-verify-pr-sha" 2>/dev/null | tr -d '[:space:]')
  case "$sentinel_bytes" in
    '' | *[!0-9]*) sentinel_bytes=99999 ;;
  esac
  if [ "$sentinel_bytes" -le 128 ]; then
    # Braces around the redirect: bash applies `< file` BEFORE `2>/dev/null`, so
    # a `chmod 000` sentinel otherwise leaks a "Permission denied" line onto the
    # hook's own stderr (verdict was already correct).
    recorded_sha=$({ tr -d '[:space:]\000' < "$target_top/.markgate-verify-pr-sha"; } 2>/dev/null)
    case "$recorded_sha" in
      *[!0-9a-f]* | "") recorded_sha="" ;;
    esac
    case "${#recorded_sha}" in
      40 | 64) ;;
      *) recorded_sha="" ;;
    esac
  fi
fi
# `--verify`, not a bare `rev-parse HEAD`: in a repo with no commits the bare
# form prints the literal string `HEAD` on STDOUT (and the fatal on stderr), so
# `head_sha` would be "HEAD" rather than empty and the `-n` guard below would be
# dead code. Measured. `--verify` yields a sha or nothing.
head_sha=$(git -C "$target_dir" rev-parse --verify HEAD 2>/dev/null || echo "")

if [ "$status" -eq 0 ] && [ -n "$head_sha" ] && [ "$recorded_sha" = "$head_sha" ]; then
  exit 0
fi

# A FOREIGN target clears on the MARKER alone (go-to-k/cdkd#3209; the identity
# block above carries the reasoning and the bounds). The sentinel this gate
# compares is cdkd's own device, which the target repo does not write.
#
# `[ -n "$head_sha" ]` is deliberately NOT repeated here. That guard exists
# because an absent sentinel and an unreadable HEAD both read as the empty
# string, so `"" = ""` would PASS the comparison above; with no comparison on
# this path there is nothing for it to fail open.
if [ "$status" -eq 0 ] && [ "$target_is_foreign" -eq 1 ]; then
  exit 0
fi

# Extract the parenthesized reason from `markgate status verify-pr` so the
# error message tells the user *why* the gate is stale. With markgate 0.3+
# `requires: [check, docs]` the reason often names the failing child
# (e.g. "(child docs is stale)"), pointing the user straight at /check or
# /check-docs without forcing them to re-run /verify-pr blindly. Fails open
# to the static heredoc body when extraction fails.
reason=$("${markgate[@]}" status verify-pr 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

# Reaching here with a FRESH marker means the binding is what failed, whatever
# shape it failed in. An earlier revision said `&& [ "$recorded_sha" != "$head_sha" ]`,
# which is NOT the complement of the pass condition: with an unreadable HEAD and
# no sentinel both are empty, `!=` is false, and a fresh marker fell through to
# the generic "stale" text -- the exact misdirection these lines exist to
# prevent. Measured; found by both reviews of go-to-k/cdkd#2686.
# The actionable half of a RETRACTED relaxation, shared by the two paths that
# can reach it: a fresh marker (where it is the whole story) and a STALE one
# (where it is the second reason, and clearing the marker will not fix it).
__vpg_print_override_guidance() {
  printf "Re-run it from the target repository's own checkout, with literal arguments:\n" >&2
  printf "  - no \`-R\` / \`--repo\` and no short-flag cluster carrying \`R\`\n" >&2
  printf "  - no \`GH_REPO\` in the environment or on the command line\n" >&2
  printf "  - the PR named by NUMBER, not by URL\n" >&2
  printf "  - no unexpanded \$VARIABLE in the gh command\n\n" >&2
  printf "Do NOT write cdkd's \`.markgate-verify-pr-sha\` into the sibling; that file is\ncdkd's own device and the sibling does not define it.\n\n" >&2
}

if [ "$status" -eq 0 ] && [ -n "$__vpg_retract" ]; then
  # THE RETRACTED-RELAXATION CASE, and it is the one place the message below is
  # actively MISLEADING. The target is a FOREIGN repo, so it has no
  # `.markgate-verify-pr-sha` and cannot be given one without doing the thing
  # `.claude/rules/hooks.md` forbids ("do not fix the target repo to match
  # cdkd") -- yet without this branch the reader is sent to `/verify-pr` and to
  # that sentinel. With `GH_REPO` exported in a shell profile EVERY sibling PR
  # lands here, so this is not a corner.
  printf "Blocked by verify-pr-gate: this command targets %s, which is NOT this repo,\nand it also names a repository of its own -- %s.\n\n" \
    "$target_top" "$__vpg_retract" >&2
  printf "A cdkd session may open or merge a PR in a sibling repo on that repo's OWN\n\`verify-pr\` marker. It may not do so with a command that could be acting on a\nTHIRD repo, because then the marker attests to something else entirely.\n\n" >&2
  __vpg_print_override_guidance
elif [ "$status" -eq 0 ]; then
  # The marker is FRESH; what is wrong is what it is bound to. Saying "stale"
  # here would send the reader to `/check` for a problem no child has.
  printf "Blocked by verify-pr-gate: the \`verify-pr\` marker is fresh but bound to a different commit.\n\n" >&2
  printf "  HEAD is:          %s\n" "${head_sha:-<unreadable>}" >&2
  # A present-but-rejected sentinel is not the same as an absent one, and the
  # reader needs to know which: "unset" sends them to /verify-pr, "malformed"
  # sends them to the file.
  sentinel_label="<unset>"
  if [ -n "$recorded_sha" ]; then
    sentinel_label="$recorded_sha"
  elif [ -e "$target_top/.markgate-verify-pr-sha" ]; then
    sentinel_label="<present but unreadable or malformed>"
  fi
  printf "  marker bound to:  %s\n\n" "$sentinel_label" >&2
  printf "This is the second-lane case: a marker set for an earlier branch in this\nworktree, un-masked by a later \`/check\` + \`/check-docs\`. Run \`/verify-pr\`\nfor THIS branch.\n\n" >&2
elif [ -n "$reason" ]; then
  printf "Blocked by verify-pr-gate: the \`verify-pr\` marker is stale %s.\n\n" "$reason" >&2
else
  echo "Blocked by verify-pr-gate: the \`verify-pr\` marker is stale (or missing)." >&2
  echo >&2
fi

# SKIPPED when the retraction is the ONLY thing wrong -- a FRESH marker plus a
# retracted relaxation. `/verify-pr` is not the remedy there: the target is a
# foreign repo, this session's `verify-pr` marker has nothing to do with it, and
# the block above already named the one action that clears it. Printing this
# underneath would put the wrong instruction last, which is the instruction that
# gets followed.
#
# `status -eq 0` is load-bearing and was missing: without it a STALE marker plus
# a retraction also exited here, so the reader got the staleness line and
# NOTHING else -- neither the `/verify-pr` remedy that does apply to the
# staleness, nor the second-reason note below. Caught by the case that asserts
# both reasons appear.
if [ "$status" -eq 0 ] && [ -n "$__vpg_retract" ]; then
  exit 2
fi

cat >&2 <<'EOF'
Required action — no exceptions:
  /verify-pr [PR-number]

The skill walks the full PR-readiness checklist:
  - typecheck / lint / build / unit tests
  - test coverage for the diff
  - CI status / working tree / docs consistency / leftover AWS resources
  - code review (incl. shared-utility caller verification)
  - live-test the changed behavior against real or fixture input
  - retrospective + proposals for new rules / hooks / skills
  - PR title + body freshness vs the actual diff

It is the ONLY legitimate setter of this marker. Do NOT call
`markgate set verify-pr` directly from a shell to bypass this hook —
the whole point of the gate is that an unverified PR cannot be opened
or merged. If a check legitimately cannot pass right now (e.g. no
AWS credentials for live-test), say so explicitly in the report; the
gate stays red so a human can decide whether to override.
EOF

# A STALE marker and a RETRACTED relaxation are INDEPENDENT, and the staleness
# branches above print only the first. Clearing the marker then leaves the
# reader blocked again by a different message, with nothing having said the
# second reason was there all along. No security impact -- the verdict is the
# same either way -- purely so one refusal names everything that is wrong.
if [ -n "$__vpg_retract" ]; then
  printf "\nAND A SECOND REASON, which clearing the marker will NOT fix: this command\ntargets %s, which is NOT this repo, and %s.\n\n" \
    "$target_top" "$__vpg_retract" >&2
  __vpg_print_override_guidance
fi
exit 2
