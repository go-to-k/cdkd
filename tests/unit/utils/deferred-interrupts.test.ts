import { describe, it, expect, afterEach, beforeEach } from 'vite-plus/test';
import { withDeferredInterrupts } from '../../../src/utils/deferred-interrupts.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

// Save and restore any pre-existing SIGINT/SIGTERM listeners around each test
// so a stray listener registered by `withDeferredInterrupts` (on a failure
// mid-test) cannot exit the test process (see interrupt-signals.test.ts).
let savedSigint: NodeJS.SignalsListener[];
let savedSigterm: NodeJS.SignalsListener[];

beforeEach(() => {
  savedSigint = process.rawListeners('SIGINT') as NodeJS.SignalsListener[];
  savedSigterm = process.rawListeners('SIGTERM') as NodeJS.SignalsListener[];
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});

afterEach(() => {
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  for (const l of savedSigint) process.on('SIGINT', l);
  for (const l of savedSigterm) process.on('SIGTERM', l);
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('withDeferredInterrupts', () => {
  it('returns fn`s value and leaves listener counts unchanged when no signal fires', async () => {
    const baselineSigint = process.listenerCount('SIGINT');
    const baselineSigterm = process.listenerCount('SIGTERM');

    const result = await withDeferredInterrupts(async () => 'ok', () => undefined);

    expect(result).toBe('ok');
    expect(process.listenerCount('SIGINT')).toBe(baselineSigint);
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigterm);
  });

  it('lets fn finish its work, calls onDeferred ONCE even on a repeated SIGINT, then rejects INTERRUPTED', async () => {
    const onDeferred: string[] = [];
    let flagSetAfterAwait = false;
    const gate = deferred<void>();

    const run = withDeferredInterrupts(async () => {
      await gate.promise;
      flagSetAfterAwait = true;
      return 'done';
    }, (signal) => onDeferred.push(signal));

    // fn is pending here; emit SIGINT twice before releasing the gate.
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGINT', 'SIGINT');
    gate.resolve();

    const thrown = await run.catch((e: unknown) => e);

    expect(flagSetAfterAwait, 'fn completed its own work despite the signal').toBe(true);
    expect(onDeferred).toEqual(['SIGINT']);
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).code).toBe('INTERRUPTED');
  });

  it('same behavior for SIGTERM', async () => {
    const onDeferred: string[] = [];
    let flagSetAfterAwait = false;
    const gate = deferred<void>();

    const run = withDeferredInterrupts(async () => {
      await gate.promise;
      flagSetAfterAwait = true;
      return 'done';
    }, (signal) => onDeferred.push(signal));

    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGTERM', 'SIGTERM');
    gate.resolve();

    const thrown = await run.catch((e: unknown) => e);

    expect(flagSetAfterAwait).toBe(true);
    expect(onDeferred).toEqual(['SIGTERM']);
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).code).toBe('INTERRUPTED');
  });

  it('fn`s own error wins over a held signal', async () => {
    const gate = deferred<void>();
    const boom = new Error('boom');

    const run = withDeferredInterrupts(async () => {
      await gate.promise;
      throw boom;
    }, () => undefined);

    process.emit('SIGINT', 'SIGINT');
    gate.resolve();

    const thrown = await run.catch((e: unknown) => e);
    expect(thrown).toBe(boom);
  });

  it('removes its listeners even when fn throws', async () => {
    const baselineSigint = process.listenerCount('SIGINT');
    const baselineSigterm = process.listenerCount('SIGTERM');

    await withDeferredInterrupts(async () => {
      throw new Error('boom');
    }, () => undefined).catch(() => undefined);

    expect(process.listenerCount('SIGINT')).toBe(baselineSigint);
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigterm);
  });
});
