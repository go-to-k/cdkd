import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketAnalyticsConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1493 items 2 and 3, on the analytics / inventory `Destination` block.
 *
 * **Item 2 — the silent DROP.** Both appliers picked between the CFn FLATTENED
 * shape (`Destination: { BucketArn, Format }`) and the SDK NESTED one
 * (`Destination: { S3BucketDestination: { ... } }`) by probing member presence.
 * A `Destination` that is a STRING / array / unresolved intrinsic indexed every
 * probe to `undefined`, fell through to an equally-`undefined`
 * `S3BucketDestination`, and the caller's `s3Dest ? … : undefined` omitted the
 * whole block from the Put — a configuration deployed with no destination and
 * no error anywhere. Unlike the sibling defaulting class (#1471 / #1471's `??`
 * spelling) nothing is DEFAULTED here, so `readConfigString` never covered it.
 *
 * The decision, per #1513's precedent: REFUSE on the template-borne create
 * path, WARN on the update path — `rollback-executor.ts` and `drift --revert`
 * replay `update()` with a historical cdkd STATE record as the desired bag, so
 * a refusal there would strand the resource with no template-side remedy.
 *
 * **Item 3 — the misnamed refusal.** The `containerPath` handed to
 * `readConfigString` hardcoded `…Destination.S3BucketDestination` even on the
 * FLATTENED branch, where the bag IS `dest` itself — so a refusal named a key
 * the user's template does not contain. Harmless to behavior, actively
 * misleading in the message.
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
const BUCKET = 'analytics-source-bucket';

const ANALYTICS_PATH =
  'AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis.DataExport.Destination';
const INVENTORY_PATH = 'AWS::S3::Bucket InventoryConfigurations[].Destination';

let provider: S3BucketProvider;

beforeEach(() => {
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new S3BucketProvider();
  mockSend.mockResolvedValue({});
});

/** An analytics configuration whose `Destination` is whatever the case supplies. */
function analyticsProps(destination: unknown): Record<string, unknown> {
  return {
    BucketName: BUCKET,
    AnalyticsConfigurations: [
      {
        Id: 'daily',
        StorageClassAnalysis: { DataExport: { OutputSchemaVersion: 'V_1', Destination: destination } },
      },
    ],
  };
}

/** An inventory configuration whose `Destination` is whatever the case supplies. */
function inventoryProps(destination: unknown): Record<string, unknown> {
  return {
    BucketName: BUCKET,
    InventoryConfigurations: [
      { Id: 'daily', Enabled: true, ScheduleFrequency: 'Daily', Destination: destination },
    ],
  };
}

function sentCommand<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandType: new (...args: any[]) => T
): T | undefined {
  return mockSend.mock.calls.map((c) => c[0]).find((c) => c instanceof commandType) as T | undefined;
}

async function update(properties: Record<string, unknown>): Promise<void> {
  await provider.update('B', BUCKET, RESOURCE_TYPE, properties, { BucketName: BUCKET });
}

describe('item 2: a malformed Destination is REFUSED on the create path', () => {
  // Each case is a value that indexed every branch probe to `undefined` and
  // therefore dropped the whole block. `''` is listed on purpose: it is FALSY,
  // so a guard written behind a truthiness gate would never see it.
  const malformed: Array<[string, unknown]> = [
    ['a string (an unresolved intrinsic collapsed to text)', 'arn:aws:s3:::reports'],
    ['an empty string', ''],
    ['an array', [{ BucketArn: 'arn:aws:s3:::reports' }]],
    ['a number', 42],
  ];

  for (const [label, destination] of malformed) {
    it(`analytics: refuses ${label}`, async () => {
      await expect(provider.create('B', RESOURCE_TYPE, analyticsProps(destination))).rejects.toThrow(
        `${ANALYTICS_PATH} must be an object`
      );
    });

    it(`inventory: refuses ${label}`, async () => {
      await expect(provider.create('B', RESOURCE_TYPE, inventoryProps(destination))).rejects.toThrow(
        `${INVENTORY_PATH} must be an object`
      );
    });
  }

  it('refuses a malformed NESTED S3BucketDestination, naming the nested path', async () => {
    await expect(
      provider.create('B', RESOURCE_TYPE, analyticsProps({ S3BucketDestination: 'arn:aws:s3:::r' }))
    ).rejects.toThrow(`${ANALYTICS_PATH}.S3BucketDestination must be an object`);
  });

  it('refuses an object carrying neither shape, rather than dropping it', async () => {
    await expect(provider.create('B', RESOURCE_TYPE, inventoryProps({}))).rejects.toThrow(
      `${INVENTORY_PATH} carries neither a bucket`
    );
  });

  it('leaves an ABSENT Destination to AWS — an omitted block is not a shape error', async () => {
    // The template's own omission, not a malformed value: AWS reports the
    // missing required destination, and cdkd must not turn that into a
    // different, cdkd-flavored error. Asserting the Put was still SENT (with
    // only Destination omitted) is the point — `resolves` alone would also
    // pass if the whole configuration had been skipped.
    await expect(
      provider.create('B', RESOURCE_TYPE, inventoryProps(undefined))
    ).resolves.toBeDefined();
    const put = sentCommand(PutBucketInventoryConfigurationCommand);
    expect(put).toBeDefined();
    expect(put?.input.InventoryConfiguration?.Id).toBe('daily');
    expect(put?.input.InventoryConfiguration?.Destination?.S3BucketDestination).toBeUndefined();
  });

  it('treats a null Destination as absent, not as a shape error', async () => {
    await expect(
      provider.create('B', RESOURCE_TYPE, inventoryProps(null))
    ).resolves.toBeDefined();
    expect(sentCommand(PutBucketInventoryConfigurationCommand)).toBeDefined();
  });

  it('refuses a bag carrying no destination bucket, in either shape', async () => {
    // `{ Format }` alone and `{ S3BucketDestination: {} }` both used to reach
    // the SDK as `Bucket: undefined`. The bucket is the one member neither
    // branch can default, so it is checked on the PICKED bag.
    await expect(
      provider.create('B', RESOURCE_TYPE, inventoryProps({ Format: 'CSV' }))
    ).rejects.toThrow('has no destination bucket');
    await expect(
      provider.create('B', RESOURCE_TYPE, inventoryProps({ S3BucketDestination: {} }))
    ).rejects.toThrow(`${INVENTORY_PATH}.S3BucketDestination has no destination bucket`);
  });

  it('downgrades to a warning when create() is replaying a STATE record', async () => {
    // `rollback-executor.ts`'s reverse-replacement arm revives the OLD resource
    // through create() with `replayingState: true`. A refusal there would leave
    // a bucket recorded by a pre-fix binary unrestorable, with only a hand-edit
    // of state.json as a remedy.
    await expect(
      provider.create('B', RESOURCE_TYPE, inventoryProps('arn:aws:s3:::reports'), {
        replayingState: true,
      })
    ).resolves.toBeDefined();
    expect(
      childLogger.warn.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes(`${INVENTORY_PATH} must be an object`))
    ).toBe(true);
    expect(sentCommand(PutBucketInventoryConfigurationCommand)).toBeUndefined();
  });

  it('keeps a falsy-but-defined flat key on the NESTED branch (no regression)', async () => {
    // `{ BucketAccountId: '', S3BucketDestination: {...} }` worked before this
    // change by falling to the nested branch. A presence-based probe would
    // re-route it to the flat bag and send `Bucket: undefined`.
    await update(
      inventoryProps({
        BucketAccountId: '',
        S3BucketDestination: { Bucket: 'arn:aws:s3:::reports', Format: 'CSV' },
      })
    );
    expect(
      sentCommand(PutBucketInventoryConfigurationCommand)?.input.InventoryConfiguration?.Destination
        ?.S3BucketDestination?.Bucket
    ).toBe('arn:aws:s3:::reports');
  });
});

describe('item 2: the same value only WARNS on the update path', () => {
  it('analytics: warns and leaves the live configuration untouched', async () => {
    await expect(update(analyticsProps('arn:aws:s3:::reports'))).resolves.toBeUndefined();

    const warning = childLogger.warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes(`${ANALYTICS_PATH} must be an object`));
    expect(warning, 'no warning named the malformed destination').toBeDefined();
    expect(warning).toContain('REFUSED on a template-path create');

    // NOT "sends the Put with Destination omitted": `Destination` is a REQUIRED
    // SDK member, so that request is rejected by S3 and the replay this warn
    // exists to unblock would be stranded anyway — just with an opaque AWS
    // error instead of cdkd's actionable one. Skipping the per-id Put is what
    // actually leaves the live configuration alone.
    expect(sentCommand(PutBucketAnalyticsConfigurationCommand)).toBeUndefined();
  });

  it('inventory: warns and leaves the live configuration untouched', async () => {
    await expect(update(inventoryProps(['not', 'an', 'object']))).resolves.toBeUndefined();

    expect(
      childLogger.warn.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes(`${INVENTORY_PATH} must be an object`))
    ).toBe(true);
    expect(sentCommand(PutBucketInventoryConfigurationCommand)).toBeUndefined();
  });

  it('warns instead of throwing on a malformed Format during an update', async () => {
    // The destination guard one line up deliberately warns on the update path;
    // a malformed `Format` must not hard-fail underneath it, or the
    // replay-safety invariant is only half true.
    await expect(
      update(inventoryProps({ BucketArn: 'arn:aws:s3:::reports', Format: 42 }))
    ).resolves.toBeUndefined();

    expect(
      childLogger.warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('Format'))
    ).toBe(true);
    expect(
      sentCommand(PutBucketInventoryConfigurationCommand)?.input.InventoryConfiguration?.Destination
        ?.S3BucketDestination?.Format
    ).toBe('CSV');
  });
});

describe('item 3: a refusal names the branch the template actually used', () => {
  it('FLATTENED branch: names Destination, not Destination.S3BucketDestination', async () => {
    // `Format: 42` is refused by `readConfigString`; before the fix the path it
    // was handed hardcoded the nested spelling, so the message pointed at a key
    // this template does not contain.
    const promise = provider.create(
      'B',
      RESOURCE_TYPE,
      analyticsProps({ BucketArn: 'arn:aws:s3:::reports', Format: 42 })
    );
    await expect(promise).rejects.toThrow(`${ANALYTICS_PATH}.Format`);
    await expect(promise).rejects.not.toThrow(`${ANALYTICS_PATH}.S3BucketDestination.Format`);
  });

  it('NESTED branch: still names Destination.S3BucketDestination', async () => {
    await expect(
      provider.create(
        'B',
        RESOURCE_TYPE,
        inventoryProps({ S3BucketDestination: { Bucket: 'arn:aws:s3:::reports', Format: 42 } })
      )
    ).rejects.toThrow(`${INVENTORY_PATH}.S3BucketDestination.Format`);
  });
});

describe('both legitimate shapes keep working', () => {
  it('analytics: FLATTENED (the CFn schema shape)', async () => {
    await update(
      analyticsProps({
        BucketArn: 'arn:aws:s3:::reports',
        BucketAccountId: '111122223333',
        Format: 'CSV',
        Prefix: 'analytics/',
      })
    );

    const dest = sentCommand(PutBucketAnalyticsConfigurationCommand)?.input.AnalyticsConfiguration
      ?.StorageClassAnalysis?.DataExport?.Destination?.S3BucketDestination;
    expect(dest).toMatchObject({
      Bucket: 'arn:aws:s3:::reports',
      BucketAccountId: '111122223333',
      Format: 'CSV',
      Prefix: 'analytics/',
    });
  });

  it('inventory: NESTED (the SDK shape a state record can carry)', async () => {
    await update(
      inventoryProps({
        S3BucketDestination: { Bucket: 'arn:aws:s3:::reports', Format: 'ORC', Prefix: 'inv/' },
      })
    );

    expect(
      sentCommand(PutBucketInventoryConfigurationCommand)?.input.InventoryConfiguration?.Destination
        ?.S3BucketDestination
    ).toMatchObject({ Bucket: 'arn:aws:s3:::reports', Format: 'ORC', Prefix: 'inv/' });
  });

  it('inventory: a FLATTENED block spelled `Bucket` is used, not dropped', async () => {
    // The readers accept `BucketArn ?? Bucket`, but `Bucket` was missing from
    // the branch probe — so a `{ Bucket }`-only block took the nested branch,
    // found nothing, and dropped. Same silent drop, one shape over.
    await update(inventoryProps({ Bucket: 'arn:aws:s3:::reports' }));

    expect(
      sentCommand(PutBucketInventoryConfigurationCommand)?.input.InventoryConfiguration?.Destination
        ?.S3BucketDestination?.Bucket
    ).toBe('arn:aws:s3:::reports');
  });
});
