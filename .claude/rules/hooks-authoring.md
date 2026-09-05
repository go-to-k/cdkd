---
description: Authoring a cdkd hook - why every Bash gate stays unconditional, and the unquoted-heredoc trap that executes a refusal message's worked example instead of printing it
paths:
  - '.claude/hooks/*.sh'
  - '.claude/settings.json'
---

# Why every Bash gate stays unconditional

**Every Bash-targeting `PreToolUse` entry in `.claude/settings.json` uses the
coarse `Bash` matcher AND no per-hook `if:` condition.** The absent `if:` is
the load-bearing half: each gate parses the command itself, which is what
lets gates catch the `cd <path> && ...` and `gh -C <path>` spellings.

The `if:` fields silently never fired (go-to-k/cdkd#1455 / #1476 — see "The
`if:` layer is GONE" in [hooks.md](hooks.md), which this file split out of). Their removal also immunises cdkd against the
go-to-k/cdk-real-drift#1788 bypass class (measured 2026-08-19 via
go-to-k/cdkd#2016: that repo's matcher was the coarse `Bash` too — the
asymmetry was per-hook `if:` conditions; cdkd carries 0 `if:` fields across
35 Bash hooks, and `check-gate` / `verify-pr-gate` answer rc=2 for the bare
and the `cd <wt> && ...` spellings alike). This matters because
`/work-issues` writes commands in exactly that form. **Fenced by
`tests/unit/scripts/settings-bash-matcher-coverage.test.ts`**: fails on any
per-hook `if:`, any command-narrowed `Bash(...)` matcher, and the removal of
`check-gate` / `verify-pr-gate` / `non-english-text-gate` from the coarse
entry, with a parser floor so "found nothing" cannot pass as "everything
matches".

# Writing a hook's refusal message

**A hook that prints its remediation with `cat >&2 <<EOF` is running an
UNQUOTED heredoc**, so `$( )`, backticks and `$var` in the body expand at
REFUSAL time rather than printing. That matters here more than in ordinary
shell, because a refusal message is exactly where a worked example belongs:
the useful advice is a command, and a command is what the heredoc eats.

Measured 2026-09-06 (issue [#2630](https://github.com/go-to-k/cdkd/issues/2630),
PR [#2652](https://github.com/go-to-k/cdkd/pull/2652)): `ci-green-gate`'s
no-checks branch gained an advised poll containing `$(gh pr checks ...)`. The
agent read `until [ -n "" ]; do sleep 20; done` — an unconditional infinite
loop, since the substitution had already run and returned empty — preceded by
a `command not found` line from an unescaped backtick, and the gate fired a
SECOND live `gh` call from inside a PreToolUse hook. The advice shipped the
exact hot-spin it was written to remove, deterministically: that branch only
runs when stdout is empty.

Two rules follow:

- **Escape every `$` and backtick you mean to PRINT** (`\$(`, `` \` ``), or
  switch the delimiter to `<<'EOF'` and interpolate the few values you do want
  with a separate `printf`. `${pr_number:-<PR>}` in that message is deliberate
  — it is the one value that SHOULD expand.
- **Assert the rendered message in the hook's test harness**, not a
  re-statement of it. A case that drives a predicate the test file declares
  passes just as well when the hook's text is reverted or replaced with
  nonsense; only reading the hook's own stderr catches an executed heredoc,
  because the damage is visible nowhere else.
