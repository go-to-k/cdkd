/**
 * Issue #2301 items 1 and 2 -- `CloudControlProvider` acted on a state
 * record's `physicalId` without confirming the record's region, everywhere
 * except the per-type S3 bucket probe issue #2283 added.
 *
 * Two facts make that dangerous, and both are why these tests use
 * `AWS::SQS::Queue` -- a type with NO identity probe and no deletion-protection
 * entry -- rather than the bucket the #2283 suite drives:
 *
 *  - The guard was type-INDEPENDENT in its absence. `assertRegionMatch` ran
 *    only inside `delete()`'s `NotFound` catch arm, so every Cloud-Control
 *    routed type was exposed, not just S3.
 *  - A wrong-region call usually never REACHES that arm. A Cloud Control
 *    `Identifier` is normally a NAME, and the same name commonly exists in the
 *    client's region as well, so the call succeeds against the wrong resource
 *    instead of erroring.
 *
 * Every case here therefore asserts a DIRECTION as well as an outcome: the
 * refusing arm must issue no AWS call, and the permitting arm must actually
 * reach `DeleteResource` / `UpdateResource`. A guard that starts refusing
 * ordinary same-region work would break every destroy and every in-place
 * update, and a one-directional fence would never see it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockS3Send = vi.fn();
const mockEc2Send = vi.fn();

let clientRegion: string | undefined = 'us-east-1';
let clientRegionRejects = false;
let regionResolveCalls = 0;

const resolveClientRegion = (): Promise<string | undefined> => {
  regionResolveCalls++;
  return clientRegionRejects
    ? Promise.reject(new Error('Region is missing'))
    : Promise.resolve(clientRegion);
};

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCloudControlSend, config: { region: resolveClientRegion } },
    s3: { send: mockS3Send, config: { region: resolveClientRegion } },
    ec2: { send: mockEc2Send, config: { region: resolveClientRegion } },
  }),
}));

// The UPDATE path consults the type's write-only properties before building
// its patch (issue #809), which is a `cloudformation:DescribeType` round trip.
// Stubbed to the empty set so these tests are about the region guard --
// and note the guard runs BEFORE it, which is what the "no Cloud Control
// traffic" assertions on the refusing arms actually pin.
const mockWriteOnlyLookup = vi.fn(() => Promise.resolve(new Set<string>()));
vi.mock('../../../src/provisioning/write-only-properties.js', () => ({
  getTopLevelWriteOnlyProperties: () => mockWriteOnlyLookup(),
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

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

/** No identity probe, no deletion-protection entry -- an ordinary CC type. */
const QUEUE = 'AWS::SQS::Queue';
const QUEUE_ID = 'https://sqs.us-east-1.amazonaws.com/123456789012/shared-name';

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

const ccCallNames = (): string[] =>
  mockCloudControlSend.mock.calls.map((c) => c[0]?.constructor?.name as string);

beforeEach(() => {
  vi.clearAllMocks();
  clientRegion = 'us-east-1';
  clientRegionRejects = false;
  regionResolveCalls = 0;
  wireCloudControl();
});

describe('CloudControlProvider.delete -- unconditional state-region pre-flight (issue #2301 item 2)', () => {
  it('REFUSES a delete whose state region disagrees with the client, on a type with no identity probe', async () => {
    const provider = new CloudControlProvider();

    await expect(
      provider.delete('Queue', QUEUE_ID, QUEUE, undefined, { expectedRegion: 'us-west-2' })
    ).rejects.toThrow(
      /Refusing to delete Queue \(AWS::SQS::Queue\): AWS client region us-east-1 does not match stack state region us-west-2/
    );

    // The load-bearing half. Before this guard the delete was ISSUED and
    // usually SUCCEEDED -- against whatever carried that identifier in
    // us-east-1 -- so "it threw" is not the claim; "AWS was never asked" is.
    expect(ccCallNames()).toEqual([]);
  });

  it('...and still issues the ordinary same-region delete', async () => {
    const provider = new CloudControlProvider();

    await provider.delete('Queue', QUEUE_ID, QUEUE, undefined, { expectedRegion: 'us-east-1' });

    // Asserting the DELETE was actually called, not merely that the flow
    // completed: a guard that refuses before the delete also produces a
    // resolved promise if the refusal is swallowed anywhere upstream.
    expect(ccCallNames()).toContain('DeleteResourceCommand');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('marks the refusal non-retryable so the destroy and deploy retry loops do not re-run it', async () => {
    const provider = new CloudControlProvider();

    const error = await provider
      .delete('Queue', QUEUE_ID, QUEUE, undefined, { expectedRegion: 'eu-west-1' })
      .catch((e: unknown) => e);

    // Deterministic by construction: no retry budget can turn a state/client
    // region disagreement into agreement, and spending one reads to the user
    // as flaky AWS rather than as a refusal.
    expect(isMarkedNonRetryable(error as Error)).toBe(true);
  });

  it('refuses BEFORE the --remove-protection EC2 termination flip, not merely before the delete', async () => {
    // Ordering, on a production route rather than an injected one: a
    // protection flip aimed at the wrong instance is already damage, so the
    // region check has to precede it. `AWS::EC2::Instance` under
    // `removeProtection` is the real mutating pre-step in `delete()`.
    const provider = new CloudControlProvider();

    await expect(
      provider.delete('Instance', 'i-01234567890abcdef', 'AWS::EC2::Instance', undefined, {
        expectedRegion: 'ap-northeast-1',
        removeProtection: true,
      })
    ).rejects.toThrow(/does not match stack state region ap-northeast-1/);

    expect(mockEc2Send).not.toHaveBeenCalled();
    expect(ccCallNames()).toEqual([]);
  });

  it('refuses BEFORE the S3 bucket identity probe of issue #2283', async () => {
    // The two guards are ordered cheapest-and-most-general first: this one
    // costs no API call, the #2283 probe costs a `GetBucketLocation`.
    const provider = new CloudControlProvider();

    await expect(
      provider.delete('Bucket', 'shared-name', 'AWS::S3::Bucket', undefined, {
        expectedRegion: 'us-west-2',
      })
    ).rejects.toThrow(/does not match stack state region us-west-2/);

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(ccCallNames()).toEqual([]);
  });

  // The THREE-WAY table for an unknown region. Each row states which of
  // refuse / proceed it takes and why, because the guard must not reject its
  // OWN default -- the shapes its real callers legitimately produce.
  describe('unknown-region table', () => {
    it('recorded region ABSENT (pre-v2 state record): PROCEEDS, and does not even ask the client', async () => {
      // `destroy-runner.ts` spreads `expectedRegion` only when
      // `state.region !== undefined`, and a `version: 1` record predates the
      // region-scoped key layout entirely. Refusing here would break every
      // destroy of a legacy record.
      const provider = new CloudControlProvider();

      await provider.delete('Queue', QUEUE_ID, QUEUE);

      expect(ccCallNames()).toContain('DeleteResourceCommand');
      // Zero cost on the commonest shape: with nothing to compare against
      // there is no reason to resolve the client's region at all.
      expect(regionResolveCalls).toBe(0);
    });

    it('recorded region EMPTY: PROCEEDS -- `deploy-engine.ts` types its stackRegion as `string`', async () => {
      const provider = new CloudControlProvider();

      await provider.delete('Queue', QUEUE_ID, QUEUE, undefined, { expectedRegion: '' });

      expect(ccCallNames()).toContain('DeleteResourceCommand');
      expect(regionResolveCalls).toBe(0);
    });

    it('recorded region WHITESPACE-ONLY: PROCEEDS, treated as absent rather than as a mismatch', async () => {
      const provider = new CloudControlProvider();

      await provider.delete('Queue', QUEUE_ID, QUEUE, undefined, { expectedRegion: '   ' });

      expect(ccCallNames()).toContain('DeleteResourceCommand');
      expect(regionResolveCalls).toBe(0);
    });

    it('recorded region present, CLIENT region unresolvable: REFUSES', async () => {
      // The asymmetry with `confirmDeleteTargetIdentity`, which proceeds when
      // IT cannot determine a region: there the probe asks a remote service
      // about a globally unique name and a least-privilege role would be
      // stranded by a refusal. Here the caller positively recorded a region,
      // and a client that cannot say where it points cannot be shown to point
      // at it.
      clientRegion = undefined;
      const provider = new CloudControlProvider();

      await expect(
        provider.delete('Queue', QUEUE_ID, QUEUE, undefined, { expectedRegion: 'us-east-1' })
      ).rejects.toThrow(/AWS client region is unknown but stack state records the resource in us-east-1/);
      expect(ccCallNames()).toEqual([]);
    });

    it('recorded region present, client region chain THROWS: REFUSES with the guard message, not the SDK error', async () => {
      clientRegionRejects = true;
      const provider = new CloudControlProvider();

      await expect(
        provider.delete('Queue', QUEUE_ID, QUEUE, undefined, { expectedRegion: 'us-east-1' })
      ).rejects.toThrow(/AWS client region is unknown but stack state records the resource in us-east-1/);
      expect(ccCallNames()).toEqual([]);
    });
  });

  // Spelling, not identity. `canonicalizeRegion` lowercases but does not trim,
  // so both halves are needed and both are driven here: a `--region US-EAST-1`
  // destroy and a padded state region are CORRECT inputs, and refusing them
  // would be the over-tightening failure rather than a stricter guard.
  it('accepts a case-different recorded region (--region US-EAST-1)', async () => {
    const provider = new CloudControlProvider();

    await provider.delete('Queue', QUEUE_ID, QUEUE, undefined, { expectedRegion: 'US-EAST-1' });

    expect(ccCallNames()).toContain('DeleteResourceCommand');
  });

  it('accepts a PADDED recorded region, and a padded client region', async () => {
    clientRegion = '  us-east-1  ';
    const provider = new CloudControlProvider();

    await provider.delete('Queue', QUEUE_ID, QUEUE, undefined, {
      expectedRegion: '  us-east-1  ',
    });

    expect(ccCallNames()).toContain('DeleteResourceCommand');
  });

  it('a case-different client region on the NotFound arm is still idempotent success (issue #2301 review)', async () => {
    // The two comparisons in `delete()` -- the pre-flight and the `NotFound`
    // arm -- have to normalise IDENTICALLY, and until they shared one helper
    // they did not: the arm compared RAW. This case is where the disagreement
    // showed, and no existing test made the two halves meet: the suite's
    // case-different test drives a SUCCEEDING delete, and its NotFound tests
    // are all exact-equal lowercase.
    //
    // `US-EAST-1` is reachable from a profile's `region = US-EAST-1`, which
    // `foldRegionOption` does NOT fold (it folds `--region` / `AWS_REGION` /
    // `AWS_DEFAULT_REGION` only). Pre-fix: the delete passed the pre-flight,
    // came back NotFound, and was then REFUSED by the raw comparison -- the
    // guard contradicting itself 200 lines below itself.
    clientRegion = 'US-EAST-1';
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'DeleteResourceCommand') {
        const error = new Error('Resource of type AWS::SQS::Queue was not found');
        error.name = 'ResourceNotFoundException';
        return Promise.reject(error);
      }
      return Promise.resolve({});
    });
    const provider = new CloudControlProvider();

    await expect(
      provider.delete('Queue', QUEUE_ID, QUEUE, undefined, { expectedRegion: 'us-east-1' })
    ).resolves.toBeUndefined();
    expect(ccCallNames()).toContain('DeleteResourceCommand');
  });

  it('leaves the NotFound arm on its own wording, so the existing idempotent path is unchanged', async () => {
    // Same region on both sides -- so the pre-flight passes -- and the delete
    // then comes back NotFound. That arm still runs its own
    // `assertRegionMatch` in its historical `not-found` phase, and treating
    // the absence as success is still the right answer.
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'DeleteResourceCommand') {
        const error = new Error('Resource of type AWS::SQS::Queue was not found');
        error.name = 'ResourceNotFoundException';
        return Promise.reject(error);
      }
      return Promise.resolve({});
    });
    const provider = new CloudControlProvider();

    await expect(
      provider.delete('Queue', QUEUE_ID, QUEUE, undefined, { expectedRegion: 'us-east-1' })
    ).resolves.toBeUndefined();
    expect(ccCallNames()).toContain('DeleteResourceCommand');
  });
});

describe('CloudControlProvider.update -- state-region pre-flight (issue #2301 item 1)', () => {
  const DESIRED = { VisibilityTimeout: 60 };
  const PREVIOUS = { VisibilityTimeout: 30 };

  it('REFUSES an update whose state region disagrees with the client region', async () => {
    const provider = new CloudControlProvider();

    await expect(
      provider.update('Queue', QUEUE_ID, QUEUE, DESIRED, PREVIOUS, {
        expectedRegion: 'us-west-2',
      })
    ).rejects.toThrow(
      /Refusing to update Queue \(AWS::SQS::Queue\): AWS client region us-east-1 does not match stack state region us-west-2/
    );

    // Nothing reached AWS -- not the `UpdateResource`, and not the
    // `DescribeType` behind the write-only-property lookup either. The second
    // half needs its OWN observation: that lookup goes out on the
    // CloudFormation client, which `ccCallNames()` cannot see, so asserting it
    // through the Cloud Control mock would have been a claim with nothing
    // behind it.
    expect(ccCallNames()).toEqual([]);
    expect(mockWriteOnlyLookup).not.toHaveBeenCalled();
  });

  it('...and still performs the ordinary same-region update', async () => {
    const provider = new CloudControlProvider();

    const result = await provider.update('Queue', QUEUE_ID, QUEUE, DESIRED, PREVIOUS, {
      expectedRegion: 'us-east-1',
    });

    expect(ccCallNames()).toContain('UpdateResourceCommand');
    expect(result.physicalId).toBe(QUEUE_ID);
  });

  it('marks the refusal non-retryable so the deploy engine does not re-run the update', async () => {
    const provider = new CloudControlProvider();

    const error = await provider
      .update('Queue', QUEUE_ID, QUEUE, DESIRED, PREVIOUS, { expectedRegion: 'eu-west-1' })
      .catch((e: unknown) => e);

    expect(isMarkedNonRetryable(error as Error)).toBe(true);
  });

  it('PROCEEDS when the caller threads no context at all -- the pre-#2301 five-argument shape', async () => {
    // Every provider that has not been threaded, and every caller that has no
    // trustworthy region, keeps its previous behaviour. `update()` gained the
    // sixth parameter here; it did not gain a requirement.
    const provider = new CloudControlProvider();

    await provider.update('Queue', QUEUE_ID, QUEUE, DESIRED, PREVIOUS);

    expect(ccCallNames()).toContain('UpdateResourceCommand');
    expect(regionResolveCalls).toBe(0);
  });

  it('PROCEEDS on an empty recorded region, and on a case-different one', async () => {
    const provider = new CloudControlProvider();

    await provider.update('Queue', QUEUE_ID, QUEUE, DESIRED, PREVIOUS, { expectedRegion: '' });
    expect(ccCallNames()).toContain('UpdateResourceCommand');
    // Same discriminator as the delete twin: with nothing to compare against,
    // the client's region is never even resolved.
    expect(regionResolveCalls).toBe(0);

    mockCloudControlSend.mockClear();
    await provider.update('Queue', QUEUE_ID, QUEUE, DESIRED, PREVIOUS, {
      expectedRegion: 'US-EAST-1',
    });
    expect(ccCallNames()).toContain('UpdateResourceCommand');
  });

  it('REFUSES when the client region cannot be resolved but state recorded one', async () => {
    clientRegion = undefined;
    const provider = new CloudControlProvider();

    await expect(
      provider.update('Queue', QUEUE_ID, QUEUE, DESIRED, PREVIOUS, {
        expectedRegion: 'us-east-1',
      })
    ).rejects.toThrow(/Refusing to update Queue/);
    expect(ccCallNames()).toEqual([]);
  });

  it('keeps the guard ahead of the no-op short-circuit, so an identical bag is refused too', async () => {
    // `update()` returns early when the generated patch is empty. That early
    // return is BELOW the guard, deliberately: a caller pointed at the wrong
    // region should hear about it rather than be told "no changes" about a
    // resource it never looked at.
    const provider = new CloudControlProvider();

    await expect(
      provider.update('Queue', QUEUE_ID, QUEUE, DESIRED, DESIRED, { expectedRegion: 'us-west-2' })
    ).rejects.toThrow(/Refusing to update Queue/);
  });
});
