// String-level island handling for the static pages Ox Content's SSG writes.
//
// A page declares a Vue island as a raw HTML block in its Markdown, naming
// the component by its kebab-case file name:
//
//   <div data-ox-island="cdkd-command" data-ox-props='{"lines":["cdkd deploy"]}'></div>
//
// The SSG passes that block through untouched. After it has written the page,
// the build renders each island to HTML (renderIslands) and moves islands
// that name a slot into the entry layout's hero (relocateIslands), so the
// static page already has the final markup and layout: nothing shifts when
// the client hydrates, and a reader without JavaScript still gets the content.
//
// The same slot move runs in the browser (hydrate.ts) for `vp run docs:dev`,
// where no build step touches the page.

/** Where an island may ask to be placed, and the entry-layout element it joins. */
export const ISLAND_SLOTS = {
  'hero-content': 'hero-content',
  'hero-image': 'hero-image',
} as const;

export type IslandSlot = keyof typeof ISLAND_SLOTS;

const KEBAB_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * The key a component is registered under, from its kebab-case file or
 * island name: `cdkd-command` -> `CdkdCommand`. Ox Content's Vue registry
 * imports each component under its key, so the key must be an identifier.
 * Any other spelling is refused, so a component has exactly one name.
 */
export function registryName(name: string): string {
  if (!KEBAB_NAME.test(name)) {
    throw new Error(`[islands] component names are kebab-case: ${JSON.stringify(name)}`);
  }
  return name.replace(/(?:^|-)([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function isIslandSlot(value: string | undefined): value is IslandSlot {
  return value !== undefined && Object.hasOwn(ISLAND_SLOTS, value);
}

export interface IslandMatch {
  name: string;
  props: Record<string, unknown>;
  attrs: Record<string, string>;
  /** Offset of `<div`. */
  start: number;
  /** Offset just past the opening tag's `>`. */
  openEnd: number;
  /** Offset of the matching `</div>`. */
  closeStart: number;
  /** Offset just past the matching `</div>`. */
  end: number;
}

const ISLAND_OPEN = /<div\b([^>]*\bdata-ox-island\s*=\s*(?:"[^"]*"|'[^']*')[^>]*)>/gi;
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    const code = lower.startsWith('#x')
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

/** Attributes of one opening tag's attribute text, entity-decoded. */
export function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/** Offset of the `</div>` closing the element whose content starts at `from`. */
export function findMatchingClose(html: string, from: number): number {
  const tag = /<div\b[^>]*>|<\/div\s*>/gi;
  tag.lastIndex = from;
  let depth = 1;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    if (match[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return match.index;
    } else if (!match[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return -1;
}

function parseProps(raw: string | undefined, name: string): Record<string, unknown> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[islands] ${name}: data-ox-props must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Top-level islands in document order. Islands nested in islands are not supported. */
export function findIslands(html: string): IslandMatch[] {
  const islands: IslandMatch[] = [];
  ISLAND_OPEN.lastIndex = 0;
  for (let match = ISLAND_OPEN.exec(html); match; match = ISLAND_OPEN.exec(html)) {
    const attrs = parseAttributes(match[1] ?? '');
    const name = attrs['data-ox-island'] ?? '';
    const openEnd = match.index + match[0].length;
    const closeStart = findMatchingClose(html, openEnd);
    if (!name || closeStart === -1) {
      throw new Error(`[islands] unterminated island at offset ${match.index}`);
    }
    const end = html.indexOf('>', closeStart) + 1;
    islands.push({
      name,
      props: parseProps(attrs['data-ox-props'], name),
      attrs,
      start: match.index,
      openEnd,
      closeStart,
      end,
    });
    ISLAND_OPEN.lastIndex = end;
  }
  return islands;
}

/** The id prefix an island's Vue app uses, the same on the server and the client. */
export function islandIdPrefix(index: number): string {
  return `cdkd-island-${index}`;
}

/**
 * Renders islands in place. `render` returns the island's inner HTML, or
 * `null` for a client-only island, which is left as written. Rendered
 * islands are marked `data-ox-ssr="true"` so the client hydrates them
 * instead of mounting over them, and numbered (`data-cdkd-island`) in
 * document order: each island is its own app, and the number keeps the
 * ids two of them generate apart.
 */
export async function renderIslands(
  html: string,
  render: (name: string, props: Record<string, unknown>, index: number) => Promise<string | null>,
): Promise<string> {
  let output = html;
  const islands = findIslands(html);
  for (const [index, island] of [...islands.entries()].toReversed()) {
    const inner = await render(island.name, island.props, index);
    if (inner === null) continue;
    // The number is always this render's: it is the prefix the island was
    // just rendered with, whatever an earlier pass or the page wrote.
    const openTag = output
      .slice(island.start, island.openEnd)
      .replace(/\sdata-cdkd-island\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    const ssr = /\sdata-ox-ssr\b/i.test(openTag) ? '' : ' data-ox-ssr="true"';
    const marked = `${openTag.slice(0, -1)}${ssr} data-cdkd-island="${index}">`;
    output = output.slice(0, island.start) + marked + inner + output.slice(island.closeStart);
  }
  return output;
}

/**
 * Moves every island carrying `data-cdkd-slot` to the end of the slot's
 * element, in document order. The slot is the first `div` with that class
 * among its classes. An island whose slot is not on the page, or never
 * closes, stays where it was written.
 */
export function relocateIslands(html: string): string {
  const slotOpen = (slot: IslandSlot): RegExp =>
    new RegExp(`<div\\b[^>]*\\bclass="(?:[^"]*\\s)?${ISLAND_SLOTS[slot]}(?:\\s[^"]*)?"[^>]*>`);
  const placeable = (slot: IslandSlot): boolean => {
    const open = slotOpen(slot).exec(html);
    return open !== null && findMatchingClose(html, open.index + open[0].length) !== -1;
  };
  const moving = findIslands(html).filter((island) => {
    const slot = island.attrs['data-cdkd-slot'];
    return isIslandSlot(slot) && placeable(slot);
  });
  let output = html;
  for (const island of moving.toReversed()) {
    output = output.slice(0, island.start) + output.slice(island.end);
  }
  for (const island of moving) {
    const open = slotOpen(island.attrs['data-cdkd-slot'] as IslandSlot).exec(output);
    if (!open) continue;
    const closeStart = findMatchingClose(output, open.index + open[0].length);
    if (closeStart === -1) continue;
    output =
      output.slice(0, closeStart) + html.slice(island.start, island.end) + output.slice(closeStart);
  }
  return output;
}
