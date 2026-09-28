import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

import { AsyncLocalStorage } from 'node:async_hooks';

const mockCloudFormationSend = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerDebug = vi.fn();
// Stands in for `runWithStackAwsClients`: a scope's own CloudFormation client.
const clientScope = new AsyncLocalStorage<{ send: (...args: unknown[]) => unknown }>();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: clientScope.getStore() ?? { send: mockCloudFormationSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      debug: mockLoggerDebug,
      info: vi.fn(),
      warn: mockLoggerWarn,
      error: vi.fn(),
    }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  getCreateOnlyPropertyPaths,
  prefetchCreateOnlyPropertyPaths,
  templateResourceTypes,
  createOnlyChangeRequiresReplacement,
  clearCreateOnlyPropertiesCache,
} from '../../../src/provisioning/create-only-properties.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';
import {
  DESCRIBE_TYPE_MAX_IN_FLIGHT,
  describeTypeQueueDepth,
  describeTypeRetryDelays,
  describeTypeWithThrottleRetry,
} from '../../../src/provisioning/describe-type.js';

/** A type cdkd holds no schema snapshot for. */
const UNSNAPSHOTTED = 'AWS::NoSnapshot::Type';

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function schemaResponse(createOnlyProperties: string[]): { Schema: string } {
  return { Schema: JSON.stringify({ createOnlyProperties }) };
}

describe('getCreateOnlyPropertyPaths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCreateOnlyPropertiesCache();
  });

  it('extracts createOnly property paths from the registry schema', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(
      schemaResponse([
        '/properties/PerformanceMode',
        '/properties/Encrypted',
        '/properties/KmsKeyId',
      ])
    );

    const result = await getCreateOnlyPropertyPaths('AWS::EFS::FileSystem');

    expect(result.map((p) => p.join('.')).sort()).toEqual([
      'Encrypted',
      'KmsKeyId',
      'PerformanceMode',
    ]);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('keeps the FULL segment path for nested createOnly JSON pointers (issue #960)', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(
      schemaResponse(['/properties/Foo/Bar', '/properties/Baz'])
    );

    const result = await getCreateOnlyPropertyPaths('AWS::Some::Type');

    expect(result.map((p) => p.join('.')).sort()).toEqual(['Baz', 'Foo.Bar']);
  });

  it('unescapes RFC 6901 JSON-pointer segments (~1 -> /, ~0 -> ~) in the property name', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(
      schemaResponse(['/properties/Foo~1Bar', '/properties/Tilde~0Name'])
    );

    const result = await getCreateOnlyPropertyPaths('AWS::Some::Type');

    expect(result.map((p) => p.join('.')).sort()).toEqual(['Foo/Bar', 'Tilde~Name']);
  });

  it('caches SUCCESSFUL lookups per type (one DescribeType for repeated calls)', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(schemaResponse(['/properties/Engine']));

    const a = await getCreateOnlyPropertyPaths('AWS::ElastiCache::CacheCluster');
    const b = await getCreateOnlyPropertyPaths('AWS::ElastiCache::CacheCluster');

    expect(a).toBe(b); // same cached promise result
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('a Schema-less response is a successful "no createOnly props" lookup (no warning)', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({});

    const result = await getCreateOnlyPropertyPaths('AWS::Private::Type');

    expect(result.length).toBe(0);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('degrades gracefully on DescribeType failure for a type with NO snapshot (empty list + warning, NOT cached)', async () => {
    expect(CREATE_ONLY_PATHS_SNAPSHOT.has(UNSNAPSHOTTED)).toBe(false);
    mockCloudFormationSend
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockResolvedValueOnce(schemaResponse(['/properties/ProtocolType']));

    const first = await getCreateOnlyPropertyPaths(UNSNAPSHOTTED);
    expect(first.length).toBe(0); // graceful fallback
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn.mock.calls[0]![0]).toContain('registry-only replacement classification');

    // The failure was NOT cached — a later call retries DescribeType and succeeds.
    const second = await getCreateOnlyPropertyPaths(UNSNAPSHOTTED);
    expect(second.map((p) => p.join('.'))).toEqual(['ProtocolType']);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(2);
  });

  it('Custom::* types skip DescribeType entirely — no API call, no warning (issue #1016)', async () => {
    const result = await getCreateOnlyPropertyPaths('Custom::AWSCDKOpenIdConnectProvider');

    expect(result.length).toBe(0);
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('AWS::CloudFormation::CustomResource skips DescribeType entirely (issue #1016)', async () => {
    const result = await getCreateOnlyPropertyPaths('AWS::CloudFormation::CustomResource');

    expect(result.length).toBe(0);
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('AWS::CDK::Metadata skips DescribeType entirely — no API call, no misleading warning', async () => {
    // The CDK construct-tree sentinel every synthesized template carries. It
    // has no registry schema, so the lookup could only ever fail and emit a
    // "Grant cloudformation:DescribeType ..." warning naming a pseudo-resource
    // the user cannot act on.
    const result = await getCreateOnlyPropertyPaths('AWS::CDK::Metadata');

    expect(result.length).toBe(0);
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});

describe('getCreateOnlyPropertyPaths — committed-snapshot fallback on FAILURE only (issue #3718)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCreateOnlyPropertiesCache();
  });

  it('a failed live lookup resolves the snapshot paths and warns that it fell back to them', async () => {
    const snapshot = CREATE_ONLY_PATHS_SNAPSHOT.get('AWS::SQS::Queue');
    expect(snapshot?.length).toBeGreaterThan(0);
    mockCloudFormationSend.mockRejectedValueOnce(new Error('AccessDenied'));

    const result = await getCreateOnlyPropertyPaths('AWS::SQS::Queue');

    expect(result).toEqual(snapshot);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const warning = mockLoggerWarn.mock.calls[0]![0] as string;
    expect(warning).toContain("cdkd's bundled schema snapshot");
    expect(warning).toContain('AccessDenied');
    expect(warning).not.toContain('registry-only');
  });

  it('a nested snapshot path survives the fallback (full paths, not top-level names)', async () => {
    // Pick any snapshot type carrying a NESTED path, so the fallback is shown
    // to serve the granularity the live parse does.
    const nested = [...CREATE_ONLY_PATHS_SNAPSHOT].find(([, paths]) =>
      paths.some((p) => p.length > 1)
    );
    expect(nested, 'no snapshot type carries a nested create-only path').toBeDefined();
    const [type, paths] = nested!;
    mockCloudFormationSend.mockRejectedValueOnce(new Error('AccessDenied'));

    expect(await getCreateOnlyPropertyPaths(type)).toEqual(paths);
  });

  it('a successful live lookup wins over the snapshot', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(schemaResponse(['/properties/OnlyLive']));

    const result = await getCreateOnlyPropertyPaths('AWS::SQS::Queue');

    expect(result.map((p) => p.join('.'))).toEqual(['OnlyLive']);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('the fallback is NOT cached as a success: the next call retries live and takes its answer', async () => {
    mockCloudFormationSend
      .mockRejectedValueOnce(new Error('Rate exceeded'))
      .mockResolvedValueOnce(schemaResponse(['/properties/OnlyLive']));

    const first = await getCreateOnlyPropertyPaths('AWS::SQS::Queue');
    expect(first).toEqual(CREATE_ONLY_PATHS_SNAPSHOT.get('AWS::SQS::Queue'));

    const second = await getCreateOnlyPropertyPaths('AWS::SQS::Queue');
    expect(second.map((p) => p.join('.'))).toEqual(['OnlyLive']);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(2);
  });

  it('an unparseable live Schema is a failure, and falls back too', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: '{not json' });

    expect(await getCreateOnlyPropertyPaths('AWS::SQS::Queue')).toEqual(
      CREATE_ONLY_PATHS_SNAPSHOT.get('AWS::SQS::Queue')
    );
  });
});

/** A send() the test settles by hand, recording the order types were sent in. */
function deferredSends(): {
  sent: string[];
  release: (type: string) => void;
  releaseAll: () => Promise<void>;
} {
  const sent: string[] = [];
  const pending = new Map<string, () => void>();
  mockCloudFormationSend.mockImplementation(
    (command: { input: { TypeName: string } }) =>
      new Promise((resolve) => {
        const type = command.input.TypeName;
        sent.push(type);
        pending.set(type, () => resolve(schemaResponse([`/properties/${type.split('::')[2]}`])));
      })
  );
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return {
    sent,
    release: (type) => {
      pending.get(type)!();
      pending.delete(type);
    },
    releaseAll: async () => {
      // Released slots start queued calls, which register new pending sends.
      for (let round = 0; round < 50 && pending.size > 0; round++) {
        for (const [type, resolve] of [...pending]) {
          pending.delete(type);
          resolve();
        }
        await flush();
      }
    },
  };
}

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('the DescribeType concurrency cap (issue #3718)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudFormationSend.mockReset();
    clearCreateOnlyPropertiesCache();
  });

  const types = (n: number, prefix = 'P'): string[] =>
    Array.from({ length: n }, (_, i) => `AWS::Test::${prefix}${i}`);

  it('a prefetch never has more than the cap in flight, and every type still resolves', async () => {
    const sends = deferredSends();
    const all = types(DESCRIBE_TYPE_MAX_IN_FLIGHT + 15);
    prefetchCreateOnlyPropertyPaths(all);
    await flushMicrotasks();
    expect(sends.sent).toHaveLength(DESCRIBE_TYPE_MAX_IN_FLIGHT);

    await sends.releaseAll();
    expect(new Set(sends.sent)).toEqual(new Set(all));
    // Each type was sent ONCE and is now a cache hit.
    expect(sends.sent).toHaveLength(all.length);
    const results = await Promise.all(all.map((t) => getCreateOnlyPropertyPaths(t)));
    expect(results.map((r) => r[0]![0])).toEqual(all.map((t) => t.split('::')[2]));
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(all.length);
  });

  it('failed lookups release their slot, so the queue behind them still drains', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));
    const all = types(DESCRIBE_TYPE_MAX_IN_FLIGHT * 2 + 3, 'F');
    const results = await Promise.all(all.map((t) => getCreateOnlyPropertyPaths(t)));
    expect(results.every((r) => r.length === 0)).toBe(true);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(all.length);
  });

  it('an awaited lookup of a type the prefetch already QUEUED shares that call and jumps the queue', async () => {
    const sends = deferredSends();
    const all = types(DESCRIBE_TYPE_MAX_IN_FLIGHT + 10);
    prefetchCreateOnlyPropertyPaths(all);
    await flushMicrotasks();
    const last = all[all.length - 1]!;
    expect(sends.sent).not.toContain(last);

    const awaited = getCreateOnlyPropertyPaths(last);
    // Freeing ONE slot must start the awaited type, not the next prefetch in line.
    sends.release(all[0]!);
    await flushMicrotasks();
    expect(sends.sent[DESCRIBE_TYPE_MAX_IN_FLIGHT]).toBe(last);

    sends.release(last);
    expect((await awaited).map((p) => p.join('.'))).toEqual([last.split('::')[2]]);
    await sends.releaseAll();
    // One DescribeType for that type, not a second one for the awaited caller.
    expect(sends.sent.filter((t) => t === last)).toHaveLength(1);
  });

  it('an awaited lookup of a type NOT prefetched still runs ahead of the queued prefetches', async () => {
    const sends = deferredSends();
    prefetchCreateOnlyPropertyPaths(types(DESCRIBE_TYPE_MAX_IN_FLIGHT + 10));
    await flushMicrotasks();

    const awaited = getCreateOnlyPropertyPaths('AWS::Test::Urgent');
    sends.release('AWS::Test::P0');
    await flushMicrotasks();
    expect(sends.sent[DESCRIBE_TYPE_MAX_IN_FLIGHT]).toBe('AWS::Test::Urgent');

    sends.release('AWS::Test::Urgent');
    await awaited;
    await sends.releaseAll();
  });

  it('a prefetch whose lookups all fail leaves no unhandled rejection', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      prefetchCreateOnlyPropertyPaths(types(5, 'U'));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('the prefetch skips schema-less types and duplicates', async () => {
    mockCloudFormationSend.mockResolvedValue({});
    prefetchCreateOnlyPropertyPaths([
      'AWS::Test::Dup',
      'AWS::Test::Dup',
      'AWS::CDK::Metadata',
      'Custom::Thing',
      'AWS::CloudFormation::CustomResource',
    ]);
    await flushMicrotasks();
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });
});

describe('cancelling a prefetch (issue #3718)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudFormationSend.mockReset();
    clearCreateOnlyPropertiesCache();
  });

  const types = (n: number, prefix: string): string[] =>
    Array.from({ length: n }, (_, i) => `AWS::Test::${prefix}${i}`);

  it('aborts the running background calls and drops the queued ones — no cache, no warning', async () => {
    const signals: AbortSignal[] = [];
    mockCloudFormationSend.mockImplementation(
      (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
        signals.push(options!.abortSignal!);
        return new Promise(() => {}); // never answers: only the abort ends it
      }
    );
    const all = types(DESCRIBE_TYPE_MAX_IN_FLIGHT + 5, 'C');
    const prefetch = prefetchCreateOnlyPropertyPaths(all);
    await flushMicrotasks();
    expect(signals).toHaveLength(DESCRIBE_TYPE_MAX_IN_FLIGHT);

    prefetch.cancel();
    await flushMicrotasks();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    // The queued five were dropped, never sent.
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(DESCRIBE_TYPE_MAX_IN_FLIGHT);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(
      mockLoggerDebug.mock.calls.some(([line]) => String(line).includes('Failed to resolve'))
    ).toBe(false);

    // Nothing cached: a later lookup starts a fresh call and takes its answer.
    mockCloudFormationSend.mockReset();
    mockCloudFormationSend.mockResolvedValue(schemaResponse(['/properties/Fresh']));
    expect((await getCreateOnlyPropertyPaths(all[0]!)).map((p) => p.join('.'))).toEqual(['Fresh']);
    expect((await getCreateOnlyPropertyPaths(all[all.length - 1]!)).map((p) => p.join('.'))).toEqual(
      ['Fresh']
    );
  });

  it('never withdraws a call an awaited lookup joined — running or queued', async () => {
    const sends = deferredSends();
    const all = types(DESCRIBE_TYPE_MAX_IN_FLIGHT + 5, 'K');
    const prefetch = prefetchCreateOnlyPropertyPaths(all);
    await flushMicrotasks();
    const running = all[0]!;
    const queued = all[all.length - 1]!;
    const awaitedRunning = getCreateOnlyPropertyPaths(running);
    const awaitedQueued = getCreateOnlyPropertyPaths(queued);

    prefetch.cancel();
    sends.release(running);
    expect((await awaitedRunning).map((p) => p.join('.'))).toEqual([running.split('::')[2]]);
    await flushMicrotasks();
    // The promoted queued call took the freed slot and still answers.
    expect(sends.sent).toContain(queued);
    sends.release(queued);
    expect((await awaitedQueued).map((p) => p.join('.'))).toEqual([queued.split('::')[2]]);
    await sends.releaseAll();
  });

  it("cancelling one prefetch leaves another prefetch's calls alone", async () => {
    const signals = new Map<string, AbortSignal>();
    const sends = deferredSends();
    const deferred = mockCloudFormationSend.getMockImplementation()!;
    mockCloudFormationSend.mockImplementation(
      (command: { input: { TypeName: string } }, options?: { abortSignal?: AbortSignal }) => {
        signals.set(command.input.TypeName, options!.abortSignal!);
        return deferred(command);
      }
    );
    const child = prefetchCreateOnlyPropertyPaths(['AWS::Test::ChildOnly']);
    // The parent names ChildOnly too, but the child already started it, so
    // the parent does not own that call.
    const parent = prefetchCreateOnlyPropertyPaths(['AWS::Test::ParentOnly', 'AWS::Test::ChildOnly']);
    await flushMicrotasks();

    parent.cancel();
    expect(signals.get('AWS::Test::ParentOnly')!.aborted).toBe(true);
    expect(signals.get('AWS::Test::ChildOnly')!.aborted).toBe(false);
    const childAnswer = getCreateOnlyPropertyPaths('AWS::Test::ChildOnly');
    sends.release('AWS::Test::ChildOnly');
    expect((await childAnswer).map((p) => p.join('.'))).toEqual(['ChildOnly']);
    // Joined the child's call rather than issuing a second one.
    expect(sends.sent.filter((t) => t === 'AWS::Test::ChildOnly')).toHaveLength(1);
    child.cancel();
    await sends.releaseAll();
  });

  it("an URGENT lookup's throttle backoff sleeps on a REF'd timer — the command is waiting on it", async () => {
    mockCloudFormationSend
      .mockRejectedValueOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .mockResolvedValueOnce(schemaResponse(['/properties/X']));
    const timers: NodeJS.Timeout[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      const timer = realSetTimeout(fn, ms === 1000 ? 1 : ms);
      if (ms === 1000) timers.push(timer);
      return timer;
    }) as typeof setTimeout);
    try {
      expect(describeTypeRetryDelays.sleep).toBeUndefined();
      const result = await getCreateOnlyPropertyPaths('AWS::Test::UrgentBackoff');
      expect(result.map((p) => p.join('.'))).toEqual(['X']);
      expect(timers, 'the urgent backoff never started').toHaveLength(1);
      expect(timers[0]!.hasRef()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a background call in a throttle backoff holds no ref\'d timer, and a cancel ends it at once', async () => {
    mockCloudFormationSend.mockRejectedValue(
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
    );
    const timers: NodeJS.Timeout[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      const timer = realSetTimeout(fn, ms);
      if (ms === 1000) timers.push(timer); // the first backoff step
      return timer;
    }) as typeof setTimeout);
    try {
      const prefetch = prefetchCreateOnlyPropertyPaths(['AWS::Test::Throttled']);
      for (let i = 0; i < 20 && timers.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(timers, 'the backoff sleep never started').toHaveLength(1);
      // Unref'd: a pending retry cannot keep a finished command's process alive.
      expect(timers[0]!.hasRef()).toBe(false);

      const started = Date.now();
      prefetch.cancel();
      // A fresh lookup is not blocked behind the cancelled one.
      mockCloudFormationSend.mockReset();
      mockCloudFormationSend.mockResolvedValue(schemaResponse(['/properties/Fresh']));
      const fresh = await getCreateOnlyPropertyPaths('AWS::Test::Throttled');
      expect(fresh.map((p) => p.join('.'))).toEqual(['Fresh']);
      expect(Date.now() - started).toBeLessThan(500);
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('an URGENT lookup is sent exactly as before — no abort signal, no unref\'d sleep', async () => {
    mockCloudFormationSend.mockResolvedValue(schemaResponse(['/properties/X']));
    await getCreateOnlyPropertyPaths('AWS::Test::UrgentShape');
    expect(mockCloudFormationSend.mock.calls[0]).toHaveLength(1);
  });
});

describe('a PROMOTED prefetch call backs off on a REF\'d timer (issue #3939)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudFormationSend.mockReset();
    clearCreateOnlyPropertiesCache();
  });

  const throttle = (): Error =>
    Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });

  /**
   * Hold every DescribeType backoff-step timer (`withRetry` sleeps in steps of
   * at most 1 s, all from `backoffSleep`) instead of letting it fire: each is a
   * real timer, so its ref state is the production one, but set 60 s out, and
   * `fire()` runs the pending ones by hand, recording whether each was ref'd at
   * that moment. Timers from anywhere else pass straight through, and nothing
   * depends on wall-clock timing.
   */
  function holdBackoffTimers(): {
    timers: NodeJS.Timeout[];
    refAtFire: boolean[];
    fire: () => void;
    drive: <T>(promise: Promise<T>) => Promise<T>;
    restore: () => void;
  } {
    const timers: NodeJS.Timeout[] = [];
    const refAtFire: boolean[] = [];
    const pending = new Map<NodeJS.Timeout, () => void>();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      if (!new Error().stack?.includes('backoffSleep')) return realSetTimeout(fn, ms);
      const timer = realSetTimeout(fn, 60_000);
      timers.push(timer);
      pending.set(timer, fn);
      return timer;
    }) as typeof setTimeout);
    const fire = (): void => {
      for (const [timer, fn] of [...pending]) {
        pending.delete(timer);
        refAtFire.push(timer.hasRef());
        clearTimeout(timer);
        fn();
      }
    };
    const drive = async <T>(promise: Promise<T>): Promise<T> => {
      let done = false;
      promise.then(
        () => (done = true),
        () => (done = true)
      );
      for (let i = 0; i < 200 && !done; i++) {
        fire();
        await new Promise((resolve) => setImmediate(resolve));
      }
      return promise;
    };
    const restore = (): void => {
      for (const timer of pending.keys()) clearTimeout(timer);
      pending.clear();
      spy.mockRestore();
    };
    return { timers, refAtFire, fire, drive, restore };
  }

  const settle = async (until: () => boolean): Promise<void> => {
    for (let i = 0; i < 50 && !until(); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  it('promoted MID-backoff: the live timer is ref\'d at once, and every later one is too', async () => {
    mockCloudFormationSend
      .mockRejectedValueOnce(throttle())
      .mockRejectedValueOnce(throttle())
      .mockResolvedValueOnce(schemaResponse(['/properties/X']));
    const held = holdBackoffTimers();
    const prefetch = prefetchCreateOnlyPropertyPaths(['AWS::Test::MidBackoff']);
    let awaited: Promise<ReadonlyArray<readonly string[]>> | undefined;
    try {
      await settle(() => held.timers.length > 0);
      expect(held.timers, 'the background backoff never started').toHaveLength(1);
      // Nobody awaits it yet: it must not hold the process open.
      expect(held.timers[0]!.hasRef()).toBe(false);

      awaited = getCreateOnlyPropertyPaths('AWS::Test::MidBackoff');
      // The command now waits on this very sleep; an unref'd one lets the
      // event loop drain under it and the process exit 0 mid-command.
      expect(held.timers[0]!.hasRef(), 'the live backoff timer stayed unref\'d').toBe(true);

      expect((await held.drive(awaited)).map((p) => p.join('.'))).toEqual(['X']);
      // The first step plus the second throttle's 2 s backoff (two 1 s steps).
      expect(held.refAtFire).toEqual([true, true, true]);
    } finally {
      prefetch.cancel();
      // A promoted call cannot be cancelled: let it finish, so a failure here
      // does not leave it holding a slot the next case counts.
      if (awaited) await held.drive(awaited);
      held.restore();
    }
  });

  it('promoted while QUEUED: its backoff, once it runs, is ref\'d', async () => {
    const queued = 'AWS::Test::QueuedThenPromoted';
    let queuedSends = 0;
    mockCloudFormationSend.mockImplementation(
      (command: { input: { TypeName: string } }, options?: { abortSignal?: AbortSignal }) => {
        if (command.input.TypeName !== queued) {
          // Holds its slot until the prefetch withdraws it.
          return new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        queuedSends++;
        return queuedSends === 1
          ? Promise.reject(throttle())
          : Promise.resolve(schemaResponse(['/properties/Q']));
      }
    );
    const held = holdBackoffTimers();
    const fillers = Array.from(
      { length: DESCRIBE_TYPE_MAX_IN_FLIGHT },
      (_, i) => `AWS::Test::Filler${i}`
    );
    const prefetch = prefetchCreateOnlyPropertyPaths([...fillers, queued]);
    try {
      await flushMicrotasks();
      expect(describeTypeQueueDepth().pending, 'the type never queued').toBe(1);

      const awaited = getCreateOnlyPropertyPaths(queued);
      // Withdrawing the fillers frees the slots the promoted call runs in.
      prefetch.cancel();
      expect((await held.drive(awaited)).map((p) => p.join('.'))).toEqual(['Q']);
      expect(held.refAtFire, 'a promoted call backed off on an unref\'d timer').toEqual([true]);
    } finally {
      prefetch.cancel();
      held.restore();
    }
  });

  it('an awaited call QUEUED behind a full limiter of backoffs refs every one of them', async () => {
    // Every slot is held by a background call asleep in its backoff, and the
    // command awaits a type the prefetch queued behind them: that call cannot
    // start until one of those sleeps ends, so the command is waiting on all
    // of them. Unref'd, the loop drained and the process exited 0.
    const throttledOnce = new Set<string>();
    mockCloudFormationSend.mockImplementation((command: { input: { TypeName: string } }) => {
      const type = command.input.TypeName;
      if (throttledOnce.has(type)) return Promise.resolve(schemaResponse(['/properties/Name']));
      throttledOnce.add(type);
      return Promise.reject(throttle());
    });
    const held = holdBackoffTimers();
    const all = Array.from({ length: DESCRIBE_TYPE_MAX_IN_FLIGHT + 1 }, (_, i) => `AWS::Test::Q${i}`);
    const prefetch = prefetchCreateOnlyPropertyPaths(all);
    let awaited: Promise<ReadonlyArray<readonly string[]>> | undefined;
    try {
      await settle(() => held.timers.length >= DESCRIBE_TYPE_MAX_IN_FLIGHT);
      expect(held.timers).toHaveLength(DESCRIBE_TYPE_MAX_IN_FLIGHT);
      expect(describeTypeQueueDepth().pending).toBe(1);
      expect(held.timers.filter((t) => t.hasRef())).toHaveLength(0);

      awaited = getCreateOnlyPropertyPaths(all[DESCRIBE_TYPE_MAX_IN_FLIGHT]!);
      expect(
        held.timers.filter((t) => !t.hasRef()),
        'a running backoff the awaited call is queued behind stayed unref\'d'
      ).toHaveLength(0);
      expect((await held.drive(awaited)).map((p) => p.join('.'))).toEqual(['Name']);
    } finally {
      prefetch.cancel();
      if (awaited) await held.drive(awaited);
      held.restore();
    }
  });

  it('promoting ONE call leaves another background call\'s live backoff unref\'d', async () => {
    let answerAwaited!: () => void;
    mockCloudFormationSend.mockImplementation((command: { input: { TypeName: string } }) =>
      command.input.TypeName === 'AWS::Test::Awaited'
        ? new Promise((resolve) => {
            answerAwaited = () => resolve(schemaResponse(['/properties/A']));
          })
        : Promise.reject(throttle())
    );
    const held = holdBackoffTimers();
    const prefetch = prefetchCreateOnlyPropertyPaths(['AWS::Test::Awaited', 'AWS::Test::Left']);
    try {
      // `Left` is asleep in its backoff BEFORE the other call is promoted.
      await settle(() => held.timers.length > 0);
      expect(held.timers).toHaveLength(1);
      expect(held.timers[0]!.hasRef()).toBe(false);

      const awaited = getCreateOnlyPropertyPaths('AWS::Test::Awaited');
      expect(held.timers[0]!.hasRef(), 'a promotion elsewhere ref\'d this sleep').toBe(false);
      answerAwaited();
      expect((await awaited).map((p) => p.join('.'))).toEqual(['A']);
      expect(held.timers[0]!.hasRef()).toBe(false);
    } finally {
      prefetch.cancel();
      held.restore();
    }
  });
});

describe('scheduling and fallback details (issue #3718 review)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudFormationSend.mockReset();
    clearCreateOnlyPropertiesCache();
  });

  const throttle = (): Error =>
    Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });

  it('a call backing off from a throttle KEEPS its slot: the next call does not start', async () => {
    const sleeps: Array<() => void> = [];
    describeTypeRetryDelays.sleep = () => new Promise((resolve) => sleeps.push(resolve));
    try {
      mockCloudFormationSend.mockRejectedValue(throttle());
      const all = Array.from({ length: DESCRIBE_TYPE_MAX_IN_FLIGHT + 1 }, (_, i) => `AWS::T::S${i}`);
      const prefetch = prefetchCreateOnlyPropertyPaths(all);
      for (let i = 0; i < 20 && sleeps.length < DESCRIBE_TYPE_MAX_IN_FLIGHT; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(sleeps).toHaveLength(DESCRIBE_TYPE_MAX_IN_FLIGHT);
      // Every slot is asleep in a backoff, so the 21st type was never sent.
      expect(mockCloudFormationSend).toHaveBeenCalledTimes(DESCRIBE_TYPE_MAX_IN_FLIGHT);
      prefetch.cancel();
      expect(describeTypeQueueDepth()).toEqual({ active: 0, pending: 0 });
    } finally {
      delete describeTypeRetryDelays.sleep;
    }
  });

  it('an aborted call is not retried', async () => {
    let calls = 0;
    mockCloudFormationSend.mockImplementation(
      (_c: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          calls++;
          options!.abortSignal!.addEventListener('abort', () => reject(throttle()));
        })
    );
    // An instant, NON-abortable backoff, so only the retry predicate can stop
    // a second attempt after the abort surfaces as a throttle.
    describeTypeRetryDelays.sleep = () => Promise.resolve();
    try {
      const prefetch = prefetchCreateOnlyPropertyPaths(['AWS::T::Aborted']);
      await flushMicrotasks();
      prefetch.cancel();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toBe(1);
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    } finally {
      delete describeTypeRetryDelays.sleep;
    }
  });

  it('describeTypeWithThrottleRetry (write-only / read-only / import callers) runs ahead of a queued prefetch', async () => {
    const sends = deferredSends();
    const prefetch = prefetchCreateOnlyPropertyPaths(
      Array.from({ length: DESCRIBE_TYPE_MAX_IN_FLIGHT + 5 }, (_, i) => `AWS::Test::W${i}`)
    );
    await flushMicrotasks();
    const urgent = describeTypeWithThrottleRetry('AWS::Test::WriteOnly');
    sends.release('AWS::Test::W0');
    await flushMicrotasks();
    expect(sends.sent[DESCRIBE_TYPE_MAX_IN_FLIGHT]).toBe('AWS::Test::WriteOnly');
    sends.release('AWS::Test::WriteOnly');
    await urgent;
    prefetch.cancel();
    await sends.releaseAll();
  });

  it('a queued call goes out on the client of the scope that SCHEDULED it', async () => {
    const sends = deferredSends();
    const scopeB = vi.fn(() => Promise.resolve(schemaResponse(['/properties/B'])));
    // Scope A fills every slot; scope B's lookup queues behind them.
    const prefetch = prefetchCreateOnlyPropertyPaths(
      Array.from({ length: DESCRIBE_TYPE_MAX_IN_FLIGHT }, (_, i) => `AWS::Test::A${i}`)
    );
    await flushMicrotasks();
    const b = clientScope.run({ send: scopeB }, () => getCreateOnlyPropertyPaths('AWS::Test::B'));
    // A's task finishing starts B from INSIDE A's async context.
    sends.release('AWS::Test::A0');
    expect((await b).map((p) => p.join('.'))).toEqual(['B']);
    expect(scopeB).toHaveBeenCalledTimes(1);
    expect(sends.sent).not.toContain('AWS::Test::B');
    prefetch.cancel();
    await sends.releaseAll();
  });

  it('a background failure nobody awaited logs at debug; the awaited retry warns once', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));
    prefetchCreateOnlyPropertyPaths(['AWS::SQS::Queue', 'AWS::SNS::Topic']);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(
      mockLoggerDebug.mock.calls.some(([line]) => String(line).includes('AWS::SQS::Queue'))
    ).toBe(true);

    await getCreateOnlyPropertyPaths('AWS::SQS::Queue');
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it('a failure an awaited caller JOINED still warns', async () => {
    mockCloudFormationSend.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('AccessDenied')), 5);
        })
    );
    prefetchCreateOnlyPropertyPaths(['AWS::SQS::Queue']);
    const joined = await getCreateOnlyPropertyPaths('AWS::SQS::Queue');
    expect(joined).toEqual(CREATE_ONLY_PATHS_SNAPSHOT.get('AWS::SQS::Queue'));
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it('a snapshot entry of [] is "the snapshot says none" (snapshot warning), distinct from no entry', async () => {
    const empty = [...CREATE_ONLY_PATHS_SNAPSHOT].find(([, paths]) => paths.length === 0);
    expect(empty, 'no snapshot type declares zero create-only paths').toBeDefined();
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));

    expect(await getCreateOnlyPropertyPaths(empty![0])).toEqual([]);
    expect(mockLoggerWarn.mock.calls[0]![0]).toContain("cdkd's bundled schema snapshot");

    expect(await getCreateOnlyPropertyPaths(UNSNAPSHOTTED)).toEqual([]);
    expect(mockLoggerWarn.mock.calls[1]![0]).toContain('registry-only');
  });

  it('with fake timers: the backoff timer is cleared by the cancel', async () => {
    vi.useFakeTimers();
    try {
      mockCloudFormationSend.mockRejectedValue(throttle());
      const prefetch = prefetchCreateOnlyPropertyPaths(['AWS::Test::Fake']);
      for (let i = 0; i < 50 && vi.getTimerCount() === 0; i++) await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      prefetch.cancel();
      await flushMicrotasks();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('templateResourceTypes', () => {
  it('returns the distinct string Types and tolerates malformed sections', () => {
    expect(
      templateResourceTypes({
        A: { Type: 'AWS::S3::Bucket' },
        B: { Type: 'AWS::S3::Bucket' },
        C: { Type: 'AWS::SQS::Queue' },
        D: null,
        E: { Type: 42 },
        F: 'nope',
      })
    ).toEqual(['AWS::S3::Bucket', 'AWS::SQS::Queue']);
    expect(templateResourceTypes(undefined)).toEqual([]);
    expect(templateResourceTypes('x')).toEqual([]);
  });
});

describe('createOnlyChangeRequiresReplacement (pure path-granular comparison, issue #960)', () => {
  const PIPE_PATHS: string[][] = [
    ['Name'],
    ['Source'],
    ['SourceParameters', 'KinesisStreamParameters', 'StartingPosition'],
    ['SourceParameters', 'DynamoDBStreamParameters', 'StartingPosition'],
  ];

  it('length-1 path: any change to the whole property replaces', () => {
    expect(createOnlyChangeRequiresReplacement(PIPE_PATHS, 'Source', 'arn:a', 'arn:b', eq)).toBe(
      true
    );
  });

  it('nested path: a sibling sub-property change does NOT replace (Pipes SQS BatchSize)', () => {
    const oldV = { SqsQueueParameters: { BatchSize: 1 } };
    const newV = { SqsQueueParameters: { BatchSize: 2 } };
    expect(
      createOnlyChangeRequiresReplacement(PIPE_PATHS, 'SourceParameters', oldV, newV, eq)
    ).toBe(false);
  });

  it('nested path: a change AT the createOnly path replaces (StartingPosition)', () => {
    const oldV = { KinesisStreamParameters: { StartingPosition: 'LATEST' } };
    const newV = { KinesisStreamParameters: { StartingPosition: 'TRIM_HORIZON' } };
    expect(
      createOnlyChangeRequiresReplacement(PIPE_PATHS, 'SourceParameters', oldV, newV, eq)
    ).toBe(true);
  });

  it('nested path: removing the value at the createOnly path replaces', () => {
    const oldV = { KinesisStreamParameters: { StartingPosition: 'LATEST' } };
    const newV = { KinesisStreamParameters: {} };
    expect(
      createOnlyChangeRequiresReplacement(PIPE_PATHS, 'SourceParameters', oldV, newV, eq)
    ).toBe(true);
  });

  it('absent containers on both sides resolve to undefined (no replacement)', () => {
    // SQS pipe: neither side has the stream-source subtrees at all.
    const oldV = { SqsQueueParameters: { BatchSize: 1 } };
    const newV = { SqsQueueParameters: { BatchSize: 5 } };
    expect(
      createOnlyChangeRequiresReplacement(
        [['SourceParameters', 'ActiveMQBrokerParameters', 'QueueName']],
        'SourceParameters',
        oldV,
        newV,
        eq
      )
    ).toBe(false);
  });

  it('unresolvable shapes are conservative: array where an object is expected replaces', () => {
    expect(
      createOnlyChangeRequiresReplacement(
        [['Prop', 'Nested']],
        'Prop',
        [{ Nested: 1 }],
        [{ Nested: 2 }],
        eq
      )
    ).toBe(true);
  });

  it('unresolvable shapes are conservative: * wildcard segment replaces', () => {
    expect(
      createOnlyChangeRequiresReplacement([['Prop', '*', 'Key']], 'Prop', { a: 1 }, { a: 2 }, eq)
    ).toBe(true);
  });

  it('unresolved intrinsics along the path are conservative (fails-safe toward replacement)', () => {
    // {'Fn::If': ...} is not a plain container — descending into it would
    // compare undefined === undefined and let the change slip through
    // in-place where CloudFormation would replace.
    const oldV = { 'Fn::If': ['Cond', { KinesisStreamParameters: { StartingPosition: 'LATEST' } }, {}] };
    const newV = { SqsQueueParameters: { BatchSize: 1 } };
    expect(
      createOnlyChangeRequiresReplacement(
        [['SourceParameters', 'KinesisStreamParameters', 'StartingPosition']],
        'SourceParameters',
        oldV,
        newV,
        eq
      )
    ).toBe(true);
  });

  it('paths for OTHER top-level keys are ignored', () => {
    expect(createOnlyChangeRequiresReplacement(PIPE_PATHS, 'Target', 'arn:a', 'arn:b', eq)).toBe(
      false
    );
  });
});
