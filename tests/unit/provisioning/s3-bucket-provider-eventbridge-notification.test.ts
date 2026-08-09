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

    it('round-trips: the read shape is what the write side accepts', async () => {
      // The two halves have to agree, or a drift REVERT would re-send a shape
      // the write path misreads. Feed the reader's output straight back in.
      const notification = await readNotification({});
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
      const cfg = (call as PutBucketNotificationConfigurationCommand).input
        .NotificationConfiguration as Record<string, unknown>;
      expect(cfg.EventBridgeConfiguration).toEqual({});
    });
  });
});
