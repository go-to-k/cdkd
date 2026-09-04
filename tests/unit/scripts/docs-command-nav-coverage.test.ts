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
 * WHY THREE STRUCTURES RATHER THAN A `cli-<command>.md` CONVENTION. Several
 * commands have no `cli-<command>.md` at all, and several more have one whose
 * H1 is a topic rather than the command. Those are not one case: some of the
 * first group ARE documented, on a page named for the topic it covers, and some
 * are not documented anywhere. A single naming convention collapses them into
 * one exclusion list and loses that distinction -- which is the whole finding.
 * The current membership of each group is the three structures below; they are
 * the record, so this paragraph does not restate it.
 *
 * So a command is claimed in one of three ways, each CHECKED differently, and
 * the strength of the check follows the strength of the claim:
 *
 *   - `COMMAND_REFERENCE_PAGES` -- this page IS the command's reference.
 *     Checked by H1 IDENTITY (`# cdkd <command>`) rather than by a mention, so
 *     the mapping cannot drift onto a page that merely name-drops the command.
 *   - `COMMAND_TOPIC_PAGES` -- the command is documented inside a page covering
 *     a broader topic, with the reason recorded. Checked by the page's own
 *     FRONTMATTER naming the command, plus a structural refusal of the hub.
 *   - `UNDOCUMENTED` -- shipped with no documentation, with the reason recorded.
 *
 * HOW A TOPIC CLAIM IS CHECKED, AND WHY NOT BY A BODY MENTION. A body mention
 * decides nothing here: a command is named in the body of most of the
 * navigation-listed pages, `/getting-started` and `/troubleshooting` among
 * them, and neither of those is any command's documentation. Either would
 * satisfy a mention check for every topic mapping, so one could be repointed
 * there and stay green -- exactly the regression this fence is for, a dedicated
 * page deleted and its mapping quietly moved somewhere the command merely gets
 * discussed. An earlier revision refused the CLI Reference hub as a target and
 * claimed that removed the class; it removed one destination out of dozens, and
 * the claim was the more serious error.
 *
 * The evidence is the page's FRONTMATTER instead: its own `title` or
 * `description` must name `cdkd <command>`, matched at a word boundary so an
 * inflected verb does not qualify (`How cdkd deploys CDK apps` contains the
 * substring `cdkd deploy`, and Core Concepts is written exactly that way). That
 * is the page declaring the command to be part of its subject rather than
 * something it happens to mention.
 *
 * That it DISCRIMINATES is asserted rather than asserted-in-prose, by
 * `NON_DOCUMENTING_PAGES` below. Three review rounds each found a wrong count
 * in a hand-maintained figure here -- the last one counting Core Concepts among
 * the qualifying pages in the same sentence that introduced the word boundary
 * to reject it. A fourth recount would have been the same mistake again, so the
 * figures are gone and the property they described is a test.
 *
 * The hub is ALSO refused structurally, not left to the frontmatter rule. Its
 * description names no command today, so the rule happens to reject it -- but
 * that is a fact about current wording, and a hub description listing the
 * commands it indexes would re-qualify it. The refusal is the invariant; the
 * frontmatter rule is what generalises it to every other page.
 *
 * WHAT THIS DOES NOT PROVE:
 *
 *   - That a page documents a command WELL, or covers its flags. The H1 check
 *     proves a page is titled after the command; the frontmatter check proves a
 *     topic page declares the command part of its subject. Neither grades the
 *     prose, and neither can tell a thorough page from a stub.
 *   - That a topic mapping points at the BEST page for the command. Several
 *     commands have more than one page whose frontmatter names them -- `local`
 *     its subcommand pages, `deploy` its other flag-family pages, `destroy` the
 *     orphan comparison -- so a mapping could be swapped between them and stay
 *     green. Those pages do document the command, so this is a worse-page risk
 *     rather than the no-page one this fence is for.
 *   - That an `UNDOCUMENTED` reason is still TRUE beyond the narrow check
 *     below: nothing re-reads the pages its prose describes, so a reason can
 *     go stale in every way except the command acquiring a page of its own.
 *   - Anything about SUBCOMMANDS. `cdkd state *`, `cdkd local *` and
 *     `cdkd events prune` are out of scope, so one of those can still ship
 *     undocumented -- the same class as the `migrate` incident, one level down.
 *     Widening to subcommands is a separate change.
 */
const repoRoot = join(import.meta.dirname, '..', '..', '..');
const DOCS_CONFIG = join(repoRoot, 'vite.docs.config.ts');

/** The hub. Refused as a topic-page target regardless of its wording. */
const HUB_PAGE = '/cli-reference';

/**
 * Pages linked from the hub's own index of per-command reference pages.
 *
 * That index is a second hand-maintained list, and nothing fenced it: this
 * change had to add its `cdkd force-unlock` line by hand, one level over from
 * the omission the whole fence exists to catch. Checked one way only -- every
 * mapped `/cli-*` page must be indexed -- because the index legitimately holds
 * pages that are not commands (`cli-deploy-tuning`, `cli-deploy-safety` are
 * deploy's other flag families).
 */
function hubIndexedPages(): Set<string> {
  const file = docFileFor(HUB_PAGE);
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(HUB_INDEX_HEADING);
  expect(
    start,
    `${file}: could not find the "${HUB_INDEX_HEADING}" section. It was renamed or ` +
      `removed; update this extractor rather than letting it silently index nothing.`
  ).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + HUB_INDEX_HEADING.length);
  const end = rest.indexOf('\n## ');
  const section = end === -1 ? rest : rest.slice(0, end);
  return new Set([...section.matchAll(/\]\((cli-[a-z0-9-]+)\.md\)/g)].map((m) => `/${m[1]}`));
}

/**
 * Pages that discuss commands at length without being any one command's
 * documentation. None of them may qualify as a topic page for any command that
 * HAS a topic mapping -- the check iterates `COMMAND_TOPIC_PAGES`, deliberately
 * not the reference commands, whose stronger H1 claim these pages cannot meet
 * anyway.
 *
 * This is the discrimination claim as an assertion. Body mentions cannot tell
 * these apart from a real topic page, so what makes the frontmatter rule worth
 * having is exactly that these are rejected by it. Core Concepts is the near
 * miss: its description reads "How cdkd deploys CDK apps", which a substring
 * match accepts and the word boundary rejects. The others each name every topic
 * command somewhere in their bodies while documenting none of them.
 *
 * The HUB is deliberately NOT in this list, even though it is the same kind of
 * page. It is refused structurally by the topic check, and the header says that
 * refusal exists precisely because a hub description listing the commands it
 * indexes WOULD otherwise re-qualify it. Listing it here would make that reword
 * a test failure and contradict the reason the structural refusal is there.
 *
 * A page can leave this list -- if one of them genuinely becomes a command's
 * documentation, moving it out and into `COMMAND_TOPIC_PAGES` is the intended
 * resolution, not a workaround.
 */
const NON_DOCUMENTING_PAGES: readonly string[] = [
  '/getting-started',
  '/troubleshooting',
  '/state-management',
  '/concepts',
];

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
    'No page of its own. Its material is scattered: the CLI Reference covers the stdout ' +
    'contract on a multi-stack app and names `--output` there, and the deploy-tuning page ' +
    'documents `--strict` / `--ignore-errors` as also accepted by it. Tracked by ' +
    'go-to-k/cdkd#2577.',
  migrate:
    'Held pending the deprecation decision in go-to-k/cdkd#2572 -- it is the only ' +
    'command that requires the AWS CDK CLI binary, so whether it stays at all is ' +
    'undecided. Writing a reference page for it first would be premature.',
};

/**
 * Floors, so a parse that has gone blind cannot report green having compared
 * nothing. "The tree yielded no commands" and "every command is documented" are
 * the same pass without these. Both sit well below what the tree yields today,
 * with enough slack that an ordinary removal does not force a test edit, while
 * a total parse failure cannot clear them. They are backstops against a dead
 * parser, not measurements -- deliberately not tightened to the live counts,
 * which would make every ordinary docs change a test edit.
 */
const MIN_COMMANDS = 15;
const MIN_NAV_PATHS = 30;

/**
 * Floors on the two CHECKED structures, and on the decoy list.
 *
 * Without them a command can be moved from a checked structure into
 * `UNDOCUMENTED` with a plausible reason, and the assertions that would have
 * inspected its page stop having anything to inspect while every test stays
 * green -- the same collapse the parser floors guard, reached by editing the
 * data instead of breaking the parse. `NON_DOCUMENTING_PAGES` needs one for the
 * same reason: emptied, its loop runs zero times and the discrimination claim
 * the header rests on becomes silently unasserted.
 */
const MIN_REFERENCE_PAGES = 8;
const MIN_TOPIC_PAGES = 3;
const MIN_NON_DOCUMENTING_PAGES = 4;

/** The hub section that indexes the per-command reference pages. */
const HUB_INDEX_HEADING = '## CLI reference pages';

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
 * built site does not link to. TRAILING comments are stripped as well as
 * whole-line ones: `{ ..., path: '/x' }, // was path: '/old'` would otherwise
 * put `/old` into the set and let a stale mapping pass. The `[^:]` guard keeps
 * a `://` in a future URL from being read as the start of one. Line comments were the spelling a review caught;
 * block comments are the same defect one spelling over. Line comments are
 * dropped FIRST, because a `/*` written inside one would otherwise open a
 * spurious block and swallow the real entries after it. The captured region
 * holds no comment of either form today, so the ordering is a guard against a
 * shape the config does not yet have rather than one it does -- which is why
 * the ordering is probed rather than described with a citation. The path
 * pattern is deliberately permissive (`[^']+`) so a future nested path is READ
 * and then judged by the existence check, rather than skipped and then reported
 * as missing from the navigation -- a true failure with a misleading reason.
 */
function navPaths(): Set<string> {
  expect(
    existsSync(DOCS_CONFIG),
    `${DOCS_CONFIG} does not exist. The site config was renamed or moved; point this ` +
      `extractor at it rather than letting readFileSync raise a bare ENOENT.`
  ).toBe(true);
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
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...uncommented.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1] as string));
}

/** `/cli-gc` -> `docs/cli-gc.md`. */
function docFileFor(navPath: string): string {
  return join(repoRoot, 'docs', `${navPath.slice(1)}.md`);
}

/**
 * Does this text name the command, at a word boundary?
 *
 * The boundary is load-bearing: `docs/concepts.md`'s description reads "How
 * cdkd deploys CDK apps", which CONTAINS the substring `cdkd deploy` -- so a
 * plain `includes` would let the `deploy` mapping be repointed at Core Concepts
 * and stay green.
 */
function namesCommand(text: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`cdkd ${escaped}\\b`).test(text);
}

/** The page's frontmatter block, or `null` when it has none. */
function frontmatterOf(file: string): string | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'));
  return m ? (m[1] as string) : null;
}

/**
 * The page's first `# ` heading, or `null` when it has none.
 *
 * Fenced blocks are removed first: a shell example's `# comment` is not a
 * heading, and `docs/cli-reference.md` already contains one (`# or`, inside a
 * bash fence). It is harmless there -- the real H1 comes earlier -- but a page
 * whose fence preceded its H1 would be read wrong.
 */
function h1Of(file: string): string | null {
  const body = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  const m = /^# (.+)$/m.exec(body);
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

  it('keeps a plausible amount of each structure', () => {
    expect(
      Object.keys(COMMAND_REFERENCE_PAGES).length,
      `COMMAND_REFERENCE_PAGES holds fewer than ${MIN_REFERENCE_PAGES} entries. Moving ` +
        `commands out of a checked structure and into UNDOCUMENTED is how this fence ` +
        `goes quiet without any test failing.`
    ).toBeGreaterThanOrEqual(MIN_REFERENCE_PAGES);
    expect(
      Object.keys(COMMAND_TOPIC_PAGES).length,
      `COMMAND_TOPIC_PAGES holds fewer than ${MIN_TOPIC_PAGES} entries. Same collapse as ` +
        `above, reached through the other checked structure.`
    ).toBeGreaterThanOrEqual(MIN_TOPIC_PAGES);
    expect(
      NON_DOCUMENTING_PAGES.length,
      `NON_DOCUMENTING_PAGES holds fewer than ${MIN_NON_DOCUMENTING_PAGES} entries. Its ` +
        `loop is what turns "the frontmatter rule discriminates" into an assertion; ` +
        `emptied, that claim is prose again.`
    ).toBeGreaterThanOrEqual(MIN_NON_DOCUMENTING_PAGES);
  });

  it('rejects an inflected verb as a frontmatter mention', () => {
    // Pinned here rather than only through `docs/concepts.md`, whose description
    // is the tree's one witness for the boundary: rewording that page would
    // leave the load-bearing arm of `namesCommand` unfalsifiable.
    expect(namesCommand('How cdkd deploys CDK apps without CloudFormation', 'deploy')).toBe(false);
    expect(namesCommand('Deploy-time flags for cdkd deploy.', 'deploy')).toBe(true);
    expect(namesCommand('cdkd force-unlock clears a stale lock', 'force-unlock')).toBe(true);
  });

  it('indexes every mapped reference page from the hub', () => {
    const indexed = hubIndexedPages();
    expect(
      indexed.size,
      `${docFileFor(HUB_PAGE)}: the "${HUB_INDEX_HEADING}" section yielded fewer than ` +
        `${MIN_REFERENCE_PAGES} links. The extractor stopped seeing its input.`
    ).toBeGreaterThanOrEqual(MIN_REFERENCE_PAGES);
    const missing = Object.entries(allMapped)
      .filter(([, navPath]) => navPath.startsWith('/cli-') && !indexed.has(navPath))
      .map(([name, navPath]) => `${name} -> ${navPath}`)
      .sort();
    expect(
      missing,
      `These pages document a command but are not linked from the hub's index of ` +
        `per-command reference pages, so a reader who starts at the CLI Reference never ` +
        `finds them. Add the bullet to ${HUB_INDEX_HEADING} in docs/cli-reference.md.`
    ).toEqual([]);
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
      if (navPath === HUB_PAGE) {
        problems.push(`${name} -> ${navPath}: the hub indexes every command, so it is never the page that documents one`);
        continue;
      }
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
      if (!namesCommand(fm, name)) {
        problems.push(`${name} -> ${navPath}: frontmatter never names \`cdkd ${name}\``);
      }
    }
    expect(
      problems.sort(),
      `A COMMAND_TOPIC_PAGES entry claims a broader page documents the command, and the ` +
        `page's own title or description must say so. A body mention is not evidence -- ` +
        `a command is named in the body of most navigation-listed pages, so a mapping ` +
        `repointed at Getting Started or Troubleshooting would pass on one.`
    ).toEqual([]);
  });

  it('rejects every page that discusses commands without documenting one', () => {
    const problems: string[] = [];
    for (const navPath of NON_DOCUMENTING_PAGES) {
      const file = docFileFor(navPath);
      if (!existsSync(file)) {
        problems.push(`${navPath}: docs/${navPath.slice(1)}.md does not exist`);
        continue;
      }
      const fm = frontmatterOf(file);
      if (fm === null) {
        problems.push(`${navPath}: page has no frontmatter block to check`);
        continue;
      }
      for (const name of Object.keys(COMMAND_TOPIC_PAGES)) {
        if (namesCommand(fm, name)) {
          problems.push(`${navPath} would qualify as the topic page for ${name}`);
        }
      }
    }
    expect(
      problems.sort(),
      `One of these pages now names a command in its frontmatter, so the topic check ` +
        `would accept a mapping repointed at it. Two resolutions, both fine: reword the ` +
        `description if the mention was incidental, or -- if the page genuinely became ` +
        `that command's documentation -- move it out of NON_DOCUMENTING_PAGES and into ` +
        `COMMAND_TOPIC_PAGES. Collect-then-assert so one missing page does not hide the ` +
        `rest.`
    ).toEqual([]);
  });

  it('gives every undocumented command a reason, and none of them a page', () => {
    const problems = Object.entries(UNDOCUMENTED)
      .filter(([, reason]) => reason.trim().length < MIN_REASON_LENGTH)
      .map(([name]) => `${name}: no reason recorded`)
      .concat(
        // The reason says the command has no page of its own. Nothing else
        // re-reads the prose, so at least check the one claim every entry
        // makes: if `docs/cli-<command>.md` now exists, the entry is a lie and
        // the command belongs in COMMAND_REFERENCE_PAGES.
        Object.keys(UNDOCUMENTED)
          .filter((name) => existsSync(docFileFor(`/cli-${name}`)))
          .map((name) => `${name}: docs/cli-${name}.md now exists, so the entry is stale`)
      );
    expect(
      problems.sort(),
      `An entry in UNDOCUMENTED records a decision, so it needs the reason the command ` +
        `ships without a page -- a bare name is an omission wearing an exclusion list's ` +
        `clothes -- and the decision must still hold: a command that has since been ` +
        `given docs/cli-<command>.md belongs in COMMAND_REFERENCE_PAGES.`
    ).toEqual([]);
  });
});
