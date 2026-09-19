# Steps 10-12 — Retrospective, residual-nit sweep, PR freshness

Read at step 10 of `/verify-pr`, after the live-test and before the Final Step.
All three run once, at the end of the run.

## 10. Retrospective + rules update

- Walk the session that produced this PR. For each surprise, friction, or user
  correction: one-off, or recurring pattern? For each pattern, propose where it
  lands. A NEW hook, fence or rule paragraph is added only on the SECOND
  occurrence of the same failure — the first goes to
  [../../../../docs/tooling-backlog.md](../../../../docs/tooling-backlog.md) and
  nothing is built.
- The retrospective is part of the checklist, not an optional coda.

## 11. Residual review-nit sweep

Mandatory. For every reviewer output this session (including re-reviews), walk
the "Minor / Nit / Informational" section. For EACH item, confirm ONE of these
BEFORE reporting the PR ready (the same buckets as CLAUDE.md's Remaining-work
taxonomy):

- (a) **Fixed in this PR** — point at the fix commit / file:line.
- (b) **TODO (issue #N)** — an issue exists AND the PR body references it. The
  issue body carries the four classification lines, one field per line, spelled
  exactly as [../../../rules/session-report.md](../../../rules/session-report.md)
  gives them, plus the `Dup-check:` line `/work-issues` requires.

  **Reviewers grade on a DIFFERENT scale — translate, do not copy**: `nit` →
  `low`, `minor` → `medium`. There is deliberately no `blocker` arm: a blocker is
  resolved by step 8's fix-back loop, and one reaching this step means the steps
  ran out of order. Reviewer severity grades the FINDING; `Severity` grades what
  stays broken for a USER.

  **This step is the deferral moment** — the call is made here, not at wrap time
  when the evidence is gone. **(a) is the default, not (b)**: a nit a reviewer
  found lives in a file this session just reviewed, so the Session-fit context
  test makes it `now` unless external input blocks it. A `now` item is fixed
  before the PR is reported ready, or re-classified with the reason recorded.
- (c) **Won't-do (decided + recorded)** — the PR body or a comment names the nit
  and why shipping as-is is right.

Also walk the transcript for memory-rule candidates — each written as a memory
file (with its MEMORY.md index entry) or explicitly de-prioritized.

**Auto-close audit**: read the PR body; for every `(#N)` parens-form reference
adjacent to a close keyword, the merge will NOT auto-close — rewrite to the
parens-free `Closes #N`, or add a manual `gh issue close <N>` step.
`pr-content-checks.yml` warns on it, but a warning reds nothing.

## 12. PR title + body freshness

Skip if no PR exists yet — `/create-pr` writes them from scratch. Follow-up
commits routinely stale both.

**Title**: confirm it describes the union of commits; update with
`gh pr edit --title "..."`.

**Body**: if the PR has more than one commit, the initial body is almost
certainly stale. Compare `gh pr view <PR> --json body -q .body` against the final
diff; flag bullets describing reverted behavior or removed checks, dead file:line
citations, wording contradicting current docs, and stale numeric claims. If
stale, rewrite and patch:

```bash
cat > /tmp/pr-body.md <<'EOF'
## Summary
...
## Test plan
...
EOF
gh api repos/{owner}/{repo}/pulls/{number} -X PATCH --field "body=@/tmp/pr-body.md" -q '.html_url'
```

(`gh pr edit --body-file` works too; the `gh api` form is kept because
`--field body=@<file>` reads the file verbatim, which sidesteps shell-escaping a
body full of backticks.) Verify with
`gh pr view <PR> --json body -q .body | head -5`.
