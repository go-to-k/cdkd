/**
 * Issue go-to-k/cdkd#2319: a Cloud Control failure keeps AWS's text — the
 * handler's `StatusMessage` is what a user fixes the template from — with the
 * CALLER's principal ARN and the account id masked, since the message is
 * persisted in the `RESOURCE_FAILED` event. The raw text stays at `debug`.
 *
 * The classifiers reading this message must keep their verdicts: the
 * name-collision prose and code, the retry needles, the already-deleted
 * needles and `handlerAuthFailureHint`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.hoisted(() => vi.fn());
const mockDebug = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    cloudFormation: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: mockDebug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): unknown => child,
  };
  return { getLogger: () => child };
});

import {
  ACCOUNT_ID_MASK,
  CALLER_PRINCIPAL_MASK,
  CloudControlProvider,
  CloudControlOperationFailedError,
  maskCallerIdentity,
} from '../../../src/provisioning/cloud-control-provider.js';
import {
  isNameCollisionError,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';

const ACCOUNT = '123456789012';
const ROLE = 'cdkd-deployer-role';
const SESSION = 'alice-session';
const CALLER = `arn:aws:sts::${ACCOUNT}:assumed-role/${ROLE}/${SESSION}`;
const TYPE = 'AWS::SomeCc::Type';

function expectNoIdentity(text: string): void {
  expect(text).not.toContain(ACCOUNT);
  expect(text).not.toContain(ROLE);
  expect(text).not.toContain(SESSION);
}

describe('maskCallerIdentity (issue #2319)', () => {
  it.each([
    [
      'an assumed-role caller in a denial',
      `User: ${CALLER} is not authorized to perform: s3:PutBucketPolicy on resource: arn:aws:s3:::my-bucket because no identity-based policy allows the s3:PutBucketPolicy action`,
      `User: ${CALLER_PRINCIPAL_MASK} is not authorized to perform: s3:PutBucketPolicy on resource: arn:aws:s3:::my-bucket because no identity-based policy allows the s3:PutBucketPolicy action`,
    ],
    [
      'a federated-user caller, other partition, trailing period kept',
      `Denied for arn:aws-us-gov:sts::${ACCOUNT}:federated-user/bob.`,
      `Denied for ${CALLER_PRINCIPAL_MASK}.`,
    ],
    [
      'an IAM user after "User:"',
      `User: arn:aws:iam::${ACCOUNT}:user/ops/carol is not authorized to perform: kms:Decrypt`,
      `User: ${CALLER_PRINCIPAL_MASK} is not authorized to perform: kms:Decrypt`,
    ],
    [
      'an IAM role before "is not authorized"',
      `arn:aws:iam::${ACCOUNT}:role/${ROLE} is not authorized to perform: iam:PassRole`,
      `${CALLER_PRINCIPAL_MASK} is not authorized to perform: iam:PassRole`,
    ],
    [
      'the root user',
      `User: arn:aws:iam::${ACCOUNT}:root is not authorized to perform: sqs:CreateQueue`,
      `User: ${CALLER_PRINCIPAL_MASK} is not authorized to perform: sqs:CreateQueue`,
    ],
    [
      'a role ARN the template names keeps its name, loses its account',
      `Invalid principal in policy: "AWS":"arn:aws:iam::${ACCOUNT}:role/app-role"`,
      `Invalid principal in policy: "AWS":"arn:aws:iam::${ACCOUNT_ID_MASK}:role/app-role"`,
    ],
    [
      'a resource ARN keeps service, region and name',
      `Resource arn:aws:lambda:us-east-1:${ACCOUNT}:function:my-fn already exists`,
      `Resource arn:aws:lambda:us-east-1:${ACCOUNT_ID_MASK}:function:my-fn already exists`,
    ],
    [
      'an IAM user after "User:" with no "is not authorized" after it',
      `User: arn:aws:iam::${ACCOUNT}:user/ops/carol does not have permission to call kms:Decrypt`,
      `User: ${CALLER_PRINCIPAL_MASK} does not have permission to call kms:Decrypt`,
    ],
    [
      'an IAM user after "Not authorized:"',
      `Not authorized: arn:aws:iam::${ACCOUNT}:user/alice`,
      `Not authorized: ${CALLER_PRINCIPAL_MASK}`,
    ],
    [
      'an IAM role after "Access denied:" (any case)',
      `access denied: arn:aws:iam::${ACCOUNT}:role/ops/${ROLE}.`,
      `access denied: ${CALLER_PRINCIPAL_MASK}.`,
    ],
    [
      'an IAM user after "AccessDenied:"',
      `AccessDenied: arn:aws:iam::${ACCOUNT}:user/bob (Service: Kms, Status Code: 400)`,
      `AccessDenied: ${CALLER_PRINCIPAL_MASK} (Service: Kms, Status Code: 400)`,
    ],
    [
      'an IAM role in a resource position after a denial keeps its name',
      `Access denied for iam:PassRole on arn:aws:iam::${ACCOUNT}:role/app-role`,
      `Access denied for iam:PassRole on arn:aws:iam::${ACCOUNT_ID_MASK}:role/app-role`,
    ],
    [
      'an IAM user path holding a printable non-name character',
      `User: arn:aws:iam::${ACCOUNT}:user/team!a/bob is not authorized to perform: kms:Decrypt`,
      `User: ${CALLER_PRINCIPAL_MASK} is not authorized to perform: kms:Decrypt`,
    ],
    [
      "a deleted principal's unique id and session",
      `User: AROAEXAMPLEID12345678:${SESSION} is not authorized to perform: sqs:CreateQueue`,
      `User: ${CALLER_PRINCIPAL_MASK} is not authorized to perform: sqs:CreateQueue`,
    ],
    [
      'an account id after the word "account"',
      `Account ${ACCOUNT} is not subscribed; AccountId: '${ACCOUNT}'`,
      `Account ${ACCOUNT_ID_MASK} is not subscribed; AccountId: '${ACCOUNT_ID_MASK}'`,
    ],
    [
      'an account id in a registry host',
      `Image ${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/app:latest not found`,
      `Image ${ACCOUNT_ID_MASK}.dkr.ecr.us-east-1.amazonaws.com/app:latest not found`,
    ],
    [
      'an account id in a path, a partial ARN, and after "account (" / "account number"',
      `Prefix AWSLogs/${ACCOUNT}/ and ${ACCOUNT}:function:my-fn; account (${ACCOUNT}), account number ${ACCOUNT}`,
      `Prefix AWSLogs/${ACCOUNT_ID_MASK}/ and ${ACCOUNT_ID_MASK}:function:my-fn; account (${ACCOUNT_ID_MASK}), account number ${ACCOUNT_ID_MASK}`,
    ],
    [
      'an account id in a queue URL and as a bare policy principal',
      `Queue https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/MyQueue: Invalid principal in policy: "AWS":"${ACCOUNT}"; Owner ID ${ACCOUNT}`,
      `Queue https://sqs.us-east-1.amazonaws.com/${ACCOUNT_ID_MASK}/MyQueue: Invalid principal in policy: "AWS":"${ACCOUNT_ID_MASK}"; Owner ID ${ACCOUNT_ID_MASK}`,
    ],
    [
      'every account id in a policy principal list',
      `Invalid principal in policy: "AWS": ["${ACCOUNT}", "210987654321", '111111111111']`,
      `Invalid principal in policy: "AWS": ["${ACCOUNT_ID_MASK}", "${ACCOUNT_ID_MASK}", '${ACCOUNT_ID_MASK}']`,
    ],
    [
      'an account id in a name before a dash and a letter',
      `Bucket logs-2024-${ACCOUNT}-us-east-1 does not exist`,
      `Bucket logs-2024-${ACCOUNT_ID_MASK}-us-east-1 does not exist`,
    ],
    [
      'a bare account id in a name',
      `Bucket cdk-hnb659fds-assets-${ACCOUNT}-us-east-1 does not exist`,
      `Bucket cdk-hnb659fds-assets-${ACCOUNT_ID_MASK}-us-east-1 does not exist`,
    ],
  ])('%s', (_label, input, expected) => {
    expect(maskCallerIdentity(input)).toBe(expected);
  });

  it.each([
    'Property validation failure: [Value for property {/Timeout} does not match pattern ^[0-9]+$]',
    'Request ID: 6f1e2a3b-4c5d-4e6f-8a9b-000000000000, 13 digits 1234567890123 kept',
    'Rate exceeded (Service: SesV2, Status Code: 403, Request ID: abc)',
    // A 12-digit size or template value is not an account id by position.
    'Property validation failure: [Value 549755813888 exceeds expected maximum: 107374182400.]',
    "Value '123456789012' at 'phoneNumber' failed to satisfy constraint",
    'Value -107374182400 is below minimum: -107374182400; Valid range: 0-549755813888',
    'Region ASIAPACIFICREGION1 is not a key id',
  ])('leaves text with no identity unchanged: %s', (text) => {
    expect(maskCallerIdentity(text)).toBe(text);
  });

  it('does not chain from a name mask into a following number', () => {
    expect(maskCallerIdentity('Bucket logs-123456789012, 549755813888 bytes')).toBe(
      `Bucket logs-${ACCOUNT_ID_MASK}, 549755813888 bytes`
    );
  });
});

describe('CloudControlProvider: FAILED StatusMessage keeps the handler text, masks the caller (issue #2319)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    mockCloudControlSend.mockReset();
    mockDebug.mockReset();
    provider = new CloudControlProvider();
    vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(
      undefined
    );
  });

  function wireFailed(
    submit: 'CreateResourceCommand' | 'UpdateResourceCommand' | 'DeleteResourceCommand',
    statusMessage: string,
    errorCode?: string
  ): void {
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === submit) {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-2319' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({
          ProgressEvent: {
            OperationStatus: 'FAILED',
            TypeName: TYPE,
            ErrorCode: errorCode,
            StatusMessage: statusMessage,
          },
        });
      }
      return Promise.resolve({});
    });
  }

  async function createOutcome(logicalId = 'Res'): Promise<Error> {
    return provider.create(logicalId, TYPE, { Name: 'x' }).then(
      () => {
        throw new Error('expected create to reject');
      },
      (e: unknown) => e as Error
    );
  }

  function debugText(): string {
    return mockDebug.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('masks the principal and account id, keeps the validation text, and keeps the raw text at debug', async () => {
    const statusMessage =
      'Property validation failure: [Value for property {/Timeout} does not match pattern]. ' +
      `User: ${CALLER} is not authorized to perform: lambda:GetFunction on resource: ` +
      `arn:aws:lambda:us-east-1:${ACCOUNT}:function:my-fn`;
    wireFailed('CreateResourceCommand', statusMessage, 'InvalidRequest');

    const error = await createOutcome();

    expect(error).toBeInstanceOf(CloudControlOperationFailedError);
    expect(error.message).toContain(
      'Property validation failure: [Value for property {/Timeout} does not match pattern]'
    );
    expect(error.message).toContain(
      `User: ${CALLER_PRINCIPAL_MASK} is not authorized to perform: lambda:GetFunction on resource: ` +
        `arn:aws:lambda:us-east-1:${ACCOUNT_ID_MASK}:function:my-fn`
    );
    expectNoIdentity(error.message);
    expect((error as CloudControlOperationFailedError).ccErrorCode).toBe('InvalidRequest');
    // `--verbose` still shows the whole handler text.
    expect(debugText()).toContain(CALLER);
  });

  it('keeps the downstream-403 hint, computed from the masked text', async () => {
    wireFailed(
      'CreateResourceCommand',
      `User: ${CALLER} is not authorized to perform: ses:CreateEmailIdentity (Service: SesV2, Status Code: 403, Request ID: r-1)`
    );

    const error = await createOutcome();

    expectNoIdentity(error.message);
    expect(error.message).toContain('[hint: this 403 was returned by SesV2');
  });

  it('a collision quoting the resource ARN is still a name collision', async () => {
    wireFailed(
      'CreateResourceCommand',
      `Resource of type '${TYPE}' with identifier 'arn:aws:sqs:us-east-1:${ACCOUNT}:my-queue' already exists.`,
      'AlreadyExists'
    );

    const error = await createOutcome('Queue');

    expectNoIdentity(error.message);
    expect(error.message).toContain(`arn:aws:sqs:us-east-1:${ACCOUNT_ID_MASK}:my-queue' already exists.`);
    expect(isNameCollisionError(error.message)).toBe(true);
    expect(isNameCollisionErrorFrom(error, 'Queue')).toBe(true);
  });

  it.each(['Rate exceeded', 'cannot be assumed', 'is unable to assume provided role'])(
    'an UPDATE failure quoting the caller still matches the retry needle %j',
    async (needle) => {
      wireFailed('UpdateResourceCommand', `User: ${CALLER} hit: ${needle}. Please retry`);

      const error = await provider
        .update('Res', 'phys-id', TYPE, { Name: 'y' }, { Name: 'x' })
        .then(
          () => new Error('expected update to reject'),
          (e: unknown) => e as Error
        );

      expectNoIdentity(error.message);
      expect(error.message).toContain(needle);
      expect(isRetryableTransientError(error, error.message)).toBe(true);
    }
  );

  it('a DELETE failure quoting the caller keeps its not-found needle', async () => {
    wireFailed(
      'DeleteResourceCommand',
      `Subnet subnet-0abc in account ${ACCOUNT} does not exist; User: ${CALLER}`,
      'GeneralServiceException'
    );

    const error = await provider
      .delete('Res', 'phys-id', TYPE, {}, { expectedRegion: 'us-east-1' })
      .then(
        () => new Error('expected delete to reject'),
        (e: unknown) => e as Error
      );

    expectNoIdentity(error.message);
    expect(error.message).toContain('does not exist');
    expect(isMarkedNotGone(error)).toBe(true);
  });
});

describe('CloudControlProvider: a rejected CreateResource masks the caller too (issue #2319)', () => {
  beforeEach(() => {
    mockCloudControlSend.mockReset();
    mockDebug.mockReset();
  });

  function awsError(name: string, message: string): Error {
    return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: 400 } });
  }

  it('an AccessDenied keeps its wording with the principal masked; `cause` stays raw', async () => {
    const raw = awsError(
      'AccessDeniedException',
      `User: ${CALLER} is not authorized to perform: cloudformation:CreateResource`
    );
    mockCloudControlSend.mockRejectedValue(raw);

    const error = await new CloudControlProvider().create('Res', TYPE, { Name: 'x' }).then(
      () => new Error('expected create to reject'),
      (e: unknown) => e as Error
    );

    expect(error.message).toContain(
      `User: ${CALLER_PRINCIPAL_MASK} is not authorized to perform: cloudformation:CreateResource`
    );
    expectNoIdentity(error.message);
    expect((error as Error & { cause?: unknown }).cause).toBe(raw);
    expect(mockDebug.mock.calls.map((c) => String(c[0])).join('\n')).toContain(CALLER);
  });

  it('the unsupported-type wrap masks the caller in the quoted AWS text', async () => {
    mockCloudControlSend.mockRejectedValue(
      awsError('TypeNotFoundException', `User: ${CALLER} is not authorized to describe type ${TYPE}`)
    );

    const error = await new CloudControlProvider().create('Res', TYPE, { Name: 'x' }).then(
      () => new Error('expected create to reject'),
      (e: unknown) => e as Error
    );

    expect(error.message).toContain('is not supported by Cloud Control API');
    expect(error.message).toContain(`Error: User: ${CALLER_PRINCIPAL_MASK} is not authorized`);
    expectNoIdentity(error.message);
  });

  it('an AWS-authored "already exists" naming the resource ARN still classifies as a collision', async () => {
    mockCloudControlSend.mockRejectedValue(
      awsError('GeneralServiceException', `Queue arn:aws:sqs:us-east-1:${ACCOUNT}:my-queue already exists`)
    );

    const error = await new CloudControlProvider().create('Queue', TYPE, { Name: 'x' }).then(
      () => new Error('expected create to reject'),
      (e: unknown) => e as Error
    );

    expectNoIdentity(error.message);
    expect(isNameCollisionErrorFrom(error, 'Queue')).toBe(true);
  });
});
