/**
 * Issue #2080 (Plan C, API Gateway v1): `CreateAuthorizer` and
 * `CreateDeployment` mint their id and carry no idempotency token. A 5xx whose
 * request AWS completed used to be replayed -- inside one `send` by the SDK,
 * invisibly, or by the engine's retry -- minting a second child no state
 * records. The create now goes through a client that refuses the SDK's 5xx
 * retry, and the engine's next attempt REPORTS the candidates first.
 * Detection only: nothing is adopted and nothing is deleted.
 *
 * The fakes count RESOURCES, not calls (acceptance item 2), and every retry
 * advances the clock (acceptance item 3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy, sentVia, baseStrategy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
  /** `[command name, which client]` per send. */
  sentVia: [] as Array<
    [string, 'shared' | 'create', { region: () => Promise<unknown>; retryStrategy?: () => Promise<unknown> }]
  >,
  /** A stand-in for the SDK's resolved V2 retry strategy. */
  baseStrategy: {
    acquireInitialRetryToken: async (_scope: string) => 'token',
    refreshRetryTokenForRetry: async (_token: unknown, _info: { error?: unknown }) =>
      'retry-token',
    recordSuccess: (_token: unknown) => undefined,
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => {
  const config = { region: () => Promise.resolve('us-east-1') };
  return {
    getAwsClients: () => ({
      apiGateway: {
        config,
        send: (command: { constructor: { name: string } }) => {
          sentVia.push([command.constructor.name, 'shared', config]);
          return mockSend(command);
        },
      },
    }),
  };
});

vi.mock('@aws-sdk/client-api-gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-api-gateway')>();
  return {
    ...actual,
    APIGatewayClient: vi.fn().mockImplementation((options: { region?: unknown }) => {
      const config = {
        region: () => Promise.resolve(options.region),
        retryStrategy: async (): Promise<unknown> => baseStrategy,
      };
      return {
        config,
        send: (command: { constructor: { name: string } }) => {
          sentVia.push([command.constructor.name, 'create', config]);
          return mockSend(command);
        },
      };
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  ApiGatewayProvider,
  resetApiGatewayCreateRetryStateForTests,
} from '../../../src/provisioning/providers/apigateway-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';

/** The shape `isTransientServerError` / `isAmbiguousOutcomeError` classify (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('Internal server error'), {
    name: 'InternalServerError',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

/**
 * API Gateway's modeled throttle, identified BY NAME. On a 503 on purpose: with
 * a 4xx status the ambiguity check answers false at its status check, so only
 * the name exemption keeps this one from arming the latch.
 */
const throttled = (): Error =>
  Object.assign(new Error('Too Many Requests'), {
    name: 'TooManyRequestsException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

/** A definite refusal: API Gateway did nothing, and the text is an IAM-propagation retry pattern. */
const propagationDenied = (): Error =>
  Object.assign(
    new Error(
      'User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: apigateway:POST'
    ),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );

/** Advance the fake clock on every backoff (issue #2080 acceptance item 3). */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

interface FakeAuthorizer {
  id: string;
  restApiId: string;
  name: string;
  type: string;
}

interface FakeDeployment {
  id: string;
  restApiId: string;
  description?: string;
  createdDate: Date;
}

/** A fake API Gateway. The arrays count RESOURCES, not calls (issue #2080 acceptance item 2). */
class FakeApiGateway {
  readonly authorizers: FakeAuthorizer[] = [];
  readonly deployments: FakeDeployment[] = [];
  readonly calls: string[] = [];
  readonly failNext = new Map<string, Error[]>();
  /** The next create makes its resource, THEN throws this (a lost response). */
  loseNextCreateResponse: Error | undefined;
  /** Items per list page. */
  pageSize = 500;
  /** Runs on every list call, to stage what the NEXT create does. */
  onList: (() => void) | undefined;
  private nextId = 1;

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const queued = this.failNext.get(name);
    if (queued && queued.length > 0) throw queued.shift();
    const input = command.input;
    switch (name) {
      case 'CreateAuthorizerCommand': {
        const created: FakeAuthorizer = {
          id: `auth${this.nextId++}`,
          restApiId: input['restApiId'] as string,
          name: input['name'] as string,
          type: input['type'] as string,
        };
        this.authorizers.push(created);
        return this.answer(created);
      }
      case 'CreateDeploymentCommand': {
        const created: FakeDeployment = {
          id: `dep${this.nextId++}`,
          restApiId: input['restApiId'] as string,
          ...(input['description'] !== undefined && {
            description: input['description'] as string,
          }),
          createdDate: new Date(Date.now()),
        };
        this.deployments.push(created);
        return this.answer(created);
      }
      case 'GetAuthorizersCommand':
        return this.page(
          this.authorizers.filter((a) => a.restApiId === input['restApiId']),
          input['position']
        );
      case 'GetDeploymentsCommand':
        return this.page(
          this.deployments.filter((d) => d.restApiId === input['restApiId']),
          input['position']
        );
      default:
        return {};
    }
  };

  private answer<T extends { id: string }>(created: T): { id: string } {
    if (this.loseNextCreateResponse) {
      const error = this.loseNextCreateResponse;
      this.loseNextCreateResponse = undefined;
      throw error;
    }
    return { id: created.id };
  }

  private page<T>(all: T[], position: unknown): { items: T[]; position?: string } {
    this.onList?.();
    const start = position === undefined ? 0 : Number(position);
    const end = start + this.pageSize;
    return {
      items: all.slice(start, end).map((a) => ({ ...a })),
      ...(end < all.length && { position: String(end) }),
    };
  }

  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
}

const AUTH_PROPS = { RestApiId: 'rest1', Name: 'jwt-auth', Type: 'TOKEN' };
const DEP_PROPS = { RestApiId: 'rest1', Description: 'v1' };

describe('ApiGatewayProvider tokenless create retry safety (issue #2080, detection only)', () => {
  let provider: ApiGatewayProvider;
  let aws: FakeApiGateway;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    resetApiGatewayCreateRetryStateForTests();
    aws = new FakeApiGateway();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    debugSpy.mockReset();
    sentVia.length = 0;
    provider = new ApiGatewayProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createWithRetry = (
    type: 'AWS::ApiGateway::Authorizer' | 'AWS::ApiGateway::Deployment',
    props: Record<string, unknown>,
    logicalId = 'Child'
  ) =>
    withRetry(() => provider.create(logicalId, type, props), logicalId, {
      sleep: advancingSleep,
    });

  const warnLines = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));
  const reportFor = (action: string): string | undefined =>
    warnLines().find((l) => l.includes(`earlier ${action} attempt`));

  describe('CreateAuthorizer (no creation date: read command only)', () => {
    it('names the authorizer a lost response created, and neither adopts nor deletes it', async () => {
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry('AWS::ApiGateway::Authorizer', AUTH_PROPS);

      expect(aws.authorizers.map((a) => a.id)).toEqual(['auth1', 'auth2']);
      expect(result.physicalId).toBe('auth2');
      expect(aws.calls).not.toContain('DeleteAuthorizerCommand');
      const line = reportFor('CreateAuthorizer');
      expect(line).toContain('auth1');
      expect(line).toContain(
        'aws apigateway get-authorizer --rest-api-id rest1 --authorizer-id auth1'
      );
      expect(line).not.toContain('delete-authorizer');
      expect(line).toContain('does not adopt or delete');
    });

    it('does not report one this process recorded, one of another name, type or REST API', async () => {
      const earlier = await provider.create('Other', 'AWS::ApiGateway::Authorizer', AUTH_PROPS);
      aws.authorizers.push(
        { id: 'othername', restApiId: 'rest1', name: 'other', type: 'TOKEN' },
        { id: 'othertype', restApiId: 'rest1', name: 'jwt-auth', type: 'REQUEST' },
        { id: 'otherapi', restApiId: 'rest2', name: 'jwt-auth', type: 'TOKEN' }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGateway::Authorizer', AUTH_PROPS);

      const line = reportFor('CreateAuthorizer')!;
      expect(line).toContain('auth2');
      expect(line).toContain('1 authorizer(s) match');
      for (const id of [earlier.physicalId, 'othername', 'othertype', 'otherapi']) {
        expect(line).not.toContain(id);
      }
    });

    it('follows GetAuthorizers pagination to a candidate on a later page', async () => {
      aws.pageSize = 1;
      aws.authorizers.push(
        { id: 'a', restApiId: 'rest1', name: 'a', type: 'TOKEN' },
        { id: 'b', restApiId: 'rest1', name: 'b', type: 'TOKEN' }
      );
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGateway::Authorizer', AUTH_PROPS);

      expect(reportFor('CreateAuthorizer')).toContain('auth1');
    });

    it('says the search was incomplete when the listing is cut at the page ceiling', async () => {
      aws.pageSize = 1;
      for (let i = 0; i < 25; i++) {
        aws.authorizers.push({ id: `x${i}`, restApiId: 'rest1', name: `o${i}`, type: 'TOKEN' });
      }
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGateway::Authorizer', AUTH_PROPS);

      expect(warnLines().some((l) => l.includes('cut at 20 pages'))).toBe(true);
    });

    it('names at most five candidates, then an ellipsis', async () => {
      for (let i = 0; i < 6; i++) {
        aws.authorizers.push({ id: `twin${i}`, restApiId: 'rest1', name: 'jwt-auth', type: 'TOKEN' });
      }
      aws.failNext.set('CreateAuthorizerCommand', [transient500()]);

      await createWithRetry('AWS::ApiGateway::Authorizer', AUTH_PROPS);

      const line = reportFor('CreateAuthorizer')!;
      expect(line).toContain('6 authorizer(s) match');
      expect(line).toContain('twin4, ...');
      expect(line).not.toContain('twin5');
    });

    it('masks a short secret-derived authorizer name as a WHOLE value', async () => {
      aws.loseNextCreateResponse = transient500();

      await withRetry(
        () =>
          provider.create(
            'Child',
            'AWS::ApiGateway::Authorizer',
            { ...AUTH_PROPS, Name: 'zq' },
            { maskSecrets: (t) => (t === 'zq' ? '***' : t) }
          ),
        'Child',
        { sleep: advancingSleep }
      );

      const line = reportFor('CreateAuthorizer')!;
      expect(line).toContain('auth1');
      expect(line).not.toContain('named zq');
    });

    it('a throttled CreateAuthorizer triggers no lookup', async () => {
      aws.failNext.set('CreateAuthorizerCommand', [throttled()]);

      await createWithRetry('AWS::ApiGateway::Authorizer', AUTH_PROPS);

      expect(aws.count('GetAuthorizersCommand')).toBe(0);
      expect(aws.authorizers).toHaveLength(1);
    });

    it('a DEFINITE CreateAuthorizer failure (a 4xx) triggers no lookup', async () => {
      aws.failNext.set('CreateAuthorizerCommand', [propagationDenied()]);

      await createWithRetry('AWS::ApiGateway::Authorizer', AUTH_PROPS);

      expect(aws.count('GetAuthorizersCommand')).toBe(0);
      expect(aws.authorizers).toHaveLength(1);
    });

    it('a failed GetAuthorizers warns and lets the create proceed', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.failNext.set('GetAuthorizersCommand', [propagationDenied()]);

      const result = await createWithRetry('AWS::ApiGateway::Authorizer', AUTH_PROPS);

      expect(result.physicalId).toBe('auth2');
      expect(warnLines().some((l) => l.includes('could not look for it (GetAuthorizers'))).toBe(
        true
      );
    });
  });

  describe('CreateDeployment (createdDate: windowed, delete command after the read command)', () => {
    it('names the deployment a lost response created, with a read then a conditional delete command', async () => {
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry('AWS::ApiGateway::Deployment', DEP_PROPS);

      expect(aws.deployments.map((d) => d.id)).toEqual(['dep1', 'dep2']);
      expect(result.physicalId).toBe('dep2');
      expect(aws.calls).not.toContain('DeleteDeploymentCommand');
      const line = reportFor('CreateDeployment')!;
      expect(line).toContain('dep1');
      const read = line.indexOf(
        'aws apigateway get-deployment --rest-api-id rest1 --deployment-id dep1'
      );
      const remove = line.indexOf(
        'aws apigateway delete-deployment --rest-api-id rest1 --deployment-id dep1'
      );
      expect(read).toBeGreaterThan(-1);
      expect(remove).toBeGreaterThan(read);
      expect(line).toContain('Only after confirming');
    });

    it('does not report a same-described deployment created BEFORE the ambiguous attempt', async () => {
      aws.deployments.push({
        id: 'old',
        restApiId: 'rest1',
        description: 'v1',
        createdDate: new Date(Date.now() - 60_000),
      });
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGateway::Deployment', DEP_PROPS);

      const line = reportFor('CreateDeployment')!;
      expect(line).toContain('dep1');
      expect(line).not.toContain('old');
    });

    it('does not report one of another description, or one this process recorded', async () => {
      const earlier = await provider.create('Other', 'AWS::ApiGateway::Deployment', DEP_PROPS);
      aws.deployments.push({
        id: 'otherdesc',
        restApiId: 'rest1',
        description: 'v2',
        createdDate: new Date(Date.now()),
      });
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGateway::Deployment', DEP_PROPS);

      const line = reportFor('CreateDeployment')!;
      expect(line).toContain('dep2');
      expect(line).not.toContain(earlier.physicalId);
      expect(line).not.toContain('otherdesc');
    });

    it('matches a deployment with no description to a create with none', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry('AWS::ApiGateway::Deployment', { RestApiId: 'rest1' });

      expect(reportFor('CreateDeployment')).toContain('dep1');
    });

    it('two ambiguous attempts in a row: the second report covers the FIRST attempt too', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.loseNextCreateResponse = transient500();
        aws.onList = undefined;
      };

      await withRetry(
        () => provider.create('Child', 'AWS::ApiGateway::Deployment', DEP_PROPS),
        'Child',
        {
          sleep: (): Promise<void> => {
            vi.setSystemTime(Date.now() + 30_000);
            return Promise.resolve();
          },
        }
      );

      const lines = warnLines().filter((l) => l.includes('earlier CreateDeployment attempt'));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('between 2026-09-30T23:59:55.000Z');
      expect(lines[1]).toContain('dep1');
      expect(lines[1]).toContain('dep2');
    });

    it('looks up once per ambiguous failure, not again on a later DEFINITE failure', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.failNext.set('CreateDeploymentCommand', [propagationDenied()]);
        aws.onList = undefined;
      };

      await createWithRetry('AWS::ApiGateway::Deployment', DEP_PROPS);

      expect(aws.count('GetDeploymentsCommand')).toBe(1);
      expect(aws.deployments.map((d) => d.id)).toEqual(['dep1', 'dep2']);
    });
  });

  it.each([
    ['CreateAuthorizerCommand', 'AWS::ApiGateway::Authorizer', AUTH_PROPS],
    ['CreateDeploymentCommand', 'AWS::ApiGateway::Deployment', DEP_PROPS],
  ] as const)(
    'sends %s through a client that refuses the SDK retry of a 5xx, in the shared client region',
    async (command, type, props) => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(type, props);

      const [, via, createConfig] = sentVia.find(([name]) => name === command)!;
      expect(via).toBe('create');
      const strategy = (await createConfig.retryStrategy!()) as typeof baseStrategy;
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
      ).rejects.toThrow();
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
      ).resolves.toBe('retry-token');
      // The list call keeps the shared client and its full SDK retry.
      expect(sentVia.filter(([name]) => name.startsWith('Get')).map(([, v]) => v)).toEqual([
        'shared',
      ]);
      const { APIGatewayClient } = await import('@aws-sdk/client-api-gateway');
      expect(vi.mocked(APIGatewayClient).mock.calls.at(-1)![0]).toMatchObject({
        region: 'us-east-1',
      });
    }
  );
});
