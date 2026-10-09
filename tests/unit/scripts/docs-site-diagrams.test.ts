import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import type { MarkdownNode } from '@ox-content/vite-plugin';
import { DIAGRAMS } from '../../../docs/diagrams/index.js';
import {
  type Diagram,
  type Variant,
  escapeXml,
  layout,
  renderFigure,
  renderSvg,
  wrap,
} from '../../../docs/diagrams/render.js';
import { diagramId, diagrams } from '../../../docs/plugins/diagrams.js';

// The docs' flow diagrams are drawn from data; these pin the layout's
// invariants and the swap of a named fence for its drawing.

const ROOT = join(import.meta.dirname, '..', '..', '..');
const VARIANTS: Variant[] = ['wide', 'narrow'];

describe('wrap', () => {
  it('fills lines word by word up to the width', () => {
    expect(wrap('one two three four', 10 * 7, 7)).toEqual(['one two', 'three four']);
  });

  it('cuts a word longer than a line at punctuation or a camelCase capital', () => {
    expect(wrap('intrinsic-function-resolver.ts', 12 * 7, 7)).toEqual([
      'intrinsic-',
      'function-',
      'resolver.ts',
    ]);
    expect(wrap('ContextProviderRegistry', 16 * 7, 7)).toEqual(['ContextProvider', 'Registry']);
    expect(wrap('AssemblyReader', 13 * 7, 7)).toEqual(['Assembly', 'Reader']);
  });
});

describe('escapeXml', () => {
  it('escapes markup characters', () => {
    expect(escapeXml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});

describe.each(Object.values(DIAGRAMS).flatMap((d) => VARIANTS.map((v) => [d.id, v, d] as const)))(
  '%s (%s)',
  (_id, variant, diagram) => {
    const { m, boxes, height } = layout(diagram, variant);
    const all = [...boxes.values()];

    it('places every node, inside the drawing', () => {
      expect(all.map((box) => box.node.id).sort()).toEqual(
        diagram.rows
          .flat()
          .filter((id): id is string => id !== null)
          .sort()
      );
      for (const box of all) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w).toBeLessThanOrEqual(m.width);
        expect(box.y + box.h).toBeLessThanOrEqual(height);
      }
    });

    it('keeps boxes apart', () => {
      for (const a of all) {
        for (const b of all) {
          if (a === b) continue;
          const apart =
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart, `${a.node.id} overlaps ${b.node.id}`).toBe(true);
        }
      }
    });

    it('sets no line longer than its box can hold', () => {
      for (const box of all) {
        const inner = box.w - 28;
        for (const line of box.titleLines) expect(line.length * 8.2).toBeLessThanOrEqual(inner);
        for (const line of box.detailLines) {
          const advance = line.kind === 'mono' ? 7.6 : 6.7;
          expect(line.text.length * advance).toBeLessThanOrEqual(inner + 1);
        }
      }
    });

    it('is a named, described image', () => {
      const svg = renderSvg(diagram, variant);
      const id = `cdkd-diagram-${diagram.id}-${variant}`;
      expect(svg).toMatch(new RegExp(`^<svg [^>]*role="img" aria-labelledby="${id}-title ${id}-desc"`));
      expect(svg).toContain(`<title id="${id}-title">${escapeXml(diagram.title)}</title>`);
      expect(svg).toContain(`<desc id="${id}-desc">`);
      expect(svg.match(/<rect /g)).toHaveLength(all.length);
    });
  }
);

describe('layout', () => {
  const tiny: Diagram = {
    id: 'tiny',
    title: 'Tiny',
    description: 'Two boxes.',
    rows: [['a'], ['b']],
    nodes: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ],
  };

  it('chains rows when no edges are given', () => {
    expect(layout(tiny, 'wide').edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('refuses a row naming a node it does not define', () => {
    expect(() => layout({ ...tiny, rows: [['a'], ['c']] }, 'wide')).toThrow(/no node "c"/);
  });

  it('draws the narrow and the wide drawing in one figure', () => {
    const figure = renderFigure(tiny);
    expect(figure).toMatch(/^<figure class="cdkd-diagram"><svg [^>]*cdkd-diagram__svg--wide/);
    expect(figure).toContain('cdkd-diagram__svg--narrow');
  });
});

describe('diagrams transformer', () => {
  const run = (ast: MarkdownNode) => diagrams().transform(ast, {} as never) as MarkdownNode;

  it('reads the id from a fence info string', () => {
    expect(diagramId('diagram=how-it-works')).toBe('how-it-works');
    expect(diagramId('title="x" diagram=layers')).toBe('layers');
    expect(diagramId('diagrams=layers')).toBeNull();
    expect(diagramId(undefined)).toBeNull();
  });

  it('swaps a named fence for its drawing and leaves other fences alone', () => {
    const named: MarkdownNode = { type: 'code', lang: 'text', meta: 'diagram=layers', value: 'x' };
    const plain: MarkdownNode = { type: 'code', lang: 'text', value: 'x' };
    const out = run({ type: 'root', children: [named, plain] });
    expect(out.children?.[0]).toEqual({ type: 'html', value: renderFigure(DIAGRAMS['layers']!) });
    expect(out.children?.[1]).toEqual(plain);
  });

  it('refuses a fence naming a diagram that does not exist', () => {
    const ast: MarkdownNode = {
      type: 'root',
      children: [{ type: 'code', lang: 'text', meta: 'diagram=nope', value: '' }],
    };
    expect(() => run(ast)).toThrow(/"nope"/);
  });

  it('defines every diagram a page names', () => {
    const pages = readdirSync(join(ROOT, 'docs', '_contents')).filter((f) => f.endsWith('.md'));
    const named = pages.flatMap((page) =>
      [...readFileSync(join(ROOT, 'docs', '_contents', page), 'utf8').matchAll(/^```\S*\s+([^\n]*)$/gm)]
        .map((m) => diagramId(m[1]))
        .filter((id): id is string => id !== null)
    );
    expect(named.length).toBeGreaterThanOrEqual(8);
    for (const id of named) expect(DIAGRAMS).toHaveProperty(id);
  });
});
