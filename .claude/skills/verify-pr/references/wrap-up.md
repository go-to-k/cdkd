# Steps 10-12 — Retrospective, residual-nit sweep, PR freshness

Read at step 10 of `/verify-pr`, after the live-test and before the Final Step's
marker chain. All three run once, at the end of the run.

## 10. Retrospective + rules update

- Walk the session that produced this PR. For each surprise, friction, or user
  correction: one-off, or recurring pattern? For each pattern, propose where it
  lands: **hook** (mechanically detectable — strongest), **skill / marker** (a
  pre-action checklist), **memory** (judgmental — weakest). Surface the
  proposals before merging; write agreed code/skill/hook artifacts in the same
  PR.
- The retrospective is itself covered by the `verify-pr` marker — skipping it
  sets the marker on incomplete work.

## 11. Residual review-nit sweep

Mandatory — a multi-PR session once left ~9 reviewer-flagged nits unfiled at
"session complete".

For every reviewer output this session (including re-reviews), walk the
"Minor / Nit / Informational" section. For EACH item, confirm ONE of these
BEFORE setting the `verify-pr` marker (same buckets as CLAUDE.md's
Remaining-work taxonomy):

- (a) **Fixed in this PR** — point at the fix commit / file:line.
- (b) **TODO (issue #N)** — an issue exists AND the PR body references it. The
  issue body MUST carry the four classification lines, one field per line,
  spelled exactly as `.claude/rules/session-report.md` gives them (CLAUDE.md →
  "The four TODO fields") — NOT restated here, because a second copy of a
  template is a second thing to drift — plus the `Dup-check:` line
  `/work-issues` §5-f requires.

  **Reviewers grade on a DIFFERENT scale — translate, do not copy**: `nit` →
  `low`, `minor` → `medium`. There is deliberately no `blocker` arm — a blocker
  is resolved by step 8's fix-back loop; one reaching this step means the steps
  ran out of order. Re-read the mapped value against the Severity scale:
  reviewer severity grades the FINDING, `Severity` grades what stays broken for
  a USER.

  **This step is the deferral moment** — the call gets made here, not at wrap
  time when the evidence is gone. A `now` item must be fixed before the marker
  is set, or re-classified with the reason recorded.
- (c) **Won't-do (decided + recorded)** — the PR body or a comment names the nit
  and why shipping as-is is right.

If none holds for any nit, file a bundled follow-up issue NOW and reference it
from the PR body. Do not set `verify-pr` until every reviewer-flagged item is on
one of the three paths.

Also walk the transcript for memory-rule candidates — each written as a memory
file (with MEMORY.md index entry) or explicitly de-prioritized.

**Auto-close audit**: read the PR body; for every `(#N)` parens-form reference
adjacent to a close keyword, the merge will NOT auto-close — rewrite to
parens-free `Closes #N` or add a manual `gh issue close <N>` step.
`pr-content-checks.yml` also WARNS on it (go-to-k/cdkd#2736), but a warning reds
nothing, so this step is still the one that acts.

## 12. PR title + body freshness

Skip if no PR exists yet — `/create-pr` writes them from scratch.

Follow-up commits routinely stale both.

**Title**: confirm it describes the union of commits; update via
`gh pr edit --title "..."`, or the equivalent
`gh api -X PATCH repos/{owner}/{repo}/pulls/{number} -f title="..."`.
(`gh pr edit` used to fail SILENTLY on a Projects-classic GraphQL deprecation
and a gate blocked it; that is FIXED upstream — measured 2026-09-07 on gh
2.92.0, `--body` exited 0 and the body was replaced — so both spellings work and
the gate is gone.)

**Body**: if the PR has >1 commit, the initial body is almost certainly stale.
Compare `gh pr view <PR> --json body -q .body` against the final diff; flag
bullets describing reverted behavior or removed checks, dead file:line
citations, wording contradicting current docs, stale numeric claims. If stale,
rewrite and patch:

```bash
cat > /tmp/pr-body.md <<'EOF'
## Summary
...
## Test plan
...
EOF
gh api repos/{owner}/{repo}/pulls/{number} -X PATCH --field "body=@/tmp/pr-body.md" -q '.html_url'
```

(Either spelling works since the deprecation was fixed upstream; the
`gh api PATCH` form is kept here because `-F body=@<file>` reads the file
verbatim, which sidesteps shell-escaping a body full of backticks.) Verify with
`gh pr view <PR> --json body -q .body | head -5`.
