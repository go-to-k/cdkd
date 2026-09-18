import { describe, expect, it } from 'vite-plus/test';

import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
} from '../../../src/utils/aws-client-defaults.js';
import {
  applyCallerIdentityCredentials,
  AWS_CREDENTIAL_ENV_KEYS,
} from '../../../src/utils/caller-credentials.js';
import { SENSITIVE_ENV_KEYS } from '../../../src/local/docker-runner.js';

/**
 * `AWS_CREDENTIAL_ENV_KEYS` is a SINGLE EDIT POINT for what three
 * `forwardAwsEnv` bodies copy into an emulated container (issue
 * [#3250](https://github.com/go-to-k/cdkd/issues/3250) item 4 wired them onto
 * it). That is what the constant is for, and it is also a new way to widen the
 * container's credential surface from one line in `src/utils/` — so the three
 * other populations that have to agree with it need a fence, because none of
 * them can be driven off it mechanically.
 *
 * Each `expect` below is a DIFFERENT consequence of adding a fourth key, and
 * the first two are the ones with teeth:
 *
 *   1. `SENSITIVE_ENV_KEYS` (`src/local/docker-runner.ts`) is what keeps a
 *      value OFF the `docker run` argv — `partitionSensitiveEnv` emits the
 *      value-carrying `-e KEY=value` form for anything not in it, and an argv
 *      is readable from `/proc/<pid>/cmdline` by any local user. A key added
 *      here and not there is forwarded at three sites and leaked at all three.
 *   2. `applyCallerIdentityCredentials`'s RESTORE arm names its three keys
 *      individually (it writes named FIELDS of a credential bag, so it cannot
 *      loop over the constant the way its STRIP arm does). A key added to the
 *      constant would therefore be STRIPPED on the no-snapshot path and
 *      FORWARDED-then-never-corrected on the restore path — the role's value
 *      surviving into the container, which is the whole class issue
 *      [#3130](https://github.com/go-to-k/cdkd/issues/3130) closed.
 *
 * This is a guard-the-guard, so it asserts the CONTENT of the population rather
 * than its size: a count is satisfied by a substitution.
 */
describe('AWS_CREDENTIAL_ENV_KEYS cannot be widened without its readers agreeing', () => {
  it('is exactly the static-credential triple', () => {
    // A literal, from the AWS SDK's own environment contract rather than from
    // anything this repo computes. `AWS_PROFILE` / `AWS_REGION` deliberately
    // are NOT here: neither is a credential, and the region keys are each
    // forwarding site's own concern.
    expect([...AWS_CREDENTIAL_ENV_KEYS]).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]);
  });

  it('is a SUBSET of the keys kept off the docker argv', () => {
    const leaked = [...AWS_CREDENTIAL_ENV_KEYS].filter((k) => !SENSITIVE_ENV_KEYS.has(k));
    expect(
      leaked,
      'every key forwarded into a container must also be masked off the `docker run` argv ' +
        '(`SENSITIVE_ENV_KEYS` in `src/local/docker-runner.ts`) — otherwise its value is ' +
        'readable from /proc/<pid>/cmdline by any local user'
    ).toEqual([]);
  });

  it('has every key both STRIPPED and RESTORED, so no key is corrected on only one path', () => {
    // Driven through the real helper in both of its arms, rather than by
    // reading the source: the restore arm's key list is spelled as field
    // assignments, which no static check can compare against the constant.
    const ROLE = 'ASIA-ROLE-AKID';
    try {
      // STRIP arm: a role was assumed over a caller who had nothing.
      setPreAssumeEnvCredentials(undefined);
      setAssumedRoleCredentials({ accessKeyId: ROLE, secretAccessKey: 's', sessionToken: 't' });
      const stripped: Record<string, string> = {};
      for (const key of AWS_CREDENTIAL_ENV_KEYS) stripped[key] = `ROLE-${key}`;
      stripped['AWS_REGION'] = 'us-east-1';
      applyCallerIdentityCredentials(stripped);
      expect(Object.keys(stripped), 'the strip arm must remove every key in the population').toEqual(
        ['AWS_REGION']
      );

      // RESTORE arm: a role was assumed over a caller who HAD a triple. Every
      // key in the population must be overwritten or removed — a key left
      // holding its `ROLE-` value is one the constant forwards and this helper
      // does not correct.
      resetAwsClientDefaults();
      setPreAssumeEnvCredentials({
        accessKeyId: 'AKIA-CALLER',
        secretAccessKey: 'caller-secret',
        sessionToken: 'caller-token',
      });
      setAssumedRoleCredentials({ accessKeyId: ROLE, secretAccessKey: 's', sessionToken: 't' });
      const restored: Record<string, string> = {};
      for (const key of AWS_CREDENTIAL_ENV_KEYS) restored[key] = `ROLE-${key}`;
      applyCallerIdentityCredentials(restored);
      const uncorrected = [...AWS_CREDENTIAL_ENV_KEYS].filter((k) =>
        (restored[k] ?? '').startsWith('ROLE-')
      );
      expect(
        uncorrected,
        "these keys keep the assumed role's value after the restore — add them to " +
          '`applyCallerIdentityCredentials`, which names its restored keys one by one'
      ).toEqual([]);
    } finally {
      resetAwsClientDefaults();
    }
  });
});
