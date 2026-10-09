// Ox Content transformer: the status emoji the docs use (✅ ❌ ⚠️) become
// brand status marks -- a Lucide icon in the status color -- when the page
// is rendered.
//
// The Markdown keeps the emoji on purpose: the same files are read on GitHub
// and published raw for AI agents (`markdownSource`), where an emoji still
// reads correctly and an HTML span would not. Code spans and code blocks are
// separate node types, so a glyph inside one is never touched.
import type { MarkdownNode, MarkdownTransformer } from '@ox-content/vite-plugin';

export interface StatusMark {
  status: 'yes' | 'no' | 'caution';
  icon: string;
  /** Spoken when the mark stands alone, as in a table cell. */
  label: string;
}

export const STATUS_MARKS: Record<string, StatusMark> = {
  '✅': { status: 'yes', icon: 'lucide:circle-check', label: 'Supported' },
  '❌': { status: 'no', icon: 'lucide:circle-x', label: 'Not supported' },
  '⚠️': { status: 'caution', icon: 'lucide:triangle-alert', label: 'Caution' },
};

/** Every icon the marks use, for the self-hosted icon stylesheet's safelist. */
export const STATUS_ICONS = Object.values(STATUS_MARKS).map((mark) => mark.icon);

const GLYPHS = new RegExp(`(${Object.keys(STATUS_MARKS).join('|')})`, 'u');

export function statusMarkHtml(mark: StatusMark, labelled: boolean): string {
  const [prefix, name] = mark.icon.split(':');
  const icon = `<span class="cdkd-status__icon iconify-icon icon-[${prefix}--${name}]" aria-hidden="true"></span>`;
  const label = labelled ? `<span class="cdkd-visually-hidden">${mark.label}</span>` : '';
  return `<span class="cdkd-status cdkd-status--${mark.status}">${icon}${label}</span>`;
}

/** The replacement nodes for one text node, or `null` when it has no glyph. */
export function splitStatusText(value: string): MarkdownNode[] | null {
  if (!GLYPHS.test(value)) return null;
  const parts = value.split(GLYPHS).filter((part) => part !== '');
  // A mark with no words beside it carries the meaning alone, so it is named;
  // next to words it is a decoration of them.
  const alone = parts.length === 1;
  return parts.map((part) => {
    const mark = STATUS_MARKS[part];
    return mark
      ? { type: 'html', value: statusMarkHtml(mark, alone) }
      : { type: 'text', value: part };
  });
}

function rewrite(node: MarkdownNode): MarkdownNode {
  if (!node.children) return node;
  const children: MarkdownNode[] = [];
  for (const child of node.children) {
    const replaced =
      child.type === 'text' && typeof child.value === 'string'
        ? splitStatusText(child.value)
        : null;
    if (replaced) children.push(...replaced);
    else children.push(rewrite(child));
  }
  return { ...node, children };
}

export function statusIcons(): MarkdownTransformer {
  return { name: 'cdkd:status-icons', transform: (ast) => rewrite(ast) };
}
