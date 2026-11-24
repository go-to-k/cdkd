import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#6422: turning `autoDeleteObjects` off removes the bucket's only
// tag and the `Custom::S3AutoDeleteObjects` resource in one deploy. CDK's
// handler then runs `GetBucketTagging`, S3 answers `NoSuchTagSet` for a bucket
// with no tags, and the handler reports FAILED, so the deploy exited 2.
// CloudFormation's bucket keeps its `aws:cloudformation:*` tags and the handler
// skips. The fix reads S3 itself; the handler's `Reason` is never classified
// (#2054, `custom-resource-delete-failed-response.test.ts`).
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

const warnSpy = vi.fn();
const infoSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: (...args: unknown[]) => infoSpy(...args),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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
  getSignedUrl: () => Promise.resolve('https://s3.example.com/presigned-url'),
}));

import {
  CustomResourceProvider,
  CR_DELETE_HANDLER_FAILED_SKIP_REASON,
} from '../../../src/provisioning/providers/custom-resource-provider.js';
import { deleteSkipReason } from '../../../src/deployment/delete-outcome.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

const SERVICE_TOKEN =
  'arn:aws:lambda:us-east-1:123456789012:function:Stack-CustomS3AutoDeleteObjectsCustomR';
const BUCKET = 'my-stack-bucket-abc123';
const AUTO_DELETE = 'Custom::S3AutoDeleteObjects';
/** What CDK's handler reported on the live repro. */
const LIVE_REASON = 'NoSuchTagSet: The TagSet does not exist';

function awsError(name: string): Error {
  return Object.assign(new Error(`${name}: simulated`), { name });
}

/**
 * The handler's DIRECT payload is `response`; `tagging` is what S3's
 * `GetBucketTagging` answers (an Error rejects). Every other S3 call (the
 * response-bucket path) resolves empty.
 */
function wire(response: Record<string, unknown>, tagging: Error | Record<string, unknown>): void {
  mockS3Send.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'GetBucketTaggingCommand') {
      return tagging instanceof Error ? Promise.reject(tagging) : Promise.resolve(tagging);
    }
    return Promise.resolve({});
  });
  mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'InvokeCommand') {
      return Promise.resolve({ Payload: Buffer.from(JSON.stringify(response)) });
    }
    return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
  });
}

function taggingCalls(): unknown[] {
  return mockS3Send.mock.calls
    .map((call) => call[0] as { constructor: { name: string }; input: unknown })
    .filter((cmd) => cmd.constructor.name === 'GetBucketTaggingCommand')
    .map((cmd) => cmd.input);
}

async function deleteAs(resourceType: string, properties: Record<string, unknown>) {
  const provider = new CustomResourceProvider({ responseBucket: 'test-bucket' });
  return provider.delete('BAutoDeleteObjectsCustomResource', 'phys-1', resourceType, {
    ServiceToken: SERVICE_TOKEN,
    ...properties,
  });
}

describe('CustomResourceProvider delete: Custom::S3AutoDeleteObjects on an untagged bucket (#6422)', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    warnSpy.mockReset();
    infoSpy.mockReset();
    resetAccountInfoCache();
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
  });

  afterEach(() => {
    delete process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
  });

  it('reports DELETED when S3 itself answers NoSuchTagSet for the bucket', async () => {
    wire({ Status: 'FAILED', Reason: LIVE_REASON }, awsError('NoSuchTagSet'));

    const result = await deleteAs(AUTO_DELETE, { BucketName: BUCKET });

    expect(result).toBeUndefined();
    expect(deleteSkipReason(result)).toBeUndefined();
    expect(taggingCalls()).toEqual([{ Bucket: BUCKET }]);
    const info = infoSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(info).toContain(`bucket ${BUCKET} carries no tags`);
    expect(warnSpy.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain(
      'LEFT IN PLACE'
    );
  });

  it("reports DELETED on S3's answer alone, whatever the handler's Reason says", async () => {
    // The other polarity of "the Reason is never read": a FAILED whose Reason
    // names something else entirely is still decided by the tag-set read.
    wire({ Status: 'FAILED', Reason: 'Task timed out after 3.00 seconds' }, awsError('NoSuchTagSet'));

    const result = await deleteAs(AUTO_DELETE, { BucketName: BUCKET });

    expect(deleteSkipReason(result)).toBeUndefined();
    expect(taggingCalls()).toEqual([{ Bucket: BUCKET }]);
  });

  it("still SKIPS when the bucket HAS tags, whatever the handler's Reason says", async () => {
    // The Reason is never read: a handler claiming NoSuchTagSet over a tagged
    // bucket is not believed.
    wire(
      { Status: 'FAILED', Reason: LIVE_REASON },
      { TagSet: [{ Key: 'aws-cdk:auto-delete-objects', Value: 'true' }] }
    );

    const result = await deleteAs(AUTO_DELETE, { BucketName: BUCKET });

    expect(deleteSkipReason(result)).toBe(CR_DELETE_HANDLER_FAILED_SKIP_REASON);
    expect(taggingCalls()).toEqual([{ Bucket: BUCKET }]);
  });

  it.each(['AccessDenied', 'NoSuchBucket', 'PermanentRedirect'])(
    'still SKIPS when cdkd cannot read the tag set (%s)',
    async (name) => {
      wire({ Status: 'FAILED', Reason: LIVE_REASON }, awsError(name));

      const result = await deleteAs(AUTO_DELETE, { BucketName: BUCKET });

      expect(deleteSkipReason(result)).toBe(CR_DELETE_HANDLER_FAILED_SKIP_REASON);
    }
  );

  it.each([
    ['missing', {}],
    ['non-string', { BucketName: { Ref: 'B' } }],
    ['empty', { BucketName: '' }],
  ])('still SKIPS, with no S3 read, when BucketName is %s', async (_label, properties) => {
    wire({ Status: 'FAILED', Reason: LIVE_REASON }, awsError('NoSuchTagSet'));

    const result = await deleteAs(AUTO_DELETE, properties);

    expect(deleteSkipReason(result)).toBe(CR_DELETE_HANDLER_FAILED_SKIP_REASON);
    expect(taggingCalls()).toEqual([]);
  });

  it('is scoped to the CDK type: another custom resource with a BucketName still SKIPS', async () => {
    wire({ Status: 'FAILED', Reason: LIVE_REASON }, awsError('NoSuchTagSet'));

    const result = await deleteAs('Custom::MyBucketCleaner', { BucketName: BUCKET });

    expect(deleteSkipReason(result)).toBe(CR_DELETE_HANDLER_FAILED_SKIP_REASON);
    expect(taggingCalls()).toEqual([]);
  });

  it('reads no tag set when the handler answers SUCCESS', async () => {
    wire({ Status: 'SUCCESS', PhysicalResourceId: 'phys-1' }, awsError('NoSuchTagSet'));

    const result = await deleteAs(AUTO_DELETE, { BucketName: BUCKET });

    expect(result).toBeUndefined();
    expect(taggingCalls()).toEqual([]);
  });
});
