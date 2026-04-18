---
name: check-docs
description: Check if documentation (README.md, CLAUDE.md, docs/) is up to date with recent code changes. Use when code has been modified and docs may be stale.
---

# Documentation Consistency Check

You are checking whether documentation is up to date with recent code changes in this repository.

## Steps

1. **Identify what changed**: Run `git diff main...HEAD --name-only` (or `git diff HEAD~5 --name-only` if on main) to see recently changed source files.

2. **For each changed source file**, determine what documentation might be affected:
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

3. **Read the relevant documentation sections** and compare with the actual code to find:
   - Missing mentions of new files, features, or options
   - Outdated descriptions that no longer match the code
   - Stale lists (e.g., provider lists, context provider lists) that don't match what's in the source
   - Hardcoded lists that should reference the source directory instead

4. **Report findings** as a checklist:
   - List each discrepancy found with the specific file and section
   - For each issue, suggest the fix
   - If no issues found, confirm documentation is consistent

5. **Fix the issues** if the user agrees, or ask for confirmation first.

## Important

- Do NOT add documentation that doesn't exist yet (don't create new doc files)
- Focus on consistency between existing docs and code, not completeness
- Check CLAUDE.md's "Known Limitations / Recently Implemented" section for stale entries
- Prefer referencing source directories over hardcoded lists in docs
