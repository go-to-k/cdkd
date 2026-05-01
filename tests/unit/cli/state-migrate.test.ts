import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

const mockStsSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    sts: { send: mockStsSend },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

const mockResolveBucketRegion = vi.hoisted(() => vi.fn<(name: string) => Promise<string>>());
vi.mock('../../../src/utils/aws-region-resolver.js', () => ({
  resolveBucketRegion: mockResolveBucketRegion,
}));

// S3 client mock — every command we send is a class instance whose constructor
// name we match against. Each test wires up `s3SendImpl` to drive the responses.
const s3SendImpl = vi.hoisted(() => vi.fn<(cmd: { constructor: { name: string }; input?: unknown }) => Promise<unknown>>());
const s3DestroySpy = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-s3', async (importActual) => {
  const actual = await importActual<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({
      send: s3SendImpl,
      destroy: s3DestroySpy,
    })),
  };
});

// readline confirmation prompt — scriptable via readlineQuestion.mockResolvedValue('y'/'n').
const readlineQuestion = vi.hoisted(() => vi.fn<(p: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: readlineQuestion,
    close: readlineClose,
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function runMigrate(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const stateCmd = createStateCommand();
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

/**
 * Build an S3 send-mock plan keyed by command-class name. Each entry is a
 * function returning the desired response (or throwing). A command may be
 * called multiple times — the array entry is consumed sequentially per
 * invocation, and the last entry is sticky after exhaustion.
 */
function planS3(plan: Record<string, Array<() => unknown>>): void {
  const counters: Record<string, number> = {};
  s3SendImpl.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    const handlers = plan[name];
    if (!handlers || handlers.length === 0) {
      throw new Error(`Unexpected S3 command: ${name}`);
    }
    const idx = Math.min(counters[name] ?? 0, handlers.length - 1);
    counters[name] = (counters[name] ?? 0) + 1;
    const result = handlers[idx]!();
    if (result instanceof Error) throw result;
    return Promise.resolve(result);
  });
}

describe('cdkd state migrate', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    s3SendImpl.mockReset();
    s3DestroySpy.mockReset();
    mockStsSend.mockReset();
    mockResolveBucketRegion.mockReset();
    readlineQuestion.mockReset();
    readlineClose.mockReset();
    errorSpy.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();

    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    mockResolveBucketRegion.mockResolvedValue('us-east-1');

    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('refuses when source bucket does not exist', async () => {
    planS3({
      HeadBucketCommand: [
        () => {
          const e = new Error('NotFound') as Error & { name: string };
          e.name = 'NotFound';
          return e;
        },
      ],
    });

    await expect(
      runMigrate(['migrate', '--region', 'us-east-1', '--yes'])
    ).rejects.toThrow();
    const msg = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toMatch(/Source bucket .* does not exist/);
  });

  it('refuses to migrate while a stack lock is held', async () => {
    planS3({
      HeadBucketCommand: [() => ({})], // source exists
      ListObjectsV2Command: [
        () => ({
          Contents: [
            { Key: 'cdkd/MyStack/us-east-1/state.json' },
            { Key: 'cdkd/MyStack/us-east-1/lock.json' }, // active lock
          ],
        }),
      ],
    });

    await expect(runMigrate(['migrate', '--region', 'us-east-1', '--yes'])).rejects.toThrow();
    const msg = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toMatch(/active lock file/);
    expect(msg).toMatch(/lock\.json/);
  });

  it('--dry-run stops before any mutation', async () => {
    planS3({
      HeadBucketCommand: [() => ({})], // source exists
      ListObjectsV2Command: [
        () => ({ Contents: [{ Key: 'cdkd/MyStack/us-east-1/state.json' }] }),
      ],
    });

    await runMigrate(['migrate', '--region', 'us-east-1', '--yes', '--dry-run']);

    // The plan only allows HeadBucket + one ListObjectsV2 (the lock check + source listing).
    // CopyObject / CreateBucket would have thrown "Unexpected S3 command".
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/--dry-run: no changes will be made/)
    );
  });

  it('cancels when user declines the prompt', async () => {
    planS3({
      HeadBucketCommand: [() => ({})],
      ListObjectsV2Command: [
        () => ({ Contents: [{ Key: 'cdkd/MyStack/us-east-1/state.json' }] }),
      ],
    });
    readlineQuestion.mockResolvedValue('n');

    await runMigrate(['migrate', '--region', 'us-east-1']);

    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('Migration cancelled.');
  });

  it('refuses when source and destination resolve to the same bucket', async () => {
    // Simulate user passing the same name explicitly.
    await runMigrate([
      'migrate',
      '--region',
      'us-east-1',
      '--yes',
      '--legacy-bucket',
      'same',
      '--new-bucket',
      'same',
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Source and destination resolve to the same bucket/)
    );
  });

  it('happy path: copies all objects, keeps source by default', async () => {
    planS3({
      HeadBucketCommand: [
        () => ({}), // source probe (region-agnostic)
        () => {
          // destination probe — does not exist yet
          const e = new Error('NotFound') as Error & { name: string };
          e.name = 'NotFound';
          return e;
        },
      ],
      ListObjectsV2Command: [
        // 1st call: lock check on source (no locks)
        () => ({
          Contents: [
            { Key: 'cdkd/StackA/us-east-1/state.json' },
            { Key: 'cdkd/StackB/us-east-1/state.json' },
          ],
        }),
        // 2nd call: source listing for the copy loop
        () => ({
          Contents: [
            { Key: 'cdkd/StackA/us-east-1/state.json' },
            { Key: 'cdkd/StackB/us-east-1/state.json' },
          ],
        }),
        // 3rd call: post-copy verification on destination
        () => ({
          Contents: [
            { Key: 'cdkd/StackA/us-east-1/state.json' },
            { Key: 'cdkd/StackB/us-east-1/state.json' },
          ],
        }),
      ],
      CreateBucketCommand: [() => ({})],
      PutBucketVersioningCommand: [() => ({})],
      PutBucketEncryptionCommand: [() => ({})],
      PutBucketPolicyCommand: [() => ({})],
      CopyObjectCommand: [() => ({})],
    });

    await runMigrate(['migrate', '--region', 'us-east-1', '--yes']);

    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/Copied 2 object\(s\)/));
    expect(infoSpy).toHaveBeenCalledWith('✓ Object count verified at destination');
    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/kept\. Pass --remove-legacy/));
    // Source bucket still there: no DeleteBucketCommand was planned for it.
  });

  it('--remove-legacy empties source (versions + delete-markers) and deletes it', async () => {
    planS3({
      HeadBucketCommand: [
        () => ({}), // source probe
        () => {
          // dest probe — does not exist
          const e = new Error('NotFound') as Error & { name: string };
          e.name = 'NotFound';
          return e;
        },
      ],
      ListObjectsV2Command: [
        () => ({ Contents: [{ Key: 'cdkd/X/us-east-1/state.json' }] }), // lock check
        () => ({ Contents: [{ Key: 'cdkd/X/us-east-1/state.json' }] }), // source listing
        () => ({ Contents: [{ Key: 'cdkd/X/us-east-1/state.json' }] }), // post-copy verify
      ],
      CreateBucketCommand: [() => ({})],
      PutBucketVersioningCommand: [() => ({})],
      PutBucketEncryptionCommand: [() => ({})],
      PutBucketPolicyCommand: [() => ({})],
      CopyObjectCommand: [() => ({})],
      ListObjectVersionsCommand: [
        () => ({
          Versions: [{ Key: 'cdkd/X/us-east-1/state.json', VersionId: 'v1' }],
          DeleteMarkers: [{ Key: 'cdkd/X/us-east-1/old.json', VersionId: 'dm1' }],
        }),
      ],
      DeleteObjectsCommand: [() => ({})],
      DeleteBucketCommand: [() => ({})],
    });

    await runMigrate(['migrate', '--region', 'us-east-1', '--yes', '--remove-legacy']);

    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/Deleted source bucket/));
  });

  it('reuses existing destination bucket when it already exists', async () => {
    planS3({
      HeadBucketCommand: [
        () => ({}), // source exists
        () => ({}), // destination ALREADY exists
      ],
      ListObjectsV2Command: [
        () => ({ Contents: [{ Key: 'cdkd/X/us-east-1/state.json' }] }), // lock check
        () => ({ Contents: [{ Key: 'cdkd/X/us-east-1/state.json' }] }), // source listing
        () => ({
          Contents: [
            { Key: 'cdkd/Y/us-east-1/state.json' }, // pre-existing in destination
            { Key: 'cdkd/X/us-east-1/state.json' }, // newly copied
          ],
        }),
      ],
      CopyObjectCommand: [() => ({})],
    });

    await runMigrate(['migrate', '--region', 'us-east-1', '--yes']);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Destination bucket .* already exists; reusing it\./)
    );
  });

  it('verification fails when destination has fewer objects than source', async () => {
    planS3({
      HeadBucketCommand: [
        () => ({}), // source
        () => {
          const e = new Error('NotFound') as Error & { name: string };
          e.name = 'NotFound';
          return e;
        },
      ],
      ListObjectsV2Command: [
        () => ({
          Contents: [
            { Key: 'cdkd/A/us-east-1/state.json' },
            { Key: 'cdkd/B/us-east-1/state.json' },
          ],
        }),
        () => ({
          Contents: [
            { Key: 'cdkd/A/us-east-1/state.json' },
            { Key: 'cdkd/B/us-east-1/state.json' },
          ],
        }),
        () => ({ Contents: [{ Key: 'cdkd/A/us-east-1/state.json' }] }), // only 1 of 2 copied
      ],
      CreateBucketCommand: [() => ({})],
      PutBucketVersioningCommand: [() => ({})],
      PutBucketEncryptionCommand: [() => ({})],
      PutBucketPolicyCommand: [() => ({})],
      CopyObjectCommand: [() => ({}), () => ({})],
    });

    await expect(runMigrate(['migrate', '--region', 'us-east-1', '--yes'])).rejects.toThrow();
    const msg = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toMatch(/Migration verification failed/);
  });
});
