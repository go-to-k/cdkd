// The cdkd design tokens: cdkd.tokens.json is the single source, and this
// module is the only reader of it. The site's CSS custom properties are
// generated from it at build time (tokensToCss), and TypeScript consumers --
// the key visual, the OG image -- import the same values from here, so no
// color or size is ever written down twice.
import json from './cdkd.tokens.json' with { type: 'json' };

export type ThemeName = 'light' | 'dark';
export type ColorToken = keyof typeof json.themes.light.color;

export const tokens = json;

export function themeColor(theme: ThemeName, name: ColorToken): string {
  return json.themes[theme].color[name];
}

/**
 * The syntax theme ("cdkd Night"): each highlighter role mapped to a
 * dark-theme color token. Code sits on the Night surface in both page
 * themes, so the roles always resolve against the dark palette.
 */
export const SYNTAX_ROLES = {
  background: 'code-bg',
  foreground: 'code-text',
  function: 'link-hover',
  constant: 'info',
  string: 'success',
  'string-expression': 'success',
  keyword: 'warning',
  parameter: 'code-text',
  punctuation: 'text-secondary',
  comment: 'code-muted',
  link: 'info',
  // Line annotations and the file-name bar.
  highlight: 'code-accent',
  added: 'success',
  removed: 'danger',
  warned: 'warning',
  'line-number': 'border',
  'title-bg': 'surface',
  'title-text': 'text-secondary',
  'title-border': 'border-subtle',
} as const satisfies Record<string, ColorToken>;

/**
 * Site-level roles composed from the brand tokens, per theme. They are
 * decisions about the brand, not new values: each names a token.
 */
export const DERIVED_ROLES = {
  /** Edge of a Night code surface: none on Paper, a hairline on Night. */
  'code-frame': { light: 'transparent', dark: 'var(--cdkd-color-border-subtle)' },
} as const;

const block = (selector: string, vars: Record<string, string>, indent = ''): string =>
  [
    `${indent}${selector} {`,
    ...Object.entries(vars).map(([name, value]) => `${indent}  --cdkd-${name}: ${value};`),
    `${indent}}`,
  ].join('\n');

function themeVars(theme: ThemeName): Record<string, string> {
  const { color, shadow } = json.themes[theme];
  return {
    ...Object.fromEntries(Object.entries(color).map(([name, value]) => [`color-${name}`, value])),
    ...Object.fromEntries(Object.entries(shadow).map(([name, value]) => [`shadow-${name}`, value])),
    ...Object.fromEntries(
      Object.entries(DERIVED_ROLES).map(([name, values]) => [name, values[theme]])
    ),
  };
}

function staticVars(): Record<string, string> {
  const { typography, space, radius, size, border, layout, motion, brand } = json;
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(brand)) vars[name] = value;
  for (const [name, value] of Object.entries(typography.fontFamily)) vars[`font-${name}`] = value;
  for (const [name, value] of Object.entries(typography.fontWeight))
    vars[`weight-${name}`] = String(value);
  vars['font-features-ui'] = typography.fontFeatures.ui;
  vars['font-features-code'] = typography.fontFeatures.code;
  vars['numeric-data'] = typography.dataNumeric;
  for (const [step, type] of Object.entries(typography.scale)) {
    vars[`type-${step}-size`] = type.size;
    vars[`type-${step}-leading`] = type.leading;
    vars[`type-${step}-weight`] = String(type.weight);
    vars[`type-${step}-tracking`] = type.tracking;
  }
  for (const [name, value] of Object.entries(space)) vars[`space-${name}`] = value;
  for (const [name, value] of Object.entries(radius)) vars[`radius-${name}`] = value;
  for (const [name, value] of Object.entries(size)) vars[`size-${name}`] = value;
  vars['border-width'] = border.width;
  vars['border-focus-width'] = border['focus-width'];
  vars['border-focus-offset'] = border['focus-offset'];
  for (const [name, value] of Object.entries(layout)) vars[`layout-${name}`] = String(value);
  for (const [name, value] of Object.entries(motion.duration)) vars[`motion-${name}`] = value;
  vars['motion-ease'] = motion.ease;
  vars['motion-distance'] = motion.distance;
  for (const [role, name] of Object.entries(SYNTAX_ROLES)) {
    vars[`syntax-${role}`] = themeColor('dark', name);
  }
  return vars;
}

function mobileVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [step, type] of Object.entries(json.typography.mobileScale)) {
    vars[`type-${step}-size`] = type.size;
    vars[`type-${step}-leading`] = type.leading;
  }
  return vars;
}

/**
 * Every token as a `--cdkd-*` custom property. Theme selection follows Ox
 * Content's switch: an explicit `data-theme` on <html> wins, and without one
 * the system scheme decides.
 */
export function tokensToCss(): string {
  const dark = themeVars('dark');
  const { reduced } = json.motion;
  return [
    '/* Generated from docs-site/brand/cdkd.tokens.json by docs-site/brand/tokens.ts. */',
    block(':root', { ...staticVars(), ...themeVars('light') }),
    block(`[data-theme='dark']`, dark),
    `@media (prefers-color-scheme: dark) {\n${block(`:root:not([data-theme='light'])`, dark, '  ')}\n}`,
    `@media (max-width: ${json.layout.breakpoint}) {\n${block(':root', mobileVars(), '  ')}\n}`,
    `@media (prefers-reduced-motion: reduce) {\n${block(
      ':root',
      {
        'motion-fast': reduced.duration,
        'motion-normal': reduced.duration,
        'motion-slow': reduced.duration,
        'motion-distance': reduced.distance,
      },
      '  '
    )}\n}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
