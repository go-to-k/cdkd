import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { clearReplicationProbeCache } from '../../../src/state/s3-replication-purge-gap.js';

/**
 * Issue [#2346](https://github.com/go-to-k/cdkd/issues/2346) site 7, second
 * order — adding the noncurrent-version purge to `uploadCfnTemplate`'s
 * `cleanup()` must not cost the S3 client its `destroy()`.
 *
 * ## The regression this pins, measured in the session that wrote the purge
 *
 * The first revision placed `s3.destroy()` AFTER the purge's `catch` arm
 * rather than inside a `finally` under it. A throw raised INSIDE that catch
 * then skipped the destroy and leaked the connection pool — and the catch arm
 * is reached only when something has already failed, so the leak arrived
 * exactly when the process was least healthy. It was caught by
 * `retire-cfn-stack.test.ts`'s pre-existing `expect(s3DestroyMock).toHaveBeenCalled()`
 * failing, not by anything written for the purge.
 *
 * ## The discriminator
 *
 * `s3DestroyMock` being called at all. Reaching the catch arm needs the purge
 * to fail, and making the catch arm ITSELF throw needs the warning to fail,
 * so this suite arranges both: the version listing rejects, and the logger's
 * `warn` throws. Under the pre-fix placement `destroy()` is never reached; a
 * test that merely made the purge fail would pass either way, because a
 * cleanly-completing catch falls through to a trailing `destroy()` too.
 */

/**
 * Throws on the FIRST call and records afterwards.
 *
 * The first `warn` on this path is the shared helper's own, so a logger that
 * always throws makes the helper's warning escape into `cleanup()`'s catch —
 * the only mechanism that can actually fire there (see the comment at the call
 * site). Recording from the second call on is what lets the bespoke fallback
 * message be READ rather than merely counted: review probed that message by
 * replacing its opening phrase and 119 tests across six suites stayed green,
 * because the one test reaching the arm made `warn` throw and never looked at
 * what it was handed.
 */
const warnCalls = vi.hoisted(() => [] as string[]);
/**
 * `throwEvery` distinguishes the two things this file has to reach.
 *
 * With it ON, the fallback's OWN `warn` throws too, so `cleanup()` rejects and
 * the destroy-leak test can prove `s3.destroy()` still ran. With it OFF only
 * the helper's warning throws, which is what carries control into the fallback
 * arm and then lets that arm's message be recorded and read.
 */
const warnBehavior = vi.hoisted(() => ({ throwEvery: true }));
const warnMock = vi.hoisted(() =>
  vi.fn((m: string) => {
    warnCalls.push(String(m));
    if (warnBehavior.throwEvery || warnCalls.length === 1) {
      throw new Error('logger transport down');
    }
  })
);
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
  }),
}));

const s3DestroyMock = vi.hoisted(() => vi.fn());
const s3SendMock = vi.hoisted(() =>
  vi.fn(async (cmd: { _name: string; input?: Record<string, unknown> }) => {
    if (cmd._name === 'ListObjectVersions') {
      return {
        Versions: [{ Key: cmd.input?.['Prefix'], VersionId: 'v-old', IsLatest: false }],
        IsTruncated: false,
      };
    }
    // `DeleteObjects` reports per-key failures through `Errors` rather than
    // throwing, which is what makes the helper warn — the trigger this suite
    // needs, and one a `throw` would not reproduce faithfully.
    if (cmd._name === 'DeleteObjects') {
      return { Errors: [{ Key: 'k', VersionId: 'v-old', Code: 'AccessDenied', Message: 'nope' }] };
    }
    return {};
  })
);

const s3Commands = vi.hoisted(() => {
  class FakeS3Command {
    constructor(
      public readonly _name: string,
      public readonly input: Record<string, unknown>
    ) {}
  }
  const make = (name: string) =>
    class extends FakeS3Command {
      constructor(input: Record<string, unknown>) {
        super(name, input);
      }
    };
  return {
    PutObjectCommand: make('PutObject'),
    DeleteObjectCommand: make('DeleteObject'),
    ListObjectVersionsCommand: make('ListObjectVersions'),
    DeleteObjectsCommand: make('DeleteObjects'),
    // Issue #2447: the purge closes with a `GetBucketReplication` probe.
    // Omitting it is NOT neutral for the same reason the two above are not --
    // the missing export throws inside the probe's own try, the probe issues
    // no call, and every replication assertion in this file would read as
    // "cdkd does not probe" whether or not it does.
    GetBucketReplicationCommand: make('GetBucketReplication'),
  };
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: s3SendMock, destroy: s3DestroyMock })),
  PutObjectCommand: s3Commands.PutObjectCommand,
  DeleteObjectCommand: s3Commands.DeleteObjectCommand,
  ListObjectVersionsCommand: s3Commands.ListObjectVersionsCommand,
  DeleteObjectsCommand: s3Commands.DeleteObjectsCommand,
  GetBucketReplicationCommand: s3Commands.GetBucketReplicationCommand,
}));

vi.mock('../../../src/utils/aws-region-resolver.js', () => ({
  resolveBucketRegion: vi.fn(async () => 'eu-west-1'),
}));

import { uploadCfnTemplate } from '../../../src/cli/upload-cfn-template.js';

describe('uploadCfnTemplate cleanup destroys the client even when the purge arm blows up', () => {
  beforeEach(() => {
    // Issue #2447: the purge closes with a replication probe cached per
    // bucket for the process lifetime. Cleared so this file's command
    // streams do not depend on which test ran first.
    clearReplicationProbeCache();
    s3DestroyMock.mockClear();
    warnMock.mockClear();
    warnCalls.length = 0;
    warnBehavior.throwEvery = true;
  });

  it('destroys the S3 client when both the purge AND its warning throw', async () => {
    const { cleanup } = await uploadCfnTemplate({
      bucket: 'state-bucket',
      body: 'body',
      stackName: 'MyStack',
    });

    // The warning throwing is what escapes; the point is only that the
    // connection pool is released on the way out regardless.
    await expect(cleanup()).rejects.toThrow(/logger transport down/);
    expect(s3DestroyMock).toHaveBeenCalledTimes(1);
  });

  it('the fallback warning names the transient upload and its remedy', async () => {
    const { cleanup } = await uploadCfnTemplate({
      bucket: 'state-bucket',
      body: 'body',
      stackName: 'MyStack',
    });

    // Only the helper's warning throws here, so control reaches the fallback
    // arm, its own `warn` succeeds, and `cleanup()` completes normally.
    warnBehavior.throwEvery = false;

    await expect(cleanup()).resolves.toBeUndefined();
    expect(s3DestroyMock).toHaveBeenCalledTimes(1);

    // Call 1 was the helper's own (it threw, which is what reaches the catch);
    // call 2 is `cleanup()`'s bespoke fallback, and this READS it.
    expect(warnCalls).toHaveLength(2);
    const fallback = warnCalls[1]!;
    expect(fallback).toContain('Could not purge noncurrent versions of the transient template');
    expect(fallback).toContain('s3://state-bucket/cdkd-migrate-tmp/MyStack/');
    expect(fallback).toContain('readable via GetObject with a VersionId');
    expect(fallback).toContain('Grant s3:ListBucketVersions and s3:DeleteObjectVersion');
    expect(fallback).toContain('logger transport down');
  });
});
