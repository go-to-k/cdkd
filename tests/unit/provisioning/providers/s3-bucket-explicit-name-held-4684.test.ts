import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4684: a create whose EXPLICIT `BucketName` a bucket already
// holds -- S3's `BucketAlreadyOwnedByYou` 409, or the us-east-1 pre-flight
// finding it, where `CreateBucket` would answer 200 and reset its ACLs -- is
// refused, not adopted. A GENERATED name's holder is still adopted (#4345).
// The deploy engine asks before a plain create and a renamed replacement; this
// is the provider's own floor for every create that skips that lookup (a
// same-name replacement, a rollback's re-create of a replaced bucket) and the
// lookup-to-create race.

const { mockSend, clientRegion } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'eu-west-1' },
}));

// CreateBucket goes through its own S3Client (issue #4639); forward it to the
// shared double below.
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
import { S3BucketProvider } from '../../../../src/provisioning/providers/s3-bucket-provider.js';
import {
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
} from '../../../../src/deployment/retryable-errors.js';
import { hasCreatedBeforeFailure } from '../../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::S3::Bucket';
const BUCKET = 'held-explicit-bucket-4684';
const EXPLICIT = { BucketName: BUCKET, VersioningConfiguration: { Status: 'Enabled' } };
const GENERATED = { VersioningConfiguration: { Status: 'Enabled' } };

/** The 409 as the SDK delivers it, with the bucket's region on the header. */
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
  new NoSuchBucket({
    message: 'The specified bucket does not exist',
    $metadata: { httpStatusCode: 404 },
  });

/** Answers each command by name; anything unnamed resolves `{}`. */
function answer(byName: Record<string, unknown>): void {
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const value = byName[cmd.constructor.name];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? {});
  });
}

const sent = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);

async function refusal(run: Promise<unknown>): Promise<Error> {
  const error = await run.then(
    () => expect.fail('create resolved'),
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/** Everything the refusal owes, whichever arm raised it. */
function expectExplicitRefusal(error: Error): void {
  expect(error.message).toContain(`Refusing to adopt S3 bucket ${BUCKET} for MyBucket`);
  expect(error.message).toContain('its BucketName is set explicitly');
  expect(error.message).toContain('`cdkd import`');
  expect(error.message).toContain('Nothing was applied to it');
  // The create-first replacement and the rollback's reverse replacement read
  // this verdict; it is anchored to THIS logical id.
  expect(isNameCollisionErrorFrom(error, 'MyBucket')).toBe(true);
  expect(isNameCollisionErrorFrom(error, 'OtherBucket')).toBe(false);
  // Deterministic: the next attempt meets the same bucket.
  expect(isMarkedNonRetryable(error)).toBe(true);
  expect(isRetryableTransientError(error, error.message)).toBe(false);
  expect(error.message).not.toContain('does not exist');
  // Not this create's bucket: nothing names it for a rollback to delete.
  expect(hasCreatedBeforeFailure(error)).toBe(false);
}

describe('S3BucketProvider explicit BucketName already held (go-to-k/cdkd#4684)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'eu-west-1';
    provider = new S3BucketProvider();
  });

  describe('BucketAlreadyOwnedByYou in the stack region', () => {
    it('refuses an explicit name with nothing configured', async () => {
      answer({ CreateBucketCommand: ownedHere('eu-west-1') });

      const error = await refusal(provider.create('MyBucket', TYPE, EXPLICIT));

      expectExplicitRefusal(error);
      expect(error.message).toContain('S3 answered BucketAlreadyOwnedByYou');
      expect(sent()).toEqual(['CreateBucketCommand']);
    });

    it('refuses on a state replay too: identity is not a template value the replay may soften', async () => {
      answer({ CreateBucketCommand: ownedHere('eu-west-1') });

      const error = await refusal(
        provider.create('MyBucket', TYPE, EXPLICIT, { replayingState: true })
      );

      expectExplicitRefusal(error);
      expect(sent()).toEqual(['CreateBucketCommand']);
    });

    it('still adopts and configures a GENERATED name (the negative control)', async () => {
      answer({ CreateBucketCommand: ownedHere('eu-west-1') });

      const result = await provider.create('MyBucket', TYPE, GENERATED);

      const created = mockSend.mock.calls[0]![0] as { input: { Bucket: string } };
      expect(result.physicalId).toBe(created.input.Bucket);
      expect(sent()).toEqual(['CreateBucketCommand', 'PutBucketVersioningCommand']);
    });

    it('keeps the foreign-region refusal ahead of it', async () => {
      answer({ CreateBucketCommand: ownedHere('us-west-2') });

      const error = await refusal(provider.create('MyBucket', TYPE, EXPLICIT));

      expect(error.message).toContain('Refusing to adopt existing S3 bucket');
      expect(error.message).toContain('lives in us-west-2');
      expect(error.message).not.toContain('its BucketName is set explicitly');
    });

    it('creates an explicit name nobody holds as before', async () => {
      answer({});

      const result = await provider.create('MyBucket', TYPE, EXPLICIT);

      expect(result.physicalId).toBe(BUCKET);
      expect(sent()).toEqual(['CreateBucketCommand', 'PutBucketVersioningCommand']);
    });
  });

  describe('us-east-1, where a re-create answers 200', () => {
    beforeEach(() => {
      clientRegion.value = 'us-east-1';
    });

    it('refuses an explicit name the pre-flight found, BEFORE CreateBucket is sent', async () => {
      answer({ GetBucketLocationCommand: { LocationConstraint: null } });

      const error = await refusal(provider.create('MyBucket', TYPE, EXPLICIT));

      expectExplicitRefusal(error);
      expect(error.message).toContain('already in us-east-1');
      // No legacy 200, so the bucket's ACLs are not reset; no adopt warning.
      expect(sent()).toEqual(['GetBucketLocationCommand']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('refuses on a state replay too', async () => {
      answer({ GetBucketLocationCommand: { LocationConstraint: null } });

      const error = await refusal(
        provider.create('MyBucket', TYPE, EXPLICIT, { replayingState: true })
      );

      expectExplicitRefusal(error);
      expect(sent()).toEqual(['GetBucketLocationCommand']);
    });

    it('still adopts a GENERATED name through the legacy 200, with its warning', async () => {
      answer({ GetBucketLocationCommand: { LocationConstraint: null } });

      await provider.create('MyBucket', TYPE, GENERATED);

      expect(sent()).toEqual([
        'GetBucketLocationCommand',
        'CreateBucketCommand',
        'PutBucketVersioningCommand',
      ]);
      expect(String(warn.mock.calls[0]?.[0])).toContain('was ADOPTED, not created');
    });

    it('creates an explicit name the pre-flight found free as before', async () => {
      answer({ GetBucketLocationCommand: noSuchBucket() });

      const result = await provider.create('MyBucket', TYPE, EXPLICIT);

      expect(result.physicalId).toBe(BUCKET);
      expect(sent()).toEqual([
        'GetBucketLocationCommand',
        'CreateBucketCommand',
        'PutBucketVersioningCommand',
      ]);
    });
  });
});
