/**
 * Issue #4639 (the IAM slice): `CreateRole`, `CreateUser`, `CreateGroup`,
 * `CreateInstanceProfile`, `CreatePolicy` and `CreateAccessKey` carry no
 * idempotency token, and used to go through the shared IAM client, whose SDK
 * retry replays a 5xx inside one `send` -- invisibly. They now go through a
 * dedicated client that refuses the SDK's 5xx retry
 * (`iam-create-client.ts`), so the 5xx reaches the provider and the engine.
 *
 * The fake sits BELOW the SDK's retry, so the two outcome cases hold with or
 * without the client change; what the change itself turns red is the
 * create-client block, which reads WHICH client sent each create.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

interface FakeClientConfig {
  region: () => Promise<unknown>;
  retryStrategy?: () => Promise<unknown>;
}

const { mockSend, sentVia, ctorOptions, baseStrategy, shared } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  /** `[command name, which client, that client's config]` per send. */
  sentVia: [] as Array<[string, 'shared' | 'create', FakeClientConfig]>,
  /** The options of every `IAMClient` the code under test constructed. */
  ctorOptions: [] as Array<Record<string, unknown>>,
  /** A stand-in for the SDK's resolved V2 retry strategy. */
  baseStrategy: {
    acquireInitialRetryToken: async (_scope: string) => 'token',
    refreshRetryTokenForRetry: async (_token: unknown, _info: { error?: unknown }) =>
      'retry-token',
    recordSuccess: (_token: unknown) => undefined,
  },
  /** The shared client `getAwsClients().iam` returns; built in `beforeEach`. */
  shared: { client: undefined as unknown, region: vi.fn() },
}));

vi.mock('@aws-sdk/client-iam', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-iam')>();
  /**
   * A REAL class, so the getter's `instanceof IAMClient` sees the shared
   * client as production-shaped and builds its dedicated create client.
   */
  class FakeIAMClient {
    readonly config: FakeClientConfig;
    kind: 'shared' | 'create' = 'create';
    constructor(options: Record<string, unknown>) {
      ctorOptions.push(options);
      this.config = {
        region: () => Promise.resolve(options['region']),
        retryStrategy: async (): Promise<unknown> => baseStrategy,
      };
    }
    send(command: { constructor: { name: string } }): Promise<unknown> {
      sentVia.push([command.constructor.name, this.kind, this.config]);
      return mockSend(command) as Promise<unknown>;
    }
    destroy(): void {}
  }
  return { ...actual, IAMClient: FakeIAMClient };
});

vi.mock('../../../src/utils/ambient-client-defaults.js', () => ({
  /**
   * A sentinel, so the create client is shown to carry the ambient identity.
   * Its `region` stands for a stack scope's, which must NOT win over the
   * shared client's.
   */
  ambientClientDefaults: () => ({
    credentials: { accessKeyId: 'AKIDAMBIENT' },
    region: 'us-west-2',
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ iam: shared.client }),
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

import { EntityAlreadyExistsException, IAMClient } from '@aws-sdk/client-iam';
import type { ResourceProvider } from '../../../src/types/resource.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMAccessKeyProvider } from '../../../src/provisioning/providers/iam-access-key-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  hasReplayMayCollide,
  isNameCollisionErrorFrom,
} from '../../../src/deployment/retryable-errors.js';

/** IAM's 500 shape (`isTransientServerError` / `isAmbiguousOutcomeError`, issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('We encountered an internal error. Please try again.'), {
    name: 'ServiceFailureException',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'Throttling',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });

/** Advance the fake clock on every backoff. */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

/** How the fake answers each name-unique create: IAM refuses a held name. */
const NAME_UNIQUE: Record<
  string,
  { nameKey: string; kind: string; responseKey: string; arnKind: string }
> = {
  CreateRoleCommand: { nameKey: 'RoleName', kind: 'Role', responseKey: 'Role', arnKind: 'role' },
  CreateUserCommand: { nameKey: 'UserName', kind: 'User', responseKey: 'User', arnKind: 'user' },
  CreateGroupCommand: {
    nameKey: 'GroupName',
    kind: 'Group',
    responseKey: 'Group',
    arnKind: 'group',
  },
  CreateInstanceProfileCommand: {
    nameKey: 'InstanceProfileName',
    kind: 'Instance Profile',
    responseKey: 'InstanceProfile',
    arnKind: 'instance-profile',
  },
  CreatePolicyCommand: {
    nameKey: 'PolicyName',
    kind: 'A policy',
    responseKey: 'Policy',
    arnKind: 'policy',
  },
};

/** A fake IAM. Its collections count ENTITIES, not calls. */
class FakeIam {
  /** Create command name -> the entity names it holds. */
  readonly entities = new Map<string, Set<string>>();
  readonly accessKeys: Array<{ AccessKeyId: string; CreateDate: Date }> = [];
  readonly calls: string[] = [];
  /** The named call does its work, THEN throws this (a lost response). */
  readonly loseNextResponse = new Map<string, Error>();
  private keySeq = 0;

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const input = command.input;
    const lose = (): void => {
      const error = this.loseNextResponse.get(name);
      if (error) {
        this.loseNextResponse.delete(name);
        throw error;
      }
    };
    switch (name) {
      case 'CreateRoleCommand':
      case 'CreateUserCommand':
      case 'CreateGroupCommand':
      case 'CreateInstanceProfileCommand':
      case 'CreatePolicyCommand': {
        const { nameKey, kind, responseKey, arnKind } = NAME_UNIQUE[name]!;
        const entityName = input[nameKey] as string;
        const held = this.entities.get(name) ?? new Set<string>();
        this.entities.set(name, held);
        if (held.has(entityName)) {
          throw new EntityAlreadyExistsException({
            message: `${kind} with name ${entityName} already exists.`,
            $metadata: { httpStatusCode: 409 },
          });
        }
        held.add(entityName);
        lose();
        return {
          [responseKey]: {
            Arn: `arn:aws:iam::123456789012:${arnKind}/${entityName}`,
            RoleId: 'AROA1',
          },
        };
      }
      case 'CreateAccessKeyCommand': {
        const key = { AccessKeyId: `AKIAKEY${++this.keySeq}`, CreateDate: new Date() };
        this.accessKeys.push(key);
        lose();
        return { AccessKey: { ...key, SecretAccessKey: `secret-${this.keySeq}` } };
      }
      case 'ListAccessKeysCommand':
        return { AccessKeyMetadata: this.accessKeys.map((k) => ({ ...k, Status: 'Active' })) };
      case 'DeleteAccessKeyCommand': {
        const i = this.accessKeys.findIndex((k) => k.AccessKeyId === input['AccessKeyId']);
        if (i >= 0) this.accessKeys.splice(i, 1);
        return {};
      }
      default:
        return {};
    }
  };
}

const POLICY_DOC = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};
const ASSUME_DOC = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
};

const CASES = [
  [
    'CreateRoleCommand',
    'AWS::IAM::Role',
    () => new IAMRoleProvider(),
    { RoleName: 'app-role', AssumeRolePolicyDocument: ASSUME_DOC },
  ],
  [
    'CreateUserCommand',
    'AWS::IAM::User',
    () => new IAMUserGroupProvider(),
    { UserName: 'app-user' },
  ],
  [
    'CreateGroupCommand',
    'AWS::IAM::Group',
    () => new IAMUserGroupProvider(),
    { GroupName: 'app-group' },
  ],
  [
    'CreateInstanceProfileCommand',
    'AWS::IAM::InstanceProfile',
    () => new IAMInstanceProfileProvider(),
    { InstanceProfileName: 'app-profile', Roles: [] },
  ],
  [
    'CreatePolicyCommand',
    'AWS::IAM::ManagedPolicy',
    () => new IAMManagedPolicyProvider(),
    { ManagedPolicyName: 'app-policy', PolicyDocument: POLICY_DOC },
  ],
  [
    'CreateAccessKeyCommand',
    'AWS::IAM::AccessKey',
    () => new IAMAccessKeyProvider(),
    { UserName: 'app-user' },
  ],
] as const satisfies ReadonlyArray<
  readonly [string, string, () => ResourceProvider, Record<string, unknown>]
>;

describe('IAM tokenless create retry safety (issue #4639)', () => {
  let aws: FakeIam;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    aws = new FakeIam();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    sentVia.length = 0;
    shared.region.mockReset();
    // Not a default region, so a create client built from the ambient
    // region instead of the shared client's is told apart.
    shared.region.mockResolvedValue('cn-north-1');
    const client = new IAMClient({}) as unknown as { kind: string; config: FakeClientConfig };
    client.kind = 'shared';
    client.config.region = () => shared.region() as Promise<unknown>;
    shared.client = client;
    ctorOptions.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the create client', () => {
    it.each(CASES)(
      'sends %s through a client that refuses the SDK retry of a 5xx, in the shared client region',
      async (command, type, makeProvider, props) => {
        await makeProvider().create('Res', type, { ...props });

        const sent = sentVia.find(([name]) => name === command);
        expect(sent?.[1]).toBe('create');
        const strategy = (await sent![2].retryStrategy!()) as typeof baseStrategy;
        await expect(
          strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
        ).rejects.toThrow();
        await expect(
          strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
        ).resolves.toBe('retry-token');
        // Every other call keeps the shared client and its full SDK retry.
        const others = sentVia.filter(([name]) => name !== command);
        expect(others.every(([, via]) => via === 'shared')).toBe(true);
        const sharedConfig = (shared.client as { config: FakeClientConfig }).config;
        expect(await sharedConfig.retryStrategy!()).toBe(baseStrategy);
        expect(ctorOptions).toHaveLength(1);
        expect(ctorOptions[0]).toMatchObject({
          region: 'cn-north-1',
          credentials: { accessKeyId: 'AKIDAMBIENT' },
        });
      }
    );

    it('two creates on a cold provider build ONE create client', async () => {
      const provider = new IAMUserGroupProvider();

      await Promise.all([
        provider.create('A', 'AWS::IAM::User', { UserName: 'a' }),
        provider.create('B', 'AWS::IAM::Group', { GroupName: 'b' }),
      ]);

      expect(ctorOptions).toHaveLength(1);
    });

    it('a rejected region read is not cached: the next create builds the client', async () => {
      const provider = new IAMRoleProvider();
      shared.region.mockRejectedValueOnce(new Error('Region is missing'));

      await expect(
        provider.create('Res', 'AWS::IAM::Role', {
          RoleName: 'app-role',
          AssumeRolePolicyDocument: ASSUME_DOC,
        })
      ).rejects.toThrow('Region is missing');
      const result = await provider.create('Res', 'AWS::IAM::Role', {
        RoleName: 'app-role',
        AssumeRolePolicyDocument: ASSUME_DOC,
      });

      expect(result.physicalId).toBe('app-role');
      expect(shared.region).toHaveBeenCalledTimes(2);
      expect(ctorOptions).toHaveLength(1);
    });
  });

  it.each(CASES.filter(([command]) => command !== 'CreateAccessKeyCommand'))(
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

      expect(String(error)).toContain('already exists');
      // One entity, never two: the name collides rather than duplicating.
      expect(aws.entities.get(command)?.size).toBe(1);
      expect(aws.calls.filter((c) => c === command)).toHaveLength(2);
      expect(hasReplayMayCollide(error)).toBe(true);
      expect(isNameCollisionErrorFrom(error, 'Res')).toBe(false);
      expect(aws.calls.some((c) => c.startsWith('Delete'))).toBe(false);
    }
  );

  it('a lost CreateAccessKey response: the attempt deletes the key it minted, and the retry leaves exactly one', async () => {
    aws.loseNextResponse.set('CreateAccessKeyCommand', transient500());
    const provider = new IAMAccessKeyProvider();

    const result = await withRetry(
      () => provider.create('Key', 'AWS::IAM::AccessKey', { UserName: 'app-user' }),
      'Key',
      { sleep: advancingSleep }
    );

    expect(aws.accessKeys.map((k) => k.AccessKeyId)).toEqual([result.physicalId]);
    expect(result.physicalId).toBe('AKIAKEY2');
    expect(aws.calls.filter((c) => c === 'DeleteAccessKeyCommand')).toHaveLength(1);
  });
});
