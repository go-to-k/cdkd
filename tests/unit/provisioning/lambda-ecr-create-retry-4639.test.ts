/**
 * Issue #4639 (the Lambda / EventBridge bus / ECR slice): `CreateFunction`,
 * `CreateFunctionUrlConfig`, `AddPermission`, `CreateEventBus` and
 * `CreateRepository` carry no idempotency token and are each unique by name.
 * They used to go through a client whose SDK retry replays a 5xx inside one
 * `send` -- invisibly. They now go through a dedicated client that refuses the
 * SDK's 5xx retry, so the 5xx reaches the deploy engine.
 *
 * The fake sits BELOW the SDK's retry, so the outcome cases hold with or
 * without the client change; what the change itself turns red is the
 * create-client block, which reads WHICH client config sent each call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

interface FakeClientConfig {
  region: () => Promise<unknown>;
  retryStrategy?: () => Promise<unknown>;
}

const { mockSend, sentVia, ctorOptions, baseStrategy, shared } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  /** `[command name, the sending client's config]` per send. */
  sentVia: [] as Array<[string, FakeClientConfig]>,
  /** `[service, options]` of every SDK client the code under test constructed. */
  ctorOptions: [] as Array<[string, Record<string, unknown>]>,
  /** A stand-in for the SDK's resolved V2 retry strategy. */
  baseStrategy: {
    acquireInitialRetryToken: async (_scope: string) => 'token',
    refreshRetryTokenForRetry: async (_token: unknown, _info: { error?: unknown }) =>
      'retry-token',
    recordSuccess: (_token: unknown) => undefined,
  },
  /** The shared clients `getAwsClients()` returns; built in `beforeEach`. */
  shared: { lambda: undefined as unknown, eventBridge: undefined as unknown, region: vi.fn() },
}));

/**
 * A REAL class per service, so a provider's `instanceof` sees the shared
 * client as production-shaped and builds its dedicated create client.
 */
function fakeClientClass(service: string) {
  return class FakeClient {
    readonly config: FakeClientConfig;
    constructor(options: Record<string, unknown>) {
      ctorOptions.push([service, options]);
      this.config = {
        region: () => Promise.resolve(options['region']),
        retryStrategy: async (): Promise<unknown> => baseStrategy,
      };
    }
    send(command: { constructor: { name: string } }): Promise<unknown> {
      sentVia.push([command.constructor.name, this.config]);
      return mockSend(command) as Promise<unknown>;
    }
    destroy(): void {}
  };
}

vi.mock('@aws-sdk/client-lambda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-lambda')>();
  return { ...actual, LambdaClient: fakeClientClass('lambda') };
});
vi.mock('@aws-sdk/client-eventbridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-eventbridge')>();
  return { ...actual, EventBridgeClient: fakeClientClass('eventbridge') };
});
vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecr')>();
  return { ...actual, ECRClient: fakeClientClass('ecr') };
});

vi.mock('../../../src/utils/ambient-client-defaults.js', () => ({
  /**
   * A sentinel, so a create client is shown to carry the ambient identity. Its
   * `region` stands for a stack scope's, which must NOT win over the shared
   * client's for the providers that read it.
   */
  ambientClientDefaults: () => ({
    credentials: { accessKeyId: 'AKIDAMBIENT' },
    region: 'us-west-2',
  }),
}));

vi.mock('../../../src/utils/stack-aws-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/stack-aws-scope.js')>()),
  /** ECR's own region source (`providerRegion`); distinct from every other region here. */
  ambientRegion: () => 'eu-central-1',
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: shared.lambda,
    eventBridge: shared.eventBridge,
    ec2: { send: vi.fn() },
  }),
}));

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

import { LambdaClient, ResourceConflictException } from '@aws-sdk/client-lambda';
import { EventBridgeClient, ResourceAlreadyExistsException } from '@aws-sdk/client-eventbridge';
import { RepositoryAlreadyExistsException } from '@aws-sdk/client-ecr';
import type { ResourceProvider } from '../../../src/types/resource.js';
import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import { LambdaUrlProvider } from '../../../src/provisioning/providers/lambda-url-provider.js';
import { LambdaPermissionProvider } from '../../../src/provisioning/providers/lambda-permission-provider.js';
import { EventBridgeBusProvider } from '../../../src/provisioning/providers/eventbridge-bus-provider.js';
import { ECRProvider } from '../../../src/provisioning/providers/ecr-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  hasReplayMayCollide,
  isNameCollisionErrorFrom,
} from '../../../src/deployment/retryable-errors.js';

const transient500 = (): Error =>
  Object.assign(new Error('We encountered an internal error. Please try again.'), {
    name: 'ServiceException',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'TooManyRequestsException',
    $fault: 'client',
    $metadata: { httpStatusCode: 429 },
  });

/** Advance the fake clock on every backoff. */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

const META = { $metadata: { httpStatusCode: 409 } };

/** Per create command: the key it is unique by, and the refusal of a held key. */
const NAME_UNIQUE: Record<string, { key: (i: Record<string, unknown>) => string; held: () => Error }> =
  {
    CreateFunctionCommand: {
      key: (i) => String(i['FunctionName']),
      held: () => new ResourceConflictException({ message: 'Function already exist', ...META }),
    },
    CreateFunctionUrlConfigCommand: {
      key: (i) => `${String(i['FunctionName'])}:${String(i['Qualifier'] ?? '')}`,
      held: () =>
        new ResourceConflictException({ message: 'FunctionUrlConfig exists', ...META }),
    },
    AddPermissionCommand: {
      key: (i) => `${String(i['FunctionName'])}:${String(i['StatementId'])}`,
      held: () =>
        new ResourceConflictException({
          message: 'The statement id provided already exists.',
          ...META,
        }),
    },
    CreateEventBusCommand: {
      key: (i) => String(i['Name']),
      held: () =>
        new ResourceAlreadyExistsException({ message: 'Event bus already exists.', ...META }),
    },
    CreateRepositoryCommand: {
      key: (i) => String(i['repositoryName']),
      held: () =>
        new RepositoryAlreadyExistsException({
          message: 'The repository already exists in the registry',
          ...META,
        }),
    },
  };

/** A fake Lambda / EventBridge / ECR. `held` counts RESOURCES, not calls. */
class FakeAws {
  /** Create command name -> the keys it holds. */
  readonly held = new Map<string, Set<string>>();
  readonly calls: string[] = [];
  /** The named call does its work, THEN throws this (a lost response). */
  readonly loseNextResponse = new Map<string, Error>();

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const unique = NAME_UNIQUE[name];
    if (unique) {
      const key = unique.key(command.input);
      const held = this.held.get(name) ?? new Set<string>();
      this.held.set(name, held);
      if (held.has(key)) throw unique.held();
      held.add(key);
      const lost = this.loseNextResponse.get(name);
      if (lost) {
        this.loseNextResponse.delete(name);
        throw lost;
      }
    }
    return {
      FunctionName: 'app-fn',
      FunctionArn: 'arn:aws:lambda:ap-southeast-2:123456789012:function:app-fn',
      FunctionUrl: 'https://abc.lambda-url.ap-southeast-2.on.aws/',
      State: 'Active',
      LastUpdateStatus: 'Successful',
      Configuration: { State: 'Active', LastUpdateStatus: 'Successful' },
      EventBusArn: 'arn:aws:events:ap-southeast-2:123456789012:event-bus/app-bus',
      repository: {
        repositoryName: 'app-repo',
        repositoryArn: 'arn:aws:ecr:ap-southeast-2:123456789012:repository/app-repo',
        repositoryUri: '123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/app-repo',
      },
    };
  };
}

const FN_ARN = 'arn:aws:lambda:ap-southeast-2:123456789012:function:app-fn';

/** `[command, resource type, provider, props, the service whose shared region it must take]` */
const CASES = [
  [
    'CreateFunctionCommand',
    'AWS::Lambda::Function',
    () => new LambdaFunctionProvider(),
    {
      FunctionName: 'app-fn',
      Role: 'arn:aws:iam::123456789012:role/r',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Code: { S3Bucket: 'bucket', S3Key: 'key.zip' },
    },
    'lambda',
  ],
  [
    'CreateFunctionUrlConfigCommand',
    'AWS::Lambda::Url',
    () => new LambdaUrlProvider(),
    { TargetFunctionArn: FN_ARN, AuthType: 'NONE' },
    'lambda',
  ],
  [
    'AddPermissionCommand',
    'AWS::Lambda::Permission',
    () => new LambdaPermissionProvider(),
    { FunctionName: FN_ARN, Action: 'lambda:InvokeFunction', Principal: 's3.amazonaws.com' },
    'lambda',
  ],
  [
    'CreateEventBusCommand',
    'AWS::Events::EventBus',
    () => new EventBridgeBusProvider(),
    { Name: 'app-bus' },
    'eventbridge',
  ],
  [
    'CreateRepositoryCommand',
    'AWS::ECR::Repository',
    () => new ECRProvider(),
    // A lifecycle policy, so a non-create ECR call is sent and checked too.
    { RepositoryName: 'app-repo', LifecyclePolicy: { LifecyclePolicyText: '{"rules":[]}' } },
    'ecr',
  ],
] as const satisfies ReadonlyArray<
  readonly [string, string, () => ResourceProvider, Record<string, unknown>, string]
>;

const refusesServerErrorRetry = async (config: FakeClientConfig): Promise<void> => {
  const strategy = (await config.retryStrategy!()) as typeof baseStrategy;
  await expect(
    strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
  ).rejects.toThrow();
  await expect(
    strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
  ).resolves.toBe('retry-token');
};

describe('Lambda / EventBridge bus / ECR tokenless create retry safety (issue #4639)', () => {
  let aws: FakeAws;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    aws = new FakeAws();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    sentVia.length = 0;
    shared.region.mockReset();
    // Not the ambient sentinel's region, so a create client built from the
    // ambient region instead of the shared client's is told apart.
    shared.region.mockResolvedValue('ap-southeast-2');
    for (const [key, Ctor] of [
      ['lambda', LambdaClient],
      ['eventBridge', EventBridgeClient],
    ] as const) {
      const client = new (Ctor as unknown as new (o: object) => { config: FakeClientConfig })({});
      client.config.region = () => shared.region() as Promise<unknown>;
      shared[key] = client;
    }
    ctorOptions.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the create client', () => {
    it.each(CASES)(
      'sends %s through a client that refuses the SDK retry of a 5xx, and nothing else',
      async (command, type, makeProvider, props, service) => {
        await makeProvider().create('Res', type, { ...props });

        const sent = sentVia.find(([name]) => name === command);
        expect(sent).toBeDefined();
        await refusesServerErrorRetry(sent![1]);
        // Every other call keeps its full SDK retry.
        for (const [, config] of sentVia.filter(([name]) => name !== command)) {
          expect(await config.retryStrategy!()).toBe(baseStrategy);
        }
        // ONE create client, carrying the ambient identity.
        const built = ctorOptions.filter(([s]) => s === service);
        if (service === 'ecr') {
          // ECR builds its own clients: the main one and a SEPARATE create
          // client, both with the provider's own options (the ambient defaults).
          expect(built).toHaveLength(2);
          for (const [, options] of built) {
            // The provider's own region (`ambientRegion()`), on BOTH clients:
            // never the ambient defaults' region, never left unset.
            expect(options).toMatchObject({
              region: 'eu-central-1',
              credentials: { accessKeyId: 'AKIDAMBIENT' },
            });
          }
          expect(sentVia.some(([name]) => name === 'PutLifecyclePolicyCommand')).toBe(true);
        } else {
          expect(built).toHaveLength(1);
          // The shared client's region, never the ambient (scope) one.
          expect(built[0]![1]).toMatchObject({
            region: 'ap-southeast-2',
            credentials: { accessKeyId: 'AKIDAMBIENT' },
          });
        }
      }
    );

    it('two Lambda creates on a cold provider build ONE create client', async () => {
      const provider = new LambdaPermissionProvider();

      await Promise.all([
        provider.create('A', 'AWS::Lambda::Permission', { ...CASES[2][3] }),
        provider.create('B', 'AWS::Lambda::Permission', { ...CASES[2][3] }),
      ]);

      expect(ctorOptions.filter(([s]) => s === 'lambda')).toHaveLength(1);
    });

    it.each([
      ['LambdaUrlProvider', 1],
      ['EventBridgeBusProvider', 3],
    ] as const)(
      '%s: a rejected region read is not cached, so the next create builds the client',
      async (_name, index) => {
        const [, type, makeProvider, props] = CASES[index];
        const provider = makeProvider();
        shared.region.mockRejectedValueOnce(new Error('Region is missing'));

        await expect(provider.create('Res', type, { ...props })).rejects.toThrow();
        await provider.create('Res', type, { ...props });

        expect(ctorOptions).toHaveLength(1);
      }
    );
  });

  it.each(CASES)(
    "a lost %s response: the replay's collision is marked as possibly this create's own, never credited",
    async (command, type, makeProvider, props) => {
      aws.loseNextResponse.set(command, transient500());
      const provider = makeProvider();

      const error = await withRetry(() => provider.create('Res', type, { ...props }), 'Res', {
        sleep: advancingSleep,
      }).then(
        () => undefined,
        (e: unknown) => e
      );

      expect(error).toBeDefined();
      // One resource, never two: the name collides rather than duplicating.
      expect(aws.held.get(command)?.size).toBe(1);
      expect(aws.calls.filter((c) => c === command)).toHaveLength(2);
      expect(hasReplayMayCollide(error)).toBe(true);
      expect(isNameCollisionErrorFrom(error, 'Res')).toBe(false);
      expect(aws.calls.some((c) => c.startsWith('Delete') || c.startsWith('Remove'))).toBe(false);
    }
  );
});
