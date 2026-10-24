import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { AuthorizationErrorException, InvalidParameterException } from '@aws-sdk/client-sns';

/**
 * go-to-k/cdkd#2319: a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and SNS words an `AuthorizationErrorException`
 * with the caller's ARN. The create / update / delete wraps name an AWS
 * failure by its class plus the `--verbose` pointer, AWS's text goes to
 * `debug`, and the original error stays as `cause`, stamped so the retry
 * classifiers read it.
 */
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const debugSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: (...args: unknown[]) => debugSpy(...args),
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

import { SNSSubscriptionProvider } from '../../../src/provisioning/providers/sns-subscription-provider.js';
import { hasRedactedCause, isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::SNS::Subscription';
const CALLER = 'arn:aws:sts::123456789012:assumed-role/Deployer/session';
const POINTER = "Re-run with --verbose for AWS's own message.";
const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';
const SUB_ARN = `${TOPIC_ARN}:11111111-1111-1111-1111-111111111111`;
const PROPERTIES = {
  TopicArn: TOPIC_ARN,
  Protocol: 'sqs',
  Endpoint: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
};

const denied = (): AuthorizationErrorException =>
  new AuthorizationErrorException({
    message: `User: ${CALLER} is not authorized to perform: SNS:Unsubscribe`,
    $metadata: { httpStatusCode: 403 },
  });

async function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e as Error
  );
}

function expectClassOnly(error: Error, prefix: string, cause: Error): void {
  expect(error.message).toBe(`${prefix}: AuthorizationErrorException. ${POINTER}`);
  expect(error.message).not.toContain(CALLER);
  expect(error.cause).toBe(cause);
  expect(hasRedactedCause(error)).toBe(true);
  // AWS's text is not lost: it is at `debug`.
  expect(debugSpy.mock.calls.map((c) => String(c[0])).some((l) => l.includes(CALLER))).toBe(true);
}

describe('SNS Subscription wraps name an AWS failure by its class (#2319)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    debugSpy.mockReset();
  });

  it('delete', async () => {
    const cause = denied();
    mockSend.mockRejectedValueOnce(cause);

    const error = await rejection(new SNSSubscriptionProvider().delete('Sub', SUB_ARN, TYPE));

    expectClassOnly(error, 'Failed to delete SNS subscription Sub', cause);
    // Not a dependency's NotFound: it stays for the classifiers to read.
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('create', async () => {
    const cause = denied();
    mockSend.mockRejectedValueOnce(cause);

    const error = await rejection(new SNSSubscriptionProvider().create('Sub', TYPE, PROPERTIES));

    expectClassOnly(error, 'Failed to create SNS subscription Sub', cause);
  });

  it('update (the attribute readback)', async () => {
    const cause = denied();
    mockSend.mockRejectedValueOnce(cause);

    const error = await rejection(
      new SNSSubscriptionProvider().update('Sub', SUB_ARN, TYPE, PROPERTIES, PROPERTIES)
    );

    expectClassOnly(
      error,
      'Failed to update SNS subscription Sub: could not read its attributes',
      cause
    );
  });

  it('a create collision restates "already exists" for the replacement classifiers', async () => {
    mockSend.mockRejectedValueOnce(
      new InvalidParameterException({
        message: 'Invalid parameter: Attributes Reason: Subscription already exists with different attributes',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const error = await rejection(new SNSSubscriptionProvider().create('Sub', TYPE, PROPERTIES));

    expect(error.message).toBe(
      `Failed to create SNS subscription Sub: InvalidParameterException. ${POINTER} ` +
        'AWS reports that it already exists.'
    );
  });

  it("AWS's text reaches the debug line masked", async () => {
    // A filter policy can carry a resolved secret, which SNS quotes back; the
    // debug line is now the one place AWS's text goes.
    const SECRET = 's3cr3t-filter-value';
    mockSend.mockRejectedValueOnce(
      new InvalidParameterException({
        message: `Invalid parameter: FilterPolicy: value ${SECRET} is not allowed`,
        $metadata: { httpStatusCode: 400 },
      })
    );
    const maskSecrets = (text: string): string => text.split(SECRET).join('***');

    const error = await rejection(
      new SNSSubscriptionProvider().create('Sub', TYPE, PROPERTIES, { maskSecrets })
    );

    expect(error.message).not.toContain(SECRET);
    const debug = debugSpy.mock.calls.map((c) => String(c[0]));
    expect(debug.some((l) => l.includes('FilterPolicy: value *** is not allowed'))).toBe(true);
    for (const line of debug) expect(line).not.toContain(SECRET);
  });

  it('a cdkd-authored failure keeps its text (negative control)', async () => {
    mockSend.mockRejectedValueOnce(new Error('socket hang up'));

    const error = await rejection(new SNSSubscriptionProvider().delete('Sub', SUB_ARN, TYPE));

    expect(error.message).toBe('Failed to delete SNS subscription Sub: socket hang up');
    expect(hasRedactedCause(error)).toBe(false);
  });
});
