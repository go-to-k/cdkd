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
   - `src/cli/options.ts`, `src/cli/commands/**` — CLI surface described in README.md
   - `src/types/**` — public type definitions
   - **any new file added** anywhere under `src/**` — must be mentioned in CLAUDE.md "Key Files and Directories"
   - `package.json` — dependency additions/removals described in CLAUDE.md "Dependencies"
   - `README.md`, `CLAUDE.md`, `docs/**` — the docs themselves
   - README-visible CLI behavior changes (new flags, changed defaults, new commands)

   If none of the above apply (only internal src files modified, no new files, no deps changed), write a one-line note — "no docs-visible surface touched" — set the `docs` marker (see "Commit-gate marker" below), and stop. Do NOT re-read docs for unrelated internal edits.

3. **For each changed source file** (when a deep review is warranted), determine what documentation might be affected:
   - `src/cli/` changes → check CLI options/commands in README.md, CLAUDE.md
   - `src/synthesis/` changes → check docs/architecture.md synthesis section, CLAUDE.md synthesis section
   - `src/assets/` changes → check docs/architecture.md asset section, CLAUDE.md asset section
   - `src/deployment/` changes → check docs/architecture.md deployment section, CLAUDE.md deployment section
   - `src/provisioning/` changes → check docs/provider-development.md, CLAUDE.md provider section
   - `src/analyzer/` changes → check docs/architecture.md analysis section
   - `src/state/` changes → check docs/state-management.md
   - New files added → check if they're mentioned in CLAUDE.md "Key Files and Directories"
   - New exports in `src/index.ts` → check if public API docs are updated
   - `package.json` dependency changes → check CLAUDE.md "Dependencies" section
   - New CLI options → check README.md usage section
   - New integration tests → check docs/testing.md

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

After documentation is verified consistent (either no issues were found, or all issues were fixed), record the `docs` markgate marker so the PreToolUse `check-gate` hook (see `.claude/hooks/check-gate.sh`) allows the next `git commit`. The `docs` gate is scoped to `src/**`, `docs/**`, `README.md`, and `CLAUDE.md` via `.markgate.yml`, so it only invalidates when one of those is edited.

Run from the repo root (use `mise exec` to avoid PATH issues when shims aren't active):

```bash
mise exec -- markgate set docs
```

Skip this step if issues remain unfixed — a stale or missing marker correctly forces the user (or Claude) to re-run `/check-docs` after fixing docs.

## Important

- Do NOT add documentation that doesn't exist yet (don't create new doc files)
- Focus on consistency between existing docs and code, not completeness
- Check CLAUDE.md's "Known Limitations / Recently Implemented" section for stale entries
- Prefer referencing source directories over hardcoded lists in docs
