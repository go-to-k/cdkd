import { describe, expect, it } from 'vite-plus/test';
import { onShutdownSignals, shutdownSignalExitCode } from '../../../src/utils/shutdown-signals.js';

describe('shutdown-signals (go-to-k/cdkd#6285)', () => {
  it('exits 128 + the signal number', () => {
    expect(shutdownSignalExitCode('SIGINT')).toBe(130);
    expect(shutdownSignalExitCode('SIGTERM')).toBe(143);
  });

  it('hands each signal to the one handler, named, and removes both registrations', () => {
    const seen: string[] = [];
    const intBefore = process.listeners('SIGINT').length;
    const termBefore = process.listeners('SIGTERM').length;
    const remove = onShutdownSignals((signal) => seen.push(signal));
    try {
      const int = process.listeners('SIGINT');
      const term = process.listeners('SIGTERM');
      expect(int.length).toBe(intBefore + 1);
      expect(term.length).toBe(termBefore + 1);
      // Called directly so no other listener in the worker runs.
      (term[term.length - 1] as () => void)();
      (int[int.length - 1] as () => void)();
    } finally {
      remove();
    }
    expect(seen).toEqual(['SIGTERM', 'SIGINT']);
    expect(process.listeners('SIGINT').length).toBe(intBefore);
    expect(process.listeners('SIGTERM').length).toBe(termBefore);
  });
});
