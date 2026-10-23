/**
 * The keyboard picker behind `cdkd state browse` (go-to-k/cdkd#5199), driven
 * through a PassThrough that stands in for a raw-mode TTY: real key bytes for
 * the keys the decoder resolves at once, direct keypress events for Esc
 * (which the decoder holds back to tell it from an escape sequence).
 */
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  filterItems,
  isInteractiveTerminal,
  renderSelectFrame,
  selectFromList,
  type SelectStreams,
} from '../../../src/cli/interactive-select.js';

const ITEMS = [
  { label: 'alpha', value: 'a' },
  { label: 'beta', value: 'b' },
  { label: 'gamma', value: 'g' },
];

function fakeTerminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
  });
  const written: string[] = [];
  const output = { isTTY: true, rows: 24, write: (chunk: string) => written.push(chunk) };
  const streams: SelectStreams = { input, output };
  return { input, output, written, streams };
}

/** Let the keypress decoder run, then type `keys`. */
async function type(input: PassThrough, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    input.write(key);
    await new Promise((r) => setImmediate(r));
  }
}

describe('selectFromList', () => {
  it('moves with the arrow keys and picks on Enter, restoring raw mode', async () => {
    const t = fakeTerminal();
    const picked = selectFromList('Pick:', ITEMS, t.streams);
    await type(t.input, '\x1b[B', '\x1b[B', '\x1b[A', '\r');

    expect(await picked).toEqual({ kind: 'picked', value: 'b' });
    expect(t.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    // The last write erases the frame it drew.
    expect(t.written.at(-1)).toMatch(/^\x1b\[\d+F\x1b\[0J$/);
  });

  it('wraps around at either end', async () => {
    const t = fakeTerminal();
    const picked = selectFromList('Pick:', ITEMS, t.streams);
    await type(t.input, '\x1b[A', '\r');
    expect(await picked).toEqual({ kind: 'picked', value: 'g' });
  });

  it('filters as the user types, case-insensitively, and backspace widens again', async () => {
    const t = fakeTerminal();
    const picked = selectFromList('Pick:', ITEMS, t.streams);
    await type(t.input, 'M', 'x', '\x7f', '\r');
    // "Mx" matches nothing; backspace leaves "M", which only gamma holds.
    expect(await picked).toEqual({ kind: 'picked', value: 'g' });
    expect(t.written.join('')).toContain('(no match)');
  });

  it('takes no control, format or bidi character into the echoed filter', async () => {
    const t = fakeTerminal();
    const picked = selectFromList('Pick:', ITEMS, t.streams);
    t.input.emit('keypress', '\u202e', { sequence: '\u202e' });
    t.input.emit('keypress', '\u009b', { sequence: '\u009b' });
    await type(t.input, 'b', '\r');
    expect(await picked).toEqual({ kind: 'picked', value: 'b' });
    const echoed = t.written.join('');
    expect(echoed).toContain('filter: b\n');
    expect(echoed).not.toMatch(/[\u202e\u009b]/);
  });

  it('ignores Enter while nothing matches', async () => {
    const t = fakeTerminal();
    const picked = selectFromList('Pick:', ITEMS, t.streams);
    await type(t.input, 'z', '\r', '\x7f', '\r');
    expect(await picked).toEqual({ kind: 'picked', value: 'a' });
  });

  it('Esc goes back and Ctrl+C quits, both restoring raw mode', async () => {
    const back = fakeTerminal();
    const b = selectFromList('Pick:', ITEMS, back.streams);
    await type(back.input, 'a');
    back.input.emit('keypress', '\x1b', { name: 'escape', sequence: '\x1b' });
    expect(await b).toEqual({ kind: 'back' });
    expect(back.input.setRawMode).toHaveBeenLastCalledWith(false);

    const quit = fakeTerminal();
    const q = selectFromList('Pick:', ITEMS, quit.streams);
    await type(quit.input, '\x03');
    expect(await q).toEqual({ kind: 'quit' });
    expect(quit.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(quit.input.listenerCount('keypress'), 'the key listener is removed').toBe(0);
  });
});

describe('the page size', () => {
  it('fits the terminal, and a terminal reporting 0 rows gets the 24-row default', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `s${i}`, value: i }));
    for (const [rows, shown] of [[10, 5], [0, 15], [undefined, 15]] as const) {
      const t = fakeTerminal();
      (t.output as { rows?: number }).rows = rows;
      const picked = selectFromList('T', many, t.streams);
      await type(t.input, '\x03');
      await picked;
      const frame = t.written[0]!.split('\n').filter((l) => /^(> | {2})s\d+$/.test(l));
      expect(frame, `rows=${rows}`).toHaveLength(shown);
    }
  });
});

describe('renderSelectFrame', () => {
  it('shows a window around the cursor with counts of what is hidden', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `s${i}`, value: i }));
    const lines = renderSelectFrame('T', many, 10, '', 5);
    expect(lines).toEqual([
      'T',
      '  ... 8 more above',
      '  s8',
      '  s9',
      '> s10',
      '  s11',
      '  s12',
      '  ... 7 more below',
      '  (up/down move, type to filter, Enter select, Esc back, Ctrl+C quit)',
    ]);
  });

  it('shows the filter when one is typed', () => {
    expect(renderSelectFrame('T', ITEMS.slice(1, 2), 0, 'et', 5).slice(0, 3)).toEqual([
      'T',
      '  filter: et',
      '> beta',
    ]);
  });
});

describe('filterItems / isInteractiveTerminal', () => {
  it('filters by substring ignoring case', () => {
    expect(filterItems(ITEMS, 'AM').map((i) => i.value)).toEqual(['g']);
    expect(filterItems(ITEMS, '')).toHaveLength(3);
  });

  it('needs a TTY on both sides and a raw-mode input', () => {
    const t = fakeTerminal();
    expect(isInteractiveTerminal(t.streams)).toBe(true);
    expect(isInteractiveTerminal({ ...t.streams, output: { ...t.output, isTTY: false } })).toBe(false);
    expect(
      isInteractiveTerminal({ input: Object.assign(new PassThrough(), { isTTY: true }), output: t.output })
    ).toBe(false);
  });
});
