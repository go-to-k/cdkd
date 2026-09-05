import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { clearReplicationProbeCache } from '../../../src/state/s3-replication-purge-gap.js';

// Silence the info / warn logs the upload-routing helper emits when it
// chooses the URL path.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// S3 mock — captures every PutObject / DeleteObject call so each test can
// assert the upload + delete sequence.
const s3SendCalls = vi.hoisted(
  () => [] as { name: string; input: Record<string, unknown> }[]
);
const s3DestroyMock = vi.hoisted(() => vi.fn());
const s3SendMock = vi.hoisted(() =>
  vi.fn(async (cmd: { _name: string; input: Record<string, unknown> }) => {
    s3SendCalls.push({ name: cmd._name, input: cmd.input });
    // One noncurrent body per key, plus the delete marker the bare
    // DeleteObject just wrote — the post-delete shape of issue #2346 site 7.
    if (cmd._name === 'ListObjectVersions') {
      return {
        Versions: [
          { Key: cmd.input['Prefix'], VersionId: 'v-body', IsLatest: false },
          { Key: cmd.input['Prefix'], VersionId: 'dm', IsLatest: true },
        ],
        IsTruncated: false,
      };
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
  return {
    PutObjectCommand: class extends FakeS3Command {
      constructor(input: Record<string, unknown>) {
        super('PutObject', input);
      }
    },
    DeleteObjectCommand: class extends FakeS3Command {
      constructor(input: Record<string, unknown>) {
        super('DeleteObject', input);
      }
    },
    // Issue #2346 site 7: `cleanup()` now also purges the transient template's
    // noncurrent versions (the state bucket is versioned). Omitting these two
    // from the mock is NOT neutral — the shared helper catches its own
    // construction failure and warns, so the purge would silently no-op and
    // every wire-sequence assertion below would keep asserting the PRE-FIX
    // sequence while reading as green.
    ListObjectVersionsCommand: class extends FakeS3Command {
      constructor(input: Record<string, unknown>) {
        super('ListObjectVersions', input);
      }
    },
    DeleteObjectsCommand: class extends FakeS3Command {
      constructor(input: Record<string, unknown>) {
        super('DeleteObjects', input);
      }
    },
    // Issue #2447: the purge closes with a `GetBucketReplication` probe.
    // Omitting it is NOT neutral for the same reason the two above are not --
    // the missing export throws inside the probe's own try, the probe issues
    // no call, and every replication assertion in this file would read as
    // "cdkd does not probe" whether or not it does.
    GetBucketReplicationCommand: class extends FakeS3Command {
      constructor(input: Record<string, unknown>) {
        super('GetBucketReplication', input);
      }
    },
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
  resolveBucketRegion: vi.fn(async () => 'us-east-1'),
}));

import { selectChangeSetTemplateSource } from '../../../src/cli/commands/export.js';

function buildTemplate(approxBytes: number): {
  template: Record<string, unknown>;
  body: string;
} {
  // Pad a single resource's Properties block until JSON.stringify of the
  // template comfortably exceeds the requested target. The exact byte
  // count does not need to match — tests only need <= 51,200 / in-range /
  // > 1,048,576 distinctions.
  const fill = 'x'.repeat(Math.max(approxBytes - 200, 16));
  const template = {
    AWSTemplateFormatVersion: '2010-09-09',
    Resources: {
      BigLambda: {
        Type: 'AWS::Lambda::Function',
        Properties: { Code: { ZipFile: fill } },
      },
    },
  };
  const body = JSON.stringify(template, null, 2);
  return { template, body };
}

describe('selectChangeSetTemplateSource', () => {
  beforeEach(() => {
    // Issue #2447: the purge closes with a replication probe cached per
    // bucket for the process lifetime. Cleared so this file's command
    // streams do not depend on which test ran first.
    clearReplicationProbeCache();
    s3SendCalls.length = 0;
    s3SendMock.mockClear();
    s3DestroyMock.mockClear();
    // Mirrors the hoisted default, INCLUDING the version listing — this
    // re-attachment would otherwise silently drop the purge's `DeleteObjects`
    // arm for every test in the suite (issue #2346 site 7).
    s3SendMock.mockImplementation(async (cmd) => {
      s3SendCalls.push({ name: cmd._name, input: cmd.input });
      if (cmd._name === 'ListObjectVersions') {
        // The delete marker goes under `DeleteMarkers`, which is where S3 puts
        // it; an earlier revision of this stub listed it under `Versions`,
        // a response shape S3 never produces. The helper merges the two arrays
        // so the assertions were unaffected, but "the post-delete shape" has to
        // actually be the post-delete shape.
        return {
          Versions: [{ Key: cmd.input['Prefix'], VersionId: 'v-body', IsLatest: false }],
          DeleteMarkers: [{ Key: cmd.input['Prefix'], VersionId: 'dm', IsLatest: true }],
          IsTruncated: false,
        };
      }
      return {};
    });
  });

  describe('size routing matrix', () => {
    it('returns kind="inline" with a no-op cleanup for payloads <= 51,200 bytes', async () => {
      const tiny = { template: { Resources: {} }, body: JSON.stringify({ Resources: {} }) };
      const source = await selectChangeSetTemplateSource(
        tiny.template,
        tiny.body,
        { stateBucket: 'state-bucket' },
        'MyStack',
        'Phase-1 IMPORT'
      );

      expect(source.kind).toBe('inline');
      if (source.kind === 'inline') {
        expect(source.templateBody).toBe(tiny.body);
      }
      // No S3 round-trip — cleanup is a no-op.
      expect(s3SendCalls).toHaveLength(0);
      await source.cleanup();
      expect(s3SendCalls).toHaveLength(0);
      expect(s3DestroyMock).not.toHaveBeenCalled();
    });

    it('uploads to TemplateURL for payloads in (51_200, 1_048_576]', async () => {
      const { template, body } = buildTemplate(150_000);
      expect(body.length).toBeGreaterThan(51_200);
      expect(body.length).toBeLessThanOrEqual(1_048_576);

      const source = await selectChangeSetTemplateSource(
        template,
        body,
        { stateBucket: 'state-bucket' },
        'CdkdExportStack',
        'Phase-1 IMPORT'
      );

      expect(source.kind).toBe('url');
      if (source.kind === 'url') {
        expect(source.templateUrl).toMatch(
          /^https:\/\/state-bucket\.s3\.us-east-1\.amazonaws\.com\/cdkd-migrate-tmp\/CdkdExportStack\/\d+\.json$/
        );
      }
      // PutObject runs immediately; DeleteObject runs only when cleanup
      // is invoked by the caller's finally block.
      expect(s3SendCalls.map((c) => c.name)).toEqual(['PutObject']);
      expect(s3SendCalls[0]!.input['Bucket']).toBe('state-bucket');
      expect(s3SendCalls[0]!.input['ContentType']).toBe('application/json');
      expect(s3SendCalls[0]!.input['Body']).toBe(body);
    });

    it('rejects payloads > 1_048_576 with an actionable pre-flight error naming offending resources', async () => {
      const { template, body } = buildTemplate(1_100_000);
      expect(body.length).toBeGreaterThan(1_048_576);

      await expect(
        selectChangeSetTemplateSource(
          template,
          body,
          { stateBucket: 'state-bucket' },
          'HugeStack',
          'Phase-2 UPDATE'
        )
      ).rejects.toThrow(/over the 1048576-byte CloudFormation TemplateURL limit/);

      // No S3 PutObject in the >1 MB pre-flight reject path.
      expect(s3SendCalls).toHaveLength(0);

      // Re-collect the error message so we can assert the offending
      // resource appears in it.
      let thrown: Error | undefined;
      try {
        await selectChangeSetTemplateSource(
          template,
          body,
          { stateBucket: 'state-bucket' },
          'HugeStack',
          'Phase-2 UPDATE'
        );
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain('BigLambda');
      expect(thrown!.message).toContain('AWS::Lambda::Function');
      expect(thrown!.message).toContain('lambda.Code.fromAsset');
    });
  });

  describe('cleanup contract (caller invokes in finally)', () => {
    it('runs DeleteObject + destroys the S3 client on the success path', async () => {
      const { template, body } = buildTemplate(150_000);
      const source = await selectChangeSetTemplateSource(
        template,
        body,
        { stateBucket: 'state-bucket' },
        'CleanupStack',
        'Phase-1 IMPORT'
      );

      await source.cleanup();

      // The purge pair is part of `cleanup()`'s contract since issue #2346 site 7:
      // the state bucket is versioned, so the DeleteObject alone leaves the
      // uploaded template body readable by VersionId.
      expect(s3SendCalls.map((c) => c.name)).toEqual([
        'PutObject',
        'DeleteObject',
        'ListObjectVersions',
        'DeleteObjects',
        // Issue #2447: the purge closes by asking whether a replica kept what it
        // just removed. It fires HERE and not in every sibling suite because
        // this fixture's listing actually returns a noncurrent version -- the
        // probe is scoped to keys a body was really removed for.
        'GetBucketReplication',
      ]);
      const put = s3SendCalls[0]!;
      const del = s3SendCalls[1]!;
      expect(del.input['Bucket']).toBe('state-bucket');
      expect(del.input['Key']).toBe(put.input['Key']);
      expect(s3DestroyMock).toHaveBeenCalledTimes(1);
    });

    it('runs DeleteObject when the caller invokes cleanup AFTER an error (failure path)', async () => {
      // The caller's `finally` block runs cleanup regardless of whether
      // the CFn CreateChangeSet / wait / execute steps threw. We simulate
      // that here by calling cleanup() from a try/catch that swallows a
      // synthetic error.
      const { template, body } = buildTemplate(150_000);
      const source = await selectChangeSetTemplateSource(
        template,
        body,
        { stateBucket: 'state-bucket' },
        'FailStack',
        'Phase-2 UPDATE'
      );

      try {
        throw new Error('CreateChangeSet failed');
      } catch {
        await source.cleanup();
      }

      // The purge pair is part of `cleanup()`'s contract since issue #2346 site 7:
      // the state bucket is versioned, so the DeleteObject alone leaves the
      // uploaded template body readable by VersionId.
      expect(s3SendCalls.map((c) => c.name)).toEqual([
        'PutObject',
        'DeleteObject',
        'ListObjectVersions',
        'DeleteObjects',
        // Issue #2447: the purge closes by asking whether a replica kept what it
        // just removed. It fires HERE and not in every sibling suite because
        // this fixture's listing actually returns a noncurrent version -- the
        // probe is scoped to keys a body was really removed for.
        'GetBucketReplication',
      ]);
      expect(s3DestroyMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('phase-1 / phase-2 symmetry', () => {
    it('uses the same upload key shape (cdkd-migrate-tmp/<stack>/<ts>.json) for both phases', async () => {
      const { template: t1, body: b1 } = buildTemplate(80_000);
      const phase1 = await selectChangeSetTemplateSource(
        t1,
        b1,
        { stateBucket: 'state-bucket' },
        'SymStack',
        'Phase-1 IMPORT'
      );
      expect(phase1.kind).toBe('url');

      const { template: t2, body: b2 } = buildTemplate(80_000);
      const phase2 = await selectChangeSetTemplateSource(
        t2,
        b2,
        { stateBucket: 'state-bucket' },
        'SymStack',
        'Phase-2 UPDATE'
      );
      expect(phase2.kind).toBe('url');

      const keys = s3SendCalls
        .filter((c) => c.name === 'PutObject')
        .map((c) => String(c.input['Key']));
      expect(keys).toHaveLength(2);
      for (const key of keys) {
        expect(key).toMatch(/^cdkd-migrate-tmp\/SymStack\/\d+\.json$/);
      }
    });

    it('annotates the >1 MB pre-flight error with the caller-supplied phase label', async () => {
      const { template, body } = buildTemplate(1_100_000);

      await expect(
        selectChangeSetTemplateSource(
          template,
          body,
          { stateBucket: 'state-bucket' },
          'HugeStack',
          'Filtered phase-1 IMPORT'
        )
      ).rejects.toThrow(/Filtered phase-1 IMPORT template is/);

      await expect(
        selectChangeSetTemplateSource(
          template,
          body,
          { stateBucket: 'state-bucket' },
          'HugeStack',
          'Phase-2 UPDATE'
        )
      ).rejects.toThrow(/Phase-2 UPDATE template is/);
    });
  });
});
