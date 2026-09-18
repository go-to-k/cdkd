import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { writeProfileCredentialsFile } from '../../../src/cli/commands/local-profile-credentials-file.js';
import { resolveProfileCredentials } from '../../../src/cli/commands/local-start-api.js';
import {
  assumeRoleFallbackWarning,
  resolveHostCredentialsForSigV4,
} from '../../../src/cli/commands/local-invoke-agentcore.js';
import { ConsoleLogger, getLogger, setLogger } from '../../../src/utils/logger.js';
import { resetAwsClientDefaults } from '../../../src/utils/aws-client-defaults.js';

/**
 * Issue [#3377](https://github.com/go-to-k/cdkd/issues/3377): a user-supplied
 * `--profile <name>` reaching a terminal-bound string unsanitized.
 *
 * WHY EVERY ASSERTION CALLS ITS SUBJECT DIRECTLY. `formatError` sanitizes an
 * error's `cause`, and `ConsoleLogger.formatMessage` sanitizes an extra ARG --
 * so a probe that enters through either of those routes is answered by the
 * enclosing layer and stays green whatever the site does. Neither layer touches
 * the value tested here (an error's own `message`, and a log message's own
 * text), and calling the function directly is what keeps that true rather than
 * relying on it.
 *
 * THE TWO SHAPES DO NOT TAKE THE SAME HELPER, which is the substance of the
 * issue rather than a detail:
 *
 *   - a MESSAGE takes `displayIdent` -- ASCII allowlist, length cap, and a
 *     JSON-quoted boundary for anything outside the plain-identifier set;
 *   - a COMMAND CDKD TELLS AN OPERATOR TO RUN takes `isPasteableIdent`, because
 *     `displayIdent` renders `~evil` and `-rf` bare (every character is a plain
 *     identifier character) while the shell reads the first as a home directory
 *     and the second as a flag. `~evil` is therefore the discriminating needle
 *     between the two helpers, and it is the one this file leans on: a site
 *     that took `displayIdent` for its command half passes every control-
 *     character case and still emits a command that does not mean what it says.
 */

const ESC = '\u001b';
const CSI_C1 = '\u009b';
const BIDI_OVERRIDE = '\u202e';

const credsProviderMock = vi.fn();
const stsSendMock = vi.fn();
const stsDestroyMock = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    config: { credentials: credsProviderMock },
    send: stsSendMock,
    destroy: stsDestroyMock,
  })),
  AssumeRoleCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

describe('writeProfileCredentialsFile: the refusal renders the name it is refusing (issue #3377)', () => {
  it('strips the terminal-forging classes its own validator does not reject', async () => {
    // The `]` is what TRIPS the validator; the control character rides along.
    // That pairing is the whole point: the two predicates answer different
    // questions, so the character that reaches the throw is by construction
    // one the validator had an opinion about, and the one that corrupts the
    // TERMINAL is one it did not.
    for (const hostile of [ESC, CSI_C1, BIDI_OVERRIDE, '\u0085', '\u2028']) {
      let message = '';
      try {
        await writeProfileCredentialsFile(`pro${hostile}d]`, {
          accessKeyId: 'AKIA',
          secretAccessKey: 'secret',
        });
        throw new Error('expected a refusal');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(
        message,
        `U+${hostile.codePointAt(0)!.toString(16)} survived into the refusal`
      ).not.toContain(hostile);
      expect(message).toContain('contains a forbidden character');
    }
  });

  it('gives the name a visible BOUNDARY, since every value reaching it is non-plain', async () => {
    // `displayIdent` quotes conditionally, and a value that reaches this throw
    // is non-plain by construction (CR / LF sanitize to a space and so read as
    // ALTERED; `[` and `]` are outside the plain-identifier set), so the name
    // always arrives quoted -- which is why the hand-written `'...'` pair was
    // dropped rather than kept around the rendering.
    await expect(
      writeProfileCredentialsFile('prod]evil', { accessKeyId: 'A', secretAccessKey: 'S' })
    ).rejects.toThrow('"prod]evil"');
    // Not double-quoted: a second pair would leave a reader unable to tell
    // which quote the name ends at.
    await expect(
      writeProfileCredentialsFile('prod]evil', { accessKeyId: 'A', secretAccessKey: 'S' })
    ).rejects.not.toThrow(`'"prod]evil"'`);
  });

  it('still WRITES a legitimate name byte-identically', async () => {
    // The other direction. Sanitizing the refusal must not have touched the
    // file the happy path writes -- the INI section header is a lookup key the
    // container's `fromIni({ profile })` has to match exactly.
    const file = await writeProfileCredentialsFile('dev-sso', {
      accessKeyId: 'AKIA-PLAIN',
      secretAccessKey: 'secret-plain',
    });
    try {
      expect(readFileSync(file.hostPath, 'utf8')).toContain('[dev-sso]');
      expect(file.profileName).toBe('dev-sso');
    } finally {
      await file.dispose();
    }
  });
});

describe('resolveProfileCredentials: the message half and the PASTEABLE half take different helpers (issue #3377)', () => {
  beforeEach(() => {
    credsProviderMock.mockReset();
    stsSendMock.mockReset();
    stsDestroyMock.mockReset();
    credsProviderMock.mockResolvedValue(undefined);
  });

  it('sanitizes the name in the MESSAGE half', async () => {
    for (const hostile of [ESC, CSI_C1, BIDI_OVERRIDE, '\u0085', '\u2028']) {
      let message = '';
      try {
        await resolveProfileCredentials(`pro${hostile}d`);
        throw new Error('expected a refusal');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(
        message,
        `U+${hostile.codePointAt(0)!.toString(16)} survived into the message`
      ).not.toContain(hostile);
      expect(message).toContain('resolved without usable credentials');
    }
  });

  it('offers the `aws sso login` command for a name that is safe to paste', async () => {
    await expect(resolveProfileCredentials('dev-sso')).rejects.toThrow(
      'aws sso login --profile dev-sso'
    );
  });

  it('REFUSES to build the command out of a name the shell would reinterpret', async () => {
    // The discriminator between the two helpers. Every character of `~evil`
    // and of `-rf` is a plain identifier character, so `displayIdent` renders
    // both bare and a site using it for the command half emits
    // `aws sso login --profile ~evil` -- which the shell expands to a home
    // directory -- and `aws sso login --profile -rf`, in which the name is a
    // flag. `isPasteableIdent` is the predicate that refuses a leading `~` or
    // `-`, and shell-quoting is NOT an alternative for the second: an option
    // is still an option inside quotes.
    for (const name of ['~evil', '-rf', '~/x']) {
      let message = '';
      try {
        await resolveProfileCredentials(name);
        throw new Error('expected a refusal');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, `${name} was pasted into a command`).not.toContain(
        `aws sso login --profile ${name}`
      );
      expect(message).toContain('cdkd is not writing the command out');
      // The message still names WHICH profile failed -- refusing the command
      // must not cost the operator the identification.
      expect(message).toContain(name);
    }
  });

  it('keeps a long name out of the pasteable command via the same predicate', async () => {
    // `isPasteableIdent`'s second test is a `displayIdent` round-trip, so a
    // value the cap TRUNCATES is not byte-identical and fails -- the length
    // rule the regex alone does not carry.
    const long = 'a'.repeat(4000);
    await expect(resolveProfileCredentials(long)).rejects.toThrow(
      'cdkd is not writing the command out'
    );
  });
});

describe('local invoke-agentcore: the fallback notice sanitizes the profile name (issue #3377)', () => {
  const warnings: string[] = [];
  let previousLogger: ConsoleLogger;

  class CapturingLogger extends ConsoleLogger {
    override warn(message: string, ...args: unknown[]): void {
      warnings.push(message);
      void args;
    }
  }

  beforeEach(() => {
    warnings.length = 0;
    credsProviderMock.mockReset();
    stsSendMock.mockReset();
    stsDestroyMock.mockReset();
    resetAwsClientDefaults();
    // `getLogger()`, not a fresh `new ConsoleLogger()`: fabricating one
    // RESTORES A DIFFERENT OBJECT, at the default level, so a level or a
    // logger set by any sibling describe would be clobbered rather than put
    // back. Harmless while this describe runs last; the point is that it
    // stops being harmless silently (go-to-k/cdkd#3390 review).
    previousLogger = getLogger();
    setLogger(new CapturingLogger());
  });

  afterEach(() => {
    setLogger(previousLogger);
    resetAwsClientDefaults();
  });

  it('renders the name through displayIdent on the --assume-role failure path', async () => {
    // `ConsoleLogger.formatMessage` sanitizes the EXTRA ARGS and never the
    // message itself, so this line put raw argv bytes on the terminal. The
    // capture reads the message the logger was HANDED, one step before any
    // formatting, so nothing downstream can answer for the site.
    stsSendMock.mockRejectedValue(new Error('AccessDenied'));
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
    });

    const creds = await resolveHostCredentialsForSigV4(
      { profile: `pro${ESC}d`, assumeRole: 'arn:aws:iam::111122223333:role/Agent' } as never,
      {
        runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/Agent',
        runtimeName: 'Agent',
      } as never,
      undefined,
      'us-east-1'
    );

    expect(creds.accessKeyId).toBe('AKIA-PROFILE');
    const fallback = warnings.find((w) => w.includes('Falling back to'));
    expect(fallback, 'the fallback notice did not fire').toBeDefined();
    expect(fallback, 'ESC survived into the fallback notice').not.toContain(ESC);
    // And the notice still says WHICH profile it fell back to, quoted because
    // `displayIdent` saw the value as altered.
    expect(fallback).toContain('--profile');
    expect(fallback).toContain('"pro d"');
  });

  it('leaves a legitimate name bare on the same line', async () => {
    // The other direction: `displayIdent` is the identity on a plain
    // identifier, so an ordinary profile name reads exactly as it always did
    // and no operator's grep changes.
    stsSendMock.mockRejectedValue(new Error('AccessDenied'));
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
    });

    await resolveHostCredentialsForSigV4(
      { profile: 'dev-sso', assumeRole: 'arn:aws:iam::111122223333:role/Agent' } as never,
      {
        runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/Agent',
        runtimeName: 'Agent',
      } as never,
      undefined,
      'us-east-1'
    );

    expect(warnings.find((w) => w.includes('Falling back to'))).toContain(
      'Falling back to --profile dev-sso.'
    );
  });
});

/**
 * The SHARED `--assume-role` fallback warning, which both agentcore sites now
 * build (go-to-k/cdkd#3390 test review).
 *
 * Why this describe exists rather than a second copy of the one above: the two
 * emit sites were TWINS, and only the `--sigv4` one was reachable from a unit
 * test (`resolveHostCredentialsForSigV4` is exported; the fromS3 path is not,
 * and downloads an S3 bundle). So the fromS3 copy was guarded by the
 * source-shape fence alone, and dropping `displayIdent` from it reddened
 * nothing behavioural. Collapsing the twins into one PURE builder makes both
 * inherit these cases, and leaves one subject to test rather than a second one
 * somebody has to remember exists.
 */
describe('assumeRoleFallbackWarning: both untrusted values, both twins (issue #3377)', () => {
  const ARN = 'arn:aws:iam::111122223333:role/AgentExec';

  it('sanitizes the PROFILE, and quotes it when the value was altered', () => {
    for (const hostile of [ESC, CSI_C1, BIDI_OVERRIDE, '\u0085', '\u2028']) {
      const line = assumeRoleFallbackWarning({
        assumeRoleArn: ARN,
        purpose: '--sigv4 signing',
        error: new Error('AccessDenied'),
        profile: `pro${hostile}d`,
        fallbackWithoutProfile: 'shell credentials',
      });
      expect(
        line,
        `U+${hostile.codePointAt(0)!.toString(16)} survived into the fallback notice`
      ).not.toContain(hostile);
      expect(line).toContain('"pro d"');
    }
  });

  it('sanitizes the ROLE ARN, which is the WIDER boundary of the two', () => {
    // Not symmetry: nothing validates this value before the STS call whose
    // failure lands here, and `resolveAssumeRoleArn` can source it from a
    // deployed STATE RECORD rather than from argv.
    const line = assumeRoleFallbackWarning({
      assumeRoleArn: `arn:aws:iam::111122223333:role/A${ESC}[2Kgent`,
      purpose: 'the fromS3 bundle download',
      error: new Error('AccessDenied'),
      profile: 'dev-sso',
      fallbackWithoutProfile: 'the default credentials',
    });
    expect(line, 'ESC survived in the ARN').not.toContain(ESC);
  });

  it("sanitizes the ERROR, which is how the ARN comes back in (issue #3377)", () => {
    // The hole the other two guards leave open, and it is not symmetry. STS
    // answers an unparseable RoleArn with a `ValidationError` that ECHOES THE
    // SUBMITTED VALUE VERBATIM, so an attacker-controlled ARN returns through
    // the error string and lands on the same line the `displayIdent` two
    // expressions to its left was added to protect. A C1 byte, U+0085, U+2028
    // and the bidi overrides all survive an XML 1.0 response body.
    //
    // The ARN argument here is CLEAN on purpose: the needle can only have
    // arrived via the error, so the case cannot be satisfied by the ARN guard.
    for (const hostile of [ESC, CSI_C1, BIDI_OVERRIDE, '\u0085', '\u2028']) {
      const line = assumeRoleFallbackWarning({
        assumeRoleArn: 'arn:aws:iam::111122223333:role/AgentExec',
        purpose: '--sigv4 signing',
        error: new Error(
          `1 validation error: Value 'arn:aws:iam::111122223333:role/A${hostile}X' at 'roleArn' failed`
        ),
        profile: 'dev-sso',
        fallbackWithoutProfile: 'shell credentials',
      });
      expect(
        line,
        `U+${hostile.codePointAt(0)!.toString(16)} survived through the error message`
      ).not.toContain(hostile);
      // The error's TEXT still reaches the operator -- sanitizing must not cost
      // the reason the assume failed.
      expect(line).toContain('1 validation error');
    }
    // A non-Error value takes the same route.
    expect(
      assumeRoleFallbackWarning({
        assumeRoleArn: 'arn:aws:iam::111122223333:role/AgentExec',
        purpose: '--sigv4 signing',
        error: `plain${ESC}[2Kstring`,
        profile: undefined,
        fallbackWithoutProfile: 'shell credentials',
      })
    ).not.toContain(ESC);
  });

  it('is the IDENTITY on legitimate values, so no existing line changes', () => {
    // The other direction, without which the two cases above are satisfied by a
    // builder that mangles everything. An ARN's characters are all in
    // `PLAIN_IDENT`, so it must still render BARE -- unquoted, unaltered.
    expect(
      assumeRoleFallbackWarning({
        assumeRoleArn: ARN,
        purpose: '--sigv4 signing',
        error: new Error('AccessDenied'),
        profile: 'dev-sso',
        fallbackWithoutProfile: 'shell credentials',
      })
    ).toBe(
      `--assume-role: STS AssumeRole(${ARN}) failed for --sigv4 signing: AccessDenied. ` +
        `Falling back to --profile dev-sso.`
    );
  });

  it('renders a LEGAL long role ARN without cutting it (issue go-to-k/cdkd#3390 round 3)', () => {
    // AWS bounds a role PATH at 512 and a NAME at 64, so a valid ARN reaches
    // ~612 -- past `displayIdent`'s 255 default, which would print
    // `[cut: N more characters withheld]` inside the very sentence whose only
    // job is to say WHICH role failed. Every ARN render on this surface passes
    // `ROLE_ARN_MAX_CODE_POINTS` for that reason.
    const longArn = `arn:aws:iam::111122223333:role/${'p'.repeat(400)}/LongRoleName`;
    expect(longArn.length).toBeGreaterThan(255);
    const line = assumeRoleFallbackWarning({
      assumeRoleArn: longArn,
      purpose: '--sigv4 signing',
      error: new Error('AccessDenied'),
      profile: 'dev-sso',
      fallbackWithoutProfile: 'shell credentials',
    });
    expect(line, 'a legal ARN was truncated').not.toContain('more characters withheld');
    expect(line).toContain(longArn);
    // ...and the cap is still a cap: something past even the ARN budget cuts.
    const absurd = `arn:aws:iam::111122223333:role/${'p'.repeat(1200)}`;
    expect(
      assumeRoleFallbackWarning({
        assumeRoleArn: absurd,
        purpose: '--sigv4 signing',
        error: new Error('AccessDenied'),
        profile: 'dev-sso',
        fallbackWithoutProfile: 'shell credentials',
      })
    ).toContain('more characters withheld');
  });

  it('names the no-profile fallback its caller chose, per site', () => {
    // The one value that differs between the twins, so a copy-paste swapping
    // them would be caught.
    expect(
      assumeRoleFallbackWarning({
        assumeRoleArn: ARN,
        purpose: '--sigv4 signing',
        error: 'plain string failure',
        profile: undefined,
        fallbackWithoutProfile: 'shell credentials',
      })
    ).toBe(
      `--assume-role: STS AssumeRole(${ARN}) failed for --sigv4 signing: plain string failure. ` +
        `Falling back to shell credentials.`
    );
    expect(
      assumeRoleFallbackWarning({
        assumeRoleArn: ARN,
        purpose: 'the fromS3 bundle download',
        error: new Error('boom'),
        profile: undefined,
        fallbackWithoutProfile: 'the default credentials',
      })
    ).toContain('Falling back to the default credentials.');
  });
});
