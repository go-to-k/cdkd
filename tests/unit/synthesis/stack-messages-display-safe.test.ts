import { describe, expect, it, vi } from 'vite-plus/test';
import { processStackMessages } from '../../../src/synthesis/stack-messages.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { StackMessage } from '../../../src/synthesis/stack-messages.js';

/**
 * go-to-k/cdkd#3479: `processStackMessages` printed a CDK annotation's `path`
 * and `message` raw. Under `cdkd deploy -a <dir>` no app runs, so both come out
 * of an assembly someone else may have written. Each field carries its OWN
 * marker, so sanitizing one cannot pass for sanitizing the other.
 */

// eslint-disable-next-line no-control-regex
const FORGING = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function stackWith(messages: StackMessage[]): StackInfo {
  return {
    stackName: 'MyStack',
    displayName: 'MyStack',
    artifactId: 'MyStack',
    template: { Resources: {} },
    dependencyNames: [],
    messages,
  } as StackInfo;
}

function render(messages: StackMessage[]) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  processStackMessages([stackWith(messages)], logger, { ignoreErrors: true });
  return logger;
}

describe('processStackMessages display (go-to-k/cdkd#3479)', () => {
  it.each([
    ['warning', 'warn', 'Warning'],
    ['info', 'info', 'Info'],
    ['error', 'error', 'Error'],
  ] as const)('sanitizes path and message on the %s line', (level, method, label) => {
    const logger = render([
      {
        level,
        // Path marker: a C1 CSI erase plus a LF that would start a forged line.
        path: '/MyStack/P\u009b2K\nPATHFORGED',
        // Message marker: ESC CSI erase + CR, and a U+2028 line terminator.
        message: 'msg\x1b[2K\rMSGFORGED\u2028MSGSEP',
      },
    ]);
    const line = String(logger[method].mock.calls[0]?.[0]);
    expect(line).not.toMatch(FORGING);
    expect(line).not.toContain('\x1b[2K');
    // The path is flattened onto the header line: no LF survives from it.
    expect(line).toBe(`[${label} at /MyStack/P PATHFORGED] msg MSGFORGED MSGSEP`);
  });

  it('keeps a legitimate multi-line annotation byte-identical', () => {
    const message = 'Deprecated API in use:\n  use `fooV2` instead\n\tsee docs';
    const logger = render([{ level: 'warning', path: '/MyStack/My Bucket', message }]);
    expect(logger.warn).toHaveBeenCalledWith(`[Warning at /MyStack/My Bucket] ${message}`);
  });

  it('keeps the message newlines while stripping a forging byte on a continuation line', () => {
    const logger = render([
      { level: 'warning', path: '/MyStack', message: 'first\nsecond\u0085third' },
    ]);
    expect(logger.warn).toHaveBeenCalledWith('[Warning at /MyStack] first\nsecond third');
  });

  it("drops cdkd's own colours from the message, so a continuation line cannot borrow them", () => {
    const logger = render([
      { level: 'warning', path: '/MyStack', message: 'ok\n\x1b[32mDeployment complete\x1b[0m' },
    ]);
    expect(logger.warn).toHaveBeenCalledWith('[Warning at /MyStack] ok\nDeployment complete');
  });

  it("drops cdkd's own colours from the path too", () => {
    const logger = render([
      { level: 'info', path: '/My\x1b[31mStack\x1b[0m', message: 'm' },
    ]);
    expect(logger.info).toHaveBeenCalledWith('[Info at /MyStack] m');
  });

  it('still fails on an error annotation after sanitizing it', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(() =>
      processStackMessages(
        [stackWith([{ level: 'error', path: '/MyStack\u009b', message: 'bad\u0085' }])],
        logger
      )
    ).toThrow('Found errors');
    expect(logger.error).toHaveBeenCalledWith('[Error at /MyStack ] bad ');
  });
});
