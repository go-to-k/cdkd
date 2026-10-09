import type { MarkdownNode } from '@ox-content/vite-plugin';
import { describe, expect, it } from 'vite-plus/test';
import {
  STATUS_ICONS,
  STATUS_MARKS,
  splitStatusText,
  statusIcons,
  statusMarkHtml,
} from '../../../docs/plugins/status-icons.js';

// The docs keep their status emoji in Markdown (GitHub and the raw Markdown
// companions read them); the site renders them as Lucide status marks.

describe('splitStatusText', () => {
  it('names a mark that stands alone, as in a table cell', () => {
    expect(splitStatusText('✅')).toEqual([
      { type: 'html', value: statusMarkHtml(STATUS_MARKS['✅']!, true) },
    ]);
    expect(statusMarkHtml(STATUS_MARKS['✅']!, true)).toBe(
      '<span class="cdkd-status cdkd-status--yes"><span class="cdkd-status__icon iconify-icon icon-[lucide--circle-check]" aria-hidden="true"></span><span class="cdkd-visually-hidden">Supported</span></span>'
    );
  });

  it('leaves a mark beside words unnamed, since the words carry the meaning', () => {
    expect(splitStatusText('✅ (via STS)')).toEqual([
      { type: 'html', value: statusMarkHtml(STATUS_MARKS['✅']!, false) },
      { type: 'text', value: ' (via STS)' },
    ]);
    expect(statusMarkHtml(STATUS_MARKS['❌']!, false)).not.toContain('cdkd-visually-hidden');
  });

  it('handles every mark, and the warning sign only in its emoji form', () => {
    expect(splitStatusText('❌')?.[0]?.value).toContain('icon-[lucide--circle-x]');
    expect(splitStatusText('⚠️')?.[0]?.value).toContain('icon-[lucide--triangle-alert]');
    expect(splitStatusText('⚠ plain text sign')).toBeNull();
    expect(splitStatusText('no marks here')).toBeNull();
  });

  it('lists every icon it renders, for the icon stylesheet', () => {
    expect(STATUS_ICONS).toEqual(['lucide:circle-check', 'lucide:circle-x', 'lucide:triangle-alert']);
  });
});

describe('statusIcons transformer', () => {
  it('rewrites text nodes and never code', async () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [
        {
          type: 'table',
          children: [
            {
              type: 'tableCell',
              children: [{ type: 'text', value: '✅' }],
            },
            {
              type: 'tableCell',
              children: [{ type: 'inlineCode', value: '✅' }],
            },
          ],
        },
        { type: 'code', value: '✅ Deployment completed' },
      ],
    };
    const out = await statusIcons().transform(tree, {} as never);
    const [cell, codeCell] = out.children![0]!.children!;
    expect(cell!.children![0]!.type).toBe('html');
    expect(codeCell!.children![0]).toEqual({ type: 'inlineCode', value: '✅' });
    expect(out.children![1]).toEqual({ type: 'code', value: '✅ Deployment completed' });
  });
});
