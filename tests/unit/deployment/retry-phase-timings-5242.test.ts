import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { withRetry } from '../../../src/deployment/retry.js';
import { renderPhaseTimings, resetPhaseTimings } from '../../../src/utils/phase-timings.js';

/**
 * go-to-k/cdkd#5242: with `CDKD_PHASE_TIMINGS=1`, every retry `withRetry`
 * makes is counted by the retried error's class (never its message), so a
 * wide deploy's throttling shows up without `--verbose`.
 */
describe('withRetry phase timings (#5242)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['CDKD_PHASE_TIMINGS'];
    resetPhaseTimings();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['CDKD_PHASE_TIMINGS'];
    else process.env['CDKD_PHASE_TIMINGS'] = saved;
    resetPhaseTimings();
  });

  const throttledTwice = () => {
    let calls = 0;
    return vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) {
        throw Object.assign(new Error('Rate exceeded for secret-value-123'), {
          name: 'ThrottlingException',
        });
      }
      return 'ok';
    });
  };

  it('counts each retry under the error class, without the message', async () => {
    process.env['CDKD_PHASE_TIMINGS'] = '1';
    await expect(
      withRetry(throttledTwice(), 'MyQueue', { sleep: () => Promise.resolve() })
    ).resolves.toBe('ok');
    const report = renderPhaseTimings().join('\n');
    expect(report).toMatch(/retry after ThrottlingException\s+\S+\s+x2/);
    expect(report).not.toContain('secret-value-123');
  });

  it('records nothing with the report off', async () => {
    delete process.env['CDKD_PHASE_TIMINGS'];
    await withRetry(throttledTwice(), 'MyQueue', { sleep: () => Promise.resolve() });
    expect(renderPhaseTimings()).toEqual([]);
  });
});
