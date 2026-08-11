import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketVersioningCommand,
  PutBucketLoggingCommand,
  PutBucketInventoryConfigurationCommand,
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

const childLogger = (
  getLogger() as unknown as { child: () => { warn: ReturnType<typeof vi.fn> } }
).child();

const BUCKET_NAME = 'my-bucket';

/**
 * Issue #1605: the FIELD-level S3 reads that were still hard refusals on the
 * replay-reachable paths.
 *
 * `.claude/rules/providers.md` records the rule these close: an UPDATE-path or
 * replay-reachable refusal must DOWNGRADE, because `rollback-executor.ts`'s
 * revert arm and `cdkd drift --revert` both call
 * `update(..., previousState.properties, ...)` and the reverse-replacement arm
 * calls `create(..., previousState.properties, REPLAYING_STATE_CREATE_CONTEXT)`
 * — so the DESIRED bag can be a historical cdkd STATE record with no
 * template-side remedy.
 *
 * #1595 applied that to the four per-ITEM reads, whose skip unit is obvious
 * from the API. These three were split out because the skip UNIT is the whole
 * question, and each answers it differently:
 *
 *   - versioning `Status`     -> SKIP the Put (the DEFAULT is the dangerous
 *                                direction here: #1471 measured it turning
 *                                versioning OFF on a live bucket)
 *   - logging destination     -> SKIP the Put (the default CLEARS access
 *                                logging, losing an audit trail silently)
 *   - inventory `ScheduleFrequency` -> FALL THROUGH to `Schedule.Frequency`,
 *                                and only skip the ITEM when that is unusable
 *                                too — a third downgrade shape neither #1581
 *                                nor #1595 needed
 *
 * Every case below asserts BOTH halves: the call that must NOT go out, and the
 * warning that makes the skip announced rather than silent.
 */
describe('S3 FIELD-level reads downgrade on a state replay (issue #1605)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    // `mockReset` over `clearAllMocks` per the repo convention: the latter
    // leaves any `mockResolvedValueOnce` queue intact across tests.
    mockSend.mockReset();
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new S3BucketProvider();
  });

  function callsOf(cmdClass: new (...args: never[]) => unknown): { input: unknown }[] {
    return mockSend.mock.calls
      .filter((c) => c[0] instanceof cmdClass)
      .map((c) => c[0] as { input: unknown });
  }

  function warnings(): string {
    return childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
  }

  const base = { BucketName: BUCKET_NAME };
  const update = (next: Record<string, unknown>, prev: Record<string, unknown>) =>
    provider.update('L', BUCKET_NAME, 'AWS::S3::Bucket', next, prev);
  const replayCreate = (props: Record<string, unknown>) =>
    provider.create('L', 'AWS::S3::Bucket', { BucketName: BUCKET_NAME, ...props }, {
      replayingState: true,
    });
  const templateCreate = (props: Record<string, unknown>) =>
    provider.create('L', 'AWS::S3::Bucket', { BucketName: BUCKET_NAME, ...props });

  // ---------------- VersioningConfiguration.Status ----------------

  describe('versioning Status', () => {
    it('a REPLAY create warns and leaves live versioning alone instead of throwing', async () => {
      // The reverse-replacement create revives the OLD bucket from its state
      // record. Before this change a record carrying a malformed
      // VersioningConfiguration made that bucket unrestorable, with a hand-edit
      // of state.json as the only remedy.
      await replayCreate({ VersioningConfiguration: 'Enabled' as never });
      expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
      expect(warnings()).toMatch(/VersioningConfiguration must be an object/);
      expect(warnings()).toMatch(/Leaving the bucket's LIVE versioning state unchanged/);
    });

    it('names the Suspended default as the thing it is REFUSING to apply', async () => {
      // The wording is load-bearing: the skip has a real cost (a rollback of a
      // versioning change is not reverted), so the message has to say what was
      // avoided, not just that something was skipped.
      await replayCreate({ VersioningConfiguration: { Status: null } as never });
      expect(warnings()).toMatch(/would turn object versioning OFF/);
    });

    it('a TEMPLATE create still REFUSES — the value is actionable there', async () => {
      await expect(templateCreate({ VersioningConfiguration: 'Enabled' as never })).rejects.toThrow(
        /VersioningConfiguration must be an object/
      );
      expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
    });

    it('an UPDATE skips BOTH arms, so a malformed record cannot reach the SUSPEND branch', async () => {
      // The trap this closes: `readConfigString`'s fallback is 'Suspended', so
      // a warn-and-DEFAULT downgrade would route a malformed record straight
      // into the suspend arm and disable versioning on a live bucket — the
      // exact outcome #1471 exists to prevent, re-introduced by the fix for a
      // different issue.
      await update({ ...base, VersioningConfiguration: 42 as never }, {
        ...base,
        VersioningConfiguration: { Status: 'Enabled' },
      });
      expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
      expect(warnings()).toMatch(/neither enabling nor suspending it/);
    });

    it('a WELL-FORMED value is unaffected on both paths', async () => {
      // The guard must not cost the ordinary case an API call.
      await replayCreate({ VersioningConfiguration: { Status: 'Enabled' } });
      expect(callsOf(PutBucketVersioningCommand)).toHaveLength(1);
      expect(warnings()).not.toMatch(/VersioningConfiguration/);
    });

    it('an UNRECOGNIZED status still reaches AWS rather than being skipped', async () => {
      // The enable arm keeps its `!== 'Suspended'` test rather than becoming
      // `=== 'Enabled'`: a status cdkd does not recognize is AWS's to reject by
      // name, and silently swallowing it would be a new silent drop.
      await update({ ...base, VersioningConfiguration: { Status: 'Enabling' } }, base);
      const calls = callsOf(PutBucketVersioningCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.input).toMatchObject({
        VersioningConfiguration: { Status: 'Enabling' },
      });
    });
  });

  // ---------------- LoggingConfiguration ----------------

  describe('logging destination + prefix', () => {
    it('a REPLAY create warns and skips the block instead of throwing', async () => {
      // The GATE refuses here, not the applier — it reads the same field to
      // decide whether to call at all, so it had to take the downgrade too or
      // it would throw before the applier's skip could run. Its wording is
      // deliberately the create-side one ("skipping the block") rather than
      // the applier's "leaving the LIVE configuration unchanged": on a create
      // there is no live configuration yet to preserve.
      await replayCreate({ LoggingConfiguration: 'my-log-bucket' as never });
      expect(callsOf(PutBucketLoggingCommand)).toHaveLength(0);
      expect(warnings()).toMatch(/LoggingConfiguration must be an object/);
      expect(warnings()).toMatch(/Skipping the logging configuration/);
    });

    it('does NOT take the CLEARING branch, which is what the default would do', async () => {
      // The load-bearing half. The destination's fallback is '', which the
      // clearing branch reads as "no logging" and turns access logging OFF —
      // so a warn-and-default downgrade would silently destroy an audit trail.
      // Asserting "no Put at all" is what distinguishes the skip from it: a
      // cleared configuration is ALSO a PutBucketLogging call.
      await update(
        { ...base, LoggingConfiguration: { DestinationBucketName: 7 } as never },
        { ...base, LoggingConfiguration: { DestinationBucketName: 'logs' } }
      );
      expect(callsOf(PutBucketLoggingCommand)).toHaveLength(0);
      expect(warnings()).toMatch(/rather than clearing it/);
    });

    it('refuses a malformed LogFilePrefix too, not only the destination', async () => {
      // `LogFilePrefix` has a BLANK fallback, so the blank-with-blank-default
      // relaxation accepts '' — but a NON-string still refuses, and the Put
      // replaces the whole logging status, so a partially-applied block would
      // send a destination with a defaulted prefix.
      await update(
        {
          ...base,
          LoggingConfiguration: { DestinationBucketName: 'logs', LogFilePrefix: {} } as never,
        },
        { ...base, LoggingConfiguration: { DestinationBucketName: 'logs' } }
      );
      expect(callsOf(PutBucketLoggingCommand)).toHaveLength(0);
      expect(warnings()).toMatch(/LogFilePrefix must be a non-empty string/);
    });

    it('keeps a BLANK LogFilePrefix, which legitimately means "no prefix"', async () => {
      await update(
        { ...base, LoggingConfiguration: { DestinationBucketName: 'logs', LogFilePrefix: '' } },
        base
      );
      const calls = callsOf(PutBucketLoggingCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.input).toMatchObject({
        BucketLoggingStatus: { LoggingEnabled: { TargetBucket: 'logs', TargetPrefix: '' } },
      });
    });

    it('a TEMPLATE create still REFUSES', async () => {
      await expect(templateCreate({ LoggingConfiguration: 'my-log-bucket' as never })).rejects
        .toThrow(/LoggingConfiguration must be an object/);
    });

    it('an ABSENT config still CLEARS — the legitimate removal is untouched', async () => {
      await update(base, { ...base, LoggingConfiguration: { DestinationBucketName: 'logs' } });
      const calls = callsOf(PutBucketLoggingCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.input).toMatchObject({ BucketLoggingStatus: {} });
    });
  });

  // ---------------- InventoryConfigurations schedule ----------------

  describe('inventory ScheduleFrequency / Schedule.Frequency', () => {
    const inventoryItem = (extra: Record<string, unknown>) => ({
      Id: 'inv1',
      Enabled: true,
      IncludedObjectVersions: 'All',
      Destination: { BucketArn: 'arn:aws:s3:::dest', Format: 'CSV' },
      ...extra,
    });

    it('falls through to Schedule.Frequency when the FIRST source is malformed', async () => {
      // The third downgrade shape. The second source is a value the template
      // also declares, so it is a real answer — unlike inventing a cadence.
      await update(
        {
          ...base,
          InventoryConfigurations: [
            inventoryItem({ ScheduleFrequency: {}, Schedule: { Frequency: 'Daily' } }),
          ],
        },
        base
      );
      const calls = callsOf(PutBucketInventoryConfigurationCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.input).toMatchObject({
        InventoryConfiguration: { Schedule: { Frequency: 'Daily' } },
      });
      expect(warnings()).toMatch(/Falling back to Schedule\.Frequency/);
    });

    it('SKIPS the item when BOTH sources are unusable, rather than inventing Weekly', async () => {
      // `Weekly` is the fallback, and applying it would silently re-cadence a
      // LIVE inventory report. The skip unit is one configuration item,
      // matching the `IncludedObjectVersions` guard in the same applier (the
      // Put is per-Id).
      await update(
        {
          ...base,
          InventoryConfigurations: [inventoryItem({ ScheduleFrequency: {}, Schedule: 'Daily' })],
        },
        base
      );
      expect(callsOf(PutBucketInventoryConfigurationCommand)).toHaveLength(0);
      expect(warnings()).toMatch(/Skipping this inventory configuration/);
    });

    it('a TEMPLATE create still REFUSES a malformed ScheduleFrequency', async () => {
      await expect(
        templateCreate({
          InventoryConfigurations: [
            inventoryItem({ ScheduleFrequency: {}, Schedule: { Frequency: 'Daily' } }),
          ],
        })
      ).rejects.toThrow(/ScheduleFrequency must be a non-empty string/);
    });

    it('a well-formed ScheduleFrequency still WINS over Schedule.Frequency', async () => {
      // The precedence is preserved, not merely the fall-through: a correct
      // first source must not start losing to the second one.
      await update(
        {
          ...base,
          InventoryConfigurations: [
            inventoryItem({ ScheduleFrequency: 'Weekly', Schedule: { Frequency: 'Daily' } }),
          ],
        },
        base
      );
      const calls = callsOf(PutBucketInventoryConfigurationCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.input).toMatchObject({
        InventoryConfiguration: { Schedule: { Frequency: 'Weekly' } },
      });
    });
  });
});
