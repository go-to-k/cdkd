import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateBucketCommand,
  GetBucketLocationCommand,
  NoSuchBucket,
  PutBucketTaggingCommand,
} from '@aws-sdk/client-s3';

// go-to-k/cdkd#4969: an SCP requiring `aws:RequestTag/...` on `s3:CreateBucket`
// denied cdkd's untagged create (tags came later, via `PutBucketTagging`), and
// the explicit deny was retried as IAM propagation for ~48s. The template's
// tags now ride on `CreateBucket`, a role lacking `s3:TagResource` falls back
// to the untagged create + Put, and an explicit deny fails fast.

const mockSend = vi.fn();
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-s3')>()),
  ...(await import('./s3-create-client-forward.js')).forwardedS3Client(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import {
  S3BucketProvider,
  resetS3BucketCreateRetryStateForTests,
} from '../../../src/provisioning/providers/s3-bucket-provider.js';
import {
  isRetryableTransientError,
  isIamPropagationError,
  isMarkedNonRetryable,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::S3::Bucket';
const BUCKET = 'my-bucket-4969';
const TAGS = [
  { Key: 'Project', Value: 'p' },
  { Key: 'Env', Value: 'dev' },
];
const ACCOUNT = '123456789012';

/** An AWS-authored S3 error, as the SDK deserializes one. */
function awsError(name: string, message: string, status = 403): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
  });
}

const TAG_RESOURCE_DENIAL = (): Error =>
  awsError(
    'AccessDenied',
    `User: arn:aws:sts::${ACCOUNT}:assumed-role/Deployer/s is not authorized to perform: ` +
      `s3:TagResource on resource: "arn:aws:s3:::${BUCKET}" because no identity-based policy ` +
      `allows the s3:TagResource action`
  );

const SCP_DENIAL = (): Error =>
  awsError(
    'AccessDenied',
    `User: arn:aws:sts::${ACCOUNT}:assumed-role/Deployer/s is not authorized to perform: ` +
      `s3:CreateBucket on resource: "arn:aws:s3:::${BUCKET}" with an explicit deny in a ` +
      `service control policy: arn:aws:organizations::${ACCOUNT}:policy/o-x/service_control_policy/p-x`
  );

function creates(): CreateBucketCommand[] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((c): c is CreateBucketCommand => c instanceof CreateBucketCommand);
}

function puts(): PutBucketTaggingCommand[] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((c): c is PutBucketTaggingCommand => c instanceof PutBucketTaggingCommand);
}

/** Default S3 double: the us-east-1 pre-flight finds no bucket; every other call succeeds. */
function answer(createAnswers: Array<() => unknown> = []): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof GetBucketLocationCommand) {
      throw new NoSuchBucket({ message: 'no such bucket', $metadata: { httpStatusCode: 404 } });
    }
    if (cmd instanceof CreateBucketCommand) {
      const next = createAnswers.shift();
      if (next !== undefined) return next();
    }
    return {};
  });
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe('S3BucketProvider create sends tags on CreateBucket (go-to-k/cdkd#4969)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    resetS3BucketCreateRetryStateForTests();
    clientRegion.value = 'us-east-1';
    answer();
    provider = new S3BucketProvider();
  });

  it('us-east-1: CreateBucketConfiguration carries Tags alone, and no PutBucketTagging follows', async () => {
    await provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS });

    expect(creates()).toHaveLength(1);
    expect(creates()[0]!.input.CreateBucketConfiguration).toEqual({ Tags: TAGS });
    expect(puts()).toEqual([]);
  });

  it('another region: Tags ride beside the LocationConstraint', async () => {
    clientRegion.value = 'ap-northeast-1';
    await provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS });

    expect(creates()[0]!.input.CreateBucketConfiguration).toEqual({
      LocationConstraint: 'ap-northeast-1',
      Tags: TAGS,
    });
    expect(puts()).toEqual([]);
  });

  it('an untagged bucket sends no Tags member and no PutBucketTagging', async () => {
    await provider.create('B', TYPE, { BucketName: BUCKET });
    expect(creates()[0]!.input.CreateBucketConfiguration).toBeUndefined();

    clientRegion.value = 'eu-west-1';
    await provider.create('C', TYPE, { BucketName: `${BUCKET}-c`, Tags: [] });
    expect(creates()[1]!.input.CreateBucketConfiguration).toEqual({
      LocationConstraint: 'eu-west-1',
    });
    expect(puts()).toEqual([]);
  });

  it('a role lacking s3:TagResource: retries once untagged, then applies the tags with PutBucketTagging', async () => {
    clientRegion.value = 'ap-northeast-1';
    answer([
      () => {
        throw TAG_RESOURCE_DENIAL();
      },
    ]);

    await provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS });

    expect(creates()).toHaveLength(2);
    expect(creates()[0]!.input.CreateBucketConfiguration?.Tags).toEqual(TAGS);
    expect(creates()[1]!.input.CreateBucketConfiguration).toEqual({
      LocationConstraint: 'ap-northeast-1',
    });
    expect(puts().map((c) => c.input)).toEqual([
      { Bucket: BUCKET, Tagging: { TagSet: TAGS } },
    ]);
  });

  it('us-east-1 fallback drops the configuration block entirely', async () => {
    answer([
      () => {
        throw TAG_RESOURCE_DENIAL();
      },
    ]);

    await provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS });

    expect(creates()).toHaveLength(2);
    expect(creates()[1]!.input.CreateBucketConfiguration).toBeUndefined();
    expect(puts()).toHaveLength(1);
  });

  it('an AccessDenied not naming s3:TagResource is not retried untagged', async () => {
    answer([
      () => {
        throw SCP_DENIAL();
      },
    ]);

    const err = await failure(() => provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS }));
    expect(creates()).toHaveLength(1);
    expect(puts()).toEqual([]);
    expect(err.message).not.toContain('needs s3:TagResource');
  });

  it('a TagResource denial on an UNTAGGED create (nothing to drop) is not retried', async () => {
    answer([
      () => {
        throw TAG_RESOURCE_DENIAL();
      },
    ]);

    await failure(() => provider.create('B', TYPE, { BucketName: BUCKET }));
    expect(creates()).toHaveLength(1);
  });

  it('when both creates are denied implicitly, the s3:TagResource denial surfaces (the cause to fix), keeping its retry', async () => {
    answer([
      () => {
        throw TAG_RESOURCE_DENIAL();
      },
      () => {
        throw awsError(
          'AccessDenied',
          `User: arn:aws:sts::${ACCOUNT}:assumed-role/Deployer/s is not authorized to perform: ` +
            `s3:CreateBucket on resource: "arn:aws:s3:::${BUCKET}" because no identity-based ` +
            `policy allows the s3:CreateBucket action`
        );
      },
    ]);

    const err = await failure(() => provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS }));
    expect(creates()).toHaveLength(2);
    const classify = retryClassificationText(err);
    expect(classify).toContain('s3:TagResource');
    expect(classify).not.toContain('explicit deny');
    // An implicit TagResource deny may still be propagating: it keeps the retry.
    expect(isRetryableTransientError(err, classify)).toBe(true);
    expect(err.message).not.toContain('explicit deny');
    expect(err.message).toContain('Creating a bucket with tags needs s3:TagResource.');
    expect(err.message).not.toContain(ACCOUNT);
  });

  it('an explicit s3:TagResource deny with the untagged create also denied fails fast, naming TagResource', async () => {
    answer([
      () => {
        throw awsError(
          'AccessDenied',
          `User: arn:aws:sts::${ACCOUNT}:assumed-role/Deployer/s is not authorized to perform: ` +
            `s3:TagResource on resource: "arn:aws:s3:::${BUCKET}" with an explicit deny in an identity-based policy`
        );
      },
      () => {
        throw SCP_DENIAL();
      },
    ]);

    const err = await failure(() => provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS }));
    const classify = retryClassificationText(err);
    expect(classify).toContain('s3:TagResource');
    expect(isRetryableTransientError(err, classify)).toBe(false);
    expect(err.message).toContain('Refused by an explicit deny (identity-based policy)');
  });

  it('a non-AccessDenied answer to the untagged create surfaces as itself', async () => {
    answer([
      () => {
        throw TAG_RESOURCE_DENIAL();
      },
      () => {
        throw awsError('BucketAlreadyExists', 'The requested bucket name is not available.', 409);
      },
    ]);

    const err = await failure(() => provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS }));
    expect(retryClassificationText(err)).not.toContain('s3:TagResource');
    expect(err.message).toContain('BucketAlreadyExists');
    expect(err.message).not.toContain('needs s3:TagResource');
  });

  it('a role without s3:TagResource under an SCP requiring tags fails fast, naming both causes', async () => {
    answer([
      () => {
        throw TAG_RESOURCE_DENIAL();
      },
      () => {
        throw SCP_DENIAL();
      },
    ]);

    const err = await failure(() => provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS }));
    expect(creates()).toHaveLength(2);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(isRetryableTransientError(err, retryClassificationText(err))).toBe(false);
    expect(err.message).toContain('Creating a bucket with tags needs s3:TagResource.');
    expect(err.message).toContain(
      'The untagged retry was refused by an explicit deny (service control policy), which retrying cannot clear.'
    );
    expect(err.message).not.toContain(ACCOUNT);
    expect(err.message).not.toContain('arn:aws:organizations');
  });

  it.each([
    ['MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema', 400],
    ['NotImplemented', 'A header you provided implies functionality that is not implemented', 501],
    ['InvalidArgument', 'Tags are not supported in this Region', 400],
    ['InvalidRequest', 'Tags are not supported for this request', 400],
  ])('a %s refusal of the Tags member falls back to untagged create + PutBucketTagging', async (name, message, status) => {
    clientRegion.value = 'ap-northeast-1';
    answer([
      () => {
        throw awsError(name, message, status);
      },
    ]);

    await provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS });

    expect(creates()).toHaveLength(2);
    expect(creates()[1]!.input.CreateBucketConfiguration).toEqual({
      LocationConstraint: 'ap-northeast-1',
    });
    expect(puts().map((c) => c.input)).toEqual([{ Bucket: BUCKET, Tagging: { TagSet: TAGS } }]);
  });

  it.each([
    ['InvalidArgument', 'Invalid storage class'],
    ['InvalidTag', 'The TagValue you have provided is invalid'],
  ])('a %s refusal not about the Tags member is not retried untagged', async (name, message) => {
    answer([
      () => {
        throw awsError(name, message, 400);
      },
    ]);

    await failure(() => provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS }));
    expect(creates()).toHaveLength(1);
    expect(puts()).toEqual([]);
  });

  it('a shape refusal on an UNTAGGED create is not retried', async () => {
    answer([
      () => {
        throw awsError('MalformedXML', 'not well-formed', 400);
      },
    ]);

    await failure(() => provider.create('B', TYPE, { BucketName: BUCKET }));
    expect(creates()).toHaveLength(1);
  });

  it('after a shape refusal, the untagged create\'s own AccessDenied surfaces as itself', async () => {
    answer([
      () => {
        throw awsError('MalformedXML', 'not well-formed', 400);
      },
      () => {
        throw SCP_DENIAL();
      },
    ]);

    const err = await failure(() => provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS }));
    expect(retryClassificationText(err)).toContain('s3:CreateBucket');
    expect(err.message).toContain('Refused by an explicit deny (service control policy)');
    expect(err.message).not.toContain('untagged retry');
  });

  it('an explicit deny names the policy type in the thrown message, without AWS\'s identity-bearing text', async () => {
    answer([
      () => {
        throw SCP_DENIAL();
      },
    ]);

    const err = await failure(() => provider.create('B', TYPE, { BucketName: BUCKET, Tags: TAGS }));
    expect(err.message).toContain(
      'Refused by an explicit deny (service control policy), which retrying cannot clear.'
    );
    expect(err.message).not.toContain(ACCOUNT);
    expect(err.message).not.toContain('Deployer');
    expect(err.message).not.toContain('arn:aws:organizations');
  });

  it('an implicit deny keeps its propagation retry and gets no explicit-deny note', async () => {
    answer([
      () => {
        throw awsError(
          'AccessDenied',
          `User: arn:aws:sts::${ACCOUNT}:assumed-role/Deployer/s is not authorized to perform: ` +
            `s3:CreateBucket on resource: "arn:aws:s3:::${BUCKET}" because no identity-based ` +
            `policy allows the s3:CreateBucket action`
        );
      },
    ]);

    const err = await failure(() => provider.create('B', TYPE, { BucketName: BUCKET }));
    expect(err.message).not.toContain('explicit deny');
    const classify = retryClassificationText(err);
    expect(isRetryableTransientError(err, classify)).toBe(true);
    expect(isIamPropagationError(classify)).toBe(true);
  });

  it('an adopted generated-name bucket (BucketAlreadyOwnedByYou) still gets PutBucketTagging', async () => {
    clientRegion.value = 'eu-west-1';
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateBucketCommand) {
        throw awsError('BucketAlreadyOwnedByYou', 'you already own it', 409);
      }
      if (cmd instanceof GetBucketLocationCommand) return { LocationConstraint: 'eu-west-1' };
      return {};
    });

    await provider.create('B', TYPE, { Tags: TAGS });

    expect(creates()).toHaveLength(1);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.input.Tagging).toEqual({ TagSet: TAGS });
  });

  it('a us-east-1 legacy 200 over an existing generated-name bucket still gets PutBucketTagging', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      // The pre-flight places the bucket in us-east-1: CreateBucket's 200
      // adopts it rather than creating it.
      if (cmd instanceof GetBucketLocationCommand) return { LocationConstraint: undefined };
      return {};
    });

    await provider.create('B', TYPE, { Tags: TAGS });

    expect(creates()).toHaveLength(1);
    expect(puts()).toHaveLength(1);
  });
});
