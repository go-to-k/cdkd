import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  DeploymentEventsStore,
  DeploymentEventsReader,
  DEPLOYMENT_EVENTS_MAX_INDEX_RUNS,
  deploymentEventsKey,
  deploymentEventsIndexKey,
  newDeploymentRunId,
} from '../../../src/state/deployment-events-store.js';
import { DEPLOYMENT_EVENTS_INDEX_VERSION } from '../../../src/types/deployment-events.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

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
  } as unknown as S3StateBackend;
  return {
    backend,
    objects,
    get putCalls() {
      return state.putCalls;
    },
  };
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
