/**
 * go-to-k/cdkd#5219: the S3 clients carry a silent logger (the SDK's "Stream
 * of unknown length" warning), and that logger used to REPLACE the call log's
 * counting one, so `CDKD_SDK_CALL_LOG` recorded no state, lock or marker call.
 * Each S3 client factory must keep the counting logger while the log is on,
 * and stay silent on `warn` either way.
 */
import { Readable } from 'node:stream';
import { describe, it, expect, afterEach, vi } from 'vite-plus/test';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

vi.mock('../../../src/utils/aws-region-resolver.js', () => ({
  resolveBucketRegion: vi.fn(async () => 'eu-west-1'),
}));

import { AwsClients } from '../../../src/utils/aws-clients.js';
import { rebuildClientForBucketRegion } from '../../../src/utils/bucket-region-client.js';
import {
  SDK_CALL_LOG_ENV,
  quietS3Logger,
  resetSdkCallCounts,
  sdkCallCounts,
} from '../../../src/utils/sdk-call-log.js';

const CREDENTIALS = { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' };

/** Answers every request with an empty 200, without a network. */
const okHandler = {
  handle: () =>
    Promise.resolve({
      response: { statusCode: 200, headers: {}, body: Readable.from([]) },
    }),
};

/** Send one HeadObject through `client` with the network replaced. */
async function headObject(client: S3Client): Promise<void> {
  (client.config as unknown as { requestHandler: unknown }).requestHandler = okHandler;
  await client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' }));
}

/**
 * Whether `client` hides the unknown-length warning. The SDK's
 * `checkContentLengthHeader` sends it to `console.warn` when the client's
 * logger is its default `NoOpLogger`, and to `logger.warn` otherwise -- so a
 * client hides it when its logger is not a `NoOpLogger` and its `warn`
 * prints nothing.
 */
function hidesUnknownLengthWarning(client: S3Client): boolean {
  const logger = client.config.logger as { warn?: (m: string) => void; constructor: { name: string } };
  if (logger.constructor.name === 'NoOpLogger' || typeof logger.warn !== 'function') return false;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    logger.warn('Are you using a Stream of unknown length as the Body of a PutObject request?');
    return warn.mock.calls.length === 0;
  } finally {
    warn.mockRestore();
  }
}

afterEach(() => {
  delete process.env[SDK_CALL_LOG_ENV];
  resetSdkCallCounts();
});

describe('S3 clients and the SDK call log (go-to-k/cdkd#5219)', () => {
  it("AwsClients.getS3Client's commands are counted while the log is on", async () => {
    process.env[SDK_CALL_LOG_ENV] = '/dev/null';
    const s3 = new AwsClients({ region: 'us-east-1', credentials: CREDENTIALS }).getS3Client();

    await headObject(s3);

    expect(sdkCallCounts()).toEqual({ 'S3Client.HeadObjectCommand': 1 });
  });

  it("the bucket-region rebuild's client is counted while the log is on", async () => {
    process.env[SDK_CALL_LOG_ENV] = '/dev/null';
    const original = new S3Client({ region: 'us-east-1', credentials: CREDENTIALS });

    const rebuilt = await rebuildClientForBucketRegion(original, 'b', {
      credentials: CREDENTIALS,
    });

    expect(rebuilt, 'the mocked bucket region differs, so the client is rebuilt').not.toBeNull();
    await headObject(rebuilt!);
    expect(sdkCallCounts()).toEqual({ 'S3Client.HeadObjectCommand': 1 });
  });

  it('CONTROL: with the log off nothing is counted', async () => {
    const s3 = new AwsClients({ region: 'us-east-1', credentials: CREDENTIALS }).getS3Client();

    await headObject(s3);

    expect(sdkCallCounts()).toEqual({});
  });

  it.each([false, true])(
    'the unknown-length warning stays hidden on both clients (call log on: %s)',
    async (logOn) => {
      if (logOn) process.env[SDK_CALL_LOG_ENV] = '/dev/null';
      const fromAwsClients = new AwsClients({
        region: 'us-east-1',
        credentials: CREDENTIALS,
      }).getS3Client();
      const rebuilt = await rebuildClientForBucketRegion(
        new S3Client({ region: 'us-east-1', credentials: CREDENTIALS }),
        'b',
        { credentials: CREDENTIALS }
      );
      // CONTROL: a client with no logger of its own does print it.
      const bare = new S3Client({ region: 'us-east-1', credentials: CREDENTIALS });
      expect(hidesUnknownLengthWarning(bare)).toBe(false);

      expect(hidesUnknownLengthWarning(fromAwsClients)).toBe(true);
      expect(hidesUnknownLengthWarning(rebuilt!)).toBe(true);
    }
  );

  it('quietS3Logger is silent on warn whether the log is on or off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      quietS3Logger().warn('Are you using a Stream of unknown length as the Body?');
      process.env[SDK_CALL_LOG_ENV] = '/dev/null';
      quietS3Logger().warn('Are you using a Stream of unknown length as the Body?');
      expect(warn).not.toHaveBeenCalled();
      expect(sdkCallCounts(), 'a warn is not a command').toEqual({});
    } finally {
      warn.mockRestore();
    }
  });
});
