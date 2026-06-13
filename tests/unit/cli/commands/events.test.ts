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
    listRawKeys: vi.fn(async (keyPrefix: string) =>
      [...objects.keys()].filter((k) => k.startsWith(keyPrefix))
    ),
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

import { eventsCommand } from '../../../../src/cli/commands/events.js';

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
