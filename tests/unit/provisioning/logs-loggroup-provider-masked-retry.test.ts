import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateLogGroupCommand, PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

/**
 * Issue #4259, CloudWatch Logs log group half: the `create()` and `update()`
 * failure wraps mask AWS's error text before joining it into their
 * `Failed to create/update log group ...` message. When a recorded secret
 * spells part of the retry table's wording, the mask cuts that wording out of
 * the message, so the wrap must be stamped (`markRedactedCause`) for the retry
 * classifiers to read the unmasked cause chain. One retryable case per wrap
 * site (the create wrap reached both by `CreateLogGroup` itself and by a
 * post-create wiring call), plus the unstamped negative control.
 */

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger['child'] = () => logger;
  return { getLogger: () => logger };
});

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';

const LOG_GROUP = 'AWS::Logs::LogGroup';

/** A secret that spells part of the retry table's `does not exist` wording. */
const RETRY_WORD = 'exist';
const retryMasker = createSecretMasker(
  new Map([[RETRY_WORD, '{{resolve:secretsmanager:logs-4259:SecretString:k::}}']])
);
const TRANSIENT = 'KMS key arn:aws:kms:us-east-1:123456789012:key/abc does not exist';

/** An AWS-authored client rejection (400, so no transient-server arm fires). */
function awsRejection(message: string): Error {
  return Object.assign(new Error(message), {
    name: 'InvalidParameterException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400, requestId: 'req-logs-4259' },
  });
}

const retryable = (error: Error): boolean =>
  isRetryableTransientError(error, retryClassificationText(error));

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw');
}

type Masker = typeof retryMasker;

const SITES = [
  {
    site: 'create() CreateLogGroup',
    command: CreateLogGroupCommand,
    wrap: 'Failed to create log group Lg',
    run: (p: LogsLogGroupProvider, m: Masker) =>
      p.create('Lg', LOG_GROUP, { LogGroupName: '/app/lg-4259' }, { maskSecrets: m }),
  },
  {
    // A post-create wiring failure goes through the inner cleanup arm, then
    // reaches the same outer create wrap.
    site: 'create() post-create PutRetentionPolicy',
    command: PutRetentionPolicyCommand,
    wrap: 'Failed to create log group Lg',
    run: (p: LogsLogGroupProvider, m: Masker) =>
      p.create(
        'Lg',
        LOG_GROUP,
        { LogGroupName: '/app/lg-4259', RetentionInDays: 7 },
        { maskSecrets: m }
      ),
  },
  {
    site: 'update() PutRetentionPolicy',
    command: PutRetentionPolicyCommand,
    wrap: 'Failed to update log group Lg',
    run: (p: LogsLogGroupProvider, m: Masker) =>
      p.update(
        'Lg',
        '/app/lg-4259',
        LOG_GROUP,
        { LogGroupName: '/app/lg-4259', RetentionInDays: 7 },
        { LogGroupName: '/app/lg-4259', RetentionInDays: 1 },
        { maskSecrets: m }
      ),
  },
] as const;

/** Reject `command` with `error`; every other call succeeds. */
function rejectOn(command: abstract new (...args: never[]) => object, error: Error): void {
  mockSend.mockImplementation((sent: unknown) =>
    sent instanceof command ? Promise.reject(error) : Promise.resolve({})
  );
}

describe('LogsLogGroupProvider: a masked failure still classifies as retryable (issue #4259)', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LogsLogGroupProvider();
  });

  it.each(SITES)('$site: the stamp keeps it retryable', async ({ command, wrap, run }) => {
    rejectOn(command, awsRejection(TRANSIENT));
    const failure = await thrown(run(provider, retryMasker));
    // Non-vacuity: the rejection came from the site's own command, and the
    // wrap that reached us is the site's own.
    expect(mockSend.mock.calls.some((c) => c[0] instanceof command)).toBe(true);
    expect(failure.message).toContain(wrap);
    // Premise: the mask cut the retry wording out of the message itself.
    expect(failure.message).not.toContain('does not exist');
    expect(isRetryableTransientError(failure, failure.message)).toBe(false);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(retryable(failure)).toBe(true);
  });

  it.each(SITES)(
    '$site: a failure the mask left unchanged is not stamped',
    async ({ command, wrap, run }) => {
      rejectOn(command, awsRejection('Bad request parameter'));
      const failure = await thrown(run(provider, retryMasker));
      expect(failure.message).toContain(wrap);
      expect(failure.message).toContain('Bad request parameter');
      expect(hasRedactedCause(failure)).toBe(false);
      expect(retryable(failure)).toBe(false);
    }
  );
});
