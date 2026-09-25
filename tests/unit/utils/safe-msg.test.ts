import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { safeMsg, terminalSafe } from '../../../src/utils/display-safe.js';
import { green, red } from '../../../src/utils/colors.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';

describe('terminalSafe (go-to-k/cdkd#3479)', () => {
  it('keeps newline, tab and cdkd colours, strips every other control character', () => {
    expect(terminalSafe(`a\nb\tc ${green('ok')} ${red('x')}`)).toBe(
      `a\nb\tc ${green('ok')} ${red('x')}`
    );
    expect(terminalSafe('a\x1b[2Jb\x1b]8;;http://x\x07c\r\u0085\u2028\u202e')).toBe(
      'a [2Jb ]8;;http://x c    '
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
    new ConsoleLogger('info', false).info(`Stack: ${'x\x1b[1A\x1b[2K'}\nnext`);
    expect(infoSpy).toHaveBeenCalledWith('Stack: x [1A [2K\nnext');
  });
});
