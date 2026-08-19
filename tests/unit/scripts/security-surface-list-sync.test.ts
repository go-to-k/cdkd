import { describe, it, expect } from 'vite-plus/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The "security / process-launch surface" path list is duplicated in FOUR
 * places, one of which is executable:
 *
 *   1. `.claude/hooks/pr-review-gate.sh`  -- `UP_PATH_REGEX`, a live merge gate
 *   2. `.claude/skills/review-pr/SKILL.md` -- the bullet list the hook calls
 *      its source of truth
 *   3. `.claude/agents/pr-security-reviewer.md` -- section 4
 *   4. `CLAUDE.md` -- twice (gate description + "PR review pattern")
 *
 * Two failure modes, both observed in the wild and both silent:
 *
 *   - A listed path stops existing. `src/local/lambda-authorizer.ts` outlived
 *     its move to cdk-local in PR #691, and `src/local-invoke/docker-runner.ts`
 *     outlived the PR #228 rename to `src/local/`. A dead alternative can never
 *     match, so the gate quietly stopped up-biasing the surface it named, and
 *     the files that inherited the logic went unlisted (issue #1972).
 *   - The copies drift apart, so the hook and the skill disagree about the tier
 *     a PR needs -- the same class the down-bias list already carries a
 *     "keep in sync" comment for.
 *
 * Both are mechanically detectable, which is why this is a test rather than
 * another sentence asking humans to remember.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const HOOK = join(repoRoot, '.claude', 'hooks', 'pr-review-gate.sh');
const SKILL = join(repoRoot, '.claude', 'skills', 'review-pr', 'SKILL.md');
const AGENT = join(repoRoot, '.claude', 'agents', 'pr-security-reviewer.md');
const CLAUDE_MD = join(repoRoot, 'CLAUDE.md');

/**
 * Floor for every extractor below. A regex that silently stops matching would
 * otherwise make this whole file pass by comparing empty sets against each
 * other -- the "a lint must prove it sees its input" trap.
 */
const MIN_PATHS = 5;

/** Concrete `src/**` file paths in the hook's UP_PATH_REGEX. */
function hookPaths(): string[] {
  const sh = readFileSync(HOOK, 'utf8');
  const m = sh.match(/^UP_PATH_REGEX='\^\((.+)\)\$'$/m);
  expect(m, 'pr-review-gate.sh must define an anchored UP_PATH_REGEX').not.toBeNull();
  return m![1]
    .split('|')
    .map((alt) => alt.replace(/\\\./g, '.'))
    // Drop directory globs (`src/provisioning/providers/.*`) -- only concrete
    // files can be existence-checked.
    .filter((alt) => !alt.includes('.*'))
    .sort();
}

/** The bullet list under "security / process-launch surface" in the skill. */
function skillPaths(): string[] {
  const md = readFileSync(SKILL, 'utf8');
  const start = md.indexOf('security / process-launch surface');
  expect(start, 'review-pr SKILL.md must have a security-surface bullet list').toBeGreaterThan(-1);
  const rest = md.slice(start);
  const end = rest.indexOf('- Any path under');
  expect(end, 'the bullet list must be followed by the providers/** bullet').toBeGreaterThan(-1);
  return [
    ...new Set(
      (rest.slice(0, end).match(/^\s+- `(src\/[^`]+)`$/gm) ?? []).map(
        (line) => line.match(/`(src\/[^`]+)`/)![1],
      ),
    ),
  ].sort();
}

/** Section 4 of the security reviewer's own definition. */
function agentPaths(): string[] {
  const md = readFileSync(AGENT, 'utf8');
  const start = md.indexOf('### 4. AuthZ');
  expect(start, 'pr-security-reviewer.md must have an AuthZ/authn section').toBeGreaterThan(-1);
  const rest = md.slice(start);
  const end = rest.indexOf('### 5.');
  const section = end > -1 ? rest.slice(0, end) : rest;
  return [
    ...new Set((section.match(/`(src\/[a-z0-9\-/]+\.ts)`/g) ?? []).map((m) => m.slice(1, -1))),
  ].sort();
}

/**
 * CLAUDE.md carries the list twice in two different spellings: a
 * slash-separated form in the gate description and a brace-expansion form in
 * the "PR review pattern" bullet. Both must expand to the same set.
 */
function claudeMdPathSets(): string[][] {
  const md = readFileSync(CLAUDE_MD, 'utf8');

  const slashForm = md.match(
    /any path under (`src\/[a-z0-9\-/]+\.ts`(?: \/ `src\/[a-z0-9\-/]+\.ts`)+)/,
  );
  expect(slashForm, 'CLAUDE.md must carry the slash-separated surface list').not.toBeNull();
  const slashPaths = (slashForm![1].match(/`(src\/[^`]+)`/g) ?? []).map((m) => m.slice(1, -1));

  // The brace form is written per-directory: `src/utils/{a,b}.ts`,
  // `src/local/{c,d}.ts`. Expand every group rather than assuming one.
  const braceGroups = [...md.matchAll(/`(src\/[a-z0-9\-]+)\/\{([a-z0-9,\-]+)\}\.ts`/g)];
  expect(
    braceGroups.length,
    'CLAUDE.md must carry the brace-expansion surface list',
  ).toBeGreaterThan(0);
  const bracePaths = braceGroups.flatMap(([, dir, names]) =>
    names.split(',').map((n) => `${dir}/${n}.ts`),
  );

  return [slashPaths.sort(), bracePaths.sort()];
}

describe('security-surface path list', () => {
  it('names only files that exist (a dead path can never fire)', () => {
    const paths = hookPaths();
    expect(paths.length).toBeGreaterThanOrEqual(MIN_PATHS);
    const missing = paths.filter((p) => !existsSync(join(repoRoot, p)));
    expect(
      missing,
      `UP_PATH_REGEX names path(s) that do not exist, so the merge gate can never ` +
        `up-bias them: ${missing.join(', ')}. Either restore the file or replace ` +
        `the entry with the path that inherited its logic (issue #1972).`,
    ).toEqual([]);
  });

  it('is in sync between the hook regex and the /review-pr skill', () => {
    const hook = hookPaths();
    const skill = skillPaths();
    expect(skill.length).toBeGreaterThanOrEqual(MIN_PATHS);
    expect(
      skill,
      'pr-review-gate.sh UP_PATH_REGEX and review-pr/SKILL.md disagree; the hook ' +
        'comment declares the skill list its source of truth, so a PR would get a ' +
        'different tier from the gate than from the skill.',
    ).toEqual(hook);
  });

  it('is in sync between the hook regex and the pr-security-reviewer definition', () => {
    const hook = hookPaths();
    const agent = agentPaths();
    expect(agent.length).toBeGreaterThanOrEqual(MIN_PATHS);
    expect(
      agent,
      'pr-security-reviewer.md section 4 lists a different surface set than the ' +
        'gate, so the reviewer would be told to audit files the gate never flags.',
    ).toEqual(hook);
  });

  it('is in sync across both spellings in CLAUDE.md', () => {
    const hook = hookPaths();
    const [slashPaths, bracePaths] = claudeMdPathSets();
    expect(slashPaths.length).toBeGreaterThanOrEqual(MIN_PATHS);
    expect(bracePaths.length).toBeGreaterThanOrEqual(MIN_PATHS);
    expect(slashPaths, 'CLAUDE.md gate description drifted from UP_PATH_REGEX').toEqual(hook);
    expect(bracePaths, 'CLAUDE.md "PR review pattern" drifted from UP_PATH_REGEX').toEqual(hook);
  });
});
