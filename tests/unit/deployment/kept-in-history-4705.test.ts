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
  keptWhenRecordsEnded,
  loadKeptForWarning,
  loadKeptInHistory,
  loadRollbackRetainedCopies,
  RETAINED_SURVIVOR_REASON_PREFIX,
  rollbackRetainedInEventHistory,
} from '../../../src/deployment/kept-in-history.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';
import { retainedSurvivorMessages } from '../../../src/deployment/rollback-executor/messages.js';

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

describe('keptWhenRecordsEnded (go-to-k/cdkd#5760)', () => {
  const Q = 'AWS::SQS::Queue';
  it('the newest record: kept only under a retaining DeletionPolicy', () => {
    expect(
      keptWhenRecordsEnded([
        { writtenAt: 2, resources: {
          Kept: { resourceType: Q, physicalId: 'q-kept', deletionPolicy: 'Retain' },
          Deleted: { resourceType: Q, physicalId: 'q-del', deletionPolicy: 'Delete' },
        } },
      ])
    ).toEqual([{ logicalId: 'Kept', resourceType: Q, physicalId: 'q-kept', keptAt: 2 }]);
  });

  it('judges each id at its LAST appearance: Retain dropped before the destroy is not kept', () => {
    const records = [
      { writtenAt: 2, resources: { Q1: { resourceType: Q, physicalId: 'q1', deletionPolicy: 'Delete' } } },
      { writtenAt: 1, resources: { Q1: { resourceType: Q, physicalId: 'q1', deletionPolicy: 'Retain' } } },
    ];
    expect(keptWhenRecordsEnded(records)).toEqual([]);
    // The same id in both records is no replacement, whatever its
    // UpdateReplacePolicy says.
    expect(
      keptWhenRecordsEnded(
        records.map((r) => ({
          ...r,
          resources: { Q1: { ...(r.resources.Q1 as object), updateReplacePolicy: 'Retain' } },
        }))
      )
    ).toEqual([]);
    // The license reader, by contrast, names it (a non-holder costs nothing there).
    expect(keptInEarlierRecords(records).map((k) => k.physicalId)).toEqual(['q1']);
  });

  it('a template removal keeps it under a retaining DeletionPolicy', () => {
    expect(
      keptWhenRecordsEnded([
        { writtenAt: 2, resources: {} },
        { writtenAt: 1, resources: { Gone: { resourceType: Q, physicalId: 'q-gone', deletionPolicy: 'Retain' } } },
      ])
    ).toEqual([{ logicalId: 'Gone', resourceType: Q, physicalId: 'q-gone', keptAt: 1 }]);
  });

  it('a replacement keeps the old id only under a retaining UpdateReplacePolicy', () => {
    const replaced = (updateReplacePolicy: string) => [
      { writtenAt: 2, resources: { Q1: { resourceType: Q, physicalId: 'q1-new', deletionPolicy: 'Delete', updateReplacePolicy } } },
      { writtenAt: 1, resources: { Q1: { resourceType: Q, physicalId: 'q1-old', deletionPolicy: 'Retain', updateReplacePolicy } } },
    ];
    expect(keptWhenRecordsEnded(replaced('Delete'))).toEqual([]);
    expect(keptWhenRecordsEnded(replaced('Retain')).map((k) => k.physicalId)).toEqual(['q1-old']);
  });
});

describe('loadKeptForWarning (go-to-k/cdkd#5760)', () => {
  const sources = (records: unknown[], runs: DeploymentEvent[][]) => ({
    earlierStateResources: async () => records as never,
    listRuns: async () => runs.map((_, i) => ({ runId: `r${runs.length - 1 - i}` })),
    readRunEvents: async (_s: string, _r: string, id: string) => runs[Number(id.slice(1))] ?? null,
  });

  it('names a resource both sources show once', async () => {
    const kept = await loadKeptForWarning(
      sources([{ resources: { Queue: { resourceType: 'AWS::SQS::Queue', physicalId: URL, deletionPolicy: 'Retain' } } }], [deployRun, destroyRun]),
      'App',
      'us-east-1'
    );
    expect(kept.map((k) => k.physicalId)).toEqual([URL]);
  });

  it('a kept resource a later run made again is not counted from the history', async () => {
    const later = (e: Partial<DeploymentEvent>) => ev({ ...e, timestamp: '2026-09-02T00:00:00.000Z' });
    const takenBack = [
      later({ eventType: 'RUN_STARTED', command: 'deploy' }),
      later({ eventType: 'RESOURCE_SUCCEEDED', operation: 'CREATE', logicalId: 'Queue', resourceType: 'AWS::SQS::Queue', physicalId: URL }),
      later({ eventType: 'RUN_FINISHED', result: 'SUCCEEDED' }),
    ];
    const kept = await loadKeptForWarning(sources([], [deployRun, destroyRun, takenBack]), 'App', 'us-east-1');
    expect(kept).toEqual([]);
  });
});

describe('rollbackRetainedInEventHistory (go-to-k/cdkd#5143)', () => {
  const survivorReason = retainedSurvivorMessages('Logs', 'AWS::Logs::LogGroup', '/aws/lambda/new', '').reason;
  const ev = (over: Record<string, unknown>): DeploymentEvent =>
    ({
      eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
      stackName: 'S',
      operation: 'UPDATE',
      logicalId: 'Logs',
      resourceType: 'AWS::Logs::LogGroup',
      physicalId: '/aws/lambda/new',
      reason: survivorReason,
      timestamp: '2026-10-21T00:00:00.000Z',
      ...over,
    }) as unknown as DeploymentEvent;

  it('reads the survivor the rollback message writes, whatever follows its reason', () => {
    expect(survivorReason.startsWith(RETAINED_SURVIVOR_REASON_PREFIX)).toBe(true);
    expect(
      rollbackRetainedInEventHistory([[ev({}), ev({ reason: `${survivorReason}; and more` })]], 'S')
    ).toEqual([
      { logicalId: 'Logs', resourceType: 'AWS::Logs::LogGroup', physicalId: '/aws/lambda/new' },
      { logicalId: 'Logs', resourceType: 'AWS::Logs::LogGroup', physicalId: '/aws/lambda/new' },
    ]);
  });

  it.each([
    ['another stack', { stackName: 'T' }],
    ['another event type', { eventType: 'RESOURCE_SUCCEEDED' }],
    ['no survivor id', { physicalId: undefined }],
    ['another reason', { reason: 'The re-create returned the live new resource' }],
  ])('ignores %s', (_n, over) => {
    expect(rollbackRetainedInEventHistory([[ev(over)]], 'S')).toEqual([]);
  });

  it("reads a nested child's survivors from its top-level stack's runs", async () => {
    const listRuns = vi.fn().mockResolvedValue([{ runId: 'r1' }]);
    const readRunEvents = vi
      .fn()
      .mockResolvedValue([ev({ stackName: 'P~C' }), ev({ stackName: 'P' })]);

    const copies = await loadRollbackRetainedCopies({ listRuns, readRunEvents }, 'P~C', 'us-east-1');

    expect(listRuns).toHaveBeenCalledWith('P', 'us-east-1');
    expect(readRunEvents).toHaveBeenCalledWith('P', 'us-east-1', 'r1');
    expect(copies).toHaveLength(1);
  });

  it('answers none when the history cannot be listed', async () => {
    const listRuns = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    expect(await loadRollbackRetainedCopies({ listRuns, readRunEvents: vi.fn() }, 'S', 'us-east-1')).toEqual([]);
  });
});
