import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { BucketLocationConstraint, NoSuchBucket } from '@aws-sdk/client-s3';
import { RegionInfo } from 'aws-cdk-lib/region-info';

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
 * `us-east-1` by design, and also excludes THIRTEEN further real regions that
 * the provider's `as` cast still sends and S3 still accepts. The cast is a
 * DELIBERATE widening of a stale enum, settled in issue
 * [#2322](https://github.com/go-to-k/cdkd/issues/2322) and fenced by the last
 * describe block in this file rather than only described in prose.)
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

  /**
   * Issue [#2322](https://github.com/go-to-k/cdkd/issues/2322) -- the regions
   * the SDK's own enum does NOT contain.
   *
   * `create()` sends `canonicalRegion as BucketLocationConstraint`, and the
   * `as` asserts a membership the value need not have. That is settled as
   * DELIBERATE rather than fixed, for two measured reasons recorded beside the
   * cast: the SDK has not widened `CreateBucketConfiguration.LocationConstraint`
   * (still `BucketLocationConstraint | undefined`), and typing the local bag's
   * field as `string` does not compile -- it moves the same assertion to
   * `new CreateBucketCommand(...)` and widens it from one field to the whole
   * bag.
   *
   * What is fenced here is the REGRESSION the cast invites, which is not its
   * removal (that fails to compile) but a future "soundness fix" that filters
   * the region to enum members. That compiles, leaves every `us-east-1` /
   * `eu-west-1` row above green, and silently omits `CreateBucketConfiguration`
   * for every region below -- which BREAKS THE DEPLOY in each of them.
   *
   * THE FAILURE IS LOUD, NOT SILENT, AND AN EARLIER REVISION OF THIS FILE SAID
   * OTHERWISE. It claimed the bucket would quietly be created in `us-east-1`.
   * It would not. The provider's client is REGION-BOUND (`this.s3Client =
   * awsClients.s3`, and `getRegion()` reads `this.s3Client.config.region()`),
   * so the create goes to that region's REGIONAL endpoint, where an omitted
   * `LocationConstraint` answers `IllegalLocationConstraintException` --
   * `src/assets/asset-storage.ts:775` states the same rule for the sibling
   * call site. The `us-east-1` default is a property of the GLOBAL
   * `s3.amazonaws.com` endpoint, which this path never uses, and a genuinely
   * region-less client THROWS (`Error: Region is missing`) rather than
   * resolving empty -- so there is no route to the global story at all. The
   * correction is recorded rather than quietly applied because the residency
   * reading is the natural guess, and re-deriving it costs the next reader the
   * same measurement it cost this one.
   *
   * The list is DERIVED, not spot-checked -- and an earlier revision of this
   * file, of the provider comment, and of issue #2282's changelog entry each
   * named FOUR regions, which was a spot-check written as an enumeration. The
   * full cross-check gives thirteen. Re-derive with:
   *
   *   node --input-type=module -e "
   *   import { BucketLocationConstraint } from '@aws-sdk/client-s3';
   *   import { RegionInfo } from 'aws-cdk-lib/region-info';
   *   const m = new Set(Object.values(BucketLocationConstraint));
   *   console.log(RegionInfo.regions.map(r => r.name).filter(r => !m.has(r)).sort().join('\n'));"
   *
   * Measured 2026-08-27 against `@aws-sdk/client-s3` 3.1018.0 (33 members) and
   * `aws-cdk-lib` 2.244.0 (46 regions).
   *
   * ALL THIRTEEN ARE SWEPT, with no commercial / non-commercial split. An
   * earlier revision swept six it called "commercial" and excluded seven
   * `aws-iso*` ones as "not reachable from a commercial deploy". Both halves
   * were wrong: `eusc-de-east-1` is NOT commercial (`RegionInfo.get(...)
   * .partition === 'aws-eusc'`, its own partition, which `PARTITION_TABLE` in
   * `src/utils/aws-partition.ts` lists beside the iso prefixes), so only FIVE
   * of the six were; and cdkd has explicit `aws-iso*` support, so the
   * exclusion was overstated too. The honest reason to sweep them all is that
   * the production gate is a single `canonicalRegion !== 'us-east-1'` with NO
   * partition branch -- every one of the thirteen traverses byte-identical
   * lines -- so a partition split would have been a classification to maintain
   * that bought no coverage. Sweeping all thirteen deletes the question.
   */
  describe('regions ABSENT from the SDK enum (issue #2322)', () => {
    const ENUM_ABSENT_REGIONS: string[] = [
      'ap-east-2',
      'ap-southeast-6',
      'ap-southeast-7',
      'ca-west-1',
      'eu-isoe-west-1',
      'eusc-de-east-1',
      'mx-central-1',
      'us-iso-east-1',
      'us-iso-west-1',
      'us-isob-east-1',
      'us-isob-west-1',
      'us-isof-east-1',
      'us-isof-south-1',
    ];

    it('pins only REAL regions -- every name is in the region table', () => {
      // Without this the list is a hand-written literal with nothing checking
      // it. Measured: substituting `'totally-not-a-region'` for `'ap-east-2'`
      // left all rows GREEN, because a bogus name still round-trips through
      // the provider and is still absent from the enum -- so a typo would
      // silently drop a real region's coverage while both its row and the
      // floor below kept passing. This is the same derivation the comment
      // above documents, asserted rather than described.
      const real = new Set(RegionInfo.regions.map((r) => r.name));
      expect(real.has('eu-west-1'), 'guard-the-guard: the table must be non-empty').toBe(true);
      expect(ENUM_ABSENT_REGIONS.filter((r) => !real.has(r))).toEqual([]);
    });

    it('still has a gap to fence -- the shipped enum omits these regions', () => {
      const members = new Set<string>(Object.values(BucketLocationConstraint));

      // Guard-the-guard. An always-empty `members` would make the absence
      // assertion below pass for the wrong reason, so pin BOTH polarities of
      // the membership test first: the enum does contain `eu-west-1`, and does
      // not contain `us-east-1` (which it omits by design, not by staleness).
      expect(members.has('eu-west-1')).toBe(true);
      expect(members.has('us-east-1')).toBe(false);

      // A FLOOR rather than an exact match, on purpose. The SDK catching up on
      // one region must not red this file -- the rows below keep asserting the
      // sent value either way, and a region that JOINS the enum simply stops
      // being an interesting case. It reds only when the enum has caught up on
      // ALL of them, which is the moment the cast, this block and the provider
      // comment should all be re-derived rather than trusted.
      const absent = ENUM_ABSENT_REGIONS.filter((r) => !members.has(r));
      expect(absent.length).toBeGreaterThan(0);
    });

    it.each(ENUM_ABSENT_REGIONS)(
      'sends LocationConstraint %s verbatim even though the enum omits it',
      async (region) => {
        clientRegion.value = region;

        await provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS);

        expect(createBucketInput()['CreateBucketConfiguration']).toEqual({
          LocationConstraint: region,
        });
      }
    );

    it('folds a mis-cased enum-absent region rather than dropping the field', async () => {
      // The two issues meet here: #2282's fold has to survive on a region
      // #2322 says is not in the enum. `CA-West-1` must reach the wire as
      // `ca-west-1` -- not raw (S3 rejects it as a NAME) and not omitted.
      clientRegion.value = 'CA-West-1';

      await provider.create('MyBucket', RESOURCE_TYPE, CREATE_PROPS);

      expect(createBucketInput()['CreateBucketConfiguration']).toEqual({
        LocationConstraint: 'ca-west-1',
      });
    });
  });
});
