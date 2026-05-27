import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { applyProfileCredentialsOverlay } from '../../../src/cli/commands/local-invoke.js';

// Issue #657: `cdkd local invoke --profile <p>` should forward the
// profile-resolved credentials to the Lambda container's env block.
// Same gap, same fix shape as PR #655 (issue #654) for `cdkd local
// start-api`. `resolveProfileCredentials` itself is already tested in
// `local-start-api-profile-creds.test.ts`; this file covers the
// OVERLAY logic that wires the resolved creds into the container env
// after `forwardAwsEnv` has copied `process.env.AWS_*`.

describe('applyProfileCredentialsOverlay (issue #657)', () => {
  let originalSessionToken: string | undefined;

  beforeEach(() => {
    // Snapshot any caller-side AWS_SESSION_TOKEN so the strip test
    // below can simulate the "inherited env" state without leaking.
    originalSessionToken = process.env['AWS_SESSION_TOKEN'];
  });

  afterEach(() => {
    if (originalSessionToken === undefined) {
      delete process.env['AWS_SESSION_TOKEN'];
    } else {
      process.env['AWS_SESSION_TOKEN'] = originalSessionToken;
    }
  });

  it('overlays profile creds (incl. sessionToken) onto dockerEnv when --profile set and no --assume-role', () => {
    // Caller flow: forwardAwsEnv first (leaves some pre-existing
    // process.env values), THEN this overlay. We pre-populate dockerEnv
    // with a stale AWS_SESSION_TOKEN to prove the SSO sessionToken from
    // the profile wins over what process.env carried.
    const dockerEnv: Record<string, string> = {
      AWS_REGION: 'us-east-1',
      AWS_SESSION_TOKEN: 'stale-from-process-env',
    };
    const profileCreds = {
      accessKeyId: 'AKIA-SSO',
      secretAccessKey: 'SECRET-SSO',
      sessionToken: 'SESSION-FROM-PROFILE',
    };

    applyProfileCredentialsOverlay(dockerEnv, profileCreds, /* assumeRoleActive */ false);

    expect(dockerEnv['AWS_ACCESS_KEY_ID']).toBe('AKIA-SSO');
    expect(dockerEnv['AWS_SECRET_ACCESS_KEY']).toBe('SECRET-SSO');
    expect(dockerEnv['AWS_SESSION_TOKEN']).toBe('SESSION-FROM-PROFILE');
    // Region from forwardAwsEnv is preserved — overlay touches creds only.
    expect(dockerEnv['AWS_REGION']).toBe('us-east-1');
  });

  it('strips inherited AWS_SESSION_TOKEN when profile resolves to long-lived creds (no sessionToken)', () => {
    // Pre-populate the env with a stray inherited session token (as
    // forwardAwsEnv would have done if process.env.AWS_SESSION_TOKEN
    // was set in the dev's shell). When the profile resolves to a
    // long-lived AKID + SAK, that stray session token MUST be stripped
    // — mixing a long-lived AKID with a foreign session token causes
    // the SDK inside the container to error.
    const dockerEnv: Record<string, string> = {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA-FORWARDED',
      AWS_SECRET_ACCESS_KEY: 'SECRET-FORWARDED',
      AWS_SESSION_TOKEN: 'INHERITED-FOREIGN-SESSION',
    };
    const profileCreds = {
      accessKeyId: 'AKIA-LONG',
      secretAccessKey: 'SECRET-LONG',
      // sessionToken intentionally absent — long-lived creds
    };

    applyProfileCredentialsOverlay(dockerEnv, profileCreds, /* assumeRoleActive */ false);

    expect(dockerEnv['AWS_ACCESS_KEY_ID']).toBe('AKIA-LONG');
    expect(dockerEnv['AWS_SECRET_ACCESS_KEY']).toBe('SECRET-LONG');
    expect(dockerEnv).not.toHaveProperty('AWS_SESSION_TOKEN');
    expect(dockerEnv['AWS_REGION']).toBe('us-east-1');
  });

  it('preserves assume-role STS creds when --assume-role is active (overlay no-ops)', () => {
    // Caller flow when assume-role succeeded: dockerEnv already holds
    // STS-issued temp creds. The overlay must NOT clobber them even
    // if --profile was also passed — assume-role takes precedence per
    // the documented precedence table.
    const dockerEnv: Record<string, string> = {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA-ASSUMED',
      AWS_SECRET_ACCESS_KEY: 'SECRET-ASSUMED',
      AWS_SESSION_TOKEN: 'SESSION-ASSUMED',
    };
    const profileCreds = {
      accessKeyId: 'AKIA-PROFILE-SHOULD-BE-IGNORED',
      secretAccessKey: 'SECRET-PROFILE-SHOULD-BE-IGNORED',
      sessionToken: 'SESSION-PROFILE-SHOULD-BE-IGNORED',
    };

    applyProfileCredentialsOverlay(dockerEnv, profileCreds, /* assumeRoleActive */ true);

    expect(dockerEnv['AWS_ACCESS_KEY_ID']).toBe('AKIA-ASSUMED');
    expect(dockerEnv['AWS_SECRET_ACCESS_KEY']).toBe('SECRET-ASSUMED');
    expect(dockerEnv['AWS_SESSION_TOKEN']).toBe('SESSION-ASSUMED');
  });

  it('no-ops when --profile is not set (regression guard: forwarded process.env wins)', () => {
    // Caller flow when --profile is absent: profileCredentials is
    // undefined. The overlay must leave the env untouched so the
    // pre-#657 forwardAwsEnv-only behavior is preserved exactly.
    const dockerEnv: Record<string, string> = {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA-FROM-PROCESS-ENV',
      AWS_SECRET_ACCESS_KEY: 'SECRET-FROM-PROCESS-ENV',
      AWS_SESSION_TOKEN: 'SESSION-FROM-PROCESS-ENV',
    };
    const before = { ...dockerEnv };

    applyProfileCredentialsOverlay(dockerEnv, undefined, /* assumeRoleActive */ false);

    expect(dockerEnv).toEqual(before);
  });
});
