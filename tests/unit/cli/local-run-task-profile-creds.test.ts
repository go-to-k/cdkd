import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { resolveSidecarCredentials } from '../../../src/cli/commands/local-run-task.js';

// Issue #658: `cdkd local run-task --profile <p>` (without
// `--assume-task-role`) used to resolve the profile for cdkd's OWN AWS
// calls but the AWS-published `amazon-ecs-local-container-endpoints`
// sidecar started with empty `AWS_*` env, so every user container that
// hit `169.254.170.2/role/<role>` got a credential-provider failure.
// This test exercises the small `resolveSidecarCredentials` helper that
// drives the new precedence: assumed-creds win when set; otherwise the
// profile chain is resolved; otherwise undefined (the pre-existing
// "sidecar uses its own default chain" path).
//
// Same gap class as #654/#655 (which shipped for `cdkd local start-api`'s
// Lambda container env overlay); the helper-extraction pattern mirrors
// PR #655's `resolveProfileCredentials` test surface.

const credsProviderMock = vi.fn();
const stsDestroyMock = vi.fn();
const stsCtorMock = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation((config: unknown) => {
    stsCtorMock(config);
    return {
      config: { credentials: credsProviderMock },
      destroy: stsDestroyMock,
    };
  }),
}));

describe('resolveSidecarCredentials (issue #658)', () => {
  beforeEach(() => {
    credsProviderMock.mockReset();
    stsDestroyMock.mockReset();
    stsCtorMock.mockReset();
  });

  it('returns the assumed credentials verbatim when --assume-task-role is effective (assume wins over --profile)', async () => {
    const assumed = {
      accessKeyId: 'AKIA-ASSUMED',
      secretAccessKey: 'SECRET-ASSUMED',
      sessionToken: 'SESSION-ASSUMED',
    };
    // Both `--profile` AND `--assume-task-role` set; assume must win.
    const result = await resolveSidecarCredentials({ profile: 'my-sso' }, assumed);
    expect(result).toBe(assumed);
    // The SDK STS client must NOT be touched on this path — the assumed
    // creds came from an earlier STS hop, the sidecar resolver is a no-op.
    expect(stsCtorMock).not.toHaveBeenCalled();
    expect(credsProviderMock).not.toHaveBeenCalled();
  });

  it('resolves --profile via the SDK default chain when --assume-task-role is NOT effective', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    const result = await resolveSidecarCredentials({ profile: 'my-sso' }, undefined);
    expect(result).toEqual({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    // STSClient instantiated with the profile so SSO / fromIni resolve.
    expect(stsCtorMock).toHaveBeenCalledWith({ profile: 'my-sso' });
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });

  it('returns undefined when neither --profile nor --assume-task-role is set (sidecar falls back to its own default chain)', async () => {
    const result = await resolveSidecarCredentials({}, undefined);
    expect(result).toBeUndefined();
    // No AWS calls at all — pre-existing "lowest precedence" path.
    expect(stsCtorMock).not.toHaveBeenCalled();
    expect(credsProviderMock).not.toHaveBeenCalled();
  });

  it('propagates resolveProfileCredentials errors (expired SSO etc.) — no silent fallback', async () => {
    credsProviderMock.mockRejectedValue(
      new Error('The SSO session associated with this profile has expired')
    );
    await expect(
      resolveSidecarCredentials({ profile: 'expired-sso' }, undefined)
    ).rejects.toThrow(/SSO session.*expired/);
  });
});
