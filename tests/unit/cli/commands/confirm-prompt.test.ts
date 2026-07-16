/**
 * Unit tests for the default-YES `promptYesNo` helper backing the issue
 * #1007 asset-storage auto-create prompt. Pins the `[Y/n]` semantics:
 * empty input / `y` / `yes` (any case) accept, everything else declines,
 * and the readline interface is closed on every path.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const readlineQuestion = vi.fn();
const readlineClose = vi.fn();
vi.mock('node:readline/promises', () => ({
  default: {
    createInterface: () => ({ question: readlineQuestion, close: readlineClose }),
  },
}));

const { promptYesNo } = await import('../../../../src/cli/commands/confirm-prompt.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('promptYesNo', () => {
  it.each([
    ['', true],
    ['y', true],
    ['Y', true],
    ['yes', true],
    ['YES', true],
    ['  y  ', true],
    ['n', false],
    ['no', false],
    ['nope', false],
    ['yess', false],
  ])('input %j -> %s', async (input, expected) => {
    readlineQuestion.mockResolvedValue(input);
    await expect(promptYesNo('Create it?')).resolves.toBe(expected);
    expect(readlineClose).toHaveBeenCalledTimes(1);
  });

  it('renders the [Y/n] default-yes suffix', async () => {
    readlineQuestion.mockResolvedValue('');
    await promptYesNo('Create it?');
    expect(readlineQuestion).toHaveBeenCalledWith('Create it? [Y/n] ');
  });

  it('closes the interface even when question rejects', async () => {
    readlineQuestion.mockRejectedValue(new Error('stdin closed'));
    await expect(promptYesNo('Create it?')).rejects.toThrow('stdin closed');
    expect(readlineClose).toHaveBeenCalledTimes(1);
  });
});
