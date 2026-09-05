import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CdkdError } from '../../../../src/utils/error-handler.js';
import { setStdinIsTty } from '../../../stdin-tty.js';

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
  // Issue #2280: the commands under test call this under --json; the mock
  // must export it or the import is `undefined` and the call throws.
  reserveStdoutForPayload: vi.fn(),
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

import {
  createEventsPruneCommand,
  eventsCommand,
  eventsPruneCommand,
} from '../../../../src/cli/commands/events.js';

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
    // Issue #2624: the keys are gone from a LISTING, not from the bucket —
    // `deleteRawObjects` sends `DeleteObjects` with no `VersionId`, so on the
    // versioned state bucket every earlier version stays readable. The line
    // that reports the delete has to say so — bound to THAT line, not to the
    // joined output, or moving the caveat to a separate hint line would leave
    // the delete claim unqualified and still pass.
    const pruned = logLines.find((l) => l.includes('Pruned 3'));
    expect(pruned).toBeDefined();
    expect(pruned).toContain('earlier versions of the deleted keys survive');
    expect(pruned).toContain('VersionId');
    expect(pruned).toContain('prune does not purge them');
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
    // THE OTHER POLARITY of the note asserted on the two delete arms (issue
    // #2624): this arm deleted NOTHING, so there is no delete to qualify and
    // the versioning caveat must not appear. Without this, appending the note
    // unconditionally would still pass every positive case.
    expect(logLines.join('\n')).not.toContain('earlier versions of the deleted keys survive');
  });

  it('refuses to prune without --yes on a non-interactive terminal (no hang)', async () => {
    // Issue #2454 changed the SHAPE of this refusal, not whether it refuses.
    // It used to log a line and RETURN, i.e. exit 0 — so a CI job could not
    // tell "cdkd refused" from "cdkd pruned nothing". It now throws the same
    // `NON_INTERACTIVE_CONFIRM` the nine prompts of issue #2275 throw, which
    // `withErrorHandling` renders as exit 1. This case is the one that pinned
    // the old contract, so it is the one that has to state the new one.
    seedJsonlRuns('us-east-1', [id(0), id(1)]);
    setStdinIsTty(false);
    const err = await eventsPruneCommand('MyStack', { keep: 1 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CdkdError);
    expect((err as CdkdError).code).toBe('NON_INTERACTIVE_CONFIRM');
    expect((err as Error).message).toContain('cdkd events prune');
    expect((err as Error).message).toContain('-y / --yes');
    // The refusal still deletes nothing — the half that did NOT change.
    expect(objects.has(`cdkd/MyStack/us-east-1/deployments/${id(0)}.jsonl`)).toBe(true);
    expect(objects.has(`cdkd/MyStack/us-east-1/deployments/${id(1)}.jsonl`)).toBe(true);
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
    // "Removed" is the same claim as "Pruned" for this purpose (issue #2624):
    // the index key was delete-markered, and its earlier versions survive. The
    // note has to be on THIS arm too, not only on the run-stream arm — and on
    // the SAME line as the removal claim.
    const removed = logLines.find((l) => l.includes('Removed the empty deployment-event index'));
    expect(removed).toBeDefined();
    expect(removed).toContain('earlier versions of the deleted keys survive');
  });
});

/**
 * `cdkd events prune`'s own HELP text carried the claim this command's output
 * now retires — it promised to "reclaim S3 space", which is precisely what a
 * version-blind delete does NOT do (issue
 * [#2624](https://github.com/go-to-k/cdkd/issues/2624)). Nothing pinned it, so
 * a revert reddened nothing; the sibling `--purge-events` help is pinned in
 * `tests/unit/cli/destroy-purge-events.test.ts`.
 *
 * Read the raw `description`, never `helpInformation()` — that re-wraps at a
 * width derived from the option names and the terminal, so a long needle would
 * match only by accident.
 */
describe('cdkd events prune help text', () => {
  const cmd = () => createEventsPruneCommand();
  const allDescription = (): string =>
    cmd().options.find((o) => o.long === '--all')?.description ?? '';

  it('the command description promises a cleared LISTING, not reclaimed space', () => {
    const text = cmd().description();
    // Bound the arm: an empty description would satisfy the negatives for free.
    expect(text).not.toBe('');
    expect(text).toContain('clears the object listing');
    expect(text).toContain('earlier versions of the deleted keys survive');
    // The exact phrase that shipped, and the one this issue retires.
    expect(text).not.toContain('reclaim S3 space');
  });

  it('--all no longer calls itself a full purge', () => {
    expect(allDescription()).not.toBe('');
    expect(allDescription()).toContain('Delete every recorded run and the index');
    // "purge" reads as removal; on a versioned bucket it is not one.
    expect(allDescription()).not.toContain('full purge');
  });
});
