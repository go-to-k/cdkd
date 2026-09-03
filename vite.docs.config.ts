import { defineConfig } from 'vite-plus';
import { defineTheme, oxContent } from '@ox-content/vite-plugin';
import type { SsgNavigationGroup } from '@ox-content/vite-plugin';
import swiss from '@ox-content/theme-swiss';


// Documentation site config (https://cdkd.dev), separate from the root
// vite.config.ts on purpose: the root config's `cdkd:vp-build` plugin claims
// every build environment as already built (it delegates to `vp pack`), which
// would short-circuit the Ox Content SSG build if the two shared a config.
// Invoked via `vp run docs:dev` / `docs:build` / `docs:preview`.

// Sidebar is hand-authored (not derived from the file tree) so the site's
// information architecture is independent of the flat docs/ file layout —
// existing files stay where tests and markgate scopes bind to them, and
// internal material (docs/design/**, docs/plans/**, docs/_generated/**,
// coverage matrices, changelog-cdkd.md) simply gets no navigation entry.
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
      { title: 'Stack Outputs', path: '/stack-outputs' },
      { title: 'Rollback', path: '/rollback' },
      { title: 'Drift Detection', path: '/drift' },
      { title: 'Orphan vs Destroy', path: '/orphan-vs-destroy' },
      { title: 'Import & CFn Migration', path: '/import' },
      { title: 'Export to CloudFormation', path: '/export' },
      { title: 'Mixed Estates', path: '/mixed-estates' },
      { title: 'Local Execution', path: '/local-emulation' },
      { title: 'CI: Per-PR Environments', path: '/ci-per-pr' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { title: 'CLI Reference', path: '/cli-reference' },
      { title: 'Supported Resources', path: '/supported-resources' },
      { title: 'Feature Parity', path: '/supported-features' },
      { title: 'State Management', path: '/state-management' },
      { title: 'Deployment Events', path: '/deployment-events' },
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
      { title: 'Architecture', path: '/architecture' },
      { title: 'Provider Development', path: '/provider-development' },
      { title: 'Testing', path: '/testing' },
    ],
  },
];

// Brand layer for the "Bypass" concept: Swiss skin + indigo palette with the
// amber direct-line accent from the logo.
const theme = defineTheme({
  colors: {
    primary: '#4f46e5',
    primaryHover: '#4338ca',
  },
  darkColors: {
    primary: '#818cf8',
    primaryHover: '#a5b0fb',
  },
  aside: true,
  headingPermalink: 'hover',
  header: {
    logoLight: '/brand/logo-light.svg',
    logoDark: '/brand/logo-dark.svg',
    showSiteNameText: true,
  },
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
  embed: {
    head: '<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">',
  },
  // Local overrides on the Swiss skin, which leans hard on hairline rules and
  // slide-on-hover motion:
  // - header: breathing room after the site name; borderless controls
  //   (GitHub / search / theme toggle read as boxed buttons otherwise)
  // - sidebar: drop the per-item hairline separators and the section
  //   top-rules, replace the hover SLIDE with a color/tint change on a
  //   rounded pill, and restyle the active item to the same pill shape.
  css: [
    '.header-nav { margin-left: 1.5rem; }',
    '.header-actions .social-link,',
    '.header-actions .search-button,',
    '.header-actions .theme-toggle {',
    '  border: none; background: transparent; box-shadow: none;',
    '  border-radius: 8px !important;',
    '}',
    // The skin's hover paints these controls background=rule / text=page-bg,
    // which in light mode is white-on-white — restate the hover as the same
    // tint treatment the sidebar uses so it stays visible in both themes.
    '.header-actions .social-link:hover,',
    '.header-actions .search-button:hover,',
    '.header-actions .theme-toggle:hover {',
    '  background: color-mix(in srgb, var(--octc-color-primary) 12%, transparent);',
    '  color: var(--octc-color-primary);',
    '}',
    '.nav-title, .toc-title { border-top: none; }',
    // The sidebar/outline column rules run the full viewport height and cut
    // across the header nav items above them — drop both.
    '.sidebar { border-right: none; }',
    '.toc { border-left: none; }',
    '.nav-link {',
    '  border-bottom: none;',
    '  border-radius: 8px !important;',
    '  padding: 0.32rem 0.6rem;',
    '}',
    '.nav-link:hover {',
    '  padding-left: 0.6rem;',
    '  background: color-mix(in srgb, var(--octc-color-primary) 10%, transparent);',
    '  color: var(--octc-color-primary);',
    '}',
    '.nav-link.active {',
    '  padding-left: 0.6rem;',
    '  border-radius: 8px !important;',
    '  background: color-mix(in srgb, var(--octc-color-primary) 14%, transparent);',
    '  box-shadow: none;',
    '}',
  ].join('\n'),
});

export default defineConfig({
  publicDir: 'docs-site/public',
  build: {
    outDir: 'dist/site',
    // The site is fully static; Ox Content emits every page during this
    // build's closeBundle. Vite still demands a client entry, so feed it an
    // empty module instead of an index.html.
    rollupOptions: {
      input: { noop: 'docs-site/noop-entry.ts' },
    },
  },
  plugins: [
    oxContent({
      srcDir: 'docs',
      outDir: 'dist/site',
      highlight: true,
      gfm: true,
      toc: true,
      codeGroups: true,
      siteMaps: true,
      publishState: true,
      ogImage: true,
      ogImageOptions: {
        template: './docs-site/og-template.ts',
        width: 1200,
        height: 630,
        cache: true,
        concurrency: 4,
      },
      editThisPage: {
        repoUrl: 'https://github.com/go-to-k/cdkd',
        branch: 'main',
      },
      // The JSDoc-derived API docs generator is off: cdkd's public surface is
      // its CLI, documented by hand in cli-reference.md.
      docs: false,
      ssg: {
        siteName: 'cdkd',
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
        navigation,
        theme: [swiss, theme],
      },
    }),
  ],
});
