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
      { title: 'Rollback', path: '/rollback' },
      { title: 'Drift Detection', path: '/drift' },
      { title: 'Orphan vs Destroy', path: '/orphan-vs-destroy' },
      { title: 'Import & CFn Migration', path: '/import' },
      { title: 'Export to CloudFormation', path: '/export' },
      { title: 'Mixed Estates', path: '/mixed-estates' },
      { title: 'Stack Outputs', path: '/stack-outputs' },
      { title: 'Deployment Events', path: '/deployment-events' },
      { title: 'CI: Per-PR Environments', path: '/ci-per-pr' },
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
    title: 'CLI Reference',
    items: [
      { title: 'Overview', path: '/cli-reference' },
      { title: 'Deploy: waits & tuning', path: '/cli-deploy' },
      { title: 'Deploy: safety flags', path: '/cli-deploy-safety' },
      { title: 'diff', path: '/cli-diff' },
      { title: 'drift', path: '/cli-drift' },
      { title: 'Destroy flags & guards', path: '/cli-destroy' },
      { title: 'bootstrap & gc', path: '/cli-bootstrap-gc' },
      { title: 'rollback', path: '/cli-rollback' },
      { title: 'export', path: '/cli-export' },
      { title: 'scrub', path: '/cli-scrub' },
      { title: 'publish-assets', path: '/cli-publish-assets' },
      { title: 'events', path: '/cli-events' },
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
  fonts: {
    sans: '-apple-system, "system-ui", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
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
  // The SSG's active-state matching does not fire for hand-authored
  // `navigation` items (no .active lands on the current page's link), so
  // mark it client-side by comparing pathnames.
  js: [
    "document.querySelectorAll('.sidebar .nav-link').forEach(function (a) {",
    "  var norm = function (p) { return p.replace(/index\\.html$/, '').replace(/\\/$/, ''); };",
    "  if (norm(a.getAttribute('href') || '') === norm(location.pathname)) a.classList.add('active');",
    "});",
  ].join('\n'),
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
    '.header-title { gap: 0.4rem; }',
    '.header-logo { margin-right: 0; }',
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
    // Entry-page hero, three tiers: (1) logo beside the title + headline,
    // (2) the tagline full-width under them, (3) the action buttons. The
    // theme's markup nests everything but the image inside .hero-content, so
    // display:contents lifts its children into the hero grid.
    // width:fit-content + auto margins center the whole block on the page
    // while its interior stays left-aligned; rows 1fr/1fr stretch the title
    // column to the logo's height so "cdkd" tops out level with the logo and
    // the headline bottoms out level with it.
    // min-height:unset kills the skin's min(100vh, 56rem) hero, which left a
    // screenful of dead space between the actions and the feature cards.
    '.hero { display: grid; grid-template-columns: auto auto; grid-template-rows: 4.5rem 4.5rem auto auto; column-gap: 1.1rem; align-content: center; width: fit-content; margin-inline: auto; min-height: unset; padding-block: calc(var(--octc-header-height) + 2.5rem) 3rem; }',
    '.hero-content { display: contents; }',
    '.hero-image { grid-column: 1; grid-row: 1 / span 2; margin: 0; align-self: center; }',
    '.hero-image img { width: 9rem; height: 9rem; }',
    // The entry layout's own `.hero-image img { display: block }` outranks
    // the core `.theme-asset--dark { display: none }` toggle, so LIGHT mode
    // showed both logo variants stacked. Restate the three theme states at
    // higher specificity.
    '.hero-image img.theme-asset--dark { display: none; }',
    '[data-theme="dark"] .hero-image img.theme-asset--dark { display: block; }',
    '[data-theme="dark"] .hero-image img.theme-asset--light { display: none; }',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) .hero-image img.theme-asset--dark { display: block; }',
    '  :root:not([data-theme="light"]) .hero-image img.theme-asset--light { display: none; }',
    '}',
    '.hero-name { grid-column: 2; grid-row: 1; align-self: start; margin: 0; line-height: 1; text-align: left; }',
    '.hero-name::after { content: "CDK Direct"; display: inline-block; margin-left: 0.6rem; font-size: 0.85rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--octc-color-text-muted); transform: translateY(-0.9rem); }',
    '.hero-text { grid-column: 2; grid-row: 2; align-self: end; margin: 0; text-align: left; font-size: 1.35rem; }',
    '.hero-tagline { grid-column: 1 / -1; grid-row: 3; margin: 1.75rem 0 0; max-width: 36.5rem; }',
    '.hero-actions { grid-column: 1 / -1; grid-row: 4; }',
    // The skin flattens every control to sharp corners; round the hero CTAs.
    '.hero-action { border-radius: 8px !important; }',
    // One skin layer draws .hero{border-bottom:2px} while the first feature
    // card draws its own border-top — a double rule between hero and cards.
    // Its ::after paints a bottom fade sized for the full-height hero, which
    // on the compact hero overlaps the action buttons and reads as the
    // section going transparent — drop it. Feature cards keep no hover
    // motion (the skin slides them 8px right) and no scroll-rise animation.
    '.hero { border-bottom: 0; background: none; }',
    '.hero::after { display: none; }',
    // Three selling-point cards in one row (the skin stacks them in a tall
    // single column); collapse back to one column on narrow viewports.
    '.features-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; column-gap: 2.5rem; }',
    '@media (max-width: 900px) { .features-grid { grid-template-columns: 1fr; } }',
    '.feature-card { animation: none; }',
    '.feature-card:hover { transform: none; }',
    '@media (max-width: 768px) {',
    '  .hero { grid-template-columns: 1fr; grid-template-rows: auto auto auto auto auto; justify-items: center; text-align: center; }',
    '  .hero-image { grid-column: 1; grid-row: 1; justify-self: center; }',
    '  .hero-image img { width: 6.5rem; height: 6.5rem; }',
    '  .hero-name { grid-column: 1; grid-row: 2; align-self: auto; margin-top: 1.25rem; text-align: center; }',
    '  .hero-name::after { display: none; }',
    '  .hero-text { grid-column: 1; grid-row: 3; align-self: auto; margin-top: 0.75rem; text-align: center; }',
    '  .hero-tagline { grid-column: 1; grid-row: 4; margin-top: 1rem; }',
    '  .hero-actions { grid-column: 1; grid-row: 5; }',
    '}',
    // Content pages: the skin caps paragraphs at 68ch while lists run the
    // full column — mixed measures that read as the source's line wrapping
    // leaking through. Let paragraphs use the full column like GitHub does,
    // and thin the heavy 2px heading rules to a hairline.
    '.content p { max-width: none; }',
    '.content h2 { border-bottom: 2px solid color-mix(in srgb, var(--octc-sw-rule) 45%, transparent); }',
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
