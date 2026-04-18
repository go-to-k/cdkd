---
name: review-pr
description: Review PR changes for correctness, completeness, and consistency before merge. Catches issues that automated checks (typecheck, lint, tests) cannot.
argument-hint: "[PR-number]"
---

# PR Code Review

Review the actual code changes to verify they correctly and completely address the requirements.

## Steps

1. **Gather context**:
   - `git diff main...HEAD` — full diff of all changes
   - `git log main...HEAD --oneline` — commit history
   - If PR exists: `gh pr view --json title,body` — PR description and stated goals

2. **Review each changed file**:
   - Read the diff carefully and understand what each change does
   - For each change, ask: is this correct? is this complete? is this necessary?
   - Look for:
     - Logic errors or edge cases not handled
     - Unnecessary changes (reverted code still in diff, dead code, unrelated changes)
     - Missing error handling
     - Inconsistencies between changed files

3. **Verify requirements coverage**:
   - Compare the PR description/title against the actual diff
   - Are all stated goals implemented?
   - Are there changes not mentioned in the PR description?
   - Does the PR title accurately reflect what the diff does?

4. **Check for common issues**:
   - Files that were changed and then reverted (should not appear in diff)
   - Stale commit messages from intermediate iterations that don't match the final state
   - New code paths without corresponding unit tests
   - Documentation that contradicts the code changes

5. **Verify consistency**:
   - Do all callers of changed functions handle the new behavior?
   - Are type definitions consistent with implementation?
   - Are related files updated together (e.g., if a type is added, is it used)?

## Output

Report findings as:

### Summary
One-line verdict: ready to merge / needs fixes

### Issues (if any)
- List each issue with file path and description

### Suggestions (if any)
- Optional improvements (not blocking merge)
