import { describe, expect, it } from 'vite-plus/test';
import type { MarkdownNode } from '@ox-content/vite-plugin';
import { UNBROKEN_MAX, codeSpan, codeSpans, escapeHtml } from '../../../docs/plugins/code-spans.js';

// Inline code stays on one line in the theme; only a span too long for a
// phone's line is marked so it may wrap.

const transform = (ast: MarkdownNode): MarkdownNode =>
  codeSpans().transform(ast, {} as never) as MarkdownNode;

describe('codeSpan', () => {
  it('leaves a span that fits on one line as inline code', () => {
    const short = '--concurrency <n>';
    expect(codeSpan(short)).toEqual({ type: 'inlineCode', value: short });
    const limit = 'x'.repeat(UNBROKEN_MAX);
    expect(codeSpan(limit)).toEqual({ type: 'inlineCode', value: limit });
  });

  it('marks a longer span, escaping its text', () => {
    const long = `${'a'.repeat(UNBROKEN_MAX)} <b> & c`;
    expect(codeSpan(long)).toEqual({
      type: 'html',
      value: `<code class="cdkd-code-long">${'a'.repeat(UNBROKEN_MAX)} &lt;b&gt; &amp; c</code>`,
    });
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });
});

describe('codeSpans', () => {
  const long = 'src/provisioning/providers/a-very-long-provider-name.ts';

  it('marks long spans anywhere in the body, including tables and links', () => {
    const ast: MarkdownNode = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'inlineCode', value: long }] },
        {
          type: 'table',
          children: [
            {
              type: 'tableRow',
              children: [
                {
                  type: 'tableCell',
                  children: [
                    {
                      type: 'link',
                      url: '#x',
                      children: [{ type: 'inlineCode', value: long }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = JSON.stringify(transform(ast));
    expect(out.match(/cdkd-code-long/g)).toHaveLength(2);
    expect(out).not.toContain('"inlineCode"');
  });

  it('leaves headings alone, since their text is the anchor id', () => {
    const heading: MarkdownNode = {
      type: 'heading',
      depth: 2,
      children: [{ type: 'inlineCode', value: long }],
    };
    expect(transform({ type: 'root', children: [heading] })).toEqual({
      type: 'root',
      children: [heading],
    });
  });
});
