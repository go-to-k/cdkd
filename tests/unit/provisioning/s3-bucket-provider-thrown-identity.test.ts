import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The three `create` / `update` / `delete` wraps must not write the CALLER'S
 * IDENTITY into a persisted store (issue
 * [#2302](https://github.com/go-to-k/cdkd/issues/2302)).
 *
 * Each of them interpolated `error.message` straight into a THROWN
 * `ProvisioningError`. That is not the terminal-only surface PR #2290's
 * identity warns are: `extractDeploymentEventError` captures a thrown message
 * into `deployments/{runId}.jsonl`, which outlives the run. An `AccessDenied`
 * on `CreateBucket` / `PutBucket*` / `DeleteBucket` is worded by S3 as `User:
 * arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized to
 * perform: ...`, so the account id, role name and session name went into that
 * store.
 *
 * Every AWS fixture here therefore carries S3's REAL wording, identity and all:
 * a fixture reading `Access Denied` cannot tell a message that prints the CLASS
 * from one that prints the MESSAGE.
 *
 * The NEGATIVE CONTROLS are the other half and they are not optional. These are
 * BROAD catch blocks that capture cdkd's OWN refusals as readily as an SDK
 * failure, and a redaction keyed on "cdkd did not author it" would reduce every
 * one of those to the token `Error` -- deleting the remedy the refusal exists to
 * deliver. Two of them are pinned below.
 */

const { mockSend, clientRegion, debugSpy, warnSpy, infoSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'eu-west-1' },
  // Split by LEVEL: the claim is not "the text was logged" but "it was logged
  // where it is neither persisted nor shown by default". cdkd defaults to `info`.
  debugSpy: vi.fn(),
  warnSpy: vi.fn(),
  infoSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import {
  isIamPropagationError,
  isRetryableTransientError,
  markRedactedCause,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { withRetry } from '../../../src/deployment/retry.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const LOGICAL_ID = 'MyBucket';
const BUCKET = 'my-globally-unique-bucket';

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
  return Object.assign(e, { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
}

/** The wire code lives on `name`, not in the text -- so the class assertions cannot be literals. */
function throttled(): Error {
  const e = new Error('Please reduce your request rate.');
  return Object.assign(e, { name: 'ThrottlingException', $metadata: { httpStatusCode: 503 } });
}

const cmd = (call: unknown[]): string => (call[0] as { constructor: { name: string } }).constructor.name;
const sentCommands = (): string[] => mockSend.mock.calls.map(cmd);
const debugText = (): string => debugSpy.mock.calls.map((c) => String(c[0])).join('\n');
const defaultLevelText = (): string =>
  [...infoSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0])).join('\n');

/** Every send rejects with `err`, except `GetBucketLocation`, which answers this region. */
function rejectAllExceptRegionProbe(err: Error): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'GetBucketLocationCommand') {
      return Promise.resolve({ LocationConstraint: clientRegion.value });
    }
    return Promise.reject(err);
  });
}

/**
 * An update whose desired bag actually issues a write.
 *
 * `PublicAccessBlockConfiguration` is what is left on `applyConfiguration`'s
 * always-PUT path once `update()` skips tags and the three diff-managed
 * sub-configs, so a bag carrying only `BucketName` reaches AWS with no call at
 * all and the wrap under test is never entered.
 */
function runUpdate(): Promise<unknown> {
  return new S3BucketProvider().update(
    LOGICAL_ID,
    BUCKET,
    RESOURCE_TYPE,
    { BucketName: BUCKET, PublicAccessBlockConfiguration: { BlockPublicAcls: true } },
    { BucketName: BUCKET }
  );
}

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

describe('S3BucketProvider thrown-failure identity redaction (issue #2302)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'eu-west-1';
    provider = new S3BucketProvider();
  });

  describe('create()', () => {
    it('names the CLASS and withholds the caller identity from the thrown message', async () => {
      mockSend.mockRejectedValue(accessDeniedNamingTheCaller('s3:CreateBucket'));

      const thrown = await capture(() =>
        provider.create(LOGICAL_ID, RESOURCE_TYPE, { BucketName: BUCKET })
      );

      expect(thrown.name).toBe('ProvisioningError');
      expect(thrown.message).toContain(`Failed to create S3 bucket ${LOGICAL_ID}: AccessDenied`);
      expect(thrown.message).toContain('--verbose');
      expectNoCallerIdentity(thrown.message);
    });

    it("keeps AWS's own message at logger.debug, and nowhere at default level", async () => {
      mockSend.mockRejectedValue(accessDeniedNamingTheCaller('s3:CreateBucket'));

      await capture(() => provider.create(LOGICAL_ID, RESOURCE_TYPE, { BucketName: BUCKET }));

      // Discarding it would be its own defect: this text is what separates a
      // missing IAM grant from a bucket-policy Deny.
      expect(debugText()).toContain('no identity-based policy allows');
      expect(debugText()).toContain(CALLER_ARN);
      expect(defaultLevelText()).not.toContain(CALLER_ARN);
    });

    it('NEGATIVE CONTROL: a cdkd-authored refusal inside the same try passes through VERBATIM', async () => {
      // `OwnershipControls.Rules must be an array (...)` is a plain `Error`
      // cdkd wrote, raised by an applier INSIDE create()'s try. A redaction
      // keyed on "not a CdkdError" would reduce it to `Error.`, deleting the
      // template-side diagnosis. It carries no `$metadata`, so it is not AWS's.
      mockSend.mockResolvedValue({});

      const thrown = await capture(() =>
        provider.create(LOGICAL_ID, RESOURCE_TYPE, {
          BucketName: BUCKET,
          OwnershipControls: { Rules: 'BucketOwnerEnforced' },
        })
      );

      expect(thrown.message).toContain('OwnershipControls.Rules must be an array');
      expect(thrown.message).toContain('check for an unresolved intrinsic');
      expect(thrown.message).not.toContain('--verbose');
      // Nothing was withheld, so there is no duplicate debug line to emit.
      expect(debugText()).not.toContain('OwnershipControls.Rules must be an array');
    });
  });

  describe('the redaction must not disarm the RETRY classifiers', () => {
    // `withRetry` classifies by SUBSTRING over a message, and the deploy engine
    // uses the DEFAULT classifier -- so withholding AWS's wording from the
    // thrown message silently withheld it from the retry decision too.
    // MEASURED before `retryClassificationText` existed: both cases below
    // flipped from retryable to NON-retryable, and `AccessDenied` additionally
    // lost the DENSE IAM-propagation cadence. That is an availability
    // regression the redaction CREATES, so it is fenced here rather than in the
    // retry module's own suite: this is the only place that knows the redaction
    // is why the wrapper's message no longer carries the signal.

    it('keeps an IAM-propagation AccessDenied retryable, on the dense cadence', async () => {
      mockSend.mockRejectedValue(accessDeniedNamingTheCaller('s3:CreateBucket'));

      const thrown = await capture(() =>
        provider.create(LOGICAL_ID, RESOURCE_TYPE, { BucketName: BUCKET })
      );

      // The premise: the signal really is gone from the message the wrap throws.
      expect(thrown.message).not.toContain('is not authorized to perform');

      const classify = retryClassificationText(thrown);
      expect(isRetryableTransientError(thrown, classify)).toBe(true);
      expect(isIamPropagationError(classify)).toBe(true);
      // ...and the text the classifier reads is NOT what anything prints.
      expect(classify).not.toBe(thrown.message);
    });

    it('keeps S3 OperationAborted retryable', async () => {
      // `A conflicting conditional operation is currently in progress` is an
      // S3-specific entry in the retryable patterns, and concurrent bucket work
      // is exactly what cdkd's DAG produces.
      mockSend.mockRejectedValue(
        Object.assign(
          new Error('A conflicting conditional operation is currently in progress against this resource.'),
          { name: 'OperationAborted', $metadata: { httpStatusCode: 409 } }
        )
      );

      const thrown = await capture(() =>
        provider.delete(LOGICAL_ID, BUCKET, RESOURCE_TYPE, {})
      );

      expect(thrown.message).not.toContain('conflicting conditional operation');
      expect(isRetryableTransientError(thrown, retryClassificationText(thrown))).toBe(true);
    });

    it('and withRetry ITSELF re-attempts the redacted wrap', async () => {
      // The two cases above pin the CLASSIFIERS. This one pins the WIRING:
      // `retry.ts` has to hand them the chain text rather than the message it
      // logs, and a probe that reverted only that hand-off left both of the
      // assertions above green.
      mockSend.mockRejectedValue(accessDeniedNamingTheCaller('s3:CreateBucket'));
      const attempts: unknown[] = [];
      const logLines: string[] = [];

      await expect(
        withRetry(
          async () => {
            attempts.push(1);
            return provider.create(LOGICAL_ID, RESOURCE_TYPE, { BucketName: BUCKET });
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

      // 1 initial attempt + 2 retries. A single element means the redaction
      // disarmed the retry.
      expect(attempts).toHaveLength(3);
      // ...and nothing retry.ts LOGGED carries the identity: the chain text is
      // for classification only.
      expect(logLines.join('\n')).not.toContain(CALLER_ARN);
      expect(logLines.join('\n')).not.toContain('assumed-role');
    });

    it('NEGATIVE CONTROL: an UNSTAMPED wrap over a RETRYABLE cause stays terminal', async () => {
      // The join is OPT-IN, and only this shape can show it. An earlier
      // revision used `deleteBucketWithEmptyRetry`'s non-empty-bucket refusal,
      // which is VACUOUS here: that refusal is a bare `new Error(...)` with NO
      // cause, so the walked chain contains no AWS error at all and the case
      // passed whether the join fired or not.
      //
      // This one is the real question: a wrapper whose own message carries no
      // retryable substring, over a cause whose message does. Unstamped, which
      // is every wrapper on `main` outside #2302's redacting sites. The
      // decisive member of that population is `deploy-engine.ts`'s outer
      // per-resource wrap, measured to flip terminal -> retryable under an
      // unconditional join. It must flip none of them.
      const cause = Object.assign(
        new Error(
          'A conflicting conditional operation is currently in progress against this resource.'
        ),
        { name: 'OperationAborted', $metadata: { httpStatusCode: 409 } }
      );
      const unstamped = new ProvisioningError(
        'Failed to delete resource MyBucket',
        RESOURCE_TYPE,
        LOGICAL_ID,
        BUCKET,
        cause
      );

      // The premise, asserted rather than assumed: the cause REALLY is
      // retryable on its own, so a `false` below is the opt-in gate holding
      // and not a fixture that never had a retryable signal in it.
      expect(isRetryableTransientError(cause, cause.message)).toBe(true);
      expect(retryClassificationText(unstamped)).toBe(unstamped.message);
      expect(isRetryableTransientError(unstamped, retryClassificationText(unstamped))).toBe(false);

      // ...and the SAME chain, stamped, does flip -- so the assertion above
      // pins the stamp rather than something incidental about the fixture.
      expect(
        isRetryableTransientError(
          markRedactedCause(unstamped),
          retryClassificationText(unstamped)
        )
      ).toBe(true);
    });

    it('NEGATIVE CONTROL: a cdkd refusal with no retryable cause stays NON-retryable', async () => {
      // Kept alongside the one above, and it is a different claim: that a
      // STAMPED chain whose text is genuinely terminal is not retried either.
      // `deleteBucketWithEmptyRetry`'s refusal reaches the wrap as a plain
      // `Error`, so `describeAwsFailure` leaves it unredacted and
      // `wrapOperationError` does not stamp it.
      mockSend.mockRejectedValue(
        Object.assign(new Error('The bucket you tried to delete is not empty'), {
          name: 'BucketNotEmpty',
          $metadata: { httpStatusCode: 409 },
        })
      );

      const thrown = await capture(() =>
        provider.delete(LOGICAL_ID, BUCKET, RESOURCE_TYPE, {})
      );

      expect(isRetryableTransientError(thrown, retryClassificationText(thrown))).toBe(false);
    });
  });

  describe('update()', () => {
    it('names the CLASS and withholds the caller identity from the thrown message', async () => {
      rejectAllExceptRegionProbe(accessDeniedNamingTheCaller('s3:PutBucketPublicAccessBlock'));

      const thrown = await capture(() => runUpdate());

      expect(thrown.name).toBe('ProvisioningError');
      expect(thrown.message).toContain(`Failed to update S3 bucket ${LOGICAL_ID}: AccessDenied`);
      expectNoCallerIdentity(thrown.message);
      expect(debugText()).toContain(CALLER_ARN);
      expect(defaultLevelText()).not.toContain(CALLER_ARN);
    });

    it('prints the ACTUAL class, not a hardcoded AccessDenied', async () => {
      rejectAllExceptRegionProbe(throttled());

      const thrown = await capture(() => runUpdate());

      expect(thrown.message).toContain(
        `Failed to update S3 bucket ${LOGICAL_ID}: ThrottlingException`
      );
      expect(thrown.message).not.toContain('Please reduce your request rate');
      expect(debugText()).toContain('Please reduce your request rate');
    });
  });

  describe('delete()', () => {
    it('names the CLASS and withholds the caller identity from the thrown message', async () => {
      mockSend.mockRejectedValue(accessDeniedNamingTheCaller('s3:DeleteBucket'));

      const thrown = await capture(() =>
        provider.delete(LOGICAL_ID, BUCKET, RESOURCE_TYPE, {})
      );

      expect(thrown.name).toBe('ProvisioningError');
      expect(thrown.message).toContain(`Failed to delete S3 bucket ${LOGICAL_ID}: AccessDenied`);
      expect(thrown.message).toContain('--verbose');
      expectNoCallerIdentity(thrown.message);
      expect(debugText()).toContain(CALLER_ARN);
      expect(defaultLevelText()).not.toContain(CALLER_ARN);
      expect(sentCommands()).toContain('DeleteBucketCommand');
    });

    it('NEGATIVE CONTROL: the non-empty-bucket refusal keeps its full CFn-parity remedy', async () => {
      // The single most expensive message in this file to lose: it is the
      // CloudFormation-parity remediation, cdkd-authored, a plain `Error`, and
      // raised INSIDE delete()'s try by `deleteBucketWithEmptyRetry`.
      mockSend.mockRejectedValue(
        Object.assign(new Error('The bucket you tried to delete is not empty'), {
          name: 'BucketNotEmpty',
          $metadata: { httpStatusCode: 409 },
        })
      );

      const thrown = await capture(() =>
        provider.delete(LOGICAL_ID, BUCKET, RESOURCE_TYPE, {})
      );

      expect(thrown.message).toContain(`bucket ${BUCKET} is not empty`);
      expect(thrown.message).toContain('Matching CloudFormation');
      expect(thrown.message).toContain('autoDeleteObjects: true');
      expect(thrown.message).not.toContain('--verbose');
    });
  });
});
