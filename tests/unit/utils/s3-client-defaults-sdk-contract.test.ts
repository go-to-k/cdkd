import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeleteBucketCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import {
  resetS3ClientDefaults,
  resolveS3ClientDefaults,
  s3ClientDefaults,
} from '../../../src/utils/s3-client-defaults.js';

/**
 * The SDK behaviours the S3 addressing design rests on (issue #5745), pinned
 * on the installed SDK so a bump that changes one is noticed. Offline:
 * `getSignedUrl` with fake credentials builds the URL locally and sends
 * nothing (S3 Express session auth is disabled so it cannot reach for
 * CreateSession).
 */

const FAKE = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/EXAMPLEKEY' };

const AWS_ENV = [
  'HOME',
  'USERPROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_S3',
  'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
  'AWS_USE_FIPS_ENDPOINT',
  'AWS_USE_DUALSTACK_ENDPOINT',
  'CDK_S3_FORCE_PATH_STYLE',
] as const;

const scratch: string[] = [];
let saved: Record<string, string | undefined>;

function configFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-s3-contract-'));
  scratch.push(dir);
  const path = join(dir, 'config');
  writeFileSync(path, contents);
  return path;
}

beforeEach(() => {
  saved = Object.fromEntries(AWS_ENV.map((n) => [n, process.env[n]]));
  for (const n of AWS_ENV) delete process.env[n];
  process.env['AWS_CONFIG_FILE'] = configFile('');
  process.env['AWS_SHARED_CREDENTIALS_FILE'] = configFile('');
  resetS3ClientDefaults();
});

afterEach(() => {
  for (const n of AWS_ENV) {
    const v = saved[n];
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  resetS3ClientDefaults();
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

async function presign(
  config: S3ClientConfig,
  input: { Bucket: string; Key?: string },
  command: 'put' | 'delete-bucket' = 'put'
): Promise<string> {
  const client = new S3Client({
    region: 'us-east-1',
    credentials: FAKE,
    disableS3ExpressSessionAuth: true,
    ...config,
  });
  try {
    return command === 'put'
      ? await getSignedUrl(
          client,
          new PutObjectCommand({ Bucket: input.Bucket, Key: input.Key ?? 'k' }),
          { expiresIn: 60 }
        )
      : await getSignedUrl(client, new DeleteBucketCommand({ Bucket: input.Bucket }), {
          expiresIn: 60,
        });
  } finally {
    client.destroy();
  }
}

const base = (url: string): string => url.split('?')[0]!;

describe('SDK contract: S3 addressing under an endpoint override', () => {
  it('the bug: AWS_ENDPOINT_URL_S3 alone gives a VIRTUAL-hosted URL against the override', async () => {
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    expect(base(await presign({}, { Bucket: 'mybucket' }))).toBe('http://mybucket.s3:4566/k');
  });

  it('the fix: the resolved defaults give http://s3:4566/<bucket>/<key>', async () => {
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    await resolveS3ClientDefaults();
    expect(base(await presign(s3ClientDefaults(), { Bucket: 'mybucket', Key: 'a/b c' }))).toBe(
      'http://s3:4566/mybucket/a/b%20c'
    );
  });

  it('the SDK still IGNORES a profile s3.addressing_style (re-decide this design if it starts honouring it)', async () => {
    process.env['AWS_CONFIG_FILE'] = configFile('[default]\ns3 =\n  addressing_style = path\n');
    expect(base(await presign({}, { Bucket: 'mybucket' }))).toBe(
      'https://mybucket.s3.us-east-1.amazonaws.com/k'
    );
    const client = new S3Client({ region: 'us-east-1' });
    try {
      expect(await client.config.forcePathStyle).toBe(false);
    } finally {
      client.destroy();
    }
  });

  it('a path-prefixed endpoint keeps its prefix before the bucket', async () => {
    expect(
      base(
        await presign(
          { endpoint: 'http://s3:4566/pre/fix', forcePathStyle: true },
          { Bucket: 'mybucket' }
        )
      )
    ).toBe('http://s3:4566/pre/fix/mybucket/k');
  });

  it('a dotted bucket name is already path-style, with or without the flag', async () => {
    for (const config of [{}, { forcePathStyle: true }]) {
      expect(base(await presign({ endpoint: 'http://s3:4566', ...config }, { Bucket: 'my.bucket' }))).toBe(
        'http://s3:4566/my.bucket/k'
      );
    }
  });

  it('S3 Express (--x-s3) buckets ignore forcePathStyle, on AWS and under an override', async () => {
    const bucket = 'b--use1-az4--x-s3';
    for (const endpoint of [undefined, 'http://s3:4566']) {
      const cfg = endpoint === undefined ? {} : { endpoint };
      expect(base(await presign({ ...cfg, forcePathStyle: true }, { Bucket: bucket }))).toBe(
        base(await presign(cfg, { Bucket: bucket }))
      );
    }
    expect(base(await presign({ forcePathStyle: true }, { Bucket: bucket }))).toBe(
      'https://b--use1-az4--x-s3.s3express-use1-az4.us-east-1.amazonaws.com/k'
    );
    expect(base(await presign({ forcePathStyle: true }, { Bucket: bucket }, 'delete-bucket'))).toBe(
      'https://s3express-control.us-east-1.amazonaws.com/b--use1-az4--x-s3/'
    );
    expect(base(await presign({ forcePathStyle: true }, { Bucket: bucket }, 'delete-bucket'))).toBe(
      base(await presign({}, { Bucket: bucket }, 'delete-bucket'))
    );
  });

  it('a top-level ARN Bucket is REFUSED under path-style (no cdkd S3 request sends one)', async () => {
    const arn = 'arn:aws:s3:us-east-1:123456789012:accesspoint/ap';
    await expect(
      presign({ endpoint: 'http://s3:4566', forcePathStyle: true }, { Bucket: arn })
    ).rejects.toThrow('Path-style addressing cannot be used with ARN buckets');
  });

  it.each([
    ['useFipsEndpoint', 'A custom endpoint cannot be combined with FIPS'],
    ['useDualstackEndpoint', 'Cannot set dual-stack in combination with a custom endpoint'],
    ['useAccelerateEndpoint', 'A custom endpoint cannot be combined with S3 Accelerate'],
  ] as const)('%s + an override is ALREADY an SDK error, with or without the flag', async (key, msg) => {
    for (const forcePathStyle of [false, true]) {
      await expect(
        presign({ endpoint: 'http://s3:4566', [key]: true, forcePathStyle }, { Bucket: 'mybucket' })
      ).rejects.toThrow(msg);
    }
  });

  it('AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: the SDK goes to AWS, and the resolver adds nothing', async () => {
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    process.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'] = 'true';
    await resolveS3ClientDefaults();
    expect(s3ClientDefaults()).toEqual({});
    expect(base(await presign(s3ClientDefaults(), { Bucket: 'mybucket' }))).toBe(
      'https://mybucket.s3.us-east-1.amazonaws.com/k'
    );
  });

  it('path-style against real AWS (addressing_style = path) is the regional path form', async () => {
    expect(base(await presign({ forcePathStyle: true, region: 'eu-west-1' }, { Bucket: 'mybucket' }))).toBe(
      'https://s3.eu-west-1.amazonaws.com/mybucket/k'
    );
  });

  it('the host is SIGNED: the signed headers name host, so a rewritten host cannot verify', async () => {
    const url = new URL(await presign({ endpoint: 'http://s3:4566', forcePathStyle: true }, { Bucket: 'b' }));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});
