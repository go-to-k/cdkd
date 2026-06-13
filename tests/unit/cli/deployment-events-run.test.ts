import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  startRunRecorder,
  recordRunSucceeded,
  recordRunFailed,
} from '../../../src/cli/commands/deployment-events-run.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { DeploymentEvent, DeploymentRunResult } from '../../../src/types/deployment-events.js';

/**
 * In-memory fake of the raw-object surface the underlying
 * DeploymentEventsStore uses. Captures the persisted JSONL so the
 * run-level bracket can be asserted end-to-end (RUN_STARTED at start,
 * RUN_FINISHED at end, finalize() persistence).
 */
function makeFakeBackend(): { backend: S3StateBackend; objects: Map<string, string> } {
  const objects = new Map<string, string>();
  const backend = {
    prefix: 'cdkd',
    putRawObject: vi.fn(async (key: string, body: string) => {
      objects.set(key, body);
    }),
    getRawObject: vi.fn(async (key: string) => objects.get(key) ?? null),
    listRawKeys: vi.fn(async (keyPrefix: string) =>
      [...objects.keys()].filter((k) => k.startsWith(keyPrefix))
    ),
  } as unknown as S3StateBackend;
  return { backend, objects };
}

function eventsOf(objects: Map<string, string>, runId: string): DeploymentEvent[] {
  const body = objects.get(`cdkd/S/us-east-1/deployments/${runId}.jsonl`);
  if (!body) return [];
  return body
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as DeploymentEvent);
}

describe('deployment-events run-level bracket helpers (#808)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('--dry-run creates NO recorder and emits no events', async () => {
    const { backend, objects } = makeFakeBackend();
    const recorder = startRunRecorder({
      backend,
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      dryRun: true,
      runId: 'dry',
    });
    expect(recorder).toBeUndefined();
    // The helpers must tolerate an undefined recorder (no-op).
    recordRunSucceeded(recorder, 'S', { created: 1, updated: 0, deleted: 0 }, 10);
    recordRunFailed(recorder, 'S', new Error('boom'));
    expect(objects.size).toBe(0);
  });

  it('emits RUN_STARTED the moment the recorder is created', async () => {
    const { backend, objects } = makeFakeBackend();
    const recorder = startRunRecorder({
      backend,
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: 'r-started',
      cdkdVersion: '9.9.9',
    })!;
    expect(recorder).toBeDefined();
    await recorder.finalize('SUCCEEDED');
    const events = eventsOf(objects, 'r-started');
    expect(events.map((e) => e.eventType)).toEqual(['RUN_STARTED']);
    expect(events[0]!.command).toBe('deploy');
    expect(events[0]!.region).toBe('us-east-1');
    expect(events[0]!.cdkdVersion).toBe('9.9.9');
  });

  it('success path: RUN_FINISHED carries result SUCCEEDED + counts + durationMs', async () => {
    const { backend, objects } = makeFakeBackend();
    const recorder = startRunRecorder({
      backend,
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: 'r-ok',
    })!;
    recordRunSucceeded(recorder, 'S', { created: 3, updated: 1, deleted: 2 }, 1234);
    await recorder.finalize('SUCCEEDED');

    const events = eventsOf(objects, 'r-ok');
    expect(events.map((e) => e.eventType)).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
    const finished = events.find((e) => e.eventType === 'RUN_FINISHED')!;
    expect(finished.result).toBe('SUCCEEDED');
    expect(finished.counts).toEqual({ created: 3, updated: 1, deleted: 2 });
    expect(finished.durationMs).toBe(1234);

    // The index summary records SUCCEEDED.
    const index = JSON.parse(objects.get('cdkd/S/us-east-1/deployments/index.json')!);
    expect(index.runs[0].result).toBe('SUCCEEDED');
  });

  it('failure path: RUN_FINISHED carries FAILED + extracted error metadata (no properties)', async () => {
    const { backend, objects } = makeFakeBackend();
    const recorder = startRunRecorder({
      backend,
      stackName: 'S',
      region: 'us-east-1',
      command: 'deploy',
      runId: 'r-fail',
    })!;
    // An AWS-shaped error wrapped in an outer ProvisioningError-style error.
    const inner = new Error('not authorized') as Error & {
      $metadata?: { requestId?: string };
      Code?: string;
    };
    inner.name = 'AccessDeniedException';
    inner.$metadata = { requestId: 'req-77' };
    inner.Code = 'AccessDeniedException';
    const outer = new Error('Failed to create resource X') as Error & { cause?: unknown };
    outer.name = 'ProvisioningError';
    outer.cause = inner;

    let runResult: DeploymentRunResult = 'SUCCEEDED';
    try {
      runResult = 'FAILED';
      recordRunFailed(recorder, 'S', outer);
      throw outer;
    } catch {
      // swallow — the bracket's job is just to record the event.
    } finally {
      // finalize() is always called in the caller's finally.
      await recorder.finalize(runResult);
    }

    const events = eventsOf(objects, 'r-fail');
    expect(events.map((e) => e.eventType)).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
    const finished = events.find((e) => e.eventType === 'RUN_FINISHED')!;
    expect(finished.result).toBe('FAILED');
    expect(finished.error?.name).toBe('ProvisioningError');
    expect(finished.error?.message).toBe('Failed to create resource X');
    expect(finished.error?.awsErrorCode).toBe('AccessDeniedException');
    expect(finished.error?.requestId).toBe('req-77');
    // SECURITY: error metadata only — never resource properties.
    expect(JSON.stringify(events)).not.toContain('"properties"');

    const index = JSON.parse(objects.get('cdkd/S/us-east-1/deployments/index.json')!);
    expect(index.runs[0].result).toBe('FAILED');
  });

  it('recordRunSucceeded omits durationMs when not supplied (destroy run-level shape)', async () => {
    const { backend, objects } = makeFakeBackend();
    const recorder = startRunRecorder({
      backend,
      stackName: 'S',
      region: 'us-east-1',
      command: 'destroy',
      runId: 'r-destroy',
    })!;
    recordRunSucceeded(recorder, 'S', { created: 0, updated: 0, deleted: 4 });
    await recorder.finalize('SUCCEEDED');
    const events = eventsOf(objects, 'r-destroy');
    const finished = events.find((e) => e.eventType === 'RUN_FINISHED')!;
    expect(finished.durationMs).toBeUndefined();
    expect(finished.counts).toEqual({ created: 0, updated: 0, deleted: 4 });
  });
});
