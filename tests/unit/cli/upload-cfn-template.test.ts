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
  };
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: s3SendMock, destroy: s3DestroyMock })),
  PutObjectCommand: s3Commands.PutObjectCommand,
  DeleteObjectCommand: s3Commands.DeleteObjectCommand,
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

    expect(s3SendCalls.map((c) => c.name)).toEqual(['PutObject', 'DeleteObject']);
    const put = s3SendCalls[0]!;
    const del = s3SendCalls[1]!;
    expect(del.input['Bucket']).toBe('state-bucket');
    expect(del.input['Key']).toBe(put.input['Key']);
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
