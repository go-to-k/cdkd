import { describe, it, expect, vi } from 'vitest';

// Mock logger
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

import { WorkGraph, type WorkNode } from '../../../src/deployment/work-graph.js';

function makeNode(
  id: string,
  type: 'asset-publish' | 'stack',
  deps: string[] = []
): WorkNode {
  return {
    id,
    type,
    dependencies: new Set(deps),
    state: 'pending',
    data: null,
  };
}

describe('WorkGraph', () => {
  it('should execute a single node', async () => {
    const graph = new WorkGraph();
    graph.addNode(makeNode('stack:A', 'stack'));

    const executed: string[] = [];
    await graph.execute({ 'asset-publish': 8, stack: 4 }, async (node) => {
      executed.push(node.id);
    });

    expect(executed).toEqual(['stack:A']);
  });

  it('should execute nodes in dependency order', async () => {
    const graph = new WorkGraph();
    graph.addNode(makeNode('asset:A', 'asset-publish'));
    graph.addNode(makeNode('stack:A', 'stack', ['asset:A']));

    const executed: string[] = [];
    await graph.execute({ 'asset-publish': 8, stack: 4 }, async (node) => {
      executed.push(node.id);
    });

    expect(executed).toEqual(['asset:A', 'stack:A']);
  });

  it('should run independent nodes in parallel', async () => {
    const graph = new WorkGraph();
    graph.addNode(makeNode('asset:A', 'asset-publish'));
    graph.addNode(makeNode('asset:B', 'asset-publish'));
    graph.addNode(makeNode('stack:A', 'stack', ['asset:A', 'asset:B']));

    const callOrder: string[] = [];
    await graph.execute({ 'asset-publish': 8, stack: 4 }, async (node) => {
      callOrder.push(`start:${node.id}`);
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(`end:${node.id}`);
    });

    // Both assets should start before either finishes
    const firstEnd = callOrder.findIndex((e) => e.startsWith('end:'));
    const startsBeforeFirstEnd = callOrder.slice(0, firstEnd).filter((e) => e.startsWith('start:'));
    expect(startsBeforeFirstEnd.length).toBe(2);

    // Stack should execute after both assets
    expect(callOrder.indexOf('start:stack:A')).toBeGreaterThan(callOrder.indexOf('end:asset:A'));
    expect(callOrder.indexOf('start:stack:A')).toBeGreaterThan(callOrder.indexOf('end:asset:B'));
  });

  it('should respect per-type concurrency limits', async () => {
    const graph = new WorkGraph();
    for (let i = 0; i < 5; i++) {
      graph.addNode(makeNode(`asset:${i}`, 'asset-publish'));
    }
    graph.addNode(
      makeNode('stack:A', 'stack', Array.from({ length: 5 }, (_, i) => `asset:${i}`))
    );

    let concurrent = 0;
    let maxConcurrent = 0;

    await graph.execute({ 'asset-publish': 2, stack: 4 }, async (node) => {
      if (node.type === 'asset-publish') {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
      }
    });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it('should skip downstream nodes when upstream fails', async () => {
    const graph = new WorkGraph();
    graph.addNode(makeNode('asset:A', 'asset-publish'));
    graph.addNode(makeNode('stack:A', 'stack', ['asset:A']));

    const executed: string[] = [];
    await expect(
      graph.execute({ 'asset-publish': 8, stack: 4 }, async (node) => {
        executed.push(node.id);
        if (node.id === 'asset:A') {
          throw new Error('publish failed');
        }
      })
    ).rejects.toThrow(/1 node\(s\) failed.*1 skipped/);

    expect(executed).toEqual(['asset:A']);
  });

  it('should handle inter-stack dependencies', async () => {
    const graph = new WorkGraph();
    graph.addNode(makeNode('stack:A', 'stack'));
    graph.addNode(makeNode('stack:B', 'stack', ['stack:A']));

    const executed: string[] = [];
    await graph.execute({ 'asset-publish': 8, stack: 4 }, async (node) => {
      executed.push(node.id);
    });

    expect(executed).toEqual(['stack:A', 'stack:B']);
  });

  it('should deploy independent stacks in parallel', async () => {
    const graph = new WorkGraph();
    graph.addNode(makeNode('stack:A', 'stack'));
    graph.addNode(makeNode('stack:B', 'stack'));

    const callOrder: string[] = [];
    await graph.execute({ 'asset-publish': 8, stack: 4 }, async (node) => {
      callOrder.push(`start:${node.id}`);
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(`end:${node.id}`);
    });

    // Both stacks should start before either finishes
    const firstEnd = callOrder.findIndex((e) => e.startsWith('end:'));
    const startsBeforeFirstEnd = callOrder.slice(0, firstEnd).filter((e) => e.startsWith('start:'));
    expect(startsBeforeFirstEnd.length).toBe(2);
  });

  it('should pipeline asset publish and stack deploy across stacks', async () => {
    // Stack A: asset → deploy
    // Stack B: asset → deploy (independent)
    const graph = new WorkGraph();
    graph.addNode(makeNode('asset:A', 'asset-publish'));
    graph.addNode(makeNode('stack:A', 'stack', ['asset:A']));
    graph.addNode(makeNode('asset:B', 'asset-publish'));
    graph.addNode(makeNode('stack:B', 'stack', ['asset:B']));

    const callOrder: string[] = [];
    await graph.execute({ 'asset-publish': 8, stack: 4 }, async (node) => {
      callOrder.push(`start:${node.id}`);
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(`end:${node.id}`);
    });

    // Both assets should start in parallel
    const assetAStart = callOrder.indexOf('start:asset:A');
    const assetBStart = callOrder.indexOf('start:asset:B');
    const firstEnd = callOrder.findIndex((e) => e.startsWith('end:'));
    expect(assetAStart).toBeLessThan(firstEnd);
    expect(assetBStart).toBeLessThan(firstEnd);

    // Stack A should start after asset A completes (not after asset B)
    expect(callOrder.indexOf('start:stack:A')).toBeGreaterThan(callOrder.indexOf('end:asset:A'));
    expect(callOrder.indexOf('start:stack:B')).toBeGreaterThan(callOrder.indexOf('end:asset:B'));
  });

  it('should return correct summary', () => {
    const graph = new WorkGraph();
    graph.addNode(makeNode('asset:A', 'asset-publish'));
    graph.addNode(makeNode('asset:B', 'asset-publish'));
    graph.addNode(makeNode('stack:A', 'stack'));

    expect(graph.summary()).toEqual({ 'asset-publish': 2, stack: 1 });
  });

  it('should handle empty graph', async () => {
    const graph = new WorkGraph();
    const executed: string[] = [];
    await graph.execute({ 'asset-publish': 8, stack: 4 }, async (node) => {
      executed.push(node.id);
    });
    expect(executed).toEqual([]);
  });
});
