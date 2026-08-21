#!/usr/bin/env bash
# check-gate.sh
#
# PreToolUse hook. Blocks `git commit` unless both the `check` and
# `docs` markgate markers are fresh for the current content state.
# Each gate is scoped (see .markgate.yml) so edits to tests-only
# invalidate only `check`, and edits to docs-only invalidate only
# `docs`. Error messages identify which gate needs re-running.
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
# leading `cd <path>` + last `git -C <path>` flag, exactly mirroring
# branch-gate.sh / integ-local-gate.sh, so the markgate verify runs
# against the worktree the commit will actually land in.
#
# WHY every "cannot evaluate" path now BLOCKS (cdkd #2027). Resolution
# can fail, and until #2027 each failure was a silent `exit 0` — the
# gate reported nothing and the commit went through unverified, which
# is indistinguishable from a passing gate. The reproduced case: the
# agent's own standard form
#
#     git -C "$W" add -A && git -C "$W" commit -F <file>
#
# reaches the hook with `$W` UNEXPANDED (the hook sees the command
# text, not the shell's expansion of it). The `git -C` parse took the
# literal token `$W`, treated it as a relative path, joined it onto the
# payload cwd, and `git -C '<cwd>/$W' rev-parse` failed — landing on
# the "not a git repo, silently pass" branch. Verified by driving the
# hook directly: that payload returned exit 0 while the same commit
# written with a literal absolute path returned exit 2.
#
# So an unexpanded path token, an unresolvable target directory, an
# unrunnable markgate, and an unreadable `.markgate.yml` are all now
# refusals naming what could not be evaluated. The refusals are bounded
# by the repo opt-in below so a commit in a genuinely non-markgate repo
# still passes through.
#
# The untrusted-`.mise.toml` half of #2027's report is NOT the fail-open
# (`mise exec` on an untrusted config exits 1, measured), but it is why
# the hook must name a remedy that survives having been tried: issuing
# `mise trust` as an agent Bash tool call can abort inside this
# environment's shell-snapshot wrapper and print nothing but a
# `line 272: : command not found`, so the session reasonably believes the
# worktree is trusted while it is not. The message therefore points at a
# VERIFICATION command, not just at `mise trust`.

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

# The guarded verb. Hoisted because the matcher, the `cd` walk and the
# unresolvable-`cd` probe must all be given the SAME pattern — three
# hand-copied literals is how they drift apart.
COMMIT_VERB='git([[:space:]]+(-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?))*[[:space:]]+commit([[:space:]]|$|[|;&`)])'

# Only gate git commit -- any other command passes through. The
# matcher tolerates `git -C <path> commit` / `git -c <key>=<val> commit`
# / `git --no-pager commit` / etc. by allowing zero or more flag tokens
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! cmd_matches_verb "$cmd" "$COMMIT_VERB"; then
  exit 0
fi

session_dir="${hook_cwd:-$PWD}"

# The repo opt-in (issue #1259) is what BOUNDS the fail-closed refusals
# below: this gate protects repos that follow the markgate convention,
# and a session rooted in such a repo can still run git against OTHER
# repos (a dotfiles checkout, a scratch clone) that have no markers at
# all. Opt-in signal: a `.markgate.yml` at a repo's top level. When we
# cannot even tell whether the session is in such a repo, we are not
# entitled to refuse, so the refusal helper passes through instead.
#
# `opted_in` is set to 1 as soon as the RESOLVED TARGET repo is known to
# carry `.markgate.yml`; before that point the session's own repo is the
# best available proxy.
opted_in=0
session_opted_in() {
  local top
  top=$(git -C "$session_dir" rev-parse --show-toplevel 2>/dev/null) || return 1
  [ -n "$top" ] && [ -f "$top/.markgate.yml" ]
}

# cannot_evaluate <what> [detail-line ...]
#
# FAIL CLOSED (issue #2027). Every caller is a state where the hook does
# not know whether the commit is safe. Refusing is the only answer that
# is not silently indistinguishable from "verified".
cannot_evaluate() {
  local what="$1"; shift
  if [ "$opted_in" != 1 ] && ! session_opted_in; then
    # Not a markgate repo as far as we can tell -- this gate has no
    # standing here, and blocking would be pure friction.
    exit 0
  fi
  echo "Blocked by check-gate: cannot evaluate whether the check / docs markers" >&2
  echo "are fresh, so this gate is failing CLOSED rather than admitting an" >&2
  echo "unverified commit (go-to-k/cdkd#2027)." >&2
  echo "" >&2
  echo "  could not evaluate: $what" >&2
  # Indent EVERY line, including the lines inside a multi-line argument
  # (a captured error body), so the block reads as one unit. Empty lines
  # stay empty rather than becoming trailing whitespace.
  local line
  for line in "$@"; do
    printf '%s\n' "$line" | sed 's/^\(.\)/  \1/' >&2
  done
  exit 2
}

# Where the git command will actually RUN. `gate_target_dir_strict` is the
# SHARED resolver (lib/command-match.sh): it returns non-zero rather than
# guessing when the command names its target with an expression this parser
# cannot read. Both spellings that reach it are refused -- an unexpanded
# `git -C "$W"`, which is the reproduced #2027 case, and an unexpanded
# `cd "$W" &&`, which used to fall back to the payload cwd and verify a
# DIFFERENT tree than the one the commit lands in.
if ! target_dir=$(gate_target_dir_strict "$cmd" "$session_dir" "$COMMIT_VERB"); then
  cannot_evaluate "the target working tree: this command names it with an unexpanded shell variable, so the hook cannot tell which worktree the commit lands in" \
    "" \
    "Re-run the commit with a literal absolute path:" \
    "  git -C /abs/path/to/worktree commit -F <file>" \
    "  cd /abs/path/to/worktree && git commit -F <file>" \
    "(the hook sees the command TEXT, not your shell's expansion of it)"
fi

# An unresolvable target directory is a "cannot evaluate", NOT a pass.
# Note what this costs when the resolution was RIGHT and the directory
# simply is not a repo: nothing. `git commit` there would fail anyway,
# so the only behavior change is a clearer error.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  cannot_evaluate "the target working tree: '$target_dir' is not a git repository" \
    "" \
    "Either the path is wrong, or this hook mis-resolved it. Re-run the" \
    "commit from the worktree itself, or with a literal absolute path:" \
    "  git -C /abs/path/to/worktree commit -F <file>"
fi

# Repo opt-in scope (mirrors branch-gate.sh, issue #1259). Repos without a
# top-level `.markgate.yml` are not markgate repos and pass through: the gate
# would otherwise demand a marker the repo cannot have.
target_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$target_top" || ! -f "$target_top/.markgate.yml" ]]; then
  exit 0
fi
opted_in=1

cd "$target_dir" 2>/dev/null || cannot_evaluate "the target working tree: '$target_dir' exists as a git repo but could not be entered (permissions?)" \
  "" \
  "Fix the directory permissions, then retry the commit."

# Prefer the `.mise.toml`-pinned version via `mise exec --` so the repo's
# canonical markgate wins over an older PATH binary (e.g. Homebrew). Falls
# back to PATH `markgate` for users without mise. The mise-first preference
# is load-bearing across markgate 0.3.x: 0.3.1 bumped the marker schema
# (version 1 -> 2) and a 0.3.0 binary on PATH would silently treat a 0.3.1
# marker as missing, so mixing binaries within a team would constantly
# invalidate each other's markers. Pinning via mise keeps every contributor
# on the same schema regardless of what their Homebrew has.
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by check-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

# Prove the resolved markgate can RUN before trusting any verdict from
# it. `markgate --version` exits 0 on every version this repo has
# pinned; a failure here means the toolchain, not the marker, is the
# problem. The motivating case is #2027's own environment: in a fresh
# worktree whose `.mise.toml` has not been trusted, `mise exec` exits 1
# with a "Config files ... are not trusted" error, and the pre-#2027
# hook reported that as `run /check first` -- a remedy that sends the
# user in a circle, since /check runs through the same untrusted mise.
if ! mg_probe_err=$("${markgate[@]}" --version 2>&1); then
  cannot_evaluate "markgate itself: the pinned binary could not be executed" \
    "" \
    "underlying error:" \
    "$(printf '%s' "$mg_probe_err" | head -3 | sed 's/^/  /')" \
    "" \
    "Fix, from the target worktree -- and note that a bare 'mise trust' can" \
    "silently NO-OP through this environment's shell-snapshot wrapper, so" \
    "VERIFY rather than assuming the step took:" \
    "  env -i HOME=\"\$HOME\" PATH=\"\$PATH\" bash -c 'cd <worktree> && mise trust && mise install'" \
    "  mise exec -- markgate status check   # must print a state: line, not a mise ERROR"
fi

# markgate's exit codes separate a VERDICT from an ERROR: 0 fresh,
# 1 stale / no marker, >=2 it could not evaluate at all (e.g. an
# unparseable `.markgate.yml`). Verified against both 0.2.0 and 0.4.1.
# Capture stderr so a >=2 can name the underlying reason.
check_err=$("${markgate[@]}" verify check 2>&1 >/dev/null)
check_status=$?

docs_err=$("${markgate[@]}" verify docs 2>&1 >/dev/null)
docs_status=$?

if [ "$check_status" -ge 2 ] || [ "$docs_status" -ge 2 ]; then
  cannot_evaluate "the markgate configuration: 'markgate verify' could not read it" \
    "" \
    "underlying error:" \
    "$(printf '%s\n%s' "$check_err" "$docs_err" | grep -v '^$' | head -3 | sed 's/^/  /')" \
    "" \
    "Fix .markgate.yml at the repo root, then retry the commit."
fi

if [ "$check_status" -eq 0 ] && [ "$docs_status" -eq 0 ]; then
  exit 0
fi

# Extract the parenthesized reason from `markgate status <gate>` so the
# error message tells the user *why* the gate is stale (digest differs vs
# expired by ttl vs child gate stale) instead of just naming the skill.
# Fails open: empty string when extraction fails (markgate too old, no
# parenthetical, or status itself errored), and the message falls back to
# the pre-0.3 generic hint text.
gate_reason() {
  "${markgate[@]}" status "$1" 2>/dev/null \
    | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }'
}

msg="Blocked by check-gate:"
if [ "$check_status" -ne 0 ]; then
  reason=$(gate_reason check)
  if [ -n "$reason" ]; then
    msg="$msg run /check first $reason;"
  else
    msg="$msg run /check first (or re-run if src/tests/config changed);"
  fi
fi
if [ "$docs_status" -ne 0 ]; then
  reason=$(gate_reason docs)
  if [ -n "$reason" ]; then
    msg="$msg run /check-docs first $reason;"
  else
    msg="$msg run /check-docs first (or re-run if src/docs/README/CLAUDE.md changed);"
  fi
fi
msg="$msg then retry the commit."
echo "$msg" >&2
exit 2
