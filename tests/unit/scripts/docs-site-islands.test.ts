import { describe, expect, it } from 'vite-plus/test';
import {
  decodeEntities,
  findIslands,
  findMatchingClose,
  parseAttributes,
  registryName,
  relocateIslands,
  renderIslands,
} from '../../../docs-site/islands/html.js';

// The build-time half of the docs site's Vue islands: finding the island
// blocks Ox Content passes through from Markdown, rendering them in place,
// and moving slotted ones into the entry layout's hero.

const page = (body: string): string =>
  [
    '<section class="hero">',
    '  <div class="hero-image"><img src="/brand/logo-light.svg"></div>',
    '  <div class="hero-content"><h1 class="hero-name">cdkd</h1></div>',
    '</section>',
    '<div class="entry-content"><div class="content">',
    body,
    '</div></div>',
  ].join('\n');

describe('parseAttributes', () => {
  it('reads double-, single- and un-quoted values, decoding entities', () => {
    expect(
      parseAttributes(` data-ox-island="cdkd-command" data-ox-props='{"lines":["a &amp; b"]}' hidden x=1`)
    ).toEqual({
      'data-ox-island': 'cdkd-command',
      'data-ox-props': '{"lines":["a & b"]}',
      hidden: '',
      x: '1',
    });
  });

  it('decodes named and numeric entities, and leaves unknown ones alone', () => {
    expect(decodeEntities('&quot;&#39;&#x41;&lt;&gt;&amp;&nbsp;')).toBe(`"'A<>&&nbsp;`);
  });
});

describe('findIslands', () => {
  it('finds each top-level island with its props and exact bounds', () => {
    const html = page(
      `<div data-ox-island="a"></div>\n<p>text</p>\n<div data-ox-island="b" data-ox-props='{"n":1}'><div><span>ssr</span></div></div>`
    );
    const islands = findIslands(html);
    expect(islands.map((island) => [island.name, island.props])).toEqual([
      ['a', {}],
      ['b', { n: 1 }],
    ]);
    const b = islands[1]!;
    expect(html.slice(b.start, b.end)).toBe(
      `<div data-ox-island="b" data-ox-props='{"n":1}'><div><span>ssr</span></div></div>`
    );
  });

  it('refuses props that are not a JSON object, and an unterminated island', () => {
    expect(() => findIslands(`<div data-ox-island="a" data-ox-props='[1]'></div>`)).toThrow(
      /must be a JSON object/
    );
    expect(() => findIslands(`<div data-ox-island="a"><div></div>`)).toThrow(/unterminated/);
  });

  it('matches nested divs to the right close', () => {
    const html = '<div><div></div><div><div></div></div></div>tail';
    expect(findMatchingClose(html, 5)).toBe(html.lastIndexOf('</div>'));
  });
});

describe('renderIslands', () => {
  it('fills rendered islands and marks them for hydration; leaves client-only ones', async () => {
    const html = `<div data-ox-island="server" data-ox-props='{"who":"x"}'></div><div data-ox-island="client"></div>`;
    const out = await renderIslands(html, async (name, props) =>
      name === 'server' ? `<b>${String(props['who'])}</b>` : null
    );
    expect(out).toBe(
      `<div data-ox-island="server" data-ox-props='{"who":"x"}' data-ox-ssr="true"><b>x</b></div><div data-ox-island="client"></div>`
    );
  });

  it('is idempotent on an island already marked', async () => {
    const html = `<div data-ox-island="s" data-ox-ssr="true"><i>old</i></div>`;
    const out = await renderIslands(html, async () => '<i>new</i>');
    expect(out).toBe(`<div data-ox-island="s" data-ox-ssr="true"><i>new</i></div>`);
  });
});

describe('relocateIslands', () => {
  it('moves slotted islands to the end of their slot, in document order', () => {
    const html = page(
      [
        '<div data-ox-island="visual" data-cdkd-slot="hero-image"></div>',
        '<h2>Benchmarks</h2>',
        '<div data-ox-island="first" data-cdkd-slot="hero-content"></div>',
        '<div data-ox-island="second" data-cdkd-slot="hero-content"></div>',
        '<div data-ox-island="stays"></div>',
      ].join('\n')
    );
    const out = relocateIslands(html);
    expect(out).toContain(
      '<div class="hero-image"><img src="/brand/logo-light.svg"><div data-ox-island="visual" data-cdkd-slot="hero-image"></div></div>'
    );
    expect(out).toContain(
      '<h1 class="hero-name">cdkd</h1><div data-ox-island="first" data-cdkd-slot="hero-content"></div><div data-ox-island="second" data-cdkd-slot="hero-content"></div></div>'
    );
    const body = out.slice(out.indexOf('entry-content'));
    expect(body).toContain('<h2>Benchmarks</h2>');
    expect(body).toContain('<div data-ox-island="stays"></div>');
    expect(body).not.toContain('data-cdkd-slot');
    expect(relocateIslands(out)).toBe(out);
  });

  it('leaves an island where it was written when its slot is not on the page', () => {
    const html = `<main><div data-ox-island="visual" data-cdkd-slot="hero-image"></div></main>`;
    expect(relocateIslands(html)).toBe(html);
  });

  it('ignores a slot name it does not know', () => {
    const html = page('<div data-ox-island="x" data-cdkd-slot="footer"></div>');
    expect(relocateIslands(html)).toBe(html);
  });
});

describe('registryName', () => {
  it('turns a kebab-case component name into its registry identifier', () => {
    expect(registryName('cdkd-command')).toBe('CdkdCommand');
    expect(registryName('cdkd-key-visual')).toBe('CdkdKeyVisual');
    expect(registryName('og-image-2')).toBe('OgImage2');
    expect(registryName('benchmark')).toBe('Benchmark');
  });

  it('refuses every other spelling, so a component has one name', () => {
    for (const name of ['CdkdCommand', 'cdkdCommand', 'cdkd_command', 'cdkd--command', '-cdkd', '']) {
      expect(() => registryName(name)).toThrow(/kebab-case/);
    }
  });
});
