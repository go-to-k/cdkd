import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { resetAwsClientDefaults } from '../../../src/utils/aws-client-defaults.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * go-to-k/cdkd#6201: when the real AssumeRole of an execution role is refused,
 * the cdkd-owned `cdkd local` commands emulate the role's permissions with
 * session policies — GetFederationToken for an IAM user, AssumeRole of
 * `--emulate-role-via` otherwise — and warn that it is an approximation.
 */
// The approximation notice prints once per role per process, so every case
// gets a role of its own (`beforeEach`).
let roleSeq = 0;
let ROLE = 'arn:aws:iam::123456789012:role/ExecRole';
const VIA = 'arn:aws:iam::123456789012:role/DevRole';
const USER_ARN = 'arn:aws:iam::123456789012:user/goto';
const ASSUMED_ARN = 'arn:aws:sts::123456789012:assumed-role/SSORole/goto';
const SECRET = 'emulated-secret-value-not-for-logs';

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

const aws = vi.hoisted(() => ({
  sent: [] as Sent[],
  callerArn: 'arn:aws:iam::123456789012:user/goto',
  /** Fail the AssumeRole whose RoleArn is this one (the execution role). */
  denyRole: undefined as string | undefined,
  tokenError: undefined as unknown,
  inline: {} as Record<string, unknown>,
  managed: [] as string[],
}));

function command(name: string) {
  return vi.fn(function (this: Record<string, unknown>, input: Record<string, unknown>) {
    this['__name'] = name;
    this['input'] = input;
  });
}

function accessDenied(): Error {
  return Object.assign(new Error('User is not authorized to perform: sts:AssumeRole'), {
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });
}

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(function STSClient() {
    return {
      send: vi.fn(async (cmd: { __name: string; input: Record<string, unknown> }) => {
        aws.sent.push({ name: cmd.__name, input: cmd.input });
        const creds = {
          Credentials: {
            AccessKeyId: `ASIA-${cmd.__name}`,
            SecretAccessKey: SECRET,
            SessionToken: `token-${cmd.__name}`,
          },
        };
        if (cmd.__name === 'GetCallerIdentity') {
          return { Arn: aws.callerArn, Account: '123456789012' };
        }
        if (cmd.__name === 'AssumeRole') {
          if (cmd.input['RoleArn'] === aws.denyRole) throw accessDenied();
          if (aws.tokenError !== undefined) throw aws.tokenError;
          return creds;
        }
        if (cmd.__name === 'GetFederationToken') {
          if (aws.tokenError !== undefined) throw aws.tokenError;
          return creds;
        }
        throw new Error(`unexpected STS command ${cmd.__name}`);
      }),
      destroy: vi.fn(),
    };
  }),
  GetCallerIdentityCommand: command('GetCallerIdentity'),
  AssumeRoleCommand: command('AssumeRole'),
  GetFederationTokenCommand: command('GetFederationToken'),
}));

vi.mock('@aws-sdk/client-iam', () => ({
  IAMClient: vi.fn(function IAMClient() {
    return {
      send: vi.fn(async (cmd: { __name: string; input: Record<string, unknown> }) => {
        aws.sent.push({ name: cmd.__name, input: cmd.input });
        if (cmd.__name === 'ListRolePolicies') return { PolicyNames: Object.keys(aws.inline) };
        if (cmd.__name === 'GetRolePolicy') {
          const doc = aws.inline[cmd.input['PolicyName'] as string];
          return { PolicyDocument: encodeURIComponent(JSON.stringify(doc)) };
        }
        if (cmd.__name === 'ListAttachedRolePolicies') {
          return { AttachedPolicies: aws.managed.map((PolicyArn) => ({ PolicyArn })) };
        }
        throw new Error(`unexpected IAM command ${cmd.__name}`);
      }),
      destroy: vi.fn(),
    };
  }),
  ListRolePoliciesCommand: command('ListRolePolicies'),
  GetRolePolicyCommand: command('GetRolePolicy'),
  ListAttachedRolePoliciesCommand: command('ListAttachedRolePolicies'),
}));

const { buildSessionPolicy, emulateRoleAfterDeniedAssume, SESSION_POLICY_MAX_CHARS } =
  await import('../../../src/local/role-permission-emulation.js');
const { applyLambdaCredentialEnv } = await import('../../../src/cli/commands/local-invoke.js');
const { assumeLambdaExecutionRole } = await import('../../../src/cli/commands/local-start-api.js');
const { assumeTaskRole } = await import('../../../src/cli/commands/local-run-task.js');
const { assumeAgentCoreExecutionRole } = await import(
  '../../../src/cli/commands/local-invoke-agentcore/env.js'
);

const S3_LIST = {
  Version: '2012-10-17',
  Statement: [{ Sid: 'List', Effect: 'Allow', Action: 's3:ListAllMyBuckets', Resource: '*' }],
};
const LOGS = {
  Version: '2012-10-17',
  Statement: { Sid: 'List', Effect: 'Allow', Action: 'logs:PutLogEvents', Resource: '*' },
};

const ENV_KEYS = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE'] as const;
const savedEnv: Record<string, string | undefined> = {};
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  resetAwsClientDefaults();
  ROLE = `arn:aws:iam::123456789012:role/ExecRole${++roleSeq}`;
  args.roleArn = ROLE;
  aws.sent = [];
  aws.callerArn = USER_ARN;
  aws.denyRole = ROLE;
  aws.tokenError = undefined;
  aws.inline = { A: S3_LIST, B: LOGS };
  aws.managed = ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'];
  warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  warn.mockRestore();
});

const warnings = (): string =>
  (warn.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');
const sentNames = (): string[] => aws.sent.map((s) => s.name);
const args = { roleArn: ROLE, region: 'us-east-1', realAws: false, flag: '--assume-role', sessionNamePrefix: 'cdkd-test' };

describe('buildSessionPolicy', () => {
  it('combines every inline policy into one minified document without Sids', () => {
    const plan = buildSessionPolicy({ inline: [S3_LIST, LOGS], managedArns: [] });
    expect(plan).toEqual({
      ok: true,
      policy:
        '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListAllMyBuckets","Resource":"*"},{"Effect":"Allow","Action":"logs:PutLogEvents","Resource":"*"}]}',
      policyArns: [],
    });
  });

  it('denies everything for a role with no policies (no session policy would grant all)', () => {
    const plan = buildSessionPolicy({ inline: [], managedArns: [] });
    expect(plan.ok && JSON.parse(plan.policy)).toEqual({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }],
    });
  });

  it('passes only the ARNs when the role has managed policies alone', () => {
    expect(buildSessionPolicy({ inline: [], managedArns: ['arn:aws:iam::aws:policy/X'] })).toEqual({
      ok: true,
      policy: '',
      policyArns: ['arn:aws:iam::aws:policy/X'],
    });
  });

  it('refuses more than 10 managed policies', () => {
    const arns = Array.from({ length: 11 }, (_, i) => `arn:aws:iam::aws:policy/P${i}`);
    const plan = buildSessionPolicy({ inline: [], managedArns: arns });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain('11 managed policies');
  });

  it('refuses a plaintext over the 2,048-character limit, ARNs counted', () => {
    const big = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::${'b'.repeat(SESSION_POLICY_MAX_CHARS)}` }],
    };
    const plan = buildSessionPolicy({ inline: [big], managedArns: [] });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain('2048');
  });

  it('refuses inline policies whose Versions differ', () => {
    const plan = buildSessionPolicy({
      inline: [S3_LIST, { ...LOGS, Version: '2008-10-17' }],
      managedArns: [],
    });
    expect(plan.ok).toBe(false);
  });
});

describe('emulateRoleAfterDeniedAssume', () => {
  it('does nothing for a failure that is not AccessDenied', async () => {
    const err = Object.assign(new Error('throttled'), { name: 'Throttling' });
    expect(await emulateRoleAfterDeniedAssume(err, args)).toBeUndefined();
    expect(aws.sent).toEqual([]);
  });

  it('an IAM user gets GetFederationToken with the role policies as session policies', async () => {
    const creds = await emulateRoleAfterDeniedAssume(accessDenied(), args);
    expect(creds?.accessKeyId).toBe('ASIA-GetFederationToken');
    const token = aws.sent.find((s) => s.name === 'GetFederationToken');
    expect(JSON.parse(token?.input['Policy'] as string).Statement).toHaveLength(2);
    expect(token?.input['PolicyArns']).toEqual([
      { arn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' },
    ]);
    expect(sentNames()).not.toContain('AssumeRole');
    const text = warnings();
    expect(text).toContain('APPROXIMATION');
    expect(text).toContain('permissions boundary');
    expect(text).toContain('cannot call IAM');
    expect(text).not.toContain(SECRET);
  });

  it('prints the approximation notice once per role', async () => {
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a non-IAM-user caller without --emulate-role-via is not emulated, and is told the flag', async () => {
    aws.callerArn = ASSUMED_ARN;
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(sentNames()).toEqual(['GetCallerIdentity']);
    expect(warnings()).toContain('--emulate-role-via');
  });

  it('--emulate-role-via assumes that role with the session policies', async () => {
    aws.callerArn = ASSUMED_ARN;
    const creds = await emulateRoleAfterDeniedAssume(accessDenied(), { ...args, emulateRoleVia: VIA });
    expect(creds?.accessKeyId).toBe('ASIA-AssumeRole');
    const assume = aws.sent.find((s) => s.name === 'AssumeRole');
    expect(assume?.input['RoleArn']).toBe(VIA);
    expect(assume?.input['Policy']).toBeTypeOf('string');
    expect(assume?.input['PolicyArns']).toHaveLength(1);
    expect(sentNames()).not.toContain('GetFederationToken');
    expect(warnings()).toContain('APPROXIMATION');
    expect(warnings()).not.toContain('cannot call IAM');
  });

  it('refuses a role in another account (IAM is read by name in the caller account)', async () => {
    const other = 'arn:aws:iam::999999999999:role/ExecRole';
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), { ...args, roleArn: other })).toBeUndefined();
    expect(sentNames()).toEqual(['GetCallerIdentity']);
    expect(warnings()).toContain("not in your credentials' account");
  });

  it('over the limits: warns and asks STS for nothing', async () => {
    aws.managed = Array.from({ length: 11 }, (_, i) => `arn:aws:iam::aws:policy/P${i}`);
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(sentNames()).not.toContain('GetFederationToken');
    expect(warnings()).toContain('11 managed policies');
  });

  it('PackedPolicyTooLarge from STS: warns and returns nothing', async () => {
    aws.tokenError = Object.assign(new Error('packed too large'), {
      name: 'PackedPolicyTooLarge',
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
    });
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(warnings()).toContain('PackedPolicyTooLarge');
  });
});

describe('the cdkd-owned commands fall back to emulation on a refused assume', () => {
  it('local invoke: the container gets the emulated credentials', async () => {
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE, region: 'us-east-1' });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('ASIA-GetFederationToken');
    expect(env['AWS_SESSION_TOKEN']).toBe('token-GetFederationToken');
    expect(warnings()).not.toContain("Falling back to the developer's shell credentials");
  });

  it('local invoke: --emulate-role-via reaches the helper', async () => {
    aws.callerArn = ASSUMED_ARN;
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE, emulateRoleVia: VIA, region: 'us-east-1' });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('ASIA-AssumeRole');
  });

  it('local invoke: emulation impossible keeps the old shell-credentials fallback', async () => {
    aws.callerArn = ASSUMED_ARN;
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIA-CALLER';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'caller-secret';
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE, region: 'us-east-1' });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIA-CALLER');
    expect(warnings()).toContain("Falling back to the developer's shell credentials");
  });

  it('local start-api', async () => {
    const creds = await assumeLambdaExecutionRole(ROLE, 'us-east-1', VIA);
    expect(creds.accessKeyId).toBe('ASIA-AssumeRole');
  });

  it('local run-task', async () => {
    const creds = await assumeTaskRole(ROLE, 'us-east-1', { realAws: false });
    expect(creds.accessKeyId).toBe('ASIA-GetFederationToken');
  });

  it('local invoke-agentcore', async () => {
    const creds = await assumeAgentCoreExecutionRole(ROLE, 'us-east-1');
    expect(creds.accessKeyId).toBe('ASIA-GetFederationToken');
  });
});
