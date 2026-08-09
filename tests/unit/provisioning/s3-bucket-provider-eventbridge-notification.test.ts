import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetBucketNotificationConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1430 regression coverage for the two `EventBridgeConfiguration`
 * defects the S3 nested-key critic surfaced when `AWS::S3::Bucket` joined
 * `NESTED_KEY_TARGETS`.
 *
 * The two sides model the block DIFFERENTLY, which is the whole problem:
 *
 * - CFn's `EventBridgeConfiguration` carries a REQUIRED boolean
 *   `EventBridgeEnabled` (verified against aws-cdk-lib 2.244.0's
 *   `convertCfnBucketEventBridgeConfigurationPropertyToCloudFormation`, which
 *   renders exactly `{ EventBridgeEnabled: <bool> }`).
 * - The SDK's `EventBridgeConfiguration` is an EMPTY interface
 *   (`@aws-sdk/client-s3` `models_0.d.ts`) — PRESENCE enables delivery,
 *   ABSENCE disables it. There is no member for the boolean to land on.
 *
 * So the critic bucketed `EventBridgeEnabled` as `no-sdk-member`, and both
 * directions of the translation were wrong:
 *
 * 1. WRITE — the provider emitted the SDK block whenever the CFn block
 *    existed, so an explicit `EventBridgeEnabled: false` ENABLED EventBridge
 *    delivery: the inverse of the template's intent.
 * 2. READ — `readCurrentState` returned the SDK's `{}` shape, but cdkd's
 *    state baseline holds the CFn spelling and `drift-calculator` only
 *    descends into keys present in state, so the boolean read back as
 *    permanently missing on every EventBridge-enabled bucket.
 */

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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

const BUCKET_NAME = 'my-bucket';
const RESOURCE_TYPE = 'AWS::S3::Bucket';

describe('S3 NotificationConfiguration.EventBridgeConfiguration (issue #1430)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketProvider();
    mockSend.mockResolvedValue({});
  });

  describe('write side: EventBridgeEnabled -> SDK block presence', () => {
    /**
     * Drive the update path with the given CFn `EventBridgeConfiguration` and
     * return the `NotificationConfiguration` that reached
     * `PutBucketNotificationConfiguration`.
     */
    const putNotification = async (
      eventBridgeConfiguration: unknown
    ): Promise<Record<string, unknown>> => {
      await provider.update(
        'L',
        BUCKET_NAME,
        RESOURCE_TYPE,
        {
          BucketName: BUCKET_NAME,
          NotificationConfiguration: { EventBridgeConfiguration: eventBridgeConfiguration },
        },
        { BucketName: BUCKET_NAME }
      );
      const call = mockSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof PutBucketNotificationConfigurationCommand);
      expect(call).toBeDefined();
      return (call as PutBucketNotificationConfigurationCommand).input
        .NotificationConfiguration as Record<string, unknown>;
    };

    it('emits the empty SDK block for EventBridgeEnabled: true', async () => {
      const cfg = await putNotification({ EventBridgeEnabled: true });
      expect(cfg.EventBridgeConfiguration).toEqual({});
    });

    it('OMITS the block for EventBridgeEnabled: false (pre-fix it enabled delivery)', async () => {
      const cfg = await putNotification({ EventBridgeEnabled: false });
      expect(cfg.EventBridgeConfiguration).toBeUndefined();
    });

    it('OMITS the block for the stringly-typed CFn "false"', async () => {
      // CFn is stringly typed; a hand-written / imported template can carry
      // the boolean as a string and must not flip the meaning.
      const cfg = await putNotification({ EventBridgeEnabled: 'false' });
      expect(cfg.EventBridgeConfiguration).toBeUndefined();
    });

    it.each(['True', 'TRUE'])('emits the block for the case-variant "%s"', async (value) => {
      // The positive direction of the same coercion. It shares a call site
      // with `ExpiredObjectDeleteMarker`, where a `'True'` falling through to
      // `undefined` used to DROP the marker and leave the rule action-less —
      // so both directions are worth pinning.
      const cfg = await putNotification({ EventBridgeEnabled: value });
      expect(cfg.EventBridgeConfiguration).toEqual({});
    });

    it.each(['False', 'FALSE'])('OMITS the block for the case-variant "%s"', async (value) => {
      // This is the ONE call site where "not false" means "turn it on", so a
      // spelling that falls through to `undefined` would silently ENABLE
      // delivery -- the exact inversion this fix exists to close.
      const cfg = await putNotification({ EventBridgeEnabled: value });
      expect(cfg.EventBridgeConfiguration).toBeUndefined();
    });

    it('tolerates a null block instead of throwing', async () => {
      // The condition now READS a member off the block, so a hand-written or
      // intrinsic-resolved `null` would throw where the pre-fix
      // `eb !== undefined` test merely emitted. Non-objects stay on the
      // enable-on-presence side.
      const cfg = await putNotification(null);
      expect(cfg.EventBridgeConfiguration).toEqual({});
    });

    it('leaves sibling Topic configurations untouched when EventBridge is false', async () => {
      await provider.update(
        'L',
        BUCKET_NAME,
        RESOURCE_TYPE,
        {
          BucketName: BUCKET_NAME,
          NotificationConfiguration: {
            EventBridgeConfiguration: { EventBridgeEnabled: false },
            TopicConfigurations: [{ Topic: 'arn:aws:sns:us-east-1:1:t', Event: 's3:ObjectCreated:*' }],
          },
        },
        { BucketName: BUCKET_NAME }
      );
      const call = mockSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof PutBucketNotificationConfigurationCommand);
      const cfg = (call as PutBucketNotificationConfigurationCommand).input
        .NotificationConfiguration as Record<string, unknown>;
      expect(cfg.EventBridgeConfiguration).toBeUndefined();
      expect(cfg.TopicConfigurations).toHaveLength(1);
    });

    it('turns delivery OFF on a true -> false UPDATE flip', async () => {
      // The user-visible scenario this fix creates: a live bucket with
      // EventBridge on, whose template flips the boolean. Every other write
      // test starts from a bare previous state, so none of them exercise it.
      await provider.update(
        'L',
        BUCKET_NAME,
        RESOURCE_TYPE,
        {
          BucketName: BUCKET_NAME,
          NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: false } },
        },
        {
          BucketName: BUCKET_NAME,
          NotificationConfiguration: { EventBridgeConfiguration: { EventBridgeEnabled: true } },
        }
      );
      const call = mockSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof PutBucketNotificationConfigurationCommand);
      expect(call, 'the flip must actually issue a Put').toBeDefined();
      const cfg = (call as PutBucketNotificationConfigurationCommand).input
        .NotificationConfiguration as Record<string, unknown>;
      expect(cfg.EventBridgeConfiguration).toBeUndefined();
    });

    it('emits the block for the stringly-typed CFn "true"', async () => {
      const cfg = await putNotification({ EventBridgeEnabled: 'true' });
      expect(cfg.EventBridgeConfiguration).toEqual({});
    });

    it('keeps enable-on-presence when the boolean is absent or unresolved', async () => {
      // An unresolved intrinsic must not silently DISABLE a block the
      // template asked for — the pre-#1430 behavior is the safe side here.
      expect((await putNotification({})).EventBridgeConfiguration).toEqual({});
      vi.clearAllMocks();
      mockSend.mockResolvedValue({});
      expect(
        (await putNotification({ EventBridgeEnabled: { Ref: 'SomeParam' } }))
          .EventBridgeConfiguration
      ).toEqual({});
    });

    it('leaves the block out entirely when the CFn block is absent', async () => {
      await provider.update(
        'L',
        BUCKET_NAME,
        RESOURCE_TYPE,
        {
          BucketName: BUCKET_NAME,
          NotificationConfiguration: { TopicConfigurations: [] },
        },
        { BucketName: BUCKET_NAME }
      );
      const call = mockSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof PutBucketNotificationConfigurationCommand);
      const cfg = (call as PutBucketNotificationConfigurationCommand).input
        .NotificationConfiguration as Record<string, unknown>;
      expect(cfg.EventBridgeConfiguration).toBeUndefined();
    });
  });

  describe('read side: readCurrentState returns the CFn shape', () => {
    /**
     * `readCurrentState` fans out one Get* per sub-config through
     * `Promise.all`, so responses cannot be queued positionally with
     * `mockResolvedValueOnce`. Dispatch on the command instead and let every
     * other read fall through to the "not configured" default.
     */
    const readNotification = async (
      eventBridgeConfiguration: Record<string, never> | undefined
    ): Promise<Record<string, unknown>> => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof GetBucketNotificationConfigurationCommand) {
          return Promise.resolve(
            eventBridgeConfiguration === undefined
              ? {}
              : { EventBridgeConfiguration: eventBridgeConfiguration }
          );
        }
        return Promise.resolve({});
      });
      const state = await provider.readCurrentState(BUCKET_NAME, 'L', RESOURCE_TYPE);
      return (state as Record<string, unknown>)['NotificationConfiguration'] as Record<
        string,
        unknown
      >;
    };

    it('maps the SDK empty block back to EventBridgeEnabled: true', async () => {
      // Pre-fix this returned `{}`, so a state baseline holding
      // `{ EventBridgeEnabled: true }` reported permanent phantom drift.
      const notification = await readNotification({});
      expect(notification['EventBridgeConfiguration']).toEqual({ EventBridgeEnabled: true });
    });

    it('emits EventBridgeEnabled: false when the response omits the block', async () => {
      // Always-emit keeps the disabled side comparable too, matching the
      // placeholder convention every other reader in this provider follows.
      const notification = await readNotification(undefined);
      expect(notification['EventBridgeConfiguration']).toEqual({ EventBridgeEnabled: false });
    });

    /** Feed a `readNotification` result straight back into the write path. */
    const roundTrip = async (
      notification: Record<string, unknown>
    ): Promise<Record<string, unknown>> => {
      vi.clearAllMocks();
      mockSend.mockResolvedValue({});
      await provider.update(
        'L',
        BUCKET_NAME,
        RESOURCE_TYPE,
        { BucketName: BUCKET_NAME, NotificationConfiguration: notification },
        { BucketName: BUCKET_NAME }
      );
      const call = mockSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof PutBucketNotificationConfigurationCommand);
      expect(call).toBeDefined();
      return (call as PutBucketNotificationConfigurationCommand).input
        .NotificationConfiguration as Record<string, unknown>;
    };

    it('round-trips the ENABLED shape: read output re-sends as enabled', async () => {
      const notification = await readNotification({});
      expect(await roundTrip(notification)).toMatchObject({ EventBridgeConfiguration: {} });
    });

    it('round-trips the DISABLED shape: read output must NOT re-enable delivery', async () => {
      // This is the discriminating direction, and the one that matters: a
      // `cdkd drift --revert` feeds the reader's output back through the write
      // path, so if `{EventBridgeEnabled: false}` came back out as an emitted
      // block, a revert would silently turn EventBridge ON.
      //
      // The enabled case above passes even with the read fix reverted (the old
      // reader returned `{}`, which the write path also emits as `{}`), so it
      // pins nothing on its own.
      const notification = await readNotification(undefined);
      expect(notification['EventBridgeConfiguration']).toEqual({ EventBridgeEnabled: false });
      expect((await roundTrip(notification)).EventBridgeConfiguration).toBeUndefined();
    });
  });
});
