import { describe, it, expect, afterEach, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { forwardSigtermToSigint } from '../../../src/utils/interrupt-signals.js';

describe('forwardSigtermToSigint', () => {
  const sigintSpy = vi.fn();
  let unregister: (() => void) | undefined;

  afterEach(() => {
    unregister?.();
    unregister = undefined;
    process.removeListener('SIGINT', sigintSpy);
    sigintSpy.mockReset();
  });

  it('re-emits SIGTERM to the SIGINT listeners', () => {
    process.on('SIGINT', sigintSpy);
    unregister = forwardSigtermToSigint();

    process.emit('SIGTERM', 'SIGTERM');

    expect(sigintSpy).toHaveBeenCalledTimes(1);
  });

  it('forwards repeated SIGTERMs so second-signal force-quit escalation stays with the SIGINT handlers', () => {
    process.on('SIGINT', sigintSpy);
    unregister = forwardSigtermToSigint();

    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGTERM', 'SIGTERM');

    expect(sigintSpy).toHaveBeenCalledTimes(2);
  });

  it('preserves default SIGTERM behavior (exit 143) when no SIGINT listener is active', () => {
    // With zero SIGINT listeners, emitting SIGINT would be a silent no-op and
    // the process would IGNORE the termination request — the forwarder must
    // exit with the conventional 128+15 instead (e.g. SIGTERM during synth,
    // before the engine / destroy-runner registered their handlers).
    const saved = process.rawListeners('SIGINT');
    process.removeAllListeners('SIGINT');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      unregister = forwardSigtermToSigint();
      process.emit('SIGTERM', 'SIGTERM');
      expect(exitSpy).toHaveBeenCalledWith(143);
    } finally {
      exitSpy.mockRestore();
      for (const l of saved) process.on('SIGINT', l as NodeJS.SignalsListener);
    }
  });

  it('unregister removes the SIGTERM listener and stops forwarding', () => {
    const baseline = process.listenerCount('SIGTERM');
    process.on('SIGINT', sigintSpy);
    const un = forwardSigtermToSigint();
    expect(process.listenerCount('SIGTERM')).toBe(baseline + 1);

    un();

    expect(process.listenerCount('SIGTERM')).toBe(baseline);
    process.emit('SIGTERM', 'SIGTERM');
    expect(sigintSpy).not.toHaveBeenCalled();
  });
});

// Source-level wiring pin (issue #1342): each interrupt-sensitive command must
// register the SIGTERM forwarder and unregister it in its outermost `finally`.
// Without this pin a future refactor could silently drop one command from the
// CI-cancellation graceful path (the exact class of gap the issue reported —
// SIGINT handled everywhere, SIGTERM nowhere).
describe('SIGTERM forwarding command wiring (source-level pin)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const files = ['deploy.ts', 'destroy.ts', 'state.ts', 'rollback.ts'];

  it.each(files)('%s registers forwardSigtermToSigint and unregisters it', (file) => {
    const src = readFileSync(join(repoRoot, 'src', 'cli', 'commands', file), 'utf8');
    // Match on LIVE lines only — a commented-out call must fail this pin.
    const liveLines = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(
      liveLines.includes('= forwardSigtermToSigint()'),
      `${file}: forwardSigtermToSigint() registration not found`
    ).toBe(true);
    expect(
      liveLines.includes('unforwardSigterm()'),
      `${file}: unforwardSigterm() cleanup call not found`
    ).toBe(true);
  });

  it('deploy.ts gates each stack start on the interrupt flag (pre-engine interrupt honored)', () => {
    // Without this gate, an interrupt landing before the engine registered
    // its SIGINT handler (during synth / asset publish) only set the flag and
    // the deploy proceeded into lock acquisition + provisioning.
    const src = readFileSync(join(repoRoot, 'src', 'cli', 'commands', 'deploy.ts'), 'utf8');
    const liveLines = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(liveLines.includes('if (deployInterrupted) {')).toBe(true);
    expect(liveLines.includes('Deploy interrupted before stack')).toBe(true);
  });
});
