/**
 * go-to-k/cdkd#4705 review CB-14b: what this stack kept before `retained.json`
 * existed -- its earlier records (a Retain policy and a physical id) and its
 * event history (a `RESOURCE_RETAINED` row whose physical id an earlier
 * `RESOURCE_SUCCEEDED` of the same logical id and type recorded). An old-style
 * event history is seeded verbatim in the shape cdkd has written since #820.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  keptInEarlierRecords,
  keptInEventHistory,
  loadKeptInHistory,
} from '../../../src/deployment/kept-in-history.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';

const URL = 'https://sqs.us-east-1.amazonaws.com/1/App-Queue';
const LG = '/cdkd/App-Logs';
/** The retained row's timestamp: when the destroy kept the queue. */
const KEPT_AT = Date.parse('2026-09-01T00:00:00.000Z');

describe('earlier records', () => {
  it('names a Retain (or RetainExceptOnCreate) resource with a physical id, nothing else', () => {
    expect(
      keptInEarlierRecords([
        { writtenAt: 1000, resources: {
          Queue: { resourceType: 'AWS::SQS::Queue', physicalId: URL, deletionPolicy: 'Retain' },
          Logs: { resourceType: 'AWS::Logs::LogGroup', physicalId: LG, deletionPolicy: 'RetainExceptOnCreate' },
          Gone: { resourceType: 'AWS::SQS::Queue', physicalId: 'x', deletionPolicy: 'Delete' },
          NoPolicy: { resourceType: 'AWS::SQS::Queue', physicalId: 'y' },
          NoId: { resourceType: 'AWS::SQS::Queue', deletionPolicy: 'Retain' },
          Junk: 'not a record',
        } },
      ])
    ).toEqual([
      { logicalId: 'Queue', resourceType: 'AWS::SQS::Queue', physicalId: URL, keptAt: 1000 },
      { logicalId: 'Logs', resourceType: 'AWS::Logs::LogGroup', physicalId: LG, keptAt: 1000 },
    ]);
  });
});

/** An old-style run, as `DeploymentEventsStore` wrote it. */
const ev = (e: Partial<DeploymentEvent>): DeploymentEvent =>
  ({ timestamp: '2026-09-01T00:00:00.000Z', stackName: 'App', ...e }) as DeploymentEvent;
const deployRun = [
  ev({ eventType: 'RUN_STARTED', command: 'deploy', region: 'us-east-1', cdkdVersion: '0.290.0' }),
  ev({ eventType: 'RESOURCE_SUCCEEDED', operation: 'CREATE', logicalId: 'Queue', resourceType: 'AWS::SQS::Queue', physicalId: URL }),
  ev({ eventType: 'RESOURCE_SUCCEEDED', operation: 'CREATE', logicalId: 'Logs', resourceType: 'AWS::Logs::LogGroup', physicalId: LG }),
  ev({ eventType: 'RUN_FINISHED', result: 'SUCCEEDED' }),
];
const destroyRun = [
  ev({ eventType: 'RUN_STARTED', command: 'destroy', region: 'us-east-1', cdkdVersion: '0.290.0' }),
  ev({ eventType: 'RESOURCE_RETAINED', operation: 'DELETE', logicalId: 'Queue', resourceType: 'AWS::SQS::Queue' }),
  ev({ eventType: 'RESOURCE_SUCCEEDED', operation: 'DELETE', logicalId: 'Logs', resourceType: 'AWS::Logs::LogGroup' }),
  ev({ eventType: 'RUN_FINISHED', result: 'SUCCEEDED' }),
];

describe('event history', () => {
  it('a retained row licenses the physical id an earlier create of that logical id and type recorded', () => {
    expect(keptInEventHistory([deployRun, destroyRun], 'App')).toEqual([
      { logicalId: 'Queue', resourceType: 'AWS::SQS::Queue', physicalId: URL, keptAt: KEPT_AT },
    ]);
  });

  it('a retained row alone (its create pruned from the history) proves nothing', () => {
    expect(keptInEventHistory([destroyRun], 'App')).toEqual([]);
  });

  it("D-13: a nested child's rows, in its top-level stack's runs under its own name, license the child", async () => {
    const child = [...deployRun, ...destroyRun].map((e) => ({ ...e, stackName: 'App~Child' }));
    const listRuns = vi.fn(async () => [{ runId: 'r2' }, { runId: 'r1' }]);
    const readRunEvents = vi.fn(async (_s: string, _r: string, runId: string) =>
      runId === 'r1' ? child.slice(0, deployRun.length) : child.slice(deployRun.length)
    );
    const kept = await loadKeptInHistory(
      { earlierStateResources: async () => [], listRuns, readRunEvents },
      'App~Child',
      'us-east-1'
    );
    expect(listRuns).toHaveBeenCalledWith('App', 'us-east-1');
    expect(kept).toEqual([{ logicalId: 'Queue', resourceType: 'AWS::SQS::Queue', physicalId: URL, keptAt: KEPT_AT }]);
  });

  it("another stack's rows (a nested child in the parent's stream) and another type prove nothing", () => {
    const child = deployRun.map((e) => ({ ...e, stackName: 'App~Child' }));
    expect(keptInEventHistory([child, destroyRun], 'App')).toEqual([]);
    const otherType = destroyRun.map((e) =>
      e.eventType === 'RESOURCE_RETAINED' ? { ...e, resourceType: 'AWS::SNS::Topic' } : e
    );
    expect(keptInEventHistory([deployRun, otherType], 'App')).toEqual([]);
  });
});

describe('loadKeptInHistory', () => {
  it('reads at most the 20 newest runs, oldest first, and both sources best-effort', async () => {
    const runs = Array.from({ length: 25 }, (_, i) => ({ runId: `r${String(24 - i).padStart(2, '0')}` }));
    const readRunEvents = vi.fn(async (_s: string, _r: string, runId: string) =>
      runId === 'r23' ? deployRun : runId === 'r24' ? destroyRun : []
    );
    const kept = await loadKeptInHistory(
      {
        earlierStateResources: vi.fn(async () => {
          throw new Error('versions not granted');
        }),
        listRuns: vi.fn(async () => runs),
        readRunEvents,
      },
      'App',
      'us-east-1'
    );
    expect(kept).toEqual([{ logicalId: 'Queue', resourceType: 'AWS::SQS::Queue', physicalId: URL, keptAt: KEPT_AT }]);
    expect(readRunEvents).toHaveBeenCalledTimes(20);
  });

  it('an earlier record licenses even when the history kept nothing', async () => {
    const kept = await loadKeptInHistory(
      {
        earlierStateResources: async () => [
          { resources: { Logs: { resourceType: 'AWS::Logs::LogGroup', physicalId: LG, deletionPolicy: 'Retain' } } },
        ],
        listRuns: async () => {
          throw new Error('no history');
        },
        readRunEvents: async () => null,
      },
      'App',
      'us-east-1'
    );
    expect(kept).toEqual([{ logicalId: 'Logs', resourceType: 'AWS::Logs::LogGroup', physicalId: LG }]);
  });
});
