import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NoSuchBucket } from '@aws-sdk/client-s3';

const { mockSend, clientRegion, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' },
  // Split by LEVEL. cdkd's default is `info`, so "was it logged" and "will the
  // operator see it" are different questions, and the create path's cleanup
  // warnings are answers to the second one.
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

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'my-globally-unique-bucket';

const sentCommands = (): string[] => mockSend.mock.calls.map((c) => c[0].constructor.name);

/**
 * The 404 as the SDK actually delivers it -- MEASURED, not inferred.
 *
 * An earlier revision of this file used a hand-built plain `Error` here, on the
 * reasoning that `GetBucketLocationCommand` declares only
 * `@throws {@link S3ServiceException}` and therefore could not be producing the
 * modeled class. That reasoning was checked on 2026-08-26 by pushing canned 404
 * XML through the real client and is WRONG: `GetBucketLocation` and
 * `DeleteBucket` both yield `ctor=NoSuchBucket`, `name=NoSuchBucket`,
 * `instanceof NoSuchBucket === true`, `status=404`. `DeleteBucketCommand.d.ts`
 * declares the same lone `S3ServiceException`, and errors resolve through a
 * per-NAMESPACE schema registry rather than the command's throw list.
 *
 * So the default fixture is the modeled class, and the hand-built variants
 * below exist only to fence individual arms of the predicate. This file's
 * sibling (`s3-bucket-provider-already-owned-region.test.ts`) records what a
 * fixture built on an inferred wire shape already cost this provider once.
 */
function realNoSuchBucket(): Error {
  return new NoSuchBucket({ message: 'The specified bucket does not exist', $metadata: { httpStatusCode: 404 } });
}

/**
 * The `AccessDenied` as S3 really words it, caller identity and all.
 *
 * Not shortened, because the assertions using it turn on WHICH substring
 * reaches the terminal: a fixture reading `Access Denied` cannot tell a warning
 * that prints the class from one that prints the message.
 */
function accessDeniedNamingTheCaller(): Error {
  const e = new Error(
    'User: arn:aws:sts::123456789012:assumed-role/deploy-role/cdkd-session is not authorized ' +
      'to perform: s3:GetBucketLocation on resource: "arn:aws:s3:::my-globally-unique-bucket"'
  );
  Object.assign(e, { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  return e;
}

/** A 403: the name is taken by ANOTHER account, or this role cannot ask. */
function accessDenied(): Error {
  const e = new Error('Access Denied');
  Object.assign(e, { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  return e;
}

/** The `BucketAlreadyOwnedByYou` 409, optionally carrying the region header. */
function ownedElsewhere(region?: string): Error {
  const e = new Error('you already own it');
  e.name = 'BucketAlreadyOwnedByYou';
  Object.assign(e, {
    $metadata: { httpStatusCode: 409 },
    ...(region ? { $response: { headers: { 'x-amz-bucket-region': region } } } : {}),
  });
  return e;
}

const CREATE_PROPS = {
  BucketName: BUCKET,
  VersioningConfiguration: { Status: 'Enabled' },
};

/**
 * Issue [#2241](https://github.com/go-to-k/cdkd/issues/2241).
 *
 * The partial-create cleanup added by issue #376 is gated on
 * `createdNewBucket`, so that a sub-config failure never deletes a bucket that
 * pre-dated the deploy. The gate reads a 200 from `CreateBucket` as proof that
 * this call created the bucket -- and that holds in every region but one.
 *
 * `@aws-sdk/client-s3` `dist-types/models/errors.d.ts`, on
 * `BucketAlreadyOwnedByYou`: "The bucket you tried to create already exists,
 * and you own it. Amazon S3 returns this error in all Amazon Web Services
 * Regions except in the North Virginia Region. For legacy compatibility, if you
 * re-create an existing bucket that you already own in the North Virginia
 * Region, Amazon S3 returns 200 OK and resets the bucket access control lists
 * (ACLs)."
 *
 * So in `us-east-1` the adopt never enters the catch, `createdNewBucket` is set
 * for a bucket the deploy did not create, and a later sub-config failure fires
 * `DeleteBucket` at a PRE-EXISTING user bucket. `DeleteBucket` refuses a
 * non-empty bucket, so a bucket holding objects survives -- an EMPTY one does
 * not. The default bucket name is `{stackName}-{logicalId}`
 * (`generateResourceName`) with no region or account in it, so the name
 * collision that reaches this is not exotic.
 *
 * The fix is a pre-flight `GetBucketLocation` issued ONLY when the target
 * region is us-east-1, and every case here asserts the COMMAND SEQUENCE rather
 * than only an outcome: the two claims are "the destructive branch did not run"
 * and "the round trip is not spent anywhere else", and neither survives an
 * outcome-only assertion.
 */
describe('S3BucketProvider us-east-1 create pre-flight (issue #2241)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    provider = new S3BucketProvider();
  });

  describe('the bucket was already there: the legacy 200 must not license a delete', () => {
    it('does NOT delete a PRE-EXISTING us-east-1 bucket when a sub-config call then fails', async () => {
      mockSend.mockResolvedValueOnce({}); // pre-flight GetBucketLocation: it exists, in us-east-1
      mockSend.mockResolvedValueOnce({}); // CreateBucket: the legacy 200 over that same bucket
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        'Failed to create S3 bucket'
      );

      const names = sentCommands();
      expect(names).not.toContain('DeleteBucketCommand');
      // Proves the run REACHED configuration, so the assertion above is about
      // the cleanup gate rather than about an early exit -- the vacuous pass
      // this file's sibling records having nearly shipped.
      expect(names).toEqual([
        'GetBucketLocationCommand',
        'CreateBucketCommand',
        'PutBucketVersioningCommand',
      ]);
    });

    it('warns that the bucket was ADOPTED and that its ACLs were reset', async () => {
      // The second, smaller effect of the same legacy 200, quoted in the SDK
      // doc above: it "resets the bucket access control lists". A deploy that
      // SUCCEEDS gives the user no other signal that this happened.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValue({});

      await provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS);

      const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(message).toContain('already existed in us-east-1 and was ADOPTED, not created');
      expect(message).toContain('access control lists');
      expect(message).toContain(BUCKET);
    });

    // The three spellings S3 uses for "this bucket is in us-east-1". ABSENT
    // MEANS us-east-1, never "unknown": `GetBucketLocationOutput` documents
    // "Buckets in Region us-east-1 have a LocationConstraint of null"
    // (`models_0.d.ts`). This is the ADOPT side of the fold that
    // `s3-bucket-provider-already-owned-region.test.ts` fences from the refusing
    // side; it lives here because the reachable us-east-1 path to it is this
    // pre-flight, not that file's 409.
    for (const [label, response] of [
      ['an absent field', {}],
      ['an empty string', { LocationConstraint: '' }],
      ['an explicit null', { LocationConstraint: null }],
    ] as const) {
      it(`reads ${label} as "already in us-east-1" and withholds the cleanup`, async () => {
        mockSend.mockResolvedValueOnce(response);
        mockSend.mockResolvedValueOnce({});
        mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));

        await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
          'Failed to create S3 bucket'
        );

        expect(sentCommands()).not.toContain('DeleteBucketCommand');
      });
    }
  });

  describe('the bucket was NOT there: issue #376 self-heal still works in us-east-1', () => {
    // Without these the fix could be "never clean up in us-east-1", which
    // satisfies every case above while silently retiring the self-heal and
    // leaving an orphan bucket that fails the NEXT deploy.
    it('DOES delete the bucket it just created when a sub-config call fails', async () => {
      mockSend.mockRejectedValueOnce(realNoSuchBucket()); // pre-flight: the name is free
      mockSend.mockResolvedValueOnce({}); // CreateBucket really creates
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));
      mockSend.mockResolvedValueOnce({}); // DeleteBucket cleanup

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        'Failed to create S3 bucket'
      );

      expect(sentCommands()).toEqual([
        'GetBucketLocationCommand',
        'CreateBucketCommand',
        'PutBucketVersioningCommand',
        'DeleteBucketCommand',
      ]);
      const deleteCall = mockSend.mock.calls.find(
        (c) => c[0].constructor.name === 'DeleteBucketCommand'
      );
      expect(deleteCall?.[0].input).toEqual({ Bucket: BUCKET });
    });

    // Absence is decided by the wire error CODE, which the SDK lifts onto
    // `name`. Two deliveries of that code, fenced separately because which one
    // arrives is an SDK detail: the modeled class (what the client actually
    // produces today, measured) and a bare object carrying only the code (what
    // a future deserializer change, or a caller that did not go through this
    // command, could hand over).
    for (const [label, build] of [
      ['the modeled NoSuchBucket class the client really produces', realNoSuchBucket],
      [
        'a bare error carrying only the wire CODE',
        () =>
          Object.assign(new Error('The specified bucket does not exist'), {
            name: 'NoSuchBucket',
          }),
      ],
    ] as const) {
      it(`reads ${label} as absence, so the self-heal still runs`, async () => {
        mockSend.mockRejectedValueOnce(build());
        mockSend.mockResolvedValueOnce({});
        mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));
        mockSend.mockResolvedValueOnce({});

        await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
          'Failed to create S3 bucket'
        );

        expect(sentCommands()).toContain('DeleteBucketCommand');
      });
    }

    it('does NOT read a bare HTTP 404 as absence, so a non-S3 404 cannot license the delete', async () => {
      // The predicate is deliberately narrower than "the resource is missing".
      // On THIS path `absent` is the answer that ENABLES a `DeleteBucket`, so a
      // 404 from a corporate proxy, an `AWS_ENDPOINT_URL` override or an
      // S3-compatible gateway must not authorize one on the strength of a
      // response S3 never sent. The cost of narrowing is only that such a 404
      // becomes `indeterminate` -- the non-destructive branch.
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('404 Not Found'), {
          name: 'S3ServiceException',
          $metadata: { httpStatusCode: 404 },
        })
      );
      mockSend.mockResolvedValueOnce({});
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        'Failed to create S3 bucket'
      );

      expect(sentCommands()).not.toContain('DeleteBucketCommand');
    });

    it('creates normally, with ONE probe and no warning, when nothing fails', async () => {
      mockSend.mockRejectedValueOnce(realNoSuchBucket());
      mockSend.mockResolvedValue({});

      const result = await provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS);

      expect(result.physicalId).toBe(BUCKET);
      const names = sentCommands();
      expect(names.filter((n) => n === 'GetBucketLocationCommand')).toHaveLength(1);
      expect(names).not.toContain('DeleteBucketCommand');
      expect(names).toContain('PutBucketVersioningCommand');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('an unanswered probe withholds the delete rather than guessing', () => {
    it('does NOT clean up when the probe failed for a reason other than absence', async () => {
      // A throttle, a network fault, or a 403 from a bucket held by another
      // account all land here. Treating any of them as "absent" would restore
      // exactly the delete this issue is about, so the probe's two failure
      // shapes are kept distinct.
      mockSend.mockRejectedValueOnce(accessDenied());
      mockSend.mockResolvedValueOnce({});
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        'Failed to create S3 bucket'
      );

      expect(sentCommands()).not.toContain('DeleteBucketCommand');
    });

    it('names the manual cleanup, so the orphan it declines to delete is recoverable', async () => {
      mockSend.mockRejectedValueOnce(accessDenied());
      mockSend.mockResolvedValueOnce({});
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        'Failed to create S3 bucket'
      );

      const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(message).toContain('Not cleaning up S3 bucket');
      expect(message).toContain(`aws s3api delete-bucket --bucket '${BUCKET}'`);
    });
  });

  describe('interaction with the issue #2227 adopt guard, in us-east-1', () => {
    // Restores coverage the eu-west-1 flip in
    // `s3-bucket-provider-already-owned-region.test.ts` removed. Retiring the
    // IMPOSSIBLE combination there (a us-east-1 client receiving a 409 for a
    // bucket the readback places in us-east-1) was right, but it also moved
    // this REACHABLE one: the SDK's legacy-200 exception covers re-creating a
    // bucket you own IN N. Virginia, so a us-east-1 client DOES receive
    // `BucketAlreadyOwnedByYou` for a bucket of yours in another region. That
    // is exactly where issues #2241 and #2227 meet, and after the flip nothing
    // covered it.
    it('REFUSES a foreign-region owned bucket, with the 409 header answering', async () => {
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'us-west-2' }); // pre-flight
      mockSend.mockRejectedValueOnce(ownedElsewhere('us-west-2')); // CreateBucket 409

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        /Refusing to adopt existing S3 bucket/
      );

      // The header answers, so the #2227 readback costs no second lookup: the
      // pre-flight is the ONLY GetBucketLocation, and nothing was configured.
      expect(sentCommands()).toEqual(['GetBucketLocationCommand', 'CreateBucketCommand']);
    });

    it('costs TWO location lookups when the 409 carries no region header', async () => {
      // The accepted cost of the two guards being independent: the pre-flight
      // resolves the region, the 409 arrives headerless, and
      // `resolveOwnedBucketRegion` asks again. Asserted rather than left
      // implicit so the count is a decision on record -- and so that collapsing
      // the two into one lookup later shows up here as a deliberate change
      // rather than as an unexplained diff.
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'us-west-2' }); // pre-flight
      mockSend.mockRejectedValueOnce(ownedElsewhere()); // CreateBucket 409, no header
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'us-west-2' }); // #2227 readback

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        /lives in us-west-2, while this stack deploys to us-east-1/
      );

      expect(sentCommands()).toEqual([
        'GetBucketLocationCommand',
        'CreateBucketCommand',
        'GetBucketLocationCommand',
      ]);
    });

    it('REFUSES rather than warns if a 200 ever arrives over a foreign-region bucket', async () => {
      // A fail-CLOSED floor under a documented impossibility, and labelled as
      // one: the legacy 200 is scoped to a bucket you own IN N. Virginia, and
      // the case above measures that a cross-region owned bucket answers 409
      // instead -- so this combination is not producible against real AWS
      // today. It is fenced anyway because the branch it guards is the only
      // thing standing between a documentation change and cdkd silently
      // applying this stack's whole configuration to another region's bucket,
      // and because the alternative there was a warning whose own text
      // contradicted the region it named.
      mockSend.mockResolvedValueOnce({ LocationConstraint: 'us-west-2' }); // pre-flight
      mockSend.mockResolvedValueOnce({}); // CreateBucket answers 200 anyway

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        /Refusing to adopt existing S3 bucket/
      );

      // Stopped before configuring, and the refusal is the SAME one the 409
      // path raises rather than a second spelling of it.
      expect(sentCommands()).toEqual(['GetBucketLocationCommand', 'CreateBucketCommand']);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('the create catch cannot claim a cdkd refusal', () => {
    // SOURCE-level, and deliberately so: no INPUT can discriminate this today.
    // The classifier matches `name === 'BucketAlreadyOwnedByYou'` or
    // `message.includes('you already own it')`, and the foreign-region refusal
    // raised inside the same `try` satisfies neither -- so with or without the
    // pass-through the refusal propagates and every behavioural case is green.
    // What the pass-through defends against is a future REWORD of that refusal
    // bringing it inside the classifier's substring match, at which point the
    // catch would swallow it into the "already owned" arm and configure the
    // foreign bucket: the issue #2227 outcome, reintroduced by a copy-edit.
    // A fence that a mutation can only reach through the English of an error
    // message has to read the code, not run it.
    it('re-throws a ProvisioningError before classifying, as the catch of last resort', async () => {
      const { readFileSync } = await import('node:fs');
      const src = readFileSync(
        new URL('../../../src/provisioning/providers/s3-bucket-provider.ts', import.meta.url),
        'utf-8'
      );

      const catchIdx = src.indexOf('} catch (createError) {');
      expect(catchIdx, 'the create-path catch this fence is about no longer exists').toBeGreaterThan(
        -1
      );
      const passThrough = src.indexOf(
        'if (createError instanceof ProvisioningError) throw createError;',
        catchIdx
      );
      const classifier = src.indexOf("createError.name === 'BucketAlreadyOwnedByYou'", catchIdx);

      expect(passThrough, 'the typed pass-through is missing from the create catch').toBeGreaterThan(
        -1
      );
      // ORDER is the assertion, not mere presence: a pass-through placed after
      // the classifier protects nothing.
      expect(passThrough).toBeLessThan(classifier);
    });
  });

  describe('the create-path warnings name the error class, not the caller', () => {
    // The create path reads the SAME `probeBucketRegion` failure the
    // update/delete guard reports, so it had the same leak -- and it kept it
    // after the guard's copy was fixed, because the fix was found by reading a
    // diff instead of by grepping every reader of `reason`. On the headline
    // cohort (a bucket policy denying `s3:GetBucketLocation`) AWS's text names
    // the account, the role and the session, and this line prints at default
    // verbosity to the terminal and to CI logs.
    it('does NOT print the caller identity when it declines to clean up', async () => {
      mockSend.mockRejectedValueOnce(accessDeniedNamingTheCaller()); // pre-flight
      mockSend.mockResolvedValueOnce({}); // CreateBucket
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        'Failed to create S3 bucket'
      );

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('Not cleaning up S3 bucket');
      expect(warned).toContain('AccessDenied');
      expect(warned).not.toContain('assumed-role');
      expect(warned).not.toContain('123456789012');
      expect(warned).not.toContain('cdkd-session');
      expect(warned).toContain('--verbose');
    });

    it('keeps AWS s own message for that arm, at debug', async () => {
      // Redaction that DISCARDED the message would trade one defect for
      // another: it is what tells the operator whether the probe was denied by
      // IAM or by a bucket policy.
      mockSend.mockRejectedValueOnce(accessDeniedNamingTheCaller());
      mockSend.mockResolvedValueOnce({});
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        'Failed to create S3 bucket'
      );

      expect(debugSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('assumed-role');
    });

    it('does NOT print the caller identity when the cleanup DELETE itself fails', async () => {
      // The sibling arm of the same `catch`, and the one that made this a
      // half-fix twice over: it predates the rule (issue #376) and interpolated
      // a `DeleteBucket` failure, whose `AccessDenied` names the caller in
      // exactly the same shape.
      mockSend.mockRejectedValueOnce(realNoSuchBucket()); // pre-flight: name is free
      mockSend.mockResolvedValueOnce({}); // CreateBucket really creates
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));
      const denied = new Error(
        'User: arn:aws:sts::123456789012:assumed-role/deploy-role/cdkd-session is not authorized ' +
          'to perform: s3:DeleteBucket on resource: "arn:aws:s3:::my-globally-unique-bucket"'
      );
      Object.assign(denied, { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      mockSend.mockRejectedValueOnce(denied); // DeleteBucket cleanup

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        'applyConfiguration boom'
      );

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('Failed to clean up partially-created S3 bucket');
      expect(warned).toContain('AccessDenied');
      expect(warned).not.toContain('assumed-role');
      expect(warned).toContain('--verbose');
      // Still recoverable: the manual command survives the redaction.
      expect(warned).toContain(`aws s3api delete-bucket --bucket '${BUCKET}'`);
      expect(debugSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('assumed-role');
    });
  });

  describe('the probe is charged to us-east-1 only', () => {
    it('issues NO pre-flight call in another region, where the 200 already proves the create', async () => {
      // The cost fence. Every other region answers a re-create of an owned
      // bucket with `BucketAlreadyOwnedByYou`, so the probe would buy nothing
      // and would add a round trip to the hot path of every S3 create.
      clientRegion.value = 'eu-west-1';
      mockSend.mockResolvedValue({});

      await provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS);

      const names = sentCommands();
      expect(names[0]).toBe('CreateBucketCommand');
      expect(names).not.toContain('GetBucketLocationCommand');
    });

    it('still deletes what it created in another region when a sub-config call fails', async () => {
      // The other direction of the same fence: gating the probe on region must
      // not gate the CLEANUP on region.
      clientRegion.value = 'eu-west-1';
      mockSend.mockResolvedValueOnce({}); // CreateBucket
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));
      mockSend.mockResolvedValueOnce({}); // DeleteBucket

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        'Failed to create S3 bucket'
      );

      expect(sentCommands()).toEqual([
        'CreateBucketCommand',
        'PutBucketVersioningCommand',
        'DeleteBucketCommand',
      ]);
    });

    it('recognises us-east-1 through a raw `--region US-EAST-1` spelling', async () => {
      // `--region US-EAST-1` reaches `getRegion()` unfolded -- the same raw
      // spelling the issue #2227 guard folds on the deploy side. A `===`
      // comparison in the probe gate would skip the pre-flight for the one
      // region it exists for, and nothing else in this file would notice.
      //
      // HALF-REAL, and worth saying so rather than letting the green tick imply
      // more than it proves: against real S3 this deploy does not get as far as
      // the steps below. `getRegion()` returns the raw spelling to the
      // PRE-EXISTING `LocationConstraint` gate as well, which tests it with a
      // bare `!==` and so sends `CreateBucketConfiguration: { LocationConstraint:
      // 'US-EAST-1' }`, and S3 rejects that. That gate is a separate,
      // pre-existing defect left alone here (widening it changes what cdkd
      // sends to `CreateBucket`). What this case legitimately fences is one
      // thing only: that the PROBE gate canonicalizes before comparing.
      clientRegion.value = 'US-EAST-1';
      mockSend.mockResolvedValueOnce({}); // pre-flight: the bucket is already there
      mockSend.mockResolvedValueOnce({}); // legacy 200
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));

      await expect(provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS)).rejects.toThrow(
        'Failed to create S3 bucket'
      );

      expect(sentCommands()[0]).toBe('GetBucketLocationCommand');
      expect(sentCommands()).not.toContain('DeleteBucketCommand');
    });
  });
});
