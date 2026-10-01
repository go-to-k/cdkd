import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
} from '../../../src/utils/aws-client-defaults.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * Issue go-to-k/cdkd#3230: `${AWS::AccountId}` in the emulated workload's
 * environment follows the SOURCE the stack was read from, not whichever
 * identity happens to answer STS.
 *
 * - `--from-state` reads cdkd's state record AS the `--role-arn` role when one
 *   is published (and `ExpectedBucketOwner` pins that bucket to the reader's
 *   account), so the account is the ROLE's.
 * - `--from-cfn-stack` keeps the CALLER's own account.
 *
 * Each of the five resolvers on the four commands is driven through its own
 * entry point in both polarities. The STS mock answers with the account that
 * belongs to the credentials the client was BUILT with, so the assertion is on
 * the account the workload would see, not on a config key that merely exists.
 * The case that can tell the two apart is the one with a role published and
 * the caller holding different static credentials; the no-role case pins that
 * nothing changes for a run without `--role-arn`.
 */
const ROLE = { accessKeyId: 'role-access-key-id', secretAccessKey: 'role-sk', sessionToken: 'role-st' };
const CALLER = { accessKeyId: 'caller-access-key-id', secretAccessKey: 'caller-sk' };
const ROLE_ACCOUNT = '222222222222';
const CALLER_ACCOUNT = '111111111111';
const DEFAULT_CHAIN_ACCOUNT = '999999999999';
const PROFILE_ACCOUNT = '333333333333';

const stsClientConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
/** Flip to make every `GetCallerIdentity` reject, for the warning-label cases. */
const stsFailure = vi.hoisted(() => ({ on: false }));
/** Flip to make `GetCallerIdentity` answer with no `Account`. */
const stsNoAccount = vi.hoisted(() => ({ on: false }));

/** The account the mocked STS reports for the identity a client was built with. */
function accountFor(config: Record<string, unknown>): string {
  const creds = config['credentials'] as { accessKeyId?: string } | undefined;
  if (creds?.accessKeyId === ROLE.accessKeyId) return ROLE_ACCOUNT;
  if (creds?.accessKeyId === CALLER.accessKeyId) return CALLER_ACCOUNT;
  if (creds !== undefined) throw new Error('unexpected credentials shape in STS config');
  if (config['profile'] === 'dev') return PROFILE_ACCOUNT;
  return DEFAULT_CHAIN_ACCOUNT;
}

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(function STSClient(this: unknown, config: Record<string, unknown>) {
    stsClientConfigs.push(config);
    return {
      send: vi.fn(async () => {
        if (stsFailure.on) throw new Error('sts unavailable');
        if (stsNoAccount.on) return {};
        return { Account: accountFor(config) };
      }),
      destroy: vi.fn(),
    };
  }),
  GetCallerIdentityCommand: vi.fn(function GetCallerIdentityCommand(this: unknown) {}),
  AssumeRoleCommand: vi.fn(function AssumeRoleCommand(this: unknown) {}),
}));

const { resolvePseudoParametersForInvoke } = await import(
  '../../../src/cli/commands/local-invoke.js'
);
const { resolvePseudoParametersForStartApi } = await import(
  '../../../src/cli/commands/local-start-api.js'
);
const { buildEcsImageResolutionContext, resolvePlaceholderAccount } = await import(
  '../../../src/cli/commands/local-run-task.js'
);
const { buildAgentCoreImageContext } = await import(
  '../../../src/cli/commands/local-invoke-agentcore.js'
);

/** A container env entry splicing `${AWS::AccountId}` — the shape that asks for pseudo parameters. */
function ecsStack(): StackInfo {
  return {
    stackName: 'AccountSourceStack',
    displayName: 'AccountSourceStack',
    artifactId: 'AccountSourceStack',
    dependencyNames: [],
    region: 'us-east-1',
    template: {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: 'public.ecr.aws/docker/library/busybox:latest',
                Environment: [
                  {
                    Name: 'ACCOUNT',
                    Value: { 'Fn::Join': ['', [{ Ref: 'AWS::AccountId' }]] },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

function agentCoreStack(): StackInfo {
  return {
    stackName: 'AccountSourceStack',
    displayName: 'AccountSourceStack',
    artifactId: 'AccountSourceStack',
    dependencyNames: [],
    region: 'us-east-1',
    template: { Resources: {} },
  } as unknown as StackInfo;
}

/** A state provider that loads nothing: the account is resolved before the load either way. */
function stubProvider(label: string): never {
  return {
    label,
    load: vi.fn(async () => undefined),
    dispose: vi.fn(),
  } as never;
}

type Source = 'from-state' | 'from-cfn-stack';

function sourceOptions(source: Source, profile?: string): Record<string, unknown> {
  return {
    region: 'us-east-1',
    statePrefix: 'cdkd',
    fromState: source === 'from-state',
    ...(source === 'from-cfn-stack' && { fromCfnStack: true }),
    ...(profile !== undefined && { profile }),
  };
}

/** One entry per resolver: drive it and return the account it resolved. */
const resolvers: Array<{
  name: string;
  resolve: (source: Source, profile?: string) => Promise<string | undefined>;
}> = [
  {
    name: 'local invoke: resolvePseudoParametersForInvoke',
    resolve: async (source, profile) =>
      (await resolvePseudoParametersForInvoke(undefined, sourceOptions(source, profile) as never))
        ?.accountId,
  },
  {
    name: 'local start-api: resolvePseudoParametersForStartApi',
    resolve: async (source, profile) =>
      (await resolvePseudoParametersForStartApi('us-east-1', sourceOptions(source, profile) as never))
        ?.accountId,
  },
  {
    name: 'local run-task: buildEcsImageResolutionContext',
    resolve: async (source, profile) =>
      (
        await buildEcsImageResolutionContext(
          ecsStack(),
          stubProvider(source === 'from-state' ? '--from-state' : '--from-cfn-stack'),
          sourceOptions(source, profile) as never
        )
      ).context?.pseudoParameters?.accountId,
  },
  {
    name: 'local run-task: resolvePlaceholderAccount (bare --assume-task-role)',
    resolve: async (source, profile) => {
      const arn = await resolvePlaceholderAccount('arn:aws:iam::${AWS::AccountId}:role/TaskRole', {
        region: 'us-east-1',
        profile,
        fromState: source === 'from-state',
      });
      return /^arn:aws:iam::(\d{12}):role\/TaskRole$/.exec(arn)?.[1];
    },
  },
  {
    name: 'local invoke-agentcore: buildAgentCoreImageContext',
    resolve: async (source, profile) =>
      (
        await buildAgentCoreImageContext(
          agentCoreStack(),
          stubProvider(source === 'from-state' ? '--from-state' : '--from-cfn-stack'),
          sourceOptions(source, profile) as never
        )
      ).context?.pseudoParameters?.accountId,
  },
];

const ENV_KEYS = [
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const warnSpy = vi.spyOn(getLogger(), 'warn');

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetAwsClientDefaults();
  stsClientConfigs.length = 0;
  stsFailure.on = false;
  warnSpy.mockReset();
  warnSpy.mockImplementation(() => {});
});

afterEach(() => {
  resetAwsClientDefaults();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** What `applyRoleArnIfSet` leaves behind: the caller snapshotted, the role published. */
function publishRole(): void {
  setPreAssumeEnvCredentials(CALLER);
  setAssumedRoleCredentials(ROLE);
}

describe('${AWS::AccountId} follows the state source the stack was read from (issue #3230)', () => {
  describe.each(resolvers)('$name', ({ resolve }) => {
    it('--from-state with --role-arn: the account the state was read in (the role)', async () => {
      publishRole();
      await expect(resolve('from-state')).resolves.toBe(ROLE_ACCOUNT);
      expect(stsClientConfigs).toHaveLength(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("--from-cfn-stack with --role-arn: the caller's own account, never the role's", async () => {
      publishRole();
      await expect(resolve('from-cfn-stack')).resolves.toBe(CALLER_ACCOUNT);
      expect(stsClientConfigs).toHaveLength(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('with no --role-arn, both sources resolve the same default-chain account as before', async () => {
      await expect(resolve('from-state')).resolves.toBe(DEFAULT_CHAIN_ACCOUNT);
      await expect(resolve('from-cfn-stack')).resolves.toBe(DEFAULT_CHAIN_ACCOUNT);
      // Byte-identical client configs: the two arms differ only once a role exists.
      expect(stsClientConfigs).toHaveLength(2);
      expect(stsClientConfigs[0]).toEqual(stsClientConfigs[1]);
    });

    it('asks through --profile, the identity both state sources read through', async () => {
      await expect(resolve('from-state', 'dev')).resolves.toBe(PROFILE_ACCOUNT);
      await expect(resolve('from-cfn-stack', 'dev')).resolves.toBe(PROFILE_ACCOUNT);
    });

    it('with --profile AND --role-arn, --from-state still takes the role the state was read as', async () => {
      publishRole();
      await expect(resolve('from-state', 'dev')).resolves.toBe(ROLE_ACCOUNT);
      await expect(resolve('from-cfn-stack', 'dev')).resolves.toBe(PROFILE_ACCOUNT);
    });
  });
});

describe('an STS failure is warned under the state-source flag actually in use', () => {
  // `run-task`'s warning carries no flag prefix, so it has no label to get wrong.
  const labelled = resolvers.filter(
    (r) => !r.name.startsWith('local run-task')
  );

  describe.each(labelled)('$name', ({ resolve }) => {
    it.each<[Source, string, string]>([
      ['from-state', '--from-state:', '--from-cfn-stack:'],
      ['from-cfn-stack', '--from-cfn-stack:', '--from-state:'],
    ])('%s', async (source, expected, other) => {
      stsFailure.on = true;
      await expect(resolve(source)).resolves.toBeUndefined();
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      const sts = messages.filter((m) => m.includes('sts unavailable'));
      expect(sts).toHaveLength(1);
      expect(sts[0]?.startsWith(expected)).toBe(true);
      expect(messages.some((m) => m.startsWith(other))).toBe(false);
    });
  });
});

describe('local run-task: resolvePlaceholderAccount with no Account (go-to-k/cdkd#4295)', () => {
  it('quotes the --assume-task-role hole in its refusal', async () => {
    stsNoAccount.on = true;
    try {
      await expect(
        resolvePlaceholderAccount('arn:aws:iam::${AWS::AccountId}:role/TaskRole', {
          region: 'us-east-1',
        } as never)
      ).rejects.toThrow("Pass the ARN explicitly: --assume-task-role '<arn>'");
    } finally {
      stsNoAccount.on = false;
    }
  });

  it('describes a payload ARN beside --assume-task-role', async () => {
    const { PASTE_PAYLOADS, expectNoCommandBesideDisplay, spansThatRun, withPasteDir } =
      await import('../utils/paste-harness.js');
    stsNoAccount.on = true;
    try {
      for (const { value } of PASTE_PAYLOADS) {
        const message = await resolvePlaceholderAccount(
          `arn:aws:iam::\${AWS::AccountId}:role/${value}`,
          { region: 'us-east-1' } as never
        ).then(
          () => '',
          (e: unknown) => (e as Error).message
        );
        expect(message, value).toContain(
          'cannot resolve placeholder ARN (not shown: it is not a plain identifier).'
        );
        withPasteDir((dir) => {
          expectNoCommandBesideDisplay(message, value);
          expect(spansThatRun(message, dir), `${value}: ${message}`).toEqual([]);
        });
      }
    } finally {
      stsNoAccount.on = false;
    }
  }, 120_000);
});
