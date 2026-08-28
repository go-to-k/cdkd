import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// S3 mock — captures every PutObject / DeleteObject call so each test can
// assert the upload + delete sequence.
const s3SendCalls = vi.hoisted(
  () => [] as { name: string; input: Record<string, unknown> }[]
);
const s3DestroyMock = vi.hoisted(() => vi.fn());
const s3SendMock = vi.hoisted(() =>
  vi.fn(async (cmd: { _name: string; input: Record<string, unknown> }) => {
    s3SendCalls.push({ name: cmd._name, input: cmd.input });
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
    // Issue #2346 site 7: the noncurrent-version purge in `cleanup()` reaches
    // for these two. Leaving them out of the mock is NOT neutral — the helper
    // catches its own construction failure and warns, so every purge
    // assertion would read as "no purge calls" whether or not the purge is
    // wired up, which is a false green rather than a failing test.
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
  };
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: s3SendMock, destroy: s3DestroyMock })),
  PutObjectCommand: s3Commands.PutObjectCommand,
  DeleteObjectCommand: s3Commands.DeleteObjectCommand,
  ListObjectVersionsCommand: s3Commands.ListObjectVersionsCommand,
  DeleteObjectsCommand: s3Commands.DeleteObjectsCommand,
}));

const resolveBucketRegionMock = vi.hoisted(() => vi.fn(async () => 'eu-west-1'));
vi.mock('../../../src/utils/aws-region-resolver.js', () => ({
  resolveBucketRegion: resolveBucketRegionMock,
}));

import {
  CFN_TEMPLATE_BODY_LIMIT,
  CFN_TEMPLATE_URL_LIMIT,
  MIGRATE_TMP_PREFIX,
  LARGE_INLINE_RESOURCE_THRESHOLD,
  findLargeInlineResources,
  uploadCfnTemplate,
} from '../../../src/cli/upload-cfn-template.js';

describe('upload-cfn-template constants', () => {
  it('exports the canonical CloudFormation TemplateBody / TemplateURL limits', () => {
    expect(CFN_TEMPLATE_BODY_LIMIT).toBe(51_200);
    expect(CFN_TEMPLATE_URL_LIMIT).toBe(1_048_576);
    expect(MIGRATE_TMP_PREFIX).toBe('cdkd-migrate-tmp');
    // Threshold is intentionally small enough to flag typical inline
    // Lambda Code.ZipFile payloads (~4 KB).
    expect(LARGE_INLINE_RESOURCE_THRESHOLD).toBe(4096);
  });
});

describe('uploadCfnTemplate', () => {
  beforeEach(() => {
    s3SendCalls.length = 0;
    s3SendMock.mockClear();
    s3DestroyMock.mockClear();
    resolveBucketRegionMock.mockClear();
    resolveBucketRegionMock.mockResolvedValue('eu-west-1');
    // Re-attach the default success implementation in case a prior test
    // swapped it for a failing variant.
    s3SendMock.mockImplementation(async (cmd) => {
      s3SendCalls.push({ name: cmd._name, input: cmd.input });
      if (cmd._name === 'ListObjectVersions') {
        return {
          Versions: [
            { Key: cmd.input['Prefix'], VersionId: 'v-body', IsLatest: false },
            // The delete marker the bare DeleteObject just wrote: CURRENT, so
            // the purge must leave it, or the template body comes back live.
            { Key: cmd.input['Prefix'], VersionId: 'dm', IsLatest: true },
          ],
          IsTruncated: false,
        };
      }
      return {};
    });
  });

  it('issues PutObject under cdkd-migrate-tmp/<stack>/<ts>.json with the correct ContentType', async () => {
    const { url } = await uploadCfnTemplate({
      bucket: 'state-bucket',
      body: '{"hello":"world"}',
      stackName: 'MyStack',
    });

    expect(s3SendCalls).toHaveLength(1);
    const put = s3SendCalls[0]!;
    expect(put.name).toBe('PutObject');
    expect(put.input['Bucket']).toBe('state-bucket');
    expect(String(put.input['Key'])).toMatch(/^cdkd-migrate-tmp\/MyStack\/\d+\.json$/);
    expect(put.input['Body']).toBe('{"hello":"world"}');
    expect(put.input['ContentType']).toBe('application/json');
    // Virtual-hosted URL with explicit region pulled from the resolver.
    expect(url).toMatch(
      /^https:\/\/state-bucket\.s3\.eu-west-1\.amazonaws\.com\/cdkd-migrate-tmp\/MyStack\/\d+\.json$/
    );
    expect(resolveBucketRegionMock).toHaveBeenCalledWith('state-bucket', expect.anything());
  });

  it('runs DeleteObject + destroys the S3 client when cleanup is invoked (success path)', async () => {
    const { cleanup } = await uploadCfnTemplate({
      bucket: 'state-bucket',
      body: '{"hello":"world"}',
      stackName: 'MyStack',
    });

    await cleanup();

    // The purge pair is part of cleanup's contract, not an extra: the state
    // bucket is versioned, so the DeleteObject alone leaves the uploaded
    // template body readable by VersionId (issue #2346 site 7).
    expect(s3SendCalls.map((c) => c.name)).toEqual([
      'PutObject',
      'DeleteObject',
      'ListObjectVersions',
      'DeleteObjects',
    ]);
    const put = s3SendCalls[0]!;
    const del = s3SendCalls[1]!;
    expect(del.input['Bucket']).toBe('state-bucket');
    expect(del.input['Key']).toBe(put.input['Key']);
    expect(s3DestroyMock).toHaveBeenCalledTimes(1);
  });

  it('PURGES the transient template body noncurrent versions (issue #2346 site 7)', async () => {
    // Discriminator: the ARGUMENT of DeleteObjects. Pre-fix `cleanup()` issued
    // exactly one command, so this list was absent entirely; and a purge that
    // dropped the `IsLatest` filter would carry `dm` too, undoing the delete.
    const { cleanup } = await uploadCfnTemplate({
      bucket: 'state-bucket',
      body: '{"Resources":{"Fn":{"Properties":{"Code":{"ZipFile":"secret"}}}}}',
      stackName: 'MyStack',
    });
    const key = s3SendCalls[0]!.input['Key'];

    await cleanup();

    const list = s3SendCalls.find((c) => c.name === 'ListObjectVersions')!;
    // Key-scoped, never prefix-scoped: `cdkd-migrate-tmp/<stack>/` can hold a
    // CONCURRENT command's live upload.
    expect(list.input['Prefix']).toBe(key);
    expect(list.input['Bucket']).toBe('state-bucket');

    const purge = s3SendCalls.find((c) => c.name === 'DeleteObjects')!;
    expect((purge.input['Delete'] as { Objects: unknown[] }).Objects).toEqual([
      { Key: key, VersionId: 'v-body' },
    ]);
  });

  it('purges even when DeleteObject throws, and still rethrows the delete error', async () => {
    // A failed delete is exactly when the bodies are most likely to survive.
    // The purge's `IsLatest` filter keeps this safe: the live object stays and
    // only its history goes. The delete's error must still reach the caller —
    // every `cleanup()` call site catches it to name the leftover key.
    s3SendMock.mockImplementation(async (cmd) => {
      s3SendCalls.push({ name: cmd._name, input: cmd.input });
      if (cmd._name === 'DeleteObject') throw new Error('S3 access denied on delete');
      if (cmd._name === 'ListObjectVersions') {
        return {
          Versions: [{ Key: cmd.input['Prefix'], VersionId: 'v-body', IsLatest: false }],
          IsTruncated: false,
        };
      }
      return {};
    });

    const { cleanup } = await uploadCfnTemplate({
      bucket: 'state-bucket',
      body: 'body',
      stackName: 'MyStack',
    });

    await expect(cleanup()).rejects.toThrow(/S3 access denied on delete/);
    expect(s3SendCalls.map((c) => c.name)).toEqual([
      'PutObject',
      'DeleteObject',
      'ListObjectVersions',
      'DeleteObjects',
    ]);
    expect(s3DestroyMock).toHaveBeenCalledTimes(1);
  });

  it('destroys the S3 client and rethrows when PutObject fails (no DeleteObject)', async () => {
    s3SendMock.mockImplementationOnce(async () => {
      throw new Error('S3 access denied on put');
    });

    await expect(
      uploadCfnTemplate({
        bucket: 'state-bucket',
        body: 'body',
        stackName: 'MyStack',
      })
    ).rejects.toThrow(/S3 access denied on put/);

    // PutObject was attempted but no DeleteObject ever runs (no upload to
    // clean up). The S3 client must still be destroyed so the connection
    // pool does not leak.
    expect(s3SendCalls).toHaveLength(0);
    expect(s3DestroyMock).toHaveBeenCalledTimes(1);
  });

  it('still destroys the S3 client when DeleteObject throws inside cleanup', async () => {
    s3SendMock.mockImplementation(async (cmd) => {
      s3SendCalls.push({ name: cmd._name, input: cmd.input });
      if (cmd._name === 'DeleteObject') throw new Error('S3 access denied on delete');
      return {};
    });

    const { cleanup } = await uploadCfnTemplate({
      bucket: 'state-bucket',
      body: 'body',
      stackName: 'MyStack',
    });

    await expect(cleanup()).rejects.toThrow(/S3 access denied on delete/);
    // S3Client.destroy() must run in the inner `finally` so the
    // connection pool does not leak even when DeleteObject fails.
    expect(s3DestroyMock).toHaveBeenCalledTimes(1);
  });

  it('forwards profile + credentials to the S3 client and the region resolver', async () => {
    await uploadCfnTemplate({
      bucket: 'state-bucket',
      body: 'body',
      stackName: 'MyStack',
      s3ClientOpts: {
        profile: 'my-profile',
        credentials: {
          accessKeyId: 'fake-key',
          secretAccessKey: 'fake-secret',
          sessionToken: 'fake-token',
        },
      },
    });

    expect(resolveBucketRegionMock).toHaveBeenCalledWith(
      'state-bucket',
      expect.objectContaining({
        profile: 'my-profile',
        credentials: expect.objectContaining({ accessKeyId: 'fake-key' }),
      })
    );
  });

  it('uses the URL region returned by resolveBucketRegion (us-east-1)', async () => {
    resolveBucketRegionMock.mockResolvedValueOnce('us-east-1');
    const { url } = await uploadCfnTemplate({
      bucket: 'us-east-bucket',
      body: 'body',
      stackName: 'S',
    });
    expect(url).toMatch(
      /^https:\/\/us-east-bucket\.s3\.us-east-1\.amazonaws\.com\/cdkd-migrate-tmp\/S\/\d+\.json$/
    );
  });

  // ---------- partition URL suffixes (issue #1758) ----------
  // The TemplateURL host suffix is derived from the bucket's region, so a
  // non-commercial bucket gets a hostname CloudFormation can actually fetch.
  // Each case is paired with a commercial counter-case asserting the
  // unchanged (byte-identical) URL.

  it('derives the TemplateURL host suffix from the bucket region (aws-cn)', async () => {
    resolveBucketRegionMock.mockResolvedValueOnce('cn-north-1');
    const { url } = await uploadCfnTemplate({
      bucket: 'cn-bucket',
      body: 'body',
      stackName: 'S',
    });
    expect(url).toMatch(
      /^https:\/\/cn-bucket\.s3\.cn-north-1\.amazonaws\.com\.cn\/cdkd-migrate-tmp\/S\/\d+\.json$/
    );

    resolveBucketRegionMock.mockResolvedValueOnce('eu-west-1');
    const commercial = await uploadCfnTemplate({
      bucket: 'cn-bucket',
      body: 'body',
      stackName: 'S',
    });
    expect(commercial.url).toMatch(
      /^https:\/\/cn-bucket\.s3\.eu-west-1\.amazonaws\.com\/cdkd-migrate-tmp\/S\/\d+\.json$/
    );
  });

  it('derives the TemplateURL host suffix in us-iso / us-isob, and keeps us-gov commercial', async () => {
    resolveBucketRegionMock.mockResolvedValueOnce('us-iso-east-1');
    const iso = await uploadCfnTemplate({ bucket: 'b', body: 'body', stackName: 'S' });
    expect(iso.url).toMatch(
      /^https:\/\/b\.s3\.us-iso-east-1\.c2s\.ic\.gov\/cdkd-migrate-tmp\/S\/\d+\.json$/
    );

    resolveBucketRegionMock.mockResolvedValueOnce('us-isob-east-1');
    const isob = await uploadCfnTemplate({ bucket: 'b', body: 'body', stackName: 'S' });
    expect(isob.url).toMatch(
      /^https:\/\/b\.s3\.us-isob-east-1\.sc2s\.sgov\.gov\/cdkd-migrate-tmp\/S\/\d+\.json$/
    );

    // GovCloud shares the commercial suffix.
    resolveBucketRegionMock.mockResolvedValueOnce('us-gov-west-1');
    const gov = await uploadCfnTemplate({ bucket: 'b', body: 'body', stackName: 'S' });
    expect(gov.url).toMatch(
      /^https:\/\/b\.s3\.us-gov-west-1\.amazonaws\.com\/cdkd-migrate-tmp\/S\/\d+\.json$/
    );
  });
});

describe('findLargeInlineResources', () => {
  it('returns an empty array for a template with no Resources', () => {
    expect(findLargeInlineResources({})).toEqual([]);
    expect(findLargeInlineResources({ Resources: null as unknown as object })).toEqual([]);
    expect(findLargeInlineResources({ Resources: [] as unknown as object })).toEqual([]);
  });

  it('flags resources whose Properties exceeds the default 4096-byte threshold', () => {
    const big = 'x'.repeat(5000);
    const template = {
      Resources: {
        SmallBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { Tag: 'tiny' },
        },
        BigLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: { Code: { ZipFile: big } },
        },
        BiggerLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: { Code: { ZipFile: big + big } },
        },
      },
    };

    const result = findLargeInlineResources(template);

    // Only the two large resources are reported, sorted descending.
    expect(result.map((r) => r.logicalId)).toEqual(['BiggerLambda', 'BigLambda']);
    expect(result[0]!.resourceType).toBe('AWS::Lambda::Function');
    expect(result[0]!.approxBytes).toBeGreaterThan(result[1]!.approxBytes);
  });

  it('respects a custom threshold and reports `<unknown>` Type for resources missing the Type key', () => {
    const template = {
      Resources: {
        A: { Properties: { v: 'aa' } },
      },
    };
    const result = findLargeInlineResources(template, 1);
    expect(result).toHaveLength(1);
    expect(result[0]!).toMatchObject({ logicalId: 'A', resourceType: '<unknown>' });
    expect(result[0]!.approxBytes).toBeGreaterThan(0);
  });

  it('skips resources without a Properties block', () => {
    const template = {
      Resources: {
        NoProps: { Type: 'AWS::IAM::Role' },
        AlsoNoProps: { Type: 'AWS::S3::Bucket', Properties: null },
      },
    };
    expect(findLargeInlineResources(template, 1)).toEqual([]);
  });
});
