import { describe, it, expect, vi } from 'vite-plus/test';
import { EventEmitter } from 'node:events';
import { installPipeCloseHandler } from '../../../src/cli/pipe-close-handler.js';

// A minimal stand-in for process.stdout/stderr: an EventEmitter we can emit
// 'error' on. installPipeCloseHandler only uses `.on('error', ...)`.
function fakeStream(): NodeJS.WriteStream {
  return new EventEmitter() as unknown as NodeJS.WriteStream;
}

describe('installPipeCloseHandler', () => {
  it('exits 0 when a stream emits EPIPE (downstream closed the pipe)', () => {
    const stream = fakeStream();
    const exit = vi.fn() as unknown as (code: number) => never;
    installPipeCloseHandler([stream], exit);

    const epipe: NodeJS.ErrnoException = Object.assign(new Error('write EPIPE'), {
      code: 'EPIPE',
    });
    // No listener would otherwise throw on 'error'; the handler must catch it.
    stream.emit('error', epipe);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('re-throws a non-EPIPE stream error (a real fault, not a closed pipe)', () => {
    const stream = fakeStream();
    const exit = vi.fn() as unknown as (code: number) => never;
    installPipeCloseHandler([stream], exit);

    const other: NodeJS.ErrnoException = Object.assign(new Error('disk full'), {
      code: 'ENOSPC',
    });
    // EventEmitter invokes listeners synchronously; a throwing 'error' listener
    // propagates to the emit() call site.
    expect(() => stream.emit('error', other)).toThrow('disk full');
    expect(exit).not.toHaveBeenCalled();
  });

  it('installs the handler on every supplied stream', () => {
    const a = fakeStream();
    const b = fakeStream();
    const exit = vi.fn() as unknown as (code: number) => never;
    installPipeCloseHandler([a, b], exit);

    const epipe: NodeJS.ErrnoException = Object.assign(new Error('write EPIPE'), {
      code: 'EPIPE',
    });
    a.emit('error', epipe);
    b.emit('error', epipe);

    expect(exit).toHaveBeenCalledTimes(2);
  });
});
