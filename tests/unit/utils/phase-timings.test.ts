import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  PHASE_TIMINGS_ENV,
  PhaseClock,
  phaseScopeForStack,
  recordPhase,
  renderPhaseTimings,
  resetPhaseTimings,
  timePhase,
  timePhaseSync,
} from '../../../src/utils/phase-timings.js';

/**
 * The opt-in per-phase timing report (go-to-k/cdkd#5200). Off by default, so
 * the off case is the one every deploy takes: nothing may be recorded and every
 * wrapped function must still run and return its value.
 */
describe('phase timings', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[PHASE_TIMINGS_ENV];
    resetPhaseTimings();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[PHASE_TIMINGS_ENV];
    else process.env[PHASE_TIMINGS_ENV] = saved;
    resetPhaseTimings();
    vi.useRealTimers();
  });

  it('records nothing when the variable is unset, and still runs every wrapped function', async () => {
    delete process.env[PHASE_TIMINGS_ENV];
    const clock = new PhaseClock('run');
    clock.lap('a');
    recordPhase('run', 'b', 5);
    expect(await timePhase('run', 'c', async () => 42)).toBe(42);
    expect(timePhaseSync('run', 'd', () => 'x')).toBe('x');
    expect(renderPhaseTimings()).toEqual([]);
  });

  it('records nothing for a value other than 1', () => {
    process.env[PHASE_TIMINGS_ENV] = 'true';
    recordPhase('run', 'b', 5);
    expect(renderPhaseTimings()).toEqual([]);
  });

  it('splits a sequence into laps that add up to the scope total', () => {
    process.env[PHASE_TIMINGS_ENV] = '1';
    vi.useFakeTimers({ toFake: ['performance'] });
    const clock = new PhaseClock('stack S (us-east-1)');
    vi.advanceTimersByTime(300);
    clock.lap('lock acquire');
    vi.advanceTimersByTime(700);
    clock.lap('diff');
    const lines = renderPhaseTimings();
    expect(lines[1]).toBe('  stack S (us-east-1) (1.00s wall)');
    expect(lines[2]).toMatch(/^ {4}lock acquire\s+300ms {2}30%$/);
    expect(lines[3]).toMatch(/^ {4}diff\s+700ms {2}70%$/);
  });

  it('aggregates a repeated operation into a count, a sum and its slowest occurrence', async () => {
    process.env[PHASE_TIMINGS_ENV] = '1';
    recordPhase('s', 'resource create', 100, 'A AWS::SQS::Queue');
    recordPhase('s', 'resource create', 2500, 'B AWS::Lambda::Function');
    recordPhase('s', 'resource create', 400, 'C AWS::SNS::Topic');
    const lines = renderPhaseTimings();
    expect(lines).toContain(
      '    resource create     3.00s  x3, max 2.50s (B AWS::Lambda::Function)'
    );
  });

  it('records a timed function that throws, and rethrows its error', async () => {
    process.env[PHASE_TIMINGS_ENV] = '1';
    await expect(
      timePhase('s', 'resource delete', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(() =>
      timePhaseSync('s', 'redact', () => {
        throw new Error('sync boom');
      })
    ).toThrow('sync boom');
    const lines = renderPhaseTimings().join('\n');
    expect(lines).toContain('resource delete');
    expect(lines).toContain('redact');
  });

  it('starts the first lap at the process time origin when asked', () => {
    process.env[PHASE_TIMINGS_ENV] = '1';
    vi.useFakeTimers({ toFake: ['performance'], now: 0 });
    vi.advanceTimersByTime(1500);
    new PhaseClock('run', { fromProcessStart: true }).lap('node startup + module load');
    expect(renderPhaseTimings()[2]).toMatch(/node startup \+ module load\s+1\.50s/);
  });

  it('names a stack scope by name and region', () => {
    expect(phaseScopeForStack('Api', 'eu-west-1')).toBe('stack Api (eu-west-1)');
  });
});
