import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue #5745: the custom-resource ResponseURL under an S3 endpoint override
 * (path-style, through the bucket-region rebuild too) and under
 * `CDKD_CR_S3_ENDPOINT_URL` (signed for THAT host). Real `S3Client`s and the
 * real presigner: only `send` is stubbed, so the URL is the one the SDK builds.
 */

const mockLambdaSend = vi.fn();
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));
const holder = vi.hoisted(() => ({ s3: undefined as unknown }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: vi.fn() },
    s3: holder.s3,
    sts: { send: mockStsSend },
  }),
}));

/** EVERY logger level, root and child alike, so a leak at any level is seen. */
const debugLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const record = (...args: unknown[]): void => {
    debugLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const child = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({ child: () => child, debug: record, info: record, warn: record, error: record }),
  };
});

const mockResolveBucketRegion = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-region-resolver.js', () => ({
  resolveBucketRegion: mockResolveBucketRegion,
}));

vi.mock('../../../src/state/state-bucket-lifecycle.js', () => ({
  ensureCustomResourceResponseExpirationOnce: vi.fn(() => Promise.resolve()),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';
import {
  CR_S3_ENDPOINT_ENV,
  customResourceS3Endpoint,
  responsePresignClient,
} from '../../../src/provisioning/providers/custom-resource-response-endpoint.js';
import {
  resetS3ClientDefaults,
  resolveS3ClientDefaults,
  s3ClientDefaults,
} from '../../../src/utils/s3-client-defaults.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { clearReplicationProbeCache } from '../../../src/state/s3-replication-purge-gap.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const FAKE = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/EXAMPLEKEY' };
const BUCKET = 'cdkd-state-123456789012';
const ENV = [
  'HOME',
  'USERPROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_S3',
  'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
  'CDK_S3_FORCE_PATH_STYLE',
  'AWS_CONFIG_FILE',
  'AWS_PROFILE',
  CR_S3_ENDPOINT_ENV,
] as const;
let saved: Record<string, string | undefined>;
const builtClients: S3Client[] = [];

function realS3Client(region: string): S3Client {
  // Built the way AwsClients builds its S3 client: the defaults spread in.
  const client = new S3Client({ ...s3ClientDefaults(), region, credentials: FAKE });
  builtClients.push(client);
  return client;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));
  for (const n of ENV) delete process.env[n];
  process.env['AWS_CONFIG_FILE'] = '/dev/null';
  process.env['AWS_SHARED_CREDENTIALS_FILE'] = '/dev/null';
  process.env['HOME'] = '/nonexistent-home-5745';
  resetS3ClientDefaults();
  clearReplicationProbeCache();
  debugLines.length = 0;
  mockLambdaSend.mockReset();
  mockResolveBucketRegion.mockReset();
  // Every S3 command any client sends (placeholder PUT, cleanup) answers
  // locally; nothing reaches a socket.
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(() =>
    Promise.resolve({ Versions: [], DeleteMarkers: [], IsTruncated: false } as never)
  );
});

afterEach(() => {
  for (const n of ENV) {
    const v = saved[n];
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  resetS3ClientDefaults();
  vi.restoreAllMocks();
  for (const c of builtClients.splice(0)) c.destroy();
});

/** Run one direct-payload create and return the ResponseURL the Lambda received. */
async function responseUrlOfOneCreate(provider: CustomResourceProvider): Promise<string> {
  let responseUrl: string | undefined;
  mockLambdaSend
    .mockResolvedValueOnce({ Configuration: { State: 'Active' } })
    .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
    .mockImplementationOnce((cmd: { input: { Payload: Uint8Array } }) => {
      responseUrl = (JSON.parse(Buffer.from(cmd.input.Payload).toString()) as { ResponseURL: string })
        .ResponseURL;
      return Promise.resolve({
        Payload: Buffer.from(JSON.stringify({ PhysicalResourceId: 'phys-5745', Data: {} })),
      });
    });
  await provider.create('MyCustom', 'Custom::MyResource', {
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
  });
  expect(responseUrl).toBeDefined();
  return responseUrl!;
}

describe('CR ResponseURL under an S3 endpoint override (issue #5745)', () => {
  it('is path-style against the override: http://s3:4566/<bucket>/<key>', async () => {
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    await resolveS3ClientDefaults();
    holder.s3 = realS3Client('us-east-1');
    mockResolveBucketRegion.mockResolvedValue('us-east-1');
    const provider = new CustomResourceProvider();
    provider.setResponseBucket(BUCKET);
    const url = new URL(await responseUrlOfOneCreate(provider));
    expect(url.origin).toBe('http://s3:4566');
    expect(url.pathname).toMatch(new RegExp(`^/${BUCKET}/custom-resource-responses/cdkd-`));
  });

  it('stays path-style AFTER the foreign-region rebuild, signed for the bucket region', async () => {
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    await resolveS3ClientDefaults();
    holder.s3 = realS3Client('us-east-1');
    mockResolveBucketRegion.mockResolvedValue('eu-west-1');
    const provider = new CustomResourceProvider();
    provider.setResponseBucket(BUCKET);
    const url = new URL(await responseUrlOfOneCreate(provider));
    expect(url.origin).toBe('http://s3:4566');
    expect(url.pathname.startsWith(`/${BUCKET}/`)).toBe(true);
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/eu-west-1/s3/aws4_request');
  });

  it('without an override the URL is exactly the virtual-hosted AWS form it was', async () => {
    await resolveS3ClientDefaults();
    holder.s3 = realS3Client('us-east-1');
    mockResolveBucketRegion.mockResolvedValue('us-east-1');
    const provider = new CustomResourceProvider();
    provider.setResponseBucket(BUCKET);
    const url = new URL(await responseUrlOfOneCreate(provider));
    expect(url.origin).toBe(`https://${BUCKET}.s3.us-east-1.amazonaws.com`);
  });
});

describe('CDKD_CR_S3_ENDPOINT_URL (issue #5745)', () => {
  it('signs the ResponseURL for THAT host (path-style), leaving the response client alone', async () => {
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://localhost:4566';
    process.env[CR_S3_ENDPOINT_ENV] = 'http://s3:4566';
    await resolveS3ClientDefaults();
    const base = realS3Client('us-east-1');
    holder.s3 = base;
    mockResolveBucketRegion.mockResolvedValue('us-east-1');
    const provider = new CustomResourceProvider();
    provider.setResponseBucket(BUCKET);
    const url = new URL(await responseUrlOfOneCreate(provider));
    expect(url.origin).toBe('http://s3:4566');
    expect(url.pathname.startsWith(`/${BUCKET}/`)).toBe(true);
    // The placeholder PUT went through cdkd's own (localhost) client.
    const sendMock = vi.mocked(S3Client.prototype.send).mock;
    const putIndexes = sendMock.calls.flatMap(([command], i) =>
      command instanceof PutObjectCommand ? [i] : []
    );
    expect(putIndexes).toHaveLength(1);
    expect(sendMock.contexts[putIndexes[0]!]).toBe(base);
    // Only the origin is logged, never the URL or its query string. Positive
    // control: the URL the Lambda got DOES carry the signature, so its absence
    // from every log line is a real negative.
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    const line = debugLines.find((l) => l.includes(CR_S3_ENDPOINT_ENV));
    expect(line).toContain('http://s3:4566');
    expect(debugLines.join('\n')).not.toContain('X-Amz-Signature');
    expect(debugLines.join('\n')).not.toContain('X-Amz-Credential');
  });

  it('logs the ORIGIN of a path-prefixed endpoint, never its path', async () => {
    process.env[CR_S3_ENDPOINT_ENV] = 'http://s3:4566/secret-prefix';
    await resolveS3ClientDefaults();
    holder.s3 = realS3Client('us-east-1');
    mockResolveBucketRegion.mockResolvedValue('us-east-1');
    const provider = new CustomResourceProvider();
    provider.setResponseBucket(BUCKET);
    const url = new URL(await responseUrlOfOneCreate(provider));
    expect(url.pathname.startsWith(`/secret-prefix/${BUCKET}/`)).toBe(true);
    const line = debugLines.find((l) => l.includes(CR_S3_ENDPOINT_ENV));
    expect(line).toContain('(http://s3:4566)');
    expect(debugLines.join('\n')).not.toContain('secret-prefix');
  });

  it('survives the bucket-region rebuild: the presign client follows the REBUILT region', async () => {
    process.env[CR_S3_ENDPOINT_ENV] = 'http://s3:4566';
    await resolveS3ClientDefaults();
    holder.s3 = realS3Client('us-east-1');
    mockResolveBucketRegion.mockResolvedValue('ap-northeast-1');
    const provider = new CustomResourceProvider();
    provider.setResponseBucket(BUCKET);
    const url = new URL(await responseUrlOfOneCreate(provider));
    expect(url.origin).toBe('http://s3:4566');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      `${FAKE.accessKeyId}/${url.searchParams.get('X-Amz-Date')!.slice(0, 8)}/ap-northeast-1/s3/aws4_request`
    );
  });

  it('the signature is the one a client signing for that host computes; a rewritten host is not', async () => {
    await resolveS3ClientDefaults();
    const base = realS3Client('eu-west-1');
    const endpoint = customResourceS3Endpoint({ [CR_S3_ENDPOINT_ENV]: 'http://s3:4566' })!;
    const presigner = await responsePresignClient(base, endpoint);
    const signingDate = new Date('2026-11-04T00:00:00Z');
    const cmd = () => new PutObjectCommand({ Bucket: 'b', Key: 'k' });
    const signed = await getSignedUrl(presigner, cmd(), { expiresIn: 7200, signingDate });
    const reference = new S3Client({
      region: 'eu-west-1',
      credentials: FAKE,
      endpoint: 'http://s3:4566',
      forcePathStyle: true,
    });
    builtClients.push(reference);
    expect(signed).toBe(await getSignedUrl(reference, cmd(), { expiresIn: 7200, signingDate }));
    // Signing for AWS's host and swapping the host afterwards gives a
    // DIFFERENT signature: the host is signed, so a rewrite cannot verify.
    const awsSigned = new URL(await getSignedUrl(base, cmd(), { expiresIn: 7200, signingDate }));
    expect(awsSigned.searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(signed).searchParams.get('X-Amz-Signature')
    );
  });

  it('reuses one presign client per response client, and builds a new one for a new client', async () => {
    await resolveS3ClientDefaults();
    const endpoint = customResourceS3Endpoint({ [CR_S3_ENDPOINT_ENV]: 'http://s3:4566' })!;
    const a = realS3Client('us-east-1');
    const b = realS3Client('eu-west-1');
    const pa = await responsePresignClient(a, endpoint);
    expect(await responsePresignClient(a, endpoint)).toBe(pa);
    const pb = await responsePresignClient(b, endpoint);
    expect(pb).not.toBe(pa);
    expect(await pb.config.region()).toBe('eu-west-1');
    // Same response client, a DIFFERENT endpoint: a new client, signing for it.
    const other = customResourceS3Endpoint({ [CR_S3_ENDPOINT_ENV]: 'http://other:9000' })!;
    const pa2 = await responsePresignClient(a, other);
    expect(pa2).not.toBe(pa);
    const signed = new URL(
      await getSignedUrl(pa2, new PutObjectCommand({ Bucket: 'mybucket', Key: 'k' }))
    );
    expect(signed.origin).toBe('http://other:9000');
    builtClients.push(pa, pb, pa2);
  });

  it('a failed build is not cached: the next call builds afresh', async () => {
    await resolveS3ClientDefaults();
    const endpoint = customResourceS3Endpoint({ [CR_S3_ENDPOINT_ENV]: 'http://s3:4566' })!;
    const base = realS3Client('us-east-1');
    const realRegion = base.config.region;
    let calls = 0;
    (base.config as { region: () => Promise<string> }).region = () =>
      ++calls === 1 ? Promise.reject(new Error('region unavailable')) : realRegion();
    await expect(responsePresignClient(base, endpoint)).rejects.toThrow('region unavailable');
    const second = await responsePresignClient(base, endpoint);
    builtClients.push(second);
    expect(calls).toBe(2);
    expect(await second.config.region()).toBe('us-east-1');
  });

  it('concurrent first uses share ONE presign client', async () => {
    await resolveS3ClientDefaults();
    const endpoint = customResourceS3Endpoint({ [CR_S3_ENDPOINT_ENV]: 'http://s3:4566' })!;
    const base = realS3Client('us-east-1');
    const [x, y] = await Promise.all([
      responsePresignClient(base, endpoint),
      responsePresignClient(base, endpoint),
    ]);
    expect(x).toBe(y);
    builtClients.push(x);
  });

  it('honours addressing_style = virtual on the presign client too', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-cr-5745-'));
    writeFileSync(join(dir, 'config'), '[default]\ns3 =\n  addressing_style = virtual\n');
    process.env['AWS_CONFIG_FILE'] = join(dir, 'config');
    await resolveS3ClientDefaults();
    const endpoint = customResourceS3Endpoint({ [CR_S3_ENDPOINT_ENV]: 'http://s3:4566' })!;
    const presigner = await responsePresignClient(realS3Client('us-east-1'), endpoint);
    builtClients.push(presigner);
    const url = new URL(
      await getSignedUrl(presigner, new PutObjectCommand({ Bucket: 'mybucket', Key: 'k' }))
    );
    expect(url.host).toBe('mybucket.s3:4566');
  });

  it('a 127.0.0.1 HTTP server receives the PUT at the signed path', async () => {
    const received: Array<{ method?: string; url?: string; body: string }> = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, body });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      await resolveS3ClientDefaults();
      const endpoint = customResourceS3Endpoint({
        [CR_S3_ENDPOINT_ENV]: `http://127.0.0.1:${port}`,
      })!;
      const presigner = await responsePresignClient(realS3Client('us-east-1'), endpoint);
      builtClients.push(presigner);
      const signed = await getSignedUrl(presigner, new PutObjectCommand({ Bucket: 'b', Key: 'r/k.json' }));
      const res = await fetch(signed, { method: 'PUT', body: '{"Status":"SUCCESS"}' });
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]!.method).toBe('PUT');
      expect(received[0]!.url!.split('?')[0]).toBe('/b/r/k.json');
      expect(received[0]!.body).toBe('{"Status":"SUCCESS"}');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it.each([
    ['not a url', 'is not a URL'],
    ['   ', 'whitespace only'],
    ['ftp://s3:21', 'http:// or https://'],
    ['s3:4566', 'http:// or https://'],
    ['http://user:pw@s3:4566', 'user info'],
    ['http://s3:4566/?x=1', 'query or fragment'],
    ['http://s3:4566/#f', 'query or fragment'],
  ])('refuses %j clearly, naming the variable', (value, reason) => {
    let thrown: unknown;
    try {
      customResourceS3Endpoint({ [CR_S3_ENDPOINT_ENV]: value });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as Error).message).toContain(CR_S3_ENDPOINT_ENV);
    expect((thrown as Error).message).toContain(reason);
    // A rejected value is never echoed back (it may carry user info).
    if (value.includes('pw')) expect((thrown as Error).message).not.toContain('pw');
  });

  it('unset or empty means no override; a path prefix and https are accepted', () => {
    expect(customResourceS3Endpoint({})).toBeUndefined();
    expect(customResourceS3Endpoint({ [CR_S3_ENDPOINT_ENV]: '' })).toBeUndefined();
    expect(customResourceS3Endpoint({ [CR_S3_ENDPOINT_ENV]: ' https://s3.emu:4566/pre ' })).toEqual({
      url: 'https://s3.emu:4566/pre',
      origin: 'https://s3.emu:4566',
    });
  });

  it('a malformed value refuses BEFORE the placeholder PUT, non-retryably', async () => {
    process.env[CR_S3_ENDPOINT_ENV] = 'garbage';
    await resolveS3ClientDefaults();
    holder.s3 = realS3Client('us-east-1');
    mockResolveBucketRegion.mockResolvedValue('us-east-1');
    const provider = new CustomResourceProvider();
    provider.setResponseBucket(BUCKET);
    mockLambdaSend
      .mockResolvedValueOnce({ Configuration: { State: 'Active' } })
      .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } });
    let thrown: unknown;
    try {
      await provider.create('MyCustom', 'Custom::MyResource', {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain(CR_S3_ENDPOINT_ENV);
    expect(isMarkedNonRetryable(thrown)).toBe(true);
    const sentPut = vi
      .mocked(S3Client.prototype.send)
      .mock.calls.some(([command]) => command instanceof PutObjectCommand);
    expect(sentPut).toBe(false);
  });
});
