import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateTrailCommand } from '@aws-sdk/client-cloudtrail';

const mockSend = vi.fn();
// Hoisted with the logger factory: it builds its child logger EAGERLY, so an
// outer `const` would hit the TDZ.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

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
    warn: warnSpy,
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

  // KMSKeyId joined the RESET set on 2026-08-11 (issue #1533), from its own
  // live CFn A/B plus a separate wire-shape probe. The two are different
  // measurements and both were taken: CFn's removal UPDATE read back
  // `KmsKeyId: null` (so CFn RESETS), `UpdateTrail` with the field ABSENT
  // left the live key attached (so pass-through was the divergence), and
  // `KmsKeyId: ''` was ACCEPTED and cleared it (so `''` is the payload).
  //
  // Note the CFn spelling is `KMSKeyId` and the SDK's is `KmsKeyId`, so the
  // desired/previous bags below and the asserted input key differ on purpose.
  describe('KMSKeyId', () => {
    const KEY = 'arn:aws:kms:us-east-1:0:key/abc';

    it('removed: resets to the empty string', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, KMSKeyId: KEY });
      expect(updateTrailInput()['KmsKeyId']).toBe('');
    });

    it('never-present: sends undefined (no reset)', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, BASE);
      expect(updateTrailInput()['KmsKeyId']).toBeUndefined();
    });

    it('kept: a desired value passes through', async () => {
      const other = 'arn:aws:kms:us-east-1:0:key/def';
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, KMSKeyId: other }, {
        ...BASE,
        KMSKeyId: KEY,
      });
      expect(updateTrailInput()['KmsKeyId']).toBe(other);
    });

    it("a previous-side '' placeholder is NOT a removal", async () => {
      // `readCurrentState` always-emits `KMSKeyId: ''` for an unencrypted
      // trail, so without this a never-encrypted trail would send a pointless
      // clear on every update.
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, KMSKeyId: '' });
      expect(updateTrailInput()['KmsKeyId']).toBeUndefined();
    });

    it("a DESIRED-side '' against a configured key clears it", async () => {
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, KMSKeyId: '' }, {
        ...BASE,
        KMSKeyId: KEY,
      });
      expect(updateTrailInput()['KmsKeyId']).toBe('');
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

  // The write-side half of issue #1565's always-emit. `readCurrentState` now
  // reports `''` for both fields on an UNWIRED trail, and that snapshot
  // round-trips through `update()` on every `drift --revert` / rollback
  // replay — so the update path has to tell an ABSENT desired side (a
  // template removal, which CFn RETAINS) from an explicit `''` (a clear).
  // Conflating them, as `emptyToUndefined` did, made a `--revert` of a
  // console-side enable a NO-OP that still printed success.
  it("the always-emitted '' pair round-trips as a semantic no-op on an unwired trail", async () => {
    await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, CloudWatchLogsLogGroupArn: '', CloudWatchLogsRoleArn: '' }, {
      ...BASE,
      CloudWatchLogsLogGroupArn: '',
      CloudWatchLogsRoleArn: '',
    });

    // `''` re-asserts a field that is already null — accepted by AWS, and it
    // rides an UpdateTrail this update issues anyway. It is deliberately NOT
    // suppressed on "unchanged": that gate would also stop forwarding an
    // unchanged POPULATED pair, which the round-trip suite pins.
    expect(updateTrailInput()['CloudWatchLogsLogGroupArn']).toBe('');
    expect(updateTrailInput()['CloudWatchLogsRoleArn']).toBe('');
  });

  it("an explicit '' pair against a CONFIGURED previous CLEARS it (the --revert path)", async () => {
    // This is the shape `cdkd drift --revert` builds after a console-side
    // enable: desired = the recorded baseline (`''` / `''`), previous = what
    // AWS reports now. Dropping the `''` here left the console wiring in
    // place while cdkd reported the resource reverted.
    await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, CloudWatchLogsLogGroupArn: '', CloudWatchLogsRoleArn: '' }, {
      ...BASE,
      CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:0:log-group:/g:*',
      CloudWatchLogsRoleArn: 'arn:aws:iam::0:role/r',
    });

    expect(updateTrailInput()['CloudWatchLogsLogGroupArn']).toBe('');
    expect(updateTrailInput()['CloudWatchLogsRoleArn']).toBe('');
  });

  it.each([
    ['null', null],
    ['an unresolved intrinsic', { 'Fn::If': ['C', 'a', 'b'] }],
    ['a number', 5],
  ])(
    'leaves the live wiring alone on %s instead of reading it as a clear',
    async (_label, value) => {
      // The destructive direction of the presence rule: `null` survives a JSON
      // state round-trip, and coercing it to `''` would DISABLE a live trail's
      // CloudWatch Logs delivery on a value nobody wrote as a clear — the
      // `malformed-value-must-not-read-as-removal` class this file already
      // guards for EventSelectors.
      await provider.update('T', TRAIL_ARN, TYPE, {
        ...BASE,
        CloudWatchLogsLogGroupArn: value,
        CloudWatchLogsRoleArn: value,
      }, {
        ...BASE,
        CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:0:log-group:/g:*',
        CloudWatchLogsRoleArn: 'arn:aws:iam::0:role/r',
      });

      expect(updateTrailInput()['CloudWatchLogsLogGroupArn']).toBeUndefined();
      expect(updateTrailInput()['CloudWatchLogsRoleArn']).toBeUndefined();
    }
  );

  it('refuses a HALF-populated pair rather than sending the shape AWS rejects', async () => {
    // Reachable from a snapshot: `readCurrentState` always-emits both keys, so
    // a trail AWS reports with only one half yields `{group: arn, role: ''}`,
    // and a --revert / rollback replay hands that straight to update().
    // Sending it would pair a real ARN with an empty one.
    await provider.update('T', TRAIL_ARN, TYPE, {
      ...BASE,
      CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:0:log-group:/g:*',
      CloudWatchLogsRoleArn: '',
    }, { ...BASE });

    expect(updateTrailInput()['CloudWatchLogsLogGroupArn']).toBeUndefined();
    expect(updateTrailInput()['CloudWatchLogsRoleArn']).toBeUndefined();
  });

  it('sends the pair TOGETHER when only one half changes', async () => {
    // AWS holds the two all-or-nothing, so a request carrying one without the
    // other is a shape it rejects. The resolver decides them jointly.
    await provider.update('T', TRAIL_ARN, TYPE, {
      ...BASE,
      CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:0:log-group:/new:*',
      CloudWatchLogsRoleArn: 'arn:aws:iam::0:role/r',
    }, {
      ...BASE,
      CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:0:log-group:/old:*',
      CloudWatchLogsRoleArn: 'arn:aws:iam::0:role/r',
    });

    expect(updateTrailInput()['CloudWatchLogsLogGroupArn']).toBe(
      'arn:aws:logs:us-east-1:0:log-group:/new:*'
    );
    expect(updateTrailInput()['CloudWatchLogsRoleArn']).toBe('arn:aws:iam::0:role/r');
  });

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

  it('unmeasured: IsOrganizationTrail is NOT reset (issue #1533)', async () => {
    // The one field of the #1160 SUSPECT row that is still unmeasured, and
    // it is unmeasurable HERE rather than merely unmeasured: flipping it
    // needs an Organizations management (or delegated administrator)
    // account, and the integ account is not in an organization at all
    // (`AWSOrganizationsNotInUseException`, probed 2026-08-11). Pinned as
    // pass-through so a future "reset it too" change requires a real A/B on
    // an account that can host an organization trail.
    const previous = { ...BASE, IsOrganizationTrail: true };

    await provider.update('T', TRAIL_ARN, TYPE, BASE, previous);

    expect(updateTrailInput()['IsOrganizationTrail']).toBeUndefined();
  });

  it('a full removal sends every reset in ONE UpdateTrail call', async () => {
    const previous = {
      ...BASE,
      S3KeyPrefix: 'logs',
      SnsTopicName: 'my-topic',
      KMSKeyId: 'arn:aws:kms:us-east-1:0:key/abc',
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
      KmsKeyId: '',
      IsMultiRegionTrail: false,
      EnableLogFileValidation: false,
      IncludeGlobalServiceEvents: false,
    });
  });

  // ─── EventSelectors: its own API call, its own reset shape (#1549) ────
  //
  // `EventSelectors` does not ride `UpdateTrail` — it has a dedicated
  // `PutEventSelectors`, which is why the #1160 batch's UpdateTrail-shaped
  // sweep never covered it and the branch kept SKIPPING the call on removal
  // (the live trail silently retained its custom selectors).
  //
  // Both halves below are measured, not analogized (live CFn A/B + live API
  // probe, us-east-1, 2026-08-11): CFn RESETS to the default selector, and
  // the empty array the adjacent `InsightSelectors` branch uses is REJECTED
  // here (`InvalidEventSelectorsException`).
  describe('EventSelectors (issue #1549)', () => {
    const CUSTOM = [{ ReadWriteType: 'WriteOnly', IncludeManagementEvents: true }];
    const DEFAULT = [{ ReadWriteType: 'All', IncludeManagementEvents: true }];

    const putEventSelectorsInputs = (): Array<Record<string, unknown>> =>
      mockSend.mock.calls
        .filter((c) => c[0].constructor.name === 'PutEventSelectorsCommand')
        .map((c) => c[0].input as Record<string, unknown>);

    it('removed: RESETS to the AWS default selector', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, EventSelectors: CUSTOM });

      expect(putEventSelectorsInputs()).toEqual([
        { TrailName: TRAIL_ARN, EventSelectors: DEFAULT },
      ]);
    });

    it('removed: never sends the EMPTY array (AWS rejects 0 selectors)', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, EventSelectors: CUSTOM });

      // The length assertion is what stops this passing vacuously: without it
      // `[0]?.[...]` is `undefined` on a provider that never calls the API at
      // all — which is exactly the pre-fix behavior.
      expect(putEventSelectorsInputs()).toHaveLength(1);
      // The InsightSelectors removal shape one branch over would 400 here.
      expect(putEventSelectorsInputs()[0]?.['EventSelectors']).not.toEqual([]);
    });

    it('emptied to []: takes the same reset path as a removal', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, EventSelectors: [] }, {
        ...BASE,
        EventSelectors: CUSTOM,
      });

      expect(putEventSelectorsInputs()).toEqual([
        { TrailName: TRAIL_ARN, EventSelectors: DEFAULT },
      ]);
    });

    it('never-present: issues NO PutEventSelectors call', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, BASE);
      expect(putEventSelectorsInputs()).toEqual([]);
    });

    it('unchanged: issues NO PutEventSelectors call', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, EventSelectors: CUSTOM }, {
        ...BASE,
        EventSelectors: CUSTOM,
      });
      expect(putEventSelectorsInputs()).toEqual([]);
    });

    it('kept: a desired value passes through verbatim', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, EventSelectors: CUSTOM }, BASE);

      expect(putEventSelectorsInputs()).toEqual([{ TrailName: TRAIL_ARN, EventSelectors: CUSTOM }]);
    });

    // A malformed value must NOT read as a removal. The reset is destructive
    // by design (it clears live selectors), so falsiness or a missing
    // `.length` as the gate would let an unresolved `Fn::If` wipe a live
    // trail's configuration — turning the pre-fix silent no-op into damage.
    it.each([
      ['an object (unresolved Fn::If)', { 'Fn::If': ['C', [], []] }],
      ['a string', 'WriteOnly'],
      ['a number', 5],
    ])(
      'leaves the live selectors alone on %s instead of resetting to the default',
      async (_label, value) => {
        // WARN, not throw: `update()` is a replay path (rollback /
        // `drift --revert` feed a cdkd STATE record in as the desired bag), so
        // a refusal here would strand it with no template-side remedy — the
        // rule `.claude/rules/providers.md` states for every update-path guard.
        // The fallback is "leave the trail alone", never the reset.
        await expect(
          provider.update('T', TRAIL_ARN, TYPE, { ...BASE, EventSelectors: value }, {
            ...BASE,
            EventSelectors: CUSTOM,
          })
        ).resolves.toBeDefined();

        expect(putEventSelectorsInputs()).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('AWS::CloudTrail::Trail EventSelectors must be an array')
        );
      }
    );

    it('treats an explicit null as ABSENT (a genuine removal), not as malformed', async () => {
      // `null` is what a template that never set the property resolves to on
      // some paths; CFn treats it as absent, and absent IS the measured reset.
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, EventSelectors: null }, {
        ...BASE,
        EventSelectors: CUSTOM,
      });

      expect(putEventSelectorsInputs()).toEqual([
        { TrailName: TRAIL_ARN, EventSelectors: DEFAULT },
      ]);
    });

    it('tolerates the AdvancedEventSelectors rejection on the RESET path only', async () => {
      // A trail switched to AdvancedEventSelectors out of band still has the
      // basic selectors in cdkd state, so the diff fires and AWS rejects the
      // Put. There is nothing to clear, so the reset warns and continues
      // rather than failing the whole deploy on an unmeasured combination.
      //
      // The rejection text is AWS's OWN wording — "advanced event selectors",
      // spaced and lowercase, as spelled in `@aws-sdk/client-cloudtrail`'s
      // `InvalidEventSelectorsException` doc — NOT the CFn / SDK type spelling
      // `AdvancedEventSelectors`. A fixture using the type spelling kept a
      // production-dead matcher green, which is what review caught.
      mockSend.mockImplementation((cmd) =>
        cmd.constructor.name === 'PutEventSelectorsCommand'
          ? Promise.reject(
              Object.assign(
                new Error(
                  'This trail uses advanced event selectors, which are managed ' +
                    'through a separate API'
                ),
                { name: 'InvalidEventSelectorsException' }
              )
            )
          : Promise.resolve({})
      );

      await expect(
        provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, EventSelectors: CUSTOM })
      ).resolves.toBeDefined();

      // The Put was ATTEMPTED (a provider that skips it entirely — the pre-fix
      // behavior — would also resolve), and the tolerance is announced.
      expect(putEventSelectorsInputs()).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipping the EventSelectors reset')
      );
    });

    it('still FAILS when the reset is rejected for an UNRELATED reason', async () => {
      // The tolerance is scoped to the advanced-selector case: a throttle or an
      // AccessDenied on the reset must still fail the deploy.
      mockSend.mockImplementation((cmd) =>
        cmd.constructor.name === 'PutEventSelectorsCommand'
          ? Promise.reject(new Error('ThrottlingException: Rate exceeded'))
          : Promise.resolve({})
      );

      await expect(
        provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, EventSelectors: CUSTOM })
      ).rejects.toThrow(/Rate exceeded/);
    });

    it('still FAILS when an explicit desired value is rejected the same way', async () => {
      // The tolerance is scoped to the reset: an explicit template value that
      // AWS cannot deliver on this trail must surface, not be swallowed.
      mockSend.mockImplementation((cmd) =>
        cmd.constructor.name === 'PutEventSelectorsCommand'
          ? Promise.reject(
              new Error(
                'InvalidEventSelectorsException: This trail uses AdvancedEventSelectors'
              )
            )
          : Promise.resolve({})
      );

      await expect(
        provider.update('T', TRAIL_ARN, TYPE, { ...BASE, EventSelectors: CUSTOM }, BASE)
      ).rejects.toThrow(/AdvancedEventSelectors/);
    });
  });

  // ─── IsLogging: an ABSENT desired value is not a start request (#1549) ─
  describe('IsLogging', () => {
    const loggingCommands = (): string[] =>
      mockSend.mock.calls
        .map((c) => c[0].constructor.name)
        .filter((n) => n === 'StartLoggingCommand' || n === 'StopLoggingCommand');

    it('removed against a previous FALSE: issues NEITHER Start nor Stop', async () => {
      // Unreachable from a valid template (`IsLogging` is CFn-required) but
      // reachable from a rollback / drift-revert replay of a partial state
      // record. Pre-#1549 this compared as a change and took the `else` arm,
      // silently STARTING logging.
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, IsLogging: false });
      expect(loggingCommands()).toEqual([]);
    });

    it('removed against a previous TRUE: issues NEITHER Start nor Stop', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, BASE, { ...BASE, IsLogging: true });
      expect(loggingCommands()).toEqual([]);
    });

    it('an explicit desired TRUE against a previous FALSE still starts logging', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, IsLogging: true }, {
        ...BASE,
        IsLogging: false,
      });
      expect(loggingCommands()).toEqual(['StartLoggingCommand']);
    });

    it('an explicit desired FALSE against a previous TRUE still stops logging', async () => {
      await provider.update('T', TRAIL_ARN, TYPE, { ...BASE, IsLogging: false }, {
        ...BASE,
        IsLogging: true,
      });
      expect(loggingCommands()).toEqual(['StopLoggingCommand']);
    });
  });
});
