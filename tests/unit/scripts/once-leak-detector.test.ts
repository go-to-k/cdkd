import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  beginTest,
  endTest,
  getOnceLeakStats,
  instrumentMock,
  instrumentMockFactories,
  resetOnceLeakStats,
  suspendTracking,
} from '../../once-leak-detector.js';

// A REAL path, and this file's own. These tests drive the detector's internal
// state directly, which is the same state the global hooks use when the run is
// armed (`CDKD_ONCE_LEAK_DETECT=1`, i.e. the once-leak-detect CI job). A test
// here that left a finding undrained would surface under THIS file's name, and
// a fabricated path would then poison `vp run gen:once-leak-allowlist` with an
// entry that the allow-list's own "names only files that exist" guard rejects.
// The `afterEach` below is the belt to this braces.
const FILE = '/repo/tests/unit/scripts/once-leak-detector.test.ts';

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

  afterEach(() => {
    // Drain unconditionally: no test here may hand detector state to the next
    // one, nor to the global hook when the run is armed. See the FILE note.
    endTest();
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
    expect(leaks[0].file).toBe('tests/unit/scripts/once-leak-detector.test.ts');
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
    // Both mocks are NAMED. Unnamed `vi.fn()`s both report the literal
    // 'vi.fn()', so an assertion on the reported name could not tell them
    // apart and would pass even if the finding hardcoded the string.
    const a = instrumentMock(vi.fn()).mockName('mock-a');
    const b = instrumentMock(vi.fn()).mockName('mock-b');

    beginTest(FILE, 'test A');
    a.mockReturnValueOnce(1).mockReturnValueOnce(2);
    b.mockReturnValueOnce(3);
    void b();
    endTest();

    beginTest(FILE, 'test B');
    void a();

    const leaks = endTest();

    expect(leaks).toHaveLength(1);
    expect(leaks[0].mock).toBe('mock-a');
  });

  it('does not report a consumption that happens outside any test', () => {
    // Fences the `currentTest !== null` half of the guard. Without it, a
    // consumption between tests (an `afterAll`, or a floating promise settling
    // after the test ended) dereferences a null `currentTest`.
    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'test A');
    mock.mockReturnValueOnce('primed');
    endTest();

    // No test is running now.
    expect(() => mock()).not.toThrow();

    beginTest(FILE, 'test B');
    expect(endTest()).toEqual([]);
  });

  describe('factory patching', () => {
    // These drive `instrumentMockFactories` — the seam `installOnceLeakDetector`
    // uses — rather than calling `instrumentMock` by hand, so deleting either
    // arm of the patch fails here. Calling `instrumentMock` directly on a spy
    // would NOT catch that: it proves the instrumentation works on a spy
    // product, not that the detector ever applies it to one. The `spyOn` arm
    // had exactly that non-coverage in review.

    /** A `vi`-shaped stand-in wired to the REAL factories. */
    const patchedVi = (): { fn: typeof vi.fn; spyOn: typeof vi.spyOn } => {
      const target = { fn: vi.fn.bind(vi), spyOn: vi.spyOn.bind(vi) };
      instrumentMockFactories(target as never);
      return target as never;
    };

    it('instruments every mock handed out by the patched vi.fn', () => {
      const mock = patchedVi().fn();

      beginTest(FILE, 'test A');
      mock.mockReturnValueOnce('a').mockReturnValueOnce('LEFTOVER');
      void mock();
      endTest();

      beginTest(FILE, 'test B');
      void mock();

      expect(endTest()).toHaveLength(1);
    });

    it('instruments every spy handed out by the patched vi.spyOn', () => {
      const target = { fetch: () => 'real' };
      const spy = patchedVi().spyOn(target, 'fetch');

      beginTest(FILE, 'test A');
      spy.mockReturnValueOnce('a').mockReturnValueOnce('LEFTOVER');
      expect(target.fetch()).toBe('a');
      endTest();

      beginTest(FILE, 'test B');
      expect(target.fetch()).toBe('LEFTOVER');

      expect(endTest()).toHaveLength(1);

      spy.mockRestore();
    });

    it('leaves the patched factories behaving like the originals', () => {
      const patched = patchedVi();
      const mock = patched.fn((a: number) => a * 2);

      expect(mock(21)).toBe(42);

      const target = { fetch: () => 'real' };
      const spy = patched.spyOn(target, 'fetch');

      // `vi.spyOn` calls through to the original unless an implementation is
      // set; the patch must not change that.
      expect(target.fetch()).toBe('real');
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      expect(target.fetch()).toBe('real');
    });
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

  describe('construction fidelity', () => {
    // These three fence DIFFERENT mutations. A plain
    // `function () { this.tagged = true }` probe does NOT: `@vitest/spy`
    // already reaches the wrapper via `Reflect.construct`, so `this` is a
    // correctly-prototyped fresh object either way and the probe passes under
    // both `Reflect.construct` and `.apply`. That version shipped in review as
    // a survivor — a test asserting exactly the property it could not detect.

    it('exposes new.target to the primed implementation', () => {
      const mock = instrumentMock(vi.fn());

      beginTest(FILE, 'test A');
      mock.mockImplementationOnce(function (this: { sawNew?: boolean }) {
        this.sawNew = new.target !== undefined;
      });

      const instance = new (mock as unknown as new () => { sawNew?: boolean })();

      // `.apply` would forward `this` correctly but leave `new.target`
      // undefined, so this is the assertion that discriminates.
      expect(instance.sawNew).toBe(true);
    });

    it('lets a primer that refuses construction still refuse it', () => {
      // `mockResolvedValueOnce`'s own body throws when constructed. That is the
      // case the wrapper's comment cites, and under `.apply` the throw never
      // fires because `new.target` is undefined inside it.
      const mock = instrumentMock(vi.fn());

      beginTest(FILE, 'test A');
      mock.mockResolvedValueOnce('x');

      expect(() => new (mock as unknown as new () => unknown)()).toThrow();
    });

    it('constructs a class implementation as a class', () => {
      const mock = instrumentMock(vi.fn());

      beginTest(FILE, 'test A');
      class Built {
        readonly built = true;
      }
      mock.mockImplementationOnce(Built as never);

      // `.apply` on a class throws "Class constructors cannot be invoked
      // without 'new'", so reaching a populated field at all is the
      // discriminator. Not `toBeInstanceOf(Built)`: `new.target` is the MOCK,
      // so the instance takes the mock's prototype — that is vitest's own
      // behavior and holds with or without this wrapper.
      const instance = new (mock as unknown as new () => Built)();

      expect(instance.built).toBe(true);
    });

    it('still constructs when the primed implementation is an ARROW', () => {
      // Regression test for the review blocker on the PR that added this. The
      // wrapper is a `function` declaration and therefore constructable, so
      // setup.ts's `wrapConstructableImplementation` passes it through
      // unwrapped and never sees the arrow underneath. A bare
      // `Reflect.construct` on that arrow throws "is not a constructor" —
      // meaning `vp run test:once-leak` behaved differently from
      // `vp run test`. `constructImplementation` reapplies the guard.
      const mock = instrumentMock(vi.fn());

      beginTest(FILE, 'test A');
      mock.mockImplementationOnce(() => ({ tag: 'arrow-once' }));

      expect(() => new (mock as unknown as new () => unknown)()).not.toThrow();
    });
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

  it('attributes nothing while tracking is suspended (concurrent tests)', () => {
    // `it.concurrent` interleaves, which a single module-global owner cannot
    // represent, so those tests are opted OUT rather than reported wrongly.
    const mock = instrumentMock(vi.fn());

    beginTest(FILE, 'test A');
    mock.mockReturnValueOnce('a').mockReturnValueOnce('LEFTOVER');
    void mock();
    endTest();

    suspendTracking();
    void mock();

    beginTest(FILE, 'test B');
    expect(endTest()).toEqual([]);
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
