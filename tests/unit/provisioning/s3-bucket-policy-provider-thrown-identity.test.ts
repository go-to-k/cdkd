import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NoSuchBucket } from '@aws-sdk/client-s3';

/**
 * The `create` / `update` / `delete` wraps must not write the CALLER'S
 * IDENTITY into a persisted store (go-to-k/cdkd#2319), nor out-throw the
 * failure they wrap (go-to-k/cdkd#3341).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`, and S3 words an `AccessDenied` as `User:
 * arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized to
 * perform: ...`. Every AWS fixture carries that real wording, so a message
 * printing the CLASS is told apart from one printing the MESSAGE.
 */

const { mockSend, debugSpy, warnSpy, infoSpy, errorSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debugSpy: vi.fn(),
  warnSpy: vi.fn(),
  infoSpy: vi.fn(),
  errorSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
    }),
  };
});

import { S3BucketPolicyProvider } from '../../../src/provisioning/providers/s3-bucket-policy-provider.js';
import {
  hasRedactedCause,
  isIamPropagationError,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { withRetry } from '../../../src/deployment/retry.js';

const RESOURCE_TYPE = 'AWS::S3::BucketPolicy';
const LOGICAL_ID = 'MyBucketPolicy';
const BUCKET = 'my-globally-unique-bucket';
const PROPERTIES = {
  Bucket: BUCKET,
  PolicyDocument: { Version: '2012-10-17', Statement: [] },
};

const CALLER_ACCOUNT = '123456789012';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;

/** S3's `AccessDenied` as it really words it, for a named action. */
function accessDeniedNamingTheCaller(action: string): Error {
  const e = new Error(
    `User: ${CALLER_ARN} is not authorized to perform: ${action} on resource: ` +
      `"arn:aws:s3:::${BUCKET}" because no identity-based policy allows the ${action} action`
  );
  return Object.assign(e, {
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });
}

const SECRET = 'tok-SECRETVALUE-9f3a';
const maskSecret = (t: string): string => t.split(SECRET).join('***');

const debugText = (): string => debugSpy.mock.calls.map((c) => String(c[0])).join('\n');
const defaultLevelText = (): string =>
  [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
    .map((c) => String(c[0]))
    .join('\n');

async function capture(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw, but it resolved');
}

/** The identity fragments, asserted one by one so a PARTIAL redaction cannot pass. */
function expectNoCallerIdentity(text: string): void {
  expect(text).not.toContain(CALLER_ARN);
  expect(text).not.toContain(CALLER_ACCOUNT);
  expect(text).not.toContain(CALLER_ROLE);
  expect(text).not.toContain(CALLER_SESSION);
  expect(text).not.toContain('assumed-role');
  expect(text).not.toContain('is not authorized to perform');
}

describe('S3BucketPolicyProvider thrown-failure identity redaction (go-to-k/cdkd#2319)', () => {
  let provider: S3BucketPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new S3BucketPolicyProvider();
  });

  const operations: Array<{
    operation: 'create' | 'update' | 'delete';
    action: string;
    run: (p: S3BucketPolicyProvider, maskSecrets?: (t: string) => string) => Promise<unknown>;
  }> = [
    {
      operation: 'create',
      action: 's3:PutBucketPolicy',
      run: (p, maskSecrets) =>
        p.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES, maskSecrets && { maskSecrets }),
    },
    {
      operation: 'update',
      action: 's3:PutBucketPolicy',
      run: (p, maskSecrets) =>
        p.update(
          LOGICAL_ID,
          BUCKET,
          RESOURCE_TYPE,
          PROPERTIES,
          PROPERTIES,
          maskSecrets && { maskSecrets }
        ),
    },
    {
      operation: 'delete',
      action: 's3:DeleteBucketPolicy',
      run: (p, maskSecrets) =>
        p.delete(LOGICAL_ID, BUCKET, RESOURCE_TYPE, PROPERTIES, maskSecrets && { maskSecrets }),
    },
  ];

  describe.each(operations)('$operation()', ({ operation, action, run }) => {
    it('names the CLASS and withholds the caller identity from the thrown message', async () => {
      mockSend.mockRejectedValue(accessDeniedNamingTheCaller(action));

      const thrown = await capture(() => run(provider));

      expect(thrown.name).toBe('ProvisioningError');
      expect(thrown.message).toContain(
        `Failed to ${operation} S3 bucket policy ${LOGICAL_ID}: AccessDenied`
      );
      expect(thrown.message).toContain('--verbose');
      expectNoCallerIdentity(thrown.message);
    });

    it("keeps AWS's own message at logger.debug, and nowhere at default level", async () => {
      mockSend.mockRejectedValue(accessDeniedNamingTheCaller(action));

      await capture(() => run(provider));

      // This text is what separates a missing IAM grant from a bucket-policy Deny.
      expect(debugText()).toContain('no identity-based policy allows');
      expect(debugText()).toContain(CALLER_ARN);
      expect(defaultLevelText()).not.toContain(CALLER_ARN);
    });

    it('keeps the AWS error as cause and stamps the redaction for the retry classifiers', async () => {
      const aws = accessDeniedNamingTheCaller(action);
      mockSend.mockRejectedValue(aws);

      const thrown = await capture(() => run(provider));

      expect(thrown.cause).toBe(aws);
      expect(hasRedactedCause(thrown)).toBe(true);
      // The premise: the signal really is gone from the message the wrap throws.
      expect(thrown.message).not.toContain('is not authorized to perform');
      const classify = retryClassificationText(thrown);
      expect(isRetryableTransientError(thrown, classify)).toBe(true);
      expect(isIamPropagationError(classify)).toBe(true);
    });

    it('does not out-throw a value String() cannot convert (go-to-k/cdkd#3341)', async () => {
      // A null-prototype object: `String(value)` throws `TypeError: Cannot
      // convert object to primitive value`, which used to REPLACE the failure.
      mockSend.mockRejectedValue(Object.create(null));

      const thrown = await capture(() => run(provider));

      expect(thrown.name).toBe('ProvisioningError');
      expect(thrown.message).toContain(
        `Failed to ${operation} S3 bucket policy ${LOGICAL_ID}: a non-Error value of type object`
      );
      // No Error to thread as cause, so there is no chain for a stamp to point at.
      expect(thrown.cause).toBeUndefined();
      expect(hasRedactedCause(thrown)).toBe(false);
    });

    it("routes the debug line through this operation's masker", async () => {
      // AWS echoes request values into some messages, and the debug line is
      // the only place the raw text now goes. Each call site passes its own
      // masker, so each is exercised.
      mockSend.mockRejectedValue(
        Object.assign(new Error(`Invalid principal in policy: ${SECRET}`), {
          name: 'MalformedPolicy',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        })
      );

      await capture(() => run(provider, maskSecret));

      expect(debugText()).toContain('Invalid principal in policy: ***');
      expect(debugText()).not.toContain(SECRET);
    });
  });

  it('reads a bucket that is gone by error NAME, so the redacted wrap is never reached', async () => {
    // The wrap no longer carries AWS's `does not exist`, which the engine's
    // already-deleted substring match used to rescue a guard miss with. The
    // SDK's `instanceof NoSuchBucket` matches on the error name today; this
    // pins that a plain error with that name still takes the gone arm.
    mockSend.mockRejectedValue(
      Object.assign(new Error('The specified bucket does not exist'), {
        name: 'NoSuchBucket',
        $fault: 'client',
        $metadata: { httpStatusCode: 404 },
      })
    );

    await expect(
      provider.delete(LOGICAL_ID, BUCKET, RESOURCE_TYPE, PROPERTIES)
    ).resolves.toBeUndefined();
  });

  it('and withRetry ITSELF re-attempts the redacted wrap', async () => {
    // The cases above pin the CLASSIFIERS; this pins the WIRING into retry.ts.
    mockSend.mockRejectedValue(accessDeniedNamingTheCaller('s3:PutBucketPolicy'));
    const attempts: unknown[] = [];
    const logLines: string[] = [];

    await expect(
      withRetry(
        async () => {
          attempts.push(1);
          return provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES);
        },
        LOGICAL_ID,
        {
          maxRetries: 2,
          sleep: async () => {},
          logger: {
            debug: (line: string) => logLines.push(line),
            warn: (line: string) => logLines.push(line),
          },
        }
      )
    ).rejects.toThrow(/AccessDenied/);

    // 1 initial attempt + 2 retries; a single element means the redaction
    // disarmed the retry.
    expect(attempts).toHaveLength(3);
    expect(logLines.join('\n')).not.toContain(CALLER_ARN);
  });

  it('NEGATIVE CONTROL: a cdkd refusal inside the same try passes through VERBATIM, unstamped', async () => {
    // The not-found arm's region check raises a cdkd-authored refusal INSIDE delete()'s outer try. Reducing it to its class would
    // delete the remedy; stamping it would feed classification a chain that
    // withheld nothing.
    mockSend.mockRejectedValue(new NoSuchBucket({ message: 'nope', $metadata: {} }));

    const thrown = await capture(() =>
      provider.delete(LOGICAL_ID, BUCKET, RESOURCE_TYPE, PROPERTIES, {
        expectedRegion: 'eu-west-1',
      })
    );

    expect(thrown.message).toContain('does not match stack state region eu-west-1');
    expect(thrown.message).not.toContain('--verbose');
    expect(hasRedactedCause(thrown)).toBe(false);
    // Nothing was withheld, so there is no duplicate debug line to emit.
    expect(debugText()).not.toContain('Failed to delete S3 bucket policy');
  });
});
