/**
 * Issue #2283 -- a Cloud-Control-routed `AWS::S3::Bucket` delete had no
 * bucket-identity guard, so a state record naming a bucket in another region
 * was deleted for real: S3 follows the region redirect for a body-bearing
 * operation, so the delete never comes back `NotFound` and the existing
 * `assertRegionMatch` (which only fires on that branch) is never reached.
 *
 * Both polarities of the routing decision are asserted, because the fix is a
 * per-type dispatch: the guarded type must probe and be able to refuse, and a
 * control type must keep issuing its `DeleteResource` with no extra call and
 * no new IAM dependency.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockS3Send = vi.fn();
let clientRegion: string | undefined = 'us-east-1';
let clientRegionRejects = false;

const resolveClientRegion = (): Promise<string | undefined> =>
  clientRegionRejects
    ? Promise.reject(new Error('Region is missing'))
    : Promise.resolve(clientRegion);

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCloudControlSend, config: { region: resolveClientRegion } },
    s3: { send: mockS3Send, config: { region: resolveClientRegion } },
    ec2: { send: vi.fn(), config: { region: resolveClientRegion } },
  }),
}));

/**
 * Test-side injection of a deletion-protection entry for `AWS::S3::Bucket`.
 *
 * The ORDER of the pre-flight confirmation against the `--remove-protection`
 * flip is otherwise UNOBSERVABLE, and that was measured, not assumed: moving
 * `confirmDeleteTargetIdentity` below all three protection blocks left this
 * suite 27/27 green. The reason is that the only guarded type is
 * `AWS::S3::Bucket`, which carries no real entry in
 * `cc-protection-properties.ts` and is neither of the two SDK-delegating
 * types -- so with the production table there is simply no mutating step for
 * the guard to be ordered against, and "zero Cloud Control traffic" catches a
 * mutation that SKIPS the guard but not one that MOVES it.
 *
 * Injecting an entry gives the delete a real `UpdateResourceCommand` to issue
 * before `DeleteResource`, which makes the order observable without touching
 * production routing. Default `undefined`, which is also what the REAL table
 * answers for every type this file drives through `delete()` --
 * `AWS::S3::Bucket`, `AWS::SQS::Queue` and `AWS::DynamoDB::Table` are none of
 * its seven entries -- so with the injection off these cases see exactly the
 * production answer.
 */
let injectedS3ProtectionEntry: CcProtectionEntry | undefined;
vi.mock('../../../src/provisioning/cc-protection-properties.js', () => ({
  ccProtectionProperty: (type: string) =>
    type === 'AWS::S3::Bucket' ? injectedS3ProtectionEntry : undefined,
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

const mockWarn = vi.fn();
const mockDebug = vi.fn();
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: mockDebug,
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: mockDebug, info: vi.fn(), warn: mockWarn, error: vi.fn() };
  },
}));

import {
  CloudControlProvider,
  requiresCcDeleteIdentityCheck,
  isNotFoundMessage,
} from '../../../src/provisioning/cloud-control-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
// Typed against the REAL entry (rather than structurally) so a field added to
// `CcProtectionEntry` cannot leave this injection silently diverged from what
// the provider actually consumes.
import type { CcProtectionEntry } from '../../../src/provisioning/cc-protection-properties.js';

const S3 = 'AWS::S3::Bucket';
const BUCKET = 'poisoned-stack-bucket';

/** CC mock: DeleteResource returns a token, the status poll reports SUCCESS. */
function wireCloudControl(): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'DeleteResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-delete' } });
    }
    if (name === 'UpdateResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-update' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
    }
    return Promise.resolve({});
  });
}

/**
 * S3 mock: `GetBucketLocation` answers with this WHOLE response object.
 *
 * The response, not just a constraint value, because the field's ABSENCE is
 * one of the three wire spellings for "this bucket is in us-east-1", and it is
 * the one the SDK's own types produce. AWS's API documentation does describe a
 * us-east-1 bucket's constraint as `null` (`@aws-sdk/client-s3`'s
 * `models_0.d.ts:6806` carries that sentence verbatim), which is what the CLI
 * renders -- but that sentence is the doc comment ON the field, and the
 * DECLARED type four lines BELOW it, at `models_0.d.ts:6810`, is
 * `GetBucketLocationOutput.LocationConstraint?: BucketLocationConstraint |
 * undefined`. `null` is not in that union, so a v3 client can present the same
 * fact as an absent field. (An earlier revision of this comment cited
 * `:1581`, which is `CreateBucketConfiguration` -- the CreateBucket INPUT, a
 * different symbol -- and said "two thousand lines above", inverting the
 * direction as well.) A fixture that can only express `null` therefore shares
 * its premise with the production code, and a mutation probe cannot falsify a
 * premise both sides hold.
 */
function wireBucketLocationResponse(response: Record<string, unknown>): void {
  mockS3Send.mockImplementation(() => Promise.resolve(response));
}

/** Shorthand for the ordinary case: a populated `LocationConstraint`. */
function wireBucketLocation(constraint: string): void {
  wireBucketLocationResponse({ LocationConstraint: constraint });
}

/** S3 mock: `GetBucketLocation` rejects with a named error. */
function wireBucketLocationError(name: string, message: string): void {
  mockS3Send.mockImplementation(() => {
    const error = new Error(message);
    error.name = name;
    return Promise.reject(error);
  });
}

const ccCallNames = (): string[] =>
  mockCloudControlSend.mock.calls.map((c) => c[0]?.constructor?.name as string);
const s3CallNames = (): string[] =>
  mockS3Send.mock.calls.map((c) => c[0]?.constructor?.name as string);

/** The three wire spellings S3 uses for "this bucket is in us-east-1". */
const US_EAST_1_SPELLINGS = [
  ['an absent field', {}],
  ['an empty string', { LocationConstraint: '' }],
  ['an explicit null', { LocationConstraint: null }],
] as const;

describe('requiresCcDeleteIdentityCheck -- both polarities of the routing decision', () => {
  it('selects AWS::S3::Bucket', () => {
    expect(requiresCcDeleteIdentityCheck(S3)).toBe(true);
  });

  it('leaves every control type on the unguarded path', () => {
    for (const type of [
      'AWS::SQS::Queue',
      'AWS::DynamoDB::Table',
      'AWS::Lambda::Function',
      'AWS::EC2::Instance',
      'AWS::AutoScaling::AutoScalingGroup',
      // Near-misses: a different S3 type, and the S3 Express twin, neither of
      // which is the globally-unique-name-plus-redirect shape this guards.
      'AWS::S3::BucketPolicy',
      'AWS::S3Express::DirectoryBucket',
    ]) {
      expect(requiresCcDeleteIdentityCheck(type)).toBe(false);
    }
  });
});

describe('CloudControlProvider.delete -- S3 bucket identity confirmation (issue #2283)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion = 'us-east-1';
    clientRegionRejects = false;
    injectedS3ProtectionEntry = undefined;
    wireCloudControl();
  });

  it('REFUSES the delete when the bucket lives in another region, and never issues DeleteResource', async () => {
    wireBucketLocation('us-west-2');
    const provider = new CloudControlProvider();

    await expect(
      provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'us-east-1' })
    ).rejects.toThrow(/Refusing to delete S3 bucket/);

    // The load-bearing half: the refusal has to happen BEFORE any mutating
    // Cloud Control call, not merely be reported after one.
    expect(ccCallNames()).toEqual([]);
    expect(s3CallNames()).toEqual(['GetBucketLocationCommand']);
  });

  it('marks the refusal non-retryable so withRetry does not re-run the whole delete', async () => {
    wireBucketLocation('eu-west-1');
    const provider = new CloudControlProvider();

    const error = await provider
      .delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'us-east-1' })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(error).toBeInstanceOf(Error);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('words the refusal so the not-found / transient classifiers do not claim it', async () => {
    wireBucketLocation('us-west-2');
    const provider = new CloudControlProvider();

    const error = (await provider
      .delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'us-east-1' })
      .then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

    // `isNotFoundMessage` would let a caller treat this deterministic refusal
    // as "the resource is gone"; `does not exist` is additionally a literal
    // member of the transient-message table in retryable-errors.ts.
    expect(isNotFoundMessage(error.message)).toBe(false);
    expect(error.message).not.toMatch(/does not exist|not found|no such/i);
    // It must still name both regions, or the operator cannot act on it.
    expect(error.message).toContain('us-west-2');
    expect(error.message).toContain('us-east-1');
    // The remedy has to be the one that actually applies: the comparand is
    // the region stored in STATE (destroy-runner threads `state.region`), so
    // telling the operator to re-run with a different `--region` would send
    // them somewhere that cannot change the comparison.
    expect(error.message).toContain('--region does not change this comparison');
  });

  it('PROCEEDS when the bucket is confirmed in the targeted region', async () => {
    wireBucketLocation('us-east-1');
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'us-east-1' });

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    // Distinguishes "probed and confirmed" from "never probed": without this
    // the case passes just as happily when the guard is skipped entirely.
    expect(s3CallNames()).toEqual(['GetBucketLocationCommand']);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  // The us-east-1 fold, across all THREE wire spellings. `null` alone is the
  // AWS CLI's rendering; the SDK types the field `BucketLocationConstraint |
  // undefined`, so an ABSENT field is what a real us-east-1 response gives a
  // v3 client. Each spelling gets both polarities, so a fold that permits too
  // much is caught as well as one that permits too little.
  for (const [label, response] of US_EAST_1_SPELLINGS) {
    it(`folds ${label} to us-east-1 and PROCEEDS when the destroy targets us-east-1`, async () => {
      wireBucketLocationResponse(response);
      const provider = new CloudControlProvider();

      await provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'us-east-1' });

      expect(ccCallNames()).toContain('DeleteResourceCommand');
      expect(s3CallNames()).toEqual(['GetBucketLocationCommand']);
      // A fold that throws instead of answering lands in the indeterminate
      // arm, which also proceeds -- the missing warning is what separates
      // "confirmed" from "gave up".
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it(`folds ${label} to us-east-1 and REFUSES when the destroy targets us-west-2`, async () => {
      wireBucketLocationResponse(response);
      const provider = new CloudControlProvider();

      await expect(
        provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'us-west-2' })
      ).rejects.toThrow(/lives in us-east-1/);
      expect(ccCallNames()).toEqual([]);
    });
  }

  it('folds the legacy EU constraint to eu-west-1', async () => {
    wireBucketLocation('EU');
    const provider = new CloudControlProvider();
    await provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'eu-west-1' });
    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('does NOT overfold: eu-central-1 is a real region, not the legacy EU alias', async () => {
    // The refusing polarity of the same fold. A prefix match (`startsWith`)
    // instead of an equality test would read an eu-central-1 bucket as
    // eu-west-1 and permit exactly the delete this guard exists to refuse.
    wireBucketLocation('eu-central-1');
    const provider = new CloudControlProvider();

    await expect(
      provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'eu-west-1' })
    ).rejects.toThrow(/lives in eu-central-1/);
    expect(ccCallNames()).toEqual([]);
  });

  it('compares case-insensitively so a --region US-EAST-1 destroy is not refused', async () => {
    wireBucketLocation('us-east-1');
    const provider = new CloudControlProvider();
    await provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'US-EAST-1' });
    expect(ccCallNames()).toContain('DeleteResourceCommand');
  });

  it('prefers the state region over the client region as the comparand', async () => {
    // Client is pinned to us-east-1 while state says the stack lives in
    // us-west-2 and the bucket really is there: reading the CLIENT region
    // would refuse a correct destroy.
    clientRegion = 'us-east-1';
    wireBucketLocation('us-west-2');
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'us-west-2' });

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(s3CallNames()).toEqual(['GetBucketLocationCommand']);
  });

  it('falls back to the client region when state carried none, and can refuse on it', async () => {
    clientRegion = 'us-east-1';
    wireBucketLocation('ap-northeast-1');
    const provider = new CloudControlProvider();

    // No context at all -- the shape a pre-v2 state record produces, since
    // `destroy-runner.ts` only spreads `expectedRegion` when `state.region`
    // is defined.
    await expect(provider.delete('Bucket', BUCKET, S3)).rejects.toThrow(/lives in ap-northeast-1/);
    expect(ccCallNames()).toEqual([]);
  });

  it('treats an EMPTY recorded region as absent and consults the client instead', async () => {
    // `destroy-runner.ts` spreads `expectedRegion` whenever
    // `state.region !== undefined`, and `deploy-engine.ts` types its
    // `stackRegion` as `string` -- so `''` arrives here as a DEFINED value
    // that a bare `??` would accept, making the comparison `'' !== 'us-east-1'`
    // and refusing a perfectly correct destroy.
    clientRegion = 'us-east-1';
    wireBucketLocation('us-east-1');
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: '' });

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(s3CallNames()).toEqual(['GetBucketLocationCommand']);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  // Both `.trim()` calls have two halves, and only the `=== ''` half was
  // fenced: dropping either `.trim()` left this suite green, because nothing
  // drove a PADDED region. `canonicalizeRegion` lowercases but does not trim,
  // so untrimmed padding survives into the comparison and refuses a correct
  // destroy.
  it('trims a PADDED recorded region rather than refusing on the whitespace', async () => {
    wireBucketLocation('us-east-1');
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: '  us-east-1  ' });

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(s3CallNames()).toEqual(['GetBucketLocationCommand']);
  });

  it('trims a PADDED client region too, on the fallback path', async () => {
    clientRegion = '  us-east-1  ';
    wireBucketLocation('us-east-1');
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3);

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(s3CallNames()).toEqual(['GetBucketLocationCommand']);
  });

  it('WARNS and proceeds when no region can be determined at all', async () => {
    // Neither half of the comparand exists: no state region, and the client's
    // region chain resolves to nothing. There is nothing to compare against,
    // so the probe is not even worth issuing -- but the operator must still
    // be told the guard did not run.
    clientRegion = undefined;
    wireBucketLocation('us-west-2');
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3);

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(String(mockWarn.mock.calls[0]?.[0])).toContain('reports a region');
  });

  it('does not ABORT the delete when the client region chain itself rejects', async () => {
    // Same policy as a probe that cannot answer: report and proceed. An
    // unresolvable SDK region chain throwing out of `delete()` would make the
    // guard fail CLOSED on one undeterminable input while failing open on
    // every other one.
    clientRegionRejects = true;
    wireBucketLocation('us-west-2');
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3);

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('PROCEEDS with a default-verbosity WARN when the probe cannot answer', async () => {
    wireBucketLocationError(
      'AccessDenied',
      'User is not authorized to perform: s3:GetBucketLocation'
    );
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'us-east-1' });

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const warned = String(mockWarn.mock.calls[0]?.[0]);
    expect(warned).toContain(BUCKET);
    expect(warned).toContain('s3:GetBucketLocation');
  });

  it('treats an ABSENT bucket as absent, not as indeterminate: no warn, delete proceeds', async () => {
    wireBucketLocationError('NoSuchBucket', 'The specified bucket does not exist');
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'us-east-1' });

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    // Warning here would fire on every ordinary re-run of a finished destroy.
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('reads the wire CODE, not the message: a bare 404 whose message says "does not exist" is indeterminate', async () => {
    // A proxy / AWS_ENDPOINT_URL / S3-compatible gateway can produce this. If
    // the message were trusted it would be read as a positive "absent" and the
    // operator would see no warning at all.
    wireBucketLocationError('NotFound', 'The specified bucket does not exist');
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3, undefined, { expectedRegion: 'us-east-1' });

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe('CloudControlProvider.delete -- the confirmation precedes --remove-protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion = 'us-east-1';
    clientRegionRejects = false;
    injectedS3ProtectionEntry = undefined;
    wireCloudControl();
  });

  // Two DIFFERENT properties, and the first two cases below only prove the
  // first of them:
  //
  //  - that the confirmation is not GATED on `removeProtection` (a mutation
  //    wrapping the call in `if (context?.removeProtection !== true)` reds
  //    them), and
  //  - that it runs BEFORE the `--remove-protection` flip.
  //
  // The second needs an injected protection entry, because with the real
  // `cc-protection-properties.ts` table `AWS::S3::Bucket` has no entry and is
  // neither SDK-delegating type, so no mutating step precedes the probe for
  // any member of the guarded set and "zero Cloud Control traffic" is
  // satisfied by both orders. Measured: moving the call below all three
  // protection blocks left this suite green until the injected case below
  // was added.
  it('REFUSES a foreign-region bucket even when --remove-protection was passed', async () => {
    wireBucketLocation('us-west-2');
    const provider = new CloudControlProvider();

    await expect(
      provider.delete('Bucket', BUCKET, S3, undefined, {
        expectedRegion: 'us-east-1',
        removeProtection: true,
      })
    ).rejects.toThrow(/Refusing to delete S3 bucket/);

    // Zero Cloud Control traffic: no UpdateResource protection patch, no
    // DeleteResource. Gating the confirmation on `removeProtection !== true`
    // would let both through.
    expect(ccCallNames()).toEqual([]);
    expect(s3CallNames()).toEqual(['GetBucketLocationCommand']);
  });

  it('still probes, and still proceeds, on a confirmed bucket under --remove-protection', async () => {
    wireBucketLocation('us-east-1');
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3, undefined, {
      expectedRegion: 'us-east-1',
      removeProtection: true,
    });

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(s3CallNames()).toEqual(['GetBucketLocationCommand']);
  });

  // GUARD-THE-GUARD, and it must come first: if the injection silently did not
  // apply, the ordering case below would assert "no UpdateResourceCommand"
  // against a run that was never going to issue one, and pass vacuously. This
  // case fails if the injected entry is not reaching the provider.
  it('the injected protection entry really does reach the provider', async () => {
    injectedS3ProtectionEntry = { property: 'DeletionProtectionEnabled', offValue: false };
    wireBucketLocation('us-east-1');
    const provider = new CloudControlProvider();

    await provider.delete('Bucket', BUCKET, S3, undefined, {
      expectedRegion: 'us-east-1',
      removeProtection: true,
    });

    expect(ccCallNames()).toContain('UpdateResourceCommand');
    expect(ccCallNames()).toContain('DeleteResourceCommand');
  });

  it('runs the confirmation BEFORE the protection flip, not merely before the delete', async () => {
    // With an entry injected, a guard placed below the protection blocks would
    // have already issued the `UpdateResourceCommand` by the time it refused --
    // a write against a resource cdkd has just decided it must not touch.
    injectedS3ProtectionEntry = { property: 'DeletionProtectionEnabled', offValue: false };
    wireBucketLocation('us-west-2');
    const provider = new CloudControlProvider();

    await expect(
      provider.delete('Bucket', BUCKET, S3, undefined, {
        expectedRegion: 'us-east-1',
        removeProtection: true,
      })
    ).rejects.toThrow(/Refusing to delete S3 bucket/);

    expect(ccCallNames()).toEqual([]);
    expect(s3CallNames()).toEqual(['GetBucketLocationCommand']);
  });
});

describe('CloudControlProvider.delete -- control types keep their existing route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion = 'us-east-1';
    clientRegionRejects = false;
    injectedS3ProtectionEntry = undefined;
    wireCloudControl();
    // Wired to a FOREIGN region on purpose: if a control type ever probed, it
    // would refuse here, so this doubles as proof that it does not probe.
    wireBucketLocation('us-west-2');
  });

  it('issues DeleteResource for AWS::SQS::Queue with no identity probe', async () => {
    const provider = new CloudControlProvider();
    await provider.delete(
      'Queue',
      'https://sqs.us-east-1.amazonaws.com/1/q',
      'AWS::SQS::Queue',
      undefined,
      { expectedRegion: 'us-east-1' }
    );

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('issues DeleteResource for AWS::DynamoDB::Table with no identity probe', async () => {
    const provider = new CloudControlProvider();
    await provider.delete('Table', 'my-table', 'AWS::DynamoDB::Table', undefined, {
      expectedRegion: 'us-east-1',
    });

    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});
