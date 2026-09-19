---
name: check-docs
description: Check if documentation (README.md, CLAUDE.md, docs/) is up to date with recent code changes. Use when code has been modified and docs may be stale.
---

# Documentation Consistency Check

You are checking whether documentation is up to date with recent code changes in
this repository.

## Steps

1. **Identify what changed**: `git diff main...HEAD --name-only` (or
   `git diff HEAD~5 --name-only` if on main).

2. **Decide whether a deep review is needed (short-circuit)**. Most internal
   refactors and bug fixes do not affect anything the docs describe. A deep
   review IS required if the diff touches any of:
   - `src/index.ts` — public exports.
   - `src/cli/options.ts`, `src/cli/commands/**` — the CLI surface described in
     `docs/getting-started.md` and the per-command pages under `docs/`.
   - `src/types/**` — public type definitions.
   - `src/state/**` — bucket name, key layout, lock layout, schema version, all
     documented verbatim in `docs/state-management.md`,
     `docs/troubleshooting.md`, `docs/stack-outputs.md` and CLAUDE.md. A
     path-layout change invalidates dozens of shell snippets across them.
   - Any NEW file under `src/**` — it must be reachable from CLAUDE.md's key-file
     index.
   - `package.json` — dependency changes described in CLAUDE.md "Dependencies".
   - `README.md`, `CLAUDE.md`, `docs/**`, `.claude/rules/**`, `plugins/**` — the
     docs themselves. `plugins/**` is a TRIGGER and not only a step-3 target: a
     plugins-only diff matches nothing else, and step 3 is scoped to changed
     SOURCE files.
   - **Any `src/**` file matched by a `paths:` glob in a `.claude/rules/`
     satellite** — in practice nearly every src file. A comment-only or
     message-only edit does NOT exempt it: those rule files assert DECISIONS
     about the code, and a reworded message or a retired rationale is precisely
     what invalidates one.

   If none apply, write "no docs-visible surface touched" and stop.

3. **For each changed source file**, determine what documentation is affected:
   - **Any `src/**` change → the `.claude/rules/` satellites whose `paths:` glob
     matches it.** DERIVE them —
     `for f in .claude/rules/*.md; do echo "$f"; sed -n '/^paths:/,/^---$/p' "$f"; done`,
     or the per-area row in `.claude/rules/code-layout.md` — rather than
     recalling them, and use the `sed` range, not `grep -A<n>`, which truncates
     a file declaring several globs. Then read what each one SAYS about the code
     you changed, not just whether it names your new files. Nothing mechanical
     watches a rule file that asserts a decision.
   - `src/cli/` → CLI options/commands in `docs/getting-started.md`, the
     per-command pages, and CLAUDE.md.
   - `src/synthesis/`, `src/assets/`, `src/deployment/`, `src/analyzer/` → the
     matching section of `docs/architecture.md` and of CLAUDE.md.
   - `src/provisioning/` → `docs/provider-development.md` and
     `docs/provider-rules.md`, plus CLAUDE.md's provider section. For a NEW SDK
     provider also `docs/supported-resources.md` + `docs/import.md`. If the
     provider gates a stabilization wait on `process.env['CDKD_NO_WAIT']`, its
     resource type MUST appear in the per-type wait-semantics table in
     `docs/cli-deploy.md` and in the `noWaitOption` help + JSDoc in
     `src/cli/options.ts` (enforced by
     `tests/unit/provisioning/no-wait-doc-coverage.test.ts`).
   - `src/state/` → `docs/state-management.md`.
   - New exports in `src/index.ts` → public API docs.
   - `package.json` dependency changes → CLAUDE.md "Dependencies".
   - New integration tests → `docs/testing.md` and
     `docs/integ-fixture-conventions.md`.
   - **Any behaviour change → `plugins/cdkd-skills/skills/cdkd/SKILL.md`**, the
     DISTRIBUTED plugin surface, written for an audience that never reads this
     repo. Grep it for the subject you changed. If you edit it, bump the
     `version` in BOTH `plugins/cdkd-skills/.claude-plugin/plugin.json` and
     `.claude-plugin/marketplace.json` in the same PR — nothing enforces that,
     and an un-bumped edit ships to nobody.

4. **Read the relevant documentation sections** and compare with the code, for:
   missing mentions of new files / features / options; outdated descriptions;
   stale lists (provider lists, context-provider lists); hardcoded lists that
   should reference the source directory instead.

5. **Report findings** as a checklist: each discrepancy with its file and
   section, and the suggested fix. If none, confirm the docs are consistent.

6. **Fix the issues**, or ask for confirmation first.

## When to run this

Before committing, and again before opening the PR if anything changed since. It
only needs re-running when one of `src/**`, `docs/**`, `README.md`, `CLAUDE.md`
or `.claude/rules/**` is edited. If issues remain unfixed, fix them and re-run —
do not report the docs consistent.

## Important

- Do NOT create new doc files; check consistency, not completeness.
- Check CLAUDE.md's "Known Limitations" and the changelog entries for stale
  content. **First ask whether this change writes a changelog entry AT ALL**:
  only a user-visible behavior delta does — what the shipped binary does. Agent
  instructions, tests, CI, hooks and behavior-describing docs write none. A
  required entry is ONE file under
  `changelog.d/entries/<YYYY-MM-DD>-<issue>-<slug>.md` carrying the bullet and no
  dated heading, capped at 2000 characters
  (`tests/unit/scripts/changelog-entry-size.test.ts`); a design decision goes to
  `docs/design/<issue>-<slug>.md` instead.
- Prefer referencing source directories over hardcoded lists in docs.
