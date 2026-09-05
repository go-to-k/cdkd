---
name: check-docs
description: Check if documentation (README.md, CLAUDE.md, docs/) is up to date with recent code changes. Use when code has been modified and docs may be stale.
---

# Documentation Consistency Check

You are checking whether documentation is up to date with recent code changes in this repository.

## Steps

1. **Identify what changed**: Run `git diff main...HEAD --name-only` (or `git diff HEAD~5 --name-only` if on main) to see recently changed source files.

2. **Decide whether a deep review is needed (short-circuit)**. The `docs` gate's scope includes `src/**`, so any src edit invalidates the marker — but most internal refactors and bug fixes don't affect anything the docs describe. Skip the LLM-judged review and set the marker directly when the diff **only** touches files that the docs don't describe. A deep review is required if the diff touches ANY of:
   - `src/index.ts` — public exports
   - `src/cli/options.ts`, `src/cli/commands/**` — CLI surface described in docs/getting-started.md and the per-command pages under docs/ (the README's usage sections moved there)
   - `src/types/**` — public type definitions
   - `src/state/**` — bucket name, key layout, lock layout, schema version. These are documented verbatim in `docs/state-management.md`, `docs/troubleshooting.md`, `docs/stack-outputs.md` (the "Outputs" example path), and CLAUDE.md ("S3 storage structure"). A path-layout change in `s3-state-backend.ts` or `lock-manager.ts` invalidates ~30 shell snippets across those files; the auto-migration session of 2026-05-01 (PR #57 → v0.7.0) shipped before this trigger existed and the docs took the full rollout to be re-aligned.
   - **any new file added** anywhere under `src/**` — must be mentioned in CLAUDE.md "Key Files and Directories"
   - `package.json` — dependency additions/removals described in CLAUDE.md "Dependencies"
   - `README.md`, `CLAUDE.md`, `docs/**`, `.claude/rules/**` — the docs themselves
   - README-visible CLI behavior changes (new flags, changed defaults, new commands)
   - **ANY `src/**` file matched by a `paths:` glob in a `.claude/rules/` satellite.** In practice that is nearly every src file — `code-layout.md` routes each area to one — so this trigger is the reason the short-circuit below is narrow rather than the common case. It is listed HERE, in the step-2 gate, and not only in step 3: the satellites were previously named as a step-3 TARGET while the paths that reach them were not step-2 TRIGGERS, so a change confined to `src/provisioning/**` or `src/deployment/**` short-circuited out and the marker was set with no rule file opened. That is exactly how issue [#2615](https://github.com/go-to-k/cdkd/issues/2615) reached review with a rule file still teaching a decision the same PR had reverted. A comment-only or message-only edit does NOT exempt it: those rule files assert DECISIONS about the code, and a reworded message or a retired rationale is precisely what invalidates one.

   If none of the above apply (only internal src files modified, no new files, no deps changed, and no `.claude/rules/` satellite claims the paths), write a one-line note — "no docs-visible surface touched" — set the `docs` marker (see "Commit-gate marker" below), and stop. Do NOT re-read docs for unrelated internal edits.

3. **For each changed source file** (when a deep review is warranted), determine what documentation might be affected:
   - **ANY `src/**` change → the `.claude/rules/` satellites whose `paths:` frontmatter glob matches the changed file.** DERIVE them (`for f in .claude/rules/*.md; do echo "$f"; sed -n '/^paths:/,/^---$/p' "$f"; done`, or the per-area row in `.claude/rules/code-layout.md`) rather than recalling them, then read what each SAYS about the code you changed — not just whether it names your new files. Use the `sed` range and not a `grep -A<n>` form, which silently truncates the rule files declaring several globs. The corpus is in the `docs` gate's scope, so a src edit stales its marker; it appeared in this skill only as a step-2 TRIGGER and never as a TARGET, so the marker could be set with no rule file opened. That is how issue [go-to-k/cdkd#2615](https://github.com/go-to-k/cdkd/issues/2615) reached review with a merge blocker: it hedged `renderStatefulReason('has-objects')` while `.claude/rules/layout-provisioning.md` still read that that wording "stays assertive by an explicit, recorded decision" **and** told future sessions to consult that record before rewording a case — an instruction to restore what the same PR had retired. Pay particular attention to a rule file asserting a DECISION about the code: nothing mechanical watches one. A phrase-sync test (`tests/unit/deployment/stateful-replace-message-doc-sync.test.ts`) pins a QUOTE, never a claim about why the quote is what it is.
   - `src/cli/` changes → check CLI options/commands in docs/getting-started.md + the per-command pages under docs/, and CLAUDE.md
   - `src/synthesis/` changes → check docs/architecture.md synthesis section, CLAUDE.md synthesis section
   - `src/assets/` changes → check docs/architecture.md asset section, CLAUDE.md asset section
   - `src/deployment/` changes → check docs/architecture.md deployment section, CLAUDE.md deployment section
   - `src/provisioning/` changes → check docs/provider-development.md AND docs/provider-rules.md (the rules corpus split out of it), plus the CLAUDE.md provider section. For a NEW SDK provider ALSO check docs/supported-resources.md + docs/import.md (per `.claude/rules/providers.md` "Adding a New SDK Provider"). **If the provider gates a stabilization wait on `process.env['CDKD_NO_WAIT']`** (i.e. `--no-wait` skips a multi-minute poll for this type), its resource type MUST appear in the per-type wait-semantics table + its intro in docs/cli-deploy.md, and the `noWaitOption` help + JSDoc in src/cli/options.ts (the README no longer enumerates flags — that content lives in docs/cli-deploy.md's table). Enforced by `tests/unit/provisioning/no-wait-doc-coverage.test.ts` (CI fails if a `CDKD_NO_WAIT` provider is absent from the cli-deploy.md `--no-wait` table). The `AWS::Lambda::MicrovmImage` provider shipped honoring `--no-wait` but missed this list — this bullet + that test are the backstop.
   - `src/analyzer/` changes → check docs/architecture.md analysis section
   - `src/state/` changes → check docs/state-management.md
   - New files added → check if they're mentioned in CLAUDE.md "Key Files and Directories"
   - New exports in `src/index.ts` → check if public API docs are updated
   - `package.json` dependency changes → check CLAUDE.md "Dependencies" section
   - New CLI options → check docs/getting-started.md and the per-command pages under docs/ (the README's usage cheatsheet moved there)
   - New integration tests → check docs/testing.md AND docs/integ-fixture-conventions.md (the fixture rules split out of it)

4. **Read the relevant documentation sections** and compare with the actual code to find:
   - Missing mentions of new files, features, or options
   - Outdated descriptions that no longer match the code
   - Stale lists (e.g., provider lists, context provider lists) that don't match what's in the source
   - Hardcoded lists that should reference the source directory instead

5. **Report findings** as a checklist:
   - List each discrepancy found with the specific file and section
   - For each issue, suggest the fix
   - If no issues found, confirm documentation is consistent

6. **Fix the issues** if the user agrees, or ask for confirmation first.

## Commit-gate marker (on success only)

After documentation is verified consistent (either no issues were found, or all issues were fixed), record the `docs` markgate marker so the PreToolUse `check-gate` hook (see `.claude/hooks/check-gate.sh`) allows the next `git commit`. The `docs` gate is scoped to `src/**`, `docs/**`, `README.md`, `CLAUDE.md`, and `.claude/rules/**` via `.markgate.yml`, so it only invalidates when one of those is edited.

Run from the repo root (use `mise exec` to avoid PATH issues when shims aren't active):

```bash
mise exec -- markgate set docs
```

Skip this step if issues remain unfixed — a stale or missing marker correctly forces the user (or Claude) to re-run `/check-docs` after fixing docs.

## Important

- Do NOT add documentation that doesn't exist yet (don't create new doc files)
- Focus on consistency between existing docs and code, not completeness
- Check CLAUDE.md's "Known Limitations" section AND `docs/changelog-cdkd.md` (the per-PR shipped-feature changelog moved out of CLAUDE.md per Claude Code's ≤200-line memory guidance) for stale entries. A new entry there is capped at 2000 characters over the bullet and its continuation lines (issue go-to-k/cdkd#2552, enforced by `tests/unit/scripts/changelog-entry-size.test.ts`): keep the behavior delta, the changed files, and the issue / PR + residual numbers, and put a design decision in `docs/design/<issue>-<slug>.md` or a mechanism in the implementing module's or test's doc comment, linked from the entry
- Prefer referencing source directories over hardcoded lists in docs
