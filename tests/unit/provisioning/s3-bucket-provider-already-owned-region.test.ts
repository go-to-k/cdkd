import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, clientRegion } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  // eu-west-1 rather than us-east-1, and the reason is a wire fact rather than
  // a preference: `BucketAlreadyOwnedByYou` -- the error EVERY case in this
  // file is about -- is the answer in "all Amazon Web Services Regions except
  // in the North Virginia Region" (`@aws-sdk/client-s3`
  // `dist-types/models/errors.d.ts`). A `us-east-1` client therefore receives
  // it ONLY for a bucket that lives somewhere else; the same-region case there
  // is answered by the legacy 200 instead, which is issue #2241's path and is
  // fenced in `s3-bucket-provider-us-east-1-preflight.test.ts`. Defaulting to
  // us-east-1 made three cases below encode a 409 that region cannot produce.
  clientRegion: { value: 'eu-west-1' },
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

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'my-globally-unique-bucket';

class BucketAlreadyOwnedByYou extends Error {
  override name = 'BucketAlreadyOwnedByYou';
}

/**
 * The 409 as the SDK actually delivers it. Measured 2026-08-26 against a bucket
 * in us-west-2 from clients pinned to us-east-1 / eu-west-1 / ap-northeast-1:
 * `x-amz-bucket-region` was present on `$response.headers` every time, and
 * `$metadata.httpHeaders` was ABSENT every time. Building the fixture the way
 * the wire actually looks is the whole point of this file's history.
 */
function ownedElsewhere(region: string): Error {
  const e = new BucketAlreadyOwnedByYou('you already own it');
  Object.assign(e, {
    $response: { headers: { 'x-amz-bucket-region': region } },
    $metadata: { httpStatusCode: 409 },
  });
  return e;
}

/** The same 409 with NO region header, forcing the GetBucketLocation fallback. */
function ownedNoHeader(): Error {
  const e = new BucketAlreadyOwnedByYou('you already own it');
  Object.assign(e, { $metadata: { httpStatusCode: 409 } });
  return e;
}

const sentCommands = (): string[] => mockSend.mock.calls.map((c) => c[0].constructor.name);

/**
 * Issue [#2227](https://github.com/go-to-k/cdkd/issues/2227).
 *
 * `CreateBucket` answers `BucketAlreadyOwnedByYou` on OWNERSHIP, which is
 * account-global, while a bucket is regional. Measured on real AWS: a bucket
 * created in `us-west-2` answers it to a `CreateBucket` in `eu-west-1`,
 * `us-east-1` and `ap-northeast-1` alike, and the bucket never moves. Before
 * this guard the provider short-circuited that to an idempotent-create SUCCESS,
 * so the deploy applied the whole stack's bucket configuration to another
 * region's bucket and recorded a physical id denoting no bucket in its own.
 *
 * This is NOT an explicit-`BucketName` edge case: the default name is
 * `{stackName}-{logicalId}` (`generateResourceName`) with no region or account
 * in it, so one stack deployed to two regions collides by construction.
 *
 * ## Why this file was rewritten once, and what that must not repeat
 *
 * The first version mocked `HeadBucket` RESOLVING with a `BucketRegion` field.
 * All seven cases passed and were mutation-probed two complementary ways --
 * and the guard could not fire against real AWS at all. A cross-region
 * `HeadBucket` 301s, and SDK v3 mishandles the empty-body HEAD response into a
 * synthetic `name: 'Unknown', message: 'UnknownError'`; the AWS CLI hides this
 * by following the redirect, so a hand measurement taken with the CLI encoded a
 * shape the SDK never produces. Only a real-AWS integ arm caught it.
 *
 * A mutation probe cannot catch that class: it perturbs the CODE and reads the
 * TEST, while both read the same fixture, so any premise SHARED by code and
 * mock is invariant under mutation. The fixtures here are therefore built from
 * measured wire shapes, and the ones that can only be settled live are named as
 * such rather than assumed.
 *
 * Every case asserts the COMMAND SEQUENCE, not only the thrown message: the
 * load-bearing claim is that the deploy stops BEFORE issuing configuration
 * writes against a foreign-region bucket, and a message assertion alone is
 * satisfied by any failure that happens to stop early.
 */
describe('S3BucketProvider BucketAlreadyOwnedByYou region guard (issue #2227)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'eu-west-1';
    provider = new S3BucketProvider();
  });

  describe('the region comes from the 409 itself, with no extra call', () => {
    it('REFUSES a bucket the error reports in another region, before any config write', async () => {
      mockSend.mockRejectedValueOnce(ownedElsewhere('us-west-2'));

      await expect(
        provider.create('MyBucket', RESOURCE_TYPE, {
          BucketName: BUCKET,
          VersioningConfiguration: { Status: 'Enabled' },
        })
      ).rejects.toThrow(/Refusing to adopt existing S3 bucket/);

      // The discriminator: ONE call total. No readback round trip, and nothing
      // configured against the foreign bucket.
      expect(sentCommands()).toEqual(['CreateBucketCommand']);
    });

    it('names BOTH regions, so the refusal is actionable', async () => {
      clientRegion.value = 'eu-west-1';
      mockSend.mockRejectedValueOnce(ownedElsewhere('us-west-2'));

      await expect(
        provider.create('MyBucket', RESOURCE_TYPE, { BucketName: BUCKET })
      ).rejects.toThrow(/lives in us-west-2, while this stack deploys to eu-west-1/);
    });

    it('ADOPTS and configures when the error reports THIS region', async () => {
      // The negative control for the header path. Without it a guard that
      // refused every already-owned bucket would satisfy every case above.
      mockSend.mockRejectedValueOnce(ownedElsewhere('eu-west-1'));
      mockSend.mockResolvedValue({});

      const result = await provider.create('MyBucket', RESOURCE_TYPE, {
        BucketName: BUCKET,
        VersioningConfiguration: { Status: 'Enabled' },
      });

      expect(result.physicalId).toBe(BUCKET);
      const names = sentCommands();
      expect(names[0]).toBe('CreateBucketCommand');
      expect(names).not.toContain('GetBucketLocationCommand');
      expect(names).toContain('PutBucketVersioningCommand');
    });

    it('never DELETES the bucket it refused to adopt', async () => {
      mockSend.mockRejectedValueOnce(ownedElsewhere('us-west-2'));

      await expect(
        provider.create('MyBucket', RESOURCE_TYPE, { BucketName: BUCKET })
      ).rejects.toThrow(/Refusing to adopt/);

      expect(sentCommands()).not.toContain('DeleteBucketCommand');
    });
  });

  it('finds the header in $metadata.httpHeaders when $response.headers is empty', async () => {
    // The lookup is per-KEY across both bags. A `??` between the BAGS would
    // select an empty `$response.headers` and fall through to the
    // GetBucketLocation round trip -- fail-closed, but a wasted call and a
    // JSDoc that claimed both bags were read.
    const e = new BucketAlreadyOwnedByYou('you already own it');
    Object.assign(e, {
      $response: { headers: {} },
      $metadata: { httpStatusCode: 409, httpHeaders: { 'x-amz-bucket-region': 'us-west-2' } },
    });
    mockSend.mockRejectedValueOnce(e);

    await expect(
      provider.create('MyBucket', RESOURCE_TYPE, { BucketName: BUCKET })
    ).rejects.toThrow(/lives in us-west-2/);

    // The discriminator: no fallback call was needed.
    expect(sentCommands()).toEqual(['CreateBucketCommand']);
  });

  it('ignores a blank header rather than treating it as a region', async () => {
    const e = new BucketAlreadyOwnedByYou('you already own it');
    Object.assign(e, { $response: { headers: { 'x-amz-bucket-region': '   ' } } });
    mockSend.mockRejectedValueOnce(e);
    mockSend.mockResolvedValueOnce({ LocationConstraint: 'us-west-2' });

    await expect(
      provider.create('MyBucket', RESOURCE_TYPE, { BucketName: BUCKET })
    ).rejects.toThrow(/lives in us-west-2/);

    // Blank is not a region: it must fall through to the readback, never be
    // canonicalized into an empty string that could match something.
    expect(sentCommands()).toEqual(['CreateBucketCommand', 'GetBucketLocationCommand']);
  });

  describe('GetBucketLocation fallback when the 409 carries no region header', () => {
    it('refuses on a cross-region LocationConstraint', async () => {
      mockSend.mockRejectedValueOnce(ownedNoHeader());
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'us-west-2' });

      await expect(
        provider.create('MyBucket', RESOURCE_TYPE, {
          BucketName: BUCKET,
          VersioningConfiguration: { Status: 'Enabled' },
        })
      ).rejects.toThrow(/lives in us-west-2/);

      expect(sentCommands()).toEqual(['CreateBucketCommand', 'GetBucketLocationCommand']);
    });

    // The three spellings S3 uses for "this bucket is in us-east-1". ABSENT
    // MEANS us-east-1 -- never "unknown". A fail-closed branch here would
    // refuse correct deploys in the single commonest region, which is exactly
    // what the first version of this guard did.
    //
    // Only the REFUSING half of the fold is fenced here. Its ADOPTING twin
    // used to sit alongside it with `clientRegion.value = 'us-east-1'`, and
    // that combination -- a 409 received BY a us-east-1 client FOR a bucket
    // the readback then places IN us-east-1 -- cannot occur: us-east-1 answers
    // a re-create of a bucket you already own there with the legacy 200, not
    // with this error (SDK doc quoted at the top of this file). The adopt side
    // of the same fold is fenced against the path that IS reachable, the
    // issue #2241 pre-flight, in
    // `s3-bucket-provider-us-east-1-preflight.test.ts`.
    for (const [label, response] of [
      ['an absent field', {}],
      ['an empty string', { LocationConstraint: '' }],
      ['an explicit null', { LocationConstraint: null }],
    ] as const) {
      it(`treats ${label} as us-east-1 and REFUSES, naming us-east-1, when deploying elsewhere`, async () => {
        clientRegion.value = 'eu-west-1';
        mockSend.mockRejectedValueOnce(ownedNoHeader());
        mockSend.mockResolvedValueOnce(response);

        await expect(
          provider.create('MyBucket', RESOURCE_TYPE, { BucketName: BUCKET })
        ).rejects.toThrow(/lives in us-east-1, while this stack deploys to eu-west-1/);
      });
    }

    it("folds the legacy 'EU' alias to eu-west-1 rather than refusing on it", async () => {
      clientRegion.value = 'eu-west-1';
      mockSend.mockRejectedValueOnce(ownedNoHeader());
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'EU' });
      mockSend.mockResolvedValue({});

      await expect(
        provider.create('MyBucket', RESOURCE_TYPE, { BucketName: BUCKET })
      ).resolves.toMatchObject({ physicalId: BUCKET });
    });

    it('does NOT adopt when the readback itself fails', async () => {
      mockSend.mockRejectedValueOnce(ownedNoHeader());
      mockSend.mockRejectedValueOnce(new Error('ThrottlingException: slow down'));

      await expect(
        provider.create('MyBucket', RESOURCE_TYPE, {
          BucketName: BUCKET,
          VersioningConfiguration: { Status: 'Enabled' },
        })
      ).rejects.toThrow(/ThrottlingException/);

      // Asserted as a SEQUENCE, not as `rejects.toThrow`: the danger here is a
      // readback that degrades to a guess and adopts. `src/utils/aws-region-resolver.ts`'s
      // `resolveBucketRegion` does exactly that (it never throws and returns a
      // fallback region), which is why this guard does not use it.
      expect(sentCommands()).toEqual(['CreateBucketCommand', 'GetBucketLocationCommand']);
    });
  });

  describe('classification and the untouched happy path', () => {
    it('marks the refusal NON-RETRYABLE, and its wording avoids the transient patterns', async () => {
      mockSend.mockRejectedValueOnce(ownedElsewhere('us-west-2'));

      const error = await provider
        .create('MyBucket', RESOURCE_TYPE, { BucketName: BUCKET })
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );

      expect(error).toBeDefined();
      // Without the marker `withRetry` re-runs the whole create for its full
      // budget before surfacing the same deterministic refusal.
      expect(isMarkedNonRetryable(error as Error)).toBe(true);
      // Belt and braces: `does not exist` is a literal member of
      // OTHER_TRANSIENT_ERROR_MESSAGE_PATTERNS, so a refusal containing it is
      // classified transient by WORDING even when the throw is marked.
      expect((error as Error).message).not.toContain('does not exist');
    });

    it('compares case-insensitively on the DEPLOY side, where a raw spelling can actually arrive', async () => {
      // `--region EU-WEST-1` reaches `getRegion()` unfolded. AWS never returns
      // an uppercase region, so the risk is on this side, not the response side.
      //
      // Spelled with eu-west-1 rather than us-east-1 for the reachability
      // reason recorded above: a us-east-1 client cannot receive this 409 for a
      // us-east-1 bucket. The unfolded-spelling risk is identical in either
      // region, and the us-east-1 spelling now decides something ELSE as well
      // (whether the issue #2241 pre-flight runs), which is fenced separately.
      clientRegion.value = 'EU-WEST-1';
      mockSend.mockRejectedValueOnce(ownedElsewhere('eu-west-1'));
      mockSend.mockResolvedValue({});

      await expect(
        provider.create('MyBucket', RESOURCE_TYPE, { BucketName: BUCKET })
      ).resolves.toMatchObject({ physicalId: BUCKET });
    });

    it('adds NO readback call when CreateBucket simply succeeds', async () => {
      // The guard must be free on the ordinary create path. Nothing else
      // asserts that, so an unconditional readback would go unnoticed.
      mockSend.mockResolvedValue({});

      await provider.create('MyBucket', RESOURCE_TYPE, {
        BucketName: BUCKET,
        VersioningConfiguration: { Status: 'Enabled' },
      });

      const names = sentCommands();
      expect(names[0]).toBe('CreateBucketCommand');
      expect(names).not.toContain('GetBucketLocationCommand');
      expect(names).not.toContain('HeadBucketCommand');
    });
  });
});
