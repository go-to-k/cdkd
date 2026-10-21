import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#5136: a declined `--require-approval` prompt is reported once,
// softly, while a genuine failure keeps its red report.
const log = vi.hoisted(() => ({ error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({ debug: log.debug, info: vi.fn(), warn: vi.fn(), error: log.error }),
  }),
}));

import { WorkGraph, type WorkNode } from '../../../src/deployment/work-graph.js';
import {
  DeploymentNotApprovedError,
  isSoftAbort,
} from '../../../src/utils/error-handler.js';

const CONCURRENCY = { 'asset-build': 4, 'asset-publish': 8, stack: 4 };

function stackNode(id: string, deps: string[] = []): WorkNode {
  return { id, type: 'stack', dependencies: new Set(deps), state: 'pending', data: null };
}

const declined = (stack: string): DeploymentNotApprovedError =>
  new DeploymentNotApprovedError(`Deployment of stack ${stack} was not approved.`);

describe('WorkGraph: declined approval', () => {
  beforeEach(() => {
    log.error.mockReset();
    log.debug.mockReset();
  });

  it('rejects with the decline itself and logs no failure line', async () => {
    const graph = new WorkGraph();
    graph.addNode(stackNode('stack:A'));
    const error = declined('A');

    const rejection = await graph
      .execute(CONCURRENCY, async () => {
        throw error;
      })
      .catch((e: unknown) => e);

    expect(rejection).toBe(error);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps skipping dependents and names them in a soft rejection', async () => {
    const graph = new WorkGraph();
    graph.addNode(stackNode('stack:A'));
    graph.addNode(stackNode('stack:B', ['stack:A']));
    const ran: string[] = [];

    const rejection = await graph
      .execute(CONCURRENCY, async (node) => {
        ran.push(node.id);
        throw declined('A');
      })
      .catch((e: unknown) => e);

    expect(ran).toEqual(['stack:A']);
    expect(isSoftAbort(rejection)).toBe(true);
    expect((rejection as Error).message).toBe(
      'Deployment of stack A was not approved.\n1 node(s) depending on a declined stack were skipped.'
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('reports a genuine failure beside a decline as a failure', async () => {
    const graph = new WorkGraph();
    graph.addNode(stackNode('stack:A'));
    graph.addNode(stackNode('stack:B'));

    const rejection = await graph
      .execute(CONCURRENCY, async (node) => {
        throw node.id === 'stack:A' ? declined('A') : new Error('boom');
      })
      .catch((e: unknown) => e);

    expect(isSoftAbort(rejection)).toBe(false);
    expect((rejection as Error).message).toContain('2 node(s) failed');
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toContain('Failed: stack:B: boom');
  });
});

describe('WorkGraph: several declines', () => {
  it('joins every declined stack into one soft rejection', async () => {
    const graph = new WorkGraph();
    graph.addNode(stackNode('stack:A'));
    graph.addNode(stackNode('stack:B'));

    const rejection = await graph
      .execute(CONCURRENCY, async (node) => {
        throw declined(node.id.slice('stack:'.length));
      })
      .catch((e: unknown) => e);

    expect(isSoftAbort(rejection)).toBe(true);
    expect((rejection as Error).message.split('\n').sort()).toEqual([
      'Deployment of stack A was not approved.',
      'Deployment of stack B was not approved.',
    ]);
  });
});
