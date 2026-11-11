import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetBucketPolicyCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';

/**
 * go-to-k/cdkd#6109: `PutBucketPolicy` REPLACES the bucket's whole policy, so
 * a create that sends it without looking first silently drops a policy
 * another owner attached (a vended-log delivery service auto-attaches one
 * when a WAF / VPC Flow Logs destination is configured). CloudFormation
 * refuses the same create with "The bucket policy already exists on bucket
 * <name>"; so does cdkd now.
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
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
} from '../../../src/deployment/retryable-errors.js';
import {
  isRefusedBeforeApplying,
  priorAttemptLookup,
  withPriorAttempts,
} from '../../../src/deployment/prior-attempt-scope.js';
import { withRetry } from '../../../src/deployment/retry.js';

const RESOURCE_TYPE = 'AWS::S3::BucketPolicy';
const LOGICAL_ID = 'LogsBucketPolicy';
const BUCKET = 'aws-waf-logs-example-bucket';
const DESIRED = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AWSLogDeliveryWrite',
      Effect: 'Allow',
      Principal: { Service: 'delivery.logs.amazonaws.com' },
      Action: 's3:PutObject',
      Resource: `arn:aws:s3:::${BUCKET}/AWSLogs/*`,
    },
  ],
};
const PROPERTIES = { Bucket: BUCKET, PolicyDocument: DESIRED };
/** What the log-delivery service attaches on its own (Sid suffixed `1`). */
const AUTO_ATTACHED = JSON.stringify({
  Version: '2012-10-17',
  Id: 'AWSLogDeliveryWrite20150319',
  Statement: [{ ...DESIRED.Statement[0], Sid: 'AWSLogDeliveryWrite1' }],
});

function awsError(name: string, status: number | undefined, message = name): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: status !== undefined && status >= 500 ? 'server' : 'client',
    $metadata: status === undefined ? {} : { httpStatusCode: status },
  });
}

const noPolicy = (): Error =>
  awsError('NoSuchBucketPolicy', 404, 'The bucket policy does not exist');

/** Route the mock by command class: `get` answers GetBucketPolicy, `put` PutBucketPolicy. */
function respond(
  get: () => Promise<unknown>,
  put: () => Promise<unknown> = () => Promise.resolve({})
): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof GetBucketPolicyCommand) return get();
    if (command instanceof PutBucketPolicyCommand) return put();
    return Promise.reject(new Error('unexpected command'));
  });
}

const sentPuts = (): number =>
  mockSend.mock.calls.filter(([c]) => c instanceof PutBucketPolicyCommand).length;

async function capture(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the create to throw, but it resolved');
}

describe('S3BucketPolicyProvider.create onto a bucket that already holds a policy (go-to-k/cdkd#6109)', () => {
  let provider: S3BucketPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new S3BucketPolicyProvider();
  });

  it('refuses with CloudFormation’s message and sends NO PutBucketPolicy', async () => {
    respond(() => Promise.resolve({ Policy: AUTO_ATTACHED }));

    const thrown = await capture(() => provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES));

    expect(thrown.name).toBe('ProvisioningError');
    expect(thrown.message).toContain(`The bucket policy already exists on bucket ${BUCKET}`);
    expect(thrown.message).toContain('aws s3api delete-bucket-policy');
    expect(thrown.message).toContain('cdkd import');
    expect(sentPuts()).toBe(0);
    // Deterministic: a retry would only refuse again.
    expect(isMarkedNonRetryable(thrown)).toBe(true);
    // Nothing was applied, so the journal keeps no bag a later deploy could adopt from.
    expect(isRefusedBeforeApplying(thrown, LOGICAL_ID)).toBe(true);
  });

  it('is not read as a NAME COLLISION, whose verdict can delete-first under --replace', async () => {
    respond(() => Promise.resolve({ Policy: AUTO_ATTACHED }));

    const thrown = await capture(() => provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES));

    expect(thrown.message).toContain('already exists');
    expect(isNameCollisionErrorFrom(thrown, LOGICAL_ID)).toBe(false);
  });

  it('refuses even when the existing policy is IDENTICAL, with no in-dispatch doubt', async () => {
    // Identical content proves nothing about ownership: CloudFormation refuses it too.
    respond(() => Promise.resolve({ Policy: JSON.stringify(DESIRED) }));

    await expect(provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES)).rejects.toThrow(
      /The bucket policy already exists/
    );
    expect(sentPuts()).toBe(0);
  });

  it('creates when the bucket has no policy (NoSuchBucketPolicy)', async () => {
    respond(() => Promise.reject(noPolicy()));

    const result = await provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES);

    expect(result).toEqual({ physicalId: BUCKET, attributes: {} });
    expect(sentPuts()).toBe(1);
    const put = mockSend.mock.calls.find(([c]) => c instanceof PutBucketPolicyCommand)![0];
    expect((put as PutBucketPolicyCommand).input).toEqual({
      Bucket: BUCKET,
      Policy: JSON.stringify(DESIRED),
    });
  });

  it('leaves a missing bucket to the Put, which reports it as before', async () => {
    respond(
      () => Promise.reject(awsError('NoSuchBucket', 404)),
      () => Promise.reject(awsError('NoSuchBucket', 404, 'The specified bucket does not exist'))
    );

    const thrown = await capture(() => provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES));

    expect(sentPuts()).toBe(1);
    expect(thrown.message).toContain(`Failed to create S3 bucket policy ${LOGICAL_ID}`);
    expect(thrown.message).not.toContain('already exists on bucket');
  });

  it('warns by error CLASS and still creates when the policy cannot be read (AccessDenied)', async () => {
    const callerArn = 'arn:aws:sts::123456789012:assumed-role/deployer/session-1';
    respond(() =>
      Promise.reject(
        awsError(
          'AccessDenied',
          403,
          `User: ${callerArn} is not authorized to perform: s3:GetBucketPolicy`
        )
      )
    );

    await provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES);

    expect(sentPuts()).toBe(1);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('could not read the policy');
    expect(warned).toContain('AccessDenied');
    expect(warned).not.toContain(callerArn);
    // AWS's text, which separates a missing grant from a Deny, stays at debug.
    expect(debugSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(callerArn);
  });

  it('fails the create, without a Put, on any OTHER failure of the look', async () => {
    respond(() => Promise.reject(awsError('SlowDown', 503, 'Please reduce your request rate.')));

    const thrown = await capture(() => provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES));

    expect(sentPuts()).toBe(0);
    expect(thrown.message).toContain(`Failed to create S3 bucket policy ${LOGICAL_ID}`);
    // Through the operation's wrap, so the engine's retry still classifies it.
    expect(isMarkedNonRetryable(thrown)).toBe(false);
  });

  it('a rollback replay (replayingState) restores the recorded policy, with a warning', async () => {
    respond(() => Promise.resolve({ Policy: AUTO_ATTACHED }));

    await provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES, { replayingState: true });

    expect(sentPuts()).toBe(1);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('rollback replay');
  });

  it('masks a secret-derived bucket name in the refusal', async () => {
    const secret = 'secret-bucket-xyz';
    respond(() => Promise.resolve({ Policy: AUTO_ATTACHED }));

    const thrown = await capture(() =>
      provider.create(
        LOGICAL_ID,
        RESOURCE_TYPE,
        { Bucket: secret, PolicyDocument: DESIRED },
        { maskSecrets: (t) => t.split(secret).join('***') }
      )
    );

    expect(thrown.message).toContain('already exists on bucket ***');
    expect(thrown.message).not.toContain(secret);
  });

  describe('an earlier Put of THIS dispatch got no definite answer', () => {
    const dispatch = () =>
      priorAttemptLookup(LOGICAL_ID, () => Promise.resolve([]));

    it('notes the doubt on an ambiguous Put failure (5xx), not on a 4xx', async () => {
      const ambiguous = dispatch();
      respond(
        () => Promise.reject(noPolicy()),
        () => Promise.reject(awsError('InternalError', 500))
      );
      await capture(() =>
        withPriorAttempts(ambiguous, () => provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES))
      );
      expect(ambiguous.possiblyLanded()).toBe(true);

      const definite = dispatch();
      respond(
        () => Promise.reject(noPolicy()),
        () => Promise.reject(awsError('MalformedPolicy', 400))
      );
      await capture(() =>
        withPriorAttempts(definite, () => provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES))
      );
      expect(definite.possiblyLanded()).toBe(false);
    });

    it('the engine retry proceeds over the policy that Put attached', async () => {
      // Attempt 1: no policy, Put answers 500 but lands. Attempt 2: the look
      // finds the policy attempt 1 sent (AWS's own spelling) and proceeds.
      let landed = false;
      let puts = 0;
      respond(
        () =>
          landed ? Promise.resolve({ Policy: JSON.stringify(DESIRED) }) : Promise.reject(noPolicy()),
        () => {
          puts++;
          landed = true;
          return puts === 1 ? Promise.reject(awsError('InternalError', 500)) : Promise.resolve({});
        }
      );

      const result = await withPriorAttempts(dispatch(), () =>
        withRetry(() => provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES), LOGICAL_ID, {
          maxRetries: 2,
          sleep: async () => {},
          logger: { debug: () => {}, warn: () => {} },
        })
      );

      expect(result.physicalId).toBe(BUCKET);
      expect(puts).toBe(2);
    });

    it('still refuses a policy that differs from the one it sent, and keeps the journal bag', async () => {
      const lookup = dispatch();
      lookup.notePossiblyLanded();
      respond(() => Promise.resolve({ Policy: AUTO_ATTACHED }));

      const thrown = await capture(() =>
        withPriorAttempts(lookup, () => provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES))
      );

      expect(thrown.message).toContain('The bucket policy already exists');
      expect(thrown.message).toContain('got no definite answer');
      expect(sentPuts()).toBe(0);
      // The earlier Put may have applied, so the attempt must stay evidence.
      expect(isRefusedBeforeApplying(thrown, LOGICAL_ID)).toBe(false);
    });

    it('does not read ANOTHER logical id’s doubt', async () => {
      const other = priorAttemptLookup('SomeOtherPolicy', () => Promise.resolve([]));
      other.notePossiblyLanded();
      respond(() => Promise.resolve({ Policy: JSON.stringify(DESIRED) }));

      await expect(
        withPriorAttempts(other, () => provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES))
      ).rejects.toThrow(/The bucket policy already exists/);
    });
  });
});
