import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketIntelligentTieringConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1612: the warn-and-skip replay paths #1579 / #1581 / #1595 / #1605
 * shipped announce the skip and let the deploy SUCCEED — so the engine records
 * the DESIRED bag, malformed value and all, for a Put that never reached AWS.
 * `readCurrentState` can then never match it, every later `cdkd drift`
 * re-reports the same difference, and `drift --revert` re-issues the same
 * skipped call: the permanent phantom drift `.claude/rules/providers.md`
 * records for the EC2 Route warn arm (#1591), reached through a SKIP rather
 * than a narrowing.
 *
 * The remedy is `effectiveProperties`, and what to record differs per path —
 * neither answer generalizes, which is why each is pinned separately here:
 *
 * - **UPDATE**: retain the PREVIOUS value. The Put never ran, so AWS still
 *   holds the previously-applied configuration. Dropping the key instead is
 *   wrong in the other direction — a later template that REMOVES the block
 *   would derive no removal and the live configuration would survive forever,
 *   which is what the `drops the key` mutation row below fences.
 * - **replay-CREATE**: DROP the key. The bucket is brand new and nothing was
 *   applied, so there is no previous value to keep.
 * - **per-item appliers**: the skip unit is one configuration ITEM, so the
 *   effective array substitutes the previous item of the same `Id` IN PLACE,
 *   or drops it when the skipped item was an ADD.
 *
 * Three rows exist because the obvious version of this test passes under a
 * wrong implementation:
 *
 * 1. **The DESIRED order is asserted with the skipped item FIRST.**
 *    `DiffCalculator` compares arrays positionally, so an implementation that
 *    appends the retained items instead of substituting them in place removes
 *    this phantom drift and manufactures a fresh one. With the skipped item
 *    last, `[kept, retained]` and `[retained, kept]` are the same array.
 * 2. **The no-skip row asserts `effectiveProperties` is ABSENT, not equal to
 *    the desired bag.** An implementation that always returns the bag is
 *    indistinguishable by value, and it would rewrite the record on every
 *    ordinary deploy — the engine gates on `??`, so absent is the contract.
 * 3. **The retained value is asserted to be the PREVIOUS one specifically**,
 *    not merely "different from desired". A skip that dropped the key also
 *    differs from desired.
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

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'effective-properties-bucket';

let provider: S3BucketProvider;

beforeEach(() => {
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new S3BucketProvider();
  mockSend.mockResolvedValue({});
});

function sentCommands<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandType: new (...args: any[]) => T
): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof commandType) as T[];
}

/** The malformed shapes a state record written by an older binary can carry. */
const MALFORMED = ['   ', null, 1, ['Enabled'], { 'Fn::If': ['C', 'Enabled', 'Disabled'] }];

const TIERINGS = [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }];

const liveLifecycle = { Rules: [{ Id: 'r1', Status: 'Disabled', ExpirationInDays: 30 }] };
const malformedLifecycle = (value: unknown) => ({
  Rules: [{ Id: 'r1', Status: value, ExpirationInDays: 30 }],
});

describe('UPDATE: a skipped WHOLE-Put records the PREVIOUS value', () => {
  for (const value of MALFORMED) {
    it(`lifecycle: retains the previously applied configuration (${JSON.stringify(value)})`, async () => {
      const properties = { BucketName: BUCKET, LifecycleConfiguration: malformedLifecycle(value) };
      const previousProperties = { BucketName: BUCKET, LifecycleConfiguration: liveLifecycle };

      const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
        ...previousProperties,
      });

      // The Put really was skipped — otherwise there is nothing to record.
      expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
      // ...and the record describes what AWS still holds, not what it was
      // handed. Asserted against the PREVIOUS value specifically: a
      // key-dropping implementation is also "not the desired value".
      expect(result.effectiveProperties?.['LifecycleConfiguration']).toEqual(liveLifecycle);
      // Every other key rides through untouched — `effectiveProperties`
      // REPLACES the desired bag wholesale, so it has to be complete.
      expect(result.effectiveProperties?.['BucketName']).toBe(BUCKET);
    });
  }

  it('lifecycle: an ABSENT previous value removes the key rather than recording undefined', async () => {
    const properties = { BucketName: BUCKET, LifecycleConfiguration: malformedLifecycle(1) };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
    });

    expect(result.effectiveProperties).toBeDefined();
    // `in`, not a value compare: an explicit `undefined` survives a value
    // assertion but is dropped by `JSON.stringify` on one side of the next
    // diff and not the other.
    expect('LifecycleConfiguration' in result.effectiveProperties!).toBe(false);
  });

  it('versioning: a skipped PutBucketVersioning retains the previous block', async () => {
    const properties = { BucketName: BUCKET, VersioningConfiguration: { Status: ['Enabled'] } };
    const previousProperties = {
      BucketName: BUCKET,
      VersioningConfiguration: { Status: 'Enabled' },
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      ...previousProperties,
    });

    expect(sentCommands(PutBucketVersioningCommand)).toHaveLength(0);
    expect(result.effectiveProperties?.['VersioningConfiguration']).toEqual({ Status: 'Enabled' });
  });

  it('versioning: Object Lock blocking a suspend records the still-Enabled previous block', async () => {
    // A warn-and-skip arm reached by a structural AWS constraint rather than a
    // malformed value — same state consequence, so the same remedy.
    const previousProperties = {
      BucketName: BUCKET,
      ObjectLockEnabled: true,
      VersioningConfiguration: { Status: 'Enabled' },
    };
    const properties = {
      BucketName: BUCKET,
      ObjectLockEnabled: true,
      VersioningConfiguration: { Status: 'Suspended' },
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      ...previousProperties,
    });

    expect(sentCommands(PutBucketVersioningCommand)).toHaveLength(0);
    expect(result.effectiveProperties?.['VersioningConfiguration']).toEqual({ Status: 'Enabled' });
  });
});

describe('UPDATE: a skipped PER-ITEM Put substitutes that item IN PLACE', () => {
  it('intelligent tiering: keeps the previous item, in the DESIRED position', async () => {
    // The skipped item is FIRST and the previous array holds it LAST, so an
    // implementation that appends retained items instead of substituting them
    // produces `[good, previousBad]` and fails here. With the skipped item
    // last, both orders coincide and the mutation is invisible.
    const previousBad = { Id: 'bad', Status: 'Disabled', Tierings: TIERINGS };
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [
        { Id: 'bad', Status: 1, Tierings: TIERINGS },
        { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
      ],
    };
    const previousProperties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [
        { Id: 'good', Status: 'Disabled', Tierings: TIERINGS },
        previousBad,
      ],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      ...previousProperties,
    });

    // The valid sibling DID apply — the Put is per-Id, so only the malformed
    // item is skipped.
    const sent = sentCommands(PutBucketIntelligentTieringConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input['Id']).toBe('good');

    expect(result.effectiveProperties?.['IntelligentTieringConfigurations']).toEqual([
      previousBad,
      { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
    ]);
  });

  it('intelligent tiering: a skipped ADD is DROPPED, since AWS holds nothing for that Id', async () => {
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [
        { Id: 'added', Status: 1, Tierings: TIERINGS },
        { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
      ],
    };
    const previousProperties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [{ Id: 'good', Status: 'Disabled', Tierings: TIERINGS }],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      ...previousProperties,
    });

    expect(result.effectiveProperties?.['IntelligentTieringConfigurations']).toEqual([
      { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
    ]);
  });

  it('intelligent tiering: every item skipped with NO previous array removes the key', async () => {
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [{ Id: 'added', Status: 1, Tierings: TIERINGS }],
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
    });

    expect(result.effectiveProperties).toBeDefined();
    expect('IntelligentTieringConfigurations' in result.effectiveProperties!).toBe(false);
  });
});

describe('replay-CREATE: a skip DROPS the key, because nothing was ever applied', () => {
  it('lifecycle: the skipped block is absent from the recorded bag', async () => {
    const properties = { BucketName: BUCKET, LifecycleConfiguration: malformedLifecycle(1) };

    const result = await provider.create('B', RESOURCE_TYPE, properties, { replayingState: true });

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    expect(result.effectiveProperties).toBeDefined();
    expect('LifecycleConfiguration' in result.effectiveProperties!).toBe(false);
    expect(result.effectiveProperties?.['BucketName']).toBe(BUCKET);
  });

  it('intelligent tiering: only the skipped ITEM is dropped, the applied ones stay', async () => {
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [
        { Id: 'bad', Status: 1, Tierings: TIERINGS },
        { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
      ],
    };

    const result = await provider.create('B', RESOURCE_TYPE, properties, { replayingState: true });

    expect(result.effectiveProperties?.['IntelligentTieringConfigurations']).toEqual([
      { Id: 'good', Status: 'Enabled', Tierings: TIERINGS },
    ]);
  });

  it('versioning: the skipped block is absent, so state does not claim a versioned bucket', async () => {
    const properties = { BucketName: BUCKET, VersioningConfiguration: { Status: null } };

    const result = await provider.create('B', RESOURCE_TYPE, properties, { replayingState: true });

    expect(sentCommands(PutBucketVersioningCommand)).toHaveLength(0);
    expect('VersioningConfiguration' in result.effectiveProperties!).toBe(false);
  });
});

describe('nothing skipped: `effectiveProperties` stays ABSENT', () => {
  it('update: an ordinary configuration change records the desired bag unchanged', async () => {
    const properties = {
      BucketName: BUCKET,
      LifecycleConfiguration: { Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 10 }] },
    };

    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, properties, {
      BucketName: BUCKET,
      LifecycleConfiguration: liveLifecycle,
    });

    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    // Absent, NOT "equal to properties": the engine gates on `??`, so an
    // implementation that always answers is a rewrite of the record on every
    // deploy and a value compare cannot see it.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('template-path create: no downgrade is reachable, so nothing is recorded', async () => {
    const properties = {
      BucketName: BUCKET,
      IntelligentTieringConfigurations: [{ Id: 'good', Status: 'Enabled', Tierings: TIERINGS }],
    };

    const result = await provider.create('B', RESOURCE_TYPE, properties);

    expect(sentCommands(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(1);
    expect(result.effectiveProperties).toBeUndefined();
  });
});
