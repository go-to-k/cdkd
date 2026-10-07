/**
 * Issue #4639 (the remaining-sites slice): CloudFront `CreateOriginAccessControl`,
 * SSM `PutParameter` (`Overwrite: false`), CodeBuild `CreateProject`, Budgets
 * `CreateBudget`, Auto Scaling `CreateAutoScalingGroup`, WAFv2 `CreateWebACL`
 * and EFS `CreateMountTarget` carry no idempotency token, and used to go
 * through a client whose SDK retry replays a 5xx inside one `send` --
 * invisibly. Each now goes through a dedicated client that refuses the SDK's
 * 5xx retry, so the 5xx reaches the deploy engine's retry and its latch.
 *
 * Every SDK client here is a stand-in whose `send` models the SDK retry
 * middleware (it asks the client's RESOLVED `config.retryStrategy` whether to
 * replay a failure), so the lost-response case is red without the routing:
 * the in-send replay would collide on the engine's FIRST attempt.
 */
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vite-plus/test';

interface StandInConfig {
  region: () => Promise<string>;
  /** The `profile` the client was constructed with, to tell identities apart. */
  profile?: string;
  retryStrategy: () => Promise<unknown>;
}

interface Command {
  constructor: { name: string };
  input: Record<string, unknown>;
}

const h = vi.hoisted(() => {
  /** A stand-in for the SDK's resolved V2 retry strategy: it retries a server fault only. */
  const baseStrategy = {
    acquireInitialRetryToken: async (_scope: string) => 'token',
    refreshRetryTokenForRetry: async (_token: unknown, info: { error?: unknown }) => {
      if ((info.error as { $fault?: string } | undefined)?.$fault !== 'server') {
        throw new Error('not retryable');
      }
      return 'retry-token';
    },
    recordSuccess: (_token: unknown) => undefined,
  };
  /** `[command name, client config, input]` per send, so a test can see WHICH client sent it. */
  const sentVia: Array<[string, StandInConfig, Record<string, unknown>]> = [];
  const state = {
    service: (async () => ({})) as (command: Command) => Promise<unknown>,
  };
  /**
   * A distinct client class per SDK package, so a provider's
   * `instanceof <Service>Client` sees the `AwsClients`-built shared client as
   * production-shaped. Its `send` replays a failure while the resolved
   * strategy hands back a token (the standard mode's 3 attempts).
   */
  const fakeClientClass = () =>
    class FakeClient {
      readonly config: StandInConfig;
      constructor(options: Record<string, unknown> = {}) {
        const region =
          (options['region'] as string | undefined) ?? process.env['AWS_REGION'] ?? 'us-east-1';
        this.config = {
          region: () => Promise.resolve(region),
          ...(options['profile'] !== undefined && { profile: options['profile'] as string }),
          retryStrategy: async (): Promise<unknown> => baseStrategy,
        };
      }
      async send(command: Command): Promise<unknown> {
        sentVia.push([command.constructor.name, this.config, command.input]);
        const strategy = (await this.config.retryStrategy()) as typeof baseStrategy;
        let token: unknown = await strategy.acquireInitialRetryToken('svc');
        for (let attempt = 1; ; attempt++) {
          try {
            return await state.service(command);
          } catch (error) {
            if (attempt >= 3) throw error;
            try {
              token = await strategy.refreshRetryTokenForRetry(token, { error });
            } catch {
              throw error;
            }
          }
        }
      }
      destroy(): void {}
    };
  return { baseStrategy, sentVia, state, fakeClientClass };
});

vi.mock('@aws-sdk/client-cloudfront', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CloudFrontClient: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  SSMClient: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-codebuild', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CodeBuildClient: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-budgets', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BudgetsClient: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  STSClient: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-auto-scaling', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AutoScalingClient: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-ec2', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  EC2Client: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-wafv2', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  WAFV2Client: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-efs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  EFSClient: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-bedrock-agentcore-control', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BedrockAgentCoreControlClient: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-servicediscovery', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ServiceDiscoveryClient: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-lambda-microvms', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  LambdaMicrovmsClient: h.fakeClientClass(),
}));
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  SecretsManagerClient: h.fakeClientClass(),
}));

import type { ResourceProvider } from '../../../src/types/resource.js';
import { AwsClients, getAwsClients, setAwsClients } from '../../../src/utils/aws-clients.js';
import { runInStackAwsScope } from '../../../src/utils/stack-aws-scope.js';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  hasReplayMayCollide,
  isNameCollisionErrorFrom,
  isReplayedNameCollisionFrom,
} from '../../../src/deployment/retryable-errors.js';
import {
  isAuxiliaryMarkOf,
  RETRY_AUXILIARY_OWNER,
} from '../../../src/provisioning/auxiliary-failure.js';
import { CloudFrontOACProvider } from '../../../src/provisioning/providers/cloudfront-oac-provider.js';
import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { CodeBuildProvider } from '../../../src/provisioning/providers/codebuild-provider.js';
import { BudgetsBudgetProvider } from '../../../src/provisioning/providers/budgets-budget-provider.js';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { WAFv2WebACLProvider } from '../../../src/provisioning/providers/wafv2-provider.js';
import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { AgentCoreRuntimeProvider } from '../../../src/provisioning/providers/agentcore-runtime-provider.js';
import { AgentCoreEvaluatorProvider } from '../../../src/provisioning/providers/agentcore-evaluator-provider.js';
import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';
import { LambdaMicrovmImageProvider } from '../../../src/provisioning/providers/lambda-microvm-image-provider.js';
import { SecretsManagerSecretProvider } from '../../../src/provisioning/providers/secretsmanager-secret-provider.js';

const { sentVia, baseStrategy } = h;

/** The shape `isTransientServerError` / `isAmbiguousOutcomeError` classify (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('Internal failure'), {
    name: 'InternalFailure',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

const awsError = (name: string, message: string, status = 400): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
  });

/** Advance the fake clock on every backoff. */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

/**
 * A fake AWS. The create under test COLLIDES on a key it already made; `made`
 * counts RESOURCES, not calls. Every other command answers `canned` or `{}`.
 */
class FakeAws {
  readonly made = new Set<string>();
  readonly calls: string[] = [];
  /** The create does its work, THEN throws this (a lost response). */
  loseNextResponse: Error | undefined;

  constructor(private readonly site: CreateSite) {}

  send = async (command: Command): Promise<unknown> => {
    const name = command.constructor.name;
    this.calls.push(name);
    if (name !== this.site.command) return this.site.canned?.[name] ?? {};
    const key = this.site.keyOf(command.input);
    if (this.made.has(key)) throw this.site.collision(key);
    this.made.add(key);
    const error = this.loseNextResponse;
    if (error) {
      this.loseNextResponse = undefined;
      throw error;
    }
    return this.site.created;
  };
}

interface CreateSite {
  type: string;
  /** The SDK command class name of the create under test. */
  command: string;
  props: Record<string, unknown>;
  provider: () => ResourceProvider;
  /** The key AWS collides on (a name; for a mount target, the file system's AZ slot). */
  keyOf: (input: Record<string, unknown>) => string;
  /** The key `props` makes the create send. */
  key: string;
  /** AWS's refusal of a held key. */
  collision: (key: string) => Error;
  /** AWS's collision text says "already exists", so the prose classifier reads it. */
  prose: boolean;
  /** The create's successful response. */
  created: unknown;
  /** Answers to the non-create commands a site's flow needs. */
  canned?: Record<string, unknown>;
  /** A call the provider sends through its OTHER client(s). */
  other: (provider: ResourceProvider) => Promise<unknown>;
  /** The shared client comes from `getAwsClients()` rather than the provider's own. */
  sharedFromAwsClients: boolean;
  /** The provider field holding that shared `getAwsClients()` client. */
  sharedField?: string;
}

const read =
  (physicalId: string, type: string, props: Record<string, unknown>) =>
  (provider: ResourceProvider): Promise<unknown> =>
    provider.readCurrentState!(physicalId, 'Res', type, props);

const OAC_PROPS = {
  OriginAccessControlConfig: {
    Name: 'app-oac',
    OriginAccessControlOriginType: 's3',
    SigningBehavior: 'always',
    SigningProtocol: 'sigv4',
  },
};
const SSM_PROPS = { Name: '/app/param', Type: 'String', Value: 'plain-value' };
const CODEBUILD_PROPS = {
  Name: 'app-project',
  Source: { Type: 'NO_SOURCE', BuildSpec: 'version: 0.2' },
  Artifacts: { Type: 'NO_ARTIFACTS' },
  Environment: {
    Type: 'LINUX_CONTAINER',
    ComputeType: 'BUILD_GENERAL1_SMALL',
    Image: 'aws/codebuild/standard:7.0',
  },
  ServiceRole: 'arn:aws:iam::123456789012:role/build',
};
const BUDGET_PROPS = {
  Budget: {
    BudgetName: 'app-budget',
    BudgetType: 'COST',
    TimeUnit: 'MONTHLY',
    BudgetLimit: { Amount: 10, Unit: 'USD' },
  },
};
const ASG_PROPS = {
  AutoScalingGroupName: 'app-asg',
  MinSize: '0',
  MaxSize: '1',
  LaunchTemplate: { LaunchTemplateId: 'lt-0123456789abcdef0', Version: '1' },
  VPCZoneIdentifier: ['subnet-1'],
};
const WAF_PROPS = {
  Name: 'app-acl',
  Scope: 'REGIONAL',
  DefaultAction: { Allow: {} },
  VisibilityConfig: {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: 'app-acl',
  },
};
const MOUNT_TARGET_PROPS = { FileSystemId: 'fs-0123456789abcdef0', SubnetId: 'subnet-1' };

const SITES: CreateSite[] = [
  {
    type: 'AWS::CloudFront::OriginAccessControl',
    command: 'CreateOriginAccessControlCommand',
    props: OAC_PROPS,
    provider: () => new CloudFrontOACProvider(),
    keyOf: (input) => (input['OriginAccessControlConfig'] as { Name: string }).Name,
    key: 'app-oac',
    collision: () =>
      awsError(
        'OriginAccessControlAlreadyExists',
        'An origin access control with the same name already exists.',
        409
      ),
    prose: true,
    created: { OriginAccessControl: { Id: 'E2OAC' } },
    other: read('E2OAC', 'AWS::CloudFront::OriginAccessControl', OAC_PROPS),
    sharedFromAwsClients: true,
    sharedField: 'cloudFrontClient',
  },
  {
    type: 'AWS::SSM::Parameter',
    command: 'PutParameterCommand',
    props: SSM_PROPS,
    provider: () => new SSMParameterProvider(),
    keyOf: (input) => input['Name'] as string,
    key: '/app/param',
    collision: () =>
      awsError(
        'ParameterAlreadyExists',
        'The parameter already exists. To overwrite this value, set the overwrite option in the request to true.'
      ),
    prose: true,
    created: { Version: 1 },
    other: read('/app/param', 'AWS::SSM::Parameter', SSM_PROPS),
    sharedFromAwsClients: true,
    sharedField: 'ssmClient',
  },
  {
    type: 'AWS::CodeBuild::Project',
    command: 'CreateProjectCommand',
    props: CODEBUILD_PROPS,
    provider: () => new CodeBuildProvider(),
    keyOf: (input) => input['name'] as string,
    key: 'app-project',
    collision: (key) =>
      awsError(
        'ResourceAlreadyExistsException',
        `Project already exists: arn:aws:codebuild:us-east-1:123456789012:project/${key}`
      ),
    prose: true,
    created: { project: { name: 'app-project', arn: 'arn:aws:codebuild:::project/app-project' } },
    other: read('app-project', 'AWS::CodeBuild::Project', CODEBUILD_PROPS),
    sharedFromAwsClients: false,
  },
  {
    type: 'AWS::Budgets::Budget',
    command: 'CreateBudgetCommand',
    props: BUDGET_PROPS,
    provider: () => new BudgetsBudgetProvider(),
    keyOf: (input) => (input['Budget'] as { BudgetName: string }).BudgetName,
    key: 'app-budget',
    collision: (key) =>
      awsError(
        'DuplicateRecordException',
        `Error creating budget: ${key} - the budget already exists.`
      ),
    prose: true,
    created: {},
    canned: { GetCallerIdentityCommand: { Account: '123456789012' } },
    // Budgets has no `readCurrentState`.
    other: (provider) => provider.delete('Res', 'app-budget', 'AWS::Budgets::Budget', BUDGET_PROPS),
    sharedFromAwsClients: false,
  },
  {
    type: 'AWS::AutoScaling::AutoScalingGroup',
    command: 'CreateAutoScalingGroupCommand',
    props: ASG_PROPS,
    provider: () => new ASGProvider(),
    keyOf: (input) => input['AutoScalingGroupName'] as string,
    key: 'app-asg',
    collision: (key) =>
      awsError(
        'AlreadyExists',
        `AutoScalingGroup by this name already exists - A group with the name ${key} already exists`
      ),
    prose: true,
    created: {},
    other: read('app-asg', 'AWS::AutoScaling::AutoScalingGroup', ASG_PROPS),
    sharedFromAwsClients: false,
  },
  {
    type: 'AWS::WAFv2::WebACL',
    command: 'CreateWebACLCommand',
    props: WAF_PROPS,
    provider: () => new WAFv2WebACLProvider(),
    keyOf: (input) => `${input['Name'] as string}|${input['Scope'] as string}`,
    key: 'app-acl|REGIONAL',
    collision: () =>
      awsError(
        'WAFDuplicateItemException',
        'AWS WAF couldn’t perform the operation because some resource in your request is a duplicate of an existing one.'
      ),
    prose: false,
    created: {
      Summary: {
        Id: 'acl-id',
        Name: 'app-acl',
        ARN: 'arn:aws:wafv2:eu-west-3:123456789012:regional/webacl/app-acl/acl-id',
        LockToken: 'lock',
      },
    },
    other: read(
      'arn:aws:wafv2:eu-west-3:123456789012:regional/webacl/app-acl/acl-id',
      'AWS::WAFv2::WebACL',
      WAF_PROPS
    ),
    sharedFromAwsClients: false,
  },
  {
    type: 'AWS::EFS::MountTarget',
    command: 'CreateMountTargetCommand',
    props: MOUNT_TARGET_PROPS,
    provider: () => new EFSProvider(),
    // One mount target per file system per Availability Zone; one subnet, one AZ here.
    keyOf: (input) => `${input['FileSystemId'] as string}/${input['SubnetId'] as string}`,
    key: 'fs-0123456789abcdef0/subnet-1',
    collision: () => awsError('MountTargetConflict', 'mount target already exists in this AZ', 409),
    prose: true,
    created: { MountTargetId: 'fsmt-1', LifeCycleState: 'creating' },
    other: read('fsmt-1', 'AWS::EFS::MountTarget', MOUNT_TARGET_PROPS),
    sharedFromAwsClients: false,
  },
];

/** The stack region the suite stubs, distinct from every client default. */
const STACK_REGION = 'eu-west-3';
/** The region the `AwsClients`-built shared clients are pinned to, distinct from the stack's. */
const SHARED_REGION = 'ap-southeast-2';
/** A stack scope's region, distinct from both. */
const SCOPE_REGION = 'sa-east-1';

/** The configs every send of `command` went through; at least one. */
function configsOf(command: string): StandInConfig[] {
  const configs = sentVia.filter(([n]) => n === command).map(([, c]) => c);
  expect(configs.length).toBeGreaterThan(0);
  return configs;
}

describe.each(SITES)('$type create retry safety (issue #4639)', (site) => {
  let provider: ResourceProvider;
  let aws: FakeAws;
  let previous: AwsClients;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    // Read by `ambientRegion()` when the provider is built below, and by a
    // stand-in built with no region.
    vi.stubEnv('AWS_REGION', STACK_REGION);
    previous = getAwsClients();
    setAwsClients(new AwsClients({ region: SHARED_REGION }));
    aws = new FakeAws(site);
    h.state.service = aws.send;
    sentVia.length = 0;
    provider = site.provider();
  });

  afterEach(() => {
    setAwsClients(previous);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const createWithRetry = () =>
    withRetry(() => provider.create('Res', site.type, site.props), 'Res', {
      sleep: advancingSleep,
    });

  it('a lost create response surfaces the replay collision as one THIS create may have made', async () => {
    aws.loseNextResponse = transient500();

    const error = await createWithRetry().catch((e: unknown) => e);

    // One resource, never two: the key collides rather than duplicating.
    expect([...aws.made]).toEqual([site.key]);
    // The 5xx left the SDK unreplayed and reached the engine's retry, which
    // sent the create again in a SECOND send.
    expect(sentVia.filter(([n]) => n === site.command)).toHaveLength(2);
    expect(aws.calls.filter((c) => c === site.command)).toHaveLength(2);
    // The engine stamped the collision as possibly this create's own, the
    // verdict no delete-first path may act on. Nothing is adopted: the
    // collision is the error.
    expect(hasReplayMayCollide(error)).toBe(true);
    expect(isNameCollisionErrorFrom(error, 'Res')).toBe(false);
    if (site.prose) {
      expect(
        isReplayedNameCollisionFrom(error, 'Res', (link) =>
          isAuxiliaryMarkOf(link, RETRY_AUXILIARY_OWNER)
        )
      ).toBe(true);
    }
  });

  it('a key that already existed before any ambiguous attempt is not stamped as replayed', async () => {
    aws.made.add(site.key);

    const error = await createWithRetry().catch((e: unknown) => e);

    expect(aws.calls.filter((c) => c === site.command)).toHaveLength(1);
    expect(hasReplayMayCollide(error)).toBe(false);
    if (site.prose) expect(isNameCollisionErrorFrom(error, 'Res')).toBe(true);
  });

  it('sends the create through a client that refuses the SDK retry of a 5xx, and nothing else', async () => {
    aws.made.add(site.key);
    // Inside a stack scope of ANOTHER region than the one the provider was
    // built in: a client that takes its region from the scope instead of the
    // provider's pinned one lands elsewhere.
    await runInStackAwsScope({ region: SCOPE_REGION, clients: getAwsClients() }, async () => {
      await provider.create('Res', site.type, site.props).catch(() => undefined);
      await site.other(provider).catch(() => undefined);
    });

    for (const config of configsOf(site.command)) {
      const strategy = (await config.retryStrategy()) as typeof baseStrategy;
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
      ).rejects.toThrow();
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
      ).resolves.toBe('retry-token');
    }
    const others = sentVia.filter(([n]) => n !== site.command);
    expect(others.length).toBeGreaterThan(0);
    for (const [, config] of others) expect(await config.retryStrategy()).toBe(baseStrategy);
    // The create lands in the region of the calls around it: the shared
    // client's when it comes from `AwsClients`, else the stack's.
    const region = site.sharedFromAwsClients ? SHARED_REGION : STACK_REGION;
    for (const [name, config] of sentVia) {
      if (name === 'GetCallerIdentityCommand') continue;
      expect(await config.region()).toBe(region);
    }
  });

  it('builds the create client with the identity of the client every other call uses', async () => {
    setAwsClients(new AwsClients({ profile: 'first-profile', region: SHARED_REGION }));
    // A provider holding a shared `AwsClients` client binds it at
    // construction; one building its own binds at its first call.
    provider = site.provider();
    await site.other(provider).catch(() => undefined);
    // A switch between the provider's first call and its create.
    setAwsClients(new AwsClients({ profile: 'second-profile', region: SHARED_REGION }));
    aws.made.add(site.key);
    await provider.create('Res', site.type, site.props).catch(() => undefined);

    expect(configsOf(site.command).length).toBeGreaterThan(0);
    const providerSends = sentVia.filter(([n]) => n !== 'GetCallerIdentityCommand');
    expect(providerSends.length).toBeGreaterThan(configsOf(site.command).length);
    for (const [, config] of providerSends) expect(config.profile).toBe('first-profile');
  });

  it.runIf(site.sharedFromAwsClients)(
    'two creates on a cold provider build ONE create client, and a rejected region read is retried',
    async () => {
      aws.made.add(site.key);
      await Promise.all([
        provider.create('A', site.type, site.props).catch(() => undefined),
        provider.create('B', site.type, site.props).catch(() => undefined),
      ]);
      const configs = new Set(configsOf(site.command));
      expect(configs.size).toBe(1);

      // A fresh provider whose shared client's first region read fails.
      sentVia.length = 0;
      const fresh = site.provider();
      const shared = (fresh as unknown as Record<string, { config: StandInConfig }>)[
        site.sharedField!
      ]!;
      const realRegion = shared.config.region;
      let reads = 0;
      shared.config.region = () => {
        reads++;
        return reads === 1 ? Promise.reject(new Error('Region is missing')) : realRegion();
      };
      const first = await fresh.create('Res', site.type, site.props).catch((e: unknown) => e);
      expect(String(first)).toContain('Region is missing');
      await fresh.create('Res', site.type, site.props).catch(() => undefined);
      expect(reads).toBe(2);
      for (const config of configsOf(site.command)) {
        expect(await config.retryStrategy()).not.toBe(baseStrategy);
      }
    }
  );
});

/**
 * The calls that must KEEP the SDK's full retry: an overwriting SSM
 * `PutParameter` is idempotent, and EFS's `CreateFileSystem` /
 * `CreateAccessPoint` carry cdkd-set tokens the service answers a replay
 * with. Routing either through the create client would trade a replay that
 * is absorbed for a failed call.
 */
describe('calls that stay on the full-retry shared client (issue #4639)', () => {
  let previous: AwsClients;

  beforeEach(() => {
    vi.stubEnv('AWS_REGION', STACK_REGION);
    previous = getAwsClients();
    setAwsClients(new AwsClients({ region: SHARED_REGION }));
    sentVia.length = 0;
  });

  afterEach(() => {
    setAwsClients(previous);
    vi.unstubAllEnvs();
  });

  it("SSM update's overwriting PutParameter keeps the SDK retry of a 5xx", async () => {
    h.state.service = async () => ({});
    const provider = new SSMParameterProvider();

    await provider
      .update('Res', '/app/param', 'AWS::SSM::Parameter', { ...SSM_PROPS, Value: 'v2' }, SSM_PROPS)
      .catch(() => undefined);

    const puts = sentVia.filter(([n]) => n === 'PutParameterCommand');
    expect(puts.length).toBeGreaterThan(0);
    for (const [, config, input] of puts) {
      expect(input['Overwrite']).toBe(true);
      expect(await config.retryStrategy()).toBe(baseStrategy);
    }
  });

  it.each([
    [
      'CreateAccessPointCommand',
      'AWS::EFS::AccessPoint',
      { FileSystemId: 'fs-0123456789abcdef0' },
      { AccessPointId: 'fsap-1', LifeCycleState: 'available' },
    ],
    [
      'CreateFileSystemCommand',
      'AWS::EFS::FileSystem',
      {},
      { FileSystemId: 'fs-1', LifeCycleState: 'available' },
    ],
  ] as const)(
    'EFS %s keeps the SDK retry of a 5xx',
    async (command, type, props, response) => {
      // The file system's token is stack-scoped; this case runs outside a stack.
      const prior = allowUnscopedCreateTokensForTests(true);
      onTestFinished(() => {
        allowUnscopedCreateTokensForTests(prior);
      });
      h.state.service = async (cmd) => (cmd.constructor.name === command ? response : {});
      const provider = new EFSProvider();

      await provider.create('Res', type, { ...props }).catch(() => undefined);

      const sends = sentVia.filter(([n]) => n === command);
      expect(sends.length).toBeGreaterThan(0);
      for (const [, config] of sends) expect(await config.retryStrategy()).toBe(baseStrategy);
    }
  );

  // The creates #4639 left on the full retry ON PURPOSE: each carries an
  // SDK-filled idempotency token that its in-send replay repeats
  // (`token-filled-create-retry-4639.test.ts`). Wrapping one would turn a
  // replay the service absorbs into a failed deploy.
  it.each([
    [
      'CreateAgentRuntimeCommand',
      'AWS::BedrockAgentCore::Runtime',
      () => new AgentCoreRuntimeProvider(),
      {
        AgentRuntimeName: 'rt',
        AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: 'uri' } },
        RoleArn: 'arn:aws:iam::123456789012:role/r',
        NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      },
    ],
    [
      'CreateEvaluatorCommand',
      'AWS::BedrockAgentCore::Evaluator',
      () => new AgentCoreEvaluatorProvider(),
      {
        EvaluatorName: 'ev',
        Level: 'TRACE',
        EvaluatorConfig: {
          LlmAsAJudge: {
            Instructions: 'i',
            RatingScale: { Numerical: [{ Value: 1, Label: 'l', Definition: 'd' }] },
            ModelConfig: { BedrockEvaluatorModelConfig: { ModelId: 'm' } },
          },
        },
      },
    ],
    [
      'CreateHttpNamespaceCommand',
      'AWS::ServiceDiscovery::HttpNamespace',
      () => new ServiceDiscoveryProvider(),
      { Name: 'ns' },
    ],
    [
      'CreatePrivateDnsNamespaceCommand',
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      () => new ServiceDiscoveryProvider(),
      { Name: 'ns.local', Vpc: 'vpc-1' },
    ],
    [
      'CreatePublicDnsNamespaceCommand',
      'AWS::ServiceDiscovery::PublicDnsNamespace',
      () => new ServiceDiscoveryProvider(),
      { Name: 'example.com' },
    ],
    [
      'CreateServiceCommand',
      'AWS::ServiceDiscovery::Service',
      () => new ServiceDiscoveryProvider(),
      { Name: 'svc', NamespaceId: 'ns-1' },
    ],
    [
      'CreateMicrovmImageCommand',
      'AWS::Lambda::MicrovmImage',
      () => new LambdaMicrovmImageProvider(),
      {
        Name: 'img',
        BaseImageArn: 'arn:aws:lambda:eu-west-3:123456789012:microvm-image:base',
        BuildRoleArn: 'arn:aws:iam::123456789012:role/b',
        CodeArtifact: { Uri: 's3://bucket/key.zip' },
      },
    ],
    [
      'CreateSecretCommand',
      'AWS::SecretsManager::Secret',
      () => new SecretsManagerSecretProvider(),
      { Name: 'app-secret', SecretString: 'not-a-real-secret' },
    ],
  ] as const)('%s keeps the SDK retry of a 5xx', async (command, type, makeProvider, props) => {
    h.state.service = async () => ({});
    const provider = makeProvider() as ResourceProvider;

    await provider.create('Res', type, { ...props } as Record<string, unknown>).catch(() => undefined);

    const sends = sentVia.filter(([n]) => n === command);
    expect(sends.length).toBeGreaterThan(0);
    for (const [, config] of sends) expect(await config.retryStrategy()).toBe(baseStrategy);
  });
});

/**
 * The create / update failure wraps quote AWS's text through the operation's
 * masker: with a 5xx now surfacing instead of being replayed, these paths run
 * more often, and AWS's text can quote a resolved secret-derived value.
 */
describe('create failure text goes through the masker (issue #4639)', () => {
  const SECRET = 'S3CR3T-VALUE';
  const maskSecrets = (text: string): string => text.split(SECRET).join('***');
  let previous: AwsClients;

  beforeEach(() => {
    vi.stubEnv('AWS_REGION', STACK_REGION);
    previous = getAwsClients();
    setAwsClients(new AwsClients({ region: SHARED_REGION }));
    sentVia.length = 0;
  });

  afterEach(() => {
    setAwsClients(previous);
    vi.unstubAllEnvs();
  });

  const refusing = (command: string) => async (cmd: Command) => {
    if (cmd.constructor.name === 'GetCallerIdentityCommand') return { Account: '123456789012' };
    if (cmd.constructor.name === command) {
      throw awsError('ValidationError', `value ${SECRET} is not valid`);
    }
    return {};
  };

  it.each([
    ['CreateBudgetCommand', 'AWS::Budgets::Budget', () => new BudgetsBudgetProvider(), BUDGET_PROPS],
    [
      'CreateAutoScalingGroupCommand',
      'AWS::AutoScaling::AutoScalingGroup',
      () => new ASGProvider(),
      ASG_PROPS,
    ],
  ] as const)('%s', async (command, type, makeProvider, props) => {
    h.state.service = refusing(command);

    const error = await makeProvider()
      .create('Res', type, { ...props } as Record<string, unknown>, { maskSecrets })
      .catch((e: unknown) => e);

    expect(sentVia.some(([n]) => n === command)).toBe(true);
    expect((error as Error).message).toContain('***');
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('UpdateBudgetCommand', async () => {
    h.state.service = refusing('UpdateBudgetCommand');

    const error = await new BudgetsBudgetProvider()
      .update(
        'Res',
        'app-budget',
        'AWS::Budgets::Budget',
        { Budget: { ...BUDGET_PROPS.Budget, BudgetLimit: { Amount: 20, Unit: 'USD' } } },
        BUDGET_PROPS,
        { maskSecrets }
      )
      .catch((e: unknown) => e);

    expect(sentVia.some(([n]) => n === 'UpdateBudgetCommand')).toBe(true);
    expect((error as Error).message).toContain('***');
    expect((error as Error).message).not.toContain(SECRET);
  });
});
