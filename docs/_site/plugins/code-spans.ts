// Ox Content transformer: an inline code span names one thing -- a flag, a
// path, a type -- and reads wrong broken across two lines (`--` | `revert`),
// so the theme keeps inline code on one line. A span too long for a phone's
// text column is marked here as long, and the theme lets that one wrap.
//
// Headings are left alone: their text is the anchor id the site's links use.
import type { MarkdownNode, MarkdownTransformer } from '@ox-content/vite-plugin';

/** The longest span kept on one line: it still fits a phone's text column. */
export const UNBROKEN_MAX = 36;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The node an inline code span renders as. */
export function codeSpan(value: string): MarkdownNode {
  return value.length > UNBROKEN_MAX
    ? { type: 'html', value: `<code class="cdkd-code-long">${escapeHtml(value)}</code>` }
    : { type: 'inlineCode', value };
}

function rewrite(node: MarkdownNode): MarkdownNode {
  if (!node.children || node.type === 'heading') return node;
  return {
    ...node,
    children: node.children.map((child) =>
      child.type === 'inlineCode' && typeof child.value === 'string'
        ? codeSpan(child.value)
        : rewrite(child),
    ),
  };
}

export function codeSpans(): MarkdownTransformer {
  return { name: 'cdkd:code-spans', transform: (ast) => rewrite(ast) };
}
