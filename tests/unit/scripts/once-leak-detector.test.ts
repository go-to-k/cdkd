import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  beginTest,
  endTest,
  getOnceLeakStats,
  instrumentMock,
  resetOnceLeakStats,
} from '../../once-leak-detector.js';

const FILE = '/repo/tests/unit/x.test.ts';

/**
 * Unit coverage for the runtime `*Once`-leak detector (issue #1618).
 *
 * These tests drive `beginTest` / `endTest` EXPLICITLY rather than relying on
 * the detector's own hooks, because its installation is env-gated
 * (`CDKD_ONCE_LEAK_DETECT=1`) and the default test run — including this one —
 * leaves it off. Simulating the test boundary directly is what lets the
 * cross-test semantics be pinned without arming the global hook for the whole
 * suite.
 */
describe('once-leak detector', () => {
  beforeEach(() => {
    resetOnceLeakStats();
  });

  it('reports nothing when a test consumes its own primed values', () => {
    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'test A');
    mock.mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    void mock();
    void mock();

    expect(endTest()).toEqual([]);
  });

  it('reports nothing when an over-primed value is never consumed', () => {
    // An extra priming that nothing ever reads corrupts no result. Flagging it
    // would be flagging a proxy for the defect rather than the defect.
    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'test A');
    mock.mockResolvedValueOnce('a').mockResolvedValueOnce('leftover');
    void mock();
    expect(endTest()).toEqual([]);

    beginTest(FILE, 'test B');
    expect(endTest()).toEqual([]);
  });

  it('reports when a later test consumes an earlier test\'s primed value', () => {
    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'the leaking test');
    mock.mockReturnValueOnce('a').mockReturnValueOnce('LEFTOVER');
    void mock();
    expect(endTest()).toEqual([]);

    beginTest(FILE, 'the corrupted test');
    // This test believes it is reading its own response; it gets the leftover.
    expect(mock()).toBe('LEFTOVER');

    const leaks = endTest();

    expect(leaks).toHaveLength(1);
    expect(leaks[0].file).toBe('tests/unit/x.test.ts');
    expect(leaks[0].test).toBe('the corrupted test');
    expect(leaks[0].primedBy).toBe('the leaking test');
  });

  it('is NOT fooled by two tests sharing a name', () => {
    // Ownership is object identity, not the name string — otherwise a
    // parameterized suite whose cases share a title would go unprotected.
    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'same name');
    mock.mockReturnValueOnce('a').mockReturnValueOnce('LEFTOVER');
    void mock();
    endTest();

    beginTest(FILE, 'same name');
    void mock();

    expect(endTest()).toHaveLength(1);
  });

  it('does not flag a suite that drains with mockReset in beforeEach', () => {
    // The prescribed remediation. A `mockReset()` between tests discards the
    // queued implementations, so nothing crosses the boundary and nothing is
    // reported. The earlier pending-based design flagged exactly this shape —
    // measured on a real probe suite, which is why the design changed.
    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'test A');
    mock.mockReturnValueOnce(1).mockReturnValueOnce(2);
    void mock();
    endTest();

    mock.mockReset();

    beginTest(FILE, 'test B');
    mock.mockReturnValueOnce(9);
    expect(mock()).toBe(9);

    expect(endTest()).toEqual([]);
  });

  it('does not flag a value primed outside any test', () => {
    // `beforeAll` / `afterAll` priming has no owning test, so it crosses no
    // boundary and there is nobody to blame.
    const mock = instrumentMock(vi.fn());

    mock.mockReturnValueOnce('from beforeAll');

    beginTest(FILE, 'test A');
    expect(mock()).toBe('from beforeAll');

    expect(endTest()).toEqual([]);
  });

  it('counts every *Once spelling, not just mockResolvedValueOnce', async () => {
    // All five funnel through `mockImplementationOnce` in @vitest/spy, which is
    // the single method the detector instruments. A regression that stopped
    // covering one of them would make this suite red rather than silently
    // narrowing what the CI job protects.
    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'primer');
    mock
      .mockImplementationOnce(() => 'impl')
      .mockReturnValueOnce('return')
      .mockResolvedValueOnce('resolved')
      .mockRejectedValueOnce(new Error('boom'))
      .mockThrowOnce(new Error('bang'));
    endTest();

    beginTest(FILE, 'consumer');
    expect(mock()).toBe('impl');
    expect(mock()).toBe('return');
    await expect(mock()).resolves.toBe('resolved');
    await expect(mock()).rejects.toThrow('boom');
    expect(() => mock()).toThrow('bang');

    expect(endTest()).toHaveLength(5);
  });

  it('counts a consumed rejection as consumed', async () => {
    // The queue is shifted BEFORE the implementation runs, so a throwing or
    // rejecting primer has still consumed its slot. Treating only clean returns
    // as consumption would leave a stale owner attached to an already-drained
    // slot.
    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'test A');
    mock.mockRejectedValueOnce(new Error('boom'));
    await expect(mock()).rejects.toThrow('boom');
    expect(endTest()).toEqual([]);

    expect(getOnceLeakStats().consumptions).toBe(1);
  });

  it('tracks each mock separately', () => {
    const a = instrumentMock(vi.fn());
    const b = instrumentMock(vi.fn());

    beginTest(FILE, 'test A');
    a.mockReturnValueOnce(1).mockReturnValueOnce(2);
    b.mockReturnValueOnce(3);
    void b();
    endTest();

    beginTest(FILE, 'test B');
    void a();

    const leaks = endTest();

    expect(leaks).toHaveLength(1);
    expect(leaks[0].mock).toBe(a.getMockName());
  });

  it('is idempotent, so a re-instrumented mock does not double-count', () => {
    const mock = instrumentMock(vi.fn());
    instrumentMock(mock);

    beginTest(FILE, 'test A');
    mock.mockReturnValueOnce(1);
    endTest();

    beginTest(FILE, 'test B');
    void mock();

    expect(endTest()).toHaveLength(1);
    expect(getOnceLeakStats().mocksInstrumented).toBe(1);
  });

  it('preserves new.target so constructor mocks keep working', () => {
    // The wrapper forwards construction through `Reflect.construct`. An
    // `.apply` would swallow `new.target`, silently breaking every mock that is
    // invoked with `new` — and the primers' own bodies branch on it too.
    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'test A');
    mock.mockImplementationOnce(function (this: { tagged?: boolean }) {
      this.tagged = true;
    });

    const instance = new (mock as unknown as new () => { tagged?: boolean })();

    expect(instance.tagged).toBe(true);
    expect(endTest()).toEqual([]);
  });

  it('passes arguments and `this` through to the primed implementation', () => {
    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'test A');
    mock.mockImplementationOnce((a: number, b: number) => a + b);

    expect(mock(2, 3)).toBe(5);
  });

  it('leaves a non-mock value untouched', () => {
    expect(instrumentMock(undefined)).toBeUndefined();
    expect(instrumentMock({ notAMock: true })).toEqual({ notAMock: true });
  });

  it('counts what it instrumented, so a dead hook cannot pass vacuously', () => {
    // Coverage floor, per the "a checker must prove it sees its input" rule in
    // .claude/rules/testing.md: an instrumentation that silently stopped
    // wrapping would report zero leaks forever and look identical to a clean
    // tree.
    resetOnceLeakStats();

    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'test A');
    mock.mockReturnValueOnce('a').mockReturnValueOnce('b');
    void mock();
    endTest();

    beginTest(FILE, 'test B');
    void mock();
    endTest();

    const stats = getOnceLeakStats();

    expect(stats.mocksInstrumented).toBe(1);
    expect(stats.primings).toBe(2);
    expect(stats.consumptions).toBe(2);
    expect(stats.crossTestConsumptions).toBe(1);
  });
});
