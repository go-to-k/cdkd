import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vite-plus/test';
import {
  buildProfileCredentialsDockerArgs,
  CONTAINER_AWS_CREDENTIALS_PATH,
  writeProfileCredentialsFile,
} from '../../../src/cli/commands/local-profile-credentials-file.js';

describe('writeProfileCredentialsFile', () => {
  it('writes a valid AWS INI section with sessionToken when present', async () => {
    const file = await writeProfileCredentialsFile('dev-sso', {
      accessKeyId: 'AKIA-EXAMPLE',
      secretAccessKey: 'SECRET-EXAMPLE',
      sessionToken: 'SESSION-EXAMPLE',
    });
    try {
      const body = await readFile(file.hostPath, 'utf8');
      expect(body).toBe(
        '[dev-sso]\n' +
          'aws_access_key_id = AKIA-EXAMPLE\n' +
          'aws_secret_access_key = SECRET-EXAMPLE\n' +
          'aws_session_token = SESSION-EXAMPLE\n'
      );
      expect(file.containerPath).toBe(CONTAINER_AWS_CREDENTIALS_PATH);
      expect(file.profileName).toBe('dev-sso');
    } finally {
      await file.dispose();
    }
  });

  it('omits aws_session_token when the profile resolved to long-lived creds', async () => {
    const file = await writeProfileCredentialsFile('long-lived', {
      accessKeyId: 'AKIA-LIVED',
      secretAccessKey: 'SECRET-LIVED',
    });
    try {
      const body = await readFile(file.hostPath, 'utf8');
      expect(body).toBe(
        '[long-lived]\n' +
          'aws_access_key_id = AKIA-LIVED\n' +
          'aws_secret_access_key = SECRET-LIVED\n'
      );
      expect(body).not.toContain('aws_session_token');
    } finally {
      await file.dispose();
    }
  });

  it('writes the file with 0o600 permissions (owner-only readable)', async () => {
    const file = await writeProfileCredentialsFile('perm-check', {
      accessKeyId: 'AKIA-P',
      secretAccessKey: 'SECRET-P',
    });
    try {
      const stats = await stat(file.hostPath);
      // mode & 0o777 isolates the permission bits from file-type flags.
      // 0o600 = owner read+write only, no group/other access.
      // Credential files on disk must not be world-readable.
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await file.dispose();
    }
  });

  it('dispose() removes the file + tempdir', async () => {
    const file = await writeProfileCredentialsFile('cleanup', {
      accessKeyId: 'AKIA-C',
      secretAccessKey: 'SECRET-C',
    });
    // File exists pre-dispose.
    await expect(stat(file.hostPath)).resolves.toBeDefined();
    await file.dispose();
    // Gone post-dispose.
    await expect(stat(file.hostPath)).rejects.toThrow();
  });

  it('dispose() is idempotent (safe to call from concurrent cleanup paths)', async () => {
    const file = await writeProfileCredentialsFile('idempotent', {
      accessKeyId: 'AKIA-I',
      secretAccessKey: 'SECRET-I',
    });
    await file.dispose();
    // Second call must not throw — single-flight cleanup runners +
    // SIGINT-mid-finally races can both fire dispose simultaneously.
    await expect(file.dispose()).resolves.toBeUndefined();
  });

  it('rejects an empty profile name (would write an `[]` header)', async () => {
    await expect(
      writeProfileCredentialsFile('', { accessKeyId: 'A', secretAccessKey: 'B' })
    ).rejects.toThrow(/must not be empty/);
  });

  it("rejects a profile name containing ']' (would inject a second INI section)", async () => {
    await expect(
      writeProfileCredentialsFile('a]\n[evil', { accessKeyId: 'A', secretAccessKey: 'B' })
    ).rejects.toThrow(/forbidden character/);
  });

  it("rejects a profile name containing '[' (would corrupt the INI section header)", async () => {
    await expect(
      writeProfileCredentialsFile('a[b', { accessKeyId: 'A', secretAccessKey: 'B' })
    ).rejects.toThrow(/forbidden character/);
  });

  it('rejects a profile name containing CR/LF (would break the docker -e env line)', async () => {
    await expect(
      writeProfileCredentialsFile('a\nb', { accessKeyId: 'A', secretAccessKey: 'B' })
    ).rejects.toThrow(/forbidden character/);
    await expect(
      writeProfileCredentialsFile('a\rb', { accessKeyId: 'A', secretAccessKey: 'B' })
    ).rejects.toThrow(/forbidden character/);
  });

  it('uses the profile name the caller passed (matches handler-side fromIni({ profile }))', async () => {
    // Real-world case: user passes `--profile my-team-dev`; handler code
    // has `fromIni({ profile: 'my-team-dev' })`. The INI section header
    // MUST match exactly or the SDK throws "Profile 'my-team-dev' could
    // not be found".
    const file = await writeProfileCredentialsFile('my-team-dev', {
      accessKeyId: 'A',
      secretAccessKey: 'B',
    });
    try {
      const body = await readFile(file.hostPath, 'utf8');
      expect(body.startsWith('[my-team-dev]\n')).toBe(true);
    } finally {
      await file.dispose();
    }
  });
});

describe('buildProfileCredentialsDockerArgs', () => {
  it('returns empty when no file is provided (--profile not set)', () => {
    expect(buildProfileCredentialsDockerArgs(undefined)).toEqual([]);
  });

  it('emits -v mount + AWS_SHARED_CREDENTIALS_FILE + AWS_PROFILE env when file is provided', () => {
    const args = buildProfileCredentialsDockerArgs({
      hostPath: '/tmp/cdkd-profile-creds-xyz/credentials',
      containerPath: '/cdkd-aws/credentials',
      profileName: 'dev',
      dispose: async () => undefined,
    });
    expect(args).toEqual([
      '-v',
      '/tmp/cdkd-profile-creds-xyz/credentials:/cdkd-aws/credentials:ro',
      '-e',
      'AWS_SHARED_CREDENTIALS_FILE=/cdkd-aws/credentials',
      '-e',
      'AWS_PROFILE=dev',
    ]);
  });

  it('uses :ro suffix on the mount (compromised handler must not tamper with the host file)', () => {
    const args = buildProfileCredentialsDockerArgs({
      hostPath: '/host/path',
      containerPath: '/container/path',
      profileName: 'p',
      dispose: async () => undefined,
    });
    expect(args[1]).toMatch(/:ro$/);
  });
});
