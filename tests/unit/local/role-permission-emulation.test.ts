import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { resetAwsClientDefaults } from '../../../src/utils/aws-client-defaults.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * go-to-k/cdkd#6201: when the real AssumeRole of an execution role is refused,
 * the cdkd-owned `cdkd local` commands emulate the role's permissions with
 * session policies — GetFederationToken for an IAM user, AssumeRole of
 * `--emulate-role-via` otherwise — and warn that it is an approximation.
 */
// The notice and the failure warning print once per role per process, so every
// case gets a role of its own (`beforeEach`).
let roleSeq = 0;
let ROLE = 'arn:aws:iam::123456789012:role/ExecRole';
const VIA = 'arn:aws:iam::123456789012:role/DevRole';
const USER_ARN = 'arn:aws:iam::123456789012:user/goto';
const ASSUMED_ARN = 'arn:aws:sts::123456789012:assumed-role/SSORole/goto';
const SECRET = 'emulated-secret-value-not-for-logs';
const DENY_ALL = '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}';

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

const aws = vi.hoisted(() => ({
  sent: [] as Array<{ name: string; input: Record<string, unknown> }>,
  /** Every SDK client constructor config (STS and IAM), in order. */
  configs: [] as Array<{ client: string; config: Record<string, unknown> }>,
  callerArn: 'arn:aws:iam::123456789012:user/goto',
  callerIdError: undefined as unknown,
  /** Fail the AssumeRole whose RoleArn is this one (the execution role). */
  denyRole: undefined as string | undefined,
  denyError: undefined as unknown,
  tokenError: undefined as unknown,
  /** The token call answers with no credentials / with nothing at all. */
  tokenEmpty: false,
  tokenUndefined: false,
  iamError: undefined as unknown,
  /** The role's permissions boundary ARN (`GetRole`), and a `GetRole`-only failure. */
  boundary: undefined as string | undefined,
  getRoleError: undefined as unknown,
  inline: {} as Record<string, unknown>,
  managed: [] as string[],
  /** Split the List* answers into pages of this size (0: one page). */
  pageSize: 0,
  mixed: false,
  /** `mixedModeEmulatorOverride()`: set while `--aws-emulator` is active (#6252). */
  emulatorOverride: undefined as { endpoint: string } | undefined,
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

/** One page of `items` per `aws.pageSize`, keyed by the `Marker` the call sent. */
function page<T>(items: T[], marker: unknown): { items: T[]; IsTruncated: boolean; Marker?: string } {
  if (aws.pageSize === 0) return { items, IsTruncated: false };
  const start = marker === undefined ? 0 : Number(String(marker).replace('m', ''));
  const end = start + aws.pageSize;
  return {
    items: items.slice(start, end),
    IsTruncated: end < items.length,
    ...(end < items.length && { Marker: `m${end}` }),
  };
}

// Echo the routing / identity options into the client config, so a test can
// read which `realAws` each client was built with.
vi.mock('../../../src/utils/aws-client-defaults.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/aws-client-defaults.js')>();
  return {
    ...actual,
    awsClientDefaults: (opts?: { realAws?: boolean; ignoreAssumedRole?: boolean }) => ({
      ...actual.awsClientDefaults(opts),
      __realAws: opts?.realAws,
      __ignoreAssumedRole: opts?.ignoreAssumedRole,
    }),
  };
});

vi.mock('../../../src/local/local-aws-wiring.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/local-aws-wiring.js')>();
  return {
    ...actual,
    mixedModeActive: () => aws.mixed,
    mixedModeEmulatorOverride: () => aws.emulatorOverride,
  };
});

// The fromS3 path downloads the bundle after the credential hop; stop it there.
vi.mock('../../../src/local/agentcore-s3-bundle.js', () => ({
  downloadAndExtractS3Bundle: vi.fn(async () => {
    throw new Error('test: bundle download stubbed');
  }),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(function STSClient(config: Record<string, unknown>) {
    aws.configs.push({ client: 'STS', config });
    return {
      config: { region: async () => 'us-east-1' },
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
          if (aws.callerIdError !== undefined) throw aws.callerIdError;
          return { Arn: aws.callerArn, Account: '123456789012' };
        }
        if (cmd.__name === 'AssumeRole' && cmd.input['RoleArn'] === aws.denyRole) {
          throw aws.denyError ?? accessDenied();
        }
        if (cmd.__name === 'AssumeRole' || cmd.__name === 'GetFederationToken') {
          if (aws.tokenError !== undefined) throw aws.tokenError;
          if (aws.tokenUndefined) return undefined;
          if (aws.tokenEmpty) return {};
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
  IAMClient: vi.fn(function IAMClient(config: Record<string, unknown>) {
    aws.configs.push({ client: 'IAM', config });
    return {
      send: vi.fn(async (cmd: { __name: string; input: Record<string, unknown> }) => {
        aws.sent.push({ name: cmd.__name, input: cmd.input });
        if (aws.iamError !== undefined) throw aws.iamError;
        if (cmd.__name === 'GetRole') {
          if (aws.getRoleError !== undefined) throw aws.getRoleError;
          return {
            Role: {
              RoleName: cmd.input['RoleName'],
              ...(aws.boundary !== undefined && {
                PermissionsBoundary: {
                  PermissionsBoundaryType: 'Policy',
                  PermissionsBoundaryArn: aws.boundary,
                },
              }),
            },
          };
        }
        if (cmd.__name === 'ListRolePolicies') {
          const p = page(Object.keys(aws.inline), cmd.input['Marker']);
          return { PolicyNames: p.items, IsTruncated: p.IsTruncated, Marker: p.Marker };
        }
        if (cmd.__name === 'GetRolePolicy') {
          const doc = aws.inline[cmd.input['PolicyName'] as string];
          if (typeof doc === 'string') return { PolicyDocument: encodeURIComponent(doc) };
          return { PolicyDocument: encodeURIComponent(JSON.stringify(doc)) };
        }
        if (cmd.__name === 'ListAttachedRolePolicies') {
          const p = page(aws.managed, cmd.input['Marker']);
          return {
            AttachedPolicies: p.items.map((PolicyArn) => ({ PolicyArn })),
            IsTruncated: p.IsTruncated,
            Marker: p.Marker,
          };
        }
        throw new Error(`unexpected IAM command ${cmd.__name}`);
      }),
      destroy: vi.fn(),
    };
  }),
  GetRoleCommand: command('GetRole'),
  ListRolePoliciesCommand: command('ListRolePolicies'),
  GetRolePolicyCommand: command('GetRolePolicy'),
  ListAttachedRolePoliciesCommand: command('ListAttachedRolePolicies'),
}));

const { buildSessionPolicy, emulateRoleAfterDeniedAssume, isAssumeRoleAccessDenied, SESSION_POLICY_MAX_CHARS } =
  await import('../../../src/local/role-permission-emulation.js');
const { applyLambdaCredentialEnv } = await import('../../../src/cli/commands/local-invoke.js');
const { assumeLambdaExecutionRole } = await import('../../../src/cli/commands/local-start-api.js');
const { buildContainerSpec } = await import(
  '../../../src/cli/commands/local-start-api/container-spec.js'
);
const { assumeTaskRole } = await import('../../../src/cli/commands/local-run-task.js');
const {
  applyAgentCoreCredentialEnv,
  resolveHostCredentialsForSigV4,
  resolveAgentCoreCodeImageFromS3,
} = await import('../../../src/cli/commands/local-invoke-agentcore.js');
const { assumeAgentCoreExecutionRole, buildContainerEnv } = await import(
  '../../../src/cli/commands/local-invoke-agentcore/env.js'
);
const { createLocalCommand } = await import('../../../src/cli/commands/local-invoke.js');
const { applyLocalAwsWiring, resetEmulatorIssuedCredentials } = await import(
  '../../../src/local/local-aws-wiring.js'
);
const { setActiveWorkloadAwsWiring } = await import('cdk-local/internal');
type WorkloadAwsWiring = import('cdk-local/internal').WorkloadAwsWiring;

describe('--emulate-role-via parses to `emulateRoleVia` on every command that takes it', () => {
  function stubbed() {
    const local = createLocalCommand();
    for (const sub of local.commands) sub.action(() => {});
    return local;
  }
  const parsed = (local: ReturnType<typeof stubbed>, name: string): unknown =>
    local.commands.find((c) => c.name() === name)?.opts()['emulateRoleVia'];

  it('invoke', () => {
    const local = stubbed();
    local.parse(['invoke', 'S/T', '--emulate-role-via', VIA], { from: 'user' });
    expect(parsed(local, 'invoke')).toBe(VIA);
  });
  it('start-api', () => {
    const local = stubbed();
    local.parse(['start-api', '--emulate-role-via', VIA], { from: 'user' });
    expect(parsed(local, 'start-api')).toBe(VIA);
  });
  it('run-task', () => {
    const local = stubbed();
    local.parse(['run-task', 'S/T', '--emulate-role-via', VIA], { from: 'user' });
    expect(parsed(local, 'run-task')).toBe(VIA);
  });
  it('invoke-agentcore', () => {
    const local = stubbed();
    local.parse(['invoke-agentcore', 'S/T', '--emulate-role-via', VIA], { from: 'user' });
    expect(parsed(local, 'invoke-agentcore')).toBe(VIA);
  });
});

const S3_LIST = {
  Version: '2012-10-17',
  Statement: [{ Sid: 'List', Effect: 'Allow', Action: 's3:ListAllMyBuckets', Resource: '*' }],
};
const LOGS = {
  Version: '2012-10-17',
  Statement: { Sid: 'List', Effect: 'Allow', Action: 'logs:PutLogEvents', Resource: '*' },
};
const BASIC = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

const ENV_KEYS = [
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
] as const;
const savedEnv: Record<string, string | undefined> = {};
let warn: ReturnType<typeof vi.spyOn>;
const args = {
  roleArn: ROLE,
  region: 'us-east-1',
  realAws: false,
  flag: '--assume-role',
  sessionNamePrefix: 'cdkd-test',
};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  resetAwsClientDefaults();
  ROLE = `arn:aws:iam::123456789012:role/ExecRole${++roleSeq}`;
  args.roleArn = ROLE;
  args.realAws = false;
  aws.sent = [];
  aws.configs = [];
  aws.callerArn = USER_ARN;
  aws.callerIdError = undefined;
  aws.denyRole = ROLE;
  aws.denyError = undefined;
  aws.tokenError = undefined;
  aws.tokenEmpty = false;
  aws.tokenUndefined = false;
  aws.iamError = undefined;
  aws.boundary = undefined;
  aws.getRoleError = undefined;
  aws.inline = { A: S3_LIST, B: LOGS };
  aws.managed = [BASIC];
  aws.pageSize = 0;
  aws.mixed = false;
  aws.emulatorOverride = undefined;
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
const sent = (name: string): Sent | undefined => aws.sent.find((s) => s.name === name);
/** The RoleArn of the emulation's AssumeRole (the second one; the first was refused). */
const viaAssumes = (): unknown[] =>
  aws.sent.filter((s) => s.name === 'AssumeRole' && s.input['RoleArn'] !== ROLE).map((s) => s.input['RoleArn']);
/** `realAws` each emulation client (the IAM one and the STS ones after the refused hop) was built with. */
const iamRealAws = (): unknown[] =>
  aws.configs.filter((c) => c.client === 'IAM').map((c) => c.config['__realAws']);

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
    expect(buildSessionPolicy({ inline: [], managedArns: [] })).toEqual({
      ok: true,
      policy: DENY_ALL,
      policyArns: [],
    });
  });

  it('denies everything when the inline policies have no statement and nothing is managed', () => {
    const plan = buildSessionPolicy({
      inline: [{ Version: '2012-10-17', Statement: [] }, { Version: '2012-10-17' }],
      managedArns: [],
    });
    expect(plan).toEqual({ ok: true, policy: DENY_ALL, policyArns: [] });
  });

  it('sends no Policy for statement-less inline policies beside managed ones', () => {
    const plan = buildSessionPolicy({ inline: [{ Version: '2012-10-17', Statement: [] }], managedArns: [BASIC] });
    expect(plan).toEqual({ ok: true, policy: '', policyArns: [BASIC] });
  });

  it('passes only the ARNs when the role has managed policies alone', () => {
    expect(buildSessionPolicy({ inline: [], managedArns: [BASIC] })).toEqual({
      ok: true,
      policy: '',
      policyArns: [BASIC],
    });
  });

  it('refuses more than 10 managed policies', () => {
    const arns = Array.from({ length: 11 }, (_, i) => `arn:aws:iam::aws:policy/P${i}`);
    const plan = buildSessionPolicy({ inline: [], managedArns: arns });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain('11 managed policies');
  });

  /** An inline document whose minified JSON is exactly `chars` long. */
  function inlineOf(chars: number): unknown {
    const doc = (pad: string) => ({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::${pad}` }],
    });
    const base = JSON.stringify(buildPlanPolicy(doc(''))).length;
    return doc('b'.repeat(chars - base));
  }
  function buildPlanPolicy(d: unknown): unknown {
    const plan = buildSessionPolicy({ inline: [d], managedArns: [] });
    return plan.ok ? JSON.parse(plan.policy) : undefined;
  }
  const ARN_49 = `arn:aws:iam::aws:policy/${'x'.repeat(49 - 24)}`;

  it('counts the managed ARNs: ~2000 inline characters plus a 49-character ARN is refused', () => {
    expect(ARN_49).toHaveLength(49);
    const plan = buildSessionPolicy({ inline: [inlineOf(2000)], managedArns: [ARN_49] });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain('2049 characters');
  });

  it('accepts exactly 2,048 characters', () => {
    const plan = buildSessionPolicy({ inline: [inlineOf(1999)], managedArns: [ARN_49] });
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.policy.length + ARN_49.length).toBe(SESSION_POLICY_MAX_CHARS);
  });

  it('refuses inline policies whose Versions differ', () => {
    const plan = buildSessionPolicy({
      inline: [S3_LIST, { ...LOGS, Version: '2008-10-17' }],
      managedArns: [],
    });
    expect(plan.ok).toBe(false);
  });
});

describe('isAssumeRoleAccessDenied', () => {
  it('is the AccessDenied name', () => {
    expect(isAssumeRoleAccessDenied(accessDenied())).toBe(true);
  });

  it.each(['InvalidClientTokenId', 'SignatureDoesNotMatch', 'ExpiredToken'])(
    'is not a bare 403 (%s: broken caller credentials)',
    (name) => {
      expect(isAssumeRoleAccessDenied({ name, $metadata: { httpStatusCode: 403 } })).toBe(false);
    }
  );
});

describe('emulateRoleAfterDeniedAssume against AWS Emulator (go-to-k/cdkd#6252)', () => {
  it('skips GetFederationToken: the emulator user has no policies, so the session would allow nothing', async () => {
    aws.emulatorOverride = { endpoint: 'https://127.0.0.1:9297' };
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(aws.sent).toEqual([]);
    const text = warnings();
    expect(text).toContain('GetFederationToken session is allowed nothing');
    expect(text).toContain("trust policy allow the emulator's identity");
    expect(text).not.toContain('APPROXIMATION');
  });

  it('still emulates through --emulate-role-via, a role the caller can assume there', async () => {
    aws.emulatorOverride = { endpoint: 'https://127.0.0.1:9297' };
    const creds = await emulateRoleAfterDeniedAssume(accessDenied(), { ...args, emulateRoleVia: VIA });
    expect(creds?.accessKeyId).toBe('ASIA-AssumeRole');
    expect(viaAssumes()).toEqual([VIA]);
  });

  describe('the role credentials the emulator issued reach the container', () => {
    const EMU_KEYS = { accessKeyId: 'EMULATORKEY000000000', secretAccessKey: 'emulator-secret' };
    const wiring = {
      mode: 'emulator',
      emulatorEndpoint: { url: 'https://127.0.0.1:9297', hostname: '127.0.0.1', port: 9297, loopback: true },
      env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:9297' },
      scrubEnvKeys: [],
      mounts: [],
      loopbackPorts: [9297],
      probeHealth: true,
      emulatorCredentials: EMU_KEYS,
      dispose: () => {},
    } as unknown as WorkloadAwsWiring;
    const ROLE_TRIPLE = {
      AWS_ACCESS_KEY_ID: 'ASIA-AssumeRole',
      AWS_SECRET_ACCESS_KEY: SECRET,
      AWS_SESSION_TOKEN: 'token-AssumeRole',
    };
    beforeEach(() => {
      aws.denyRole = undefined;
      setActiveWorkloadAwsWiring(wiring);
    });
    afterEach(() => {
      setActiveWorkloadAwsWiring(undefined);
      resetEmulatorIssuedCredentials();
    });
    const wired = async (env: Record<string, string>) =>
      (await applyLocalAwsWiring(wiring, env, [], [])).env;

    it('local invoke', async () => {
      const env: Record<string, string> = {};
      await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE, region: 'us-east-1' });
      expect(await wired(env)).toMatchObject(ROLE_TRIPLE);
    });

    it('local start-api', async () => {
      const c = await assumeLambdaExecutionRole(ROLE, 'us-east-1');
      expect(
        await wired({
          AWS_ACCESS_KEY_ID: c.accessKeyId,
          AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
          AWS_SESSION_TOKEN: c.sessionToken,
        })
      ).toMatchObject(ROLE_TRIPLE);
    });

    it('local invoke-agentcore', async () => {
      const c = await assumeAgentCoreExecutionRole(ROLE, 'us-east-1');
      expect(
        await wired({
          AWS_ACCESS_KEY_ID: c.accessKeyId,
          AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
          AWS_SESSION_TOKEN: c.sessionToken,
        })
      ).toMatchObject(ROLE_TRIPLE);
    });

    it('caller credentials in the env are still replaced by the emulator keys', async () => {
      const out = await wired({ AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'real' });
      expect(out['AWS_ACCESS_KEY_ID']).toBe(EMU_KEYS.accessKeyId);
    });
  });

  it('mixed mode routes the hop to real AWS, where GetFederationToken still runs', async () => {
    aws.emulatorOverride = { endpoint: 'https://127.0.0.1:9297' };
    const creds = await emulateRoleAfterDeniedAssume(accessDenied(), { ...args, realAws: true });
    expect(creds?.accessKeyId).toBe('ASIA-GetFederationToken');
  });
});

describe('emulateRoleAfterDeniedAssume', () => {
  it('does nothing for a failure that is not AccessDenied', async () => {
    const err = Object.assign(new Error('throttled'), { name: 'Throttling' });
    expect(await emulateRoleAfterDeniedAssume(err, args)).toBeUndefined();
    expect(aws.sent).toEqual([]);
  });

  it('does nothing for a 403 from broken caller credentials', async () => {
    const err = Object.assign(new Error('bad token'), {
      name: 'InvalidClientTokenId',
      $metadata: { httpStatusCode: 403 },
    });
    expect(await emulateRoleAfterDeniedAssume(err, args)).toBeUndefined();
    expect(aws.sent).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('an IAM user gets GetFederationToken with the role policies as session policies', async () => {
    const creds = await emulateRoleAfterDeniedAssume(accessDenied(), args);
    expect(creds?.accessKeyId).toBe('ASIA-GetFederationToken');
    const token = sent('GetFederationToken');
    expect(JSON.parse(token?.input['Policy'] as string).Statement).toHaveLength(2);
    expect(token?.input['PolicyArns']).toEqual([{ arn: BASIC }]);
    expect(sentNames()).not.toContain('AssumeRole');
    const text = warnings();
    expect(text).toContain('APPROXIMATION');
    // A boundary is refused (#6220), so the notice no longer lists it.
    expect(text).not.toContain('permissions boundary');
    expect(text).toContain('aws:username');
    expect(text).toContain('cannot call IAM');
    expect(text).not.toContain(SECRET);
  });

  it('a managed-only role sends no Policy key', async () => {
    aws.inline = {};
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    const token = sent('GetFederationToken');
    expect(token?.input).not.toHaveProperty('Policy');
    expect(token?.input['PolicyArns']).toEqual([{ arn: BASIC }]);
  });

  it('a policy-less role sends the deny-all policy and no ARNs', async () => {
    aws.inline = {};
    aws.managed = [];
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    const token = sent('GetFederationToken');
    expect(token?.input['Policy']).toBe(DENY_ALL);
    expect(token?.input).not.toHaveProperty('PolicyArns');
  });

  it('reads the role by the last segment of a path role ARN', async () => {
    await emulateRoleAfterDeniedAssume(accessDenied(), {
      ...args,
      roleArn: 'arn:aws:iam::123456789012:role/service-role/X',
    });
    expect(sent('GetRole')?.input['RoleName']).toBe('X');
    expect(sent('ListRolePolicies')?.input['RoleName']).toBe('X');
    expect(sent('ListAttachedRolePolicies')?.input['RoleName']).toBe('X');
  });

  it('follows every List* page and uses the policies of all of them', async () => {
    aws.pageSize = 1;
    aws.managed = [BASIC, 'arn:aws:iam::aws:policy/Other'];
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    const lists = aws.sent.filter((s) => s.name === 'ListRolePolicies');
    expect(lists.map((s) => s.input['Marker'])).toEqual([undefined, 'm1']);
    const attached = aws.sent.filter((s) => s.name === 'ListAttachedRolePolicies');
    expect(attached.map((s) => s.input['Marker'])).toEqual([undefined, 'm1']);
    const token = sent('GetFederationToken');
    expect(JSON.parse(token?.input['Policy'] as string).Statement).toHaveLength(2);
    expect(token?.input['PolicyArns']).toHaveLength(2);
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

  it('prints the cannot-emulate warning once per role (agentcore assumes up to 3 times)', async () => {
    aws.callerArn = ASSUMED_ARN;
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('--emulate-role-via assumes that role with the session policies', async () => {
    aws.callerArn = ASSUMED_ARN;
    const creds = await emulateRoleAfterDeniedAssume(accessDenied(), {
      ...args,
      emulateRoleVia: VIA,
    });
    expect(creds?.accessKeyId).toBe('ASIA-AssumeRole');
    const assume = sent('AssumeRole');
    expect(assume?.input['RoleArn']).toBe(VIA);
    expect(assume?.input['Policy']).toBeTypeOf('string');
    expect(assume?.input['PolicyArns']).toHaveLength(1);
    expect(sentNames()).not.toContain('GetFederationToken');
    expect(warnings()).toContain('APPROXIMATION');
    expect(warnings()).not.toContain('cannot call IAM');
  });

  it('refuses a role in another account (IAM is read by name in the caller account)', async () => {
    const other = 'arn:aws:iam::999999999999:role/ExecRole';
    expect(
      await emulateRoleAfterDeniedAssume(accessDenied(), { ...args, roleArn: other })
    ).toBeUndefined();
    expect(sentNames()).toEqual(['GetCallerIdentity']);
    expect(warnings()).toContain("not in your credentials' account");
  });

  // go-to-k/cdkd#6220: STS combines session policies as a union, so the
  // boundary cannot be one more of them; emulating would allow what it denies.
  it('refuses a role with a permissions boundary: no STS credentials, a warning naming it', async () => {
    aws.boundary = 'arn:aws:iam::123456789012:policy/ExecBoundary';
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(sentNames()).toContain('GetRole');
    expect(sentNames()).not.toContain('GetFederationToken');
    expect(sentNames()).not.toContain('AssumeRole');
    const text = warnings();
    expect(text).toContain('cannot emulate');
    expect(text).toContain('permissions boundary (arn:aws:iam::123456789012:policy/ExecBoundary)');
    expect(text).not.toContain('APPROXIMATION');
    // No policy contents in the warning.
    expect(text).not.toContain('s3:ListAllMyBuckets');
  });

  it('refuses a role with a permissions boundary under --emulate-role-via too (no via AssumeRole)', async () => {
    aws.callerArn = ASSUMED_ARN;
    aws.boundary = 'arn:aws:iam::123456789012:policy/ExecBoundary';
    expect(
      await emulateRoleAfterDeniedAssume(accessDenied(), { ...args, emulateRoleVia: VIA })
    ).toBeUndefined();
    expect(sentNames()).not.toContain('AssumeRole');
    expect(warnings()).toContain('permissions boundary');
  });

  it('warns about the boundary once per role', async () => {
    aws.boundary = 'arn:aws:iam::123456789012:policy/ExecBoundary';
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    await emulateRoleAfterDeniedAssume(accessDenied(), args);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a GetRole failure is a cannot-emulate warning naming iam:GetRole, and no credentials', async () => {
    aws.getRoleError = Object.assign(new Error('not authorized to perform: iam:GetRole'), {
      name: 'AccessDenied',
      $fault: 'client',
      $metadata: { httpStatusCode: 403 },
    });
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(sentNames()).not.toContain('GetFederationToken');
    expect(warnings()).toContain("reading the role's policies failed (it needs iam:GetRole");
  });

  it('a non-JSON inline policy document never reaches a log line', async () => {
    const debug = vi.spyOn(getLogger(), 'debug').mockImplementation(() => undefined);
    aws.inline = { Bad: 'SNIPPET-OF-THE-POLICY' };
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    const all = [...warn.mock.calls, ...debug.mock.calls].map((c) => String(c[0])).join('\n');
    debug.mockRestore();
    expect(all).toContain('not valid JSON');
    expect(all).not.toContain('SNIPPET');
  });

  it('over the limits: warns and asks STS for nothing', async () => {
    aws.managed = Array.from({ length: 11 }, (_, i) => `arn:aws:iam::aws:policy/P${i}`);
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(sentNames()).not.toContain('GetFederationToken');
    expect(warnings()).toContain('11 managed policies');
  });

  it('PackedPolicyTooLargeException (the SDK name) gets its dedicated message', async () => {
    aws.tokenError = Object.assign(new Error('packed too large'), {
      name: 'PackedPolicyTooLargeException',
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
    });
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(warnings()).toContain('larger than STS accepts as session policies (PackedPolicyTooLarge)');
  });

  it('a refused GetFederationToken (temporary IAM-user credentials) points at --emulate-role-via', async () => {
    aws.tokenError = Object.assign(new Error('Cannot call GetFederationToken with session credentials'), {
      name: 'AccessDenied',
      $fault: 'client',
      $metadata: { httpStatusCode: 403 },
    });
    expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
    expect(warnings()).toContain('Temporary IAM user credentials');
    expect(warnings()).toContain('--emulate-role-via');
  });

  describe('failure branches: undefined, a warning, and the original refusal rethrown', () => {
    const refusal = async (): Promise<string> => {
      const err = await assumeTaskRole(ROLE, 'us-east-1', { realAws: false }).then(
        () => undefined,
        (e: unknown) => e
      );
      return (err as Error).message;
    };

    it.each([
      ['no usable credentials', () => (aws.tokenEmpty = true), 'STS returned no usable credentials'],
      [
        'a GetCallerIdentity failure',
        () => (aws.callerIdError = Object.assign(new Error('x'), { name: 'Throttling', $fault: 'client', $metadata: {} })),
        'cannot emulate',
      ],
      [
        'an IAM read failure',
        () => (aws.iamError = Object.assign(new Error('no iam'), { name: 'AccessDenied', $fault: 'client', $metadata: {} })),
        "reading the role's policies failed",
      ],
      ['an unexpected exception', () => (aws.tokenUndefined = true), "emulating the role's permissions failed"],
    ])('%s', async (_label, arrange, warned) => {
      arrange();
      expect(await emulateRoleAfterDeniedAssume(accessDenied(), args)).toBeUndefined();
      expect(warnings()).toContain(warned);
      // A fresh role: the run-task hop rethrows the ORIGINAL AccessDenied.
      ROLE = `arn:aws:iam::123456789012:role/ExecRole${++roleSeq}`;
      aws.denyRole = ROLE;
      expect(await refusal()).toContain('AccessDenied: User is not authorized to perform: sts:AssumeRole');
    });
  });
});

describe('the cdkd-owned commands fall back to emulation on a refused assume', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cdkd-6201-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const apiStack = {
    stackName: 'ApiStack',
    displayName: 'ApiStack',
    artifactId: 'ApiStack',
    template: {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs22.x',
            Handler: 'index.handler',
            Code: { ZipFile: 'exports.handler = async () => ({});' },
          },
        },
      },
    },
    dependencyNames: [],
  } as unknown as StackInfo;
  const spec = (emulateRoleVia?: string) =>
    buildContainerSpec({
      logicalId: 'Fn',
      stacks: [apiStack],
      overrides: undefined,
      assumeRole: { globalArn: ROLE, perLambda: {} },
      containerHost: '127.0.0.1',
      stsRegion: 'us-east-1',
      inlineTmpDirs: new Set([workDir]),
      layerTmpDirs: new Set(),
      stateByStack: new Map(),
      skipPull: true,
      ...(emulateRoleVia !== undefined && { emulateRoleVia }),
    });
  const agentStack = {
    stackName: 'AgentStack',
    displayName: 'AgentStack',
    artifactId: 'AgentStack',
    dependencyNames: [],
    region: 'us-east-1',
    template: { Resources: {} },
  } as unknown as StackInfo;
  const runtime = () =>
    ({
      logicalId: 'Runtime',
      stack: agentStack,
      properties: {},
      environmentVariables: {},
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
    }) as never;

  it('local invoke: the container gets the emulated credentials', async () => {
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE, region: 'us-east-1' });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('ASIA-GetFederationToken');
    expect(env['AWS_SESSION_TOKEN']).toBe('token-GetFederationToken');
    expect(warnings()).not.toContain("Falling back to the developer's shell credentials");
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

  it('local invoke: a role with a permissions boundary keeps the old shell-credentials fallback', async () => {
    aws.boundary = 'arn:aws:iam::123456789012:policy/ExecBoundary';
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIA-CALLER';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'caller-secret';
    const env: Record<string, string> = {};
    await applyLambdaCredentialEnv(env, { assumeRoleArn: ROLE, region: 'us-east-1' });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIA-CALLER');
    expect(warnings()).toContain('permissions boundary');
    expect(warnings()).toContain("Falling back to the developer's shell credentials");
  });

  it('local run-task: a role with a permissions boundary rethrows the original AssumeRole refusal', async () => {
    aws.boundary = 'arn:aws:iam::123456789012:policy/ExecBoundary';
    const err = await assumeTaskRole(ROLE, 'us-east-1', { realAws: false }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toContain('AccessDenied: User is not authorized to perform: sts:AssumeRole');
    expect(sentNames()).not.toContain('GetFederationToken');
  });

  describe('--emulate-role-via reaches each hop (assumed-role caller)', () => {
    beforeEach(() => {
      aws.callerArn = ASSUMED_ARN;
    });

    it('local invoke: applyLambdaCredentialEnv', async () => {
      const env: Record<string, string> = {};
      await applyLambdaCredentialEnv(env, {
        assumeRoleArn: ROLE,
        emulateRoleVia: VIA,
        region: 'us-east-1',
      });
      expect(env['AWS_ACCESS_KEY_ID']).toBe('ASIA-AssumeRole');
      expect(viaAssumes()).toEqual([VIA]);
    });

    it('local start-api: buildContainerSpec', async () => {
      const out = await spec(VIA);
      expect(out.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-AssumeRole');
      expect(viaAssumes()).toEqual([VIA]);
    });

    it('local start-api: assumeLambdaExecutionRole', async () => {
      const creds = await assumeLambdaExecutionRole(ROLE, 'us-east-1', VIA);
      expect(creds.accessKeyId).toBe('ASIA-AssumeRole');
      expect(viaAssumes()).toEqual([VIA]);
    });

    it('local run-task: assumeTaskRole', async () => {
      const creds = await assumeTaskRole(ROLE, 'us-east-1', { realAws: false }, VIA);
      expect(creds.accessKeyId).toBe('ASIA-AssumeRole');
      expect(viaAssumes()).toEqual([VIA]);
    });

    it('local invoke-agentcore: applyAgentCoreCredentialEnv', async () => {
      const env: Record<string, string> = {};
      await applyAgentCoreCredentialEnv(env, {
        assumeRoleArn: ROLE,
        emulateRoleVia: VIA,
        region: 'us-east-1',
      });
      expect(env['AWS_ACCESS_KEY_ID']).toBe('ASIA-AssumeRole');
      expect(viaAssumes()).toEqual([VIA]);
    });

    it('local invoke-agentcore: buildContainerEnv (the command-level hand-off)', async () => {
      const out = await buildContainerEnv(
        runtime(),
        { assumeRole: ROLE, emulateRoleVia: VIA, region: 'us-east-1' } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      );
      expect(out.env['AWS_ACCESS_KEY_ID']).toBe('ASIA-AssumeRole');
      expect(viaAssumes()).toEqual([VIA]);
    });

    it('local invoke-agentcore: resolveHostCredentialsForSigV4', async () => {
      const creds = await resolveHostCredentialsForSigV4(
        { assumeRole: ROLE, emulateRoleVia: VIA } as never,
        runtime(),
        undefined,
        'us-east-1'
      );
      expect(creds.accessKeyId).toBe('ASIA-AssumeRole');
      expect(viaAssumes()).toEqual([VIA]);
    });

    it('local invoke-agentcore: resolveAgentCoreCodeImageFromS3', async () => {
      await resolveAgentCoreCodeImageFromS3(
        runtime(),
        { runtime: 'PYTHON_3_12', entryPoint: ['main.py'] } as never,
        { bucket: 'bundle-bucket', key: 'bundle.zip' },
        { assumeRole: ROLE, emulateRoleVia: VIA, region: 'us-east-1' } as never,
        'arm64',
        undefined
      ).catch(() => undefined);
      expect(viaAssumes()).toEqual([VIA]);
    });
  });

  describe('the emulation clients take the refused hop route', () => {
    it.each([
      ['local invoke', () => applyLambdaCredentialEnv({}, { assumeRoleArn: ROLE, region: 'us-east-1' })],
      ['local start-api', () => assumeLambdaExecutionRole(ROLE, 'us-east-1')],
      ['local invoke-agentcore', () => assumeAgentCoreExecutionRole(ROLE, 'us-east-1')],
    ])('%s: mixedModeActive()', async (_label, run) => {
      aws.mixed = true;
      await run();
      expect(iamRealAws()).toEqual([true]);
      aws.configs = [];
      aws.mixed = false;
      ROLE = `arn:aws:iam::123456789012:role/ExecRole${++roleSeq}`;
      aws.denyRole = ROLE;
      await run();
      expect(iamRealAws()).toEqual([false]);
    });

    it('local run-task: the route parameter', async () => {
      await assumeTaskRole(ROLE, 'us-east-1', { realAws: true });
      expect(iamRealAws()).toEqual([true]);
      expect(aws.configs.filter((c) => c.client === 'STS').map((c) => c.config['__realAws'])).toEqual([
        true,
        true,
      ]);
      aws.configs = [];
      ROLE = `arn:aws:iam::123456789012:role/ExecRole${++roleSeq}`;
      aws.denyRole = ROLE;
      await assumeTaskRole(ROLE, 'us-east-1', { realAws: false });
      expect(iamRealAws()).toEqual([false]);
    });

    it('every emulation client is the caller (ignoreAssumedRole)', async () => {
      await assumeTaskRole(ROLE, 'us-east-1', { realAws: false });
      expect(aws.configs.map((c) => c.config['__ignoreAssumedRole'])).toEqual([true, true, true]);
    });
  });

  it('local start-api / run-task / invoke-agentcore return the emulated credentials', async () => {
    expect((await assumeLambdaExecutionRole(ROLE, 'us-east-1')).accessKeyId).toBe(
      'ASIA-GetFederationToken'
    );
    expect((await assumeTaskRole(ROLE, 'us-east-1', { realAws: false })).accessKeyId).toBe(
      'ASIA-GetFederationToken'
    );
    expect((await assumeAgentCoreExecutionRole(ROLE, 'us-east-1')).accessKeyId).toBe(
      'ASIA-GetFederationToken'
    );
  });
});
