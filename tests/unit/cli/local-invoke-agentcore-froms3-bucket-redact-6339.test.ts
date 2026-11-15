import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { resetEmbedConfig, setEmbedConfig } from 'cdk-local';
import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';

/**
 * go-to-k/cdkd#6339: a fromS3 bucket read from a judged cross-stack value
 * (a producer stack's secret, or one cdkd could not check) is still downloaded
 * from, but its name is in neither cdk-local's `Downloading fromS3 code bundle`
 * line nor an error the download throws. The shim is wrapped around the REAL
 * cdk-local downloader, with only its S3 read replaced, so the far side's own
 * wording is what the assertions read.
 */

const DEFAULT_FETCH = async (_loc: unknown): Promise<Uint8Array> => new Uint8Array([1, 2, 3]);
const fetchControl = vi.hoisted(() => ({
  // `undefined`: cdk-local's own S3 read runs, against the stubbed client.
  fetch: undefined as ((loc: unknown) => Promise<Uint8Array>) | undefined,
}));
vi.mock('../../../src/local/agentcore-s3-bundle.js', async () => {
  const real = await vi.importActual<typeof import('cdk-local/internal')>('cdk-local/internal');
  return {
    downloadAndExtractS3Bundle: vi.fn((loc: never, opts: Record<string, unknown> = {}) =>
      real.downloadAndExtractS3Bundle(loc, {
        ...opts,
        ...(fetchControl.fetch !== undefined && { fetchObject: fetchControl.fetch }),
      })
    ),
  };
});

import { downloadAndExtractS3Bundle } from '../../../src/local/agentcore-s3-bundle.js';
import {
  resolveAgentCoreCodeImageFromS3,
  type JudgedS3Source,
} from '../../../src/cli/commands/local-invoke-agentcore/image.js';

const BUCKET = 'producer-judged-bucket-6339';
const KEY = 'bundles/agent.zip';

const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  fetchControl.fetch = DEFAULT_FETCH;
  const record = (message: string): void => {
    lines.push(message);
  };
  setEmbedConfig({
    logger: {
      debug: record,
      info: record,
      warn: record,
      error: record,
      setLevel: () => {},
      getLevel: () => 'debug',
    },
  });
});
afterEach(() => {
  resetEmbedConfig();
  vi.mocked(downloadAndExtractS3Bundle).mockClear();
  vi.restoreAllMocks();
});

async function download(judged: boolean): Promise<Error> {
  const s3Source = { bucket: BUCKET, key: KEY } as { bucket: string; key: string } & JudgedS3Source;
  if (judged) s3Source.bucketJudged = true;
  const err = await resolveAgentCoreCodeImageFromS3(
    { logicalId: 'Runtime', stack: { stackName: 'S6339', region: 'us-east-1' }, resource: {} } as never,
    { runtime: 'PYTHON_3_12', entryPoint: ['main.py'] } as never,
    s3Source,
    {} as never,
    'arm64',
    undefined
  ).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe('invoke-agentcore fromS3: a judged bucket is not printed by the download (go-to-k/cdkd#6339)', () => {
  it('judged: neither the download line nor the unzip error names the bucket', async () => {
    const err = await download(true);
    const downloadLine = lines.find((l) => l.includes('Downloading fromS3 code bundle'));
    expect(downloadLine).toContain(`<cross-stack value withheld>/${KEY}`);
    expect(err.message).toMatch(/Failed to unzip the fromS3 code bundle/);
    expect(err.message).toContain(`<cross-stack value withheld>/${KEY}`);
    for (const text of [...lines, err.message, String(err.stack)]) expect(text).not.toContain(BUCKET);
    expect(vi.mocked(downloadAndExtractS3Bundle).mock.calls[0]?.[0]).toMatchObject({ bucket: BUCKET });
  });

  it('control: an unjudged bucket is still named in the line and the error', async () => {
    const err = await download(false);
    expect(lines.find((l) => l.includes('Downloading fromS3 code bundle'))).toContain(
      `s3://${BUCKET}/${KEY}`
    );
    expect(err.message).toContain(`s3://${BUCKET}/${KEY}`);
    expect(vi.mocked(downloadAndExtractS3Bundle).mock.calls[0]?.[1]).not.toHaveProperty('redactBucket');
  });

  it('judged: an S3 message naming the bucket in its resource ARN is withheld too', async () => {
    fetchControl.fetch = async () => {
      const denied = new Error(
        `User: arn:aws:sts::123456789012:assumed-role/r/s is not authorized to perform: s3:GetObject on resource: "arn:aws:s3:::${BUCKET}/${KEY}"`
      );
      // V8 formats `stack` on first read; read it now, as a logger might,
      // so a later message edit does not reach it on its own.
      void denied.stack;
      throw denied;
    };
    const err = await download(true);
    expect(err.message).toContain(`arn:aws:s3:::<cross-stack value withheld>/${KEY}`);
    expect(err.message).not.toContain(BUCKET);
    expect(String(err.stack)).not.toContain(BUCKET);
  });

  it('control: the same S3 message keeps an unjudged bucket', async () => {
    fetchControl.fetch = async () => {
      throw new Error(`not authorized on resource: "arn:aws:s3:::${BUCKET}/${KEY}"`);
    };
    const err = await download(false);
    expect(err.message).toContain(`arn:aws:s3:::${BUCKET}/${KEY}`);
  });

  it("judged: cdk-local's wrapped AccessDenied, cut mid-bucket by its truncation, names no part of it", async () => {
    fetchControl.fetch = undefined;
    // Pad so cdk-local's 512-character cap falls inside the resource ARN's bucket.
    const lead = 'x'.repeat(512 - 'arn:aws:s3:::'.length - 8);
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async () => {
      throw new S3ServiceException({
        name: 'AccessDenied',
        $fault: 'client',
        $metadata: {},
        message: `${lead}arn:aws:s3:::${BUCKET}/${KEY}`,
      });
    }) as never);
    const err = await download(true);
    expect(err.message).toMatch(/S3 GetObject for s3:\/\/<cross-stack value withheld>\/.* failed: AccessDenied: x+/);
    // cdk-local withholds the bucket BEFORE its cap (cdk-local 0.168.3, go-to-k/cdk-local#985),
    // so the cap now cuts the placeholder, never the bucket.
    expect(err.message).toContain('arn:aws:s3:::<cross-s[... truncated');
    expect(err.message).not.toContain(BUCKET.slice(0, 8));
  });

  it('control: the same wrapped AccessDenied keeps an unjudged bucket prefix', async () => {
    fetchControl.fetch = undefined;
    const lead = 'x'.repeat(512 - 'arn:aws:s3:::'.length - 8);
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async () => {
      throw new S3ServiceException({
        name: 'AccessDenied',
        $fault: 'client',
        $metadata: {},
        message: `${lead}arn:aws:s3:::${BUCKET}/${KEY}`,
      });
    }) as never);
    const err = await download(false);
    expect(err.message).toContain(`arn:aws:s3:::${BUCKET.slice(0, 8)}[... truncated`);
  });
});
