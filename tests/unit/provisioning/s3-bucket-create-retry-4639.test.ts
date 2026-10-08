import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639, the S3 bucket residual: `CreateBucket` carries no
// idempotency token. When a 5xx hid a create S3 had completed, the replay
// (the SDK's own inside one send, or the deploy engine's) answered
// `BucketAlreadyOwnedByYou` -- or 200 in us-east-1 -- and the provider ADOPTED
// the bucket: no created-before-failure mark, so a later configuration failure
// left a bucket this run made in no record. A bucket that exists after an
// ambiguous attempt of the SAME create is now refused, never adopted.

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    S3Client: vi
      .fn()
      .mockImplementation((cfg?: Parameters<typeof sdkClientStandIn>[0]) => sdkClientStandIn(cfg)),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
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

import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { BucketAlreadyOwnedByYou, S3Client } from '@aws-sdk/client-s3';
import { AwsClients, getAwsClients, setAwsClients } from '../../../src/utils/aws-clients.js';
import {
  S3BucketProvider,
  resetS3BucketCreateRetryStateForTests,
} from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  isMarkedNonRetryable,
  isRecreateRetryableError,
} from '../../../src/deployment/retryable-errors.js';
import { hasCreatedBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { generateResourceName } from '../../../src/provisioning/resource-name.js';
import {
  advancingSleep,
  configsOf,
  expectFullSdkRetry,
  expectRefusesServerErrorReplay,
  sentVia,
  transient500,
  useService,
} from './data-create-retry-4639-harness.js';

const TYPE = 'AWS::S3::Bucket';
const BUCKET = 'orders-archive-4639';
/** Distinct from every client default and from the ambient region the cases stub. */
const STACK_REGION = 'eu-west-3';

interface Command {
  constructor: { name: string };
  input: Record<string, unknown>;
}

/**
 * A fake S3 that holds buckets by name and answers `CreateBucket` the way the
 * real one does for a bucket you own: `BucketAlreadyOwnedByYou` (409, with
 * the bucket's region in `x-amz-bucket-region`), except a re-create in
 * us-east-1, which answers 200.
 */
class FakeS3 {
  /** name -> region it lives in. */
  readonly buckets = new Map<string, string>();
  readonly calls: string[] = [];
  /** `CreateBucket` does its work, THEN throws this (a lost response). */
  loseCreateResponse: Error | undefined;
  /** `CreateBucket` throws this WITHOUT creating (a 5xx before the work). */
  failCreateBefore: Error | undefined;
  /** A configuration call that fails, by command name. */
  failing: Record<string, Error> = {};
  /** Buckets ANOTHER account holds (name -> region); its policy lets us read the location. */
  readonly foreign = new Map<string, string>();
  /** `GetBucketLocation` is denied (a least-privilege role). */
  denyLocation = false;
  /** `CreateBucket` throws these, one per call, WITHOUT creating. */
  createFailures: Error[] = [];
  /** `GetBucketLocation` throws these, one per call. */
  locationFailures: Error[] = [];
  /** The 409 carries no `x-amz-bucket-region`, so the region is read by `GetBucketLocation`. */
  omitRegionHeader = false;

  constructor(private readonly region: string) {}

  send = async (command: Command): Promise<unknown> => {
    const name = command.constructor.name;
    this.calls.push(name);
    const bucket = command.input['Bucket'] as string;
    if (name === 'CreateBucketCommand') {
      if (this.failCreateBefore) {
        const error = this.failCreateBefore;
        this.failCreateBefore = undefined;
        throw error;
      }
      const queued = this.createFailures.shift();
      if (queued) throw queued;
      if (this.foreign.has(bucket)) {
        throw Object.assign(new Error('The requested bucket name is not available.'), {
          name: 'BucketAlreadyExists',
          $fault: 'client',
          $metadata: { httpStatusCode: 409 },
        });
      }
      const existing = this.buckets.get(bucket);
      if (existing !== undefined) {
        if (existing === 'us-east-1' && this.region === 'us-east-1') return {};
        throw Object.assign(
          new BucketAlreadyOwnedByYou({
            message:
              'Your previous request to create the named bucket succeeded and you already own it.',
            $metadata: { httpStatusCode: 409 },
          }),
          this.omitRegionHeader ? {} : { $response: { headers: { 'x-amz-bucket-region': existing } } }
        );
      }
      this.buckets.set(bucket, this.region);
      if (this.loseCreateResponse) {
        const error = this.loseCreateResponse;
        this.loseCreateResponse = undefined;
        throw error;
      }
      return {};
    }
    if (name === 'GetBucketLocationCommand') {
      if (this.denyLocation) throw accessDenied();
      const queued = this.locationFailures.shift();
      if (queued) throw queued;
      const where = this.buckets.get(bucket) ?? this.foreign.get(bucket);
      if (where === undefined) {
        throw Object.assign(new Error('The specified bucket was not found'), {
          name: 'NoSuchBucket',
          $metadata: { httpStatusCode: 404 },
        });
      }
      return { LocationConstraint: where === 'us-east-1' ? undefined : where };
    }
    if (name === 'ListBucketsCommand') {
      // This account's buckets only, filtered by prefix, one page.
      const prefix = (command.input['Prefix'] as string | undefined) ?? '';
      return {
        Buckets: [...this.buckets.keys()]
          .filter((n) => n.startsWith(prefix))
          .map((Name) => ({ Name })),
      };
    }
    if (name === 'DeleteBucketCommand') {
      const failure = this.failing[name];
      if (failure) throw failure;
      this.buckets.delete(bucket);
      return {};
    }
    const failure = this.failing[name];
    if (failure) throw failure;
    return {};
  };

  configurationCalls(): string[] {
    return this.calls.filter(
      (c) =>
        c !== 'CreateBucketCommand' &&
        c !== 'GetBucketLocationCommand' &&
        c !== 'ListBucketsCommand'
    );
  }
}

const PROPS = {
  BucketName: BUCKET,
  VersioningConfiguration: { Status: 'Enabled' },
};

/** The same bucket with NO `BucketName`: the provider generates one. */
const GENERATED_PROPS = { VersioningConfiguration: { Status: 'Enabled' } };
/** The name the provider generates for `Res` (its own `generateResourceName` call). */
const GENERATED = generateResourceName('Res', {
  maxLength: 63,
  lowercase: true,
  allowedPattern: /[^a-z0-9.-]/g,
});

/**
 * The COLD path's answer for an explicit `BucketName` a bucket already holds
 * (go-to-k/cdkd#4684): refused as held -- never the #4639 ambiguous-attempt
 * refusal, whose window these cases prove spent -- with nothing configured.
 */
function expectColdExplicitRefusal(error: unknown, aws: FakeS3): void {
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain(`Refusing to adopt S3 bucket ${BUCKET}`);
  expect(message).toContain('its BucketName is set explicitly');
  expect(message).not.toContain('ended without a definite answer');
  // Not marked: only a delete-first re-create retries it (its classifier
  // reads "already exists"); the ordinary retry never does.
  expect(isMarkedNonRetryable(error)).toBe(false);
  expect(isRecreateRetryableError(message)).toBe(true);
  expect(aws.calls).not.toContain('PutBucketVersioningCommand');
}

/** S3's 409 for a conflicting operation on the same name: retryable, not ambiguous. */
const operationAborted = (): Error =>
  Object.assign(
    new Error('A conflicting conditional operation is currently in progress against this resource.'),
    { name: 'OperationAborted', $fault: 'client', $metadata: { httpStatusCode: 409 } }
  );

/** S3's named throttle (a 503): retryable, not ambiguous. */
const slowDown = (): Error =>
  Object.assign(new Error('Please reduce your request rate.'), {
    name: 'SlowDown',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

/** Enough copies of `make()` to outlast the stand-in SDK's 3 in-send attempts. */
const sdkExhausting = (make: () => Error): Error[] => [make(), make(), make()];

const accessDenied = (): Error =>
  Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });

function useRegion(region: string): { aws: FakeS3; restore: () => void } {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
  vi.stubEnv('AWS_REGION', region);
  const previous = getAwsClients();
  setAwsClients(new AwsClients({ region }));
  resetS3BucketCreateRetryStateForTests();
  const aws = new FakeS3(region);
  useService(aws.send);
  return {
    aws,
    restore: () => {
      setAwsClients(previous);
      vi.useRealTimers();
      vi.unstubAllEnvs();
    },
  };
}

const createWithRetry = (provider: S3BucketProvider, props: Record<string, unknown> = PROPS) =>
  withRetry(() => provider.create('Res', TYPE, props), 'Res', { sleep: advancingSleep });

describe('S3 bucket CreateBucket after an ambiguous attempt (issue #4639)', () => {
  let aws: FakeS3;
  let restore: () => void;
  beforeEach(() => ({ aws, restore } = useRegion(STACK_REGION)));
  afterEach(() => restore());

  it('refuses the bucket a lost 5xx response left behind instead of adopting it', async () => {
    aws.loseCreateResponse = transient500();

    const error = await createWithRetry(new S3BucketProvider()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    // The 5xx reached the engine (the SDK did not replay it), whose second
    // attempt collided with the bucket the first one made.
    expect(sentVia.filter(([n]) => n === 'CreateBucketCommand')).toHaveLength(2);
    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(2);
    // Refused: deterministic, nothing configured, nothing deleted, and no
    // created mark -- the bucket is not attributed to this create.
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(aws.configurationCalls()).toEqual([]);
    expect(aws.buckets.get(BUCKET)).toBe(STACK_REGION);
    expect(hasCreatedBeforeFailure(error)).toBe(false);
    const message = (error as Error).message;
    expect(message).toContain(`Refusing to adopt S3 bucket ${BUCKET}`);
    // A READ command leads; the delete is conditional and comes after it.
    const read = message.indexOf(`aws s3api list-buckets --prefix ${BUCKET}`);
    const list = message.indexOf(`aws s3api list-object-versions --bucket ${BUCKET}`);
    const deletion = message.indexOf(
      `aws s3api delete-bucket --bucket ${BUCKET} --region ${STACK_REGION}`
    );
    expect(read).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(read);
    expect(deletion).toBeGreaterThan(list);
    expect(message.slice(read, list)).toContain('its CreationDate is a hint, not proof');
    expect(message.slice(list, deletion)).toContain(
      'it is empty, and nobody else on your team uses this name'
    );
    expect(message.slice(deletion)).toContain('BucketNotEmpty');
    // An explicit name is not adopted by a re-run (go-to-k/cdkd#4684), so the
    // refusal points at `cdkd import` instead.
    expect(message.slice(deletion)).toContain(
      'If it is a bucket you mean this stack to own, adopt it with `cdkd import` and re-run'
    );
    expect(message).not.toContain('re-run the deploy to adopt it');
    expect(message).toContain('the bucket now exists');
  });

  it('keeps the re-run advice for a GENERATED name, which a re-run still adopts', async () => {
    aws.loseCreateResponse = transient500();

    const error = await createWithRetry(new S3BucketProvider(), GENERATED_PROPS).catch(
      (e: unknown) => e
    );

    expect(isMarkedNonRetryable(error)).toBe(true);
    const message = (error as Error).message;
    expect(message).toContain(`Refusing to adopt S3 bucket ${GENERATED}`);
    expect(message).toContain('re-run the deploy to adopt it');
    expect(message).not.toContain('cdkd import');
  });

  it('still refuses when a second ambiguous attempt came between the first and the collision', async () => {
    aws.loseCreateResponse = transient500();
    const provider = new S3BucketProvider();
    let attempts = 0;
    const error = await withRetry(
      () => {
        attempts++;
        // The second attempt fails with a 5xx before S3 looks at the name.
        if (attempts === 2) aws.failCreateBefore = transient500();
        return provider.create('Res', TYPE, PROPS);
      },
      'Res',
      { sleep: advancingSleep }
    ).catch((e: unknown) => e);

    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(3);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(aws.configurationCalls()).toEqual([]);
  });

  // An attempt that ends without CreateBucket's verdict must not spend the window.
  const interrupted = async (between: (attempt: number) => void): Promise<unknown> => {
    aws.loseCreateResponse = transient500();
    const provider = new S3BucketProvider();
    let attempts = 0;
    return withRetry(
      () => {
        attempts++;
        between(attempts);
        return provider.create('Res', TYPE, PROPS);
      },
      'Res',
      { sleep: advancingSleep }
    ).catch((e: unknown) => e);
  };

  it('still refuses when an OperationAborted came between the 5xx and the collision', async () => {
    const error = await interrupted((n) => {
      if (n === 2) aws.createFailures = [operationAborted()];
    });

    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(3);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect((error as Error).message).toContain('Refusing to adopt');
    expect(aws.configurationCalls()).toEqual([]);
  });

  it('still refuses when a SlowDown outlasting the SDK came between the 5xx and the collision', async () => {
    const error = await interrupted((n) => {
      if (n === 2) aws.createFailures = sdkExhausting(slowDown);
    });

    expect(isMarkedNonRetryable(error)).toBe(true);
    expect((error as Error).message).toContain('Refusing to adopt');
    expect(aws.configurationCalls()).toEqual([]);
  });

  it("still refuses when the owned-bucket arm's GetBucketLocation was throttled", async () => {
    aws.omitRegionHeader = true;
    const error = await interrupted((n) => {
      if (n === 2) aws.locationFailures = sdkExhausting(slowDown);
    });

    // Attempt 2 collided but could not read the region; attempt 3 did.
    expect(aws.calls.filter((c) => c === 'GetBucketLocationCommand').length).toBeGreaterThan(1);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect((error as Error).message).toContain('Refusing to adopt');
    expect(aws.configurationCalls()).toEqual([]);
  });

  it('a fresh create spends the window: the re-run takes the cold path', async () => {
    aws.failCreateBefore = transient500();
    aws.failing = {
      PutBucketVersioningCommand: accessDenied(),
      DeleteBucketCommand: accessDenied(),
    };
    const provider = new S3BucketProvider();
    const first = await createWithRetry(provider).catch((e: unknown) => e);
    // This attempt's own bucket, left behind and named for the journal.
    expect(hasCreatedBeforeFailure(first)).toBe(true);
    aws.failing = {};
    aws.calls.length = 0;

    expectColdExplicitRefusal(await createWithRetry(provider).catch((e: unknown) => e), aws);
  });

  it('a fresh create spends the window: a generated name is adopted on the re-run', async () => {
    aws.failCreateBefore = transient500();
    aws.failing = {
      PutBucketVersioningCommand: accessDenied(),
      DeleteBucketCommand: accessDenied(),
    };
    const provider = new S3BucketProvider();
    const first = await createWithRetry(provider, GENERATED_PROPS).catch((e: unknown) => e);
    expect(hasCreatedBeforeFailure(first)).toBe(true);
    aws.failing = {};

    const result = await createWithRetry(provider, GENERATED_PROPS);

    expect(result.physicalId).toBe(GENERATED);
  });

  it("BucketAlreadyExists is the oracle's answer: the window is spent, not held", async () => {
    aws.failCreateBefore = transient500();
    const provider = new S3BucketProvider();
    let attempts = 0;
    const error = await withRetry(
      () => {
        attempts++;
        if (attempts === 2) aws.foreign.set(BUCKET, STACK_REGION);
        return provider.create('Res', TYPE, PROPS);
      },
      'Res',
      { sleep: advancingSleep }
    ).catch((e: unknown) => e);
    expect((error as Error).message).toContain('BucketAlreadyExists');
    expect((error as Error).message).not.toContain('Refusing to adopt');
    // Later, a bucket of ours under the name is the cold path again.
    aws.foreign.clear();
    aws.buckets.set(BUCKET, STACK_REGION);
    aws.calls.length = 0;

    expectColdExplicitRefusal(
      await provider.create('Res', TYPE, PROPS).catch((e: unknown) => e),
      aws
    );
  });

  it('creates normally when the 5xx attempt made nothing, and attributes THAT bucket', async () => {
    aws.failCreateBefore = transient500();
    aws.failing = { PutBucketVersioningCommand: accessDenied() };

    const error = await createWithRetry(new S3BucketProvider()).catch((e: unknown) => e);

    // The retry's 200 is proof outside us-east-1: the bucket is this create's,
    // so the failed configuration call cleans it up.
    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(2);
    expect(aws.calls).toContain('PutBucketVersioningCommand');
    expect(aws.calls).toContain('DeleteBucketCommand');
    expect(aws.buckets.has(BUCKET)).toBe(false);
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('a definite failure arms nothing: the next create of a bucket already there takes the cold path', async () => {
    const provider = new S3BucketProvider();
    aws.failCreateBefore = accessDenied();
    await expect(provider.create('Res', TYPE, PROPS)).rejects.toThrow();
    aws.buckets.set(BUCKET, STACK_REGION);

    expectColdExplicitRefusal(
      await provider.create('Res', TYPE, PROPS).catch((e: unknown) => e),
      aws
    );
  });

  it('a definite failure arms nothing: a generated name already there is adopted', async () => {
    const provider = new S3BucketProvider();
    aws.failCreateBefore = accessDenied();
    await expect(provider.create('Res', TYPE, GENERATED_PROPS)).rejects.toThrow();
    aws.buckets.set(GENERATED, STACK_REGION);

    const result = await provider.create('Res', TYPE, GENERATED_PROPS);

    expect(result.physicalId).toBe(GENERATED);
    expect(aws.calls).toContain('PutBucketVersioningCommand');
  });

  it('the latch is spent by the refusal: a re-run takes the cold path', async () => {
    aws.loseCreateResponse = transient500();
    const provider = new S3BucketProvider();
    await createWithRetry(provider).catch(() => undefined);
    aws.calls.length = 0;

    expectColdExplicitRefusal(await createWithRetry(provider).catch((e: unknown) => e), aws);
  });

  it('the latch is spent by the refusal: a re-run adopts a generated name', async () => {
    aws.loseCreateResponse = transient500();
    const provider = new S3BucketProvider();
    await createWithRetry(provider, GENERATED_PROPS).catch(() => undefined);

    const result = await createWithRetry(provider, GENERATED_PROPS);

    expect(result.physicalId).toBe(GENERATED);
    expect(aws.calls).toContain('PutBucketVersioningCommand');
  });
});

describe('S3 bucket cold BucketAlreadyOwnedByYou (go-to-k/cdkd#4684)', () => {
  let aws: FakeS3;
  let restore: () => void;
  beforeEach(() => ({ aws, restore } = useRegion(STACK_REGION)));
  afterEach(() => restore());

  it('refuses an explicit name a same-region bucket held before any attempt', async () => {
    aws.buckets.set(BUCKET, STACK_REGION);

    const error = await createWithRetry(new S3BucketProvider()).catch((e: unknown) => e);

    expectColdExplicitRefusal(error, aws);
    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(1);
    expect(hasCreatedBeforeFailure(error)).toBe(false);
    expect(aws.buckets.get(BUCKET)).toBe(STACK_REGION);
  });

  it('adopts and configures a generated name a same-region bucket held before any attempt', async () => {
    aws.buckets.set(GENERATED, STACK_REGION);

    const result = await createWithRetry(new S3BucketProvider(), GENERATED_PROPS);

    expect(result.physicalId).toBe(GENERATED);
    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(1);
    expect(aws.calls).toContain('PutBucketVersioningCommand');
  });

  it('a configuration failure after that adoption carries no created mark and deletes nothing', async () => {
    aws.buckets.set(GENERATED, STACK_REGION);
    aws.failing = { PutBucketVersioningCommand: accessDenied() };

    const error = await createWithRetry(new S3BucketProvider(), GENERATED_PROPS).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(Error);
    expect(hasCreatedBeforeFailure(error)).toBe(false);
    expect(aws.calls).not.toContain('DeleteBucketCommand');
    expect(aws.buckets.get(GENERATED)).toBe(STACK_REGION);
  });
});

describe('S3 bucket CreateBucket in us-east-1 after an ambiguous attempt (issue #4639)', () => {
  let aws: FakeS3;
  let restore: () => void;
  beforeEach(() => ({ aws, restore } = useRegion('us-east-1')));
  afterEach(() => restore());

  it('refuses at the pre-flight, without a second CreateBucket, over the bucket a lost 5xx left behind', async () => {
    aws.loseCreateResponse = transient500();

    const error = await createWithRetry(new S3BucketProvider()).catch((e: unknown) => e);

    expect(isMarkedNonRetryable(error)).toBe(true);
    // No re-create: its legacy 200 would only reset the bucket's ACLs.
    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(1);
    expect(aws.configurationCalls()).toEqual([]);
    expect(hasCreatedBeforeFailure(error)).toBe(false);
    const message = (error as Error).message;
    expect(message).toContain('the bucket now exists');
    expect(message).toContain(`aws s3api list-buckets --prefix ${BUCKET}`);
    expect(message).toContain(`aws s3api delete-bucket --bucket ${BUCKET} --region us-east-1`);
    // An explicit name is not adopted by a re-run (go-to-k/cdkd#4684).
    expect(message).toContain('adopt it with `cdkd import` and re-run');
    expect(message).not.toContain('re-run the deploy to adopt it');
  });

  it('keeps the re-run advice for a GENERATED name, which a re-run still adopts', async () => {
    aws.loseCreateResponse = transient500();

    const error = await createWithRetry(new S3BucketProvider(), GENERATED_PROPS).catch(
      (e: unknown) => e
    );

    expect(isMarkedNonRetryable(error)).toBe(true);
    const message = (error as Error).message;
    expect(message).toContain('the bucket now exists');
    expect(message).toContain('re-run the deploy to adopt it');
    expect(message).not.toContain('cdkd import');
  });

  it('refuses at an unanswered pre-flight without sending, so nothing unattributed is created', async () => {
    aws.failCreateBefore = transient500();
    aws.denyLocation = true;

    const error = await createWithRetry(new S3BucketProvider()).catch((e: unknown) => e);

    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(1);
    expect(aws.buckets.has(BUCKET)).toBe(false);
    expect(aws.configurationCalls()).toEqual([]);
    expect((error as Error).message).toContain('a bucket of that name may exist');
  });

  it('a bucket another account took meanwhile is refused at the pre-flight, never re-created over', async () => {
    aws.failCreateBefore = transient500();
    const provider = new S3BucketProvider();
    let attempts = 0;
    const error = await withRetry(
      () => {
        attempts++;
        if (attempts === 2) aws.foreign.set(BUCKET, 'us-east-1');
        return provider.create('Res', TYPE, PROPS);
      },
      'Res',
      { sleep: advancingSleep }
    ).catch((e: unknown) => e);

    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(1);
    expect(isMarkedNonRetryable(error)).toBe(true);
    // The refusal's first command is the one that shows the bucket is not ours.
    expect((error as Error).message).toContain(`aws s3api list-buckets --prefix ${BUCKET}`);
    expect(aws.configurationCalls()).toEqual([]);
  });

  it('a 5xx that made nothing keeps the pre-flight proof: the retry creates and attributes the bucket', async () => {
    aws.failCreateBefore = transient500();
    aws.failing = { PutBucketVersioningCommand: accessDenied() };

    const error = await createWithRetry(new S3BucketProvider()).catch((e: unknown) => e);

    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(2);
    expect(aws.calls).toContain('DeleteBucketCommand');
    expect(aws.buckets.has(BUCKET)).toBe(false);
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('a cold create of an explicit name over a bucket already there is refused before the send', async () => {
    aws.buckets.set(BUCKET, 'us-east-1');

    const error = await createWithRetry(new S3BucketProvider()).catch((e: unknown) => e);

    // go-to-k/cdkd#4684: no legacy 200 (which would reset the bucket's ACLs).
    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(0);
    expect(aws.configurationCalls()).toEqual([]);
    expect((error as Error).message).toContain('its BucketName is set explicitly');
    expect((error as Error).message).not.toContain('ended without a definite answer');
  });

  it('a cold create of an explicit name the pre-flight cannot read is refused by the bucket list (go-to-k/cdkd#4684)', async () => {
    aws.buckets.set(BUCKET, 'us-east-1');
    aws.denyLocation = true;

    const error = await createWithRetry(new S3BucketProvider()).catch((e: unknown) => e);

    expect(aws.calls).toContain('ListBucketsCommand');
    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(0);
    expect(aws.configurationCalls()).toEqual([]);
    expect((error as Error).message).toContain("already exists in this account's bucket list");
  });

  it('a cold create of a generated name over a bucket already there is still the legacy-200 adoption', async () => {
    aws.buckets.set(GENERATED, 'us-east-1');

    const result = await createWithRetry(new S3BucketProvider(), GENERATED_PROPS);

    expect(result.physicalId).toBe(GENERATED);
    expect(aws.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(1);
    expect(aws.calls).toContain('PutBucketVersioningCommand');
  });
});

describe('S3 bucket CreateBucket client (issue #4639)', () => {
  let aws: FakeS3;
  let restore: () => void;
  beforeEach(() => ({ aws, restore } = useRegion(STACK_REGION)));
  afterEach(() => restore());

  it('sends the create through a client that refuses the SDK retry of a 5xx, and nothing else', async () => {
    aws.failing = { PutBucketVersioningCommand: accessDenied() };
    await new S3BucketProvider().create('Res', TYPE, PROPS).catch(() => undefined);

    for (const config of configsOf('CreateBucketCommand')) {
      await expectRefusesServerErrorReplay(config);
    }
    const others = sentVia.filter(([n]) => n !== 'CreateBucketCommand');
    expect(others.map(([n]) => n)).toEqual(
      expect.arrayContaining(['PutBucketVersioningCommand', 'DeleteBucketCommand'])
    );
    for (const [, config] of others) await expectFullSdkRetry(config);
    for (const [, config] of sentVia) expect(await config.region()).toBe(STACK_REGION);
  });

  it('builds ONE create client per provider, and retries a rejected region read', async () => {
    const shared = getAwsClients().s3 as unknown as { config: { region: () => Promise<string> } };
    const provider = new S3BucketProvider();
    // Fail the create client's region read once (the create's FIRST read is
    // `getRegion()`, the second the create client's).
    let reads = 0;
    shared.config.region = () => {
      reads++;
      return reads === 2
        ? Promise.reject(new Error('region unresolved'))
        : Promise.resolve(STACK_REGION);
    };
    const built = () => vi.mocked(S3Client).mock.calls.length;
    const before = built();

    await expect(provider.create('Res', TYPE, PROPS)).rejects.toThrow(/region unresolved/);
    await provider.create('Res', TYPE, PROPS);
    // Gone again, so the third create makes it afresh rather than meeting the
    // second's bucket under its explicit name (go-to-k/cdkd#4684).
    aws.buckets.clear();
    await provider.create('Res', TYPE, PROPS);

    expect(built() - before).toBe(1);
    expect(configsOf('CreateBucketCommand')).toHaveLength(2);
  });
});

describe('S3 bucket CreateBucket client region and identity (issue #4639)', () => {
  let previous: AwsClients;
  beforeEach(() => {
    previous = getAwsClients();
    resetS3BucketCreateRetryStateForTests();
    useService(new FakeS3(STACK_REGION).send);
  });
  afterEach(() => {
    setAwsClients(previous);
    vi.unstubAllEnvs();
  });

  it("lands CreateBucket in the shared S3 client's region, not the ambient one", async () => {
    vi.stubEnv('AWS_REGION', 'ap-south-1');
    setAwsClients(new AwsClients({ region: STACK_REGION }));

    await new S3BucketProvider().create('Res', TYPE, PROPS);

    const creates = sentVia.filter(([n]) => n === 'CreateBucketCommand');
    expect(creates).toHaveLength(1);
    for (const [, config] of creates) expect(await config.region()).toBe(STACK_REGION);
  });

  it('builds the create client with the identity the provider was built under, across a switch', async () => {
    setAwsClients(new AwsClients({ region: STACK_REGION, profile: 'first-profile' }));
    const provider = new S3BucketProvider();
    setAwsClients(new AwsClients({ region: 'ap-south-1', profile: 'second-profile' }));

    await provider.create('Res', TYPE, PROPS);

    const creates = configsOf('CreateBucketCommand');
    expect(creates).toHaveLength(1);
    for (const config of creates) {
      expect(config.profile).toBe('first-profile');
      expect(await config.region()).toBe(STACK_REGION);
    }
    for (const [, config] of sentVia) expect(config.profile).toBe('first-profile');
  });

  it('builds the create client with the explicit credentials the provider was built under', async () => {
    const credentials = (accessKeyId: string) => ({ accessKeyId, secretAccessKey: 'secret' });
    setAwsClients(new AwsClients({ region: STACK_REGION, credentials: credentials('AKIDFIRST') }));
    const provider = new S3BucketProvider();
    setAwsClients(new AwsClients({ region: STACK_REGION, credentials: credentials('AKIDSECOND') }));

    await provider.create('Res', TYPE, PROPS);

    expect(configsOf('CreateBucketCommand').length).toBeGreaterThan(0);
    for (const [, config] of sentVia) expect(config.accessKeyId).toBe('AKIDFIRST');
  });
});
