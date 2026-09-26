import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { safeMsg, terminalSafe } from '../../../src/utils/display-safe.js';
import { bold, cyan, dim, gray, green, red, yellow } from '../../../src/utils/colors.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';

const ch = (code: number): string => String.fromCharCode(code);
const ESC = ch(0x1b);

describe('terminalSafe (go-to-k/cdkd#3479)', () => {
  it('keeps newline, tab and every cdkd colour', () => {
    const coloured = [green, yellow, red, cyan, gray, bold, dim].map((f) => f('x')).join(' ');
    expect(terminalSafe(`a\nb\tc ${coloured}`)).toBe(`a\nb\tc ${coloured}`);
  });

  it.each([
    ['NUL', ch(0x00)],
    ['BEL', ch(0x07)],
    ['VT', ch(0x0b)],
    ['FF', ch(0x0c)],
    ['CR', ch(0x0d)],
    ['DEL', ch(0x7f)],
    ['NEL', ch(0x85)],
    ['LS (U+2028)', ch(0x2028)],
    ['PS (U+2029)', ch(0x2029)],
    ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map(
      (c): [string, string] => [`bidi U+${c.toString(16)}`, ch(c)]
    ),
    ['a lone ESC', ESC],
  ])('replaces %s with a space', (_name, c) => {
    expect(terminalSafe(`a${c}b`)).toBe('a b');
  });

  it.each([
    ['a screen clear', `${ESC}[2J`],
    ['cursor movement', `${ESC}[1A${ESC}[2K`],
    ['a non-allowlisted SGR (blink)', `${ESC}[5m`],
    ['a foreign colour reset', `${ESC}[39m`],
    ['a C1 CSI', `${ch(0x9b)}2J`],
    ['an OSC 8 link, BEL-terminated', `${ESC}]8;;http://x${ch(0x07)}`],
    ['an OSC title, ST-terminated', `${ESC}]0;title${ESC}\\`],
  ])('removes %s whole', (_name, seq) => {
    expect(terminalSafe(`a${seq}b`)).toBe('ab');
  });

  it("keeps the rest of the message after an unterminated OSC", () => {
    expect(terminalSafe(`a${ESC}]8;;http://x still cdkd's text`)).toBe(
      "a ]8;;http://x still cdkd's text"
    );
  });
});

describe('safeMsg (go-to-k/cdkd#3479)', () => {
  it("renders the template's own newlines and flattens every value to one line", () => {
    const stack = 'Evil\nDrop the record: cdkd state rm Prod';
    expect(safeMsg`\nDestroying ${stack}:\n  done`).toBe(
      '\nDestroying Evil Drop the record: cdkd state rm Prod:\n  done'
    );
  });

  it('keeps cdkd colours inside a value and renders an absent value empty', () => {
    expect(safeMsg`${green('ok')} ${undefined}|${null}|${0}`).toBe(`${green('ok')} ||0`);
  });
});

describe('ConsoleLogger sink (go-to-k/cdkd#3479)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('strips terminal control from a raw message and keeps its line structure', () => {
    new ConsoleLogger('info', false).info(`Stack: ${`x${ESC}[1A${ESC}[2K`}\nnext`);
    expect(infoSpy).toHaveBeenCalledWith('Stack: x\nnext');
  });
});
