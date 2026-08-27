import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketIntelligentTieringConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketReplicationCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1595: the four per-item / per-rule STRING refusals that #1581 left
 * strict. Each refuses a malformed configuration ITEM through a
 * `readConfigString` carrying no `onUnusable`, so it hard-threw on the
 * state-replay paths too — the un-rollbackable refusal every CONTAINER guard
 * beside it exists to avoid.
 *
 * What makes this a per-site decision rather than a mechanical `onUnusable`
 * thread-through is the DOWNGRADE. `readConfigString`'s own downgrade is
 * warn-and-DEFAULT, and every default here ENABLES something on a LIVE
 * resource:
 *
 * - lifecycle `Status` -> `Enabled` starts an expiration rule DELETING objects;
 * - intelligent-tiering `Status` -> `Enabled` starts moving objects to archive
 *   tiers;
 * - replication `Status` -> `Enabled` starts copying objects OUT of the bucket;
 * - inventory `IncludedObjectVersions` -> `All` silently changes the report.
 *
 * So the downgrade is the SKIP the sibling container guards perform, with the
 * SAME per-applier unit: the whole Put where the Put replaces every rule
 * (lifecycle / replication), the single configuration item where the Put is
 * per-Id (intelligent tiering / inventory).
 *
 * Three things here are load-bearing and each exists because a review mutation
 * proved the obvious version of the test did NOT catch its bug:
 *
 * 1. **The skip-unit rows put the malformed item FIRST.** With `['good','bad']`
 *    an early `return` still emits the `good` Put, so `sent[0].Id === 'good'`
 *    holds either way and flipping `continue` -> `return` on the per-Id
 *    appliers left the whole suite green — the exact per-site decision the
 *    issue asked for, unfenced.
 * 2. **The replay / update rows are parametrized over every malformed shape.**
 *    With a single shape per site, mutating the probe's `fallback` argument
 *    from `'Enabled'` to `''` left the suite green while re-introducing the
 *    #1595 hard-throw for a blank `Status` — because a blank value is only
 *    refused when the fallback is NON-blank.
 * 3. **The skip CLAUSE is asserted per applier.** Swapping lifecycle's clause
 *    for the intelligent-tiering one left the suite green, i.e. a log claiming
 *    an item skip where the whole Put was actually left alone.
 *
 * The create-path rows are a REGRESSION FENCE, not proof of the new guard:
 * they pass on the unfixed tree too (the same read threw there, with a
 * byte-identical message). The genuinely new behavior is every replay / update
 * row.
 */

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

import { NoSuchBucket } from '@aws-sdk/client-s3';
import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'per-item-string-bucket';

let provider: S3BucketProvider;

/**
 * Answer every call with `{}` EXCEPT the `us-east-1` pre-flight probe, which
 * is answered "no such bucket" (issue #2241).
 *
 * This file's client is mocked at us-east-1, where the provider asks
 * `GetBucketLocation` whether the name is already taken before creating it. A
 * blanket `{}` is a VALID `GetBucketLocationOutput` -- an absent
 * `LocationConstraint` is S3's spelling of us-east-1 -- so it would tell every
 * create here that it adopted a bucket that was already there, and the adopt
 * warning would then satisfy the `warn` assertions that are supposed to be
 * about per-item string shapes.
 *
 * The 404 is the MODELED `NoSuchBucket`, which is what the client really
 * produces. An earlier revision hand-built a plain `Error` here on the
 * reasoning that `GetBucketLocationCommand` declares only
 * `@throws {@link S3ServiceException}` and so could not be yielding the modeled
 * class; measured 2026-08-26 against the real client, that is wrong --
 * `DeleteBucket` declares the same lone throw and both operations return
 * `instanceof NoSuchBucket` with `name: 'NoSuchBucket'` and status 404, errors
 * being resolved through a per-NAMESPACE schema registry.
 */
function primeSendForNewBucket(): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if ((cmd as { constructor: { name: string } }).constructor.name === 'GetBucketLocationCommand') {
      return Promise.reject(
        new NoSuchBucket({
          message: 'The specified bucket does not exist',
          $metadata: { httpStatusCode: 404 },
        })
      );
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new S3BucketProvider();
  primeSendForNewBucket();
});

function sentCommands<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandType: new (...args: any[]) => T
): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof commandType) as T[];
}

// The shapes a state record written by an older binary can legitimately carry
// for a field the template meant to be a string. The BLANK string and the
// explicit NULL are the rows a hand-written `typeof value !== 'string'` twin
// would disagree with `readConfigString` on — which is why the probe shares
// that helper's predicate instead of re-deriving one. The unresolved-intrinsic
// row uses the real CFn spelling (`Fn::If`), not a synthetic stand-in.
const malformedValues: Array<[string, unknown]> = [
  ['an array (an unresolved intrinsic collapsed to a list)', ['Enabled']],
  ['an unresolved intrinsic left as an object', { 'Fn::If': ['C', 'Enabled', 'Disabled'] }],
  ['a number', 1],
  ['a whitespace-only string', '   '],
  ['an explicit null', null],
];

const validInventoryFields = {
  Destination: { BucketArn: 'arn:aws:s3:::inv-dest', Format: 'CSV' },
  ScheduleFrequency: 'Daily',
};
const validReplicationFields = {
  Destination: { Bucket: 'arn:aws:s3:::repl-dest' },
};

interface Site {
  readonly name: string;
  /** CFn path the refusal must name. */
  readonly path: string;
  /** The exact clause the warning must carry — asserted per applier (gap 3). */
  readonly skipClause: string;
  /**
   * `whole-put` = the API replaces every rule, so ONE malformed item must
   * leave the entire live configuration alone; `per-id` = the Put is keyed by
   * Id, so only the malformed item is skipped.
   */
  readonly unit: 'whole-put' | 'per-id';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly command: new (...args: any[]) => { input: Record<string, any> };
  /** A single malformed item. */
  readonly one: (value: unknown) => Record<string, unknown>;
  /** The malformed item FIRST, a valid `good` item second (gap 1). */
  readonly badThenGood: (value: unknown) => Record<string, unknown>;
  /** A valid `good` item first, the malformed one second. */
  readonly goodThenBad: (value: unknown) => Record<string, unknown>;
  /** A well-formed item whose value is NOT the fallback. */
  readonly validNonDefault: Record<string, unknown>;
  /**
   * The guarded key OMITTED entirely, plus the fallback it must then take.
   *
   * Pins the READ's fallback, which the probe's own rows cannot: a probe-side
   * fallback flip is caught by the parametrized replay rows, but flipping the
   * `readConfigString` fallback at the SDK-call site is only observable here.
   * Two of the four sites had no such row and the whole 10,531-test suite
   * stayed green when their default was flipped `Enabled` -> `Disabled`.
   */
  readonly absent: Record<string, unknown>;
  readonly absentDefault: string;
  /** An item that is not an object at all — the CONTAINER half of the probe. */
  readonly nonObjectItem: Record<string, unknown>;
  /** Reads the value back off a sent command, for the no-false-refusal rows. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly readValue: (input: Record<string, any>) => unknown;
}

const lifecycleProps = (rules: Array<Record<string, unknown>>) => ({
  BucketName: BUCKET,
  LifecycleConfiguration: { Rules: rules },
});
const itProps = (configs: Array<Record<string, unknown>>) => ({
  BucketName: BUCKET,
  IntelligentTieringConfigurations: configs,
});
const inventoryProps = (configs: Array<Record<string, unknown>>) => ({
  BucketName: BUCKET,
  InventoryConfigurations: configs,
});
const replicationProps = (rules: Array<Record<string, unknown>>) => ({
  BucketName: BUCKET,
  ReplicationConfiguration: { Role: 'arn:aws:iam::123456789012:role/repl', Rules: rules },
});

const TIERINGS = [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }];

const SITES: Site[] = [
  {
    name: 'lifecycle',
    path: 'AWS::S3::Bucket LifecycleConfiguration.Rules[].Status',
    skipClause: 'Leaving the whole lifecycle configuration unapplied here',
    unit: 'whole-put',
    command: PutBucketLifecycleConfigurationCommand,
    one: (v) => lifecycleProps([{ Id: 'bad', Status: v, ExpirationInDays: 30 }]),
    badThenGood: (v) =>
      lifecycleProps([
        { Id: 'bad', Status: v, ExpirationInDays: 30, Filter: { Prefix: 'b/' } },
        { Id: 'good', Status: 'Enabled', ExpirationInDays: 10, Filter: { Prefix: 'a/' } },
      ]),
    goodThenBad: (v) =>
      lifecycleProps([
        { Id: 'good', Status: 'Enabled', ExpirationInDays: 10, Filter: { Prefix: 'a/' } },
        { Id: 'bad', Status: v, ExpirationInDays: 30, Filter: { Prefix: 'b/' } },
      ]),
    validNonDefault: lifecycleProps([{ Id: 'probe', Status: 'Disabled', ExpirationInDays: 30 }]),
    absent: lifecycleProps([{ Id: 'probe', ExpirationInDays: 30 }]),
    absentDefault: 'Enabled',
    nonObjectItem: lifecycleProps(['not-a-rule' as never]),
    readValue: (input) => (input['LifecycleConfiguration']?.Rules ?? [])[0]?.Status,
  },
  {
    name: 'replication',
    path: 'AWS::S3::Bucket ReplicationConfiguration.Rules[].Status',
    skipClause: 'Leaving the whole replication configuration unapplied here',
    unit: 'whole-put',
    command: PutBucketReplicationCommand,
    one: (v) => replicationProps([{ Id: 'bad', Status: v, ...validReplicationFields }]),
    badThenGood: (v) =>
      replicationProps([
        { Id: 'bad', Status: v, ...validReplicationFields },
        { Id: 'good', Status: 'Enabled', ...validReplicationFields },
      ]),
    goodThenBad: (v) =>
      replicationProps([
        { Id: 'good', Status: 'Enabled', ...validReplicationFields },
        { Id: 'bad', Status: v, ...validReplicationFields },
      ]),
    validNonDefault: replicationProps([
      { Id: 'probe', Status: 'Disabled', ...validReplicationFields },
    ]),
    absent: replicationProps([{ Id: 'probe', ...validReplicationFields }]),
    absentDefault: 'Enabled',
    nonObjectItem: replicationProps(['not-a-rule' as never]),
    readValue: (input) => (input['ReplicationConfiguration']?.Rules ?? [])[0]?.Status,
  },
  {
    name: 'intelligent tiering',
    path: 'AWS::S3::Bucket IntelligentTieringConfigurations[].Status',
    skipClause: 'Skipping this intelligent tiering configuration',
    unit: 'per-id',
    command: PutBucketIntelligentTieringConfigurationCommand,
    one: (v) => itProps([{ Id: 'bad', Status: v, Tierings: TIERINGS }]),
    badThenGood: (v) =>
      itProps([
        { Id: 'bad', Status: v, Tierings: TIERINGS },
        { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
      ]),
    goodThenBad: (v) =>
      itProps([
        { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
        { Id: 'bad', Status: v, Tierings: TIERINGS },
      ]),
    validNonDefault: itProps([{ Id: 'probe', Status: 'Disabled', Tierings: TIERINGS }]),
    absent: itProps([{ Id: 'probe', Tierings: TIERINGS }]),
    absentDefault: 'Enabled',
    nonObjectItem: itProps(['not-a-config' as never]),
    readValue: (input) => input['IntelligentTieringConfiguration']?.Status,
  },
  {
    name: 'inventory',
    path: 'AWS::S3::Bucket InventoryConfigurations[].IncludedObjectVersions',
    skipClause: 'Skipping this inventory configuration',
    unit: 'per-id',
    command: PutBucketInventoryConfigurationCommand,
    one: (v) => inventoryProps([{ Id: 'bad', IncludedObjectVersions: v, ...validInventoryFields }]),
    badThenGood: (v) =>
      inventoryProps([
        { Id: 'bad', IncludedObjectVersions: v, ...validInventoryFields },
        { Id: 'good', IncludedObjectVersions: 'Current', ...validInventoryFields },
      ]),
    goodThenBad: (v) =>
      inventoryProps([
        { Id: 'good', IncludedObjectVersions: 'Current', ...validInventoryFields },
        { Id: 'bad', IncludedObjectVersions: v, ...validInventoryFields },
      ]),
    validNonDefault: inventoryProps([
      { Id: 'probe', IncludedObjectVersions: 'Current', ...validInventoryFields },
    ]),
    absent: inventoryProps([{ Id: 'probe', ...validInventoryFields }]),
    absentDefault: 'All',
    nonObjectItem: inventoryProps(['not-a-config' as never]),
    readValue: (input) => input['InventoryConfiguration']?.IncludedObjectVersions,
  },
];

const REFUSAL = (site: Site) => `${site.path} must be a non-empty string`;

describe('create path: the refusal still stands (regression fence, NOT the new behavior)', () => {
  for (const site of SITES) {
    for (const [label, value] of malformedValues) {
      it(`${site.name}: refuses a value that is ${label}, and sends NO Put`, async () => {
        await expect(provider.create('B', RESOURCE_TYPE, site.one(value))).rejects.toThrow(
          REFUSAL(site)
        );
        expect(sentCommands(site.command)).toHaveLength(0);
      });
    }
  }
});

describe('replay path (create with replayingState): warn and SKIP, never default', () => {
  for (const site of SITES) {
    // Parametrized over EVERY malformed shape (gap 2): with one shape per site,
    // mutating the probe's `fallback` argument to `''` kept the suite green
    // while re-admitting the hard-throw for a blank value.
    for (const [label, value] of malformedValues) {
      it(`${site.name}: warns and sends NO Put for a value that is ${label}`, async () => {
        await provider.create('B', RESOURCE_TYPE, site.one(value), { replayingState: true });
        expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining(REFUSAL(site)));
        // The whole point: readConfigString's own downgrade would have sent a
        // Put carrying the ENABLING default.
        expect(sentCommands(site.command)).toHaveLength(0);
      });
    }

    it(`${site.name}: the warning names THIS applier's skip, not a sibling's`, async () => {
      // Gap 3: without the per-applier assertion, swapping the whole-Put clause
      // for the per-item one logged an item skip where the entire live
      // configuration had been left alone.
      await provider.create('B', RESOURCE_TYPE, site.one(1), { replayingState: true });
      const message = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(message).toContain(site.skipClause);
      // And never the inherited "using the default" claim this path does not
      // make good on.
      expect(message).not.toContain('using the default');
    });
  }
});

describe('the SKIP UNIT matches the API, which is the per-site decision', () => {
  for (const site of SITES) {
    if (site.unit === 'whole-put') {
      // The Put replaces every rule, so applying the valid sibling ALONE would
      // DELETE the malformed one from AWS — a destructive "partial success".
      it(`${site.name}: a malformed FIRST rule leaves the whole configuration alone`, async () => {
        await provider.create('B', RESOURCE_TYPE, site.badThenGood(1), { replayingState: true });
        expect(sentCommands(site.command)).toHaveLength(0);
      });

      it(`${site.name}: a malformed LAST rule leaves the whole configuration alone`, async () => {
        await provider.create('B', RESOURCE_TYPE, site.goodThenBad(1), { replayingState: true });
        expect(sentCommands(site.command)).toHaveLength(0);
      });
    } else {
      // The Put is per-Id, so the siblings are unaffected. Malformed item FIRST
      // (gap 1): with `['good','bad']` an early `return` still emits the good
      // Put, so this assertion held for BOTH skip units and the mutation that
      // swapped them was invisible.
      it(`${site.name}: a malformed FIRST item still applies the valid sibling`, async () => {
        await provider.create('B', RESOURCE_TYPE, site.badThenGood(1), { replayingState: true });
        const sent = sentCommands(site.command);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.input['Id']).toBe('good');
      });

      it(`${site.name}: a malformed LAST item still applies the valid sibling`, async () => {
        await provider.create('B', RESOURCE_TYPE, site.goodThenBad(1), { replayingState: true });
        const sent = sentCommands(site.command);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.input['Id']).toBe('good');
      });
    }
  }
});

describe('update path: the wiring nothing else covers', () => {
  // `rollback-executor.ts`'s revert arm and `cdkd drift --revert` both call
  // `update(..., previousState.properties, ...)`, so the DESIRED bag on this
  // path is a state record too. Without these, dropping the third argument at
  // an update call site leaves the suite green while the malformed record
  // hard-throws on every rollback.
  for (const site of SITES) {
    for (const [label, value] of malformedValues) {
      it(`${site.name}: warns and skips for a value that is ${label}`, async () => {
        await provider.update('B', BUCKET, RESOURCE_TYPE, site.one(value), {
          BucketName: BUCKET,
        });
        expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining(REFUSAL(site)));
        expect(sentCommands(site.command)).toHaveLength(0);
      });
    }
  }
});

describe('no false refusal: valid and ABSENT values keep working', () => {
  for (const site of SITES) {
    it(`${site.name}: a well-formed NON-default value is applied verbatim on a replay`, async () => {
      await provider.create('B', RESOURCE_TYPE, site.validNonDefault, { replayingState: true });
      const sent = sentCommands(site.command);
      expect(sent).toHaveLength(1);
      // Not the fallback — a guard that skipped or defaulted a VALID value
      // would be the regression this change could most easily introduce.
      expect(site.readValue(sent[0]!.input)).toBe(
        site.name === 'inventory' ? 'Current' : 'Disabled'
      );
      expect(childLogger.warn).not.toHaveBeenCalled();
    });
  }

  for (const site of SITES) {
    it(`${site.name}: an ABSENT value still takes the READ's default, with no warning`, async () => {
      // The ABSENT case belongs to the caller, not the guard: an omitted field
      // legitimately means "defaulted", and refusing it would break every
      // template that relies on the default.
      //
      // This also pins the READ's fallback, which nothing else can: the probe's
      // fallback is fenced by the parametrized replay rows, but flipping the
      // `readConfigString` fallback at the SDK-call site is invisible without
      // this row — two sites lacked it and the full suite stayed green when
      // their default was flipped.
      await provider.create('B', RESOURCE_TYPE, site.absent);
      const sent = sentCommands(site.command);
      expect(sent).toHaveLength(1);
      expect(site.readValue(sent[0]!.input)).toBe(site.absentDefault);
      expect(childLogger.warn).not.toHaveBeenCalled();
    });
  }
});

describe('the CONTAINER half of the probe is reachable from the provider too', () => {
  // The probe guards a container AND a field; the rows above exercise only the
  // FIELD half. A per-rule / per-item value that is not an object at all
  // reaches the same guard, and every applier must handle it — not just the
  // one that happened to get a test first.
  for (const site of SITES) {
    it(`${site.name}: a non-object item is refused on create and skipped on a replay`, async () => {
      await expect(provider.create('B', RESOURCE_TYPE, site.nonObjectItem)).rejects.toThrow(
        /must be an object/
      );
      expect(sentCommands(site.command)).toHaveLength(0);

      vi.clearAllMocks();
      childLogger.child.mockReturnValue(childLogger);
      primeSendForNewBucket();

      await provider.create('B', RESOURCE_TYPE, site.nonObjectItem, { replayingState: true });
      expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('must be an object'));
      expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining(site.skipClause));
      expect(sentCommands(site.command)).toHaveLength(0);
    });
  }
});
