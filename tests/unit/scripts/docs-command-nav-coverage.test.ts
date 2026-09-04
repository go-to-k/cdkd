import { describe, it, expect } from 'vite-plus/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProgram } from '../../../src/cli/program.js';

/**
 * Fences every registered top-level `cdkd` command against the documentation
 * site, so a command cannot ship with no page and no navigation entry.
 *
 * `cdkd migrate` did exactly that. It was registered, released, and covered by
 * an integ fixture while having no reference page, no entry in the site's
 * `CLI Reference` navigation group, and no mention from the import guide it is
 * adjacent to. It was found by a reader asking whether the command existed at
 * all -- not by any check, because none of the existing ones look here:
 *
 *   - `scripts/check-integ-cli-flags.ts` validates integ-fixture invocations
 *     against the real Commander tree. Fixtures, not docs.
 *   - `scripts/build-cli-flag-coverage-matrix.ts` measures which flags the
 *     fixtures exercise. Again fixtures.
 *   - `tests/unit/scripts/docs-site-links.test.ts` validates links between
 *     pages that exist. It cannot see a page that was never written.
 *
 * WHY A MAP RATHER THAN A `cli-<command>.md` CONVENTION. Measured on the tree
 * this file was written against: seven of the nineteen commands have no
 * `cli-<command>` page, but five of those seven ARE documented, under a
 * differently-named page that the navigation does list -- `import` under the
 * import guide, `orphan` under the orphan-vs-destroy comparison, `local` under
 * the local-execution overview, and `list` / `synth` inside the CLI Reference
 * overview itself. A bare naming-convention assertion would therefore have
 * pushed five documented commands into an exclusion list, leaving a fence that
 * is mostly exclusion and teaches nothing about the commands that are genuinely
 * missing. (Of the two that were: `force-unlock` got the reference page this
 * measurement showed it never had, and `migrate` is the entry below.)
 *
 * So the map is the assertion: naming the page is the act of claiming the
 * command is documented, and the claim is then CHECKED -- the page must exist,
 * must be reachable from the navigation, and must actually mention the command.
 * Anything a maintainer cannot make that claim for goes in `UNDOCUMENTED` with
 * a reason, which is the point: leaving a command undocumented becomes a
 * deliberate, reviewed act rather than an omission nobody sees.
 *
 * WHAT THIS DOES NOT PROVE. That a page documents a command WELL, or covers its
 * flags -- only that a nav-reachable page names it. The mention check rejects a
 * mapping pointed at an unrelated page; it does not grade the prose.
 */
const repoRoot = join(import.meta.dirname, '..', '..', '..');
const DOCS_CONFIG = join(repoRoot, 'vite.docs.config.ts');

/**
 * Command -> the navigation path of the page that documents it.
 *
 * The path is the site path as written in `vite.docs.config.ts` (`/cli-gc`),
 * which maps to `docs/<path>.md`.
 */
const COMMAND_PAGES: Readonly<Record<string, string>> = {
  bootstrap: '/cli-bootstrap',
  deploy: '/cli-deploy',
  destroy: '/cli-destroy',
  diff: '/cli-diff',
  drift: '/cli-drift',
  events: '/cli-events',
  export: '/cli-export',
  'force-unlock': '/cli-force-unlock',
  gc: '/cli-gc',
  import: '/import',
  list: '/cli-reference',
  local: '/local-emulation',
  orphan: '/orphan-vs-destroy',
  'publish-assets': '/cli-publish-assets',
  rollback: '/cli-rollback',
  scrub: '/cli-scrub',
  state: '/cli-state',
  synth: '/cli-reference',
};

/**
 * Commands deliberately shipped with no documentation page, each with the
 * reason. An entry here is a decision on the record, not a free pass -- adding
 * one should be as visible in review as adding a command.
 */
const UNDOCUMENTED: Readonly<Record<string, string>> = {
  migrate:
    'Held pending the deprecation decision in go-to-k/cdkd#2572 -- it is the only ' +
    'command that requires the AWS CDK CLI binary, so whether it stays at all is ' +
    'undecided. Writing a reference page for it first would be premature.',
};

/**
 * Commander adds `help` to the tree itself; it is not a cdkd command and has
 * no page to expect.
 */
const BUILT_IN = new Set(['help']);

/**
 * Floors, so a parse that has gone blind cannot report green having compared
 * nothing. "The tree yielded no commands" and "every command is documented"
 * are the same pass without these. Both sit a few entries below the measured
 * counts (19 commands, 48 nav paths) so an ordinary removal does not force a
 * test edit, while a total parse failure cannot clear them.
 */
const MIN_COMMANDS = 15;
const MIN_NAV_PATHS = 30;

/** Top-level command names, aliases excluded (they resolve to the same page). */
function topLevelCommandNames(): string[] {
  return buildProgram()
    .commands.map((c) => c.name())
    .filter((n) => !BUILT_IN.has(n));
}

/** Every `path: '/x'` entry in the hand-authored site navigation. */
function navPaths(): Set<string> {
  const source = readFileSync(DOCS_CONFIG, 'utf8');
  const paths = [...source.matchAll(/path:\s*'(\/[a-z0-9-]+)'/g)].map((m) => m[1] as string);
  expect(
    paths.length,
    `${DOCS_CONFIG}: extracted ${paths.length} navigation paths, below the floor of ` +
      `${MIN_NAV_PATHS}. Either the navigation genuinely shrank (lower the floor ` +
      `deliberately) or this extractor stopped seeing its input -- an empty set makes ` +
      `every "is this path in the nav" assertion below vacuously false and the ` +
      `mapping assertions vacuously true.`
  ).toBeGreaterThanOrEqual(MIN_NAV_PATHS);
  return new Set(paths);
}

/** `/cli-gc` -> `docs/cli-gc.md`. */
function docFileFor(navPath: string): string {
  return join(repoRoot, 'docs', `${navPath.slice(1)}.md`);
}

const commands = topLevelCommandNames();
const nav = navPaths();

describe('docs command/nav coverage', () => {
  it('reads a plausible command tree', () => {
    expect(
      commands.length,
      `buildProgram() yielded ${commands.length} top-level commands, below the floor of ` +
        `${MIN_COMMANDS}. Every assertion below iterates this list, so an empty or ` +
        `truncated tree passes them all while checking nothing.`
    ).toBeGreaterThanOrEqual(MIN_COMMANDS);
  });

  it('accounts for every registered top-level command', () => {
    const unaccounted = commands.filter(
      (name) => !(name in COMMAND_PAGES) && !(name in UNDOCUMENTED)
    );
    expect(
      unaccounted,
      `These commands are registered in src/cli/program.ts but appear in neither ` +
        `COMMAND_PAGES nor UNDOCUMENTED. Add the navigation path of the page that ` +
        `documents each one, or add it to UNDOCUMENTED with the reason -- a command ` +
        `with no documentation is a decision, and this is where it gets recorded.`
    ).toEqual([]);
  });

  it('never lists a command in both maps', () => {
    const both = Object.keys(COMMAND_PAGES).filter((name) => name in UNDOCUMENTED);
    expect(
      both,
      `A command cannot be both documented and deliberately undocumented. Remove ` +
        `the stale entry.`
    ).toEqual([]);
  });

  it('keeps both maps free of commands that no longer exist', () => {
    const registered = new Set(commands);
    const stale = [...Object.keys(COMMAND_PAGES), ...Object.keys(UNDOCUMENTED)]
      .filter((name) => !registered.has(name))
      .sort();
    expect(
      stale,
      `These names are mapped here but are no longer registered commands. A removed ` +
        `command must not leave an entry behind: the reverse direction is what stops ` +
        `this file drifting into a record of what cdkd used to ship.`
    ).toEqual([]);
  });

  it('points every mapped command at a page the navigation lists', () => {
    const missing = Object.entries(COMMAND_PAGES)
      .filter(([, navPath]) => !nav.has(navPath))
      .map(([name, navPath]) => `${name} -> ${navPath}`)
      .sort();
    expect(
      missing,
      `These pages are claimed as a command's documentation but have no entry in ` +
        `vite.docs.config.ts, so a reader browsing the site cannot reach them.`
    ).toEqual([]);
  });

  it('points every mapped command at a page that exists and names it', () => {
    const problems: string[] = [];
    for (const [name, navPath] of Object.entries(COMMAND_PAGES)) {
      const file = docFileFor(navPath);
      if (!existsSync(file)) {
        problems.push(`${name} -> ${navPath}: docs/${navPath.slice(1)}.md does not exist`);
        continue;
      }
      if (!readFileSync(file, 'utf8').includes(`cdkd ${name}`)) {
        problems.push(`${name} -> ${navPath}: page never mentions \`cdkd ${name}\``);
      }
    }
    expect(
      problems.sort(),
      `A mapping is a claim that the page documents the command. These pages do not ` +
        `back the claim -- point the command at the page that actually covers it, or ` +
        `move it to UNDOCUMENTED.`
    ).toEqual([]);
  });

  it('gives every undocumented command a reason', () => {
    const empty = Object.entries(UNDOCUMENTED)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([name]) => name)
      .sort();
    expect(
      empty,
      `An entry in UNDOCUMENTED records a decision, so it needs the reason the ` +
        `command ships without a page. A bare name is an omission wearing an ` +
        `exclusion list's clothes.`
    ).toEqual([]);
  });
});
