import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateTrailCommand } from '@aws-sdk/client-cloudtrail';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-cloudtrail', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cloudtrail');
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';

const TRAIL_ARN = 'arn:aws:cloudtrail:us-east-1:0:trail/my-trail';
const TYPE = 'AWS::CloudTrail::Trail';
const BASE = { S3BucketName: 'my-bucket' };

/**
 * The single UpdateTrail input of the update.
 *
 * Asserts the command was actually SENT before returning. Without that, every
 * `toBeUndefined()` assertion below — including the CFn-parity retention pins,
 * whose ONLY assertions are of that shape — would pass vacuously against an
 * implementation that stops issuing `UpdateTrail` at all (e.g. a future
 * "skip the call when nothing changed" optimization).
 */
function updateTrailInput(): Record<string, unknown> {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateTrailCommand);
  expect(calls).toHaveLength(1);
  return calls[0]![0].input as Record<string, unknown>;
}

describe('CloudTrailProvider removal resets (issue #1160)', () => {
  let provider: CloudTrailProvider;

  beforeEach(() => {
    // clearAllMocks (NOT resetAllMocks) — reset would wipe the module-mock
    // client constructor's implementation and every send would explode.
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new CloudTrailProvider();
  });

  // ─── The #1157-pattern trio, per RESET field ─────────────────────────
  //
  // Clear sentinels are the ones a live CFn A/B (2026-08-10) measured: a
  // real CFn removal update nulled S3KeyPrefix / SnsTopicName and flipped
  // IsMultiRegionTrail / EnableLogFileValidation /
  // IncludeGlobalServiceEvents to false. Each sentinel was then probed
  // ALONE against the live trail — the empty string IS accepted for both
  // string fields, contradicting an older in-code note.

  describe('S3KeyPrefix', () => {
    it('removed: resets to the empty string', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, S3KeyPrefix: 'logs' });
      expect(updateTrailInput()['S3KeyPrefix']).toBe('');
    });

    it('never-present: sends undefined (no reset)', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, BASE);
      expect(updateTrailInput()['S3KeyPrefix']).toBeUndefined();
    });

    it('kept: a desired value passes through', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, S3KeyPrefix: 'new' }, {
        ...BASE,
        S3KeyPrefix: 'logs',
      });
      expect(updateTrailInput()['S3KeyPrefix']).toBe('new');
    });

    it("a previous-side '' placeholder is NOT a removal (readCurrentState always-emits it)", async () => {
      // `readCurrentState` writes `S3KeyPrefix: ''` for a trail that never
      // had a prefix. Treating that as "was present" would send a pointless
      // clear on every no-op update of an unconfigured trail.
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, S3KeyPrefix: '' });
      expect(updateTrailInput()['S3KeyPrefix']).toBeUndefined();
    });
  });

  describe('SnsTopicName', () => {
    it('removed: resets to the empty string', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, SnsTopicName: 'my-topic' });
      expect(updateTrailInput()['SnsTopicName']).toBe('');
    });

    it('never-present: sends undefined (no reset)', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, BASE);
      expect(updateTrailInput()['SnsTopicName']).toBeUndefined();
    });

    it('kept: a desired value passes through', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, SnsTopicName: 'other' }, {
        ...BASE,
        SnsTopicName: 'my-topic',
      });
      expect(updateTrailInput()['SnsTopicName']).toBe('other');
    });

    it("a previous-side '' placeholder is NOT a removal", async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, SnsTopicName: '' });
      expect(updateTrailInput()['SnsTopicName']).toBeUndefined();
    });

    it("a DESIRED-side '' against a configured topic clears it", async () => {
      // Reachable via `cdkd drift --revert`, which merges the AWS-current
      // snapshot into the desired side — and `readCurrentState` always-emits
      // the `''` placeholder. Sanitizing the desired side to `undefined`
      // makes it a removal, which is the correct outcome: the baseline had
      // no topic.
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, SnsTopicName: '' }, {
        ...BASE,
        SnsTopicName: 'my-topic',
      });
      expect(updateTrailInput()['SnsTopicName']).toBe('');
    });
  });

  describe('IsMultiRegionTrail', () => {
    it('removed: resets to false', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, IsMultiRegionTrail: true });
      expect(updateTrailInput()['IsMultiRegionTrail']).toBe(false);
    });

    it('never-present: sends undefined (no reset)', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, BASE);
      expect(updateTrailInput()['IsMultiRegionTrail']).toBeUndefined();
    });

    it('kept: a desired value passes through', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, IsMultiRegionTrail: true }, {
        ...BASE,
        IsMultiRegionTrail: true,
      });
      expect(updateTrailInput()['IsMultiRegionTrail']).toBe(true);
    });

    it('an explicit desired FALSE is forwarded, not swallowed as falsy', async () => {
      // The `kept` case above passes `true`/`true`, which an implementation
      // that simply returned `previousValue` would also satisfy. A desired
      // `false` against a never-present previous is the shape that
      // discriminates: a truthiness-based `newValue || clearValue` yields
      // `undefined` here and drops the user's explicit false.
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, IsMultiRegionTrail: false }, BASE);
      expect(updateTrailInput()['IsMultiRegionTrail']).toBe(false);
    });
  });

  describe('EnableLogFileValidation', () => {
    it('removed: resets to false', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, EnableLogFileValidation: true });
      expect(updateTrailInput()['EnableLogFileValidation']).toBe(false);
    });

    it('never-present: sends undefined (no reset)', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, BASE);
      expect(updateTrailInput()['EnableLogFileValidation']).toBeUndefined();
    });

    it('kept: a desired value passes through', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, EnableLogFileValidation: true }, {
        ...BASE,
        EnableLogFileValidation: false,
      });
      expect(updateTrailInput()['EnableLogFileValidation']).toBe(true);
    });
  });

  describe('IncludeGlobalServiceEvents', () => {
    it('removed on a single-region trail: resets to false', async () => {
      // `IsMultiRegionTrail: false` must be DECLARED for the reset to apply —
      // `readCurrentState` always-emits it (`?? false`), so this is the shape
      // a real previous side carries. Without it the trail's region scope is
      // unknown and the reset is deliberately skipped (see below).
      await provider.update('T', TRAIL_ARN, TYPE, BASE, {
        ...BASE,
        IsMultiRegionTrail: false,
        IncludeGlobalServiceEvents: true,
      });
      expect(updateTrailInput()['IncludeGlobalServiceEvents']).toBe(false);
    });

    it('never-present: sends undefined (no reset)', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, BASE);
      expect(updateTrailInput()['IncludeGlobalServiceEvents']).toBeUndefined();
    });

    it('kept: a desired value passes through', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, IncludeGlobalServiceEvents: true }, {
        ...BASE,
        IncludeGlobalServiceEvents: false,
      });
      expect(updateTrailInput()['IncludeGlobalServiceEvents']).toBe(true);
    });

    it('the reset is SKIPPED while the trail stays multi-region', async () => {
      // AWS rejects a multi-region trail that excludes global service
      // events ("Multi-Region trail must include global service events") —
      // live-hit while building the A/B fixture. Resetting to false under a
      // retained `IsMultiRegionTrail: true` would turn a silent no-op into
      // a hard deploy failure on a combination CFn was never measured on.
      const desired = { ...BASE, IsMultiRegionTrail: true };
      const previous = { ...BASE, IsMultiRegionTrail: true, IncludeGlobalServiceEvents: true };

      await provider.update('T', TRAIL_ARN, TYPE, desired, previous);

      expect(updateTrailInput()['IsMultiRegionTrail']).toBe(true);
      expect(updateTrailInput()['IncludeGlobalServiceEvents']).toBeUndefined();
    });

    it('the reset is SKIPPED when multi-region is UNKNOWN (absent on both sides)', async () => {
      // Neither side declares IsMultiRegionTrail, so the live value cannot be
      // derived — it may be `true` on a console-changed or imported trail,
      // and sending globalEvents=false alone would then be REJECTED by AWS.
      // Pass-through (the old no-op) is the safe fallback.
      await provider.update('T', TRAIL_ARN, TYPE, BASE, {
        ...BASE,
        IncludeGlobalServiceEvents: true,
      });
      expect(updateTrailInput()['IsMultiRegionTrail']).toBeUndefined();
      expect(updateTrailInput()['IncludeGlobalServiceEvents']).toBeUndefined();
    });

    it('the reset APPLIES when multi-region is itself being reset away', async () => {
      // The A/B's own shape: both removed together, CFn reset both.
      const previous = {
        ...BASE,
        IsMultiRegionTrail: true,
        IncludeGlobalServiceEvents: true,
      };

      await provider.update('T', TRAIL_ARN, TYPE, BASE, previous);

      expect(updateTrailInput()['IsMultiRegionTrail']).toBe(false);
      expect(updateTrailInput()['IncludeGlobalServiceEvents']).toBe(false);
    });
  });

  // ─── CFn-parity / unmeasured retention pins ─────────────────────────

  it('parity: CloudWatchLogs pair is RETAINED on removal (CFn keeps it — live A/B)', async () => {
    // The A/B removed both from the template and the live trail kept them,
    // so the pass-through is already CFn parity. Pinned so a future "reset
    // these too" change requires a fresh A/B.
    const previous = {
      ...BASE,
      CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:0:log-group:/t:*',
      CloudWatchLogsRoleArn: 'arn:aws:iam::0:role/ct',
    };

    await provider.update('T', TRAIL_ARN, TYPE, BASE, previous);

    expect(updateTrailInput()['CloudWatchLogsLogGroupArn']).toBeUndefined();
    expect(updateTrailInput()['CloudWatchLogsRoleArn']).toBeUndefined();
  });

  it('unmeasured: KMSKeyId and IsOrganizationTrail are NOT reset (issue #1533)', async () => {
    // Neither could be A/B'd — a customer-managed KMS key's 7-day minimum
    // deletion window would orphan a PendingDeletion key, and an org trail
    // needs an Organizations management account. Recorded as unmeasured
    // rather than guessed; #1533 carries the follow-up.
    const previous = {
      ...BASE,
      KMSKeyId: 'arn:aws:kms:us-east-1:0:key/abc',
      IsOrganizationTrail: true,
    };

    await provider.update('T', TRAIL_ARN, TYPE, BASE, previous);

    expect(updateTrailInput()['KmsKeyId']).toBeUndefined();
    expect(updateTrailInput()['IsOrganizationTrail']).toBeUndefined();
  });

  it('a full removal sends every reset in ONE UpdateTrail call', async () => {
    const previous = {
      ...BASE,
      S3KeyPrefix: 'logs',
      SnsTopicName: 'my-topic',
      IsMultiRegionTrail: true,
      EnableLogFileValidation: true,
      IncludeGlobalServiceEvents: true,
    };

    await provider.update('T', TRAIL_ARN, TYPE, BASE, previous);

    const updates = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateTrailCommand);
    expect(updates).toHaveLength(1);
    expect(updateTrailInput()).toMatchObject({
      Name: TRAIL_ARN,
      S3KeyPrefix: '',
      SnsTopicName: '',
      IsMultiRegionTrail: false,
      EnableLogFileValidation: false,
      IncludeGlobalServiceEvents: false,
    });
  });
});
