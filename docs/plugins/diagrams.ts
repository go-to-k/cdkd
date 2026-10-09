// Ox Content transformer: a fenced text diagram whose info string names a
// drawing (```text diagram=how-it-works) is replaced by that drawing on the
// site. The fence itself stays in the Markdown, where GitHub and the raw
// pages for AI agents still read the text.
import type { MarkdownNode, MarkdownTransformer } from '@ox-content/vite-plugin';
import { DIAGRAMS } from '../diagrams/index.js';
import { renderFigure } from '../diagrams/render.js';

const NAMED = /(?:^|\s)diagram=([a-z0-9-]+)(?:\s|$)/;

/** The diagram id a fence's info string names, if any. */
export function diagramId(meta: unknown): string | null {
  return typeof meta === 'string' ? (NAMED.exec(meta)?.[1] ?? null) : null;
}

function rewrite(node: MarkdownNode): MarkdownNode {
  if (node.type === 'code') {
    const id = diagramId(node['meta']);
    if (!id) return node;
    const diagram = DIAGRAMS[id];
    if (!diagram)
      throw new Error(`[diagrams] a fence names "${id}", which docs/diagrams does not define`);
    return { type: 'html', value: renderFigure(diagram) };
  }
  if (!node.children) return node;
  return { ...node, children: node.children.map(rewrite) };
}

export function diagrams(): MarkdownTransformer {
  return { name: 'cdkd:diagrams', transform: (ast) => rewrite(ast) };
}
