import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { MARK_PATHS } from '../../../docs/brand/mark.js';
import {
  DERIVED_ROLES,
  SYNTAX_ROLES,
  themeColor,
  tokens,
  tokensToCss,
} from '../../../docs/brand/tokens.js';

// The docs site's design tokens have one source, cdkd.tokens.json; the CSS
// custom properties are generated from it, and the logo files and the syntax
// theme are held to it here.

const ROOT = join(import.meta.dirname, '../../..');

/** WCAG relative luminance of `#rrggbb`. */
const luminance = (hex: string): number => {
  const channel = (offset: number): number => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The declarations inside the first block opened by `selector`. */
const blockOf = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no block for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

describe('tokensToCss', () => {
  const css = tokensToCss();

  it('emits every light color on :root and every dark color for the dark theme', () => {
    const light = blockOf(css, ':root');
    const dark = blockOf(css, "[data-theme='dark']");
    for (const [name, value] of Object.entries(tokens.themes.light.color)) {
      expect(light).toContain(`--cdkd-color-${name}: ${value};`);
    }
    for (const [name, value] of Object.entries(tokens.themes.dark.color)) {
      expect(dark).toContain(`--cdkd-color-${name}: ${value};`);
    }
  });

  it('applies the dark theme to an explicit choice and to the system choice', () => {
    expect(css).toContain(`[data-theme='dark'] {`);
    expect(css).toContain(`@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {`);
  });

  it('emits the scale, spacing, radii and motion tokens, and the derived roles per theme', () => {
    const root = blockOf(css, ':root');
    expect(root).toContain(`--cdkd-type-h1-size: ${tokens.typography.scale.h1.size};`);
    expect(root).toContain(`--cdkd-space-4: ${tokens.space['4']};`);
    expect(root).toContain(`--cdkd-radius-md: ${tokens.radius.md};`);
    expect(root).toContain(`--cdkd-motion-ease: ${tokens.motion.ease};`);
    for (const [name, values] of Object.entries(DERIVED_ROLES)) {
      expect(root).toContain(`--cdkd-${name}: ${values.light};`);
      expect(blockOf(css, "[data-theme='dark']")).toContain(`--cdkd-${name}: ${values.dark};`);
    }
  });

  it('switches to the mobile type scale at the brand breakpoint, and stills motion on request', () => {
    expect(css).toContain(`@media (max-width: ${tokens.layout.breakpoint}) {`);
    expect(css).toContain(`--cdkd-type-display-size: ${tokens.typography.mobileScale.display.size};`);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\n {2}:root \{\n {4}--cdkd-motion-fast: 0ms;/);
  });
});

describe('syntax theme (cdkd Night)', () => {
  it('gives every role a dark-theme token that holds 7:1 against the code surface', () => {
    const surface = themeColor('dark', 'code-bg');
    const text = ['function', 'constant', 'string', 'keyword', 'punctuation', 'comment', 'foreground'];
    for (const role of text) {
      const token = SYNTAX_ROLES[role as keyof typeof SYNTAX_ROLES];
      const ratio = contrast(themeColor('dark', token), surface);
      expect(ratio, `${role} (${token})`).toBeGreaterThanOrEqual(7);
    }
  });

  it('is emitted as --cdkd-syntax-* and wired into every Ox Content syntax variable', () => {
    const root = blockOf(tokensToCss(), ':root');
    for (const [role, token] of Object.entries(SYNTAX_ROLES)) {
      expect(root).toContain(`--cdkd-syntax-${role}: ${themeColor('dark', token)};`);
    }
    const sheet = readFileSync(join(ROOT, 'docs/theme/syntax.css'), 'utf8');
    for (const token of [
      'function',
      'constant',
      'string',
      'string-expression',
      'keyword',
      'parameter',
      'punctuation',
      'comment',
      'link',
    ]) {
      expect(sheet).toContain(`--octc-syntax-token-${token}: var(--cdkd-syntax-${token});`);
    }
    const declarations = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations, 'syntax.css restates a color instead of naming a token').not.toMatch(
      /#[0-9a-f]{3,6}\b/i
    );
  });
});

describe('logo files', () => {
  const cloud = [MARK_PATHS.top, MARK_PATHS.left, MARK_PATHS.body].join(' ');

  it.each([
    ['logo-light.svg', tokens.brand.navy],
    ['logo-dark.svg', tokens.brand.cloud],
  ])('%s draws the symbol geometry in its colorway', (file, cloudColor) => {
    const svg = readFileSync(join(ROOT, 'docs/public/brand', file), 'utf8');
    expect(svg).toContain(`<path fill="${cloudColor}" d="${cloud}"/>`);
    expect(svg).toContain(`<path fill="${tokens.brand.orange}" d="${MARK_PATHS.route}"/>`);
  });

  it('keeps every face a closed outline', () => {
    for (const [face, d] of Object.entries(MARK_PATHS)) {
      expect(d.startsWith('M'), face).toBe(true);
      expect(d.endsWith('Z'), face).toBe(true);
    }
  });
});
