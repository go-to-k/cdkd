import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { DagExecutor, type DagNode } from '../../../src/deployment/dag-executor.js';

function node(id: string, deps: string[] = []): DagNode<null> {
  return {
    id,
    dependencies: new Set(deps),
    state: 'pending',
    data: null,
  };
}

describe('DagExecutor', () => {
  it('executes a single node', async () => {
    const exec = new DagExecutor<null>();
    exec.add(node('A'));

    const ran: string[] = [];
    await exec.execute(4, async (n) => {
      ran.push(n.id);
    });

    expect(ran).toEqual(['A']);
  });

  it('respects dependency order', async () => {
    const exec = new DagExecutor<null>();
    exec.add(node('A'));
    exec.add(node('B', ['A']));

    const ran: string[] = [];
    await exec.execute(4, async (n) => {
      ran.push(n.id);
    });

    expect(ran).toEqual(['A', 'B']);
  });

  it('starts a downstream node as soon as its only dependency completes (not waiting for siblings)', async () => {
    // A is fast (10ms), B/C are slow (100ms). X depends only on A.
    // Event-driven dispatch: X must start once A completes, NOT wait for B/C.
    const exec = new DagExecutor<null>();
    exec.add(node('A'));
    exec.add(node('B'));
    exec.add(node('C'));
    exec.add(node('X', ['A']));

    const events: { id: string; phase: 'start' | 'end'; t: number }[] = [];
    const start = Date.now();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    await exec.execute(4, async (n) => {
      events.push({ id: n.id, phase: 'start', t: Date.now() - start });
      const ms = n.id === 'A' ? 10 : n.id === 'X' ? 10 : 100;
      await sleep(ms);
      events.push({ id: n.id, phase: 'end', t: Date.now() - start });
    });

    const xStart = events.find((e) => e.id === 'X' && e.phase === 'start')!.t;
    const bEnd = events.find((e) => e.id === 'B' && e.phase === 'end')!.t;
    const cEnd = events.find((e) => e.id === 'C' && e.phase === 'end')!.t;

    // X must start before B/C finish (proves no level barrier)
    expect(xStart).toBeLessThan(bEnd);
    expect(xStart).toBeLessThan(cEnd);
  });

  it('runs independent nodes in parallel', async () => {
    const exec = new DagExecutor<null>();
    exec.add(node('A'));
    exec.add(node('B'));
    exec.add(node('C'));

    const events: string[] = [];
    await exec.execute(4, async (n) => {
      events.push(`start:${n.id}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end:${n.id}`);
    });

    const firstEnd = events.findIndex((e) => e.startsWith('end:'));
    const startsBeforeFirstEnd = events.slice(0, firstEnd).filter((e) => e.startsWith('start:'));
    expect(startsBeforeFirstEnd).toHaveLength(3);
  });

  it('respects concurrency limit', async () => {
    const exec = new DagExecutor<null>();
    for (let i = 0; i < 5; i++) exec.add(node(`N${i}`));

    let active = 0;
    let peak = 0;
    await exec.execute(2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });

    expect(peak).toBe(2);
  });

  it('skips downstream when dependency fails and rejects with the original error', async () => {
    const exec = new DagExecutor<null>();
    exec.add(node('A'));
    exec.add(node('B', ['A']));
    exec.add(node('C', ['B']));

    const ran: string[] = [];
    const failure = new Error('A boom');
    await expect(
      exec.execute(4, async (n) => {
        ran.push(n.id);
        if (n.id === 'A') throw failure;
      })
    ).rejects.toBe(failure);

    expect(ran).toEqual(['A']);
    expect([...exec.values()].find((n) => n.id === 'B')?.state).toBe('skipped');
    expect([...exec.values()].find((n) => n.id === 'C')?.state).toBe('skipped');
  });

  it('propagates skip transitively regardless of node insertion order', async () => {
    // Insert leaf-first so that a single-pass skip-marking would leave
    // descendants in 'pending' state. The fixed-point loop must catch them.
    const exec = new DagExecutor<null>();
    exec.add(node('D', ['C']));
    exec.add(node('C', ['B']));
    exec.add(node('B', ['A']));
    exec.add(node('A'));

    await expect(
      exec.execute(4, async (n) => {
        if (n.id === 'A') throw new Error('A boom');
      })
    ).rejects.toThrow('A boom');

    const stateOf = (id: string) => [...exec.values()].find((n) => n.id === id)?.state;
    expect(stateOf('A')).toBe('failed');
    expect(stateOf('B')).toBe('skipped');
    expect(stateOf('C')).toBe('skipped');
    expect(stateOf('D')).toBe('skipped');
  });

  it('does not reject until ALL in-flight nodes have observably finished their work', async () => {
    // Drain-before-reject guarantee: a sibling that started before another
    // node failed must finish its full fn() body — including any state
    // mutations the deploy-engine relies on (completedOperations.push,
    // saveStateAfterResource) — before execute() rejects. Otherwise the
    // outer catch could observe inconsistent state and rollback would miss
    // resources that already succeeded in AWS.
    const exec = new DagExecutor<null>();
    exec.add(node('A'));
    exec.add(node('B'));
    exec.add(node('C'));

    // Logical clock (millisecond timestamps coarsen too much under setTimeout).
    let tick = 0;
    const observedAt: Record<string, number> = {};

    const failure = new Error('B failed first');
    await expect(
      exec.execute(8, async (n) => {
        // B fails FAST so its rejection is queued before A/C finish.
        await new Promise((r) => setTimeout(r, n.id === 'B' ? 5 : 50));
        if (n.id === 'B') throw failure;
        observedAt[n.id] = ++tick;
      })
    ).rejects.toBe(failure);
    const rejectedAt = ++tick;

    // Both surviving siblings ran their body to completion BEFORE reject fired.
    expect(observedAt['A']).toBeDefined();
    expect(observedAt['C']).toBeDefined();
    expect(observedAt['A']).toBeLessThan(rejectedAt);
    expect(observedAt['C']).toBeLessThan(rejectedAt);
  });

  it('collects multiple concurrent failures but rejects with the FIRST one (rest are silent)', async () => {
    // Matches the prior level-sync behavior of `Promise.allSettled` then
    // `throw failures[0]!.reason`. The other errors don't disappear from
    // node state — each failed node has state === 'failed' — they're just
    // not surfaced through the rejection.
    const exec = new DagExecutor<null>();
    exec.add(node('A'));
    exec.add(node('B'));
    exec.add(node('C'));

    const errA = new Error('A boom');
    const errC = new Error('C boom');

    await expect(
      exec.execute(8, async (n) => {
        // A fails first, C fails later (still concurrently with B's success).
        await new Promise((r) => setTimeout(r, n.id === 'A' ? 5 : 30));
        if (n.id === 'A') throw errA;
        if (n.id === 'C') throw errC;
      })
    ).rejects.toBe(errA); // FIRST error wins

    expect([...exec.values()].find((n) => n.id === 'A')?.state).toBe('failed');
    expect([...exec.values()].find((n) => n.id === 'B')?.state).toBe('completed');
    expect([...exec.values()].find((n) => n.id === 'C')?.state).toBe('failed');
  });

  it('drains in-flight independent nodes when one fails (does not rollback their state)', async () => {
    const exec = new DagExecutor<null>();
    exec.add(node('A'));
    exec.add(node('B'));
    exec.add(node('C'));

    const completed: string[] = [];
    const failure = new Error('B boom');
    await expect(
      exec.execute(4, async (n) => {
        await new Promise((r) => setTimeout(r, n.id === 'B' ? 5 : 30));
        if (n.id === 'B') throw failure;
        completed.push(n.id);
      })
    ).rejects.toBe(failure);

    // A and C ran in parallel with B and completed normally
    expect(completed.sort()).toEqual(['A', 'C']);
    expect([...exec.values()].find((n) => n.id === 'B')?.state).toBe('failed');
  });

  it('treats deps outside the registered set as already-completed', async () => {
    // X depends on Y which is NOT in the executor (simulates NO_CHANGE resources
    // referenced via Ref/GetAtt but excluded from the provisioning DAG).
    const exec = new DagExecutor<null>();
    exec.add(node('X', ['Y']));

    const ran: string[] = [];
    await exec.execute(4, async (n) => {
      ran.push(n.id);
    });
    expect(ran).toEqual(['X']);
  });

  it('leaves no pending nodes when cancellation lands AFTER all nodes already completed', async () => {
    // Simulates SIGINT firing right at the end of a deploy: every node already
    // completed, then cancelled() flips. The executor must resolve cleanly with
    // no nodes left pending — caller can use values() to detect that nothing
    // was actually interrupted.
    const exec = new DagExecutor<null>();
    exec.add(node('A'));
    exec.add(node('B', ['A']));

    let cancelledFlag = false;
    const ran: string[] = [];
    await exec.execute(
      4,
      async (n) => {
        ran.push(n.id);
        if (n.id === 'B') cancelledFlag = true; // last node — flip after it runs
      },
      () => cancelledFlag
    );

    expect(ran).toEqual(['A', 'B']);
    expect([...exec.values()].every((n) => n.state === 'completed')).toBe(true);
    expect([...exec.values()].some((n) => n.state === 'pending')).toBe(false);
  });

  it('stops dispatching when cancelled() returns true and resolves cleanly after drain', async () => {
    const exec = new DagExecutor<null>();
    exec.add(node('A'));
    exec.add(node('B', ['A']));
    exec.add(node('C', ['B']));

    let cancelled = false;
    const ran: string[] = [];

    await exec.execute(
      4,
      async (n) => {
        ran.push(n.id);
        if (n.id === 'A') cancelled = true;
      },
      () => cancelled
    );

    // Only A should have started — cancellation halts further dispatch
    expect(ran).toEqual(['A']);
    expect([...exec.values()].find((n) => n.id === 'B')?.state).toBe('pending');
    expect([...exec.values()].find((n) => n.id === 'C')?.state).toBe('pending');
  });

  it('handles empty graph', async () => {
    const exec = new DagExecutor<null>();
    await exec.execute(4, async () => {
      throw new Error('should not run');
    });
  });

  it('fails on deadlock (dep cycle)', async () => {
    // A depends on B, B depends on A — neither becomes ready.
    const exec = new DagExecutor<null>();
    exec.add(node('A', ['B']));
    exec.add(node('B', ['A']));

    await expect(exec.execute(4, async () => {})).rejects.toThrow(/Deadlock/);
  });
});
