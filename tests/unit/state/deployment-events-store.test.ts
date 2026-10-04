import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  DeploymentEventsStore,
  DeploymentEventsReader,
  DEPLOYMENT_EVENTS_MAX_INDEX_RUNS,
  DEPLOYMENT_EVENTS_OBJECT_DESCRIPTION,
  deploymentEventsKey,
  deploymentEventsIndexKey,
  newDeploymentRunId,
  runIdTimestampMs,
} from '../../../src/state/deployment-events-store.js';
import { DEPLOYMENT_EVENTS_INDEX_VERSION } from '../../../src/types/deployment-events.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { purgeNoncurrentKeyVersions } from '../../../src/state/s3-noncurrent-version-purge.js';

/**
 * In-memory fake of the raw-object surface the store + reader use on the
 * S3 state backend (`prefix`, `putRawObject`, `getRawObject`,
 * `listRawKeys`). Keeps tests off real S3 while exercising the exact key
 * layout + JSONL/index round-trip.
 */
function makeFakeBackend(opts?: { failPut?: boolean }): {
  backend: S3StateBackend;
  objects: Map<string, string>;
  putCalls: number;
} {
  const objects = new Map<string, string>();
  const state = { putCalls: 0 };
  const backend = {
    prefix: 'cdkd',
    putRawObject: vi.fn(async (key: string, body: string) => {
      state.putCalls++;
      if (opts?.failPut) throw new Error('AccessDenied: put failed');
      objects.set(key, body);
    }),
    getRawObject: vi.fn(async (key: string) => objects.get(key) ?? null),
    listRawKeys: vi.fn(async (keyPrefix: string) =>
      [...objects.keys()].filter((k) => k.startsWith(keyPrefix))
    ),
    deleteRawObjects: vi.fn(async (keys: string[]) => {
      for (const k of keys) objects.delete(k);
    }),
    purgeNoncurrentVersions: vi.fn(async () => {}),
  } as unknown as S3StateBackend;
  return {
    backend,
    objects,
    get putCalls() {
      return state.putCalls;
    },
  };
}

/** Time-sortable run id differing only in the millisecond field. */
function id(i: number): string {
  return `20260101T000000${String(i).padStart(3, '0')}Z-aa`;
}

/** Seed `objects` with a `.jsonl` per run id + a matching index.json. */
function seedRuns(objects: Map<string, string>, region: string, ids: string[]): void {
  const runs = [...ids]
    .sort()
    .reverse()
    .map((runId) => ({
      runId,
      command: 'deploy' as const,
      cdkdVersion: '0',
      startedAt: '',
      finishedAt: '',
      result: 'SUCCEEDED' as const,
      eventCount: 1,
    }));
  for (const runId of ids) {
    objects.set(`cdkd/S/${region}/deployments/${runId}.jsonl`, '{}\n');
  }
  objects.set(
    `cdkd/S/${region}/deployments/index.json`,
    JSON.stringify({
      indexVersion: DEPLOYMENT_EVENTS_INDEX_VERSION,
      stackName: 'S',
      region,
      runs,
      lastModified: 1,
    })
  );
}

describe('deployment-events-store key helpers', () => {
  it('builds the JSONL + index keys under deployments/', () => {
    expect(deploymentEventsKey('cdkd', 'MyStack', 'us-east-1', 'run-1')).toBe(
      'cdkd/MyStack/us-east-1/deployments/run-1.jsonl'
    );
    expect(deploymentEventsIndexKey('cdkd', 'MyStack', 'us-east-1')).toBe(
      'cdkd/MyStack/us-east-1/deployments/index.json'
    );
  });

  it('generates a time-sortable, unique run id', () => {
    const a = newDeploymentRunId(new Date('2026-06-13T01:23:45.678Z'));
    expect(a).toMatch(/^20260613T012345678Z-[0-9a-f]{8}$/);
    const b = newDeploymentRunId(new Date('2026-06-13T01:23:45.678Z'));
    expect(a).not.toBe(b); // random suffix differs even at the same instant
  });

  it('parses a run id timestamp back to epoch ms (round-trip with newDeploymentRunId)', () => {
    const runId = newDeploymentRunId(new Date('2026-06-13T01:23:45.678Z'));
    expect(runIdTimestampMs(runId)).toBe(Date.parse('2026-06-13T01:23:45.678Z'));
  });

  it('returns null for a run id without the canonical compact-ISO prefix', () => {
    expect(runIdTimestampMs('old-3')).toBeNull();
    expect(runIdTimestampMs('')).toBeNull();
  });
});

describe('DeploymentEventsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('persists buffered events as JSONL and never records resource properties', async () => {
    const { backend, objects } = makeFakeBackend();
    const store = new DeploymentEventsStore(backend, {
      stackName: 'MyStack',
      region: 'us-east-1',
      command: 'deploy',
      runId: 'run-1',
      cdkdVersion: '1.2.3',
    });

    store.record({
      eventType: 'RUN_STARTED',
      stackName: 'MyStack',
      command: 'deploy',
      region: 'us-east-1',
      cdkdVersion: '1.2.3',
    });
    store.record({
      eventType: 'RESOURCE_STARTED',
      stackName: 'MyStack',
      operation: 'CREATE',
      logicalId: 'Bucket',
      resourceType: 'AWS::S3::Bucket',
    });
    store.record({
      eventType: 'RESOURCE_SUCCEEDED',
      stackName: 'MyStack',
      operation: 'CREATE',
      logicalId: 'Bucket',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'mystack-bucket-123',
      provisionedBy: 'sdk',
      durationMs: 42,
    });
    store.record({
      eventType: 'RUN_FINISHED',
      stackName: 'MyStack',
      result: 'SUCCEEDED',
      counts: { created: 1, updated: 0, deleted: 0 },
    });

    await store.finalize('SUCCEEDED');

    const body = objects.get('cdkd/MyStack/us-east-1/deployments/run-1.jsonl');
    expect(body).toBeDefined();
    const lines = body!.trim().split('\n');
    expect(lines).toHaveLength(4);

    const parsed = lines.map((l) => JSON.parse(l));
    // Ordered, with timestamps stamped at record time.
    expect(parsed.map((e) => e.eventType)).toEqual([
      'RUN_STARTED',
      'RESOURCE_STARTED',
      'RESOURCE_SUCCEEDED',
      'RUN_FINISHED',
    ]);
    for (const e of parsed) {
      expect(typeof e.timestamp).toBe('string');
    }
    // SECURITY: no `properties` key on any event.
    expect(body).not.toContain('"properties"');
  });

  it('captures error metadata (name/message/code/requestId) on failure events', async () => {
    const { backend, objects } = makeFakeBackend();
    const store = new DeploymentEventsStore(backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: 'run-err',
    });
    store.record({
      eventType: 'RESOURCE_FAILED',
      stackName: 'S',
      operation: 'CREATE',
      logicalId: 'Q',
      resourceType: 'AWS::SQS::Queue',
      error: {
        name: 'ProvisioningError',
        message: 'boom',
        awsErrorCode: 'AccessDeniedException',
        requestId: 'req-123',
      },
    });
    await store.finalize('FAILED');
    const body = objects.get('cdkd/S/us-east-1/deployments/run-err.jsonl')!;
    const event = JSON.parse(body.trim());
    expect(event.error).toEqual({
      name: 'ProvisioningError',
      message: 'boom',
      awsErrorCode: 'AccessDeniedException',
      requestId: 'req-123',
    });
  });

  it('is best-effort: a failed S3 write never throws and warns at most once', async () => {
    const { backend } = makeFakeBackend({ failPut: true });
    let warnCount = 0;
    let debugCount = 0;
    const store = new DeploymentEventsStore(backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: 'run-fail',
    });
    // Reach into the private logger to capture warn/debug routing.
    (
      store as unknown as { logger: { warn: () => void; debug: () => void } }
    ).logger = {
      warn: () => warnCount++,
      debug: () => debugCount++,
    };

    store.record({ eventType: 'RESOURCE_STARTED', stackName: 'S', logicalId: 'A' });
    // First flush attempt (all puts throw) — must resolve, not reject.
    await expect(store.finalize('FAILED')).resolves.toBeUndefined();
    expect(warnCount).toBe(1); // first failure warns
    // A second forced flush attempt degrades to debug — warn stays one-shot.
    const internals = store as unknown as {
      finalized: boolean;
      persistedCount: number;
      enqueueWrite: (op: () => Promise<void>) => Promise<void>;
      doFlush: () => Promise<void>;
    };
    internals.finalized = false;
    internals.persistedCount = 0;
    await internals.enqueueWrite(() => internals.doFlush());
    expect(warnCount).toBe(1); // still one-shot
    expect(debugCount).toBeGreaterThanOrEqual(1);
  });

  it('does not create artifacts when no event was recorded', async () => {
    const { backend, objects } = makeFakeBackend();
    const store = new DeploymentEventsStore(backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'destroy',
      runId: 'empty',
    });
    await store.finalize('SUCCEEDED');
    expect(objects.size).toBe(0);
  });

  it('writes the index newest-first and truncates to the last N runs', async () => {
    const { backend, objects } = makeFakeBackend();
    // Pre-seed an index with MAX runs so the new run forces a truncation.
    const seeded = Array.from({ length: DEPLOYMENT_EVENTS_MAX_INDEX_RUNS }, (_, i) => ({
      runId: `old-${i}`,
      command: 'deploy' as const,
      cdkdVersion: '0.0.0',
      startedAt: 's',
      finishedAt: 'f',
      result: 'SUCCEEDED' as const,
      eventCount: 1,
    }));
    objects.set(
      'cdkd/S/us-east-1/deployments/index.json',
      JSON.stringify({
        indexVersion: DEPLOYMENT_EVENTS_INDEX_VERSION,
        stackName: 'S',
        region: 'us-east-1',
        runs: seeded,
        lastModified: 1,
      })
    );

    const store = new DeploymentEventsStore(backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: 'new-run',
    });
    store.record({ eventType: 'RESOURCE_STARTED', stackName: 'S', logicalId: 'A' });
    await store.finalize('SUCCEEDED');

    const index = JSON.parse(objects.get('cdkd/S/us-east-1/deployments/index.json')!);
    expect(index.runs).toHaveLength(DEPLOYMENT_EVENTS_MAX_INDEX_RUNS);
    expect(index.runs[0].runId).toBe('new-run'); // newest first
    expect(index.runs.map((r: { runId: string }) => r.runId)).not.toContain(
      `old-${DEPLOYMENT_EVENTS_MAX_INDEX_RUNS - 1}`
    ); // oldest dropped
  });

  it('auto-prunes superseded .jsonl streams beyond the index window on finalize', async () => {
    const { backend, objects } = makeFakeBackend();
    const N = DEPLOYMENT_EVENTS_MAX_INDEX_RUNS;
    // Pre-seed N existing runs (ids 000..N-1), each with a .jsonl + index.
    seedRuns(
      objects,
      'us-east-1',
      Array.from({ length: N }, (_, i) => id(i))
    );

    // A new run whose id sorts newest forces the oldest out of the window.
    const newId = id(N);
    const store = new DeploymentEventsStore(backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: newId,
    });
    store.record({ eventType: 'RESOURCE_STARTED', stackName: 'S', logicalId: 'A' });
    await store.finalize('SUCCEEDED');

    // Kept window = [newId, id(N-1)..id(1)] -> oldest retained is id(1).
    // id(0) is superseded and its .jsonl is deleted; id(1).. survive.
    expect(objects.has(`cdkd/S/us-east-1/deployments/${id(0)}.jsonl`)).toBe(false);
    expect(objects.has(`cdkd/S/us-east-1/deployments/${id(1)}.jsonl`)).toBe(true);
    expect(objects.has(`cdkd/S/us-east-1/deployments/${newId}.jsonl`)).toBe(true);
  });

  it('does not prune .jsonl streams while below the index window', async () => {
    const { backend, objects } = makeFakeBackend();
    seedRuns(objects, 'us-east-1', [id(0), id(1)]);
    const store = new DeploymentEventsStore(backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: id(2),
    });
    store.record({ eventType: 'RESOURCE_STARTED', stackName: 'S', logicalId: 'A' });
    await store.finalize('SUCCEEDED');
    expect(objects.has(`cdkd/S/us-east-1/deployments/${id(0)}.jsonl`)).toBe(true);
    expect(objects.has(`cdkd/S/us-east-1/deployments/${id(1)}.jsonl`)).toBe(true);
  });

  it('does not LIST the deployments prefix at all while below the index window', async () => {
    // The prune LIST is now issued speculatively alongside the index PUT, so
    // it must stay gated on "the window is full" — otherwise every deploy of
    // every small stack would pay a brand-new S3 LIST it never used before.
    const { backend, objects } = makeFakeBackend();
    seedRuns(objects, 'us-east-1', [id(0)]);
    const store = new DeploymentEventsStore(backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: id(1),
    });
    store.record({ eventType: 'RESOURCE_STARTED', stackName: 'S', logicalId: 'A' });
    await store.finalize('SUCCEEDED');
    expect(backend.listRawKeys).not.toHaveBeenCalled();
  });

  it('overlaps the index READ with the event flush but still WRITES the index after it', async () => {
    // The durability contract: the index may never advertise a run whose
    // event stream has not been persisted. The read is free to overlap (it
    // touches a different object); the write is not.
    const { backend, objects } = makeFakeBackend();
    const order: string[] = [];
    const jsonlKey = `cdkd/S/us-east-1/deployments/${id(1)}.jsonl`;
    const indexKey = 'cdkd/S/us-east-1/deployments/index.json';
    let releaseFlush: () => void = () => {};
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });

    vi.mocked(backend.getRawObject).mockImplementation(async (key: string) => {
      order.push(`get:${key}`);
      return objects.get(key) ?? null;
    });
    vi.mocked(backend.putRawObject).mockImplementation(async (key: string, body: string) => {
      order.push(`put:${key}`);
      if (key === jsonlKey) await flushGate;
      objects.set(key, body);
    });

    const store = new DeploymentEventsStore(backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: id(1),
    });
    store.record({ eventType: 'RESOURCE_STARTED', stackName: 'S', logicalId: 'A' });
    const finalized = store.finalize('SUCCEEDED');

    // Let the microtask queue settle while the flush PUT is still pending.
    await new Promise((resolve) => setImmediate(resolve));
    // The index READ was issued without waiting for the flush to resolve...
    expect(order).toContain(`get:${indexKey}`);
    // ...but the index WRITE has not happened yet.
    expect(order).not.toContain(`put:${indexKey}`);

    releaseFlush();
    await finalized;

    expect(order.indexOf(`put:${jsonlKey}`)).toBeLessThan(order.indexOf(`put:${indexKey}`));
    expect(JSON.parse(objects.get(indexKey)!).runs[0].runId).toBe(id(1));
  });

  it('deletes superseded streams only AFTER the index PUT that dropped them', async () => {
    const { backend, objects } = makeFakeBackend();
    const N = DEPLOYMENT_EVENTS_MAX_INDEX_RUNS;
    seedRuns(
      objects,
      'us-east-1',
      Array.from({ length: N }, (_, i) => id(i))
    );
    const order: string[] = [];
    const indexKey = 'cdkd/S/us-east-1/deployments/index.json';
    vi.mocked(backend.putRawObject).mockImplementation(async (key: string, body: string) => {
      order.push(`put:${key}`);
      objects.set(key, body);
    });
    vi.mocked(backend.listRawKeys).mockImplementation(async (keyPrefix: string) => {
      order.push('list');
      return [...objects.keys()].filter((k) => k.startsWith(keyPrefix));
    });
    vi.mocked(backend.deleteRawObjects).mockImplementation(async (keys: string[]) => {
      order.push('delete');
      for (const k of keys) objects.delete(k);
    });

    const store = new DeploymentEventsStore(backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: id(N),
    });
    store.record({ eventType: 'RESOURCE_STARTED', stackName: 'S', logicalId: 'A' });
    await store.finalize('SUCCEEDED');

    // The LIST may be issued before the index PUT (it is read-only), but the
    // DELETE must not be: a stream is only removed once the index that no
    // longer references it is durable.
    expect(order.indexOf('delete')).toBeGreaterThan(order.indexOf(`put:${indexKey}`));
    expect(objects.has(`cdkd/S/us-east-1/deployments/${id(0)}.jsonl`)).toBe(false);
  });

  it('never deletes a superseded stream when the index PUT fails', async () => {
    const { backend, objects } = makeFakeBackend();
    const N = DEPLOYMENT_EVENTS_MAX_INDEX_RUNS;
    seedRuns(
      objects,
      'us-east-1',
      Array.from({ length: N }, (_, i) => id(i))
    );
    const indexKey = 'cdkd/S/us-east-1/deployments/index.json';
    vi.mocked(backend.putRawObject).mockImplementation(async (key: string, body: string) => {
      if (key === indexKey) throw new Error('AccessDenied: index put failed');
      objects.set(key, body);
    });

    const store = new DeploymentEventsStore(backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: id(N),
    });
    store.record({ eventType: 'RESOURCE_STARTED', stackName: 'S', logicalId: 'A' });
    // finalize is best-effort — it warns rather than throwing.
    await expect(store.finalize('SUCCEEDED')).resolves.toBeUndefined();

    expect(backend.deleteRawObjects).not.toHaveBeenCalled();
    expect(objects.has(`cdkd/S/us-east-1/deployments/${id(0)}.jsonl`)).toBe(true);
  });

  it('rebuilds the index from this run alone when the existing index is corrupt', async () => {
    const { backend, objects } = makeFakeBackend();
    objects.set('cdkd/S/us-east-1/deployments/index.json', '{not valid json');
    const store = new DeploymentEventsStore(backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: 'r1',
    });
    store.record({ eventType: 'RESOURCE_STARTED', stackName: 'S', logicalId: 'A' });
    await store.finalize('SUCCEEDED');
    const index = JSON.parse(objects.get('cdkd/S/us-east-1/deployments/index.json')!);
    expect(index.runs).toHaveLength(1);
    expect(index.runs[0].runId).toBe('r1');
  });
});

describe('DeploymentEventsReader', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists runs from the index newest-first', async () => {
    const { backend, objects } = makeFakeBackend();
    objects.set(
      'cdkd/S/us-east-1/deployments/index.json',
      JSON.stringify({
        indexVersion: DEPLOYMENT_EVENTS_INDEX_VERSION,
        stackName: 'S',
        region: 'us-east-1',
        runs: [
          { runId: 'b', command: 'deploy', cdkdVersion: '1', startedAt: '', finishedAt: '', result: 'SUCCEEDED', eventCount: 2 },
          { runId: 'a', command: 'destroy', cdkdVersion: '1', startedAt: '', finishedAt: '', result: 'FAILED', eventCount: 1 },
        ],
        lastModified: 1,
      })
    );
    const reader = new DeploymentEventsReader(backend);
    const runs = await reader.listRuns('S', 'us-east-1');
    expect(runs.map((r) => r.runId)).toEqual(['b', 'a']);
  });

  it('falls back to JSONL key enumeration when the index is missing', async () => {
    const { backend, objects } = makeFakeBackend();
    objects.set('cdkd/S/us-east-1/deployments/20260101T000000000Z-aaa.jsonl', '{}\n');
    objects.set('cdkd/S/us-east-1/deployments/20260102T000000000Z-bbb.jsonl', '{}\n');
    const reader = new DeploymentEventsReader(backend);
    const runs = await reader.listRuns('S', 'us-east-1');
    // Newest (lexically-largest time prefix) first.
    expect(runs.map((r) => r.runId)).toEqual([
      '20260102T000000000Z-bbb',
      '20260101T000000000Z-aaa',
    ]);
  });

  it('fallback derives the true result from the run JSONL (no FAILED fabrication)', async () => {
    const { backend, objects } = makeFakeBackend();
    // A SUCCEEDED run whose index write lost the race: its JSONL carries a
    // terminal RUN_FINISHED { result: SUCCEEDED } but there is NO index.json.
    objects.set(
      'cdkd/S/us-east-1/deployments/20260103T000000000Z-ok.jsonl',
      [
        JSON.stringify({
          timestamp: '2026-01-03T00:00:00.000Z',
          eventType: 'RUN_STARTED',
          stackName: 'S',
          command: 'deploy',
          region: 'us-east-1',
          cdkdVersion: '9.9.9',
        }),
        JSON.stringify({
          timestamp: '2026-01-03T00:01:00.000Z',
          eventType: 'RUN_FINISHED',
          stackName: 'S',
          result: 'SUCCEEDED',
        }),
        '',
      ].join('\n')
    );
    // A destroy run that genuinely failed.
    objects.set(
      'cdkd/S/us-east-1/deployments/20260102T000000000Z-bad.jsonl',
      [
        JSON.stringify({
          timestamp: '2026-01-02T00:00:00.000Z',
          eventType: 'RUN_STARTED',
          stackName: 'S',
          command: 'destroy',
          cdkdVersion: '1.0.0',
        }),
        JSON.stringify({
          timestamp: '2026-01-02T00:00:30.000Z',
          eventType: 'RUN_FINISHED',
          stackName: 'S',
          result: 'FAILED',
        }),
        '',
      ].join('\n')
    );
    // An interrupted run: no terminal RUN_FINISHED at all.
    objects.set(
      'cdkd/S/us-east-1/deployments/20260101T000000000Z-torn.jsonl',
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'RUN_STARTED',
        stackName: 'S',
        command: 'deploy',
        cdkdVersion: '2.0.0',
      }) + '\n'
    );

    const reader = new DeploymentEventsReader(backend);
    const runs = await reader.listRuns('S', 'us-east-1');

    // Newest first; results derived from each run's own JSONL.
    expect(runs.map((r) => ({ runId: r.runId, result: r.result, command: r.command }))).toEqual([
      { runId: '20260103T000000000Z-ok', result: 'SUCCEEDED', command: 'deploy' },
      { runId: '20260102T000000000Z-bad', result: 'FAILED', command: 'destroy' },
      // No RUN_FINISHED -> UNKNOWN, NOT fabricated as FAILED.
      { runId: '20260101T000000000Z-torn', result: 'UNKNOWN', command: 'deploy' },
    ]);
    // The successful run carries the mined version + timestamps.
    expect(runs[0]!.cdkdVersion).toBe('9.9.9');
    expect(runs[0]!.startedAt).toBe('2026-01-03T00:00:00.000Z');
    expect(runs[0]!.finishedAt).toBe('2026-01-03T00:01:00.000Z');
    expect(runs[0]!.eventCount).toBe(2);
  });

  it('fallback reports UNKNOWN for an empty/torn JSONL', async () => {
    const { backend, objects } = makeFakeBackend();
    objects.set('cdkd/S/us-east-1/deployments/20260101T000000000Z-empty.jsonl', '\n');
    const reader = new DeploymentEventsReader(backend);
    const runs = await reader.listRuns('S', 'us-east-1');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result).toBe('UNKNOWN');
    expect(runs[0]!.command).toBe('deploy');
  });

  it('reads a single run, skipping torn/malformed lines', async () => {
    const { backend, objects } = makeFakeBackend();
    objects.set(
      'cdkd/S/us-east-1/deployments/r1.jsonl',
      [
        JSON.stringify({ timestamp: 't1', eventType: 'RUN_STARTED', stackName: 'S' }),
        '{ this is a torn line',
        JSON.stringify({ timestamp: 't2', eventType: 'RUN_FINISHED', stackName: 'S', result: 'SUCCEEDED' }),
        '',
      ].join('\n')
    );
    const reader = new DeploymentEventsReader(backend);
    const events = await reader.readRunEvents('S', 'us-east-1', 'r1');
    expect(events).not.toBeNull();
    expect(events!.map((e) => e.eventType)).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
  });

  it('returns null for a non-existent run', async () => {
    const { backend } = makeFakeBackend();
    const reader = new DeploymentEventsReader(backend);
    expect(await reader.readRunEvents('S', 'us-east-1', 'nope')).toBeNull();
  });

  it('discovers regions from the raw key listing (survives destroy)', async () => {
    const { backend, objects } = makeFakeBackend();
    objects.set('cdkd/S/us-east-1/deployments/r1.jsonl', '{}\n');
    objects.set('cdkd/S/eu-west-1/deployments/index.json', '{}');
    // A state.json sibling must NOT be mistaken for a region with events.
    objects.set('cdkd/S/us-east-1/state.json', '{}');
    const reader = new DeploymentEventsReader(backend);
    expect(await reader.listRegions('S')).toEqual(['eu-west-1', 'us-east-1']);
  });
});

describe('DeploymentEventsReader.pruneRuns', () => {
  const DAY = 24 * 60 * 60 * 1000;
  beforeEach(() => vi.clearAllMocks());

  it('--all deletes every run and the index', async () => {
    const { backend, objects } = makeFakeBackend();
    seedRuns(objects, 'us-east-1', [id(0), id(1), id(2)]);
    const reader = new DeploymentEventsReader(backend);
    const r = await reader.pruneRuns('S', 'us-east-1', { all: true });
    expect([...r.deletedRunIds].sort()).toEqual([id(0), id(1), id(2)]);
    expect(r.remainingRunIds).toEqual([]);
    expect(r.indexDeleted).toBe(true);
    expect([...objects.keys()].filter((k) => k.includes('/deployments/'))).toEqual([]);
  });

  // Issue #2624: `indexDeleted` must report an index that EXISTED, not the
  // success of a `DeleteObjects` call, which succeeds on an absent key too.
  // Both callers (`cdkd events prune`, `purgeEventsAfterDestroy`) print a
  // removal claim when it is true.
  it('--all on an empty prefix reports no index deleted (nothing existed)', async () => {
    const { backend } = makeFakeBackend();
    const reader = new DeploymentEventsReader(backend);
    const r = await reader.pruneRuns('S', 'us-east-1', { all: true });
    expect(r.deletedRunIds).toEqual([]);
    expect(r.remainingRunIds).toEqual([]);
    expect(r.indexDeleted).toBe(false);
  });

  it('--all with run streams but no index reports the runs, not an index', async () => {
    const { backend, objects } = makeFakeBackend();
    objects.set(`cdkd/S/us-east-1/deployments/${id(0)}.jsonl`, '{}\n');
    const reader = new DeploymentEventsReader(backend);
    const r = await reader.pruneRuns('S', 'us-east-1', { all: true });
    expect(r.deletedRunIds).toEqual([id(0)]);
    expect(r.indexDeleted).toBe(false);
    expect([...objects.keys()].filter((k) => k.includes('/deployments/'))).toEqual([]);
  });

  it('--all with only an index (no run streams) reports the index deleted', async () => {
    const { backend, objects } = makeFakeBackend();
    objects.set('cdkd/S/us-east-1/deployments/index.json', '{"runs":[]}');
    const reader = new DeploymentEventsReader(backend);
    const r = await reader.pruneRuns('S', 'us-east-1', { all: true });
    expect(r.deletedRunIds).toEqual([]);
    expect(r.indexDeleted).toBe(true);
    expect(objects.has('cdkd/S/us-east-1/deployments/index.json')).toBe(false);
  });

  it('--keep 0 with run streams but no index reports no index deleted', async () => {
    const { backend, objects } = makeFakeBackend();
    // The count path's empty-remainder branch deletes the index key the same
    // way the --all arm does, so it owes the same existence-based report.
    objects.set(`cdkd/S/us-east-1/deployments/${id(0)}.jsonl`, '{}\n');
    objects.set(`cdkd/S/us-east-1/deployments/${id(1)}.jsonl`, '{}\n');
    const reader = new DeploymentEventsReader(backend);
    const r = await reader.pruneRuns('S', 'us-east-1', { keep: 0 });
    expect([...r.deletedRunIds].sort()).toEqual([id(0), id(1)]);
    expect(r.remainingRunIds).toEqual([]);
    expect(r.indexDeleted).toBe(false);
  });

  it('--keep retains the newest N and rewrites the index', async () => {
    const { backend, objects } = makeFakeBackend();
    seedRuns(objects, 'us-east-1', [id(0), id(1), id(2), id(3)]);
    const reader = new DeploymentEventsReader(backend);
    const r = await reader.pruneRuns('S', 'us-east-1', { keep: 2 });
    expect([...r.deletedRunIds].sort()).toEqual([id(0), id(1)]);
    expect(r.remainingRunIds).toEqual([id(3), id(2)]); // newest-first
    expect(r.indexDeleted).toBe(false);
    expect(objects.has(`cdkd/S/us-east-1/deployments/${id(0)}.jsonl`)).toBe(false);
    expect(objects.has(`cdkd/S/us-east-1/deployments/${id(2)}.jsonl`)).toBe(true);
    const idx = JSON.parse(objects.get('cdkd/S/us-east-1/deployments/index.json')!);
    expect(idx.runs.map((x: { runId: string }) => x.runId)).toEqual([id(3), id(2)]);
  });

  it('with no flags defaults to keeping the index window', async () => {
    const { backend, objects } = makeFakeBackend();
    const ids = Array.from({ length: DEPLOYMENT_EVENTS_MAX_INDEX_RUNS + 3 }, (_, i) => id(i));
    seedRuns(objects, 'us-east-1', ids);
    const reader = new DeploymentEventsReader(backend);
    const r = await reader.pruneRuns('S', 'us-east-1', {});
    expect(r.deletedRunIds).toHaveLength(3);
    expect(r.remainingRunIds).toHaveLength(DEPLOYMENT_EVENTS_MAX_INDEX_RUNS);
  });

  it('--older-than deletes by run-id timestamp and keeps unparseable / recent runs', async () => {
    const { backend, objects } = makeFakeBackend();
    seedRuns(objects, 'us-east-1', [
      '20260101T000000000Z-a',
      '20260103T000000000Z-b',
      '20260105T000000000Z-c',
      'weird-run',
    ]);
    const reader = new DeploymentEventsReader(backend);
    const r = await reader.pruneRuns('S', 'us-east-1', {
      olderThanMs: 2 * DAY,
      now: new Date('2026-01-06T00:00:00.000Z'),
    });
    expect([...r.deletedRunIds].sort()).toEqual(['20260101T000000000Z-a', '20260103T000000000Z-b']);
    expect(objects.has('cdkd/S/us-east-1/deployments/weird-run.jsonl')).toBe(true);
    expect(objects.has('cdkd/S/us-east-1/deployments/20260105T000000000Z-c.jsonl')).toBe(true);
  });

  it('--keep + --older-than only deletes runs that are BOTH beyond keep AND older', async () => {
    const { backend, objects } = makeFakeBackend();
    seedRuns(objects, 'us-east-1', [
      '20260101T000000000Z-a',
      '20260102T000000000Z-b',
      '20260103T000000000Z-c',
      '20260104T000000000Z-d',
    ]);
    const reader = new DeploymentEventsReader(backend);
    // keep 2 -> protect Jan4, Jan3. cutoff = now - 1.5d = Jan2 12:00 -> Jan1,Jan2 old.
    // Intersection (beyond-keep = Jan2,Jan1) AND (older = Jan2,Jan1) = Jan1,Jan2.
    const r = await reader.pruneRuns('S', 'us-east-1', {
      keep: 2,
      olderThanMs: 1.5 * DAY,
      now: new Date('2026-01-04T00:00:00.000Z'),
    });
    expect([...r.deletedRunIds].sort()).toEqual(['20260101T000000000Z-a', '20260102T000000000Z-b']);
  });

  it('returns an empty deletion set (and leaves the index) when nothing matches', async () => {
    const { backend, objects } = makeFakeBackend();
    seedRuns(objects, 'us-east-1', [id(0), id(1)]);
    const reader = new DeploymentEventsReader(backend);
    const r = await reader.pruneRuns('S', 'us-east-1', { keep: 5 });
    expect(r.deletedRunIds).toEqual([]);
    expect([...r.remainingRunIds].sort()).toEqual([id(0), id(1)]);
    expect(objects.has('cdkd/S/us-east-1/deployments/index.json')).toBe(true);
  });

  it('--keep 0 deletes every run and removes the index (noRunsRemain via the count path)', async () => {
    const { backend, objects } = makeFakeBackend();
    seedRuns(objects, 'us-east-1', [id(0), id(1), id(2)]);
    const reader = new DeploymentEventsReader(backend);
    // keep 0 protects nothing — distinct from --all but reaches the same
    // empty-remainder index-delete branch in pruneRuns.
    const r = await reader.pruneRuns('S', 'us-east-1', { keep: 0 });
    expect([...r.deletedRunIds].sort()).toEqual([id(0), id(1), id(2)]);
    expect(r.remainingRunIds).toEqual([]);
    expect(r.indexDeleted).toBe(true);
    expect(objects.has('cdkd/S/us-east-1/deployments/index.json')).toBe(false);
  });

  it('surfaces a delete failure to the caller (does not silently report success)', async () => {
    const { backend, objects } = makeFakeBackend();
    seedRuns(objects, 'us-east-1', [id(0), id(1), id(2)]);
    // The explicit-purge path must NOT swallow a delete error — unlike the
    // writer's best-effort auto-prune, it propagates so the command exits
    // non-zero rather than reporting success while orphans remain.
    (backend.deleteRawObjects as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('AccessDenied: delete failed')
    );
    const reader = new DeploymentEventsReader(backend);
    await expect(reader.pruneRuns('S', 'us-east-1', { keep: 1 })).rejects.toThrow(/delete failed/);
  });
});

/**
 * Issue #2624: every delete under `deployments/` also purges the deleted keys'
 * NONCURRENT versions. Exercised against an in-memory S3 that models
 * versioning, with the backend's `purgeNoncurrentVersions` wired to the REAL
 * shared purge helper, so the assertions read what an S3 version listing
 * would show afterwards rather than which mock was called.
 */
describe('deployments/ deletes purge noncurrent versions (issue #2624)', () => {
  type Version = { versionId: string; body: string | null }; // null = delete marker

  function makeVersionedBackend(
    versioned: boolean,
    bucket: string,
    opts: { failDelete?: boolean; failList?: boolean } = {}
  ) {
    const store = new Map<string, Version[]>(); // oldest first
    let seq = 0;
    const versionDeletes: { Key: string; VersionId: string }[] = [];
    const latest = (k: string): Version | undefined => store.get(k)?.at(-1);
    const client = {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: any }) => {
        const name = cmd.constructor.name;
        if (name === 'ListObjectVersionsCommand') {
          if (opts.failList) {
            throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
          }
          const Versions: unknown[] = [];
          const DeleteMarkers: unknown[] = [];
          for (const [Key, versions] of store) {
            if (!Key.startsWith(cmd.input.Prefix)) continue;
            versions.forEach((v, i) => {
              const entry = {
                Key: encodeURIComponent(Key),
                VersionId: v.versionId,
                IsLatest: i === versions.length - 1,
              };
              (v.body === null ? DeleteMarkers : Versions).push(entry);
            });
          }
          return { Versions, DeleteMarkers, IsTruncated: false };
        }
        if (name === 'DeleteObjectsCommand') {
          for (const o of cmd.input.Delete.Objects as { Key: string; VersionId: string }[]) {
            versionDeletes.push(o);
            const versions = store.get(o.Key) ?? [];
            store.set(
              o.Key,
              versions.filter((v) => v.versionId !== o.VersionId)
            );
          }
          return {};
        }
        if (name === 'GetBucketReplicationCommand') {
          throw Object.assign(new Error('none'), { name: 'ReplicationConfigurationNotFoundError' });
        }
        throw new Error(`unexpected command ${name}`);
      }),
    };
    const warn = vi.fn();
    const backend = {
      prefix: 'cdkd',
      putRawObject: vi.fn(async (key: string, body: string) => {
        if (versioned) {
          store.set(key, [...(store.get(key) ?? []), { versionId: `v${seq++}`, body }]);
        } else {
          store.set(key, [{ versionId: 'null', body }]);
        }
      }),
      getRawObject: vi.fn(async (key: string) => latest(key)?.body ?? null),
      listRawKeys: vi.fn(async (keyPrefix: string) =>
        [...store.keys()].filter((k) => k.startsWith(keyPrefix) && (latest(k)?.body ?? null) !== null)
      ),
      deleteRawObjects: vi.fn(async (keys: string[]) => {
        // A failed DeleteObjects writes nothing: every key keeps its CURRENT body.
        if (opts.failDelete) throw new Error('AccessDenied: delete');
        for (const k of keys) {
          if (versioned) {
            store.set(k, [...(store.get(k) ?? []), { versionId: `v${seq++}`, body: null }]);
          } else {
            store.delete(k);
          }
        }
      }),
      purgeNoncurrentVersions: vi.fn(
        async (keys: string[], opts: { listPrefix?: string; objectDescription?: string } = {}) =>
          purgeNoncurrentKeyVersions(client as never, bucket, keys, {
            ...opts,
            logger: { warn, debug: () => {} },
          })
      ),
    } as unknown as S3StateBackend;
    /** Every readable BODY version still stored for `key`. */
    const bodies = (key: string): string[] =>
      (store.get(key) ?? []).filter((v) => v.body !== null).map((v) => v.body!);
    return { backend, store, bodies, versionDeletes, warn };
  }

  const dir = 'cdkd/S/us-east-1/deployments/';
  const stream = (runId: string) => `${dir}${runId}.jsonl`;
  const indexKey = `${dir}index.json`;

  /** Seed runs the way the writer does: one full re-PUT per flush. */
  async function seed(backend: S3StateBackend, ids: string[], flushes: number): Promise<void> {
    for (const runId of ids) {
      for (let f = 1; f <= flushes; f++) {
        await backend.putRawObject(stream(runId), `{"flush":${f}}\n`);
      }
    }
    const runs = [...ids].sort().reverse().map((runId) => ({ runId, result: 'SUCCEEDED' }));
    await backend.putRawObject(indexKey, JSON.stringify({ runs }));
    await backend.putRawObject(indexKey, JSON.stringify({ runs }));
  }

  it('versioned: --all leaves no readable body of any stream or the index', async () => {
    const m = makeVersionedBackend(true, 'bucket-all');
    // A sibling stack whose name extends this one's (`S` / `S2`). The trailing
    // `/` of the listing prefix keeps it out of the walk entirely; the
    // `wanted` filter within one prefix is exercised by the --keep case.
    await m.backend.putRawObject('cdkd/S2/us-east-1/deployments/x.jsonl', 'other\n');
    await m.backend.putRawObject('cdkd/S2/us-east-1/deployments/x.jsonl', 'other2\n');
    await seed(m.backend, [id(0), id(1)], 3);
    expect(m.bodies(stream(id(0)))).toHaveLength(3); // precondition: history exists

    const r = await new DeploymentEventsReader(m.backend).pruneRuns('S', 'us-east-1', { all: true });

    expect(r.indexDeleted).toBe(true);
    for (const k of [stream(id(0)), stream(id(1)), indexKey]) expect(m.bodies(k)).toEqual([]);
    expect(m.bodies('cdkd/S2/us-east-1/deployments/x.jsonl')).toHaveLength(2);
    expect(m.warn).not.toHaveBeenCalled();
    expect(m.backend.purgeNoncurrentVersions).toHaveBeenCalledWith(
      expect.arrayContaining([stream(id(0)), stream(id(1)), indexKey]),
      expect.objectContaining({ listPrefix: dir })
    );
  });

  it('versioned: --keep purges only the pruned streams, never a retained run', async () => {
    const m = makeVersionedBackend(true, 'bucket-keep');
    await seed(m.backend, [id(0), id(1), id(2)], 2);

    await new DeploymentEventsReader(m.backend).pruneRuns('S', 'us-east-1', { keep: 1 });

    expect(m.bodies(stream(id(0)))).toEqual([]);
    expect(m.bodies(stream(id(1)))).toEqual([]);
    // The retained run keeps its CURRENT body and its own history.
    expect(m.bodies(stream(id(2)))).toHaveLength(2);
    // The REWRITTEN index is not a deleted key: its history (two seeded PUTs
    // plus the rewrite) is untouched.
    expect(m.versionDeletes.some((d) => d.Key === indexKey)).toBe(false);
    expect(m.bodies(indexKey)).toHaveLength(3);
    expect(m.versionDeletes.some((d) => d.Key === stream(id(2)))).toBe(false);
    // Boundary of `keys.length > 1`: two keys already take the one-walk mode.
    expect(m.backend.purgeNoncurrentVersions).toHaveBeenCalledWith(
      [stream(id(1)), stream(id(0))],
      expect.objectContaining({ listPrefix: dir })
    );
  });

  it('versioned: --keep 0 also purges the deleted index', async () => {
    const m = makeVersionedBackend(true, 'bucket-keep0');
    await seed(m.backend, [id(0)], 2);
    const r = await new DeploymentEventsReader(m.backend).pruneRuns('S', 'us-east-1', { keep: 0 });
    expect(r.indexDeleted).toBe(true);
    expect(m.bodies(indexKey)).toEqual([]);
    expect(m.bodies(stream(id(0)))).toEqual([]);
    // One delete-and-purge covers streams and index together, as on `--all`:
    // one version walk, so at most one warning.
    expect(m.backend.purgeNoncurrentVersions).toHaveBeenCalledOnce();
    expect(m.backend.purgeNoncurrentVersions).toHaveBeenCalledWith(
      [stream(id(0)), indexKey],
      expect.objectContaining({ listPrefix: dir })
    );
  });

  it('versioned: a failed delete still purges the history, and every CURRENT body survives', async () => {
    const m = makeVersionedBackend(true, 'bucket-fail', { failDelete: true });
    await seed(m.backend, [id(0), id(1)], 3);

    await expect(
      new DeploymentEventsReader(m.backend).pruneRuns('S', 'us-east-1', { all: true })
    ).rejects.toThrow(/AccessDenied: delete/);

    // The `finally` purge ran (history gone) but the IsLatest filter kept the
    // current version of each key whose delete failed.
    expect(m.bodies(stream(id(0)))).toEqual(['{"flush":3}\n']);
    expect(m.bodies(stream(id(1)))).toEqual(['{"flush":3}\n']);
    expect(m.bodies(indexKey)).toHaveLength(1);
    expect(m.versionDeletes.length).toBeGreaterThan(0);
  });

  it('a purge that cannot list warns ONCE, naming the event store, and the prune still succeeds', async () => {
    const m = makeVersionedBackend(true, 'bucket-failList', { failList: true });
    await seed(m.backend, [id(0), id(1)], 2);

    const r = await new DeploymentEventsReader(m.backend).pruneRuns('S', 'us-east-1', { all: true });

    expect([...r.deletedRunIds].sort()).toEqual([id(0), id(1)]);
    expect(r.indexDeleted).toBe(true);
    expect(m.warn).toHaveBeenCalledTimes(1);
    // Pins the `objectDescription` wiring: without it the warning would name
    // the helper's generic default, not the object the user has to inspect.
    expect(String(m.warn.mock.calls[0]![0])).toContain(DEPLOYMENT_EVENTS_OBJECT_DESCRIPTION);
    // Nothing was purged: the history is still there behind the markers.
    expect(m.bodies(stream(id(0)))).toHaveLength(2);
  });

  it('a purge that cannot list does not mask the DELETE error', async () => {
    const m = makeVersionedBackend(true, 'bucket-failList-failDelete', {
      failList: true,
      failDelete: true,
    });
    await seed(m.backend, [id(0)], 2);

    await expect(
      new DeploymentEventsReader(m.backend).pruneRuns('S', 'us-east-1', { all: true })
    ).rejects.toThrow(/AccessDenied: delete/);
    expect(m.warn).toHaveBeenCalledTimes(1);
  });

  it('unversioned: a failed delete leaves every current null version in place', async () => {
    // The purge's listing DOES return entries here (each key's current
    // `VersionId: 'null'`, `IsLatest: true`), so this is the case that proves
    // the unversioned polarity removes nothing rather than finding nothing.
    const m = makeVersionedBackend(false, 'bucket-unversioned-fail', { failDelete: true });
    await seed(m.backend, [id(0), id(1)], 2);

    await expect(
      new DeploymentEventsReader(m.backend).pruneRuns('S', 'us-east-1', { all: true })
    ).rejects.toThrow(/AccessDenied: delete/);

    expect(m.versionDeletes).toEqual([]);
    for (const k of [stream(id(0)), stream(id(1)), indexKey]) expect(m.bodies(k)).toHaveLength(1);
    expect(m.warn).not.toHaveBeenCalled();
  });

  it('unversioned: --keep leaves the retained run and removes no version', async () => {
    const m = makeVersionedBackend(false, 'bucket-unversioned-keep');
    await seed(m.backend, [id(0), id(1), id(2)], 2);

    await new DeploymentEventsReader(m.backend).pruneRuns('S', 'us-east-1', { keep: 1 });

    // Guards the `wanted` filter (id(2) is not a deleted key); the IsLatest
    // polarity is pinned by the failed-delete case above.
    expect(m.versionDeletes).toEqual([]);
    expect(m.bodies(stream(id(2)))).toEqual(['{"flush":2}\n']);
    expect(m.store.has(stream(id(0)))).toBe(false);
  });

  it('unversioned: --all deletes as before and removes no version (nothing noncurrent exists)', async () => {
    const m = makeVersionedBackend(false, 'bucket-unversioned');
    await seed(m.backend, [id(0), id(1)], 3);

    const r = await new DeploymentEventsReader(m.backend).pruneRuns('S', 'us-east-1', { all: true });

    expect([...r.deletedRunIds].sort()).toEqual([id(0), id(1)]);
    expect(r.indexDeleted).toBe(true);
    expect([...m.store.keys()].filter((k) => k.startsWith(dir))).toEqual([]);
    expect(m.versionDeletes).toEqual([]);
    expect(m.warn).not.toHaveBeenCalled();
  });

  it("versioned: the writer's self-bounding prune purges the streams it drops", async () => {
    const m = makeVersionedBackend(true, 'bucket-writer');
    const N = DEPLOYMENT_EVENTS_MAX_INDEX_RUNS;
    await seed(
      m.backend,
      Array.from({ length: N }, (_, i) => id(i)),
      2
    );
    const store = new DeploymentEventsStore(m.backend, {
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: id(N),
    });
    store.record({ eventType: 'RESOURCE_STARTED', stackName: 'S', logicalId: 'A' });
    await store.finalize('SUCCEEDED');

    // id(0) fell out of the window: deleted AND its bodies purged, so no later
    // `--all` (which only sees CURRENT keys) is needed to reach them.
    expect(m.bodies(stream(id(0)))).toEqual([]);
    expect(m.bodies(stream(id(1)))).toHaveLength(2);
    expect(m.bodies(stream(id(N)))).not.toEqual([]);
    // One stale key walks only its own versions, not the whole prefix.
    expect(m.backend.purgeNoncurrentVersions).toHaveBeenCalledWith(
      [stream(id(0))],
      expect.not.objectContaining({ listPrefix: expect.anything() })
    );
  });

  it('still purges when the delete fails, and the delete error reaches the caller', async () => {
    const { backend, objects } = makeFakeBackend();
    seedRuns(objects, 'us-east-1', [id(0), id(1)]);
    vi.mocked(backend.deleteRawObjects).mockRejectedValueOnce(new Error('AccessDenied: delete'));
    await expect(
      new DeploymentEventsReader(backend).pruneRuns('S', 'us-east-1', { all: true })
    ).rejects.toThrow(/AccessDenied: delete/);
    expect(backend.purgeNoncurrentVersions).toHaveBeenCalledWith(
      [stream(id(1)), stream(id(0)), indexKey],
      expect.objectContaining({ listPrefix: dir })
    );
  });
});
