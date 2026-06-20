import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// --- Module mocks (declared before importing the command under test) ---

const objects = new Map<string, string>();

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  setAwsClients: vi.fn(),
}));

vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn().mockResolvedValue('cdkd-state-123'),
}));

vi.mock('../../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    prefix: 'cdkd',
    verifyBucketExists: vi.fn().mockResolvedValue(undefined),
    getRawObject: vi.fn(async (key: string) => objects.get(key) ?? null),
    putRawObject: vi.fn(async (key: string, body: string) => {
      objects.set(key, body);
    }),
    listRawKeys: vi.fn(async (keyPrefix: string) =>
      [...objects.keys()].filter((k) => k.startsWith(keyPrefix))
    ),
    deleteRawObjects: vi.fn(async (keys: string[]) => {
      for (const k of keys) objects.delete(k);
    }),
  })),
}));

const logLines: string[] = [];
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    info: (m: string) => logLines.push(m),
    warn: (m: string) => logLines.push(m),
    error: (m: string) => logLines.push(m),
    debug: vi.fn(),
  }),
}));

// Strip ANSI color so assertions are stable.
vi.mock('../../../../src/utils/colors.js', () => {
  const id = (s: unknown) => String(s);
  return { bold: id, cyan: id, gray: id, green: id, red: id, yellow: id };
});

import { eventsCommand, eventsPruneCommand } from '../../../../src/cli/commands/events.js';

interface RunOpts {
  json?: boolean;
  run?: string;
  stackRegion?: string;
}

/** Invoke the events command core directly (bypasses process.exit wrapper). */
async function runEvents(stack: string, opts: RunOpts = {}): Promise<void> {
  await eventsCommand(stack, opts);
}

describe('cdkd events command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    objects.clear();
    logLines.length = 0;
  });

  function seedIndex(region: string): void {
    objects.set(
      `cdkd/MyStack/${region}/deployments/index.json`,
      JSON.stringify({
        indexVersion: 1,
        stackName: 'MyStack',
        region,
        runs: [
          {
            runId: 'run-b',
            command: 'deploy',
            cdkdVersion: '1.0.0',
            startedAt: 's1',
            finishedAt: 'f1',
            result: 'SUCCEEDED',
            eventCount: 3,
          },
          {
            runId: 'run-a',
            command: 'destroy',
            cdkdVersion: '1.0.0',
            startedAt: 's0',
            finishedAt: 'f0',
            result: 'FAILED',
            eventCount: 2,
          },
        ],
        lastModified: 1,
      })
    );
  }

  it('lists runs newest-first (human output)', async () => {
    seedIndex('us-east-1');
    await runEvents('MyStack');
    const out = logLines.join('\n');
    expect(out).toContain('run-b');
    expect(out).toContain('run-a');
    expect(out.indexOf('run-b')).toBeLessThan(out.indexOf('run-a'));
  });

  it('emits machine-readable JSON for the run listing with --format json', async () => {
    seedIndex('us-east-1');
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await runEvents('MyStack', { json: true });
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(writes.join(''));
    expect(parsed.stackName).toBe('MyStack');
    expect(parsed.runs.map((r: { runId: string }) => r.runId)).toEqual(['run-b', 'run-a']);
  });

  it('reads a single run with --run', async () => {
    objects.set(
      'cdkd/MyStack/us-east-1/deployments/run-b.jsonl',
      [
        JSON.stringify({ timestamp: 't1', eventType: 'RUN_STARTED', stackName: 'MyStack' }),
        JSON.stringify({
          timestamp: 't2',
          eventType: 'RESOURCE_FAILED',
          stackName: 'MyStack',
          logicalId: 'Q',
          resourceType: 'AWS::SQS::Queue',
          error: { name: 'E', message: 'boom', awsErrorCode: 'AccessDenied' },
        }),
      ].join('\n')
    );
    await runEvents('MyStack', { run: 'run-b' });
    const out = logLines.join('\n');
    expect(out).toContain('RUN_STARTED');
    expect(out).toContain('RESOURCE_FAILED');
    expect(out).toContain('boom');
    expect(out).toContain('AccessDenied');
  });

  it('errors when the named run does not exist', async () => {
    seedIndex('us-east-1');
    await expect(runEvents('MyStack', { run: 'missing' })).rejects.toThrow(
      /No deployment-event stream found/
    );
  });

  it('errors with a clear message when no event history exists', async () => {
    await expect(runEvents('MyStack')).rejects.toThrow(/No deployment-event history/);
  });

  it('errors when event history exists in multiple regions and --stack-region is absent', async () => {
    seedIndex('us-east-1');
    seedIndex('eu-west-1');
    await expect(runEvents('MyStack')).rejects.toThrow(/multiple regions/);
  });

  it('honors --stack-region to disambiguate', async () => {
    seedIndex('us-east-1');
    seedIndex('eu-west-1');
    await runEvents('MyStack', { stackRegion: 'eu-west-1' });
    expect(logLines.join('\n')).toContain('run-b');
  });
});

describe('cdkd events prune command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    objects.clear();
    logLines.length = 0;
  });

  /** Seed `.jsonl` streams + an index.json for the given run ids. */
  function seedJsonlRuns(region: string, ids: string[]): void {
    for (const runId of ids) {
      objects.set(`cdkd/MyStack/${region}/deployments/${runId}.jsonl`, '{}\n');
    }
    objects.set(
      `cdkd/MyStack/${region}/deployments/index.json`,
      JSON.stringify({
        indexVersion: 1,
        stackName: 'MyStack',
        region,
        runs: [...ids]
          .sort()
          .reverse()
          .map((runId) => ({
            runId,
            command: 'deploy',
            cdkdVersion: '1.0.0',
            startedAt: '',
            finishedAt: '',
            result: 'SUCCEEDED',
            eventCount: 1,
          })),
        lastModified: 1,
      })
    );
  }

  const id = (i: number): string => `20260101T000000${String(i).padStart(3, '0')}Z-aa`;

  it('--all purges every run and the index (with --yes)', async () => {
    seedJsonlRuns('us-east-1', [id(0), id(1), id(2)]);
    await eventsPruneCommand('MyStack', { all: true, yes: true });
    expect([...objects.keys()].filter((k) => k.includes('/deployments/'))).toEqual([]);
    expect(logLines.join('\n')).toContain('Pruned 3');
  });

  it('--keep retains the newest N (with --yes)', async () => {
    seedJsonlRuns('us-east-1', [id(0), id(1), id(2), id(3)]);
    await eventsPruneCommand('MyStack', { keep: 2, yes: true });
    expect(objects.has(`cdkd/MyStack/us-east-1/deployments/${id(0)}.jsonl`)).toBe(false);
    expect(objects.has(`cdkd/MyStack/us-east-1/deployments/${id(3)}.jsonl`)).toBe(true);
    expect(logLines.join('\n')).toContain('2 retained');
  });

  it('rejects --all combined with --keep', async () => {
    seedJsonlRuns('us-east-1', [id(0)]);
    await expect(eventsPruneCommand('MyStack', { all: true, keep: 2, yes: true })).rejects.toThrow(
      /cannot be combined/
    );
  });

  it('reports when no runs match the criteria', async () => {
    seedJsonlRuns('us-east-1', [id(0), id(1)]);
    await eventsPruneCommand('MyStack', { keep: 5, yes: true });
    expect(logLines.join('\n')).toContain('No runs matched');
  });

  it('refuses to prune without --yes on a non-interactive terminal (no hang)', async () => {
    seedJsonlRuns('us-east-1', [id(0), id(1)]);
    const prev = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await eventsPruneCommand('MyStack', { keep: 1 }); // no yes, non-TTY
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: prev, configurable: true });
    }
    // Nothing deleted; clear hint emitted.
    expect(objects.has(`cdkd/MyStack/us-east-1/deployments/${id(0)}.jsonl`)).toBe(true);
    expect(logLines.join('\n')).toMatch(/Refusing to prune.*Re-run with --yes/s);
  });

  it('--all on an index-only store removes the index and reports it accurately', async () => {
    // Only index.json exists (no .jsonl streams) — a destroyed stack whose
    // streams were already pruned but the index lingered.
    objects.set(
      'cdkd/MyStack/us-east-1/deployments/index.json',
      JSON.stringify({ indexVersion: 1, stackName: 'MyStack', region: 'us-east-1', runs: [], lastModified: 1 })
    );
    await eventsPruneCommand('MyStack', { all: true, yes: true });
    expect(objects.has('cdkd/MyStack/us-east-1/deployments/index.json')).toBe(false);
    expect(logLines.join('\n')).toContain('Removed the empty deployment-event index');
  });
});
