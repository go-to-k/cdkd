// The win32 arm of `dockerSpawnEnvWithSensitive` / `partitionSensitiveEnv`,
// run on a REAL Windows host (issue #2190). `docker-cmd.test.ts` drives the
// same arm through the injected `platform` argument; this file is what proves
// the premise that argument stands in for: which of two letter-case spellings
// a spawned child actually reads. It runs only on win32, in the
// `windows-env-precedence` CI job, which sets `CDKD_REQUIRE_WIN32=1` so a
// skipped run cannot pass for a measured one, and `CDKD_WIN32_REPORT` to a
// file the job prints.
//
// Two readers stand in for the docker client: a Node child (`process.env`,
// case-insensitive on Windows) and `cmd.exe` (`%NAME%` expansion). Both read
// the environment block the parent's `spawn` built, which is all the docker
// client reads too.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  dockerSpawnEnvWithSensitive,
  partitionSensitiveEnv,
} from '../../../src/utils/docker-cmd.js';
import { getLogger } from '../../../src/utils/logger.js';

const isWin32 = process.platform === 'win32';
const SPAWN_TIMEOUT_MS = 30_000;

function report(label: string, value: unknown): void {
  const path = process.env['CDKD_WIN32_REPORT'];
  if (path) appendFileSync(path, `${JSON.stringify({ label, value })}\n`);
}

/** What a Node child reads for `name`, or `<unset>`. */
function nodeChildReads(name: string, env: NodeJS.ProcessEnv): string {
  return execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(process.env[${JSON.stringify(name)}] ?? '<unset>')`],
    { env, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS }
  );
}

/** What `cmd.exe` expands `%name%` to (the literal `%name%` when unset). */
function cmdReads(name: string, env: NodeJS.ProcessEnv): string {
  const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `"echo %${name}%"`], {
    env,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    windowsVerbatimArguments: true,
  });
  if (run.error) throw run.error;
  expect(run.status).toBe(0);
  return run.stdout.trim();
}

it('runs on win32 whenever the Windows CI job asks for it', () => {
  // The guard against a vacuous job: `describe.skipIf` below would otherwise
  // turn a mis-detected platform into an all-skipped green run.
  if (process.env['CDKD_REQUIRE_WIN32'] === '1') expect(process.platform).toBe('win32');
});

describe.skipIf(!isWin32)('win32 env-block letter-case precedence (issue #2190)', () => {
  const PROBE = 'CDKD_2190_PROBE';
  const lower = PROBE.toLowerCase();
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    process.env[PROBE] = 'host-value';
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env[PROBE];
  });

  it(
    'MEASURES which spelling a child reads when both reach spawn (the unfixed shape)',
    () => {
      // `{ ...process.env }` keeps the host's own spelling, so this is exactly
      // the env the pre-#2190 code handed `spawn` for a secret named in lower
      // case. Recorded, not asserted beyond "one of the two": the point of the
      // fix is that cdkd stops depending on this answer.
      const env: NodeJS.ProcessEnv = { ...process.env, [lower]: 'secret-value' };
      expect(Object.keys(env).filter((k) => k.toUpperCase() === PROBE)).toEqual([PROBE, lower]);
      const node = nodeChildReads(PROBE, env);
      const cmd = cmdReads(PROBE, env);
      report('unfixed: host CDKD_2190_PROBE + secret cdkd_2190_probe', { node, cmd });
      expect(['host-value', 'secret-value']).toContain(node);
      expect(['host-value', 'secret-value']).toContain(cmd);
    },
    SPAWN_TIMEOUT_MS * 2
  );

  it(
    'a lower-case secret replaces the host variable for every reader',
    () => {
      const env = dockerSpawnEnvWithSensitive({ [lower]: 'secret-value' });
      const node = nodeChildReads(PROBE, env);
      const cmd = cmdReads(PROBE, env);
      report('fixed: dockerSpawnEnvWithSensitive({ cdkd_2190_probe })', { node, cmd });
      expect(node).toBe('secret-value');
      expect(cmd).toBe('secret-value');
      // The exact name docker's value-less `-e cdkd_2190_probe` looks up.
      expect(nodeChildReads(lower, env)).toBe('secret-value');
    },
    SPAWN_TIMEOUT_MS * 3
  );

  it(
    'two sensitive spellings: every reader gets the last, the one the warning names',
    () => {
      const partitioned = partitionSensitiveEnv(
        { my_2190_secret: 'first', MY_2190_SECRET: 'last' },
        new Set(['my_2190_secret', 'MY_2190_SECRET'])
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain(
        'receives the value of MY_2190_SECRET under every one'
      );
      const env = dockerSpawnEnvWithSensitive(partitioned.sensitiveEnv);
      const reads = {
        lowerNode: nodeChildReads('my_2190_secret', env),
        upperNode: nodeChildReads('MY_2190_SECRET', env),
        cmd: cmdReads('MY_2190_SECRET', env),
      };
      report('fixed: two sensitive spellings', reads);
      expect(reads).toEqual({ lowerNode: 'last', upperNode: 'last', cmd: 'last' });
    },
    SPAWN_TIMEOUT_MS * 4
  );

  it(
    'a secret matching a host var beyond a-z case is refused and the host var survives',
    () => {
      // `ß` upper-cases to `SS`, which Windows' own table does not do, while Node's spawn dedups by `toUpperCase`. Measured first:
      // with both names handed to spawn, which values do the readers see?
      process.env['CDKD_2190_STRASSE'] = 'host-value';
      try {
        const raw: NodeJS.ProcessEnv = { ...process.env, CDKD_2190_STRAßE: 'secret-value' };
        const rawReads = {
          ascii: nodeChildReads('CDKD_2190_STRASSE', raw),
          eszett: nodeChildReads('CDKD_2190_STRAßE', raw),
        };
        report('unfixed: host CDKD_2190_STRASSE + secret CDKD_2190_STRAßE', rawReads);
        // The premise `Win32EnvNames` rests on: Node dropped the secret, the
        // sort-later name of its `toUpperCase` group.
        expect(rawReads).toEqual({ ascii: 'host-value', eszett: '<unset>' });
        // cdkd refuses the secret, so the host's variable is untouched.
        const env = dockerSpawnEnvWithSensitive({ CDKD_2190_STRAßE: 'secret-value' });
        expect(env['CDKD_2190_STRAßE']).toBeUndefined();
        const reads = {
          node: nodeChildReads('CDKD_2190_STRASSE', env),
          cmd: cmdReads('CDKD_2190_STRASSE', env),
        };
        report('fixed: host CDKD_2190_STRASSE + secret CDKD_2190_STRAßE', reads);
        expect(reads).toEqual({ node: 'host-value', cmd: 'host-value' });
      } finally {
        delete process.env['CDKD_2190_STRASSE'];
      }
    },
    SPAWN_TIMEOUT_MS * 4
  );

  it(
    'a secret named after a Windows system var leaves the host value in place',
    () => {
      const hostComSpec = process.env['ComSpec'];
      expect(hostComSpec).toBeTruthy();
      const { collisions, sensitiveEnv } = partitionSensitiveEnv(
        { comspec: 'C:\\evil.exe', systemroot: 'C:\\evil' },
        new Set(['comspec', 'systemroot'])
      );
      expect(collisions).toEqual(['comspec', 'systemroot']);
      const env = dockerSpawnEnvWithSensitive({ ...sensitiveEnv, comspec: 'C:\\evil.exe' });
      const reads = { node: nodeChildReads('ComSpec', env), cmd: cmdReads('ComSpec', env) };
      report('fixed: secret comspec', reads);
      expect(reads).toEqual({ node: hostComSpec, cmd: hostComSpec });
    },
    SPAWN_TIMEOUT_MS * 3
  );
});
