#!/usr/bin/env bash
# ci-green-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` unless EVERY GitHub Actions
# check on the target PR is green (`pass`) or `skipping`. A `fail`,
# `pending`, `queued`, or "no checks reported" state blocks the merge.
#
# Why: PR #1231 (2026-07-27) was merged while `check-build-test` was
# FAILED — the merge command was chained after a `gh pr checks`
# DISPLAY, so the red status was printed but nothing gated on it, and
# main went red until fix-forward PR #1232. Every other merge-critical
# invariant here is enforced by a gate (markgate markers for
# verify-pr / pr-review / integ-*); CI greenness was the one
# merge-blocking fact left to eyeballs. CI status is LIVE external
# state, so this is a stateless live-query hook (like
# pr-review-gate.sh), not a digest-bound markgate marker — a marker
# would go stale the moment a new commit lands, but could never
# capture "the checks that exist RIGHT NOW all pass".
#
# Pending is blocked (not just fail): merging before checks settle is
# exactly the #1231 shape. Wait for CI (`gh pr checks <N> --watch`),
# then re-run the merge.
#
# Escape hatch: CDKD_SKIP_CI_GREEN_GATE=1 in the command environment
# (for a repo with genuinely no CI configured, where "no checks
# reported" would block forever). Do not use it to merge a red PR.
#
# Infra posture: `gh` transport errors fail OPEN (an unrelated GitHub
# outage should not block merges); a successful `gh pr checks` answer
# is enforced strictly. THE FAIL-OPEN ENDS WHERE THE COMMAND NAMES ANOTHER
# REPOSITORY: since go-to-k/cdkd#3273 a `-R` / `--repo` slug is forwarded to
# `gh pr checks`, and when one is present an unreadable answer BLOCKS instead --
# see the two blocks near the bottom of this file for why, and for the two
# shapes "unreadable" takes.

# Shared command-position matcher (issue #1455): catches the guarded verb
# after ANY chained command (`git push && gh pr create`), not just after an
# optional leading `cd`. See .claude/hooks/lib/command-match.sh.
# shellcheck source=lib/command-match.sh
__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash ci-green-gate.sh` from inside the hooks dir), which would look for
# `<script-name>/lib/...`. Fall back to the cwd in that case.
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null \
  || ! declare -F gate_matches >/dev/null \
  || ! declare -F gate_target_dir_strict >/dev/null \
  || ! declare -F gate_refuse_unresolved_target >/dev/null \
  || ! declare -F gate_gh_repo_slug >/dev/null \
  || ! declare -F gate_bounded >/dev/null \
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

input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
# Defined HERE, before its first use: assigning it after the matcher left
# `__verb_ere` unset at match time, and under `set -u` that aborted the hook
# with rc=1 on EVERY command -- a gate that errors is a gate that does not
# gate. Caught by its own suite going 0/13.
# No `CDKD_SKIP_CI_GREEN_GATE=1` alternative here: `gate_strip_prefix` already
# removes a leading env assignment before the verb is matched, so carrying one
# was dead pattern (go-to-k/cdkd#2027 review round 4). The bypass is still
# honoured: it is grepped out of the COMMAND TEXT a few lines below, not read
# from the environment, so dropping the alternation from the verb changes
# nothing about it.
__verb_ere="$GATE_RE_GH_PR_MERGE"
if ! gate_matches "$cmd" "$__verb_ere"; then
  exit 0
fi

# Documented escape hatch for no-CI repos.
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])CDKD_SKIP_CI_GREEN_GATE=1([[:space:]]|$)'; then
  echo "ci-green-gate: CDKD_SKIP_CI_GREEN_GATE=1 set; skipping CI-green enforcement" >&2
  exit 0
fi

# Resolve the directory the gh command will run in (cwd-aware, #559).
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "ci-green-gate" "${hook_cwd:-$PWD}"
fi

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi
cd "$target_dir" 2>/dev/null || exit 0

# --- Parse the PR number (same token walk as pr-review-gate.sh). -------
pr_number=""
# The matched-verb strip, not a literal one: `${cmd##*gh pr merge}` returns
# the WHOLE command under `gh -R <owner/repo> pr merge`, and the walk below
# then reads an unrelated integer as the PR number (lib/command-match.sh,
# gate_pr_selector).
# Call the shared selector rather than hand-walking its `_rest` output. The
# first version of this fix replaced the literal STRIP and left the walk, and a
# review measured the consequence: the local valueless list carried only LONG
# spellings, so `gh pr merge -d 2195` took the value-consuming arm, ate the
# number, and the gate judged the CURRENT BRANCH's PR instead. The fence for
# exactly that shape already existed -- inside `gate_pr_selector`, which this
# gate did not call. A fence in a helper protects only the callers that use it.
pr_number="$(gate_pr_selector "$cmd" "$GATE_RE_GH_PR_MERGE")"

# --- Parse the target REPO, and forward it (go-to-k/cdkd#3273). ---------
# A PR NUMBER alone does not name a pull request: the same number exists in
# every repository. This gate recovered the number and then asked `gh pr checks`
# with no `-R`, so it judged whatever repo the SHELL was in. MEASURED through
# this hook with an argv-recording `gh`, from a cdkd worktree:
# `gh pr merge 42 -R go-to-k/cdk-local --squash` produced the argv
# `pr checks 42` -- no `-R`, so gh resolves the CWD's repo and the verdict is
# cdkd's PR 42's. Wrong in both directions, and the dangerous one is a green
# local 42 clearing a red foreign one.
if ! repo_slug=$(gate_gh_repo_slug "$cmd" "$__verb_ere"); then
  cat >&2 <<EOF
Blocked by ci-green-gate: this command names a repository with \`-R\` /
\`--repo\`, but the value is not literal text (an unexpanded \$VAR, a
substitution, or a trailing \`-R\` with no value), so this gate cannot
tell WHICH repository's CI it would have to check.

Asking about the repo this shell happens to be in is exactly the
go-to-k/cdkd#3273 defect - a different PR, in a different repository,
deciding this merge. Refusing instead.

  # spell the slug literally
  gh pr merge ${pr_number:-<PR>} -R <owner>/<repo> --squash --delete-branch

  # ...or run the merge from that repository's own checkout, with no -R
  cd <that repo> && gh pr merge ${pr_number:-<PR>} --squash --delete-branch
EOF
  exit 2
fi

# --- Query live check status. ------------------------------------------
# `gh pr checks` exit codes: 0 = all passed, 1 = some failed/skipped,
# 8 = checks pending, other = infra/arg errors. We inspect the tab-
# separated status column instead of relying on the exit code so
# `skipping` rows (exit 1 territory) don't false-block.
#
# THE CALL IS BOUNDED (go-to-k/cdkd#3273 review). It was not, while
# `pr-review-gate` -- the other hook that makes a network call from inside a
# PreToolUse hook -- has used `gate_bounded` since go-to-k/cdkd#2638. A hook
# killed by its registered timeout emits NO exit 2, which propagates as a
# non-blocking error, i.e. a SILENT PASS on a merge gate. That was tolerable
# only while nothing in the COMMAND TEXT could choose what `gh` talks to;
# forwarding a `-R` slug ends that, and it was measured:
# `gh pr checks <n> -R <unroutable host>/o/r` takes 30 s against this hook's
# registered 20 s, so the gate vanishes on an input the command supplies.
#
# `GATE_BOUNDED_KEEP_STDERR=1` because the "no checks reported" discriminator
# below arrives on gh's STDERR, and `gate_bounded` discards the wrapped
# command's stderr by default (its comment says why).
#
# The argv is assembled rather than spelled as four invocations because
# `gate_bounded` EXECs its arguments and cannot run a shell function. The array
# is never empty (`pr checks` is always there), so the `set -u` / bash 3.2 trap
# that an empty `"${a[@]}"` carries cannot fire; both optional pieces are still
# ABSENT rather than empty, which is the property that mattered (`gh pr checks
# ""` is not `gh pr checks`).
__gh_args=(pr checks)
[ -n "$pr_number" ] && __gh_args+=("$pr_number")
[ -n "$repo_slug" ] && __gh_args+=(-R "$repo_slug")
checks_out=$(GATE_BOUNDED_KEEP_STDERR=1 gate_bounded 6 gh "${__gh_args[@]}" 2>&1)
checks_rc=$?

# A TIMEOUT WITH A SLUG NAMED FAILS CLOSED, for the same reason the arm further
# down does: the command chose the repository, the gate got no answer about it,
# and allowing the merge would clear a PR whose CI this session never saw. With
# NO slug the bound is pure protection against the silent-pass kill and keeps
# today's infra fail-open, so the everyday spelling is untouched.
if [ "$checks_rc" -eq 124 ]; then
  if [ -n "$repo_slug" ]; then
    cat >&2 <<EOF
Blocked by ci-green-gate: \`gh pr checks ${pr_number:-} -R ${repo_slug}\` timed out.

The command names another repository, so there is no infra fail-open here:
a timeout is not an answer, and allowing the merge would clear a PR whose
CI state this gate never read. Required action:

  gh pr checks ${pr_number:-<PR>} -R ${repo_slug} --watch   # confirm it resolves and settles
  # or run the merge from that repository's own checkout.
EOF
    exit 2
  fi
  printf 'ci-green-gate: gh pr checks timed out; allowing merge (infra fail-open)\n' >&2
  exit 0
fi

if printf '%s' "$checks_out" | grep -qiE 'no checks reported'; then
  cat >&2 <<EOF
Blocked by ci-green-gate: no CI checks are reported on this PR yet.

Merging before checks register is the PR #1231 failure shape (merged
while check-build-test was red; main stayed red until fix-forward
#1232). \`--watch\` does NOT cover THIS state: with no checks reported
it returns at once instead of waiting for them to appear, so wrapping
it in a retry loop just spins. Poll until checks EXIST, then watch:

  # Wait for the FIRST row. The discriminator is an EMPTY stdout, not the
  # exit code: rc=1 means EITHER "no checks reported" OR "a check failed".
  while :; do
    out=\$(gh pr checks ${pr_number:-<PR>} 2>/dev/null); rc=\$?
    [ -n "\$out" ] && break        # rows exist -- --watch can take over
    [ "\$rc" = 1 ] || { echo "gh pr checks failed (rc=\$rc)"; break; }
    sleep 20
  done
  gh pr checks ${pr_number:-<PR>} --watch             # once a row exists
  # merge only after every check reports pass/skipping

  # Measured 2026-09-06 (gh 2.89), all four states:
  #   no checks reported  rc=1  stdout 0 bytes   message on STDERR
  #   a check FAILED      rc=1  stdout non-empty
  #   still running       rc=8  stdout non-empty
  #   all pass            rc=0  stdout non-empty
  # So \`--json name,state\` buys nothing here (it is 0 bytes in the same
  # case), and polling on rc alone spins forever on a genuinely failing PR.

If this repo genuinely has no CI, bypass explicitly:
  CDKD_SKIP_CI_GREEN_GATE=1 gh pr merge ${pr_number:-<PR>} --squash --delete-branch
EOF
  exit 2
fi

# WHEN THE COMMAND NAMED A REPO, THERE IS NO INFRA FAIL-OPEN (go-to-k/cdkd#3273).
#
# The fail-open below is for "an unrelated GitHub outage should not block
# merges", and it is kept UNCHANGED for the ordinary cwd-relative merge. It does
# not survive an explicit `-R`: with a slug forwarded, a failure is far more
# likely to be "that repository is not reachable from here" than a global
# outage, and the gate then holds NO information at all about the PR being
# merged -- in a repo whose CI this session has never seen. That is precisely
# the state this hook exists to refuse.
#
# TWO SHAPES, because rc alone does not cover them. A transport error is rc > 1;
# but `gh pr checks <n> -R <unreachable>` answers rc=1 with its message on
# STDERR and NO tab-separated rows, which the `not_green` awk below reads as
# "nothing is red" and passes. So a forwarded slug additionally requires at
# least one parsable row.
#
# NARROW BY CONSTRUCTION: neither branch can fire for a command that names no
# repo, so nothing about the everyday spelling changes. The escape hatch and
# "run it from that repo's checkout" both still clear it.
__checks_rows=$(printf '%s\n' "$checks_out" | awk -F'\t' 'NF >= 2' | wc -l | tr -d '[:space:]')
if [ -n "$repo_slug" ] && { { [ "$checks_rc" -gt 1 ] && [ "$checks_rc" -ne 8 ]; } || [ "$__checks_rows" = 0 ]; }; then
  cat >&2 <<EOF
Blocked by ci-green-gate: could not read CI status for PR ${pr_number:-(current branch)} in ${repo_slug}.

  gh pr checks exited ${checks_rc} and returned no readable check rows:

$checks_out

This command names another repository with \`-R\` / \`--repo\`, so there is
no infra fail-open here: with the lookup failed the gate knows nothing
about the PR it would be clearing, and "unreachable repo" and "GitHub is
down" are the same answer. Required action:

  gh pr checks ${pr_number:-<PR>} -R ${repo_slug} --watch   # confirm it resolves and settles
  # or run the merge from that repository's own checkout, which is what
  # .claude/rules/hooks.md prescribes for sibling-repo work anyway.

If that repository genuinely has no CI, bypass explicitly:
  CDKD_SKIP_CI_GREEN_GATE=1 gh pr merge ${pr_number:-<PR>} -R ${repo_slug} --squash
EOF
  exit 2
fi

# Infra fail-open: transport/auth errors (not a parsable checks table).
if [ "$checks_rc" -gt 1 ] && [ "$checks_rc" -ne 8 ]; then
  printf 'ci-green-gate: gh pr checks failed (rc=%s); allowing merge (infra fail-open)\n' "$checks_rc" >&2
  exit 0
fi

# Status is column 2 of the tab-separated output.
not_green=$(printf '%s\n' "$checks_out" | awk -F'\t' 'NF >= 2 && $2 != "pass" && $2 != "skipping" {print $1 " -> " $2}')

if [ -n "$not_green" ]; then
  cat >&2 <<EOF
Blocked by ci-green-gate: PR ${pr_number:-(current branch)} has checks that are not green:

$not_green

Merging with red or pending CI is the PR #1231 incident shape (merged
while check-build-test was FAILED; main went red until fix-forward
#1232). Required action:

  gh pr checks ${pr_number:-<PR>} --watch   # wait for every check to settle
  # if a check FAILED: fix it on the branch (or fix-forward is no longer
  # needed - the merge never happened), push, wait for green, then merge.

Do NOT chain the merge after a checks DISPLAY - this gate exists
because the printed red status was scrolled past once already.
EOF
  exit 2
fi

exit 0
