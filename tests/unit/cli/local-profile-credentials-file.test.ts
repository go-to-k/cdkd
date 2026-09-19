import { existsSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  buildProfileCredentialsDockerArgs,
  CONTAINER_AWS_CREDENTIALS_PATH,
  writeProfileCredentialsFile,
} from '../../../src/cli/commands/local-profile-credentials-file.js';

describe('writeProfileCredentialsFile: the onDirCreated hook (go-to-k/cdkd#3435)', () => {
  // WHY THE RETURN VALUE IS THE WRONG MOMENT. Between `mkdtemp` and this
  // function resolving sits an `await writeFile` — a real I/O boundary — and a
  // double-`^C` delivered inside it force-exits with the caller's
  // `profileCredsFile` still `undefined`. The stranded-credentials notice then
  // names NOTHING while a mode-0600 directory is already on disk, which is
  // exactly the leak go-to-k/cdkd#3410 closed, reachable through its own fix's
  // blind spot. Two reviewers found the comment asserting it could not happen.
  //
  // The hook is what the two force-exit arms read instead, so its TIMING is the
  // property under test rather than its existence.
  it('fires with the hostPath BEFORE the file is written', async () => {
    const seen: Array<{ hostPath: string; existedYet: boolean; dirExisted: boolean }> = [];
    const file = await writeProfileCredentialsFile(
      'hook-probe',
      { accessKeyId: 'A', secretAccessKey: 'B' },
      {
        onDirCreated: (hostPath) => {
          // Both observations are taken INSIDE the hook: after the call
          // returns, the file exists either way and the case would be vacuous.
          seen.push({
            hostPath,
            existedYet: existsSync(hostPath),
            dirExisted: existsSync(path.dirname(hostPath)),
          });
        },
      }
    );
    try {
      expect(seen, 'the hook never fired').toHaveLength(1);
      const first = seen[0]!;
      // THE PATH IS THE ONE THE CALLER WILL LATER DISPOSE. Without this the
      // hook could report any string and every other assertion would hold.
      expect(first.hostPath).toBe(file.hostPath);
      // THE TIMING, in both directions: the DIRECTORY — the thing that gets
      // stranded — already exists, and the credentials file does not yet. A
      // hook moved to the end of the function fails the second assertion, and
      // one moved before `mkdtemp` fails the first.
      expect(first.dirExisted, 'the hook fired before the tmpdir existed').toBe(true);
      expect(first.existedYet, 'the hook fired after the credentials were written').toBe(false);
      // ...and the write still happened, so the timing fix did not trade the
      // hook for the file.
      expect(existsSync(file.hostPath)).toBe(true);
    } finally {
      await file.dispose();
    }
  });

  it('is optional, and a write FAILURE still reports the path it stranded', async () => {
    // The other direction on the same seam. `writeProfileCredentialsFile`
    // cleans up after a failed write, but a caller that force-exits mid-write
    // never gets there — so the hook must have fired even on the path that
    // throws, or the arm it feeds is blind for exactly the failure case.
    //
    // A profile name the validator accepts but the filesystem cannot hold is
    // not available, so the failure is induced by removing the tmpdir out from
    // under the write between the hook and the `writeFile`.
    let stranded: string | undefined;
    let retracted: string | undefined;
    await expect(
      writeProfileCredentialsFile(
        'hook-failure-probe',
        { accessKeyId: 'A', secretAccessKey: 'B' },
        {
          onDirCreated: (hostPath) => {
            stranded = hostPath;
            rmSync(path.dirname(hostPath), { recursive: true, force: true });
          },
          onDirRemoved: (hostPath) => {
            retracted = hostPath;
          },
        }
      )
    ).rejects.toThrow();

    expect(stranded, 'the hook did not fire on the failing path').toBeDefined();
    expect(stranded).toMatch(/cdkd-profile-creds-/);
    // ...and the path is RETRACTED, because the cleanup `rm` removed the
    // directory (go-to-k/cdkd#3435 review round 3). A caller that kept it would
    // later tell an operator to delete something that is not there.
    expect(retracted, 'onDirRemoved did not fire after a successful cleanup').toBe(stranded);
  });

  // RECORDED, not tested: the INVERSE arm — a failed write whose cleanup `rm`
  // ALSO fails, where the directory survives and `onDirRemoved` must NOT fire,
  // so the force-exit notice still names it. A mutation probe confirmed no case
  // discriminates it (`if (removed)` -> `if (true)` leaves this file green).
  // Inducing it needs `node:fs/promises`' `rm` mocked for one call inside a
  // helper this suite otherwise runs for real, and the repo is removing
  // machinery rather than adding it, so the gap is a backlog row in the PR
  // body rather than a mock here.
});

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
