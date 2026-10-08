import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy, sentVia, baseStrategy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
  /** `[command name, client config]` per send, so a test can see WHICH client sent it. */
  sentVia: [] as Array<[string, { retryStrategy: () => Promise<unknown> }]>,
  /** A stand-in for the SDK's resolved V2 retry strategy. */
  baseStrategy: {
    acquireInitialRetryToken: async (_scope: string) => 'token',
    refreshRetryTokenForRetry: async (_token: unknown, _info: { error?: unknown }) =>
      'retry-token',
    recordSuccess: (_token: unknown) => undefined,
  },
}));

/** The region every mocked client answers; a test can make it unreadable (issue #4307). */
let clientRegion: () => Promise<string> = () => Promise.resolve('us-east-1');

vi.mock('@aws-sdk/client-appsync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-appsync')>();
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => {
      const config = {
        region: () => clientRegion(),
        retryStrategy: async (): Promise<unknown> => baseStrategy,
      };
      return {
        config,
        send: (command: { constructor: { name: string } }) => {
          sentVia.push([command.constructor.name, config]);
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
  AppSyncProvider,
  resetGraphqlApiCreateRetryStateForTests,
} from '../../../src/provisioning/providers/appsync-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';

/** The shape `isTransientServerError` / `isAmbiguousOutcomeError` classify (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('Internal failure'), {
    name: 'InternalFailureException',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

/**
 * AppSync's modeled throttle: `LimitExceededException` ("The request exceeded
 * a limit. Try your request again."), which cdkd identifies BY NAME.
 *
 * Carried on a 503 on purpose: with a 4xx status `isAmbiguousOutcomeError`
 * already answers false at its status check, so the NAME exemption would
 * never be reached and a test titled "throttled by name" would pass without
 * it. On a 503 only that exemption keeps the failure from arming the latch.
 */
const throttled = (): Error =>
  Object.assign(new Error('The request exceeded a limit. Try your request again.'), {
    name: 'LimitExceededException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

/**
 * Deliberately NOT a throttle by name: it drives the SDK's
 * `$retryable.throttling` flag, the other way a throttle is identified. On a
 * 503 for the same reason as {@link throttled}: only the flag exemption keeps
 * it from arming the latch.
 */
const flaggedThrottle = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ConcurrentModificationException',
    $fault: 'server',
    $retryable: { throttling: true },
    $metadata: { httpStatusCode: 503 },
  });

/** A definite refusal: AppSync did nothing, and the message is an IAM-propagation retry pattern. */
const propagationDenied = (): Error =>
  Object.assign(
    new Error('User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: appsync:X'),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 400 } }
  );

/** Advance the fake clock on every backoff (issue #2080 acceptance item 3). */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

interface FakeApi {
  apiId: string;
  name: string;
  arn: string;
  apiType?: string;
}

/** A fake AppSync. `apis` counts RESOURCES, not calls (issue #2080 acceptance item 2). */
class FakeAppSync {
  readonly apis: FakeApi[] = [];
  readonly calls: string[] = [];
  readonly failNext = new Map<string, Error[]>();
  /** CreateGraphqlApi creates the API, THEN throws this (a lost response). */
  loseNextCreateResponse: Error | undefined;
  /** APIs per `ListGraphqlApis` page. */
  pageSize = 25;
  /** Runs on every `ListGraphqlApis`, to stage what the NEXT create does. */
  onList: (() => void) | undefined;
  /**
   * The `$metadata.attempts` the next successful CreateGraphqlApi reports
   * (issue #4687): each attempt past the first is an SDK replay whose earlier
   * attempt reached AppSync, so it leaves one more API behind first.
   */
  nextCreateAttempts: number | undefined;
  private nextId = 1;

  seed(api: Omit<FakeApi, 'arn'>): void {
    this.apis.push({ arn: `arn:aws:appsync:us-east-1:1:apis/${api.apiId}`, ...api });
  }

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const queued = this.failNext.get(name);
    if (queued && queued.length > 0) throw queued.shift();
    const input = command.input;
    switch (name) {
      case 'CreateGraphqlApiCommand': {
        const attempts = this.nextCreateAttempts;
        this.nextCreateAttempts = undefined;
        for (let i = 1; i < (attempts ?? 1); i++) {
          this.seed({ apiId: `api${this.nextId++}`, name: input['name'] as string });
        }
        this.seed({
          apiId: `api${this.nextId++}`,
          name: input['name'] as string,
          ...(input['apiType'] !== undefined && { apiType: input['apiType'] as string }),
        });
        if (this.loseNextCreateResponse) {
          const error = this.loseNextCreateResponse;
          this.loseNextCreateResponse = undefined;
          throw error;
        }
        const api = this.apis[this.apis.length - 1]!;
        return {
          graphqlApi: { ...api, uris: { GRAPHQL: `https://${api.apiId}/graphql` } },
          ...(attempts !== undefined && { $metadata: { attempts } }),
        };
      }
      case 'ListGraphqlApisCommand':
        this.onList?.();
        const start = input['nextToken'] === undefined ? 0 : Number(input['nextToken']);
        const end = start + this.pageSize;
        return {
          graphqlApis: this.apis.slice(start, end).map((a) => ({ ...a })),
          ...(end < this.apis.length && { nextToken: String(end) }),
        };
      default:
        return {};
    }
  };

  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
}

const API_PROPS = { Name: 'orders-api', AuthenticationType: 'API_KEY' };

describe('AppSyncProvider CreateGraphqlApi retry safety (issue #2080, detection only)', () => {
  let provider: AppSyncProvider;
  let aws: FakeAppSync;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    resetGraphqlApiCreateRetryStateForTests();
    aws = new FakeAppSync();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    debugSpy.mockReset();
    sentVia.length = 0;
    provider = new AppSyncProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createWithRetry = (props: Record<string, unknown> = API_PROPS, logicalId = 'Api') =>
    withRetry(() => provider.create(logicalId, 'AWS::AppSync::GraphQLApi', props), logicalId, {
      sleep: advancingSleep,
    });

  const warnLines = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

  it('names the API a lost response created, and neither adopts nor deletes it', async () => {
    aws.loseNextCreateResponse = transient500();

    const result = await createWithRetry();

    expect(aws.apis.map((a) => a.apiId)).toEqual(['api1', 'api2']);
    expect(result.physicalId).toBe('api2');
    expect(aws.calls).not.toContain('DeleteGraphqlApiCommand');
    const line = warnLines().find((l) => l.includes('earlier CreateGraphqlApi attempt'));
    expect(line).toContain('api1');
    // No creation date to attribute by, so a READ command only, never a delete.
    expect(line).toContain('aws appsync get-graphql-api --api-id api1 --region us-east-1');
    expect(line).not.toContain('delete-graphql-api');
    expect(line).toContain('does not adopt or delete');
  });

  it('an unreadable client region drops only the --region fragment, never the report (issue #4307)', async () => {
    aws.loseNextCreateResponse = transient500();
    // Only the FIRST read after the lookup listed the APIs fails: the
    // report's own. The create that follows reads the region too.
    let failed = false;
    clientRegion = () => {
      if (!failed && aws.calls.includes('ListGraphqlApisCommand')) {
        failed = true;
        return Promise.reject(new Error('region unavailable'));
      }
      return Promise.resolve('us-east-1');
    };
    try {
      await createWithRetry();
    } finally {
      clientRegion = () => Promise.resolve('us-east-1');
    }

    const line = warnLines().find((l) => l.includes('earlier CreateGraphqlApi attempt'));
    expect(line).toContain('aws appsync get-graphql-api --api-id api1');
    expect(line).not.toContain('--region');
  });

  it('does not report an API this process recorded, one of another name, or one of another type', async () => {
    const earlier = await provider.create('Other', 'AWS::AppSync::GraphQLApi', API_PROPS);
    aws.seed({ apiId: 'unrelated', name: 'billing-api' });
    aws.seed({ apiId: 'merged', name: 'orders-api', apiType: 'MERGED' });
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    const line = warnLines().find((l) => l.includes('earlier CreateGraphqlApi attempt'));
    expect(line).toContain('api2');
    expect(line).not.toContain(earlier.physicalId);
    expect(line).not.toContain('unrelated');
    expect(line).not.toContain('merged');
  });

  it('follows ListGraphqlApis pagination to a candidate on a later page', async () => {
    aws.pageSize = 1;
    aws.seed({ apiId: 'other-a', name: 'a' });
    aws.seed({ apiId: 'other-b', name: 'b' });
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    const line = warnLines().find((l) => l.includes('earlier CreateGraphqlApi attempt'));
    expect(line).toContain('api1');
  });

  it('says the search was incomplete when the listing is cut at the page ceiling', async () => {
    aws.pageSize = 1;
    for (let i = 0; i < 45; i++) aws.seed({ apiId: `x${i}`, name: `other-${i}` });
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    expect(warnLines().some((l) => l.includes('cut at 40 pages'))).toBe(true);
  });

  it('names at most five candidates, then an ellipsis', async () => {
    for (let i = 0; i < 6; i++) aws.seed({ apiId: `twin${i}`, name: 'orders-api' });
    aws.failNext.set('CreateGraphqlApiCommand', [transient500()]);

    await createWithRetry();

    const line = warnLines().find((l) => l.includes('earlier CreateGraphqlApi attempt'))!;
    expect(line).toContain('6 GraphQL API(s)');
    expect(line).toContain('twin4, ...');
    expect(line).not.toContain('twin5');
  });

  it('masks a secret-derived API name in the report', async () => {
    aws.loseNextCreateResponse = transient500();

    await withRetry(
      () =>
        provider.create(
          'Api',
          'AWS::AppSync::GraphQLApi',
          { ...API_PROPS, Name: 'hunter2-api' },
          { maskSecrets: (t) => t.split('hunter2-api').join('***') }
        ),
      'Api',
      { sleep: advancingSleep }
    );

    const line = warnLines().find((l) => l.includes('earlier CreateGraphqlApi attempt'))!;
    expect(line).toContain('api1');
    expect(line).not.toContain('hunter2');
  });

  it('masks the API name as a WHOLE value, which a substring masker misses for a short secret', async () => {
    aws.loseNextCreateResponse = transient500();

    await withRetry(
      () =>
        provider.create(
          'Api',
          'AWS::AppSync::GraphQLApi',
          { ...API_PROPS, Name: 'zq' },
          { maskSecrets: (t) => (t === 'zq' ? '***' : t) }
        ),
      'Api',
      { sleep: advancingSleep }
    );

    const line = warnLines().find((l) => l.includes('earlier CreateGraphqlApi attempt'))!;
    expect(line).toContain('api1');
    expect(line).not.toContain('named zq');
  });

  it('two ambiguous attempts in a row: the second report dates from the FIRST attempt', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.onList = () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = undefined;
    };

    await withRetry(() => provider.create('Api', 'AWS::AppSync::GraphQLApi', API_PROPS), 'Api', {
      sleep: (): Promise<void> => {
        vi.setSystemTime(Date.now() + 30_000);
        return Promise.resolve();
      },
    });

    const lines = warnLines().filter((l) => l.includes('earlier CreateGraphqlApi attempt'));
    expect(lines).toHaveLength(2);
    // The first attempt started at the suite's epoch, minus the 5 s margin.
    expect(lines[1]).toContain('(at 2026-09-30T23:59:55.000Z)');
    expect(lines[1]).toContain('api1');
    expect(lines[1]).toContain('api2');
  });

  it.each([
    ['by name (LimitExceededException)', throttled],
    ['by the SDK $retryable.throttling flag', flaggedThrottle],
  ])('a CreateGraphqlApi throttled %s triggers no lookup', async (_how, failure) => {
    aws.failNext.set('CreateGraphqlApiCommand', [failure()]);

    await createWithRetry();

    expect(aws.count('ListGraphqlApisCommand')).toBe(0);
    expect(aws.apis).toHaveLength(1);
  });

  it('sends CreateGraphqlApi through a client that refuses the SDK retry of a 5xx, and nothing else', async () => {
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    const createConfig = sentVia.find(([name]) => name === 'CreateGraphqlApiCommand')![1];
    const strategy = (await createConfig.retryStrategy()) as typeof baseStrategy;
    await expect(
      strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
    ).rejects.toThrow();
    await expect(
      strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
    ).resolves.toBe('retry-token');
    const listConfig = sentVia.find(([name]) => name === 'ListGraphqlApisCommand')![1];
    expect(await listConfig.retryStrategy()).toBe(baseStrategy);
  });

  it('a DEFINITE CreateGraphqlApi failure (a 4xx) triggers no lookup', async () => {
    aws.failNext.set('CreateGraphqlApiCommand', [propagationDenied()]);

    await createWithRetry();

    expect(aws.count('ListGraphqlApisCommand')).toBe(0);
    expect(aws.apis).toHaveLength(1);
  });

  it('a failed ListGraphqlApis warns and lets the create proceed', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.failNext.set('ListGraphqlApisCommand', [propagationDenied()]);

    const result = await createWithRetry();

    expect(result.physicalId).toBe('api2');
    expect(warnLines().some((l) => l.includes('could not list APIs'))).toBe(true);
  });

  it('looks up once per ambiguous failure, not again on a later DEFINITE failure', async () => {
    aws.loseNextCreateResponse = transient500();
    // Attempt 2 (after the lookup) is refused outright; attempt 3 succeeds.
    aws.onList = () => {
      aws.failNext.set('CreateGraphqlApiCommand', [propagationDenied()]);
      aws.onList = undefined;
    };

    await createWithRetry();

    expect(aws.count('ListGraphqlApisCommand')).toBe(1);
    // The lost response's API and the one attempt 3 made; attempt 2 was refused.
    expect(aws.apis.map((a) => a.apiId)).toEqual(['api1', 'api2']);
  });

  describe('a create the SDK replayed inside its send (issue #4687)', () => {
    const replayLine = (): string | undefined =>
      warnLines().find((l) => l.includes('succeeded only after the AWS SDK sent it again'));

    it('names the API the first attempt left, never the one the create returned; nothing adopted or deleted', async () => {
      aws.nextCreateAttempts = 2;

      const result = await provider.create('Api', 'AWS::AppSync::GraphQLApi', API_PROPS);

      // The replayed create's first attempt reached AppSync: two APIs exist.
      expect(aws.apis.map((a) => a.apiId)).toEqual(['api1', 'api2']);
      expect(result.physicalId).toBe('api2');
      expect(aws.calls).toEqual(['CreateGraphqlApiCommand', 'ListGraphqlApisCommand']);
      const line = replayLine();
      expect(line).toContain('The CreateGraphqlApi call for Api succeeded only after');
      expect(line).toContain('aws appsync get-graphql-api --api-id api1 --region us-east-1');
      expect(line).toContain('1 GraphQL API(s)');
      expect(line).not.toContain('api2');
      expect(line).toContain('cdkd recorded the API the create returned.');
      expect(line).not.toContain('Creating a new');
      expect(line).toContain('does not adopt or delete');
      expect(warnLines().some((l) => l.includes('earlier CreateGraphqlApi attempt'))).toBe(false);
    });

    it('a single-attempt create, or one with no $metadata, sends no lookup', async () => {
      aws.nextCreateAttempts = 1;
      await provider.create('Api', 'AWS::AppSync::GraphQLApi', API_PROPS);
      await provider.create('Other', 'AWS::AppSync::GraphQLApi', API_PROPS);

      expect(aws.calls).toEqual(['CreateGraphqlApiCommand', 'CreateGraphqlApiCommand']);
      expect(warnLines()).toEqual([]);
    });

    it('reports the duplicate before the follow-up call, so that call failing cannot skip it', async () => {
      aws.nextCreateAttempts = 2;
      aws.failNext.set('PutGraphqlApiEnvironmentVariablesCommand', [propagationDenied()]);

      await expect(
        provider.create('Api', 'AWS::AppSync::GraphQLApi', {
          ...API_PROPS,
          EnvironmentVariables: { STAGE: 'dev' },
        })
      ).rejects.toThrow();

      expect(aws.calls.slice(0, 3)).toEqual([
        'CreateGraphqlApiCommand',
        'ListGraphqlApisCommand',
        'PutGraphqlApiEnvironmentVariablesCommand',
      ]);
      expect(replayLine()).toContain('get-graphql-api --api-id api1');
    });

    it('a failed ListGraphqlApis after the replay warns with the replay lead and still returns the API', async () => {
      aws.nextCreateAttempts = 2;
      aws.failNext.set('ListGraphqlApisCommand', [propagationDenied()]);

      const result = await provider.create('Api', 'AWS::AppSync::GraphQLApi', API_PROPS);

      expect(result.physicalId).toBe('api2');
      expect(aws.calls).toEqual(['CreateGraphqlApiCommand', 'ListGraphqlApisCommand']);
      const line = replayLine()!;
      expect(line).toContain('The CreateGraphqlApi call for Api succeeded only after');
      expect(line).toContain('cdkd could not list APIs to look for it');
      expect(line).toContain('Check for another API of that name.');
      expect(line).not.toContain('Creating a new');
    });

    it('an API a failed rollback left behind is still named by a later replayed create', async () => {
      // First create: replayed (api1 orphan, api2 returned), then its follow-up
      // fails AND the rollback delete fails, so api2 is left behind.
      aws.nextCreateAttempts = 2;
      aws.failNext.set('PutGraphqlApiEnvironmentVariablesCommand', [propagationDenied()]);
      aws.failNext.set('DeleteGraphqlApiCommand', [propagationDenied()]);
      await expect(
        provider.create('Api', 'AWS::AppSync::GraphQLApi', {
          ...API_PROPS,
          EnvironmentVariables: { STAGE: 'dev' },
        })
      ).rejects.toThrow();
      expect(aws.calls).toContain('DeleteGraphqlApiCommand');
      warnSpy.mockReset();

      // Second create of the same name, replayed again: api3 orphan, api4 returned.
      aws.nextCreateAttempts = 2;
      const result = await provider.create('Api', 'AWS::AppSync::GraphQLApi', API_PROPS);

      expect(result.physicalId).toBe('api4');
      const line = replayLine()!;
      // api2 was excluded from the first lookup by id only, never added to the
      // process set, so it stays nameable now.
      expect(line).toContain('get-graphql-api --api-id api2');
      expect(line).toContain('get-graphql-api --api-id api3');
      expect(line).not.toContain('api4');
    });
  });
});
