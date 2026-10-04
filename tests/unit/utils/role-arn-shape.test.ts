import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { STSClient } from '@aws-sdk/client-sts';
import { codeLines } from '../_code-lines.js';

import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

/**
 * Issue #2348 (following cdk-local#607): a role ARN is shape- and
 * length-checked before cdkd sends it to STS.
 *
 * Three halves: the predicate itself, the two send sites in
 * `src/utils/role-arn.ts` behaviourally (nothing reaches STS), and a
 * population fence over every `new AssumeRoleCommand(` under `src/`, so a send
 * site added later cannot skip the guard.
 */

const mockStsSend = vi.fn();
vi.mock('@aws-sdk/client-sts', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-sts')>(
    '@aws-sdk/client-sts'
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

import {
  IAM_ROLE_ARN_MAX_LENGTH,
  applyRoleArnIfSet,
  assertSendableRoleArn,
  assumeRoleForCrossAccountStateRead,
  clearCrossAccountCredentialsCache,
  explicitRoleArnOrThrow,
  isIamRoleArn,
  parseIamRoleArn,
  refusedRoleArnMessage,
  sendableAssumeRoleCommand,
} from '../../../src/utils/role-arn.js';
import {
  getAssumedRoleCredentials,
  resetAwsClientDefaults,
} from '../../../src/utils/aws-client-defaults.js';

const ESC = String.fromCharCode(0x1b);
const PREFIX = 'arn:aws:iam::123456789012:role/';

/** A well-formed ARN of EXACTLY `n` characters. */
function arnOfLength(n: number): string {
  return PREFIX + 'a'.repeat(n - PREFIX.length);
}

describe('isIamRoleArn', () => {
  it.each([
    ['a plain role', 'arn:aws:iam::123456789012:role/MyRole'],
    ['a path-shaped role', 'arn:aws:iam::123456789012:role/service-role/Foo'],
    [
      'a service-linked role',
      'arn:aws:iam::123456789012:role/aws-service-role/x.amazonaws.com/AWSServiceRoleForX',
    ],
    // IAM's path grammar is `\u0021`-`\u007F`; `IAM_ROLE_ARN_RE`'s narrower
    // class would refuse this, which is why the send bound is a separate
    // pattern (see its doc comment).
    ['a path with IAM-legal punctuation', 'arn:aws:iam::123456789012:role/team(a)/MyRole'],
    ['another partition', 'arn:aws-us-gov:iam::123456789012:role/R'],
    ['the China partition', 'arn:aws-cn:iam::123456789012:role/R'],
    ['an ISO partition', 'arn:aws-iso-b:iam::123456789012:role/R'],
    ['a short account, as unit fixtures use', 'arn:aws:iam::111:role/R'],
    ['exactly the maximum length', arnOfLength(IAM_ROLE_ARN_MAX_LENGTH)],
  ])('accepts %s', (_label, value) => {
    expect(isIamRoleArn(value)).toBe(true);
  });

  it.each([
    ['a newline after a well-formed prefix', `${PREFIX}x\nforged line`],
    ['a trailing newline', `${PREFIX}x\n`],
    ['a NUL after a well-formed prefix', `${PREFIX}x\u0000y`],
    ['an ESC sequence after a well-formed prefix', `${PREFIX}x${ESC}[2K\revil`],
    ['a space in the role name', `${PREFIX}my role`],
    ['an empty role name', PREFIX],
    ['a partition containing a space', 'arn:a b:iam::123456789012:role/R'],
    ['one character over the maximum', arnOfLength(IAM_ROLE_ARN_MAX_LENGTH + 1)],
    ['a non-role IAM ARN', 'arn:aws:iam::123456789012:user/R'],
    ['a role NAME, not an ARN', 'MyRole'],
    ['leading whitespace', ` ${PREFIX}R`],
    ['a non-ASCII role name', `${PREFIX}Rolé`],
    // IAM's path grammar admits DEL; this bound refuses it deliberately.
    ['a DEL in the path', `${PREFIX}team\u007f/R`],
    ['a number', 42],
    ['undefined', undefined],
    ['an object', { Ref: 'Role' }],
  ])('rejects %s', (_label, value) => {
    expect(isIamRoleArn(value)).toBe(false);
  });

  it('bounds the length BEFORE matching, so an oversized value is refused on length alone', () => {
    // A value the PATTERN would accept, one past the bound: only the length
    // check can refuse it.
    const oversized = arnOfLength(IAM_ROLE_ARN_MAX_LENGTH + 1);
    expect(/^arn:[A-Za-z0-9-]+:iam::[0-9]+:role\/[!-~]+$/.test(oversized)).toBe(true);
    expect(isIamRoleArn(oversized)).toBe(false);
  });
});

describe('parseIamRoleArn is a subset of isIamRoleArn in length too', () => {
  it('refuses an otherwise well-formed ARN past the maximum', () => {
    const segment = 'a'.repeat(100);
    const long = `${PREFIX}${Array.from({ length: 25 }, () => segment).join('/')}`;
    expect(long.length).toBeGreaterThan(IAM_ROLE_ARN_MAX_LENGTH);
    expect(parseIamRoleArn(long)).toBeNull();
    // ...while the same shape under the bound still parses.
    expect(parseIamRoleArn(`${PREFIX}${segment}/${segment}`)).toEqual({
      partition: 'aws',
      accountId: '123456789012',
    });
  });
});

describe('refusedRoleArnMessage', () => {
  it('names the expected shape and the bound, and renders the value sanitized', () => {
    const message = refusedRoleArnMessage(`${PREFIX}x${ESC}[2K\revil`);
    expect(message).toContain('arn:<partition>:iam::<account>:role/<name>');
    expect(message).toContain(`at most ${IAM_ROLE_ARN_MAX_LENGTH} characters`);
    expect(message).toContain('Nothing was sent to STS.');
    expect(message).toContain('evil');
    expect(message).not.toContain(ESC);
    expect(message).not.toContain('\r');
  });

  it('names an EMPTY value as empty, not unrenderable', () => {
    const message = refusedRoleArnMessage('');
    expect(message).toContain('characters): (empty). Nothing was sent to STS.');
    expect(message).not.toContain('unrenderable');
  });

  it('bounds an oversized value and says how much it withheld', () => {
    const huge = `${PREFIX}${'a'.repeat(1_000_000)}`;
    const message = refusedRoleArnMessage(huge);
    expect(message.length).toBeLessThan(1_000);
    expect(message).toMatch(/\[cut: \d+ more characters withheld, tail sha256:[0-9a-f]{32}\]/);
  });
});

describe('assertSendableRoleArn / explicitRoleArnOrThrow', () => {
  it('assertSendableRoleArn passes a well-formed ARN and throws the shared refusal otherwise', () => {
    expect(() => assertSendableRoleArn(`${PREFIX}R`)).not.toThrow();
    expect(() => assertSendableRoleArn(`${PREFIX}R\n`)).toThrow(/AssumeRole refused/);
  });

  it('assertSendableRoleArn throws through the caller-supplied error class', () => {
    class SiteError extends Error {}
    expect(() => assertSendableRoleArn('nope', (m) => new SiteError(m))).toThrow(SiteError);
  });

  it('explicitRoleArnOrThrow trims, and refuses naming the flag', () => {
    expect(explicitRoleArnOrThrow('--assume-role', `  ${PREFIX}R \n`)).toBe(`${PREFIX}R`);
    expect(() => explicitRoleArnOrThrow('--assume-role', `${PREFIX}R x`)).toThrow(
      /^Invalid --assume-role value: AssumeRole refused/
    );
  });
});

describe('the role-arn.ts send sites refuse before STS', () => {
  const ENV_KEYS = [
    'CDKD_ROLE_ARN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ] as const;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    mockStsSend.mockReset();
    vi.mocked(STSClient).mockClear();
    resetAwsClientDefaults();
    clearCrossAccountCredentialsCache();
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAwsClientDefaults();
  });

  it.each([
    ['--role-arn', { roleArn: `${PREFIX}x${ESC}[2K\revil`, env: undefined }],
    ['CDKD_ROLE_ARN', { roleArn: undefined, env: `${PREFIX}${'a'.repeat(IAM_ROLE_ARN_MAX_LENGTH)}` }],
  ])('applyRoleArnIfSet refuses a malformed %s and changes nothing', async (_label, input) => {
    if (input.env !== undefined) process.env['CDKD_ROLE_ARN'] = input.env;
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIDCALLER';

    await expect(
      applyRoleArnIfSet({ roleArn: input.roleArn, region: 'us-east-1' })
    ).rejects.toThrow(/AssumeRole refused.*Nothing was sent to STS/);

    expect(vi.mocked(STSClient)).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(getAssumedRoleCredentials()).toBeUndefined();
    expect(process.env['AWS_ACCESS_KEY_ID']).toBe('AKIDCALLER');
  });

  it('applyRoleArnIfSet refuses an EMPTY --role-arn rather than running as the caller', async () => {
    process.env['CDKD_ROLE_ARN'] = `${PREFIX}FromEnv`;
    await expect(applyRoleArnIfSet({ roleArn: '', region: 'us-east-1' })).rejects.toThrow(
      /AssumeRole refused/
    );
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('applyRoleArnIfSet treats an EMPTY CDKD_ROLE_ARN as unset', async () => {
    process.env['CDKD_ROLE_ARN'] = '';
    await applyRoleArnIfSet({ roleArn: undefined, region: 'us-east-1' });
    expect(vi.mocked(STSClient)).not.toHaveBeenCalled();
    expect(getAssumedRoleCredentials()).toBeUndefined();
  });

  it('applyRoleArnIfSet still sends a well-formed ARN (negative control)', async () => {
    mockStsSend.mockResolvedValue({
      Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' },
    });
    await applyRoleArnIfSet({ roleArn: `${PREFIX}Deploy`, region: 'us-east-1' });
    expect(mockStsSend).toHaveBeenCalledTimes(1);
    expect(mockStsSend.mock.calls[0]?.[0]?.input?.RoleArn).toBe(`${PREFIX}Deploy`);
  });

  it('assumeRoleForCrossAccountStateRead refuses a malformed RoleArn, and does not cache the refusal', async () => {
    const hostile = `${PREFIX}Producer\nforged`;
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(assumeRoleForCrossAccountStateRead(hostile)).rejects.toThrow(
        /AssumeRole refused/
      );
    }
    expect(vi.mocked(STSClient)).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});

/**
 * The POPULATION, as a STRUCTURAL rule rather than a statement-order check:
 * `sendableAssumeRoleCommand` in `src/utils/role-arn.ts` is the only place an
 * `AssumeRoleCommand` may be built, and it cannot build one without the guard.
 * So the fence asserts (a) no assume-role construct appears anywhere else
 * under `src/`, and (b) the builder's own body guards before it constructs.
 *
 * Two earlier revisions scanned each send for a guard "in the same function"
 * and were evaded three ways in two review rounds (an arrow or method after a
 * guarded function, a concise arrow, a return type containing `{`). Moving the
 * guard INTO the only constructor removes the question those evasions
 * answered wrongly.
 */
const ASSUME_CONSTRUCT = /\bAssumeRole\w*Command\b|\bfromTemporaryCredentials\b|\.assumeRole\s*\(/;
const ROLE_ARN_MODULE = path.join('utils', 'role-arn.ts');

describe('codeLines strips comments without hiding code behind them', () => {
  it('keeps code after a leading block comment, and drops prose', () => {
    const text = [
      '/**',
      ' * new AssumeRoleCommand( in prose',
      ' */',
      '/* x */ const c = new AssumeRoleCommand({});',
      '// new AssumeRoleCommand( in a line comment',
      "const u = 'https://example.com'; const d = new AssumeRoleCommand({});",
    ].join('\n');
    const hits = codeLines(text).filter((l) => ASSUME_CONSTRUCT.test(l.text));
    expect(hits.map((l) => l.line)).toEqual([4, 6]);
  });

  it.each([
    ["a `/*` inside a string", "const p = 'MyStage/*';"],
    ["a ` //` inside a string", "const p = ' //';"],
    ['a `/*` inside a template literal', 'const p = `arn:aws:s3:::${b}/*`;'],
    ['a `/*` inside a regular expression', 'const r = /[/*]x/;'],
  ])('still sees a construct after %s', (_label, before) => {
    const text = [before, 'const late = new AssumeRoleCommand({ RoleArn: x });'].join('\n');
    const hits = codeLines(text).filter((l) => ASSUME_CONSTRUCT.test(l.text));
    expect(hits.map((l) => l.line)).toEqual([2]);
  });

  it('ignores a construct inside a real block or line comment', () => {
    const text = [
      '/* new AssumeRoleCommand({ RoleArn: x }) */ const a = 1;',
      'const b = 2; // new AssumeRoleCommand({ RoleArn: x })',
    ].join('\n');
    expect(codeLines(text).filter((l) => ASSUME_CONSTRUCT.test(l.text))).toEqual([]);
  });

  it('refuses a file it cannot parse rather than skipping it', () => {
    expect(() => codeLines('const = ;', 'broken.ts')).toThrow(/cannot parse broken\.ts/);
  });
});

describe('every AssumeRoleCommand is built by the guarded builder (issue #2348)', () => {
  const SRC = path.resolve(__dirname, '../../../src');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  const files = walk(SRC).map((f) => ({ rel: path.relative(SRC, f), text: readFileSync(f, 'utf8') }));
  // Every file under src/ is parsed ONCE, lazily, and shared by the cases
  // below. Each case keeps the contended-case timeout because it walks the
  // real tree (`.claude/rules/testing.md`), not because the parse is slow.
  let parsed: Map<string, Array<{ line: number; text: string }>> | undefined;
  const linesOf = (rel: string): Array<{ line: number; text: string }> => {
    parsed ??= new Map(files.map((f) => [f.rel, codeLines(f.text, f.rel)]));
    return parsed.get(rel)!;
  };

  it('finds the builder\'s callers it claims to police (floor)', () => {
    // A literal the fence does not read: seven sends in six files when #2348
    // landed. A walk that found nothing must not pass the case below.
    const callers = files.flatMap(({ rel, text }) =>
      linesOf(rel)
        .filter((l) => /\bsendableAssumeRoleCommand\(/.test(l.text))
        .filter((l) => !/export function sendableAssumeRoleCommand/.test(l.text))
        .map((l) => `${rel}:${l.line}`)
    );
    expect(callers.length).toBeGreaterThanOrEqual(7);
    expect(new Set(callers.map((c) => c.split(':')[0])).size).toBeGreaterThanOrEqual(6);
  }, CONTENDED_CASE_TIMEOUT_MS);

  it('has no assume-role construct outside src/utils/role-arn.ts', () => {
    const offenders = files
      .filter(({ rel }) => rel !== ROLE_ARN_MODULE)
      .flatMap(({ rel, text }) =>
        linesOf(rel)
          .filter((l) => ASSUME_CONSTRUCT.test(l.text))
          .map((l) => `src/${rel}:${l.line}  ${l.text.trim()}`)
      );
    expect(
      offenders,
      'Build the command with `sendableAssumeRoleCommand(...)` from src/utils/role-arn.ts, ' +
        'which refuses a malformed or unbounded RoleArn before it can be sent.'
    ).toEqual([]);
  }, CONTENDED_CASE_TIMEOUT_MS);

  it('allows role-arn.ts only its import and the builder -- no other assume-role construct', () => {
    const allowed = [
      /^import \{[^}]*\bAssumeRoleCommand\b[^}]*\} from '@aws-sdk\/client-sts';$/,
      /^\s*return new AssumeRoleCommand\(input\);$/,
      /^\s*input: AssumeRoleCommandInput,$/,
      /^\s*\): AssumeRoleCommand \{$/,
    ];
    const extra = linesOf(ROLE_ARN_MODULE)
      .filter((l) => ASSUME_CONSTRUCT.test(l.text))
      .filter((l) => !allowed.some((re) => re.test(l.text)))
      .map((l) => `src/${ROLE_ARN_MODULE}:${l.line}  ${l.text.trim()}`);
    expect(extra).toEqual([]);
  }, CONTENDED_CASE_TIMEOUT_MS);

  it('constructs AssumeRoleCommand exactly once in role-arn.ts, inside the builder, after the guard', () => {
    const code = linesOf(ROLE_ARN_MODULE).map((l) => l.text).join('\n');
    expect(code.match(/new AssumeRoleCommand\s*\(/g)).toHaveLength(1);
    const body = /export function sendableAssumeRoleCommand\([\s\S]*?\n\}/.exec(code)?.[0] ?? '';
    const guardAt = body.indexOf('assertSendableRoleArn(input.RoleArn');
    const buildAt = body.indexOf('new AssumeRoleCommand(input)');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeGreaterThan(guardAt);
  }, CONTENDED_CASE_TIMEOUT_MS);

  it('the builder refuses a malformed RoleArn and builds a well-formed one', () => {
    expect(() => sendableAssumeRoleCommand({ RoleArn: `${PREFIX}x\n`, RoleSessionName: 's' })).toThrow(
      /AssumeRole refused/
    );
    expect(() => sendableAssumeRoleCommand({ RoleArn: undefined, RoleSessionName: 's' })).toThrow(
      /AssumeRole refused/
    );
    expect(
      sendableAssumeRoleCommand({ RoleArn: `${PREFIX}R`, RoleSessionName: 's' }).input.RoleArn
    ).toBe(`${PREFIX}R`);
  });
});
