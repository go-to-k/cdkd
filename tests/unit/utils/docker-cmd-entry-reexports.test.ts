import { describe, expect, it } from 'vite-plus/test';
import * as entry from '../../../src/utils/docker-cmd.js';
import * as argvInText from '../../../src/utils/docker-cmd/argv-in-text.js';
import * as argvRedaction from '../../../src/utils/docker-cmd/argv-redaction.js';
import * as clientEnvKeys from '../../../src/utils/docker-cmd/client-env-keys.js';
import * as failure from '../../../src/utils/docker-cmd/failure.js';
import * as sensitiveEnv from '../../../src/utils/docker-cmd/sensitive-env.js';
import * as spawn from '../../../src/utils/docker-cmd/spawn.js';

/**
 * `src/utils/docker-cmd.ts` was split into the `docker-cmd/` companion
 * directory (go-to-k/cdkd#5835) and kept as the public entry every importer
 * uses. These cases pin that the entry's runtime surface is exactly what the
 * single file exported, that each name is the companion's own binding (not a
 * wrapper or a stale copy), and that the companion-internal exports the split
 * introduced did not leak into the public surface.
 */

/** The value exports of the pre-split file, per companion that now holds each. */
const SURFACE: ReadonlyArray<readonly [Record<string, unknown>, readonly string[]]> = [
  [
    spawn,
    [
      'getDockerCmd',
      'runDockerStreaming',
      'spawnStreaming',
      'runDockerForeground',
      'spawnForeground',
      'formatDockerLoginError',
    ],
  ],
  [
    clientEnvKeys,
    [
      'DOCKER_CLIENT_ENV_KEYS',
      'DOCKER_CLIENT_ENV_PREFIXES',
      'DOCKER_CLIENT_ENV_PREFIX_EXEMPTIONS',
      'isDockerClientEnvKey',
      'isMalformedEnvKey',
    ],
  ],
  [
    sensitiveEnv,
    [
      'partitionSensitiveEnv',
      'dockerSpawnEnvWithSensitive',
      'ALLOW_SECRETS_ON_ARGV_ENV',
      'isFinchVmClient',
      'finchSecretArgvRefusal',
      'resetFinchArgvWarningsForTest',
      'warnFinchArgvExposure',
    ],
  ],
  [argvRedaction, ['redactDockerArgvValues']],
  [argvInText, ['redactDockerArgvInText']],
  [
    failure,
    [
      'describeDockerExecFailure',
      'describeDockerFailure',
      'redactedDockerCause',
      'redactedCause',
      'describeDockerCapturedOutput',
    ],
  ],
];

describe('docker-cmd.ts entry re-exports (#5835)', () => {
  it('exports exactly the pre-split value surface', () => {
    const expected = SURFACE.flatMap(([, names]) => names).sort();
    // A literal count (the pre-split file's `export function` / `export const`
    // lines), so an emptied SURFACE cannot pass by collapsing.
    expect(expected).toHaveLength(25);
    expect(Object.keys(entry).sort()).toEqual(expected);
  });

  it.each(SURFACE.flatMap(([mod, names]) => names.map((name) => [name, mod] as const)))(
    '%s is the companion binding itself',
    (name, mod) => {
      expect(mod[name]).toBeDefined();
      expect((entry as Record<string, unknown>)[name]).toBe(mod[name]);
    }
  );

  it('keeps the companion-internal redaction constants out of the public surface', () => {
    expect(argvRedaction.REDACTED_ARGV_VALUE).toBe('***');
    expect(argvRedaction.ARGV_VALUE_TOKEN_RE).toBeInstanceOf(RegExp);
    expect(entry).not.toHaveProperty('REDACTED_ARGV_VALUE');
    expect(entry).not.toHaveProperty('ARGV_VALUE_TOKEN_RE');
  });

  it('redacts end to end through the entry: argv values, the text pass and the composer', () => {
    const args = ['run', '-e', 'TOKEN=hunter2-secret', 'image'];
    expect(entry.redactDockerArgvValues(args)).toEqual(['run', '-e', 'TOKEN=***', 'image']);
    const text = `Command failed: docker ${args.join(' ')}`;
    const redacted = entry.redactDockerArgvInText(text, args);
    expect(redacted).not.toContain('hunter2-secret');
    expect(redacted).toContain('TOKEN=***');
    const described = entry.describeDockerFailure(new Error(text), args);
    expect(described).not.toContain('hunter2-secret');
    const cause = entry.redactedDockerCause(new Error(text), args);
    expect(cause?.message ?? '').not.toContain('hunter2-secret');
  });
});
