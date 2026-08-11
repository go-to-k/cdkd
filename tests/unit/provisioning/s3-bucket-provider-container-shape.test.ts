import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketAnalyticsConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1581: the malformed-CONTAINER class one level up from the #1579
 * `TagFilters` guard, on containers whose members are probed for PRESENCE
 * rather than read as a string — so neither `readConfigString` (which needs a
 * string read) nor `requireConfigArray` (which needs a list) ever fired.
 *
 * Two live hazards, both silent:
 *
 * 1. **Lifecycle `Filter`.** A non-object `Filter` indexed every probe in
 *    `gatherScope` to `undefined`, so the rule kept NO scope and fell through
 *    to the empty-prefix V2 `Filter` — an expiration rule then applied to the
 *    WHOLE bucket (the #1388 hazard through the parent container).
 * 2. **Analytics `StorageClassAnalysis`.** A non-object container indexed the
 *    `DataExport` probe to `undefined`, so the data export vanished and the
 *    Put carried `StorageClassAnalysis: {}` — which S3 ACCEPTS as "no export",
 *    so nothing surfaced.
 *
 * Same #1556 split as its siblings: REFUSE on a template-path create, WARN and
 * skip on the state-replay paths. The skip UNIT differs by API — the lifecycle
 * Put replaces every rule, so the whole configuration is left alone, while the
 * analytics Put is per-Id and only the malformed item is skipped.
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
const BUCKET = 'container-shape-bucket';

const FILTER_PATH = 'AWS::S3::Bucket LifecycleConfiguration.Rules[].Filter';
const SCA_PATH = 'AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis';
const DATA_EXPORT_PATH = `${SCA_PATH}.DataExport`;

const VALID_DATA_EXPORT = {
  OutputSchemaVersion: 'V_1',
  Destination: { BucketArn: 'arn:aws:s3:::analytics-dest', Format: 'CSV' },
};

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

const lifecycleProps = (rule: Record<string, unknown>) => ({
  BucketName: BUCKET,
  LifecycleConfiguration: { Rules: [{ Id: 'probe', Status: 'Enabled', ...rule }] },
});
const analyticsProps = (config: Record<string, unknown>) => ({
  BucketName: BUCKET,
  AnalyticsConfigurations: [{ Id: 'probe', ...config }],
});

// Each is truthy-or-falsy but NOT a plain object, i.e. every probe of it
// indexes to `undefined`. The ARRAY is the one a bare `typeof === 'object'`
// check would have waved through.
const malformedContainers: Array<[string, unknown]> = [
  ['a string (an unresolved intrinsic collapsed to text)', 'logs/'],
  ['an array', [{ Prefix: 'logs/' }]],
  ['a number', 42],
];

describe('create path: a non-object container is REFUSED, not silently emptied', () => {
  for (const [label, value] of malformedContainers) {
    it(`lifecycle: refuses a Filter that is ${label}, and sends NO lifecycle Put`, async () => {
      await expect(
        provider.create(
          'B',
          RESOURCE_TYPE,
          lifecycleProps({ ExpirationInDays: 30, Filter: value })
        )
      ).rejects.toThrow(`${FILTER_PATH} must be an object`);
      expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    });

    it(`analytics: refuses a StorageClassAnalysis that is ${label}`, async () => {
      await expect(
        provider.create('B', RESOURCE_TYPE, analyticsProps({ StorageClassAnalysis: value }))
      ).rejects.toThrow(`${SCA_PATH} must be an object`);
      expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
    });

    it(`analytics: refuses a DataExport that is ${label}`, async () => {
      await expect(
        provider.create(
          'B',
          RESOURCE_TYPE,
          analyticsProps({ StorageClassAnalysis: { DataExport: value } })
        )
      ).rejects.toThrow(`${DATA_EXPORT_PATH} must be an object`);
      expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
    });
  }

  it('the refusal fires BEFORE the widened-scope rule can reach S3', async () => {
    // The regression this exists for: with the malformed Filter dropped
    // silently, the rule below reached S3 as a bucket-wide 30-day expiration.
    // Asserting only "it throws" would also pass if the Put had already gone
    // out, so pin the absence of the request itself.
    await expect(
      provider.create(
        'B',
        RESOURCE_TYPE,
        lifecycleProps({ ExpirationInDays: 30, Filter: 'archive/' })
      )
    ).rejects.toThrow(/must be an object/);
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('one malformed rule refuses the WHOLE configuration, not just that rule', async () => {
    // The Put replaces every rule, so applying the valid sibling alone would
    // DELETE the malformed rule from AWS — a destructive "partial success".
    await expect(
      provider.create('B', RESOURCE_TYPE, {
        BucketName: BUCKET,
        LifecycleConfiguration: {
          Rules: [
            { Id: 'good', Status: 'Enabled', ExpirationInDays: 10, Filter: { Prefix: 'a/' } },
            { Id: 'bad', Status: 'Enabled', ExpirationInDays: 30, Filter: 'b/' },
          ],
        },
      })
    ).rejects.toThrow(`${FILTER_PATH} must be an object`);
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });
});

describe('no false refusal: well-formed and absent containers still apply', () => {
  it('lifecycle: a valid Filter keeps its scope', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, Filter: { Prefix: 'logs/' } })
    );
    const sent = sentCommands(PutBucketLifecycleConfigurationCommand);
    expect(sent).toHaveLength(1);
    const rule = (sent[0]!.input.LifecycleConfiguration?.Rules ?? [])[0] as unknown as Record<
      string,
      unknown
    >;
    expect(rule['Filter']).toEqual({ Prefix: 'logs/' });
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('lifecycle: an EMPTY Filter object is legitimate (a whole-bucket rule the template asked for)', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, Filter: {} })
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
  });

  it('lifecycle: an explicit NULL Filter means "block omitted" and keeps the V1 Prefix form', async () => {
    // The `!= null` alignment: the strict `!== undefined` compare used to read
    // `null` as PRESENT and force every rule into V2 Filter form, disagreeing
    // with the container guard one line up which treats it as absent.
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, Prefix: 'logs/', Filter: null })
    );
    const sent = sentCommands(PutBucketLifecycleConfigurationCommand);
    expect(sent).toHaveLength(1);
    const rule = (sent[0]!.input.LifecycleConfiguration?.Rules ?? [])[0] as unknown as Record<
      string,
      unknown
    >;
    expect(rule['Prefix']).toBe('logs/');
    expect(rule['Filter']).toBeUndefined();
  });

  it('analytics: a valid StorageClassAnalysis.DataExport still reaches S3', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      analyticsProps({ StorageClassAnalysis: { DataExport: VALID_DATA_EXPORT } })
    );
    const sent = sentCommands(PutBucketAnalyticsConfigurationCommand);
    expect(sent).toHaveLength(1);
    const dataExport = sent[0]!.input.AnalyticsConfiguration?.StorageClassAnalysis?.DataExport;
    expect(dataExport?.OutputSchemaVersion).toBe('V_1');
    expect(dataExport?.Destination?.S3BucketDestination?.Bucket).toBe(
      'arn:aws:s3:::analytics-dest'
    );
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('analytics: an ABSENT StorageClassAnalysis still applies with the empty block', async () => {
    await provider.create('B', RESOURCE_TYPE, analyticsProps({ Prefix: 'logs/' }));
    const sent = sentCommands(PutBucketAnalyticsConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.AnalyticsConfiguration?.StorageClassAnalysis).toEqual({});
  });
});

describe('replay create (`replayingState`): warn and skip instead of stranding the rollback', () => {
  it('lifecycle: warns and leaves the WHOLE live configuration alone', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, Filter: 'logs/' }),
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${FILTER_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('analytics: warns, skips the malformed item, still applies the valid sibling', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      {
        BucketName: BUCKET,
        AnalyticsConfigurations: [
          { Id: 'bad', StorageClassAnalysis: 'nope' },
          { Id: 'good', StorageClassAnalysis: { DataExport: VALID_DATA_EXPORT } },
        ],
      },
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${SCA_PATH} must be an object`)
    );
    const sent = sentCommands(PutBucketAnalyticsConfigurationCommand);
    expect(sent.map((c) => c.input.Id)).toEqual(['good']);
  });

  it('analytics: a malformed DataExport no longer HARD-THROWS on a replay', async () => {
    // Before this change the block was refused only indirectly, by the
    // `readConfigString(dataExport, 'OutputSchemaVersion', …)` below it — which
    // carries no downgrade, so a historical state record with a malformed
    // DataExport made the resource un-rollbackable.
    await provider.create(
      'B',
      RESOURCE_TYPE,
      analyticsProps({ StorageClassAnalysis: { DataExport: 'nope' } }),
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${DATA_EXPORT_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
  });
});

describe('update path: warn and skip (the desired bag can be a historical state record)', () => {
  async function update(properties: Record<string, unknown>): Promise<void> {
    await provider.update('B', BUCKET, RESOURCE_TYPE, properties, { BucketName: BUCKET });
  }

  it('lifecycle: warns and does NOT send the Put', async () => {
    await update(lifecycleProps({ ExpirationInDays: 30, Filter: 'logs/' }));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${FILTER_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('analytics: warns on a malformed StorageClassAnalysis and does NOT send the Put', async () => {
    await update(analyticsProps({ StorageClassAnalysis: 'nope' }));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${SCA_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
  });

  it('analytics: warns on a malformed DataExport and does NOT send the Put', async () => {
    await update(analyticsProps({ StorageClassAnalysis: { DataExport: 42 } }));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${DATA_EXPORT_PATH} must be an object`)
    );
    expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
  });

  it('a VALID container still applies on the update path (the guard is shape-only)', async () => {
    await update(lifecycleProps({ ExpirationInDays: 30, Filter: { Prefix: 'logs/' } }));
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });
});
