import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#4758: an explicit-name create whose first attempt made its
// bucket, failed a wiring call with an error the deploy engine retries, and
// could not delete the bucket again. The retry's `CreateBucket` then meets
// that very bucket (`BucketAlreadyOwnedByYou`, or the us-east-1 pre-flight
// finding it), and the explicit-name refusal (go-to-k/cdkd#4684) failed a
// deploy the retry would have finished. The failed attempt now records the
// bucket's identity, and the retry adopts the bucket only when it is still
// that one: same name, region and `CreationDate`.

const { mockSend, clientRegion } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'eu-west-1' },
}));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-s3')>()),
  ...(await import('../s3-create-client-forward.js')).forwardedS3Client(),
}));

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
  }),
}));

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { BucketAlreadyOwnedByYou, NoSuchBucket } from '@aws-sdk/client-s3';
import {
  S3BucketProvider,
  resetS3BucketCreateRetryStateForTests,
} from '../../../../src/provisioning/providers/s3-bucket-provider.js';
import { createdBeforeFailure } from '../../../../src/provisioning/auxiliary-failure.js';
import { withRetry } from '../../../../src/deployment/retry.js';

const TYPE = 'AWS::S3::Bucket';
const BUCKET = 'own-leftover-bucket-4758';
const EXPLICIT = { BucketName: BUCKET, VersioningConfiguration: { Status: 'Enabled' } };
const D1 = new Date('2026-10-09T01:00:00.000Z');
const D2 = new Date('2026-10-09T01:05:00.000Z');
const MOVED_BY_409 = new Date('2026-10-09T01:09:00.000Z');

const denied = (action: string): Error =>
  Object.assign(
    new Error(`User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: ${action}`),
    { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }
  );

function ownedHere(region: string): Error {
  return Object.assign(
    new BucketAlreadyOwnedByYou({
      message: 'Your previous request to create the named bucket succeeded and you already own it.',
      $metadata: { httpStatusCode: 409 },
    }),
    { $response: { headers: { 'x-amz-bucket-region': region } } }
  );
}

const noSuchBucket = (): Error =>
  new NoSuchBucket({ message: 'The specified bucket does not exist', $metadata: { httpStatusCode: 404 } });

/**
 * The account as one attempt sees it. `exists` is whether the bucket is
 * there before this attempt's `CreateBucket`; `created` is its listed date.
 */
function world(opts: {
  exists: boolean;
  created: Date;
  wiring: 'fail' | 'ok';
  deleteFails?: boolean;
  bucketRegion?: string;
  listFails?: boolean;
  listHangs?: boolean;
  locationFailsOnce?: boolean;
}): void {
  let locationFailures = opts.locationFailsOnce ? 1 : 0;
  let exists = opts.exists;
  let created = opts.created;
  const region = opts.bucketRegion ?? clientRegion.value;
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'GetBucketLocationCommand':
        if (locationFailures > 0) {
          locationFailures--;
          return Promise.reject(Object.assign(new Error('Rate exceeded'), { name: 'SlowDown' }));
        }
        return exists
          ? Promise.resolve({ LocationConstraint: region === 'us-east-1' ? undefined : region })
          : Promise.reject(noSuchBucket());
      case 'CreateBucketCommand':
        if (exists) {
          if (region === 'us-east-1') return Promise.resolve({});
          // Measured (go-to-k/cdkd#4758, us-west-2): the 409 moves the
          // bucket's ListBuckets CreationDate to its own second.
          created = MOVED_BY_409;
          return Promise.reject(ownedHere(region));
        }
        exists = true;
        return Promise.resolve({});
      case 'ListBucketsCommand':
        if (opts.listHangs) return new Promise(() => {});
        if (opts.listFails) return Promise.reject(Object.assign(new Error('Rate exceeded'), { name: 'SlowDown' }));
        return Promise.resolve({
          Buckets: exists ? [{ Name: BUCKET, CreationDate: created }] : [],
        });
      case 'PutBucketVersioningCommand':
        return opts.wiring === 'fail'
          ? Promise.reject(denied('s3:PutBucketVersioning'))
          : Promise.resolve({});
      case 'DeleteBucketCommand':
        if (opts.deleteFails ?? true) return Promise.reject(denied('s3:DeleteBucket'));
        exists = false;
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  });
}

const sent = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);

async function failed(run: Promise<unknown>): Promise<Error> {
  const error = await run.then(
    () => expect.fail('create resolved'),
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/** Attempt 1: the bucket is made, its wiring and its cleanup both fail. */
async function firstAttemptLeavesBucket(provider: S3BucketProvider, logicalId = 'MyBucket') {
  world({ exists: false, created: D1, wiring: 'fail' });
  const error = await failed(provider.create(logicalId, TYPE, EXPLICIT));
  // Premise: the failure names the bucket it made, as #4583 does.
  expect(createdBeforeFailure(error, logicalId, TYPE)).toBe(BUCKET);
  mockSend.mockClear();
  return error;
}

const REFUSED = 'its BucketName is set explicitly';

describe('a retried explicit-name create meeting its own first attempt’s bucket (go-to-k/cdkd#4758)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    resetS3BucketCreateRetryStateForTests();
    clientRegion.value = 'eu-west-1';
    provider = new S3BucketProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adopts it when name, region and CreationDate are the ones the failed attempt recorded', async () => {
    await firstAttemptLeavesBucket(provider);
    world({ exists: true, created: D1, wiring: 'ok' });

    const result = await provider.create('MyBucket', TYPE, EXPLICIT);

    expect(result.physicalId).toBe(BUCKET);
    expect(sent()).toContain('PutBucketVersioningCommand');
    // Proven before any send: a CreateBucket's 409 would have moved the date.
    expect(sent()).not.toContain('CreateBucketCommand');
  });

  it('treats the adopted bucket as its own: a second failure cleans it up and marks it', async () => {
    await firstAttemptLeavesBucket(provider);
    world({ exists: true, created: D1, wiring: 'fail' });

    const error = await failed(provider.create('MyBucket', TYPE, EXPLICIT));

    expect(error.message).not.toContain(REFUSED);
    expect(sent()).toContain('DeleteBucketCommand');
    expect(createdBeforeFailure(error, 'MyBucket', TYPE)).toBe(BUCKET);
  });

  it('refuses a bucket re-created under the name since (another CreationDate)', async () => {
    await firstAttemptLeavesBucket(provider);
    world({ exists: true, created: D2, wiring: 'ok' });

    const error = await failed(provider.create('MyBucket', TYPE, EXPLICIT));

    expect(error.message).toContain(REFUSED);
    expect(sent()).not.toContain('PutBucketVersioningCommand');
  });

  it('refuses a bucket of the name in another region', async () => {
    await firstAttemptLeavesBucket(provider);
    world({ exists: true, created: D1, wiring: 'ok', bucketRegion: 'us-west-2' });

    const error = await failed(provider.create('MyBucket', TYPE, EXPLICIT));

    expect(error.message).toContain('us-west-2');
    expect(sent()).not.toContain('PutBucketVersioningCommand');
  });

  it('uses the record once', async () => {
    await firstAttemptLeavesBucket(provider);
    world({ exists: true, created: D2, wiring: 'ok' });
    await failed(provider.create('MyBucket', TYPE, EXPLICIT));
    // The bucket now matches the record again, but the record is spent.
    world({ exists: true, created: D1, wiring: 'ok' });

    const error = await failed(provider.create('MyBucket', TYPE, EXPLICIT));

    expect(error.message).toContain(REFUSED);
  });

  it('refuses once the record has aged out', async () => {
    const now = Date.now();
    await firstAttemptLeavesBucket(provider);
    vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60_000);
    world({ exists: true, created: D1, wiring: 'ok' });

    const error = await failed(provider.create('MyBucket', TYPE, EXPLICIT));

    expect(error.message).toContain(REFUSED);
  });

  it('refuses for another logical id asking for the same name', async () => {
    await firstAttemptLeavesBucket(provider);
    world({ exists: true, created: D1, wiring: 'ok' });

    const error = await failed(provider.create('OtherBucket', TYPE, EXPLICIT));

    expect(error.message).toContain(REFUSED);
  });

  it('records nothing when the cleanup deleted the bucket', async () => {
    world({ exists: false, created: D1, wiring: 'fail', deleteFails: false });
    await failed(provider.create('MyBucket', TYPE, EXPLICIT));
    expect(sent()).not.toContain('GetBucketLocationCommand');
    expect(sent()).not.toContain('ListBucketsCommand');
  });

  it('records nothing for a generated name, whose holder is adopted as before', async () => {
    world({ exists: false, created: D1, wiring: 'fail' });
    await failed(provider.create('MyBucket', TYPE, { VersioningConfiguration: { Status: 'Enabled' } }));
    expect(sent()).not.toContain('ListBucketsCommand');
  });

  it('adopts in us-east-1 without sending CreateBucket again', async () => {
    clientRegion.value = 'us-east-1';
    await firstAttemptLeavesBucket(provider);
    world({ exists: true, created: D1, wiring: 'ok', bucketRegion: 'us-east-1' });

    const result = await provider.create('MyBucket', TYPE, EXPLICIT);

    expect(result.physicalId).toBe(BUCKET);
    expect(sent()).not.toContain('CreateBucketCommand');
    // Nothing was re-created over it, so the legacy-200 ACL warning is not owed.
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('ADOPTED');
  });

  it('adopts in us-east-1 when the pre-flight could not answer but the identity read could', async () => {
    clientRegion.value = 'us-east-1';
    await firstAttemptLeavesBucket(provider);
    world({
      exists: true,
      created: D1,
      wiring: 'ok',
      bucketRegion: 'us-east-1',
      locationFailsOnce: true,
    });

    const result = await provider.create('MyBucket', TYPE, EXPLICIT);

    expect(result.physicalId).toBe(BUCKET);
    expect(sent()).not.toContain('CreateBucketCommand');
  });

  it('refuses in us-east-1 a bucket re-created under the name since', async () => {
    clientRegion.value = 'us-east-1';
    await firstAttemptLeavesBucket(provider);
    world({ exists: true, created: D2, wiring: 'ok', bucketRegion: 'us-east-1' });

    const error = await failed(provider.create('MyBucket', TYPE, EXPLICIT));

    expect(error.message).toContain(REFUSED);
    expect(sent()).not.toContain('CreateBucketCommand');
  });

  it('refuses when the bucket\u2019s identity cannot be read on the retry', async () => {
    await firstAttemptLeavesBucket(provider);
    world({ exists: true, created: D1, wiring: 'ok', listFails: true });

    const error = await failed(provider.create('MyBucket', TYPE, EXPLICIT));

    expect(error.message).toContain(REFUSED);
  });

  it('bounds the identity read on the failure path: a hung list records nothing', async () => {
    vi.useFakeTimers();
    try {
      world({ exists: false, created: D1, wiring: 'fail', listHangs: true });
      const run = provider.create('MyBucket', TYPE, EXPLICIT).then(
        () => expect.fail('create resolved'),
        (e: unknown) => e
      );
      await vi.advanceTimersByTimeAsync(10_001);
      const error = (await run) as Error;
      // The mark still names the bucket; only the record is missing.
      expect(createdBeforeFailure(error, 'MyBucket', TYPE)).toBe(BUCKET);
    } finally {
      vi.useRealTimers();
    }
    mockSend.mockClear();
    world({ exists: true, created: D1, wiring: 'ok' });
    const error = await failed(provider.create('MyBucket', TYPE, EXPLICIT));
    expect(error.message).toContain(REFUSED);
  });

  it('never takes it on a rollback\u2019s re-create (replayingState)', async () => {
    await firstAttemptLeavesBucket(provider);
    world({ exists: true, created: D1, wiring: 'ok' });

    const error = await failed(
      provider.create('MyBucket', TYPE, EXPLICIT, { replayingState: true } as never)
    );

    expect(error.message).toContain(REFUSED);
  });

  it("through the deploy engine's retry loop: the AccessDenied is retried and the deploy finishes", async () => {
    let attempt = 0;
    const result = await withRetry(
      () => {
        attempt++;
        world(
          attempt === 1
            ? { exists: false, created: D1, wiring: 'fail' }
            : { exists: true, created: D1, wiring: 'ok' }
        );
        return provider.create('MyBucket', TYPE, EXPLICIT);
      },
      'MyBucket',
      { sleep: () => Promise.resolve() }
    );
    expect(attempt).toBe(2);
    expect(result.physicalId).toBe(BUCKET);
  });
});
