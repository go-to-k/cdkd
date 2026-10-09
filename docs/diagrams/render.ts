// Flow diagrams for the docs, drawn as SVG from data.
//
// A page keeps its text diagram in the Markdown (GitHub and the raw pages
// published for AI agents read that) and names a diagram here in the fence's
// info string; plugins/diagrams.ts swaps the fence for this drawing when the
// site is built. Every drawing comes from one layout, so they share one look:
// flat boxes on hairlines, the brand route only where a diagram marks it, and
// the page's own colors through the theme's custom properties.
//
// Each diagram is drawn twice, wide and narrow, and the theme shows the one
// that fits: scaling a wide drawing down to a phone would shrink its text
// below reading size.

export interface DiagramNode {
  id: string;
  title: string;
  /** Lines under the title, set smaller. */
  detail?: string[];
  /** Set the detail lines in the code face (names of files and functions). */
  mono?: boolean;
  /** A remark beside the box, or inside it where there is no room beside. */
  note?: string;
  /** On the route the diagram is about: outlined in the brand's route color. */
  route?: boolean;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface Diagram {
  id: string;
  /** The drawing's accessible name. */
  title: string;
  /** What the drawing shows, in prose, for anyone who cannot see it. */
  description: string;
  /**
   * Node ids, top row first. A row of one id spans the width; otherwise each
   * entry is a column slot, and `null` leaves its slot empty.
   */
  rows: (string | null)[][];
  nodes: DiagramNode[];
  /** Arrows. Without them, each row points to every node of the next. */
  edges?: DiagramEdge[];
  /** Arrows back up to an earlier node, drawn up the right-hand side. */
  loops?: DiagramEdge[];
}

export type Variant = 'wide' | 'narrow';

interface Metrics {
  width: number;
  pad: number;
  colGap: number;
  rowGap: number;
  noteGap: number;
  /** Width of the content column when notes sit beside it. */
  noteColumn: number;
  loopReserve: number;
  labelLoops: boolean;
}

const METRICS: Record<Variant, Metrics> = {
  wide: {
    width: 720,
    pad: 2,
    colGap: 24,
    rowGap: 40,
    noteGap: 28,
    noteColumn: 336,
    loopReserve: 128,
    labelLoops: true,
  },
  narrow: {
    width: 360,
    pad: 2,
    colGap: 12,
    rowGap: 36,
    noteGap: 0,
    noteColumn: 0,
    loopReserve: 26,
    labelLoops: false,
  },
};

const PAD_X = 14;
const PAD_Y = 12;
const TITLE_LINE = 20;
const DETAIL_LINE = 18;
const TITLE_GAP = 6;
const LABEL_ROOM = 14;
const HEAD = 6;

// Average advance per character, in user units, for the faces the theme sets:
// on the generous side, so a line measured to fit does fit.
const ADVANCE = { title: 8.2, detail: 6.7, mono: 7.6, label: 6.3 } as const;

/**
 * A word longer than a line, cut at the last place in it that fits: after a
 * `-`, `/`, `.` or `_`, or before the capital of a camelCase name.
 */
function breakWord(word: string, fit: number): string[] {
  const parts: string[] = [];
  let rest = word;
  while (rest.length > fit) {
    let at = 0;
    for (let i = 1; i <= fit; i++) {
      const prev = rest[i - 1]!;
      const char = rest[i] ?? '';
      if ('-/._'.includes(prev) || (/[a-z]/.test(prev) && /[A-Z]/.test(char))) at = i;
    }
    if (at < fit / 3) at = fit;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  return rest ? [...parts, rest] : parts;
}

export function wrap(text: string, maxWidth: number, advance: number): string[] {
  const fit = Math.max(1, Math.floor(maxWidth / advance));
  const lines: string[] = [];
  let line = '';
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => (word.length > fit ? breakWord(word, fit) : [word]));
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= fit || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Box {
  node: DiagramNode;
  x: number;
  y: number;
  w: number;
  h: number;
  titleLines: string[];
  detailLines: { text: string; kind: 'detail' | 'mono' | 'note' }[];
  /** Lines of the note set beside the box (wide, single-node rows only). */
  sideNote: string[];
}

const fmt = (n: number): string => String(Math.round(n * 10) / 10);

function edgesOf(diagram: Diagram): DiagramEdge[] {
  if (diagram.edges) return diagram.edges;
  const edges: DiagramEdge[] = [];
  for (let i = 0; i < diagram.rows.length - 1; i++) {
    for (const from of diagram.rows[i]!) {
      for (const to of diagram.rows[i + 1]!) {
        if (from && to) edges.push({ from, to });
      }
    }
  }
  return edges;
}

export function layout(diagram: Diagram, variant: Variant) {
  const m = METRICS[variant];
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  for (const id of diagram.rows.flat()) {
    if (id && !byId.has(id)) throw new Error(`[diagrams] ${diagram.id}: no node "${id}"`);
  }
  const edges = edgesOf(diagram);
  const loops = diagram.loops ?? [];
  const cols = Math.max(...diagram.rows.map((row) => row.length));
  const singleRowNotes = diagram.rows.some(
    (row) => row.length === 1 && row[0] && byId.get(row[0])?.note,
  );
  const notesBeside = variant === 'wide' && singleRowNotes;
  const reserve = loops.length > 0 ? m.loopReserve : 0;
  const available = m.width - 2 * m.pad - reserve;
  const content = notesBeside ? Math.min(m.noteColumn, available) : available;
  // An arrow across a row carries its label in the gap it crosses.
  const sameRow = (edge: DiagramEdge) =>
    diagram.rows.some((row) => row.includes(edge.from) && row.includes(edge.to));
  const colGap = Math.max(
    m.colGap,
    ...edges
      .filter((edge) => edge.label && sameRow(edge))
      .map((edge) => edge.label!.length * ADVANCE.label + 20),
  );
  const colWidth = (content - (cols - 1) * colGap) / cols;
  const noteX = m.pad + content + m.noteGap;
  const noteWidth = m.width - m.pad - reserve - noteX;

  const boxes = new Map<string, Box>();
  let y = m.pad;
  diagram.rows.forEach((row, r) => {
    const spans = row.length === 1;
    const placed: Box[] = [];
    row.forEach((id, slot) => {
      if (!id) return;
      const node = byId.get(id)!;
      const w = spans ? content : colWidth;
      const x = m.pad + (spans ? 0 : slot * (colWidth + colGap));
      const inner = w - 2 * PAD_X;
      const titleLines = wrap(node.title, inner, ADVANCE.title);
      const detailLines: Box['detailLines'] = [];
      for (const line of node.detail ?? []) {
        const kind = node.mono ? 'mono' : 'detail';
        for (const part of wrap(line, inner, ADVANCE[kind])) detailLines.push({ text: part, kind });
      }
      const beside = notesBeside && spans && Boolean(node.note);
      if (node.note && !beside) {
        for (const part of wrap(node.note, inner, ADVANCE.detail)) {
          detailLines.push({ text: part, kind: 'note' });
        }
      }
      const loopNote = !m.labelLoops && loops.find((loop) => loop.from === id && loop.label)?.label;
      if (loopNote) {
        for (const part of wrap(`Then: ${loopNote}`, inner, ADVANCE.detail)) {
          detailLines.push({ text: part, kind: 'note' });
        }
      }
      const sideNote = beside ? wrap(node.note!, noteWidth, ADVANCE.detail) : [];
      const h =
        2 * PAD_Y +
        titleLines.length * TITLE_LINE +
        (detailLines.length > 0 ? TITLE_GAP + detailLines.length * DETAIL_LINE : 0);
      placed.push({ node, x, y: 0, w, h, titleLines, detailLines, sideNote });
    });
    const rowHeight = Math.max(
      ...placed.map((box) => Math.max(box.h, box.sideNote.length * DETAIL_LINE + PAD_Y)),
    );
    // Room for the labels on arrows arriving in this row from above.
    const labelLines = edges
      .filter((edge) => edge.label && row.includes(edge.to) && !row.includes(edge.from))
      .map((edge) => wrap(edge.label!, m.width / 2 - 24, ADVANCE.label).length);
    const labelRoom = labelLines.length > 0 ? LABEL_ROOM + (Math.max(...labelLines) - 1) * 15 : 0;
    if (r > 0) y += m.rowGap + labelRoom;
    for (const box of placed) {
      box.y = y;
      box.h = rowHeight;
      boxes.set(box.node.id, box);
    }
    y += rowHeight;
  });

  return { m, boxes, edges, loops, height: y + m.pad, noteX };
}

function arrowHead(x: number, y: number, dir: 'down' | 'right' | 'left'): string {
  const d =
    dir === 'down'
      ? `M${fmt(x - HEAD)} ${fmt(y - HEAD - 1)}L${fmt(x)} ${fmt(y)}L${fmt(x + HEAD)} ${fmt(y - HEAD - 1)}Z`
      : dir === 'right'
        ? `M${fmt(x - HEAD - 1)} ${fmt(y - HEAD)}L${fmt(x)} ${fmt(y)}L${fmt(x - HEAD - 1)} ${fmt(y + HEAD)}Z`
        : `M${fmt(x + HEAD + 1)} ${fmt(y - HEAD)}L${fmt(x)} ${fmt(y)}L${fmt(x + HEAD + 1)} ${fmt(y + HEAD)}Z`;
  return `<path class="d-head" d="${d}"/>`;
}

/** A label, wrapped to `maxWidth` and set downward from `y`. */
function label(
  x: number,
  y: number,
  text: string,
  maxWidth: number,
  anchor: 'start' | 'middle' = 'start',
): string {
  return wrap(text, maxWidth, ADVANCE.label)
    .map(
      (line, i) =>
        `<text class="d-label" x="${fmt(x)}" y="${fmt(y + i * 15)}" text-anchor="${anchor}">${escapeXml(line)}</text>`,
    )
    .join('');
}

export function renderSvg(diagram: Diagram, variant: Variant): string {
  const { m, boxes, edges, loops, height, noteX } = layout(diagram, variant);
  const parts: string[] = [];

  for (const edge of edges) {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) throw new Error(`[diagrams] ${diagram.id}: edge ${edge.from} -> ${edge.to}`);
    if (a.y === b.y) {
      // Across a row: from the right side of one box into the next.
      const yMid = a.y + Math.min(a.h, b.h) / 2;
      const x1 = a.x + a.w;
      const x2 = b.x;
      parts.push(`<path class="d-edge" d="M${fmt(x1)} ${fmt(yMid)}H${fmt(x2 - 1)}"/>`);
      parts.push(arrowHead(x2, yMid, 'right'));
      if (edge.label) parts.push(label((x1 + x2) / 2, yMid - 7, edge.label, x2 - x1, 'middle'));
      continue;
    }
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const yMid = y2 - Math.min(m.rowGap / 2, (y2 - y1) / 2);
    const d =
      Math.abs(x1 - x2) < 1
        ? `M${fmt(x1)} ${fmt(y1)}V${fmt(y2 - 1)}`
        : `M${fmt(x1)} ${fmt(y1)}V${fmt(yMid)}H${fmt(x2)}V${fmt(y2 - 1)}`;
    parts.push(`<path class="d-edge" d="${d}"/>`);
    parts.push(arrowHead(x2, y2, 'down'));
    if (edge.label) {
      const room = m.width - m.pad - (x2 + 10);
      const lines = wrap(edge.label, room, ADVANCE.label).length;
      parts.push(label(x2 + 10, y2 - 12 - (lines - 1) * 15, edge.label, room));
    }
  }

  for (const loop of loops) {
    const a = boxes.get(loop.from);
    const b = boxes.get(loop.to);
    if (!a || !b) throw new Error(`[diagrams] ${diagram.id}: loop ${loop.from} -> ${loop.to}`);
    const right = Math.max(...[...boxes.values()].map((box) => box.x + box.w));
    const xLoop = right + 18;
    const y1 = a.y + a.h / 2;
    const y2 = b.y + Math.min(b.h / 2, 24);
    parts.push(
      `<path class="d-edge" d="M${fmt(a.x + a.w)} ${fmt(y1)}H${fmt(xLoop)}V${fmt(y2)}H${fmt(b.x + b.w + 1)}"/>`,
    );
    parts.push(arrowHead(b.x + b.w, y2, 'left'));
    if (m.labelLoops && loop.label) {
      parts.push(label(xLoop + 8, (y1 + y2) / 2, loop.label, m.width - m.pad - xLoop - 8));
    }
  }

  for (const box of boxes.values()) {
    const cls = box.node.route ? 'd-node d-node--route' : 'd-node';
    parts.push(`<g class="${cls}">`);
    parts.push(
      `<rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.w)}" height="${fmt(box.h)}" rx="6"/>`,
    );
    let ty = box.y + PAD_Y + 15;
    for (const line of box.titleLines) {
      parts.push(
        `<text class="d-title" x="${fmt(box.x + PAD_X)}" y="${fmt(ty)}">${escapeXml(line)}</text>`,
      );
      ty += TITLE_LINE;
    }
    if (box.detailLines.length > 0) ty += TITLE_GAP - 2;
    for (const line of box.detailLines) {
      parts.push(
        `<text class="d-${line.kind}" x="${fmt(box.x + PAD_X)}" y="${fmt(ty)}">${escapeXml(line.text)}</text>`,
      );
      ty += DETAIL_LINE;
    }
    parts.push('</g>');
    box.sideNote.forEach((line, i) => {
      parts.push(
        `<text class="d-note" x="${fmt(noteX)}" y="${fmt(box.y + PAD_Y + 15 + i * DETAIL_LINE)}">${escapeXml(line)}</text>`,
      );
    });
  }

  const id = `cdkd-diagram-${diagram.id}-${variant}`;
  return [
    `<svg class="cdkd-diagram__svg cdkd-diagram__svg--${variant}" viewBox="0 0 ${m.width} ${fmt(height)}" width="${m.width}" height="${fmt(height)}" role="img" aria-labelledby="${id}-title ${id}-desc">`,
    `<title id="${id}-title">${escapeXml(diagram.title)}</title>`,
    `<desc id="${id}-desc">${escapeXml(diagram.description)}</desc>`,
    ...parts,
    '</svg>',
  ].join('');
}

/** The figure a fence naming this diagram becomes. */
export function renderFigure(diagram: Diagram): string {
  return `<figure class="cdkd-diagram">${renderSvg(diagram, 'wide')}${renderSvg(diagram, 'narrow')}</figure>`;
}
