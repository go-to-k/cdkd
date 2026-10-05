import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CdkdError } from '../../../../src/utils/error-handler.js';
import { setStdinIsTty } from '../../../stdin-tty.js';

// --- Module mocks (declared before importing the command under test) ---

const objects = new Map<string, string>();
/** What the prefix-wide version sweep reports, and which prefixes it was given (issue #2624). */
const sweep: {
  result: { deletedBodies: number; complete: boolean };
  prefixes: string[];
} = { result: { deletedBodies: 0, complete: true }, prefixes: [] };

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
    purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
    purgeNoncurrentVersionsUnderPrefix: vi.fn(async (prefix: string) => {
      sweep.prefixes.push(prefix);
      return sweep.result;
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

  // go-to-k/cdkd#3760: every field of the run list sits above the labelled
  // `Read one run's events with:` footer, so padding that wraps on screen must
  // not reach it. No newline here: interior padding alone is the route.
  const FORGED = `${' '.repeat(60)}Read one run's events with: cdkd destroy --all --force #`;

  it.each([
    ['runId', '  <unrenderable>  deploy  SUCCEEDED  '],
    ['command', '  run-b  <unrenderable>  SUCCEEDED  '],
    ['result', '  run-b  deploy  <unrenderable>  '],
    ['startedAt', '  ? -> f1  '],
    ['finishedAt', '  s1 -> ?  '],
    ['cdkdVersion', '  cdkd <unrenderable>  3 events'],
  ] as const)(
    'withholds a padded run-list %s instead of printing it (go-to-k/cdkd#3760)',
    async (field, fallbackRow) => {
      seedIndex('us-east-1');
      const key = 'cdkd/MyStack/us-east-1/deployments/index.json';
      const index = JSON.parse(objects.get(key)!) as { runs: Record<string, unknown>[] };
      index.runs[0]![field] = `x${FORGED}`;
      objects.set(key, JSON.stringify(index));
      await runEvents('MyStack');
      const out = logLines.join('\n');

      expect(out).not.toContain('cdkd destroy');
      // The field renders as its fallback marker, in its own column.
      expect(out).toContain(fallbackRow);
      // The untouched sibling row still renders its own values.
      expect(out).toContain('run-a');
      expect(out).toContain("Read one run's events with: cdkd events MyStack --run '<runId>'");
    }
  );

  it('describes a padded stack name in the run-list header (go-to-k/cdkd#3760)', async () => {
    const stack = `Prod${FORGED}`;
    objects.set(
      `cdkd/${stack}/us-east-1/deployments/index.json`,
      JSON.stringify({ indexVersion: 1, stackName: stack, region: 'us-east-1', runs: [], lastModified: 1 })
    );
    await runEvents(stack);
    const out = logLines.join('\n');

    expect(out).not.toContain('cdkd destroy');
    expect(out).toContain('Deployment runs for a stack name that is not a plain identifier (us-east-1)');
  });

  it('describes a padded region in the run-list header (go-to-k/cdkd#3760)', async () => {
    const region = `us${FORGED}`;
    objects.set(
      `cdkd/MyStack/${region}/deployments/index.json`,
      JSON.stringify({ indexVersion: 1, stackName: 'MyStack', region, runs: [], lastModified: 1 })
    );
    await runEvents('MyStack');
    const out = logLines.join('\n');

    expect(out).not.toContain('cdkd destroy');
    expect(out).toContain('Deployment runs for MyStack (a region that is not a plain identifier)');
  });

  it('names a plain stack in the run-list header', async () => {
    seedIndex('us-east-1');
    await runEvents('MyStack');
    expect(logLines.join('\n')).toContain('Deployment runs for MyStack (us-east-1)');
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
    sweep.result = { deletedBodies: 3, complete: true };
    sweep.prefixes = [];
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
    // Issue #2624: `--all` purges every earlier version under the stack's
    // deployments/ prefix, so the line that reports the delete says so --
    // deferring to the purge's own warning, which prints first when it could
    // not finish. Bound to THAT line, not the joined output. Neither the old
    // "survive" wording nor the partial prunes' narrower note appears.
    const pruned = logLines.find((l) => l.includes('Pruned 3'));
    expect(pruned).toBeDefined();
    expect(pruned).toContain(
      "Every earlier version under the stack's deployments/ prefix was purged as well"
    );
    expect(pruned).not.toContain('Earlier versions of the deleted keys');
    expect(pruned).toContain('unless a warning above says otherwise');
    expect(pruned).not.toContain('survive');
  });

  it('--keep retains the newest N (with --yes)', async () => {
    seedJsonlRuns('us-east-1', [id(0), id(1), id(2), id(3)]);
    await eventsPruneCommand('MyStack', { keep: 2, yes: true });
    expect(objects.has(`cdkd/MyStack/us-east-1/deployments/${id(0)}.jsonl`)).toBe(false);
    expect(objects.has(`cdkd/MyStack/us-east-1/deployments/${id(3)}.jsonl`)).toBe(true);
    const pruned = logLines.find((l) => l.includes('2 retained'));
    expect(pruned).toBeDefined();
    // A partial prune purges only the keys it deleted, so it must not claim
    // the whole prefix (issue #2624).
    expect(pruned).toContain('Earlier versions of the deleted keys were purged as well');
    expect(pruned).not.toContain('Every earlier version under');
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
    expect(logLines.join('\n')).not.toContain('Earlier versions of the deleted keys');
    expect(logLines.join('\n')).not.toContain('Every earlier version under');
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
    // the index key's earlier versions are purged too, so the note belongs on
    // THIS arm as well -- and on the SAME line as the removal claim.
    const removed = logLines.find((l) => l.includes('Removed the empty deployment-event index'));
    expect(removed).toBeDefined();
    expect(removed).toContain(
      "Every earlier version under the stack's deployments/ prefix was purged as well"
    );
  });

  it('a stack with no CURRENT history names the --stack-region route to the residue (issue #2624)', async () => {
    // Region discovery reads current keys only, so a stack whose every stream
    // is behind a delete marker lists nothing and the prune stops before its
    // `--all` sweep. The refusal has to say how to reach those versions.
    const err = await eventsPruneCommand('MyStack', { all: true, yes: true }).catch((e: unknown) => e);
    expect((err as CdkdError).code).toBe('EVENTS_NOT_FOUND');
    expect((err as Error).message).toContain(
      'the prune subcommand with --all and --stack-region still purges the earlier versions'
    );
  });

  it('--all on a stack with no event history claims no removal (issue #2624)', async () => {
    // Nothing under the prefix. `--stack-region` is what reaches the prune
    // here: without it, region discovery finds no history and refuses first.
    // The index key is still sent to the idempotent `DeleteObjects`, which
    // succeeds for an absent key; a store that reported that success as
    // `indexDeleted` made this print "Removed the empty deployment-event
    // index" for an index that never existed.
    await eventsPruneCommand('MyStack', { all: true, yes: true, stackRegion: 'us-east-1' });
    const out = logLines.join('\n');
    expect(out).toContain('No runs matched');
    expect(out).not.toContain('Removed the empty deployment-event index');
    expect(out).not.toContain('Earlier versions of the deleted keys');
    // But `--all` still swept the prefix: a stack whose history was deleted
    // BEFORE is exactly one with nothing current left, and its versions are
    // what the sweep is for (issue #2624). The sweep deleted some (the
    // beforeEach's 3), so the no-match line says so.
    expect(sweep.prefixes).toEqual(['cdkd/MyStack/us-east-1/deployments/']);
    const noMatch = logLines.find((l) => l.includes('No runs matched'));
    expect(noMatch).toContain(
      "Every earlier version under the stack's deployments/ prefix was purged as well"
    );
  });

  it('--all whose sweep found NOTHING claims no purge and shows the region (a typo is visible)', async () => {
    sweep.result = { deletedBodies: 0, complete: true };
    await eventsPruneCommand('MyStack', { all: true, yes: true, stackRegion: 'us-east-l' });
    const noMatch = logLines.find((l) => l.includes('No runs matched'));
    expect(noMatch).toContain(
      'No earlier versions were found under its deployments/ prefix in us-east-l either.'
    );
    expect(noMatch).not.toContain('was purged');
  });

  it('--all whose sweep PARTLY succeeded reports the purge, deferring to the warning', async () => {
    sweep.result = { deletedBodies: 2, complete: false };
    await eventsPruneCommand('MyStack', { all: true, yes: true, stackRegion: 'us-east-1' });
    const noMatch = logLines.find((l) => l.includes('No runs matched'));
    expect(noMatch).toContain(
      "Every earlier version under the stack's deployments/ prefix was purged as well, unless a warning above says otherwise."
    );
    expect(noMatch).not.toContain('could not be purged');
  });

  it('--all whose sweep FAILED points at the warning instead of claiming a purge', async () => {
    sweep.result = { deletedBodies: 0, complete: false };
    await eventsPruneCommand('MyStack', { all: true, yes: true, stackRegion: 'us-east-1' });
    const noMatch = logLines.find((l) => l.includes('No runs matched'));
    expect(noMatch).toContain('could not be purged; see the warning above');
    expect(noMatch).not.toContain('was purged');
    expect(noMatch).not.toContain('No earlier versions were found');
  });

  it('canonicalizes --stack-region, so US-EAST-1 sweeps the us-east-1 prefix', async () => {
    seedJsonlRuns('us-east-1', [id(0)]);
    await eventsPruneCommand('MyStack', { all: true, yes: true, stackRegion: 'US-EAST-1' });
    expect(sweep.prefixes).toEqual(['cdkd/MyStack/us-east-1/deployments/']);
    expect([...objects.keys()].filter((k) => k.includes('/deployments/'))).toEqual([]);
    expect(logLines.some((l) => l.includes('Pruned 1'))).toBe(true);
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

  it('the command description says the earlier versions are purged too', () => {
    const text = cmd().description();
    // Bound the arm: an empty description would satisfy the negatives for free.
    expect(text).not.toBe('');
    // Issue #2624: the delete now purges noncurrent versions as well.
    expect(text).toContain('versions of the deleted keys are purged too');
    expect(text).toContain(
      "with --all, every earlier version under the stack's deployments/ prefix"
    );
    expect(text).toContain('unless a warning says otherwise');
    expect(text).not.toContain('survive');
    // The exact phrase that shipped, and the one this issue retires.
    expect(text).not.toContain('reclaim S3 space');
  });

  it('--all no longer calls itself a full purge', () => {
    expect(allDescription()).not.toBe('');
    expect(allDescription()).toContain('Delete every recorded run and the index');
    expect(allDescription()).toContain(
      "purge every earlier version under the stack's deployments/ prefix"
    );
    // "purge" reads as removal; on a versioned bucket it is not one.
    expect(allDescription()).not.toContain('full purge');
  });
});
