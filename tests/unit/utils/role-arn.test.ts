import { readFileSync } from 'node:fs';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

const mockStsSend = vi.fn();
vi.mock('@aws-sdk/client-sts', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-sts')>(
    '@aws-sdk/client-sts',
  );
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      send: mockStsSend,
      destroy: vi.fn(),
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

import { applyRoleArnIfSet } from '../../../src/utils/role-arn.js';
import { getLogger } from '../../../src/utils/logger.js';
import {
  getAssumedRoleCredentials,
  getPreAssumeEnvCredentials,
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
} from '../../../src/utils/aws-client-defaults.js';

/** The single mocked child logger every case in this file shares. */
const roleArnLogger = getLogger().child('role-arn');

const PRESERVED_ENV = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'CDKD_ROLE_ARN',
];

describe('applyRoleArnIfSet', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    mockStsSend.mockReset();
    vi.mocked(STSClient).mockClear();
    vi.mocked(roleArnLogger.warn).mockClear();
    // The assumed-role bag is process-global module state, so a role published
    // by one case would change what every later case's client resolves.
    resetAwsClientDefaults();
    originalEnv = {};
    for (const key of PRESERVED_ENV) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetAwsClientDefaults();
    for (const key of PRESERVED_ENV) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('is a no-op when neither --role-arn nor CDKD_ROLE_ARN is set', async () => {
    await applyRoleArnIfSet({ roleArn: undefined, region: 'us-east-1' });

    expect(STSClient).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(process.env['AWS_ACCESS_KEY_ID']).toBeUndefined();
  });

  it('writes assumed-role temp creds into AWS_* env vars when --role-arn is provided', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-temp-key',
        SecretAccessKey: 'temp-secret',
        SessionToken: 'temp-session',
        Expiration: new Date('2026-01-01T00:00:00Z'),
      },
    });

    await applyRoleArnIfSet({
      roleArn: 'arn:aws:iam::123456789012:role/cdkd-deploy',
      region: 'us-east-1',
    });

    expect(STSClient).toHaveBeenCalledTimes(1);
    expect(STSClient).toHaveBeenCalledWith({ region: 'us-east-1' });
    const cmd = mockStsSend.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(AssumeRoleCommand);
    expect(cmd.input.RoleArn).toBe('arn:aws:iam::123456789012:role/cdkd-deploy');
    expect(cmd.input.RoleSessionName).toMatch(/^cdkd-\d+$/);
    expect(cmd.input.DurationSeconds).toBe(3600);

    expect(process.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-temp-key');
    expect(process.env['AWS_SECRET_ACCESS_KEY']).toBe('temp-secret');
    expect(process.env['AWS_SESSION_TOKEN']).toBe('temp-session');
  });

  it('falls back to CDKD_ROLE_ARN env var when --role-arn flag is not set', async () => {
    process.env['CDKD_ROLE_ARN'] = 'arn:aws:iam::999999999999:role/from-env';
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-env',
        SecretAccessKey: 'secret-env',
        SessionToken: 'session-env',
      },
    });

    await applyRoleArnIfSet({ roleArn: undefined, region: 'us-west-2' });

    const cmd = mockStsSend.mock.calls[0][0];
    expect(cmd.input.RoleArn).toBe('arn:aws:iam::999999999999:role/from-env');
    expect(process.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-env');
  });

  it('CLI --role-arn takes precedence over CDKD_ROLE_ARN env var', async () => {
    process.env['CDKD_ROLE_ARN'] = 'arn:aws:iam::000:role/env-version';
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-cli',
        SecretAccessKey: 'secret',
        SessionToken: 'session',
      },
    });

    await applyRoleArnIfSet({
      roleArn: 'arn:aws:iam::123:role/cli-version',
      region: 'us-east-1',
    });

    const cmd = mockStsSend.mock.calls[0][0];
    expect(cmd.input.RoleArn).toBe('arn:aws:iam::123:role/cli-version');
  });

  it('throws when AssumeRole returns no credentials', async () => {
    mockStsSend.mockResolvedValueOnce({});

    await expect(
      applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::123:role/x',
        region: 'us-east-1',
      }),
    ).rejects.toThrow(/AssumeRole returned no credentials/);
    expect(process.env['AWS_ACCESS_KEY_ID']).toBeUndefined();
  });

  it('throws when AssumeRole returns partial credentials', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-only',
        // SecretAccessKey + SessionToken missing
      },
    });

    await expect(
      applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::123:role/x',
        region: 'us-east-1',
      }),
    ).rejects.toThrow(/missing credentials fields/);
  });

  /**
   * `--profile` + `--role-arn` (issue
   * [#3130](https://github.com/go-to-k/cdkd/issues/3130)). The role wins for
   * credential purposes; the profile's one job is to answer the AssumeRole.
   *
   * These cases pin the two writes the fix depends on. That they are SUFFICIENT
   * — that the SDK really resolves the role and not the profile — is a claim
   * about the SDK and is proved against the real one in
   * `aws-client-defaults-assumed-role.test.ts`.
   */
  describe('when a profile is also in play', () => {
    const assumeOk = (): void => {
      mockStsSend.mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIA-temp-key',
          SecretAccessKey: 'temp-secret',
          SessionToken: 'temp-session',
          Expiration: new Date('2026-01-01T00:00:00Z'),
        },
      });
    };

    it('publishes the assumed credentials to every SDK client cdkd builds', async () => {
      process.env['AWS_PROFILE'] = 'ci';
      assumeOk();

      await applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::222222222222:role/cdkd-deploy',
        region: 'us-east-1',
      });

      expect(getAssumedRoleCredentials()).toEqual({
        accessKeyId: 'ASIA-temp-key',
        secretAccessKey: 'temp-secret',
        sessionToken: 'temp-session',
        expiration: new Date('2026-01-01T00:00:00Z'),
      });
    });

    it('LEAVES AWS_PROFILE in place — it is the shared-config source a role cannot replace', async () => {
      // Deleting it would be the obvious reading of the issue and is wrong in
      // a way nothing else here would catch: with a profile EXPORTED rather
      // than passed, `Synthesizer.resolveSdkDefaultRegion` has no other region
      // source, so the CDK app would synthesize env-agnostic stacks for a
      // different region than the profile names. The identity is fixed through
      // the credentials channel instead.
      process.env['AWS_PROFILE'] = 'ci';
      assumeOk();

      await applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::222222222222:role/cdkd-deploy',
        region: 'us-east-1',
      });

      expect(process.env['AWS_PROFILE']).toBe('ci');
      expect(process.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-temp-key');
    });

    it('WARNS that a program cdkd starts still resolves the profile', async () => {
      // The issue's "warn loudly when both are set and the fix cannot
      // reconcile them" item. The residual is narrow but real, and silence is
      // exactly what made the original defect cost an account.
      process.env['AWS_PROFILE'] = 'ci';
      assumeOk();

      await applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::222222222222:role/cdkd-deploy',
        region: 'us-east-1',
      });

      const warned = vi.mocked(roleArnLogger.warn).mock.calls.map((c) => String(c[0]));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/AWS_PROFILE is set and a role has been assumed/);
      // Both halves of the split, because a message naming only one of them
      // would leave the other surprise silent.
      expect(warned[0]).toMatch(/cdkd makes to\s+deploy and read state run as the role/);
      expect(warned[0]).toMatch(/emulated function or task is given/);
      // The ROLE is not named either: it may have come from CDKD_ROLE_ARN, so
      // naming the flag would be wrong half the time.
      expect(warned[0]).not.toMatch(/--role-arn/);
      // The profile NAME must not be interpolated into terminal-bound text.
      expect(warned[0]).not.toMatch(/\bci\b/);
    });

    it('does NOT warn for an EMPTY AWS_PROFILE, which selects no profile', async () => {
      // `--profile ''` reaches the environment as an empty string; the SDK
      // ignores it, so warning would describe a conflict that does not exist.
      process.env['AWS_PROFILE'] = '';
      assumeOk();

      await applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::222222222222:role/cdkd-deploy',
        region: 'us-east-1',
      });

      expect(vi.mocked(roleArnLogger.warn)).not.toHaveBeenCalled();
    });

    it('does NOT warn when there is no profile to be confused about', async () => {
      // The other polarity — otherwise the warning is unconditional noise and
      // says nothing about the combination.
      assumeOk();

      await applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::222222222222:role/cdkd-deploy',
        region: 'us-east-1',
      });

      expect(vi.mocked(roleArnLogger.warn)).not.toHaveBeenCalled();
    });

    it('has the profile in the environment WHILE the AssumeRole call is made', async () => {
      // The base credentials have to answer the STS hop — nothing about the
      // profile may change before it completes.
      process.env['AWS_PROFILE'] = 'ci';
      let profileDuringSend: string | undefined;
      mockStsSend.mockImplementationOnce(async () => {
        profileDuringSend = process.env['AWS_PROFILE'];
        return {
          Credentials: {
            AccessKeyId: 'ASIA-temp-key',
            SecretAccessKey: 'temp-secret',
            SessionToken: 'temp-session',
          },
        };
      });

      await applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::222222222222:role/cdkd-deploy',
        region: 'us-east-1',
      });

      expect(profileDuringSend).toBe('ci');
    });

    it('publishes NOTHING when the AssumeRole FAILS — the base credentials stay in charge', async () => {
      process.env['AWS_PROFILE'] = 'ci';
      mockStsSend.mockResolvedValueOnce({});

      await expect(
        applyRoleArnIfSet({
          roleArn: 'arn:aws:iam::222222222222:role/cdkd-deploy',
          region: 'us-east-1',
        }),
      ).rejects.toThrow(/AssumeRole returned no credentials/);

      expect(process.env['AWS_PROFILE']).toBe('ci');
      expect(getAssumedRoleCredentials()).toBeUndefined();
    });

    it('leaves --profile ALONE untouched when no role is set', async () => {
      // The other polarity: a profile-only run must be byte-identical to before.
      process.env['AWS_PROFILE'] = 'ci';

      await applyRoleArnIfSet({ roleArn: undefined, region: 'us-east-1' });

      expect(process.env['AWS_PROFILE']).toBe('ci');
      expect(getAssumedRoleCredentials()).toBeUndefined();
    });

    it('publishes credentials for --role-arn ALONE, and still writes the env triple', async () => {
      // The env triple is what a client built outside `src/**` reads — the
      // CDK app subprocess and cdk-local's own clients.
      assumeOk();

      await applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::222222222222:role/cdkd-deploy',
        region: 'us-east-1',
      });

      expect(getAssumedRoleCredentials()).toMatchObject({ accessKeyId: 'ASIA-temp-key' });
      expect(process.env['AWS_SESSION_TOKEN']).toBe('temp-session');
    });

    it('omits `expiration` when STS returned none, rather than publishing undefined', async () => {
      mockStsSend.mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIA-no-exp',
          SecretAccessKey: 'temp-secret',
          SessionToken: 'temp-session',
        },
      });

      await applyRoleArnIfSet({ roleArn: 'arn:aws:iam::123:role/x', region: 'us-east-1' });

      expect(getAssumedRoleCredentials()).not.toHaveProperty('expiration');
    });
  });

  describe('the caller snapshot is taken BEFORE the env triple is overwritten', () => {
    // The ordering IS the #3130 fix, and it lived in three lines of straight-line
    // code with no test at all: moving `setPreAssumeEnvCredentials(...)` below
    // the three `process.env[...] =` writes captures the ROLE's triple as "the
    // caller", so `cdkd local invoke --role-arn <r>` hands the emulated
    // container the deploy role again — the literal regression — with every
    // other test in the tree still green, and neither local-surface fence
    // watching this file. `local-container-caller-identity.test.ts` sets the
    // snapshot BY HAND, so it cannot see the ordering either.

    it('snapshots the CALLER key, not the role key the same function then writes', async () => {
      process.env['AWS_ACCESS_KEY_ID'] = 'AKIA-caller-own';
      process.env['AWS_SECRET_ACCESS_KEY'] = 'caller-secret';
      process.env['AWS_SESSION_TOKEN'] = 'caller-token';
      mockStsSend.mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIA-role-key',
          SecretAccessKey: 'role-secret',
          SessionToken: 'role-token',
        },
      });

      await applyRoleArnIfSet({
        roleArn: 'arn:aws:iam::222222222222:role/cdkd-deploy',
        region: 'us-east-1',
      });

      expect(getPreAssumeEnvCredentials()?.accessKeyId).toBe('AKIA-caller-own');
      expect(getPreAssumeEnvCredentials()?.secretAccessKey).toBe('caller-secret');
      expect(getPreAssumeEnvCredentials()?.sessionToken).toBe('caller-token');
      // The overwrite itself still happened — otherwise a "snapshot the caller"
      // regression could be faked by not writing the role at all.
      expect(process.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-role-key');
    });

    it('records NO snapshot when the caller carried no static triple', async () => {
      // The SSO / IMDS / container-role caller. `undefined` here is what
      // `caller-credentials.ts` turns into "STRIP the triple" rather than
      // "inherit the role", so a snapshot fabricated from the post-write
      // environment would silently re-open the whole class.
      mockStsSend.mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIA-role-key',
          SecretAccessKey: 'role-secret',
          SessionToken: 'role-token',
        },
      });

      await applyRoleArnIfSet({ roleArn: 'arn:aws:iam::123:role/x', region: 'us-east-1' });

      expect(getPreAssumeEnvCredentials()).toBeUndefined();
    });
  });

  describe('a role already published cannot be chained onto', () => {
    it('REFUSES BEFORE the hop, leaving env, snapshot and bag untouched', async () => {
      // The guard is at the TOP of `applyRoleArnIfSet`. Asserting only the bag
      // would pass with the guard sitting after the STS hop — where the damage
      // is already done: a real `sts:AssumeRole` issued, role A's triple
      // snapshotted as "the caller", and `process.env` carrying role B.
      setAssumedRoleCredentials({
        accessKeyId: 'ASIA-already-published',
        secretAccessKey: 's',
        sessionToken: 't',
      });
      setPreAssumeEnvCredentials({
        accessKeyId: 'AKIA-caller-own',
        secretAccessKey: 'caller-secret',
      });
      process.env['AWS_ACCESS_KEY_ID'] = 'ASIA-already-published';
      mockStsSend.mockResolvedValueOnce({
        Credentials: { AccessKeyId: 'ASIA-b', SecretAccessKey: 's', SessionToken: 't' },
      });

      await expect(
        applyRoleArnIfSet({ roleArn: 'arn:aws:iam::222222222222:role/b', region: 'us-east-1' })
      ).rejects.toThrow(/already been published/);

      expect(mockStsSend).not.toHaveBeenCalled();
      expect(vi.mocked(STSClient)).not.toHaveBeenCalled();
      expect(getAssumedRoleCredentials()?.accessKeyId).toBe('ASIA-already-published');
      expect(getPreAssumeEnvCredentials()?.accessKeyId).toBe('AKIA-caller-own');
      expect(process.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-already-published');
    });

    it('still opts the hop out of the published role, as the inner fence', () => {
      // The construction site keeps `ignoreAssumedRole: true` even though the
      // guard above makes a published role unreachable here. The state is no
      // longer producible through this function, so what is pinned is the
      // SOURCE: the option is still passed, and a "dead code" cleanup that
      // dropped it would leave the only remaining protection in one guard.
      const source = readFileSync(
        new URL('../../../src/utils/role-arn.ts', import.meta.url),
        'utf8'
      );
      // Anchored at BOTH ends, and the end anchor is the function's OWN
      // closing brace rather than the next `export`. Slicing to EOF is correct
      // only while `applyRoleArnIfSet` happens to be the last function in the
      // file, and slicing to `'\nexport '` only extends that by one step: any
      // sibling appended below it that is not exported — a module-private
      // helper, which is the likelier thing to add — stays INSIDE the slice and
      // satisfies this assertion on the new function's behalf, leaving the
      // check green over a deleted option. A column-0 `}` on its own line ends
      // exactly one top-level function and cannot be pushed further out by
      // anything written after it.
      const start = source.indexOf('export async function applyRoleArnIfSet');
      expect(start).toBeGreaterThan(-1);
      const close = source.indexOf('\n}\n', start);
      expect(close).toBeGreaterThan(start);
      const applyBody = source.slice(start, close);
      // A floor on the slice: a mis-anchored end would silently shrink it to
      // nothing and the `toContain` below would be the failure, not the guard.
      expect(applyBody).toContain('const sts = new STSClient({');
      expect(applyBody).toContain('ignoreAssumedRole: true');
    });
  });

  it('passes through region: undefined to STSClient when not provided', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-x',
        SecretAccessKey: 's',
        SessionToken: 't',
      },
    });

    await applyRoleArnIfSet({ roleArn: 'arn:aws:iam::123:role/x', region: undefined });

    // STS region falls back to the SDK default chain (env / profile);
    // we don't pass region in that case.
    expect(STSClient).toHaveBeenCalledWith({});
  });
});

/**
 * The cross-account AssumeRole message is CAPPED as well as sanitized.
 *
 * go-to-k/cdkd#3408's security review, on go-to-k/cdkd#3397's own fix. That
 * issue gave `assumeRoleForCrossAccountStateRead`'s STS error text
 * `displaySafe`, closing the CHARSET half of "the guard defeated by its own
 * neighbour" — the ARN beside it is capped at `ROLE_ARN_MAX_CODE_POINTS`, and
 * an unbounded neighbour defeats that cap in the LENGTH dimension instead.
 *
 * It is reachable rather than theoretical: STS answers an unparseable `RoleArn`
 * with a `ValidationError` that ECHOES THE SUBMITTED VALUE VERBATIM, and on
 * this path the `RoleArn` is a literal from the user's own template. So the
 * message's length is chosen by whoever wrote the template.
 */
describe('assumeRoleForCrossAccountStateRead bounds AWS error text (issue #3397 review)', () => {
  beforeEach(() => {
    mockStsSend.mockReset();
    resetAwsClientDefaults();
  });

  it('truncates an STS message that echoes an oversized submitted value', async () => {
    const { assumeRoleForCrossAccountStateRead, clearCrossAccountCredentialsCache } = await import(
      '../../../src/utils/role-arn.js'
    );
    clearCrossAccountCredentialsCache();

    // A message the size an ECHOED payload can reach. The literal is
    // independent of `AWS_MESSAGE_MAX_CODE_POINTS` in both directions, so this
    // case cannot scale with the constant the way a `CAP + 1` input would.
    const echoed = 'E'.repeat(200_000);
    mockStsSend.mockRejectedValue(new Error(`ValidationException: rejected ${echoed}`));

    const err = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/Producer'
    ).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    expect(err, 'the assume was expected to fail').toBeDefined();
    const message = String(err?.message ?? '');

    // BOUNDED. The remaining allowance is the sentence cdkd wraps around it
    // (the ARN, the trust-policy hint and the docs URL), which is well under
    // 2000 characters.
    expect(
      message.length,
      'the echoed payload returned unbounded past the cap the ARN itself paid'
    ).toBeLessThan(10_000);

    // ...and still DIAGNOSTIC. A cap that emptied the message would satisfy the
    // bound above while costing the user the reason.
    expect(message).toContain('AssumeRole into');
    expect(message).toContain('ValidationException');
    expect(message).toContain('trust-policy');
  });

  it('leaves an ORDINARY STS message intact', async () => {
    // The other direction: the cap is a flood stop, not a formatting rule, so a
    // real AWS sentence must pass through whole.
    const { assumeRoleForCrossAccountStateRead, clearCrossAccountCredentialsCache } = await import(
      '../../../src/utils/role-arn.js'
    );
    clearCrossAccountCredentialsCache();

    const real =
      'User: arn:aws:iam::111122223333:user/dev is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::123456789012:role/Producer';
    mockStsSend.mockRejectedValue(new Error(real));

    const err = await assumeRoleForCrossAccountStateRead(
      'arn:aws:iam::123456789012:role/Producer'
    ).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    expect(String(err?.message ?? '')).toContain(real);
  });
});

/**
 * `applyRoleArnIfSet` sanitizes an STS REJECTION, not only its debug line.
 *
 * go-to-k/cdkd#3408 round 2's MAJOR. This function wrapped `sts.send` in
 * `try { ... } finally { sts.destroy() }` with NO `catch`, so an STS rejection
 * propagated verbatim — while its twin `assumeRoleForCrossAccountStateRead`
 * caught and sanitized for the stated reason that STS ECHOES THE SUBMITTED
 * RoleArn back. One class, two halves, one guard.
 *
 * Reachable rather than theoretical: `IAM_ROLE_ARN_REGEX` in
 * `src/cli/options.ts` is START-anchored and constrains nothing past `role/`,
 * `formatError` renders the message, and `ConsoleLogger.formatMessage`
 * sanitizes a call's extra ARGS and never the message itself.
 */
describe('applyRoleArnIfSet sanitizes an STS rejection (issue #3397 review round 2)', () => {
  beforeEach(() => {
    mockStsSend.mockReset();
    resetAwsClientDefaults();
  });

  it('strips control characters STS echoed back from the submitted RoleArn', async () => {
    const esc = String.fromCharCode(0x1b);
    const hostile = `arn:aws:iam::123456789012:role/x${esc}[2K\revil`;
    // The real shape: STS quotes the submitted value into its own message.
    mockStsSend.mockRejectedValue(
      new Error(`ValidationError: ${hostile} is invalid`)
    );

    const err = await applyRoleArnIfSet({ roleArn: hostile, region: 'us-east-1' }).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    expect(err, 'the assume was expected to fail').toBeDefined();
    const message = String(err?.message ?? '');

    expect(message, 'a raw ESC escaped through the STS rejection').not.toContain(esc);
    expect(message, 'a raw CR escaped through the STS rejection').not.toContain('\r');
    // ...and it still says what happened and which role, on BOTH sides of the
    // sanitization -- a guard that emptied the message would pass the two
    // assertions above.
    expect(message).toContain('AssumeRole for');
    expect(message).toContain('ValidationError');
    expect(message).toContain('evil');
  });

  it('threads the ORIGINAL error as `cause`, unmasked, for the retry classifiers', async () => {
    // `layout-deployment-secrets.md`'s rule for every wrapper of an AWS
    // failure: the retry classifiers walk `$metadata` down the cause chain, so
    // masking the cause would change which failures are retryable.
    const original = new Error('ValidationError: nope');
    mockStsSend.mockRejectedValue(original);

    const err = await applyRoleArnIfSet({
      roleArn: 'arn:aws:iam::123456789012:role/R',
      region: 'us-east-1',
    }).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    expect((err as Error & { cause?: unknown }).cause).toBe(original);
  });
});
