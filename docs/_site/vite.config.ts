import { readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite-plus';
import { defineTheme, oxContent } from '@ox-content/vite-plugin';
import type { SsgNavigationGroup } from '@ox-content/vite-plugin';
import { oxContentVue } from '@ox-content/vite-plugin-vue';
import vize from '@vizejs/vite-plugin';
import { homeTitlePlugin } from './plugins/home-title.js';
import { navOpenCurrentScript, navToggleScript } from './plugins/nav-toggle.js';
import {
  type SearchScope,
  scopeShortcutsScript,
  searchScopesPlugin,
} from './plugins/search-scopes.js';
import { registryName } from './islands/html.js';
import { islandSsrPlugin } from './islands/ssr-plugin.js';
import { codeSpans } from './plugins/code-spans.js';
import { diagrams } from './plugins/diagrams.js';
import { STATUS_ICONS, statusIcons } from './plugins/status-icons.js';
import { tokens, tokensToCss } from './brand/tokens.js';

const SITE_NAME = 'cdkd';
// The repository root is the Vite root, and the paths below are relative to
// it: Ox Content reads a page's last-updated date from git only for files
// inside the root. The pages live in docs/, at the paths GitHub links, the
// CLI's messages and the repo's tooling already use; this directory
// (docs/_site/) is the site itself: theme, components, assets.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SITE_DIR = 'docs/_site';
const CONTENT_DIR = 'docs';
const HOME_MARKDOWN = `${CONTENT_DIR}/index.md`;

/** Iconify names (`prefix:name`) the home page's `features` use. */
const FEATURE_ICONS = (() => {
  const source = readFileSync(join(ROOT, HOME_MARKDOWN), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '';
  const features = (parseYaml(frontmatter) as { features?: Array<{ icon?: unknown }> }).features;
  return (features ?? [])
    .map((feature) => feature.icon)
    .filter(
      (icon): icon is string => typeof icon === 'string' && /^[a-z0-9-]+:[a-z0-9-]+$/.test(icon),
    );
})();
const SITE_OUT_DIR = 'dist/site';

// Documentation site config (https://cdkd.dev), separate from the root
// vite.config.ts on purpose: the root config's `cdkd:vp-build` plugin claims
// every build environment as already built (it delegates to `vp pack`), which
// would short-circuit the Ox Content SSG build if the two shared a config.
// Invoked via `vp run docs:dev` / `docs:build` / `docs:preview`; the vize
// tasks beside them carry the Vue toolchain's settings as flags.

// Sidebar is hand-authored (not derived from the file tree) so the site's
// information architecture is independent of the flat docs/ layout —
// existing files stay where tests and markgate scopes bind to them, and
// internal material (docs/design/**, docs/plans/**,
// docs/_generated/**, coverage matrices, changelog-cdkd.md) simply gets
// no navigation entry.
//
// The groups follow a reader from first deploy to reference: getting
// started, then one guide per task, then the pages looked things up in.
// Each group names the search scope its pages belong to (`@cli deploy`
// searches the CLI reference only); plugins/search-scopes.ts carries that
// into the search index.
const SEARCH_SCOPES: SearchScope[] = [
  { id: 'guide', label: 'the guides' },
  { id: 'cli', label: 'the CLI reference' },
  { id: 'local', label: 'local execution' },
  { id: 'reference', label: 'the reference pages' },
  { id: 'help', label: 'troubleshooting' },
  { id: 'contributing', label: 'the contributor docs' },
];

/** A page under another page: `under` names its parent's path in the same group. */
type NavigationItem = SsgNavigationGroup['items'][number] & { under?: string };
type ScopedNavigationGroup = Omit<SsgNavigationGroup, 'items'> & {
  scope: string;
  items: NavigationItem[];
};

const navigation: ScopedNavigationGroup[] = [
  {
    scope: 'guide',
    title: 'Get Started',
    items: [
      { title: 'Introduction', path: '/introduction' },
      { title: 'Getting Started', path: '/getting-started' },
      { title: 'Core Concepts', path: '/concepts' },
      { title: 'Benchmarks', path: '/benchmarks' },
    ],
  },
  {
    scope: 'guide',
    title: 'Guides',
    items: [
      { title: 'Wait Modes', path: '/wait-modes' },
      { title: 'Rollback', path: '/rollback' },
      { title: 'Stop on Destructive Changes', path: '/destructive-changes' },
      { title: 'Drift Detection', path: '/drift' },
      { title: 'Orphan vs Destroy', path: '/orphan-vs-destroy' },
      { title: 'Stack Outputs', path: '/stack-outputs' },
      { title: 'Cross-Stack References', path: '/cross-stack-references' },
      { title: 'State Store', path: '/state-store' },
      {
        title: 'Name check before a create',
        path: '/state-store-name-check',
        under: '/state-store',
      },
      { title: 'Stack registry', path: '/state-store-registry', under: '/state-store' },
      { title: 'Import & CFn Migration', path: '/import' },
      { title: 'Options and the import plan', path: '/import-reference', under: '/import' },
      { title: 'By resource type', path: '/import-resource-types', under: '/import' },
      { title: 'After an import', path: '/import-after', under: '/import' },
      { title: 'Export to CloudFormation', path: '/export' },
      { title: 'Mixed Estates', path: '/mixed-estates' },
      { title: 'CI: Per-PR Environments', path: '/ci-per-pr' },
      { title: 'Using with AI Agents', path: '/ai-agents' },
    ],
  },
  {
    scope: 'cli',
    title: 'CLI Reference',
    items: [
      { title: 'Overview', path: '/cli-reference' },
      {
        title: 'Credentials and --role-arn',
        path: '/cli-reference-credentials',
        under: '/cli-reference',
      },
      { title: 'Region resolution', path: '/cli-reference-region', under: '/cli-reference' },
      { title: 'Output streams', path: '/cli-reference-output', under: '/cli-reference' },
      { title: 'Exit codes', path: '/cli-reference-exit-codes', under: '/cli-reference' },
      { title: 'cdkd bootstrap', path: '/cli-bootstrap' },
      {
        title: 'Tearing down asset storage',
        path: '/cli-bootstrap-teardown',
        under: '/cli-bootstrap',
      },
      { title: 'cdkd list', path: '/cli-list' },
      { title: 'cdkd synth', path: '/cli-synth' },
      { title: 'cdkd diff', path: '/cli-diff' },
      { title: 'JSON output', path: '/cli-diff-json', under: '/cli-diff' },
      { title: 'Stack outputs', path: '/cli-diff-outputs', under: '/cli-diff' },
      { title: 'Secrets and NoEcho values', path: '/cli-diff-secrets', under: '/cli-diff' },
      { title: 'Nested stacks', path: '/cli-diff-nested-stacks', under: '/cli-diff' },
      {
        title: 'Incomplete or malformed state',
        path: '/cli-diff-state-records',
        under: '/cli-diff',
      },
      { title: 'cdkd deploy', path: '/cli-deploy' },
      { title: 'Wait mode details', path: '/cli-deploy-waits', under: '/cli-deploy' },
      { title: 'The stack lock', path: '/cli-deploy-lock', under: '/cli-deploy' },
      { title: 'Custom resources', path: '/cli-deploy-custom-resources', under: '/cli-deploy' },
      { title: 'A damaged state record', path: '/cli-deploy-damaged-state', under: '/cli-deploy' },
      { title: 'cdkd deploy: tuning', path: '/cli-deploy-tuning' },
      {
        title: 'Names prefixed before v0.94.0',
        path: '/cli-deploy-tuning-name-migration',
        under: '/cli-deploy-tuning',
      },
      { title: 'cdkd deploy: safety & compatibility flags', path: '/cli-deploy-safety' },
      {
        title: 'Provisioning route flags',
        path: '/cli-deploy-safety-routing',
        under: '/cli-deploy-safety',
      },
      {
        title: 'Recreating on the other route',
        path: '/cli-deploy-safety-recreate',
        under: '/cli-deploy-safety',
      },
      {
        title: 'Replacements and name collisions',
        path: '/cli-deploy-safety-replacement',
        under: '/cli-deploy-safety',
      },
      {
        title: 'Strictness and approval flags',
        path: '/cli-deploy-safety-ci-flags',
        under: '/cli-deploy-safety',
      },
      {
        title: 'Checks on the cloud assembly',
        path: '/cli-deploy-safety-assembly-checks',
        under: '/cli-deploy-safety',
      },
      { title: 'cdkd destroy', path: '/cli-destroy' },
      {
        title: 'Data guards and final snapshots',
        path: '/cli-destroy-guards',
        under: '/cli-destroy',
      },
      { title: 'Deletion protection', path: '/cli-destroy-protection', under: '/cli-destroy' },
      { title: 'Confirmation prompts', path: '/cli-destroy-prompts', under: '/cli-destroy' },
      { title: 'Skipped resources', path: '/cli-destroy-skipped', under: '/cli-destroy' },
      {
        title: 'Interruption and damaged state',
        path: '/cli-destroy-edge-cases',
        under: '/cli-destroy',
      },
      { title: 'cdkd rollback', path: '/cli-rollback' },
      {
        title: 'Failed operations',
        path: '/cli-rollback-failed-operations',
        under: '/cli-rollback',
      },
      { title: 'Limitations', path: '/cli-rollback-limitations', under: '/cli-rollback' },
      { title: 'cdkd drift', path: '/cli-drift' },
      {
        title: 'Accept and revert in detail',
        path: '/cli-drift-accept-revert',
        under: '/cli-drift',
      },
      { title: 'What was not compared', path: '/cli-drift-not-compared', under: '/cli-drift' },
      { title: 'Secrets and redacted values', path: '/cli-drift-secrets', under: '/cli-drift' },
      { title: 'Nested stacks', path: '/cli-drift-nested-stacks', under: '/cli-drift' },
      { title: 'JSON output', path: '/cli-drift-json', under: '/cli-drift' },
      { title: 'cdkd state', path: '/cli-state' },
      { title: 'Writing subcommands', path: '/cli-state-writing', under: '/cli-state' },
      { title: 'Malformed records', path: '/cli-state-malformed', under: '/cli-state' },
      { title: 'cdkd events', path: '/cli-events' },
      { title: 'cdkd export', path: '/cli-export' },
      { title: 'What blocks an export', path: '/cli-export-blocks', under: '/cli-export' },
      {
        title: 'Custom resources and IAM policies',
        path: '/cli-export-two-phase',
        under: '/cli-export',
      },
      { title: 'Nested stacks', path: '/cli-export-nested-stacks', under: '/cli-export' },
      {
        title: 'The template CloudFormation receives',
        path: '/cli-export-template',
        under: '/cli-export',
      },
      { title: 'cdkd scrub', path: '/cli-scrub' },
      { title: 'What scrub covers', path: '/cli-scrub-what-it-covers', under: '/cli-scrub' },
      { title: 'Across stacks', path: '/cli-scrub-multi-stack', under: '/cli-scrub' },
      { title: 'Findings and refusals', path: '/cli-scrub-findings', under: '/cli-scrub' },
      { title: 'cdkd gc', path: '/cli-gc' },
      { title: 'cdkd publish-assets', path: '/cli-publish-assets' },
      { title: 'cdkd force-unlock', path: '/cli-force-unlock' },
    ],
  },
  {
    scope: 'local',
    title: 'Local Execution',
    items: [
      { title: 'Overview', path: '/local-emulation' },
      {
        title: 'Value resolution',
        path: '/local-emulation-value-resolution',
        under: '/local-emulation',
      },
      {
        title: 'Assembly paths',
        path: '/local-emulation-assembly-trust',
        under: '/local-emulation',
      },
      { title: 'local invoke', path: '/local-invoke' },
      { title: 'Layers', path: '/local-invoke-layers', under: '/local-invoke' },
      { title: 'local start-api', path: '/local-start-api' },
      {
        title: 'Routing and request handling',
        path: '/local-start-api-routing',
        under: '/local-start-api',
      },
      { title: 'Authorizers', path: '/local-start-api-authorizers', under: '/local-start-api' },
      { title: 'Mutual TLS', path: '/local-start-api-mtls', under: '/local-start-api' },
      { title: 'WebSocket APIs', path: '/local-start-api-websocket', under: '/local-start-api' },
      {
        title: 'REST v1 integrations',
        path: '/local-start-api-rest-integrations',
        under: '/local-start-api',
      },
      {
        title: 'Containers, reloading and debugging',
        path: '/local-start-api-containers',
        under: '/local-start-api',
      },
      { title: 'local run-task', path: '/local-run-task' },
      { title: 'Images', path: '/local-run-task-images', under: '/local-run-task' },
      { title: 'Secrets', path: '/local-run-task-secrets', under: '/local-run-task' },
      { title: 'local start-service', path: '/local-start-service' },
      {
        title: 'Image overrides',
        path: '/local-start-service-image-overrides',
        under: '/local-start-service',
      },
      { title: 'local start-alb', path: '/local-start-alb' },
      { title: 'local start-cloudfront', path: '/local-start-cloudfront' },
      { title: 'local invoke-agentcore', path: '/local-invoke-agentcore' },
      { title: 'local start-agentcore', path: '/local-start-agentcore' },
    ],
  },
  {
    scope: 'reference',
    title: 'Reference',
    items: [
      { title: 'Supported Resources', path: '/supported-resources' },
      {
        title: 'Per-type behaviour notes',
        path: '/supported-resources-type-notes',
        under: '/supported-resources',
      },
      { title: 'Feature Parity', path: '/supported-features' },
      { title: 'Provisioning Layers', path: '/provisioning-layers' },
      { title: 'State Management', path: '/state-management' },
      { title: 'Physical IDs', path: '/state-management-physical-ids', under: '/state-management' },
      { title: 'Secrets in state', path: '/state-management-secrets', under: '/state-management' },
      { title: 'Locking', path: '/state-management-locking', under: '/state-management' },
      {
        title: 'Schema versions and upgrades',
        path: '/state-management-schema-versions',
        under: '/state-management',
      },
      {
        title: 'Malformed records',
        path: '/state-management-malformed-records',
        under: '/state-management',
      },
      {
        title: 'Backup and bucket security',
        path: '/state-management-backup-and-security',
        under: '/state-management',
      },
      { title: 'Deployment Events', path: '/deployment-events' },
    ],
  },
  {
    scope: 'help',
    title: 'Help',
    items: [
      { title: 'Troubleshooting', path: '/troubleshooting' },
      { title: 'Credential and permission errors', path: '/troubleshooting-permissions' },
      { title: 'Lock and state errors', path: '/troubleshooting-locks-state' },
      { title: 'Templates cdkd refuses', path: '/troubleshooting-templates' },
      { title: 'Failures during a deploy', path: '/troubleshooting-deploy' },
      { title: 'References cdkd cannot resolve', path: '/troubleshooting-references' },
      { title: 'Slow deploys, throttling and retries', path: '/troubleshooting-slow-deploys' },
      { title: 'AWS does not match the template', path: '/troubleshooting-mismatch' },
      { title: 'Asset publishing errors', path: '/troubleshooting-assets' },
      { title: 'Problems destroying a stack', path: '/troubleshooting-destroy' },
      { title: 'After a failed or interrupted deploy', path: '/troubleshooting-failed-deploy' },
      { title: 'Possible duplicates after a server error', path: '/troubleshooting-duplicates' },
      { title: 'Proxies and corporate networks', path: '/troubleshooting-proxy' },
      { title: 'Frequently asked questions', path: '/troubleshooting-faq' },
    ],
  },
  {
    scope: 'contributing',
    title: 'Contributing',
    items: [
      { title: 'Contributing Guide', path: '/contributing' },
      { title: 'Architecture', path: '/architecture' },
      {
        title: 'The deploy pipeline',
        path: '/architecture-deploy-pipeline',
        under: '/architecture',
      },
      {
        title: 'Destroy, state and locking',
        path: '/architecture-destroy-and-state',
        under: '/architecture',
      },
      {
        title: 'Providers and intrinsic functions',
        path: '/architecture-provisioning',
        under: '/architecture',
      },
      { title: 'Provider Development', path: '/provider-development' },
      {
        title: 'Import and drift support',
        path: '/provider-development-import-and-drift',
        under: '/provider-development',
      },
      {
        title: 'Testing and shipping',
        path: '/provider-development-testing',
        under: '/provider-development',
      },
      {
        title: 'Provider reference',
        path: '/provider-development-reference',
        under: '/provider-development',
      },
      { title: 'Testing', path: '/testing' },
      {
        title: 'Writing an integration fixture',
        path: '/testing-integration-fixtures',
        under: '/testing',
      },
    ],
  },
];

// cdkd brand theme, laid directly on Ox Content's core stylesheet (no preset
// skin). The `--cdkd-*` custom properties are generated from the token file
// (brand/cdkd.tokens.json); the sheets in theme/ use only
// those.
const THEME_CSS = [
  tokensToCss(),
  ...['fonts.css', 'cdkd.css', 'syntax.css', 'home.css'].map((file) =>
    readFileSync(new URL(`./theme/${file}`, import.meta.url), 'utf8'),
  ),
].join('\n');

// The sidebar, built from `navigation` above as Ox Content's theme sidebar:
// that form carries `collapsed` / `stickyCollapsed`, so every group folds,
// opens by default, and remembers what the reader closed, and the SSG marks
// the current page's link itself.
const sidebar = navigation.map((group) => ({
  text: group.title,
  collapsed: false,
  stickyCollapsed: true,
  items: group.items
    .filter((item) => item.under === undefined)
    .map((item) => {
      const link = item.path ?? item.href ?? '';
      const children = group.items.filter((child) => child.under === item.path);
      if (children.length === 0) return { text: item.title, link };
      // A page with pages under it: its title opens the page, and the pages
      // under it fold away until the reader is in that section.
      return {
        text: item.title,
        link,
        collapsed: true,
        items: children.map((child) => ({ text: child.title, link: child.path ?? '' })),
      };
    }),
}));

// Islands: one small module on every page, which loads Vue and the
// components only where a page has an island (islands/client.ts).
// The dev server serves the source; the build emits it unhashed so this
// static tag can name it.
const islandsEntry = (command: 'build' | 'serve'): string =>
  command === 'serve' ? `/${SITE_DIR}/islands/client.ts` : '/assets/islands.js';

// The components' styles, as one stylesheet every built page links: the
// build renders the islands into the page, so their styles have to be there
// at first paint, not arrive with the hydration code (the dev server
// injects them itself).
const ISLANDS_CSS = 'assets/islands.css';
const islandsStyles = (command: 'build' | 'serve'): string[] =>
  command === 'serve' ? [] : [`<link rel="stylesheet" href="/${ISLANDS_CSS}">`];

const theme = (command: 'build' | 'serve') =>
  defineTheme({
    aside: true,
    headingPermalink: 'hover',
    // Ox Content's circular reveal on the theme toggle; reduced motion and
    // browsers without View Transitions switch at once.
    toggleTransition: 'circle',
    header: {
      logoLight: '/brand/logo-light.svg',
      logoDark: '/brand/logo-dark.svg',
      // The lockup's proportion: the symbol one em tall beside the wordmark
      // (theme/cdkd.css sets the wordmark at 20px).
      logoWidth: 23,
      logoHeight: 20,
      showSiteNameText: true,
    },
    sidebar,
    nav: [
      { text: 'Guide', link: '/getting-started/' },
      { text: 'Reference', link: '/cli-reference/' },
      { text: 'Troubleshooting', link: '/troubleshooting/' },
    ],
    socialLinks: {
      github: 'https://github.com/go-to-k/cdkd',
    },
    footer: {
      message: 'Released under the Apache-2.0 License.',
      copyright: 'Copyright © go-to-k',
    },
    js: [
      // The home page's first screen is the hero alone: the header steps
      // aside while the hero is under it and returns once it has scrolled
      // away. Set synchronously first, so the header never flashes in.
      '(function () {',
      "  var hero = document.querySelector('.entry-page .hero');",
      '  if (!hero) return;',
      "  var set = function (inView) { document.body.classList.toggle('cdkd-hero-in-view', inView); };",
      '  set(hero.getBoundingClientRect().bottom > 64);',
      "  if (!('IntersectionObserver' in window)) return;",
      '  new IntersectionObserver(function (entries) { set(entries[0].isIntersecting); },',
      "    { rootMargin: '-64px 0px 0px 0px' }).observe(hero);",
      '})();',
      // Two gaps in core's markup for assistive technology: the home page's
      // feature cards are h3s straight under the hero's h1, so their section
      // gets the h2 it lacks; and the search button's shortcut hint is shown,
      // not spoken -- the shortcut itself is declared instead.
      '(function () {',
      "  var features = document.querySelector('.entry-page .features');",
      "  if (features && !features.querySelector('h2')) {",
      "    var heading = document.createElement('h2');",
      "    heading.className = 'cdkd-visually-hidden';",
      "    heading.textContent = 'Features';",
      '    features.prepend(heading);',
      '  }',
      "  document.querySelectorAll('.search-button').forEach(function (button) {",
      "    button.setAttribute('aria-keyshortcuts', 'Meta+K Control+K');",
      "    button.querySelectorAll('kbd').forEach(function (kbd) { kbd.setAttribute('aria-hidden', 'true'); });",
      '    // Named by its visible word; core hides that word on a phone, where',
      '    // the fallback below takes over (theme/cdkd.css).',
      "    button.removeAttribute('aria-label');",
      "    var fallback = document.createElement('span');",
      "    fallback.className = 'cdkd-search-name';",
      "    fallback.textContent = 'Search';",
      '    button.append(fallback);',
      '  });',
      '})();',
      // Package-manager tabs, as in the hero: npm, pnpm, yarn, bun, vp, in
      // that order (the elements move, so keyboard order follows), opening
      // on npm until the reader picks; core's deferred tab runtime then
      // restores a stored pick.
      '(function () {',
      "  var order = ['npm', 'pnpm', 'yarn', 'bun', 'vp'];",
      '  document.querySelectorAll(\'.ox-tabs[data-ox-tab-group="pkg-manager"] .ox-tabs-header\').forEach(function (header) {',
      "    Array.prototype.map.call(header.querySelectorAll('label'), function (label) {",
      '      return { label: label, input: document.getElementById(label.htmlFor), rank: order.indexOf(label.textContent.trim()) };',
      '    }).sort(function (a, b) { return a.rank - b.rank; }).forEach(function (tab) {',
      '      if (tab.input) header.append(tab.input);',
      '      header.append(tab.label);',
      '    });',
      '  });',
      '  var stored = null;',
      "  try { stored = localStorage.getItem('ox-tab-group:pkg-manager'); } catch (e) {}",
      '  if (stored) return;',
      '  document.querySelectorAll(\'.ox-tabs[data-ox-tab-group="pkg-manager"] label\').forEach(function (label) {',
      "    if (label.textContent.trim() !== 'npm') return;",
      '    var input = document.getElementById(label.htmlFor);',
      '    if (input) input.checked = true;',
      '  });',
      '})();',
      // On a phone a table's rows are set one under another, each cell
      // labelled by its column (theme/cdkd.css). The explicit roles keep it a
      // table for assistive technology once its display is no longer one.
      '(function () {',
      "  document.querySelectorAll('.content table').forEach(function (table) {",
      "    var heads = Array.prototype.map.call(table.querySelectorAll('thead th'), function (th) {",
      '      return th.textContent.trim();',
      '    });',
      "    table.setAttribute('role', 'table');",
      "    table.querySelectorAll(':scope > thead, :scope > tbody').forEach(function (group) {",
      "      group.setAttribute('role', 'rowgroup');",
      '    });',
      "    table.querySelectorAll('tr').forEach(function (row) {",
      "      row.setAttribute('role', 'row');",
      '      Array.prototype.forEach.call(row.children, function (cell, i) {',
      "        if (cell.closest('thead')) { cell.setAttribute('role', 'columnheader'); return; }",
      "        cell.setAttribute('role', 'cell');",
      "        if (heads[i]) cell.setAttribute('data-label', heads[i]);",
      '      });',
      '    });',
      "    table.setAttribute('data-cdkd-stack', '');",
      // Core may have measured the table before it stacked and named it
      // scrollable; a stacked table that no longer scrolls drops that.
      "    if (table.dataset.oxTableScrollLabel === 'true' && table.scrollWidth <= table.clientWidth + 1) {",
      "      table.removeAttribute('aria-label');",
      "      table.removeAttribute('data-ox-table-scrollable');",
      '      delete table.dataset.oxTableScrollLabel;',
      "      if (table.dataset.oxTableScrollTabindex === 'true') {",
      "        table.removeAttribute('tabindex');",
      '        delete table.dataset.oxTableScrollTabindex;',
      '      }',
      '    }',
      '  });',
      '})();',
      // Output and error messages quoted in a `text` fence wrap rather than
      // scroll sideways: their lines are as long as the tool printed them.
      // A fence that draws (a tree, a flow) keeps its lines, since wrapping
      // one would break the drawing.
      '(function () {',
      '  document.querySelectorAll(\'.content pre[data-language="text"]\').forEach(function (pre) {',
      "    if (!/[\u2500-\u257f\u25b2-\u25c4]/.test(pre.textContent)) pre.classList.add('cdkd-pre-wrap');",
      '  });',
      '})();',
      // One button per search scope under the search input
      // (plugins/search-scopes.ts).
      scopeShortcutsScript(SEARCH_SCOPES),
      // The sidebar groups' open and close, where CSS alone cannot animate
      // it (plugins/nav-toggle.ts).
      navOpenCurrentScript(),
      navToggleScript(Number.parseInt(tokens.motion.duration.normal, 10), tokens.motion.ease),
    ].join('\n'),
    embed: {
      head: [
        '<link rel="icon" href="/favicon.ico" sizes="32x32">',
        '<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">',
        '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
        `<meta name="theme-color" content="${tokens.brand.paper}" media="(prefers-color-scheme: light)">`,
        `<meta name="theme-color" content="${tokens.brand.night}" media="(prefers-color-scheme: dark)">`,
        '<link rel="preload" href="/fonts/geist-400.woff2" as="font" type="font/woff2" crossorigin>',
        '<link rel="preload" href="/fonts/geist-600.woff2" as="font" type="font/woff2" crossorigin>',
        ...islandsStyles(command),
        `<script type="module" src="${islandsEntry(command)}"></script>`,
      ].join('\n'),
    },
    css: THEME_CSS,
  });

// Vue components usable as islands from Markdown, named by their kebab-case
// file names. Ox Content's Vue integration owns the registry and serves it as
// `virtual:ox-content-vue/components`. The map is built here with absolute
// paths: a `components` glob resolves to root-relative `./...` specifiers,
// which a virtual module cannot import from. Pages stay with the SSG below,
// so two of the integration's parts are left out: its copy of the core
// environment plugin (oxContent() already registers it) and the `config`
// hook that adds its own SSR/client environments, whose warm-up would run
// every page through the JavaScript pipeline.
const COMPONENTS_DIR = fileURLToPath(new URL('./components/', import.meta.url));
const components = Object.fromEntries(
  readdirSync(COMPONENTS_DIR)
    .filter((file) => file.endsWith('.vue'))
    .map((file) => [registryName(file.slice(0, -'.vue'.length)), join(COMPONENTS_DIR, file)]),
);
// Both parts are picked out by plugin name, so a release that renames either
// stops the build here rather than quietly bringing them back.
const VUE_PARTS_LEFT_OUT = ['ox-content:environment', 'ox-content:vue-environment'];
const vueComponents = (): Plugin[] => {
  const plugins = oxContentVue({ srcDir: CONTENT_DIR, components }) as Plugin[];
  const missing = VUE_PARTS_LEFT_OUT.filter((name) => !plugins.some((p) => p.name === name));
  if (missing.length > 0) {
    throw new Error(
      `[docs] @ox-content/vite-plugin-vue no longer has ${missing.join(', ')}; revisit vueComponents()`,
    );
  }
  return plugins.flatMap((plugin) => {
    if (plugin.name === 'ox-content:environment') return [];
    if (plugin.name === 'ox-content:vue-environment') {
      const { config: _environments, ...registry } = plugin;
      return [registry];
    }
    return [plugin];
  });
};

export default defineConfig(({ command }) => ({
  root: ROOT,
  // Kept with the repo's other Vite caches, apart from the CLI build's.
  cacheDir: 'node_modules/.vite/docs',
  publicDir: `${SITE_DIR}/public`,
  build: {
    outDir: SITE_OUT_DIR,
    emptyOutDir: true,
    // The largest chunk is the key visual's three.js scene (~530 kB), loaded
    // only on the home page, only with WebGL2, and after the poster shows.
    chunkSizeWarningLimit: 600,
    // The pages are static; Ox Content emits every one during this build's
    // closeBundle. The one client entry is the islands loader, and the one
    // stylesheet the components', both under fixed names because the
    // theme's head tags above have to name them.
    cssCodeSplit: false,
    rollupOptions: {
      input: { islands: `${SITE_DIR}/islands/client.ts` },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.css'))
            ? ISLANDS_CSS
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [
    vize(),
    ...vueComponents(),
    oxContent({
      srcDir: CONTENT_DIR,
      outDir: SITE_OUT_DIR,
      highlight: true,
      gfm: true,
      toc: true,
      codeGroups: true,
      siteMaps: true,
      publishState: true,
      // Authoring blocks the pages use beyond GFM: `::: steps` around a
      // numbered procedure, `::: card-grid` / `::: card` for the hubs that
      // send a reader on, and `{kbd:...}` for a key to press. Notes use
      // GitHub's `> [!NOTE]` alerts, which need no option and also render
      // on GitHub.
      steps: true,
      cards: true,
      keyboardKeys: true,
      ogImage: true,
      ogImageOptions: {
        // A Vue SFC, compiled with vize like the site's components.
        template: `./${SITE_DIR}/og/og-image.vue`,
        vuePlugin: 'vizejs',
        width: 1200,
        height: 630,
        cache: true,
        concurrency: 4,
      },
      // Status emoji in the docs render as Lucide status marks; every icon is
      // resolved at build time into one CSS-mask stylesheet, so the site
      // requests nothing from the Iconify API. The components are scanned for
      // the classes they use; the status marks (rendered by the transformer)
      // and the home page's feature icons (read from its frontmatter, which
      // the scan does not reach) are named outright.
      transformers: [statusIcons(), codeSpans(), diagrams()],
      // `<pm>npm i …</pm>` becomes one tab per package manager, and the
      // reader's choice carries across every such block (and the hero's).
      embeds: { pm: { sync: true } },
      icons: {
        include: [`${SITE_DIR}/components/*.vue`],
        safelist: [...STATUS_ICONS, ...FEATURE_ICONS],
      },
      // The JSDoc-derived API docs generator is off: cdkd's public surface is
      // its CLI, documented by hand in cli-reference.md.
      docs: false,
      ssg: {
        siteName: SITE_NAME,
        siteUrl: 'https://cdkd.dev',
        lastUpdated: true,
        generateOgImage: true,
        pagination: true,
        readerChrome: true,
        a11y: true,
        pageChrome: true,
        notFound: true,
        jsonLd: true,
        // Publish the raw Markdown beside each page (plus
        // <link rel="alternate" type="text/markdown">) so AI agents can pull
        // clean source; pairs with the llms.txt emitted by `siteMaps`.
        markdownSource: true,
        theme: theme(command),
      },
    }),
    // After the SSG, render the Vue islands into the written pages and move
    // the hero's into place (islands/ssr-plugin.ts).
    islandSsrPlugin({
      outDir: SITE_OUT_DIR,
      entry: `/${SITE_DIR}/islands/server.ts`,
      plugins: () => [vize(), ...vueComponents()],
    }),
    // After the SSG: give the home page a search-result headline instead of
    // the bare site name (see plugins/home-title.ts for why the SSG cannot
    // be configured to do this). Its `enforce: 'post'` is what orders it
    // after the plugins `oxContent()` returns (none carry `enforce`; the
    // separate `oxContentCustomHost()` entry point does ship a `post` one,
    // so switching to it would make array order load-bearing). The position
    // here only mirrors that for the reader.
    homeTitlePlugin({
      siteName: SITE_NAME,
      outDir: SITE_OUT_DIR,
      indexMarkdownPath: HOME_MARKDOWN,
    }),
    // After the SSG: give each document in the search index the scope of its
    // sidebar group (plugins/search-scopes.ts).
    searchScopesPlugin({ outDir: SITE_OUT_DIR, groups: navigation }),
  ],
}));
