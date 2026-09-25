import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketTaggingCommand,
  PutBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
} from '@aws-sdk/client-s3';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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
import { getLogger } from '../../../src/utils/logger.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const childLogger = (
  getLogger() as unknown as { child: () => { warn: ReturnType<typeof vi.fn> } }
).child();

const BUCKET = 'my-bucket';
const RESOURCE_TYPE = 'AWS::S3::Bucket';
const DEST_ARN = 'arn:aws:s3:::dest-bucket';

const warnings = (): string => childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
const writes = (): unknown[] =>
  mockSend.mock.calls.map((c) => c[0]).filter((cmd) => !(cmd instanceof GetBucketLocationCommand));

/**
 * One row per per-config applier `applySubConfigDiffs` hands a warn callback:
 * the property, a malformed DESIRED value, a usable PREVIOUS one, and the
 * create-path refusal that applier throws for it.
 */
const APPLIERS: Array<{ applier: string; key: string; malformed: unknown; previous: unknown; refusal: RegExp }> = [
  {
    applier: 'lifecycle',
    key: 'LifecycleConfiguration',
    malformed: { Rules: [{ Id: 'r1', Status: null, ExpirationInDays: 30 }] },
    previous: { Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 30 }] },
    refusal: /LifecycleConfiguration\.Rules\[\]\.Status must be a non-empty string/,
  },
  {
    applier: 'notification',
    key: 'NotificationConfiguration',
    malformed: { EventBridgeConfiguration: { EventBridgeEnabled: 'yes' } },
    previous: { EventBridgeConfiguration: { EventBridgeEnabled: true } },
    refusal: /EventBridgeConfiguration\.EventBridgeEnabled must be a boolean/,
  },
  {
    applier: 'replication',
    key: 'ReplicationConfiguration',
    malformed: {
      Role: 'arn:aws:iam::123456789012:role/r',
      Rules: [{ Id: 'x', Status: null, Destination: { Bucket: DEST_ARN } }],
    },
    previous: {
      Role: 'arn:aws:iam::123456789012:role/r',
      Rules: [{ Id: 'x', Status: 'Enabled', Destination: { Bucket: DEST_ARN } }],
    },
    refusal: /ReplicationConfiguration\.Rules\[\]\.Status must be a non-empty string/,
  },
  {
    applier: 'object lock',
    key: 'ObjectLockConfiguration',
    malformed: {
      ObjectLockEnabled: 'Enabled',
      Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 1, DefaultEventHold: 'on' } },
    },
    previous: {
      ObjectLockEnabled: 'Enabled',
      Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 1 } },
    },
    refusal: /ObjectLockConfiguration\.Rule\.DefaultRetention\.DefaultEventHold must be an object/,
  },
  {
    applier: 'metrics',
    key: 'MetricsConfigurations',
    malformed: [{ Id: 'm1', TagFilters: 'k=v' }],
    previous: [{ Id: 'm1', Prefix: 'logs/' }],
    refusal: /MetricsConfigurations\[\]\.TagFilters must be an array/,
  },
  {
    applier: 'analytics',
    key: 'AnalyticsConfigurations',
    malformed: [{ Id: 'a1', StorageClassAnalysis: 'oops' }],
    previous: [{ Id: 'a1', StorageClassAnalysis: {} }],
    refusal: /AnalyticsConfigurations\[\]\.StorageClassAnalysis must be an object/,
  },
  {
    applier: 'intelligent tiering',
    key: 'IntelligentTieringConfigurations',
    malformed: [{ Id: 't1', Status: null, Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] }],
    previous: [{ Id: 't1', Status: 'Enabled', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] }],
    refusal: /IntelligentTieringConfigurations\[\]\.Status must be a non-empty string/,
  },
  {
    applier: 'inventory',
    key: 'InventoryConfigurations',
    malformed: [
      {
        Id: 'i1',
        Enabled: true,
        IncludedObjectVersions: null,
        ScheduleFrequency: 'Daily',
        Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
      },
    ],
    previous: [
      {
        Id: 'i1',
        Enabled: true,
        IncludedObjectVersions: 'All',
        ScheduleFrequency: 'Daily',
        Destination: { BucketArn: DEST_ARN, Format: 'CSV' },
      },
    ],
    refusal: /InventoryConfigurations\[\]\.IncludedObjectVersions must be a non-empty string/,
  },
];

/**
 * Issue #3740 (the #3728 shape, widened to the per-config appliers): each of
 * the eight appliers warn-and-skips a malformed value on every update caller,
 * and each runs MID-update, so it cannot refuse in place without stranding the
 * configurations applied before it. A template-path update now refuses a
 * malformed value the diff would actually Put BEFORE any call — the region
 * probe included — by running `applySubConfigDiffs` on a probe whose S3 client
 * writes nothing; the rollback revert arms (`replayingState`) and
 * `cdkd drift --revert` (`desiredFromAwsReadback`) keep the warning.
 */
describe('S3BucketProvider per-config appliers: template refuses, replay warns (issue #3740)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    mockSend.mockReset();
    vi.clearAllMocks();
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd instanceof GetBucketLocationCommand ? { LocationConstraint: null } : {})
    );
    provider = new S3BucketProvider();
  });

  const edit = (key: string, desired: unknown, previous: unknown, context?: Record<string, unknown>) =>
    provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      // A tag change rides along, so "nothing was applied" is observable.
      { BucketName: BUCKET, [key]: desired, Tags: [{ Key: 'k', Value: 'v2' }] },
      { BucketName: BUCKET, [key]: previous, Tags: [{ Key: 'k', Value: 'v1' }] },
      context
    );

  describe.each(APPLIERS)('$applier', ({ key, malformed, previous, refusal }) => {
    it.each([
      ['no context', undefined],
      ['both flags false', { replayingState: false, desiredFromAwsReadback: false }],
    ])('REFUSES on a template-path update (%s), before any AWS call', async (_label, context) => {
      const error = await edit(key, malformed, previous, context).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toMatch(refusal);
      expect((error as Error).message).toMatch(
        /Nothing was applied to bucket my-bucket; fix the template value$/
      );
      // Not even the region probe: the probe's client is not `mockSend`.
      expect(mockSend).not.toHaveBeenCalled();
      expect(childLogger.warn).not.toHaveBeenCalled();
    });

    it.each([
      ['a rollback revert arm (replayingState)', { replayingState: true }],
      ['cdkd drift --revert (desiredFromAwsReadback)', { desiredFromAwsReadback: true }],
    ])('keeps the warning on %s, and the rest of the update proceeds', async (_label, context) => {
      await expect(edit(key, malformed, previous, context)).resolves.toBeDefined();

      expect(warnings()).toMatch(refusal);
      expect(writes().some((cmd) => cmd instanceof PutBucketTaggingCommand)).toBe(true);
    });

    it('does NOT refuse on the template path when the value is UNCHANGED from the record', async () => {
      await expect(edit(key, malformed, malformed)).resolves.toBeDefined();
      expect(writes().some((cmd) => cmd instanceof PutBucketTaggingCommand)).toBe(true);
    });
  });

  it('the probe writes NOTHING and warns NOTHING: a valid template-path update Puts once, warns once', async () => {
    // A usable lifecycle change plus an empty CORS collection, whose skip
    // WARNS (issue #1713). Both run twice — once on the probe, once for real —
    // so any leak from the probe shows up as a doubled Put or warning.
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      {
        BucketName: BUCKET,
        LifecycleConfiguration: { Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 7 }] },
        CorsConfiguration: { CorsRules: [] },
      },
      {
        BucketName: BUCKET,
        LifecycleConfiguration: { Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 30 }] },
        CorsConfiguration: { CorsRules: [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'] }] },
      }
    );

    expect(
      writes().filter((cmd) => cmd instanceof PutBucketLifecycleConfigurationCommand)
    ).toHaveLength(1);
    expect(childLogger.warn.mock.calls.filter((c) => /CorsRules/.test(String(c[0])))).toHaveLength(1);
  });

  it('a refused item among several is refused as a whole: no sibling item is Put', async () => {
    const error = await edit(
      'MetricsConfigurations',
      [{ Id: 'ok', Prefix: 'a/' }, { Id: 'bad', TagFilters: 'k=v' }],
      []
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
