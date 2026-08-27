import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NoSuchBucket } from '@aws-sdk/client-s3';

const { mockSend, clientRegion } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' as string | undefined },
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

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'my-globally-unique-bucket';
const CREATE_PROPS = { BucketName: BUCKET };

/**
 * Issue [#2282](https://github.com/go-to-k/cdkd/issues/2282).
 *
 * `create()` decides whether to send a `CreateBucketConfiguration` from the
 * region `getRegion()` reports. With a bare case-SENSITIVE
 * `region !== 'us-east-1'` over that value, BOTH halves of the decision were
 * wrong on an unfolded spelling:
 *
 *  - the GATE: a mis-cased `US-EAST-1` took the branch and sent a
 *    `LocationConstraint` for the one region where S3 requires the field to be
 *    OMITTED; and
 *  - the SEND: every other region interpolated the raw spelling too, so a
 *    mis-cased `EU-WEST-1` sent `LocationConstraint: 'EU-WEST-1'`.
 *
 * Neither is a valid region NAME, so real S3 rejects the `CreateBucket` and the
 * deploy dies before anything else on the path runs. The issue framed the gate
 * alone; the send side is the same root cause one expression over and is fixed
 * by the same line. (Validity is about the NAME, not about
 * `BucketLocationConstraint` membership: that enum has 33 members, excludes
 * `us-east-1` by design, and also excludes real regions such as `ca-west-1` and
 * `mx-central-1` that the provider's `as` cast still sends and S3 still accepts.
 * The cast is a pre-existing stale-enum workaround this change does not touch.)
 *
 * WHERE THE RAW SPELLING COMES FROM -- measured, and it is NOT `--region`. That
 * flag is folded by `foldRegionOption` before the client bag is built and again
 * by `AwsClients`' constructor, and `AWS_REGION` is folded by `namedCliRegion`.
 * The constructor's fold is conditional on the bag HAVING a region, and every
 * command builds a region-less bag when the user named none -- so the SDK's own
 * chain answers from the profile's `region =` line, which nothing folds. A
 * profile holding `region = US-EAST-1` yields `config.region() === 'US-EAST-1'`
 * against this repo's `@aws-sdk/client-s3`, and that is exactly what
 * `getRegion()` reads. The population is therefore a mis-cased `~/.aws/config`
 * plus a command that names no region, or a library caller constructing
 * `AwsClients` with no region. `AWS_DEFAULT_REGION` is not a door -- measured,
 * the JS SDK v3 region chain does not read it.
 *
 * Every case here asserts on what the `CreateBucketCommand` ACTUALLY RECEIVED,
 * not on whether a helper was called -- a canonicalization that never reaches
 * the wire fixes nothing. The mocked `config.region()` is what makes the raw
 * spelling expressible at all: it stands in for the SDK chain resolving an
 * unfolded profile region, which is the only way this provider ever sees one.
 *
 * The two LOWERCASE rows are negative controls and are what stop the obvious
 * wrong fixes from passing: `eu-west-1` must still carry its
 * `LocationConstraint` unchanged (so deleting the block outright fails), and
 * `us-east-1` must still carry none (so inverting the comparison fails).
 */
describe('S3BucketProvider create() CreateBucketConfiguration region case (issue #2282)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    // No `*Once` primers anywhere in this file: the us-east-1 rows issue a
    // pre-flight `GetBucketLocation` that the eu-west-1 rows never do, so a
    // positional queue would mean two different scripts. Routing by COMMAND
    // keeps one arrangement correct for every row -- and a queue cannot leak
    // into the next test when there is no queue.
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'GetBucketLocationCommand'
        ? // The name is free, so the pre-flight probes `absent` and the create
          // proceeds down the ordinary path.
          Promise.reject(
            new NoSuchBucket({
              message: 'The specified bucket does not exist',
              $metadata: { httpStatusCode: 404 },
            })
          )
        : Promise.resolve({})
    );
    provider = new S3BucketProvider();
  });

  /** The input of the `CreateBucketCommand` the provider actually sent. */
  const createBucketInput = (): Record<string, unknown> => {
    const call = mockSend.mock.calls.find(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name === 'CreateBucketCommand'
    );
    expect(call, 'no CreateBucketCommand was sent').toBeDefined();
    return (call as [{ input: Record<string, unknown> }])[0].input;
  };

  describe('us-east-1 -- the field must be OMITTED', () => {
    it.each([
      ['the canonical spelling', 'us-east-1'],
      ['a raw `--region US-EAST-1` spelling', 'US-EAST-1'],
      ['a mixed-case spelling', 'US-east-1'],
    ])('sends no CreateBucketConfiguration for %s', async (_label, region) => {
      clientRegion.value = region;

      await provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS);

      expect(createBucketInput()).not.toHaveProperty('CreateBucketConfiguration');
    });
  });

  describe('every other region -- the field carries the CANONICAL spelling', () => {
    it.each([
      ['the canonical spelling', 'eu-west-1'],
      ['a raw `--region EU-WEST-1` spelling', 'EU-WEST-1'],
      ['a mixed-case spelling', 'Eu-West-1'],
    ])('sends LocationConstraint eu-west-1 for %s', async (_label, region) => {
      clientRegion.value = region;

      await provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS);

      expect(createBucketInput()['CreateBucketConfiguration']).toEqual({
        LocationConstraint: 'eu-west-1',
      });
    });
  });

  it('never puts an uppercase letter on the wire, for any spelling of any region', async () => {
    // The assertion the two blocks above cannot make between them: it fails on
    // ANY region whose raw spelling leaks, not only on the two this file names.
    for (const region of ['AP-NORTHEAST-1', 'ap-northeast-1', 'Sa-East-1']) {
      vi.clearAllMocks();
      clientRegion.value = region;

      await provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS);

      const config = createBucketInput()['CreateBucketConfiguration'] as
        | { LocationConstraint: string }
        | undefined;
      expect(config?.LocationConstraint).toBe(region.toLowerCase());
    }
  });

  // `getRegion()` ends in `return region || 'us-east-1'`, and that fallback was
  // completely unfenced: swapping it for a bare `return region` left all of
  // `tests/unit/provisioning/` green, so a future `||` -> `??` would ship
  // `LocationConstraint: ''` with nothing to catch it. Empty is not a region
  // name, so S3 would reject that create exactly as it rejects a mis-cased one.
  //
  // Scope, stated so the green tick is not read as more than it is: no REAL SDK
  // path reaches this today. `@smithy/config-resolver`'s `checkRegion` THROWS
  // ("Region not accepted: region=\"\" is not a valid hostname component")
  // rather than resolving empty, and `clientOptions` spreads `region` only when
  // truthy. What this pins is the CONTRACT of `getRegion()` -- a falsy
  // resolution means us-east-1, never the empty string -- which only a unit
  // case can hold, and which the gate above reads without re-checking.
  it.each([
    ['an empty string', ''],
    ['undefined', undefined],
  ])('falls back to us-east-1, sending no CreateBucketConfiguration, for %s', async (_label, region) => {
    clientRegion.value = region;

    await provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS);

    expect(createBucketInput()).not.toHaveProperty('CreateBucketConfiguration');
  });
});
