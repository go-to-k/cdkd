import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, clientRegion, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' },
  // Split by LEVEL, not merged into one spy: the load-bearing claim about the
  // fail-open path is not "something was logged" but "it was logged where the
  // operator will see it". cdkd's default level is `info`, so a `debug` line is
  // invisible without `--verbose` -- a single spy cannot tell the two apart and
  // would go green on exactly the regression this asserts against.
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { NoSuchBucket } from '@aws-sdk/client-s3';
import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'my-globally-unique-bucket';

const sentCommands = (): string[] => mockSend.mock.calls.map((c) => c[0].constructor.name);

/**
 * A `GetBucketLocation` answer, built from the two legacy wire shapes
 * `GetBucketLocationOutput` documents: "Buckets in Region us-east-1 have a
 * LocationConstraint of null. Buckets with a LocationConstraint of EU reside in
 * eu-west-1" (`@aws-sdk/client-s3` `models_0.d.ts`).
 */
const location = (constraint: string | null): Record<string, unknown> => ({
  LocationConstraint: constraint,
});

/**
 * The 404 as the SDK really delivers it -- from BOTH operations.
 *
 * An earlier revision of this file claimed `GetBucketLocation` does not
 * deserialize its 404 into the modeled `NoSuchBucket` class "the way
 * `DeleteBucket`'s is", inferring that from its lone
 * `@throws {@link S3ServiceException}`. Measured 2026-08-26 against the real
 * client with canned 404 XML, both operations produce `ctor=NoSuchBucket`,
 * `name=NoSuchBucket`, `instanceof NoSuchBucket === true`, `status=404`:
 * `DeleteBucketCommand.d.ts` declares the same lone throw, and errors resolve
 * through a per-NAMESPACE schema registry rather than a per-operation one. One
 * fixture therefore serves both call sites, which is also what the production
 * predicate assumes.
 */
function realNoSuchBucket(): Error {
  return new NoSuchBucket({
    message: 'The specified bucket does not exist',
    $metadata: { httpStatusCode: 404 },
  });
}

/** A 403 -- a missing IAM grant and a hostile bucket-policy `Deny` are identical here. */
function accessDenied(): Error {
  const e = new Error('Access Denied');
  Object.assign(e, { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  return e;
}

/**
 * The `AccessDenied` as S3 really words it, caller identity and all.
 *
 * Copied from the shape S3 returns for a policy denial rather than shortened,
 * because the whole point of the assertions using it is WHICH substring reaches
 * the terminal: a fixture reading `Access Denied` cannot tell a warning that
 * prints the class from one that prints the message.
 */
function accessDeniedNamingTheCaller(): Error {
  const e = new Error(
    'User: arn:aws:sts::123456789012:assumed-role/deploy-role/cdkd-session is not authorized ' +
      'to perform: s3:GetBucketLocation on resource: "arn:aws:s3:::my-globally-unique-bucket"'
  );
  Object.assign(e, { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  return e;
}

/**
 * A 301 carrying the region but NO error code -- what a proxy, an
 * `AWS_ENDPOINT_URL` override or an S3-compatible gateway can produce, and what
 * real S3 never does (its redirect always names `PermanentRedirect`).
 */
function bareRedirectStatus(region: string): Error {
  const e = new Error('Moved Permanently');
  Object.assign(e, {
    name: 'S3ServiceException',
    $response: { headers: { 'x-amz-bucket-region': region } },
    $metadata: { httpStatusCode: 301 },
  });
  return e;
}

/**
 * A throttle as the SDK delivers it: the wire CODE on `name`, a retryable
 * status on `$metadata`.
 *
 * Spelled out rather than `new Error('ThrottlingException: slow down')`, whose
 * `name` is `Error`. That shape passed only while the warning interpolated the
 * MESSAGE; now that the class is what prints, it would render `(Error)` and
 * would pin the wrong string the moment a case asserted on it. Same
 * fixture-realism class as the `NoSuchBucket` correction earlier in this lane.
 */
function throttled(): Error {
  const e = new Error('Rate exceeded');
  Object.assign(e, { name: 'ThrottlingException', $metadata: { httpStatusCode: 503 } });
  return e;
}

/**
 * A 403 whose headers echo the region of the ENDPOINT that answered.
 *
 * This is what a bucket-policy `Deny` on `s3:GetBucketLocation` looks like, and
 * the header is real -- S3 attaches it broadly. It just does not describe the
 * BUCKET, so accepting it turns "I could not check" into "checked, and it
 * matches", which is silently the worst possible answer.
 */
function accessDeniedCarryingEndpointRegion(region: string): Error {
  const e = new Error('Access Denied');
  Object.assign(e, {
    name: 'AccessDenied',
    $response: { headers: { 'x-amz-bucket-region': region } },
    $metadata: { httpStatusCode: 403 },
  });
  return e;
}

/**
 * A FAILED probe that still names the bucket's region in its own headers.
 *
 * S3 attaches `x-amz-bucket-region` to the region-bearing failures (the 301
 * redirect, `AuthorizationHeaderMalformed`), measured on the 409 for issue
 * #2227 and read by the same `readBucketRegionHeader` helper.
 */
function redirectCarryingRegion(region: string): Error {
  const e = new Error('PermanentRedirect');
  Object.assign(e, {
    name: 'PermanentRedirect',
    $response: { headers: { 'x-amz-bucket-region': region } },
    $metadata: { httpStatusCode: 301 },
  });
  return e;
}

const UPDATE_PROPS = { BucketName: BUCKET, PublicAccessBlockConfiguration: { BlockPublicAcls: true } };

/**
 * Issue [#2245](https://github.com/go-to-k/cdkd/issues/2245).
 *
 * `assertExistingBucketRegion` (issue #2227) is on the CREATE path only, so it
 * stops NEW poisoning of a state record and does nothing about one already
 * written by a build that predates it. Two paths then act on such a record:
 *
 *  - `update()` had no region check at all, and applied the stack's bucket
 *    configuration to whatever `physicalId` the record named.
 *  - `delete()`'s `assertRegionMatch` fires only from the `NoSuchBucket`
 *    branch -- which a cross-region `DeleteBucket` never reaches, because SDK
 *    v3's region-redirect middleware FOLLOWS the 301 for body-bearing
 *    operations and the delete simply SUCCEEDS against the other region's
 *    bucket. That is the unrecoverable half.
 *
 * Both now refuse on a determinate mismatch. Every case asserts the COMMAND
 * SEQUENCE, because the load-bearing claim is that nothing was written to (or
 * emptied out of) the foreign bucket before the refusal, and a message-only
 * assertion is satisfied by any failure that happens to stop early.
 */
describe('S3BucketProvider state-record region guard (issue #2245)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    provider = new S3BucketProvider();
  });

  describe('update() refuses a recorded bucket that lives elsewhere', () => {
    it('stops BEFORE any configuration write', async () => {
      mockSend.mockResolvedValueOnce(location('us-west-2'));

      await expect(
        provider.update('MyBucket', BUCKET, RESOURCE_TYPE, UPDATE_PROPS, {})
      ).rejects.toThrow(/Refusing to update S3 bucket/);

      // The discriminator: the probe and nothing else.
      expect(sentCommands()).toEqual(['GetBucketLocationCommand']);
    });

    it('names both regions and the remedy, so the refusal is actionable', async () => {
      mockSend.mockResolvedValueOnce(location('us-west-2'));

      const error = await provider
        .update('MyBucket', BUCKET, RESOURCE_TYPE, UPDATE_PROPS, {})
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );

      expect(error?.message).toContain('the bucket lives in us-west-2');
      expect(error?.message).toContain("this stack's state is for us-east-1");
      expect(error?.message).toContain('cdkd state orphan');
    });

    it('marks the refusal NON-RETRYABLE, and is not re-labelled as an AWS failure', async () => {
      // Without the marker `withRetry` re-runs the whole update for its full
      // budget before surfacing the same deterministic refusal, which reads as
      // flaky AWS.
      //
      // The guard also sits AHEAD of the method's wrapping try, so the message
      // is not prefixed with `Failed to update S3 bucket <id>:` — a deliberate
      // cdkd refusal is not an AWS failure to re-label, and
      // `gen-update-wrap-coverage` flags a wrap that can capture a typed throw
      // with no `instanceof` pass-through.
      mockSend.mockResolvedValueOnce(location('us-west-2'));

      const error = await provider
        .update('MyBucket', BUCKET, RESOURCE_TYPE, UPDATE_PROPS, {})
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );

      expect(error).toBeDefined();
      expect(isMarkedNonRetryable(error as Error)).toBe(true);
      expect((error as Error).message).not.toContain('Failed to update S3 bucket');
      expect((error as Error).message).toMatch(/^Refusing to update S3 bucket/);
      // `does not exist` is a literal member of
      // OTHER_TRANSIENT_ERROR_MESSAGE_PATTERNS, so a refusal containing it is
      // classified transient by WORDING even when the throw is marked.
      expect((error as Error).message).not.toContain('does not exist');
    });
  });

  describe('update() leaves the legitimate paths alone', () => {
    // Without these the guard could be "refuse every update", which satisfies
    // every case above while breaking every ordinary deploy.
    it('applies configuration normally when the bucket is in THIS region', async () => {
      mockSend.mockResolvedValueOnce(location(null));
      mockSend.mockResolvedValue({});

      const result = await provider.update('MyBucket', BUCKET, RESOURCE_TYPE, UPDATE_PROPS, {});

      expect(result).toMatchObject({ physicalId: BUCKET, wasReplaced: false });
      expect(sentCommands()).toContain('PutPublicAccessBlockCommand');
    });

    it("folds the legacy 'EU' alias rather than refusing on it", async () => {
      clientRegion.value = 'eu-west-1';
      mockSend.mockResolvedValueOnce(location('EU'));
      mockSend.mockResolvedValue({});

      await expect(
        provider.update('MyBucket', BUCKET, RESOURCE_TYPE, UPDATE_PROPS, {})
      ).resolves.toMatchObject({ physicalId: BUCKET });
    });

    it('compares case-insensitively on the DEPLOY side, where a raw spelling can arrive', async () => {
      // `--region EU-WEST-1` reaches `getRegion()` unfolded. AWS never returns
      // an uppercase region, so the risk is on this side.
      clientRegion.value = 'EU-WEST-1';
      mockSend.mockResolvedValueOnce(location('eu-west-1'));
      mockSend.mockResolvedValue({});

      await expect(
        provider.update('MyBucket', BUCKET, RESOURCE_TYPE, UPDATE_PROPS, {})
      ).resolves.toMatchObject({ physicalId: BUCKET });
    });

    it('PROCEEDS when the probe says the bucket does not exist', async () => {
      // Absence is not a region mismatch. The configuration calls that follow
      // fail against AWS on their own terms, which is a better error than a
      // refusal claiming the bucket is somewhere it is not.
      mockSend.mockRejectedValueOnce(realNoSuchBucket());
      mockSend.mockResolvedValue({});

      await expect(
        provider.update('MyBucket', BUCKET, RESOURCE_TYPE, UPDATE_PROPS, {})
      ).resolves.toMatchObject({ physicalId: BUCKET });
      expect(sentCommands()).toContain('PutPublicAccessBlockCommand');
    });

    it('PROCEEDS when the probe could not answer at all', async () => {
      // An IAM policy granting the writes but not `s3:GetBucketLocation`, or a
      // throttle. Failing closed here would refuse updates for a population
      // that has nothing to do with this defect; the defect itself needs a
      // bucket that exists and is owned by this account, for which the probe
      // does answer.
      mockSend.mockRejectedValueOnce(throttled());
      mockSend.mockResolvedValue({});

      await expect(
        provider.update('MyBucket', BUCKET, RESOURCE_TYPE, UPDATE_PROPS, {})
      ).resolves.toMatchObject({ physicalId: BUCKET });
    });

    it('does not probe at all when the update is a REPLACEMENT', async () => {
      // A renamed bucket short-circuits before any AWS call. The probe must not
      // move ahead of that: there is nothing to identify yet.
      const result = await provider.update(
        'MyBucket',
        BUCKET,
        RESOURCE_TYPE,
        { BucketName: 'a-different-name' },
        {}
      );

      expect(result).toMatchObject({ wasReplaced: true });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('a failed probe that still names the region is an ANSWER, not a shrug', () => {
    // `readBucketRegionHeader` already answers this question and
    // `resolveOwnedBucketRegion` already prefers it, so treating every probe
    // REJECTION as `indeterminate` threw away a region that was sitting in the
    // response -- and the region-bearing failures (the 301 redirect,
    // `AuthorizationHeaderMalformed`) are exactly the ones a cross-region
    // physical id produces.
    it('REFUSES a delete when the probe FAILED but its headers name another region', async () => {
      mockSend.mockRejectedValueOnce(redirectCarryingRegion('us-west-2'));

      await expect(
        provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).rejects.toThrow(/Refusing to delete S3 bucket/);

      expect(sentCommands()).toEqual(['GetBucketLocationCommand']);
      // It is a determinate answer, so it must NOT also announce a fail-open.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('PROCEEDS when those headers name THIS region', async () => {
      mockSend.mockRejectedValueOnce(redirectCarryingRegion('us-east-1'));
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(sentCommands()).toEqual(['GetBucketLocationCommand', 'DeleteBucketCommand']);
      // The discriminating line. The command SEQUENCE here is identical to the
      // `indeterminate` path's, so without this the case passes whether or not
      // the header was read at all -- measured: deleting the header read left
      // it green. Silence is what says the guard actually ANSWERED.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT read a 403 header as the bucket region, so the fail-open WARNS', async () => {
      // The regression this gate exists for, and it was introduced by the fix
      // that added the header read. A 403 is answered by the endpoint that was
      // ASKED, so its `x-amz-bucket-region` echoes the deploy's own region --
      // reading it made `probe.region === wantRegion`, the guard returned
      // SILENTLY, and the warning written for exactly this population never
      // fired. That is the hostile bucket-policy `Deny` case: one line of
      // bucket policy would have turned the guard off without a trace.
      mockSend.mockRejectedValueOnce(accessDeniedCarryingEndpointRegion('us-east-1'));
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('did NOT run');
    });

    it('does NOT read a 403 header as a MISMATCH either -- it is not evidence at all', async () => {
      // The other polarity, and the reason the fix is a shape gate rather than
      // "ignore the header when it matches". A 403 from a foreign-region
      // endpoint would otherwise produce a confident REFUSAL built on a header
      // that never described the bucket.
      mockSend.mockRejectedValueOnce(accessDeniedCarryingEndpointRegion('us-west-2'));
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(sentCommands()).toEqual(['GetBucketLocationCommand', 'DeleteBucketCommand']);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('does NOT accept a bare 301 STATUS as evidence -- only the wire CODE counts', async () => {
      // The same defect as the 403 arm above, arriving through the status
      // instead of the header, and the same one `isNoSuchBucketError` was
      // narrowed to close: a status S3 never NAMED is not S3 speaking. A proxy
      // or S3-compatible gateway answering 301 with the deploy's own region
      // would otherwise compare EQUAL and the guard would return silently.
      mockSend.mockRejectedValueOnce(bareRedirectStatus('us-east-1'));
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('did NOT run');
    });

    it('lets ABSENCE win over a header describing the endpoint that was asked', async () => {
      // Ordering fence. A 404 is answered by the endpoint the question went to,
      // so its `x-amz-bucket-region` can describe THAT endpoint rather than any
      // bucket. Reading the header before the absence check would turn every
      // already-gone destroy in a foreign-region client into a refusal.
      const gone = realNoSuchBucket();
      Object.assign(gone, { $response: { headers: { 'x-amz-bucket-region': 'us-west-2' } } });
      mockSend.mockRejectedValueOnce(gone);
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(sentCommands()).toEqual(['GetBucketLocationCommand', 'DeleteBucketCommand']);
    });
  });

  describe('delete() refuses a recorded bucket that lives elsewhere', () => {
    it('stops BEFORE the DeleteBucket that the redirect middleware would have completed', async () => {
      mockSend.mockResolvedValueOnce(location('us-west-2'));

      await expect(
        provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).rejects.toThrow(/Refusing to delete S3 bucket/);

      expect(sentCommands()).toEqual(['GetBucketLocationCommand']);
    });

    it('does not EMPTY the foreign bucket either, even with the auto-delete opt-in', async () => {
      // The order matters as much as the refusal: emptying destroys the data
      // whether or not the `DeleteBucket` that follows succeeds, so the guard
      // has to sit ahead of the auto-empty rather than beside the delete.
      mockSend.mockResolvedValueOnce(location('us-west-2'));

      await expect(
        provider.delete(
          'MyBucket',
          BUCKET,
          RESOURCE_TYPE,
          { Tags: [{ Key: 'aws-cdk:auto-delete-objects', Value: 'true' }] },
          { expectedRegion: 'us-east-1' }
        )
      ).rejects.toThrow(/Refusing to delete S3 bucket/);

      const names = sentCommands();
      expect(names).not.toContain('ListObjectVersionsCommand');
      expect(names).not.toContain('DeleteObjectsCommand');
      expect(names).not.toContain('DeleteBucketCommand');
    });

    it('marks the refusal NON-RETRYABLE and says the deletion cannot be undone', async () => {
      mockSend.mockResolvedValueOnce(location('us-west-2'));

      const error = await provider
        .delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, { expectedRegion: 'us-east-1' })
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );

      expect(error).toBeDefined();
      expect(isMarkedNonRetryable(error as Error)).toBe(true);
      expect((error as Error).message).toContain('cannot be undone');
      expect((error as Error).message).not.toContain('does not exist');
    });

    it('gives the DELETE branch its own remedy, not the update one', async () => {
      // cdkd's state is region-KEYED (`cdkd/{stack}/{region}/state.json`), so
      // the update remedy -- "rerun this stack against <the bucket's region>"
      // -- is actively wrong here twice over: that run finds no record of this
      // stack, and if one somehow existed it would be advice to go and destroy
      // the very bucket this guard just refused to touch.
      mockSend.mockResolvedValueOnce(location('us-west-2'));

      const error = await provider
        .delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, { expectedRegion: 'us-east-1' })
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );

      expect(error?.message).not.toContain('rerun this stack against');
      expect(error?.message).toContain('cdkd state orphan');
      expect(error?.message).toContain('delete it deliberately in us-west-2');
    });
  });

  describe('a delete that proceeds unverified says so where the operator sees it', () => {
    // The blocker three reviewers converged on. Both `absent` and
    // `indeterminate` proceed by design (refusing would strand destroys for any
    // least-privilege role, with no per-resource override to force one
    // through), so the guard's remaining obligation on the irreversible path is
    // that failing open is never SILENT. It was: the degrade logged at `debug`,
    // cdkd's default level is `info`, and deleting `logger.debug` outright
    // reddened 0 of 758 cases.
    //
    // Not a hypothetical misconfiguration either. `GetBucketLocation` is
    // deniable on the target bucket by anyone holding `s3:PutBucketPolicy` on
    // it, and a `Deny` is indistinguishable on the wire from a missing grant --
    // so a poisoned record plus a one-line bucket policy turns this guard off
    // and the destroy's output looks exactly like a healthy one.
    it('WARNS -- not debug -- when the identity check could not run', async () => {
      mockSend.mockRejectedValueOnce(accessDenied());
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      // The level IS the assertion: a debug line here is invisible without
      // `--verbose`, which is the whole defect.
      expect(warnSpy).toHaveBeenCalled();
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('GetBucketLocation');
      expect(warned).toContain('did NOT run');
      expect(warned).toContain(BUCKET);
    });

    it('names the consequence and both ways out, so the warning is actionable', async () => {
      mockSend.mockRejectedValueOnce(accessDenied());
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('delete THAT bucket');
      expect(warned).toContain('Re-run the destroy');
      // Naming the bucket-policy Deny matters: an operator who checks only IAM
      // concludes the grant is present and stops looking.
      expect(warned).toContain('s3:GetBucketLocation');
      expect(warned).toContain('bucket policy can Deny it');
    });

    it('carries the error class, so a throttle is distinguishable from a denial', async () => {
      // The class has to be enough to tell the two apart, since the message no
      // longer reaches this line. It is -- but only against a REALISTIC
      // fixture: an earlier revision threw `new Error('ThrottlingException:
      // slow down')`, whose `name` is `Error`, and it passed only because the
      // warning was interpolating the message. The SDK puts the code on `name`.
      mockSend.mockRejectedValueOnce(throttled());
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('ThrottlingException');
      expect(warned).not.toContain('AccessDenied');
    });

    it('names the error CLASS at default verbosity, never AWS s caller identity', async () => {
      // The fix that made this guard visible made the CALLER visible too. On
      // the headline population -- a bucket policy denying
      // `s3:GetBucketLocation` -- AWS's message carries the account id, the
      // role name and the session name, and this line prints at default level
      // to the terminal and to CI logs. Same answer
      // `dynamodb-index-busy-delete.ts` already reached: class at warn, AWS's
      // own text at debug.
      mockSend.mockRejectedValueOnce(accessDeniedNamingTheCaller());
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('AccessDenied');
      expect(warned).not.toContain('assumed-role');
      expect(warned).not.toContain('123456789012');
      expect(warned).not.toContain('cdkd-session');
      // Losing the detail is only acceptable because it is still reachable.
      expect(warned).toContain('--verbose');
    });

    it('keeps AWS s own message, at debug', async () => {
      // The other half: redaction that DISCARDS the message would trade one
      // defect for another, since the message is what tells an operator whether
      // the denial is IAM or a bucket policy.
      mockSend.mockRejectedValueOnce(accessDeniedNamingTheCaller());
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(debugSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('assumed-role');
    });

    it('stays QUIET on the ordinary verified destroy', async () => {
      // The over-tightening fence. A guard that warned on every destroy would
      // satisfy every case above while training the operator to ignore the one
      // line that matters.
      mockSend.mockResolvedValueOnce(location(null));
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('keeps the UPDATE degrade at debug, where the failure is recoverable', async () => {
      // The asymmetry is deliberate and is asserted, not assumed: a misapplied
      // bucket configuration can be re-applied, so it does not earn the same
      // channel as an irreversible delete. Without this case, "warn on delete"
      // and "warn on everything" are indistinguishable.
      mockSend.mockRejectedValueOnce(accessDenied());
      mockSend.mockResolvedValue({});

      await provider.update('MyBucket', BUCKET, RESOURCE_TYPE, UPDATE_PROPS, {});

      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('did NOT run');
    });
  });

  describe('delete() leaves the legitimate destroys alone', () => {
    // A refusal that stranded every destroy would be worse than the bug it
    // guards, so each ordinary shape gets its own case.
    it('deletes normally when the bucket is in the recorded region', async () => {
      mockSend.mockResolvedValueOnce(location(null));
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(sentCommands()).toEqual(['GetBucketLocationCommand', 'DeleteBucketCommand']);
    });

    it('does not probe when the state record carries no region, but SAYS SO', async () => {
      // The back-compat rule `assertRegionMatch` already states: with no
      // recorded region there is no expectation to check against, so a pre-v2
      // record keeps its previous behavior instead of paying a round trip for a
      // comparison it cannot make.
      //
      // What it must NOT keep is the silence. This is the fifth way the guard
      // can fail to run and the quietest -- no probe, no refusal, and until now
      // no line of output either -- while being the cohort MOST likely to
      // predate the issue #2227 create-path guard, i.e. the likeliest carrier
      // of a foreign-region physical id.
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {});

      expect(sentCommands()).toEqual(['DeleteBucketCommand']);
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('did NOT run');
      expect(warned).toContain('carries no region');
      expect(warned).toContain('delete THAT bucket');
    });

    it('points a no-region record at the fix that applies to IT, not at IAM', async () => {
      // A cause-specific remedy, because the probe-failure one is wrong here:
      // nothing is missing from the caller's IAM, so "grant
      // s3:GetBucketLocation" sends the operator to fix something that is not
      // broken. What makes the guard run for this record is a re-deploy that
      // writes a region into it.
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {});

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('Re-deploy the stack');
      expect(warned).not.toContain('grant s3:GetBucketLocation');
    });

    it('does not probe when no delete context is supplied, and SAYS SO', async () => {
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE);

      expect(sentCommands()).toEqual(['DeleteBucketCommand']);
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('carries no region');
    });

    it('keeps the already-gone destroy idempotent', async () => {
      // The commonest non-happy destroy: the bucket is already deleted. The
      // probe 404s, the delete 404s, and `assertRegionMatch` accepts it because
      // the client region matches the recorded one -- exactly as before.
      mockSend.mockRejectedValueOnce(realNoSuchBucket());
      mockSend.mockRejectedValueOnce(realNoSuchBucket());

      await expect(
        provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).resolves.toBeUndefined();

      expect(sentCommands()).toEqual(['GetBucketLocationCommand', 'DeleteBucketCommand']);
    });

    it('PROCEEDS when the probe could not answer at all', async () => {
      mockSend.mockRejectedValueOnce(throttled());
      mockSend.mockResolvedValue({});

      await provider.delete('MyBucket', BUCKET, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(sentCommands()).toEqual(['GetBucketLocationCommand', 'DeleteBucketCommand']);
    });

    it('still empties and deletes a non-empty in-region bucket that opted in', async () => {
      // The guard must not sit between the auto-empty retry and its delete.
      let emptied = false;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'GetBucketLocationCommand':
            return Promise.resolve(location(null));
          case 'DeleteBucketCommand':
            if (emptied) return Promise.resolve({});
            return Promise.reject(new Error('The bucket you tried to delete is not empty'));
          case 'ListObjectVersionsCommand':
            return Promise.resolve({ Versions: [{ Key: 'doc.txt', VersionId: 'v1' }] });
          case 'DeleteObjectsCommand':
            emptied = true;
            return Promise.resolve({});
          default:
            return Promise.resolve({});
        }
      });

      await provider.delete(
        'MyBucket',
        BUCKET,
        RESOURCE_TYPE,
        { Tags: [{ Key: 'aws-cdk:auto-delete-objects', Value: 'true' }] },
        { expectedRegion: 'us-east-1' }
      );

      expect(sentCommands()).toEqual([
        'GetBucketLocationCommand',
        'DeleteBucketCommand',
        'ListObjectVersionsCommand',
        'DeleteObjectsCommand',
        'DeleteBucketCommand',
      ]);
    });
  });
});
