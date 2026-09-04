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
 * WHY THREE STRUCTURES RATHER THAN A `cli-<command>.md` CONVENTION. Measured on
 * the tree this file was written against: six of the nineteen commands have no
 * `cli-<command>.md` at all (`synth`, `list`, `orphan`, `import`, `local`,
 * `migrate`), and two more have one whose H1 is a topic rather than the command
 * (`# Deploy: waits & concurrency`, `# Destroy flags & guards`). Those eight are
 * not one case: three of the six ARE documented, on a page named for the topic
 * it covers, and three are not documented at all. A single naming convention
 * collapses all eight into one exclusion list and loses that distinction --
 * which is the whole finding.
 *
 * So a command is claimed in one of three ways, each CHECKED differently, and
 * the strength of the check follows the strength of the claim:
 *
 *   - `COMMAND_REFERENCE_PAGES` -- this page IS the command's reference.
 *     Checked by H1 IDENTITY (`# cdkd <command>`) rather than by a mention, so
 *     the mapping cannot drift onto a page that merely name-drops the command.
 *   - `COMMAND_TOPIC_PAGES` -- the command is documented inside a page covering
 *     a broader topic, with the reason recorded. Checked by mention, which is
 *     weaker; the hub page is REFUSED as a target for it (see below).
 *   - `UNDOCUMENTED` -- shipped with no documentation, with the reason recorded.
 *
 * HOW A TOPIC CLAIM IS CHECKED, AND WHY NOT BY A BODY MENTION. A body mention
 * decides nothing here. Measured over the 50 navigation-listed pages:
 * `cdkd deploy` is named in the body of 38 of them, `destroy` 29, `local` 16,
 * `import` 13, `orphan` 7 -- `/getting-started` and `/troubleshooting` alone
 * would satisfy a mention check for every topic mapping, so any of the five
 * could be repointed at either and stay green. That is exactly the regression
 * this fence is for: a dedicated page deleted and its mapping quietly moved
 * somewhere the command merely gets discussed. An earlier revision refused the
 * CLI Reference hub as a target and claimed that removed the class; it removed
 * one destination out of dozens, and the claim was the more serious error.
 *
 * The evidence is the page's FRONTMATTER instead: its own `title` or
 * `description` must name `cdkd <command>`. That is the page declaring the
 * command to be part of its subject rather than something it happens to
 * mention, and it discriminates -- measured, all five topic pages name their
 * command there, while `/getting-started`, `/troubleshooting` and the hub name
 * none at all.
 *
 * WHAT THIS DOES NOT PROVE:
 *
 *   - That a page documents a command WELL, or covers its flags. The H1 check
 *     proves a page is titled after the command; the frontmatter check proves a
 *     topic page declares the command part of its subject. Neither grades the
 *     prose, and neither can tell a thorough page from a stub.
 *   - Anything about SUBCOMMANDS. `cdkd state *`, `cdkd local *` and
 *     `cdkd events prune` are out of scope, so one of those can still ship
 *     undocumented -- the same class as the `migrate` incident, one level down.
 *     Widening to subcommands is a separate change.
 */
const repoRoot = join(import.meta.dirname, '..', '..', '..');
const DOCS_CONFIG = join(repoRoot, 'vite.docs.config.ts');

/**
 * Command -> the navigation path of ITS OWN reference page.
 *
 * The path is the site path as written in `vite.docs.config.ts` (`/cli-gc`),
 * which maps to `docs/<path>.md`. Each page's H1 must be `# cdkd <command>`.
 */
const COMMAND_REFERENCE_PAGES: Readonly<Record<string, string>> = {
  bootstrap: '/cli-bootstrap',
  diff: '/cli-diff',
  drift: '/cli-drift',
  events: '/cli-events',
  export: '/cli-export',
  'force-unlock': '/cli-force-unlock',
  gc: '/cli-gc',
  'publish-assets': '/cli-publish-assets',
  rollback: '/cli-rollback',
  scrub: '/cli-scrub',
  state: '/cli-state',
};

/**
 * Command -> a page covering a broader topic that documents the command inside
 * it, with the reason its material is not on a page of its own.
 */
const COMMAND_TOPIC_PAGES: Readonly<Record<string, { path: string; reason: string }>> = {
  deploy: {
    path: '/cli-deploy',
    reason:
      'Split across three pages by flag family (waits and concurrency, tuning, ' +
      'safety and compatibility); this is the first of them.',
  },
  destroy: {
    path: '/cli-destroy',
    reason:
      'Titled after its subject rather than the command, because the page is about ' +
      'the data guards and confirmation prompts rather than a flag list.',
  },
  import: {
    path: '/import',
    reason:
      'Documented as a task guide -- the import modes and the CloudFormation ' +
      'migration flow -- rather than as a flag reference.',
  },
  orphan: {
    path: '/orphan-vs-destroy',
    reason:
      'Only meaningful next to `cdkd destroy`, so the two are documented together ' +
      'on one comparison page.',
  },
  local: {
    path: '/local-emulation',
    reason:
      'An overview for the command family, with one page per subcommand beneath ' +
      'it in the Local Execution navigation group.',
  },
};

/**
 * Commands shipped with no documentation page, each with the reason. An entry
 * here is a decision on the record, not a free pass -- adding one should be as
 * visible in review as adding a command.
 */
const UNDOCUMENTED: Readonly<Record<string, string>> = {
  list:
    'No page of its own. What exists is spread through the CLI Reference cross-command ' +
    'sections -- its output in each mode, worked examples, and `--long` / ' +
    '`--show-dependencies` -- plus the `ls` alias named on the state page. Tracked by ' +
    'go-to-k/cdkd#2577.',
  synth:
    'No page of its own. The CLI Reference explains its stdout contract on a multi-stack ' +
    'app; none of its flags are documented anywhere. Tracked by go-to-k/cdkd#2577.',
  migrate:
    'Held pending the deprecation decision in go-to-k/cdkd#2572 -- it is the only ' +
    'command that requires the AWS CDK CLI binary, so whether it stays at all is ' +
    'undecided. Writing a reference page for it first would be premature.',
};

/**
 * Floors, so a parse that has gone blind cannot report green having compared
 * nothing. "The tree yielded no commands" and "every command is documented" are
 * the same pass without these. Both sit below the measured counts (19 commands,
 * 50 navigation paths) with enough slack that an ordinary removal does not
 * force a test edit, while a total parse failure cannot clear them.
 */
const MIN_COMMANDS = 15;
const MIN_NAV_PATHS = 30;

/** The minimum length of a recorded reason, in either structure that takes one. */
const MIN_REASON_LENGTH = 20;

/**
 * Every top-level command name, aliases excluded (an alias resolves to the same
 * page as the name it aliases).
 *
 * Deliberately unfiltered otherwise. Commander's built-in `help` is NOT in this
 * tree -- it is created lazily and never added to `.commands` (measured) -- and
 * cdkd hides no top-level command today. If either changes, this fence demands
 * an entry for the newcomer, which is the right outcome: hiding a command from
 * `--help` is a decision about discoverability, and whether it also gets a page
 * is a decision worth making explicitly rather than by omission.
 */
function topLevelCommandNames(): string[] {
  return buildProgram().commands.map((c) => c.name());
}

/**
 * Every `path: '/x'` entry inside the hand-authored `navigation` array.
 *
 * Scoped to that array, with both comment forms stripped first: a whole-file
 * scan would accept a `path:` in an example, and an unstripped one would accept
 * a commented-out entry -- either way reporting a page as reachable that the
 * built site does not link to. Line comments were the spelling a review caught;
 * block comments are the same defect one spelling over. The path pattern is
 * deliberately permissive (`[^']+`) so a future nested path is READ and then
 * judged by the existence check, rather than skipped and then reported as
 * missing from the navigation -- a true failure with a misleading reason.
 */
function navPaths(): Set<string> {
  const source = readFileSync(DOCS_CONFIG, 'utf8');
  const block = /const navigation\b[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source);
  expect(
    block,
    `${DOCS_CONFIG}: could not find the \`const navigation = [ ... ];\` array. The ` +
      `declaration was renamed or reformatted; update this extractor rather than ` +
      `letting it fall back to scanning the whole file.`
  ).not.toBeNull();
  const body = (block as RegExpExecArray)[1] as string;
  const uncommented = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return new Set([...uncommented.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1] as string));
}

/** `/cli-gc` -> `docs/cli-gc.md`. */
function docFileFor(navPath: string): string {
  return join(repoRoot, 'docs', `${navPath.slice(1)}.md`);
}

/** The page's frontmatter block, or `null` when it has none. */
function frontmatterOf(file: string): string | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'));
  return m ? (m[1] as string) : null;
}

/** The page's first `# ` heading, or `null` when it has none. */
function h1Of(file: string): string | null {
  const m = /^# (.+)$/m.exec(readFileSync(file, 'utf8'));
  return m ? (m[1] as string).trim() : null;
}

const commands = topLevelCommandNames();
const allMapped: Readonly<Record<string, string>> = {
  ...COMMAND_REFERENCE_PAGES,
  ...Object.fromEntries(Object.entries(COMMAND_TOPIC_PAGES).map(([k, v]) => [k, v.path])),
};

describe('docs command/nav coverage', () => {
  it('reads a plausible command tree', () => {
    expect(
      commands.length,
      `buildProgram() yielded ${commands.length} top-level commands, below the floor of ` +
        `${MIN_COMMANDS}. Every assertion below iterates this list, so an empty or ` +
        `truncated tree passes them all while checking nothing.`
    ).toBeGreaterThanOrEqual(MIN_COMMANDS);
  });

  it('reads a plausible navigation', () => {
    expect(
      navPaths().size,
      `${DOCS_CONFIG}: extracted fewer than ${MIN_NAV_PATHS} navigation paths. Either the ` +
        `navigation genuinely shrank (lower the floor deliberately) or this extractor ` +
        `stopped seeing its input -- an empty set makes every "is this path in the ` +
        `navigation" assertion below fail for the wrong reason.`
    ).toBeGreaterThanOrEqual(MIN_NAV_PATHS);
  });

  it('accounts for every registered top-level command', () => {
    const unaccounted = commands.filter((name) => !(name in allMapped) && !(name in UNDOCUMENTED));
    expect(
      unaccounted,
      `These commands are registered in src/cli/program.ts but appear in none of ` +
        `COMMAND_REFERENCE_PAGES, COMMAND_TOPIC_PAGES or UNDOCUMENTED. Point each one at ` +
        `the page that documents it, or record it as undocumented with the reason -- a ` +
        `command with no documentation is a decision, and this is where it gets recorded.`
    ).toEqual([]);
  });

  it('claims each command exactly once', () => {
    const counts = new Map<string, number>();
    for (const name of [
      ...Object.keys(COMMAND_REFERENCE_PAGES),
      ...Object.keys(COMMAND_TOPIC_PAGES),
      ...Object.keys(UNDOCUMENTED),
    ]) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const duplicated = [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([name]) => name)
      .sort();
    expect(
      duplicated,
      `A command belongs to exactly one of the three structures. Remove the stale entry ` +
        `-- a command listed twice is one whose weaker claim is never checked.`
    ).toEqual([]);
  });

  it('keeps every structure free of commands that no longer exist', () => {
    const registered = new Set(commands);
    const stale = [
      ...Object.keys(COMMAND_REFERENCE_PAGES),
      ...Object.keys(COMMAND_TOPIC_PAGES),
      ...Object.keys(UNDOCUMENTED),
    ]
      .filter((name) => !registered.has(name))
      .sort();
    expect(
      stale,
      `These names are listed here but are no longer registered commands. A removed ` +
        `command must not leave an entry behind: the reverse direction is what stops this ` +
        `file drifting into a record of what cdkd used to ship.`
    ).toEqual([]);
  });

  it('points every mapped command at a page the navigation lists', () => {
    const nav = navPaths();
    const missing = Object.entries(allMapped)
      .filter(([, navPath]) => !nav.has(navPath))
      .map(([name, navPath]) => `${name} -> ${navPath}`)
      .sort();
    expect(
      missing,
      `These pages are claimed as a command's documentation but have no entry in the ` +
        `navigation array in vite.docs.config.ts, so a reader browsing the site cannot ` +
        `reach them.`
    ).toEqual([]);
  });

  it('titles every reference page after the command it documents', () => {
    const problems: string[] = [];
    for (const [name, navPath] of Object.entries(COMMAND_REFERENCE_PAGES)) {
      const file = docFileFor(navPath);
      if (!existsSync(file)) {
        problems.push(`${name} -> ${navPath}: docs/${navPath.slice(1)}.md does not exist`);
        continue;
      }
      const h1 = h1Of(file);
      if (h1 !== `cdkd ${name}`) {
        problems.push(`${name} -> ${navPath}: H1 is ${JSON.stringify(h1)}, want "cdkd ${name}"`);
      }
    }
    expect(
      problems.sort(),
      `A COMMAND_REFERENCE_PAGES entry claims the page IS that command's reference, so its ` +
        `H1 must be the command. A page that merely mentions the command belongs in ` +
        `COMMAND_TOPIC_PAGES instead, where the weaker claim is recorded as such.`
    ).toEqual([]);
  });

  it('declares the command in the frontmatter of every topic page', () => {
    const problems: string[] = [];
    for (const [name, { path: navPath, reason }] of Object.entries(COMMAND_TOPIC_PAGES)) {
      if (reason.trim().length < MIN_REASON_LENGTH) {
        problems.push(`${name} -> ${navPath}: no reason recorded for the absence of its own page`);
      }
      const file = docFileFor(navPath);
      if (!existsSync(file)) {
        problems.push(`${name} -> ${navPath}: docs/${navPath.slice(1)}.md does not exist`);
        continue;
      }
      const fm = frontmatterOf(file);
      if (fm === null) {
        problems.push(`${name} -> ${navPath}: page has no frontmatter block`);
        continue;
      }
      if (!fm.includes(`cdkd ${name}`)) {
        problems.push(`${name} -> ${navPath}: frontmatter never names \`cdkd ${name}\``);
      }
    }
    expect(
      problems.sort(),
      `A COMMAND_TOPIC_PAGES entry claims a broader page documents the command, and the ` +
        `page's own title or description must say so. A body mention is not evidence: ` +
        `\`cdkd deploy\` is named in the body of 38 of the 50 navigation-listed pages, so ` +
        `a mapping repointed at Getting Started or Troubleshooting would pass on one.`
    ).toEqual([]);
  });

  it('gives every undocumented command a reason', () => {
    const empty = Object.entries(UNDOCUMENTED)
      .filter(([, reason]) => reason.trim().length < MIN_REASON_LENGTH)
      .map(([name]) => name)
      .sort();
    expect(
      empty,
      `An entry in UNDOCUMENTED records a decision, so it needs the reason the command ` +
        `ships without a page. A bare name is an omission wearing an exclusion list's ` +
        `clothes.`
    ).toEqual([]);
  });
});
