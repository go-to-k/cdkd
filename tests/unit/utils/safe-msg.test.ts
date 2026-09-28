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
    ['a C1 CSI', `${ch(0x9b)}2J`],
  ])('removes %s whole', (_name, seq) => {
    expect(terminalSafe(`a${seq}b`)).toBe('ab');
  });

  it.each([
    ['blink', `${ESC}[5m`],
    ['a foreign colour reset', `${ESC}[39m`],
    ['a bold reset', `${ESC}[22m`],
  ])('turns a non-allowlisted SGR (%s) into a full reset', (_name, seq) => {
    expect(terminalSafe(`a${seq}b`)).toBe(`a${ESC}[0mb`);
  });

  it('closes a coloured CDK-app stderr line whose opener is allowlisted', () => {
    expect(terminalSafe(`${ESC}[33mwarn${ESC}[39m`)).toBe(`${ESC}[33mwarn${ESC}[0m`);
  });

  it('replaces a lone C1 CSI at the end of a message with a space', () => {
    expect(terminalSafe(`a${ch(0x9b)}`)).toBe('a ');
  });

  it('replaces only the ESC of an OSC, even a terminated one', () => {
    expect(terminalSafe(`a${ESC}]8;;http://x${ch(0x07)}b`)).toBe('a ]8;;http://x b');
  });

  it("cannot be made to delete cdkd's text between two raw values", () => {
    const opened = `stackA${ESC}]0;`;
    const closed = `${ch(0x07)}B`;
    expect(terminalSafe(`Deleting ${opened} -- DATA WILL BE LOST -- ${closed}`)).toContain(
      '-- DATA WILL BE LOST --'
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

  it('flattens a TAB inside a value', () => {
    expect(safeMsg`[${'a\tb'}]`).toBe('[a b]');
  });

  it.each([
    ['BEL-terminated', `${ESC}]8;;http://x${ch(0x07)}`],
    ['ST-terminated', `${ESC}]0;title${ESC}\\`],
  ])('removes a %s OSC inside one value whole', (_name, osc) => {
    expect(safeMsg`[${`a${osc}b`}]`).toBe('[ab]');
  });

  it("keeps the rest of a value after an unterminated OSC", () => {
    expect(safeMsg`${`a${ESC}]8;;http://x rest`}`).toBe('a ]8;;http://x rest');
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
