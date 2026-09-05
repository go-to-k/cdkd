/**
 * Issue [#2635] — the custom-resource response-object debug lines must render
 * every value through `displaySafe`.
 *
 * Two sites, one found by the issue and one by its sibling sweep:
 * `cleanupResponseObject`'s failure line (bucket + response key + AWS error
 * text) and `generatePresignedResponseUrl`'s success line (bucket + response
 * key). Sanitizing one and leaving the other raw is the one-of-N widening
 * `src/utils/display-safe.ts`'s header exists to stop.
 *
 * Every assertion is on the DEBUG STREAM — the mocked child logger's calls —
 * because the broken code emits the same line with the escapes intact, so "the
 * cleanup did not throw" discriminates nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
  }),
}));

const childDebugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: childDebugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

// Captured so a case can invoke the `onRebuild` callback the provider hands the
// helper. That callback owns the THIRD render of `responseBucket` in this file
// and the only render of the wire-supplied `bucketRegion`; the helper itself is
// mocked in every suite, so without invoking the callback the line is
// unreachable and its sanitization untested.
const mockRebuild = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: mockRebuild,
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

/**
 * A bucket name carrying a terminal escape and a bidi override.
 *
 * NOT a name S3 would accept — that is the point: it stands in for any route by
 * which a non-literal reaches the render, and `displaySafe(..., asciiOnly)` is a
 * positive allowlist, so its answer does not depend on which codepoint arrived.
 */
const HOSTILE_BUCKET = 'state-\u001b[2Kbucket\u202e-evil';
/** The C1 CSI plus a NEL, both of which forge a line in a UTF-8 xterm. */
const HOSTILE_AWS_TEXT = 'AccessDenied\u009b2K\u0085Deleted: everything';

interface S3CommandLike {
  constructor: { name: string };
  input: { Bucket?: string; Key?: string; Prefix?: string };
}

const debugLines = (): string[] =>
  childDebugSpy.mock.calls.map((call) => String(call[0] as unknown));

describe('custom-resource response-object debug lines render through displaySafe', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    childDebugSpy.mockReset();
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    mockRebuild.mockReset();
    mockRebuild.mockResolvedValue(null);
  });

  /**
   * The two `GetFunction` polls the SDK waiters consume before every Invoke,
   * then a handler that replies DIRECTLY on the sync arm. Queued in that order
   * (same shape as `custom-resource-response-version-purge.test.ts`) — an
   * `mockImplementation` here instead leaves the waiter polling and the case
   * dies on the 5s timeout rather than on an assertion.
   */
  const primeLambda = (): void => {
    mockLambdaSend
      .mockResolvedValueOnce({ Configuration: { State: 'Active' } })
      .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
      .mockResolvedValueOnce({
        Payload: Buffer.from(
          JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'cr-physical-id' })
        ),
      });
  };

  const primeS3 = (opts: { failDelete?: boolean }): void => {
    mockS3Send.mockImplementation((cmd: S3CommandLike) => {
      switch (cmd.constructor.name) {
        case 'DeleteObjectCommand':
          return opts.failDelete
            ? Promise.reject(new Error(HOSTILE_AWS_TEXT))
            : Promise.resolve({});
        case 'ListObjectVersionsCommand':
          return Promise.resolve({ IsTruncated: false });
        default:
          return Promise.resolve({});
      }
    });
  };

  const runCreate = async (opts?: { responsePrefix?: string }): Promise<void> => {
    const provider = new CustomResourceProvider({
      responseBucket: HOSTILE_BUCKET,
      ...(opts?.responsePrefix === undefined ? {} : { responsePrefix: opts.responsePrefix }),
    });
    const result = await provider.create('MyCustom', 'Custom::MyResource', {
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
    });
    expect(result.physicalId).toBe('cr-physical-id');
  };

  it('sanitizes the bucket on the pre-signed-URL line (the sweep sibling)', async () => {
    primeLambda();
    primeS3({});
    await runCreate();

    const line = debugLines().find((text) => text.includes('Generated pre-signed URL'));
    expect(line).toBeDefined();
    // Premise first: the line really is about the hostile bucket, so a miss
    // below cannot be "the value never reached the render".
    expect(line).toContain('bucket');
    // The discriminator: the escapes are gone, byte for byte.
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('\u202e');
    // Each stripped codepoint becomes a SPACE (the `asciiOnly` allowlist), and
    // the printable `[2K` that followed the ESC survives — sanitizing is not
    // deletion, and pinning the exact result is what keeps this from passing
    // against a renderer that dropped the value altogether.
    expect(line).toContain('state- [2Kbucket -evil');
  });

  it('sanitizes bucket AND AWS error text on the cleanup-failure line', async () => {
    primeLambda();
    primeS3({ failDelete: true });
    await runCreate();

    const line = debugLines().find((text) =>
      text.includes('Failed to delete custom-resource response object')
    );
    expect(line).toBeDefined();
    // The premise: this line only exists because the DeleteObject rejected.
    expect(line).toContain('AccessDenied');
    expect(line).toContain('it remains as a current object');
    // The discriminators, one per interpolated value.
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('\u202e');
    expect(line).not.toContain('\u009b');
    expect(line).not.toContain('\u0085');
  });

  it('sanitizes the response KEY, whose PREFIX is caller-supplied config', async () => {
    // The third interpolated value, and the one the two cases above cannot
    // reach: the request id in `<prefix>/<requestId>.json` is cdkd-minted, so
    // the only non-literal route into the key is
    // `CustomResourceProviderConfig.responsePrefix`. Without this case,
    // deleting either `displaySafe(responseKey)` leaves the suite GREEN.
    primeLambda();
    primeS3({ failDelete: true });
    await runCreate({ responsePrefix: 'responses\u001b[2K\u202eevil' });

    const lines = debugLines().filter(
      (text) =>
        text.includes('Generated pre-signed URL') ||
        text.includes('Failed to delete custom-resource response object')
    );
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      // Premise: the line really is about the hostile prefix.
      expect(line).toContain('evil');
      expect(line).not.toContain('\u001b');
      expect(line).not.toContain('\u202e');
      expect(line).toContain('responses [2K evil/');
    }
  });

  it('renders <unrenderable> for a bucket and an error text with nothing left', async () => {
    // The floors on the two lines that CAN sanitize to empty. Probed by
    // reverting each in the source: without them these lines read
    // `s3:///<key>` and `Underlying error: `, claiming an empty value rather
    // than an unusable one -- the argument the region-correction line's own
    // comment makes.
    primeLambda();
    mockS3Send.mockImplementation((cmd: S3CommandLike) => {
      switch (cmd.constructor.name) {
        case 'DeleteObjectCommand':
          return Promise.reject(new Error('\u0000\u0001\u0002'));
        case 'ListObjectVersionsCommand':
          return Promise.resolve({ IsTruncated: false });
        default:
          return Promise.resolve({});
      }
    });
    const provider = new CustomResourceProvider({ responseBucket: '\u0000\u0001' });
    await provider.create('MyCustom', 'Custom::MyResource', {
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
    });

    const cleanup = debugLines().find((t) =>
      t.includes('Failed to delete custom-resource response object')
    );
    expect(cleanup).toBeDefined();
    expect(cleanup).toContain('s3://<unrenderable>/custom-resource-responses/');
    expect(cleanup).not.toContain('s3:///');
    expect(cleanup).toContain('Underlying error: <unrenderable>');
    const url = debugLines().find((t) => t.includes('Generated pre-signed URL'));
    expect(url).toContain('s3://<unrenderable>/custom-resource-responses/');
  });

  it('leaves an ORDINARY bucket / key / error text unchanged (negative control)', async () => {
    // Without this, a renderer that deleted everything would satisfy every
    // assertion above.
    primeLambda();
    mockS3Send.mockImplementation((cmd: S3CommandLike) => {
      switch (cmd.constructor.name) {
        case 'DeleteObjectCommand':
          return Promise.reject(new Error('Access Denied by bucket policy'));
        case 'ListObjectVersionsCommand':
          return Promise.resolve({ IsTruncated: false });
        default:
          return Promise.resolve({});
      }
    });
    const provider = new CustomResourceProvider({ responseBucket: 'cdkd-state-123456789012' });
    await provider.create('MyCustom', 'Custom::MyResource', {
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
    });

    const line = debugLines().find((text) =>
      text.includes('Failed to delete custom-resource response object')
    );
    expect(line).toBeDefined();
    expect(line).toContain('s3://cdkd-state-123456789012/custom-resource-responses/');
    expect(line).toContain('Access Denied by bucket policy');
    const url = debugLines().find((text) => text.includes('Generated pre-signed URL'));
    expect(url).toContain('s3://cdkd-state-123456789012/custom-resource-responses/');
  });
});

describe('the region-correction debug line (the third render of responseBucket)', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    mockRebuild.mockReset();
    childDebugSpy.mockReset();
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
  });

  /** Invoke the `onRebuild` the provider passed, as the real helper would. */
  const driveOnRebuild = async (opts: {
    bucket: string;
    bucketRegion: string;
    currentRegion: unknown;
  }): Promise<string[]> => {
    mockRebuild.mockResolvedValue(null);
    mockLambdaSend
      .mockResolvedValueOnce({ Configuration: { State: 'Active' } })
      .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } })
      .mockResolvedValueOnce({
        Payload: Buffer.from(
          JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'cr-physical-id' })
        ),
      });
    mockS3Send.mockImplementation((cmd: S3CommandLike) =>
      cmd.constructor.name === 'ListObjectVersionsCommand'
        ? Promise.resolve({ IsTruncated: false })
        : Promise.resolve({})
    );
    // `ensureResponseClient` is lazy and private: an actual operation arms it.
    const provider = new CustomResourceProvider({ responseBucket: opts.bucket });
    await provider.create('MyCustom', 'Custom::MyResource', {
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
    });
    const call = mockRebuild.mock.calls.at(-1);
    expect(call, 'the provider never armed a region probe').toBeDefined();
    const onRebuild = (call![2] as { onRebuild: (i: unknown) => void }).onRebuild;
    onRebuild({
      bucket: opts.bucket,
      bucketRegion: opts.bucketRegion,
      currentRegion: opts.currentRegion,
    });
    return childDebugSpy.mock.calls.map((c) => String(c[0] as unknown));
  };

  it('sanitizes the bucket AND the wire-supplied regions', async () => {
    const lines = await driveOnRebuild({
      bucket: HOSTILE_BUCKET,
      bucketRegion: 'eu-\u001b[2Kwest-1',
      currentRegion: 'us-\u202eeast-1',
    });
    const line = lines.find((t) => t.includes('is in'));
    expect(line, 'the region-correction line was never emitted').toBeDefined();
    // Premise: the line really is about these values.
    expect(line).toContain('bucket');
    expect(line).toContain('west-1');
    // The discriminators, one per interpolated value.
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('\u202e');
  });

  it('renders <unrenderable> rather than an empty string for each of the three', async () => {
    // `displaySafe` returns '' for an unusable value AND for `undefined`, so
    // without the floor this line claims an EMPTY region. For `currentRegion`
    // it would also be a regression: the raw `String(currentRegion)` this
    // replaced rendered `undefined` visibly.
    const lines = await driveOnRebuild({
      bucket: '\u0000\u0001',
      bucketRegion: '\u0002',
      currentRegion: undefined,
    });
    const line = lines.find((t) => t.includes('is in'));
    expect(line).toBeDefined();
    expect(line).toContain(`bucket '<unrenderable>' is in '<unrenderable>'`);
    expect(line).toContain(`(client was '<unrenderable>')`);
    expect(line).not.toContain("''");
  });

  it('leaves ORDINARY values byte-identical (negative control)', async () => {
    const lines = await driveOnRebuild({
      bucket: 'cdkd-state-123456789012',
      bucketRegion: 'eu-west-1',
      currentRegion: 'us-east-1',
    });
    const line = lines.find((t) => t.includes('is in'));
    expect(line).toContain(
      "Custom resource response bucket 'cdkd-state-123456789012' is in 'eu-west-1' (client was 'us-east-1')"
    );
  });
});
