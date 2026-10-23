/**
 * go-to-k/cdkd#5219: the S3 client `Fn::GetStackOutput` builds for a
 * cross-account state read must keep the SDK call log's counting logger, like
 * every other S3 client (`tests/unit/utils/s3-client-call-log.test.ts`).
 */
import { Readable } from 'node:stream';
import { describe, it, expect, afterEach, vi } from 'vite-plus/test';
import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';

const built: S3Client[] = [];

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: class {
    constructor(s3: S3Client) {
      built.push(s3);
    }
    getState(): Promise<null> {
      return Promise.resolve(null);
    }
  },
}));
vi.mock('../../../src/utils/aws-region-resolver.js', () => ({
  resolveCrossAccountStateBucket: vi.fn(async () => ({
    bucket: 'cdkd-state-210987654321',
    region: 'us-east-1',
  })),
}));
vi.mock('../../../src/utils/role-arn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/role-arn.js')>()),
  assumeRoleForCrossAccountStateRead: vi.fn(async () => ({
    accessKeyId: 'AKIAFAKE',
    secretAccessKey: 'fake',
    sessionToken: 'token',
  })),
}));

import { getCrossAccountStackState } from '../../../src/deployment/intrinsic-resolver/stack-state.js';
import {
  SDK_CALL_LOG_ENV,
  resetSdkCallCounts,
  sdkCallCounts,
} from '../../../src/utils/sdk-call-log.js';

afterEach(() => {
  delete process.env[SDK_CALL_LOG_ENV];
  resetSdkCallCounts();
  built.length = 0;
});

describe('the cross-account state read and the SDK call log (go-to-k/cdkd#5219)', () => {
  it("its S3 client's commands are counted while the log is on", async () => {
    process.env[SDK_CALL_LOG_ENV] = '/dev/null';

    await getCrossAccountStackState(
      'arn:aws:iam::210987654321:role/Reader',
      'Producer',
      'us-east-1',
      {} as never
    );

    expect(built).toHaveLength(1);
    const s3 = built[0]!;
    (s3.config as unknown as { requestHandler: unknown }).requestHandler = {
      handle: () =>
        Promise.resolve({ response: { statusCode: 200, headers: {}, body: Readable.from([]) } }),
    };
    await s3.send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' }));
    expect(sdkCallCounts()).toEqual({ 'S3Client.HeadObjectCommand': 1 });
  });

  it('its S3 client hides the unknown-length warning with the log off', async () => {
    await getCrossAccountStackState(
      'arn:aws:iam::210987654321:role/Reader',
      'Producer',
      'us-east-1',
      {} as never
    );
    // The SDK sends the warning to `console.warn` only for its default
    // `NoOpLogger`; a logger of the client's own takes it on `warn`.
    const logger = built[0]!.config.logger as { warn: (m: string) => void; constructor: unknown };
    expect((logger.constructor as { name: string }).name).not.toBe('NoOpLogger');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      logger.warn('Are you using a Stream of unknown length as the Body of a PutObject request?');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
