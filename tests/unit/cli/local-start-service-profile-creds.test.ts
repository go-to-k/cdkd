import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { resolveSharedSidecarCredentials } from '../../../src/cli/commands/local-start-service.js';

// Issue #658: `cdkd local start-service --profile <p>` used to resolve
// the profile for cdkd's OWN AWS calls but the AWS-published shared
// `amazon-ecs-local-container-endpoints` sidecar (one per CLI
// invocation, design § 5 Option A) started with empty `AWS_*` env, so
// every replica's containers hit `169.254.171.2/role/<role>` and got
// credential-provider failures. This test exercises the small
// `resolveSharedSidecarCredentials` helper that drives the new
// precedence: the per-CLI sidecar has no concept of `--assume-task-role`
// (that flag is per-container via `buildMetadataEnv`), so this is the
// simpler of the two siblings — `--profile` set → resolve, else
// undefined.

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

describe('resolveSharedSidecarCredentials (issue #658)', () => {
  beforeEach(() => {
    credsProviderMock.mockReset();
    stsDestroyMock.mockReset();
    stsCtorMock.mockReset();
  });

  it('resolves --profile via the SDK default chain when set', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    const result = await resolveSharedSidecarCredentials({ profile: 'my-sso' });
    expect(result).toEqual({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    // STSClient instantiated with the profile so SSO / fromIni resolve.
    expect(stsCtorMock).toHaveBeenCalledWith({ profile: 'my-sso' });
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });

  it('omits sessionToken when the profile resolved to long-lived creds', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-LONG',
      secretAccessKey: 'SECRET-LONG',
    });
    const result = await resolveSharedSidecarCredentials({ profile: 'long-lived' });
    expect(result).toEqual({
      accessKeyId: 'AKIA-LONG',
      secretAccessKey: 'SECRET-LONG',
    });
    expect(result).not.toHaveProperty('sessionToken');
  });

  it('returns undefined when --profile is NOT set (sidecar falls back to its own default chain)', async () => {
    const result = await resolveSharedSidecarCredentials({});
    expect(result).toBeUndefined();
    // No AWS calls at all — pre-existing behavior preserved.
    expect(stsCtorMock).not.toHaveBeenCalled();
    expect(credsProviderMock).not.toHaveBeenCalled();
  });

  it('propagates resolveProfileCredentials errors (expired SSO etc.) — no silent fallback', async () => {
    credsProviderMock.mockRejectedValue(
      new Error('The SSO session associated with this profile has expired')
    );
    await expect(
      resolveSharedSidecarCredentials({ profile: 'expired-sso' })
    ).rejects.toThrow(/SSO session.*expired/);
  });
});
