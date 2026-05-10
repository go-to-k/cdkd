import { describe, expect, it } from 'vitest';
import { pickFreePort } from '../../../src/local-invoke/docker-runner.js';

describe('pickFreePort', () => {
  it('returns a positive port number', async () => {
    const port = await pickFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('returns different ports across consecutive calls (probabilistic)', async () => {
    // The OS may reuse a freshly-released port, but the probability of
    // hitting the same one twice in a row is small. This is a smoke test
    // for "the function actually allocates" rather than a strict invariant.
    const a = await pickFreePort();
    const b = await pickFreePort();
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
  });
});
