/**
 * go-to-k/cdkd#4705: the deploy gates over the run's stack-registry guard --
 * the first-deploy gate claims (or acts on) the stack's marker and refuses
 * before any provider call when another prefix holds the stack; the
 * destructive gate and the holder read it on demand -- and the fallback
 * scan's run-wide probe scheduler.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), child: (): unknown => quiet };
  return { ...actual, getLogger: () => quiet };
});

import {
  composeStateLoadedGates,
  createCrossPrefixDeployGate,
  createCrossPrefixDestructiveGate,
  createCrossPrefixHolder,
  crossPrefixEngineOptions,
  deployStackRegion,
} from '../../../src/cli/commands/cross-prefix-gate.js';
import {
  CrossPrefixScanCache,
  PROBE_CONCURRENCY,
  withSharedListing,
  type CrossPrefixScanTarget,
} from '../../../src/state/cross-prefix-stack-scan.js';
import type { CrossPrefixScanResult } from '../../../src/state/cross-prefix-stack-scan.js';
import { STATE_SCHEMA_VERSION_CURRENT, type StackState } from '../../../src/types/state.js';

const loaded: StackState = {
  version: STATE_SCHEMA_VERSION_CURRENT,
  stackName: 'App',
  region: 'us-east-1',
  resources: {},
  outputs: {},
  lastModified: 1,
};

/** A guard whose first-deploy answer is `result` (or never settles). */
function guardOf(result: CrossPrefixScanResult | 'never') {
  return {
    firstDeploy: vi.fn(
      (): Promise<CrossPrefixScanResult> =>
        result === 'never' ? new Promise(() => {}) : Promise.resolve(result)
    ),
    full: vi.fn(
      (): Promise<CrossPrefixScanResult> =>
        result === 'never' ? new Promise(() => {}) : Promise.resolve(result)
    ),
  };
}

function gate(result: CrossPrefixScanResult | 'never', guard = guardOf(result)) {
  return createCrossPrefixDeployGate({
    stackName: 'App',
    region: 'us-east-1',
    bucket: 'cdkd-state-123456789012',
    guard,
  });
}

describe('createCrossPrefixDeployGate', () => {
  it('refuses a first deploy when another prefix records the stack', async () => {
    await expect(
      gate({ kind: 'found', prefixes: ['team-b'] })('App', undefined)
    ).rejects.toThrow(/Refusing to deploy stack App \(us-east-1\): it is already recorded under another state prefix/);
  });

  it('asks nothing when the record was loaded: an ordinary redeploy makes no request', async () => {
    const guard = guardOf('never');
    await expect(gate('never', guard)('App', loaded)).resolves.toBeUndefined();
    expect(guard.firstDeploy).not.toHaveBeenCalled();
    expect(guard.full).not.toHaveBeenCalled();
  });

  it('ignores another stack name (a nested child inherits the options)', async () => {
    const guard = guardOf('never');
    await expect(gate('never', guard)('App~Child', undefined)).resolves.toBeUndefined();
    expect(guard.firstDeploy).not.toHaveBeenCalled();
  });

  it('a first deploy claims through the guard, for its own name and region, and proceeds on clear', async () => {
    const guard = guardOf({ kind: 'clear' });
    await expect(gate({ kind: 'clear' }, guard)('App', undefined)).resolves.toBeUndefined();
    expect(guard.firstDeploy).toHaveBeenCalledWith('App', 'us-east-1');
  });

  it('refuses a deploy in progress under the prefix the registry names', async () => {
    await expect(
      gate({ kind: 'in-progress', prefix: 'team-b' })('App', undefined)
    ).rejects.toThrow(/assigns it to state prefix team-b, which records nothing for it yet but holds its lock/);
  });

  it('warns and proceeds when S3 denied a read', async () => {
    warn.mockClear();
    await expect(
      gate({ kind: 'denied', error: { name: 'AccessDenied' }, stage: 'probe' })('App', undefined)
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('Could not check the other state prefixes for stack App');
  });
  it('reports one scan result once: the first-deploy gate and the destructive gate share its 403 warning (review R7-3)', async () => {
    warn.mockClear();
    const denied = { kind: 'denied', error: { name: 'AccessDenied' }, stage: 'list' } as const;
    const opts = crossPrefixEngineOptions({
      stackName: 'App',
      region: 'us-east-1',
      bucket: 'b',
      guard: { firstDeploy: vi.fn(async () => denied), full: vi.fn(async () => denied) },
    });
    await opts.firstDeployGate('App', undefined);
    await opts.onDestructivePlan('App', []);
    await opts.crossPrefixHolder('App');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a DIFFERENT result (another run, another stack) is reported again', async () => {
    warn.mockClear();
    const g = (scan: CrossPrefixScanResult) => gate(scan)('App', undefined);
    await g({ kind: 'denied', error: { name: 'AccessDenied' }, stage: 'probe' });
    await g({ kind: 'denied', error: { name: 'AccessDenied' }, stage: 'probe' });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

function fakeTarget(holders: Record<string, boolean> = {}) {
  let inFlight = 0;
  let max = 0;
  const t = {
    prefix: 'cdkd',
    listTopLevelPrefixes: vi.fn(async () => ['cdkd', 'team-b', 'team-c', 'team-d']),
    recordUnderPrefix: vi.fn(async (p: string, stackName: string) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return holders[`${p}|${stackName}`] ? ('holder' as const) : ('absent' as const);
    }),
    maxInFlight: () => max,
  };
  return t satisfies CrossPrefixScanTarget;
}

describe('the fallback scan scheduler (one listing, one run-wide probe cap)', () => {
  it(`caps probes in flight at ${PROBE_CONCURRENCY} across EVERY stack of the run`, async () => {
    const t = fakeTarget();
    t.listTopLevelPrefixes.mockResolvedValue(Array.from({ length: 60 }, (_, i) => `p${i}`));
    const cache = new CrossPrefixScanCache(t);
    await Promise.all(['A', 'B', 'C', 'D'].map((name) => cache.full(name, 'us-east-1')));
    expect(t.recordUnderPrefix.mock.calls.length).toBe(4 * 120);
    expect(t.maxInFlight()).toBeLessThanOrEqual(PROBE_CONCURRENCY);
    expect(t.maxInFlight()).toBe(PROBE_CONCURRENCY);
  });

  // Review R6-3: the rank is a priority, not a barrier.
  it('a probe that never settles holds only its own slot: a later-ranked scan still completes (hang isolation)', async () => {
    const t = fakeTarget();
    t.listTopLevelPrefixes.mockResolvedValue(Array.from({ length: 15 }, (_, i) => `p${i}`));
    t.recordUnderPrefix.mockImplementation(async (p: string, stackName: string) => {
      if (stackName === 'A' && p === 'p0') return new Promise<never>(() => {});
      await new Promise((r) => setTimeout(r, 1));
      return 'absent';
    });
    const cache = new CrossPrefixScanCache(t);
    void cache.full('A', 'us-east-1', 'prestart');
    await expect(cache.full('B', 'us-east-1', 'prestart')).resolves.toEqual({ kind: 'clear' });
  });

  it('when probes of two ranks both wait, the better rank is admitted first', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const target = withSharedListing({
      prefix: 'cdkd',
      listTopLevelPrefixes: vi.fn(),
      recordUnderPrefix: vi.fn((_p: string, stackName: string) => {
        started.push(stackName);
        return new Promise<'absent'>((r) => releases.push(() => r('absent')));
      }),
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    target.rank('A', 'r', 'prestart');
    target.rank('B', 'r', 'prestart');
    // An unranked scan fills every slot.
    for (let i = 0; i < PROBE_CONCURRENCY; i++) void target.recordUnderPrefix(`f${i}`, 'Z', 'r');
    await tick();
    expect(started).toHaveLength(PROBE_CONCURRENCY);
    // B queues first, then A.
    void target.recordUnderPrefix('p', 'B', 'r');
    void target.recordUnderPrefix('p', 'A', 'r');
    await tick();
    expect(started).toHaveLength(PROBE_CONCURRENCY);
    releases[0]!();
    await tick();
    expect(started[PROBE_CONCURRENCY]).toBe('A');
    releases[1]!();
    await tick();
    expect(started[PROBE_CONCURRENCY + 1]).toBe('B');
  });

  // Review R7-6: the waiters are a heap on (rank, seq).
  function heldTarget() {
    const started: string[] = [];
    const startedPrefixes: string[] = [];
    const releases: Array<() => void> = [];
    const target = withSharedListing({
      prefix: 'cdkd',
      listTopLevelPrefixes: vi.fn(),
      recordUnderPrefix: vi.fn((p: string, stackName: string) => {
        started.push(stackName);
        startedPrefixes.push(p);
        return new Promise<'absent'>((r) => releases.push(() => r('absent')));
      }),
    });
    return { target, started, startedPrefixes, releases };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('promoting a scan whose probes already wait moves them ahead', async () => {
    const { target, started, releases } = heldTarget();
    target.rank('A', 'r', 'prestart');
    target.rank('B', 'r', 'prestart');
    for (let i = 0; i < PROBE_CONCURRENCY; i++) void target.recordUnderPrefix(`f${i}`, 'Z', 'r');
    await tick();
    void target.recordUnderPrefix('p', 'A', 'r');
    void target.recordUnderPrefix('p', 'B', 'r');
    await tick();
    target.rank('B', 'r', 'now');
    releases[0]!();
    await tick();
    expect(started[PROBE_CONCURRENCY]).toBe('B');
    releases[1]!();
    await tick();
    expect(started[PROBE_CONCURRENCY + 1]).toBe('A');
  });

  it('admits waiters of ONE rank in arrival order (review R8-2)', async () => {
    const { target, startedPrefixes, releases } = heldTarget();
    target.rank('A', 'r', 'prestart');
    for (let i = 0; i < PROBE_CONCURRENCY; i++) void target.recordUnderPrefix(`f${i}`, 'Z', 'r');
    await tick();
    const arrivals = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'];
    for (const p of arrivals) void target.recordUnderPrefix(p, 'A', 'r');
    await tick();
    for (let i = 0; i < arrivals.length; i++) {
      releases[i]!();
      await tick();
    }
    expect(startedPrefixes.slice(PROBE_CONCURRENCY)).toEqual(arrivals);
  });

  it('admits many waiters in (rank, arrival) order', async () => {
    const { target, started, releases } = heldTarget();
    const names = ['S0', 'S1', 'S2', 'S3', 'S4'];
    for (const n of names) target.rank(n, 'r', 'prestart');
    for (let i = 0; i < PROBE_CONCURRENCY; i++) void target.recordUnderPrefix(`f${i}`, 'Z', 'r');
    await tick();
    // Arrivals in a scrambled rank order, two per stack.
    const arrivals = ['S3', 'S1', 'S4', 'S0', 'S2', 'S1', 'S3', 'S0', 'S4', 'S2'];
    for (const n of arrivals) void target.recordUnderPrefix('p', n, 'r');
    await tick();
    for (let i = 0; i < arrivals.length; i++) {
      releases[i]!();
      await tick();
    }
    expect(started.slice(PROBE_CONCURRENCY)).toEqual([
      'S0', 'S0', 'S1', 'S1', 'S2', 'S2', 'S3', 'S3', 'S4', 'S4',
    ]);
  });

  it('a scan started on demand (a destructive plan) is not queued behind later stacks\' pre-started scans', async () => {
    const t = fakeTarget();
    t.listTopLevelPrefixes.mockResolvedValue(Array.from({ length: 300 }, (_, i) => `p${i}`));
    const cache = new CrossPrefixScanCache(t);
    const done: string[] = [];
    const prestarted = new Map(
      ['S1', 'S2', 'S3'].map((name) => [name, cache.full(name, 'us-east-1', 'prestart')] as const)
    );
    for (const [key, scan] of prestarted) void scan.then(() => done.push(key));
    // Let the pre-started scans take every slot first.
    await new Promise((r) => setTimeout(r, 5));
    await createCrossPrefixDestructiveGate({ region: 'us-east-1', bucket: 'b', cache })('X', []);
    done.push('X');
    await Promise.all(prestarted.values());
    // X finished ahead of the later pre-started stacks it would otherwise trail.
    expect(done.indexOf('X')).toBeLessThan(done.indexOf('S3'));
    expect(done.indexOf('X')).toBeLessThan(done.indexOf('S2'));
  });

  it('calls the cross-prefix gate first, then the prefix-migration gate', async () => {
    const order: string[] = [];
    const composed = composeStateLoadedGates(
      async () => {
        order.push('cross-prefix');
      },
      async () => {
        order.push('migration');
      }
    );
    await composed('App', undefined);
    expect(order).toEqual(['cross-prefix', 'migration']);
    const refusing = composeStateLoadedGates(async () => {
      throw new Error('refused');
    }, vi.fn());
    await expect(refusing('App', undefined)).rejects.toThrow('refused');
  });
});

describe('createCrossPrefixDestructiveGate', () => {
  it('refuses a destructive plan of a stack another prefix holds, naming it', async () => {
    const gate = createCrossPrefixDestructiveGate({
      region: 'us-east-1',
      bucket: 'b',
      cache: new CrossPrefixScanCache(fakeTarget({ 'team-b|App': true })),
    });
    await expect(gate('App', [])).rejects.toThrow(
      /Refusing to deploy stack App \(us-east-1\): this deploy deletes or replaces resources.*\(team-b\)/s
    );
  });

  it('a late replacement (stage late) is refused in its own words: the resource is kept, the deploy goes on', async () => {
    const gate = createCrossPrefixDestructiveGate({
      region: 'us-east-1',
      bucket: 'b',
      cache: new CrossPrefixScanCache(fakeTarget({ 'team-b|App': true })),
    });
    const refusal = gate('App', [], 'late');
    await expect(refusal).rejects.toThrow(
      /^Refusing to replace a resource of stack App \(us-east-1\) \(a replacement this deploy found only on reading the resource back\), and the stack is also recorded .*\(team-b\)\..*That resource is kept, so the new value is not applied; the rest of the deploy goes on\./s
    );
    const message = await refusal.then(
      () => '',
      (error: unknown) => (error as Error).message
    );
    expect(message).not.toContain('No resource of this stack was changed');
  });

  it('asks for the name the engine passes', async () => {
    const t = fakeTarget({});
    const gate = createCrossPrefixDestructiveGate({
      region: 'us-east-1',
      bucket: 'b',
      cache: new CrossPrefixScanCache(t),
    });
    await expect(gate('App~Child', [])).resolves.toBeUndefined();
    expect(t.recordUnderPrefix).toHaveBeenCalledWith('team-b', 'App~Child', 'us-east-1');
  });
});

describe('deployStackRegion (the ONE region expression the engine and the scans share)', () => {
  it("uses the stack's own region when it differs from the base region", () => {
    expect(deployStackRegion({ region: 'eu-west-1' }, 'us-east-1')).toBe('eu-west-1');
  });
  it('falls back to the base region', () => {
    expect(deployStackRegion({}, 'us-east-1')).toBe('us-east-1');
    expect(deployStackRegion({ region: '' }, 'us-east-1')).toBe('us-east-1');
  });
});

describe('createCrossPrefixHolder (the settle of journaled orphans), one case per scan kind', () => {
  const holderOver = (result: CrossPrefixScanResult) => {
    const cache = new CrossPrefixScanCache(fakeTarget());
    vi.spyOn(cache, 'full').mockResolvedValue(result);
    return createCrossPrefixHolder({ region: 'us-east-1', bucket: 'b', cache });
  };

  it('found: keeps the orphan (unreadable), naming the other prefix', async () => {
    await expect(holderOver({ kind: 'found', prefixes: ['team-b'] })('App')).resolves.toEqual({
      kind: 'unreadable',
      what: 'bucket b also records this stack under another state prefix (team-b), whose record may hold it',
    });
  });

  it('in-progress: keeps the resource (unreadable), naming the prefix', async () => {
    await expect(
      holderOver({ kind: 'in-progress', prefix: 'team-b' })('App')
    ).resolves.toMatchObject({ kind: 'unreadable', what: expect.stringContaining('(team-b)') });
  });

  it('failed: keeps the orphan (unreadable)', async () => {
    await expect(
      holderOver({ kind: 'failed', error: { name: 'SlowDown' } })('App')
    ).resolves.toMatchObject({ kind: 'unreadable' });
  });

  it.each(['list', 'probe', 'registry'] as const)(
    'denied (stage %s): warns and answers nothing, so the settle deletes as before',
    async (stage) => {
      warn.mockClear();
      await expect(
        holderOver({ kind: 'denied', error: { name: 'AccessDenied' }, stage })('App')
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/Could not (check the other state prefixes|use the stack registry)/);
    }
  );

  it('clear: answers nothing', async () => {
    await expect(holderOver({ kind: 'clear' })('App')).resolves.toBeUndefined();
  });
});
