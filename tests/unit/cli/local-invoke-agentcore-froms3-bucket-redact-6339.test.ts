import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { resetEmbedConfig, setEmbedConfig } from 'cdk-local';

/**
 * go-to-k/cdkd#6339: a fromS3 bucket read from a judged cross-stack value
 * (a producer stack's secret, or one cdkd could not check) is still downloaded
 * from, but its name is in neither cdk-local's `Downloading fromS3 code bundle`
 * line nor an error the download throws. The shim is wrapped around the REAL
 * cdk-local downloader, with only its S3 read replaced, so the far side's own
 * wording is what the assertions read.
 */

const fetchControl = vi.hoisted(() => ({
  fetch: async (_loc: unknown): Promise<Uint8Array> => new Uint8Array([1, 2, 3]),
}));
vi.mock('../../../src/local/agentcore-s3-bundle.js', async () => {
  const real = await vi.importActual<typeof import('cdk-local/internal')>('cdk-local/internal');
  return {
    downloadAndExtractS3Bundle: vi.fn((loc: never, opts: Record<string, unknown> = {}) =>
      real.downloadAndExtractS3Bundle(loc, { ...opts, fetchObject: fetchControl.fetch })
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
  fetchControl.fetch = async () => new Uint8Array([1, 2, 3]);
  vi.mocked(downloadAndExtractS3Bundle).mockClear();
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
      throw new Error(
        `User: arn:aws:sts::123456789012:assumed-role/r/s is not authorized to perform: s3:GetObject on resource: "arn:aws:s3:::${BUCKET}/${KEY}"`
      );
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
});
