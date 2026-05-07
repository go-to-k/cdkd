import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EnableKeyRotationCommand,
  DisableKeyRotationCommand,
  UpdateKeyDescriptionCommand,
  PutKeyPolicyCommand,
  EnableKeyCommand,
  DisableKeyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateAliasCommand,
} from '@aws-sdk/client-kms';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    KMSClient: vi.fn().mockImplementation(() => ({
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

import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';

const KEY_ID = 'abcd-1234';
const ALIAS_NAME = 'alias/my-key';

/**
 * Mutating SDK commands the round-trip test verifies do NOT fire when
 * state == AWS. Any of these in mock.calls means the diff logic
 * misclassified an "equal" snapshot as a change — the load-bearing bug
 * `cdkd drift --revert` exposes via observed-property round-trip.
 */
const MUTATING_COMMANDS = [
  EnableKeyRotationCommand,
  DisableKeyRotationCommand,
  UpdateKeyDescriptionCommand,
  PutKeyPolicyCommand,
  EnableKeyCommand,
  DisableKeyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateAliasCommand,
];

function mutatingCalls(): unknown[] {
  return mockSend.mock.calls.filter((c: unknown[]) =>
    MUTATING_COMMANDS.some((Cmd) => c[0] instanceof Cmd)
  );
}

describe('KMSProvider read-update round-trip', () => {
  let provider: KMSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new KMSProvider();
  });

  it('symmetric key no-drift round-trip is a logical no-op (zero mutating SDK calls)', async () => {
    // State == AWS implies update() must make no AWS-side mutations.
    // The snapshot mirrors what readCurrentState produces for a
    // SYMMETRIC_DEFAULT key: Description always-emitted ('' on no
    // description), KeySpec / KeyUsage / Enabled / MultiRegion / Origin
    // surfaced from DescribeKey, Tags always-emitted as []. KeyPolicy /
    // EnableKeyRotation / RotationPeriodInDays are NOT in the snapshot
    // because they are declared in getDriftUnknownPaths.
    const observed = {
      Description: 'my key',
      KeySpec: 'SYMMETRIC_DEFAULT',
      KeyUsage: 'ENCRYPT_DECRYPT',
      Enabled: true,
      MultiRegion: false,
      Origin: 'AWS_KMS',
      Tags: [{ Key: 'Foo', Value: 'Bar' }],
    };

    await provider.update('K', KEY_ID, 'AWS::KMS::Key', observed, observed);

    expect(mutatingCalls()).toHaveLength(0);
  });

  it('symmetric key with empty description and no tags round-trips with zero mutating calls', async () => {
    // The minimum-shape AWS response: Description '' (always-emit), no
    // user tags (Tags: []). Truthy-gate regression on Description ('')
    // would silently drop the empty string and look correct here, so
    // this test pairs with the "drift --revert push '' explicitly" case
    // — but the load-bearing assertion is "no mutating call when equal".
    const observed = {
      Description: '',
      KeySpec: 'SYMMETRIC_DEFAULT',
      KeyUsage: 'ENCRYPT_DECRYPT',
      Enabled: true,
      MultiRegion: false,
      Origin: 'AWS_KMS',
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await provider.update('K', KEY_ID, 'AWS::KMS::Key', observed, observed);

    expect(mutatingCalls()).toHaveLength(0);
  });

  it('asymmetric key round-trip does NOT push EnableKeyRotation (Class 1 — invalid for non-SYMMETRIC_DEFAULT)', async () => {
    // Mechanical guard for Class 1 placeholder regression on
    // EnableKeyRotation, which AWS rejects on asymmetric keys
    // ("UnsupportedOperationException: Key rotation is not supported
    // for asymmetric KMS keys"). readCurrentState must NOT emit it as
    // an always-on placeholder — and getDriftUnknownPaths must keep it
    // out of the round-trip diff. Either way EnableKeyRotation /
    // DisableKeyRotation must NEVER fire on an asymmetric snapshot.
    //
    // See docs/provider-development.md § 3b "Read-update round-trip
    // test" for the Class 1 rationale.
    const observed = {
      Description: 'asymmetric signing key',
      KeySpec: 'RSA_2048',
      KeyUsage: 'SIGN_VERIFY',
      Enabled: true,
      MultiRegion: false,
      Origin: 'AWS_KMS',
      Tags: [] as Array<{ Key: string; Value: string }>,
      // EnableKeyRotation absent (correct: getDriftUnknownPaths
      // declares it as unreadable, so observedProperties never carries
      // it on round-trip).
    };

    await provider.update('K', KEY_ID, 'AWS::KMS::Key', observed, observed);

    const rotationCalls = mockSend.mock.calls.filter(
      (c: unknown[]) =>
        c[0] instanceof EnableKeyRotationCommand || c[0] instanceof DisableKeyRotationCommand
    );
    expect(rotationCalls).toHaveLength(0);
    expect(mutatingCalls()).toHaveLength(0);
  });

  it('alias no-drift round-trip on identical TargetKeyId still performs UpdateAlias (no diff path in updateAlias)', async () => {
    // updateAlias does NOT diff old vs new — it always sends
    // UpdateAlias. That's the documented contract for this provider
    // (Alias has only one mutable field; the API call is cheap). This
    // test pins the contract so a future "skip if no diff"
    // optimization can't silently regress drift --revert correctness
    // for aliases.
    const observed = {
      AliasName: ALIAS_NAME,
      TargetKeyId: KEY_ID,
    };

    await provider.update('A', ALIAS_NAME, 'AWS::KMS::Alias', observed, observed);

    const updateAliasCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] instanceof UpdateAliasCommand
    );
    expect(updateAliasCalls).toHaveLength(1);
    const firstCall = updateAliasCalls[0] as unknown[];
    expect((firstCall[0] as UpdateAliasCommand).input).toEqual({
      AliasName: ALIAS_NAME,
      TargetKeyId: KEY_ID,
    });
  });
});

describe('KMSProvider.getDriftUnknownPaths', () => {
  it('declares unreadable AWS::KMS::Key paths so the drift comparator skips them', () => {
    // KeyPolicy / EnableKeyRotation / RotationPeriodInDays are NOT
    // round-trippable from AWS because cdkd does not call
    // GetKeyPolicy / GetKeyRotationStatus in readCurrentState.
    // BypassPolicyLockoutSafetyCheck / PendingWindowInDays are
    // create / delete-time-only inputs not visible via DescribeKey.
    // Without this declaration any user who templates these would see
    // guaranteed false drift on every clean run.
    const provider = new KMSProvider();
    expect(provider.getDriftUnknownPaths('AWS::KMS::Key')).toEqual([
      'KeyPolicy',
      'EnableKeyRotation',
      'RotationPeriodInDays',
      'BypassPolicyLockoutSafetyCheck',
      'PendingWindowInDays',
    ]);
  });

  it('returns no unknown paths for AWS::KMS::Alias (every templatable field is read back)', () => {
    const provider = new KMSProvider();
    expect(provider.getDriftUnknownPaths('AWS::KMS::Alias')).toEqual([]);
  });
});
