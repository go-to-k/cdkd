import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { resolveProfileCredentials } from '../../../src/cli/commands/local-start-api.js';

// Issue #654: `--profile <p>` should resolve to a concrete credential set
// for forwarding to Lambda containers. The helper drives the SDK's default
// credential provider chain — covering SSO / IAM Identity Center / fromIni /
// role-assumption profiles — so a dev using `aws sso login --profile X`
// gets working creds inside the local Lambda without `eval $(aws configure
// export-credentials ...)` gymnastics.

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

describe('resolveProfileCredentials (issue #654)', () => {
  beforeEach(() => {
    credsProviderMock.mockReset();
    stsDestroyMock.mockReset();
    stsCtorMock.mockReset();
  });

  it('resolves a profile to {accessKeyId, secretAccessKey, sessionToken}', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-TEMP',
      secretAccessKey: 'SECRET-TEMP',
      sessionToken: 'SESSION-TEMP',
    });
    const creds = await resolveProfileCredentials('mates_dev');
    expect(creds).toEqual({
      accessKeyId: 'AKIA-TEMP',
      secretAccessKey: 'SECRET-TEMP',
      sessionToken: 'SESSION-TEMP',
    });
    // STSClient constructed with the profile threaded through.
    expect(stsCtorMock).toHaveBeenCalledWith({ profile: 'mates_dev' });
    // Destroy called for cleanup.
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });

  it('omits sessionToken when profile resolved to long-lived creds', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-LONG',
      secretAccessKey: 'SECRET-LONG',
    });
    const creds = await resolveProfileCredentials('long-lived-profile');
    expect(creds).toEqual({
      accessKeyId: 'AKIA-LONG',
      secretAccessKey: 'SECRET-LONG',
    });
    expect(creds).not.toHaveProperty('sessionToken');
  });

  it('throws a clear error when the provider chain returns no creds', async () => {
    credsProviderMock.mockResolvedValue(undefined);
    await expect(resolveProfileCredentials('broken-profile')).rejects.toThrow(
      /broken-profile.*resolved without usable credentials.*aws sso login/s
    );
    // STS still destroyed on the failure path (finally block).
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });

  it('throws a clear error when the provider chain returns partial creds', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-PARTIAL',
      // secretAccessKey missing
    });
    await expect(resolveProfileCredentials('partial-profile')).rejects.toThrow(
      /partial-profile.*resolved without usable credentials/
    );
  });

  it('propagates underlying provider errors (e.g. expired SSO token)', async () => {
    credsProviderMock.mockRejectedValue(
      new Error('The SSO session associated with this profile has expired')
    );
    await expect(resolveProfileCredentials('expired-sso-profile')).rejects.toThrow(
      /SSO session.*expired/
    );
    // STS destroyed on rejection too.
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });
});
