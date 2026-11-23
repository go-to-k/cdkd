import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  registerForceQuitFlush,
  registeredForceQuitFlushCount,
  startForceQuitFlushes,
  trackJournalWrite,
  withForceQuitFlushScope,
} from '../../../src/deployment/force-quit-journal.js';

/**
 * go-to-k/cdkd#6894: the registry a deploy's force-quit writes the rollback
 * journal through.
 */
afterEach(() => {
  // Drain anything a failing case left registered.
  void startForceQuitFlushes().done;
});

describe('force-quit journal registry', () => {
  it('runs every registered flusher once and answers the stack names they recorded', async () => {
    const a = vi.fn(async () => 'StackA');
    const b = vi.fn(async () => undefined); // a nested child: nothing to print
    registerForceQuitFlush(a);
    registerForceQuitFlush(b);

    const started = startForceQuitFlushes();
    expect(started.pending).toBe(2);
    expect(await started.done).toEqual(['StackA']);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();

    // Once: a second force-quit finds nothing left to run.
    const again = startForceQuitFlushes();
    expect(again.pending).toBe(0);
    expect(await again.done).toEqual([]);
    expect(a).toHaveBeenCalledOnce();
  });

  it('never rejects: a throwing or rejecting flusher counts as recording nothing', async () => {
    registerForceQuitFlush(() => {
      throw new Error('sync throw');
    });
    registerForceQuitFlush(async () => {
      throw new Error('rejected');
    });
    registerForceQuitFlush(async () => 'Ok');
    await expect(startForceQuitFlushes().done).resolves.toEqual(['Ok']);
  });

  it('takeOver before a force-quit unregisters and lets the engine journal', async () => {
    const flush = vi.fn(async () => 'S');
    const registration = registerForceQuitFlush(flush);
    await expect(registration.takeOver()).resolves.toBe(true);
    expect(registeredForceQuitFlushCount()).toBe(0);
    const started = startForceQuitFlushes();
    expect(started.pending).toBe(0);
    await started.done;
    expect(flush).not.toHaveBeenCalled();
  });

  it('takeOver after a force-quit started answers false only once the flush settled', async () => {
    let release!: () => void;
    const registration = registerForceQuitFlush(
      () => new Promise((resolve) => (release = () => resolve('S')))
    );
    const started = startForceQuitFlushes();
    // Marked synchronously: the engine reaching its takeover now writes none,
    // and it WAITS for the flush, so its own exit cannot cut the write short.
    let answer: boolean | undefined;
    void registration.takeOver().then((a) => (answer = a));
    await vi.waitFor(() => expect(release).toBeDefined());
    await new Promise((r) => setTimeout(r, 5));
    expect(answer).toBeUndefined();
    release();
    expect(await started.done).toEqual(['S']);
    await vi.waitFor(() => expect(answer).toBe(false));
  });

  it('a force-quit waits for a journal write already in flight, and counts it as pending', async () => {
    let finish!: () => void;
    const write = trackJournalWrite(new Promise<void>((r) => (finish = r)));
    const started = startForceQuitFlushes();
    expect(started.pending).toBe(1);
    let settled = false;
    void started.done.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    finish();
    await write;
    await expect(started.done).resolves.toEqual([]);
    // Settled writes are no longer tracked.
    expect(startForceQuitFlushes().pending).toBe(0);
  });

  it('a rejected tracked write neither leaks nor blocks a force-quit', async () => {
    await expect(trackJournalWrite(Promise.reject(new Error('put failed')))).rejects.toThrow();
    expect(startForceQuitFlushes().pending).toBe(0);
  });

  it('withForceQuitFlushScope removes its registrations when the run settles, a throw included', async () => {
    await expect(
      withForceQuitFlushScope(async (register) => {
        register(async () => 'S');
        expect(registeredForceQuitFlushCount()).toBe(1);
        throw new Error('run failed');
      })
    ).rejects.toThrow('run failed');
    expect(registeredForceQuitFlushCount()).toBe(0);

    await withForceQuitFlushScope(async (register) => {
      register(async () => 'S');
    });
    expect(registeredForceQuitFlushCount()).toBe(0);
  });
});
