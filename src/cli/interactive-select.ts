/**
 * A keyboard-driven list picker for an interactive terminal (go-to-k/cdkd#5199):
 * arrow keys move, typing filters, Enter picks, Esc goes back, Ctrl+C quits.
 *
 * It reads keypresses in raw mode rather than through
 * `readline.createInterface`, so it is not a line prompt, and it never runs
 * without a TTY: callers check {@link isInteractiveTerminal} first. Labels are
 * written as given, so a caller renders every value through `displayIdent` /
 * `stripForDisplay` before handing it here.
 */
import { emitKeypressEvents } from 'node:readline';

export interface SelectItem<T> {
  label: string;
  value: T;
}

export type SelectResult<T> = { kind: 'picked'; value: T } | { kind: 'back' } | { kind: 'quit' };

/** The input side: a TTY read stream, or a test double shaped like one. */
export interface SelectInput extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?: (on: boolean) => unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The output side: where the list is drawn. */
export interface SelectOutput {
  isTTY?: boolean;
  rows?: number;
  columns?: number;
  write(chunk: string): unknown;
}

export interface SelectStreams {
  input: SelectInput;
  output: SelectOutput;
  /** How long a fresh list ignores keys (see {@link selectFromList}); tests pass 0. */
  armDelayMs?: number;
}

/** No one answers a list within 50 ms of it appearing; a key that early was typed before it. */
const ARM_DELAY_MS = 50;

/**
 * One character the filter accepts: a letter, digit, punctuation, symbol or
 * space. The filter is echoed into the frame, so a control, format or bidi
 * character (from a paste, say) is never taken into it.
 */
const FILTER_CHAR = /^[\p{L}\p{N}\p{P}\p{S} ]$/u;

interface Keypress {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
}

/** Whether both streams are terminals, so a picker can be drawn and answered. */
export function isInteractiveTerminal(streams: SelectStreams): boolean {
  return (
    streams.input.isTTY === true &&
    typeof streams.input.setRawMode === 'function' &&
    streams.output.isTTY === true
  );
}

/** The items whose label contains `filter`, ignoring case. */
export function filterItems<T>(items: readonly SelectItem<T>[], filter: string): SelectItem<T>[] {
  const needle = filter.toLowerCase();
  return needle === '' ? [...items] : items.filter((i) => i.label.toLowerCase().includes(needle));
}

/**
 * The lines one frame of the picker draws: the title, the filter when one is
 * typed, a window of items around the cursor, and a key hint.
 */
export function renderSelectFrame<T>(
  title: string,
  visible: readonly SelectItem<T>[],
  cursor: number,
  filter: string,
  pageSize: number
): string[] {
  const lines = [title];
  if (filter !== '') lines.push(`  filter: ${filter}`);
  if (visible.length === 0) {
    lines.push('  (no match)');
  } else {
    const start = Math.min(
      Math.max(0, cursor - Math.floor(pageSize / 2)),
      Math.max(0, visible.length - pageSize)
    );
    const end = Math.min(visible.length, start + pageSize);
    if (start > 0) lines.push(`  ... ${start} more above`);
    for (let i = start; i < end; i++) {
      lines.push(`${i === cursor ? '> ' : '  '}${visible[i]!.label}`);
    }
    if (end < visible.length) lines.push(`  ... ${visible.length - end} more below`);
  }
  lines.push('  (up/down move, type to filter, Enter select, Esc back, Ctrl+C quit)');
  return lines;
}

/**
 * `line` cut to fit `columns - 1` code points, so no frame line wraps: the
 * redraw moves up one row per LINE, and a wrapped line would leave a stale row
 * behind on every keypress.
 */
export function fitToWidth(line: string, columns: number | undefined): string {
  if (typeof columns !== 'number' || columns < 2) return line;
  const chars = [...line];
  return chars.length < columns ? line : `${chars.slice(0, columns - 2).join('')}…`;
}

/**
 * Let the user pick one of `items`. Resolves on Enter (`picked`), Esc
 * (`back`) or Ctrl+C / Ctrl+D (`quit`). The frame is erased when it resolves,
 * and the terminal's raw mode is restored on every path.
 */
export function selectFromList<T>(
  title: string,
  items: readonly SelectItem<T>[],
  streams: SelectStreams
): Promise<SelectResult<T>> {
  const { input, output } = streams;
  // A terminal that reports no size (0, or no field at all) gets 24 rows.
  const rows = typeof output.rows === 'number' && output.rows > 0 ? output.rows : 24;
  const pageSize = Math.max(3, Math.min(15, rows - 5));
  let filter = '';
  let cursor = 0;
  let drawn = 0;

  const erase = (): void => {
    // Up to the frame's first line, then clear to the end of the screen.
    if (drawn > 0) output.write(`\x1b[${drawn}F\x1b[0J`);
    drawn = 0;
  };
  const draw = (): void => {
    erase();
    const lines = renderSelectFrame(
      title,
      filterItems(items, filter),
      cursor,
      filter,
      pageSize
    ).map((line) => fitToWidth(line, output.columns));
    output.write(`${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  return new Promise<SelectResult<T>>((resolve, reject) => {
    emitKeypressEvents(input as NodeJS.ReadableStream);
    input.setRawMode?.(true);
    input.resume();
    // Keys typed while the previous view was printing sit in the terminal's
    // buffer and arrive as soon as stdin is read again; they were not aimed at
    // this list, so they are dropped rather than picking an entry. A timer,
    // not a turn of the loop: the buffer is read on the NEXT poll, which a
    // `setImmediate` scheduled from a poll callback runs before.
    let armed = false;
    const armTimer = setTimeout(() => {
      armed = true;
    }, streams.armDelayMs ?? ARM_DELAY_MS);

    const finish = (result: SelectResult<T>): void => {
      clearTimeout(armTimer);
      input.removeListener('keypress', onKey);
      input.setRawMode?.(false);
      input.pause();
      erase();
      resolve(result);
    };

    const onKey = (str: string | undefined, key: Keypress | undefined): void => {
      if (!armed) return;
      const visible = filterItems(items, filter);
      const name = key?.name;
      if (key?.ctrl === true && (name === 'c' || name === 'd')) return finish({ kind: 'quit' });
      if (name === 'escape') return finish({ kind: 'back' });
      if (name === 'return' || name === 'enter') {
        const picked = visible[cursor];
        if (picked !== undefined) return finish({ kind: 'picked', value: picked.value });
        return;
      }
      if (name === 'up' || (key?.ctrl === true && name === 'p')) {
        cursor = visible.length === 0 ? 0 : (cursor - 1 + visible.length) % visible.length;
      } else if (name === 'down' || (key?.ctrl === true && name === 'n')) {
        cursor = visible.length === 0 ? 0 : (cursor + 1) % visible.length;
      } else if (name === 'backspace') {
        filter = filter.slice(0, -1);
        cursor = 0;
      } else if (
        typeof str === 'string' &&
        key?.ctrl !== true &&
        key?.meta !== true &&
        FILTER_CHAR.test(str)
      ) {
        filter += str;
        cursor = 0;
      } else {
        return;
      }
      draw();
    };

    input.on('keypress', onKey);
    try {
      draw();
    } catch (error) {
      clearTimeout(armTimer);
      input.removeListener('keypress', onKey);
      input.setRawMode?.(false);
      input.pause();
      reject(error);
    }
  });
}
