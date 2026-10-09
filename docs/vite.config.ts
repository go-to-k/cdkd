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
import { registryName } from './islands/html.js';
import { islandSsrPlugin } from './islands/ssr-plugin.js';
import { codeSpans } from './plugins/code-spans.js';
import { diagrams } from './plugins/diagrams.js';
import { STATUS_ICONS, statusIcons } from './plugins/status-icons.js';
import { tokens, tokensToCss } from './brand/tokens.js';

const SITE_NAME = 'cdkd';
// This directory is the Vite root: the paths below are relative to it.
const ROOT = fileURLToPath(new URL('.', import.meta.url));
// The pages. The rest of docs/ is the site itself: theme, components, assets.
const CONTENT_DIR = '_contents';
const HOME_MARKDOWN = `${CONTENT_DIR}/index.md`;

/** Iconify names (`prefix:name`) the home page's `features` use. */
const FEATURE_ICONS = (() => {
  const source = readFileSync(new URL(`./${HOME_MARKDOWN}`, import.meta.url), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '';
  const features = (parseYaml(frontmatter) as { features?: Array<{ icon?: unknown }> }).features;
  return (features ?? [])
    .map((feature) => feature.icon)
    .filter(
      (icon): icon is string => typeof icon === 'string' && /^[a-z0-9-]+:[a-z0-9-]+$/.test(icon),
    );
})();
const SITE_OUT_DIR = '../dist/site';

// Documentation site config (https://cdkd.dev), separate from the root
// vite.config.ts on purpose: the root config's `cdkd:vp-build` plugin claims
// every build environment as already built (it delegates to `vp pack`), which
// would short-circuit the Ox Content SSG build if the two shared a config.
// Invoked via `vp run docs:dev` / `docs:build` / `docs:preview`; the vize
// tasks beside them carry the Vue toolchain's settings as flags.

// Sidebar is hand-authored (not derived from the file tree) so the site's
// information architecture is independent of the flat _contents/ layout —
// existing files stay where tests and markgate scopes bind to them, and
// internal material (_contents/design/**, _contents/plans/**,
// _contents/_generated/**, coverage matrices, changelog-cdkd.md) simply gets
// no navigation entry.
const navigation: SsgNavigationGroup[] = [
  {
    title: 'Guide',
    items: [
      { title: 'Introduction', path: '/introduction' },
      { title: 'Getting Started', path: '/getting-started' },
      { title: 'Using with AI Agents', path: '/ai-agents' },
      { title: 'Core Concepts', path: '/concepts' },
      { title: 'Benchmarks', path: '/benchmarks' },
    ],
  },
  {
    title: 'Features',
    items: [
      { title: 'Wait Modes', path: '/wait-modes' },
      { title: 'Rollback', path: '/rollback' },
      { title: 'Drift Detection', path: '/drift' },
      { title: 'Orphan vs Destroy', path: '/orphan-vs-destroy' },
      { title: 'State Store', path: '/state-store' },
      { title: 'Import & CFn Migration', path: '/import' },
      { title: 'Export to CloudFormation', path: '/export' },
      { title: 'Mixed Estates', path: '/mixed-estates' },
      { title: 'Stack Outputs', path: '/stack-outputs' },
      { title: 'Provisioning Layers', path: '/provisioning-layers' },
      { title: 'Deployment Events', path: '/deployment-events' },
      { title: 'CI: Per-PR Environments', path: '/ci-per-pr' },
    ],
  },
  {
    title: 'CLI Reference',
    items: [
      { title: 'Overview', path: '/cli-reference' },
      { title: 'Deploy: waits & concurrency', path: '/cli-deploy' },
      { title: 'Deploy: tuning', path: '/cli-deploy-tuning' },
      { title: 'Deploy: safety & compatibility flags', path: '/cli-deploy-safety' },
      { title: 'cdkd list', path: '/cli-list' },
      { title: 'cdkd synth', path: '/cli-synth' },
      { title: 'cdkd diff', path: '/cli-diff' },
      { title: 'cdkd drift', path: '/cli-drift' },
      { title: 'Destroy flags & guards', path: '/cli-destroy' },
      { title: 'cdkd bootstrap', path: '/cli-bootstrap' },
      { title: 'cdkd gc', path: '/cli-gc' },
      { title: 'cdkd rollback', path: '/cli-rollback' },
      { title: 'cdkd force-unlock', path: '/cli-force-unlock' },
      { title: 'cdkd export', path: '/cli-export' },
      { title: 'cdkd scrub', path: '/cli-scrub' },
      { title: 'cdkd publish-assets', path: '/cli-publish-assets' },
      { title: 'cdkd events', path: '/cli-events' },
      { title: 'cdkd state', path: '/cli-state' },
    ],
  },
  {
    title: 'Local Execution',
    items: [
      { title: 'Overview', path: '/local-emulation' },
      { title: 'local invoke', path: '/local-invoke' },
      { title: 'local start-api', path: '/local-start-api' },
      { title: 'local run-task', path: '/local-run-task' },
      { title: 'local start-service', path: '/local-start-service' },
      { title: 'local start-alb', path: '/local-start-alb' },
      { title: 'local start-cloudfront', path: '/local-start-cloudfront' },
      { title: 'local invoke-agentcore', path: '/local-invoke-agentcore' },
      { title: 'local start-agentcore', path: '/local-start-agentcore' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { title: 'Supported Resources', path: '/supported-resources' },
      { title: 'Feature Parity', path: '/supported-features' },
      { title: 'State Management', path: '/state-management' },
      { title: 'Cross-Stack References', path: '/cross-stack-references' },
    ],
  },
  {
    title: 'Help',
    items: [{ title: 'Troubleshooting', path: '/troubleshooting' }],
  },
  {
    title: 'Contributing',
    items: [
      { title: 'Contributing Guide', path: '/contributing' },
      { title: 'Architecture', path: '/architecture' },
      { title: 'Provider Development', path: '/provider-development' },
      { title: 'Testing', path: '/testing' },
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
  items: group.items.map((item) => ({ text: item.title, link: item.path ?? item.href ?? '' })),
}));

// Islands: one small module on every page, which loads Vue and the
// components only where a page has an island (islands/client.ts).
// The dev server serves the source; the build emits it unhashed so this
// static tag can name it.
const islandsEntry = (command: 'build' | 'serve'): string =>
  command === 'serve' ? '/islands/client.ts' : '/assets/islands.js';

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
      { text: 'GitHub', link: 'https://github.com/go-to-k/cdkd' },
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
  // Kept with the repo's other caches, not in a docs/node_modules of its own.
  cacheDir: '../node_modules/.vite/docs',
  build: {
    outDir: SITE_OUT_DIR,
    // Outside the root, so Vite would not clear it unasked.
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
      input: { islands: 'islands/client.ts' },
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
      ogImage: true,
      ogImageOptions: {
        // A Vue SFC, compiled with vize like the site's components.
        template: './og/og-image.vue',
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
        include: ['components/*.vue'],
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
      entry: '/islands/server.ts',
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
  ],
}));
