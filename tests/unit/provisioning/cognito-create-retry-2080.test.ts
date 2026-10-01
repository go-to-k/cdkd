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

vi.mock('@aws-sdk/client-cognito-identity-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cognito-identity-provider')>();
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => {
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
  CognitoUserPoolProvider,
  resetUserPoolCreateRetryStateForTests,
} from '../../../src/provisioning/providers/cognito-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';

/** The shape `isTransientServerError` / `isAmbiguousOutcomeError` classify (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('Internal server error'), {
    name: 'InternalErrorException',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

/** A throttle: the service did nothing, so it must not arm the latch. */
const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'TooManyRequestsException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });

/** A definite refusal: Cognito did nothing, and the message is an IAM-propagation retry pattern. */
const propagationDenied = (): Error =>
  Object.assign(
    new Error('User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: cognito-idp:X'),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 400 } }
  );

/** Advance the fake clock on every backoff (issue #2080 acceptance item 3). */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

/**
 * A backoff far past the 5 s skew margin. With `advancingSleep`'s 1-2 s, a
 * window anchored on the LOOKUP time instead of the ambiguous attempt would
 * still cover the orphan by accident.
 */
const longSleep = (): Promise<void> => {
  vi.setSystemTime(Date.now() + 30_000);
  return Promise.resolve();
};

interface FakePool {
  Id: string;
  Name: string;
  Arn: string;
  CreationDate: Date;
}

/** A fake Cognito. `pools` counts RESOURCES, not calls (issue #2080 acceptance item 2). */
class FakeCognito {
  readonly pools: FakePool[] = [];
  readonly calls: string[] = [];
  readonly failNext = new Map<string, Error[]>();
  /** CreateUserPool creates the pool, THEN throws this (a lost response). */
  loseNextCreateResponse: Error | undefined;
  /** Pools per `ListUserPools` page. */
  pageSize = 60;
  /** The service clock's offset from ours, applied to every `CreationDate`. */
  skewMs = 0;
  private nextId = 1;

  seed(pool: Partial<FakePool> & { Id: string; Name: string }): void {
    this.pools.push({
      Arn: `arn:aws:cognito-idp:us-east-1:1:userpool/${pool.Id}`,
      CreationDate: new Date(Date.now()),
      ...pool,
    });
  }

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const queued = this.failNext.get(name);
    if (queued && queued.length > 0) throw queued.shift();
    const input = command.input;
    switch (name) {
      case 'CreateUserPoolCommand': {
        const id = `us-east-1_pool${this.nextId++}`;
        this.seed({
          Id: id,
          Name: input['PoolName'] as string,
          CreationDate: new Date(Date.now() + this.skewMs),
        });
        if (this.loseNextCreateResponse) {
          const error = this.loseNextCreateResponse;
          this.loseNextCreateResponse = undefined;
          throw error;
        }
        return { UserPool: { ...this.pools[this.pools.length - 1]! } };
      }
      case 'ListUserPoolsCommand': {
        const start = input['NextToken'] === undefined ? 0 : Number(input['NextToken']);
        const end = start + this.pageSize;
        return {
          UserPools: this.pools.slice(start, end).map((p) => ({
            Id: p.Id,
            Name: p.Name,
            CreationDate: p.CreationDate,
          })),
          ...(end < this.pools.length && { NextToken: String(end) }),
        };
      }
      case 'DeleteUserPoolCommand': {
        const index = this.pools.findIndex((p) => p.Id === input['UserPoolId']);
        if (index >= 0) this.pools.splice(index, 1);
        return {};
      }
      default:
        return {};
    }
  };

  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
}

const STACK = 'MyStack';

describe('CognitoUserPoolProvider CreateUserPool retry safety (issue #2080, detection only)', () => {
  let provider: CognitoUserPoolProvider;
  let aws: FakeCognito;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    resetUserPoolCreateRetryStateForTests();
    aws = new FakeCognito();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    debugSpy.mockReset();
    sentVia.length = 0;
    provider = new CognitoUserPoolProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createWithRetry = (
    props: Record<string, unknown> = {},
    options: { sleep?: (ms: number) => Promise<void>; maskSecrets?: (t: string) => string } = {}
  ) =>
    withStackName(STACK, () =>
      withRetry(
        () =>
          provider.create(
            'Pool',
            'AWS::Cognito::UserPool',
            props,
            options.maskSecrets ? { maskSecrets: options.maskSecrets } : undefined
          ),
        'Pool',
        { sleep: options.sleep ?? advancingSleep }
      )
    );

  const warnLines = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));
  const orphanLine = (): string | undefined =>
    warnLines().find((l) => l.includes('earlier CreateUserPool attempt'));

  it('a retried 500 whose request succeeded leaves TWO pools and names the first; nothing adopted or deleted', async () => {
    aws.loseNextCreateResponse = transient500();

    const result = await createWithRetry();

    expect(aws.pools.map((p) => p.Id)).toEqual(['us-east-1_pool1', 'us-east-1_pool2']);
    expect(result.physicalId).toBe('us-east-1_pool2');
    expect(aws.calls).not.toContain('DeleteUserPoolCommand');
    expect(aws.calls).not.toContain('DescribeUserPoolCommand');
    const line = orphanLine();
    expect(line).toContain('us-east-1_pool1');
    // Trap 2: the retry makes a second pool of the same name, and says so.
    expect(line).toContain('will ALL be named MyStack-Pool');
  });

  it('leads with a READ command, and offers deletion only after confirming', async () => {
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    const line = orphanLine()!;
    const read = line.indexOf(
      'aws cognito-idp describe-user-pool --user-pool-id us-east-1_pool1 --region us-east-1'
    );
    const del = line.indexOf(
      'aws cognito-idp delete-user-pool --user-pool-id us-east-1_pool1 --region us-east-1'
    );
    expect(read).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(read);
    expect(line.slice(read, del)).toContain('Only after confirming');
  });

  it('an unreadable client region drops only the --region fragment, never the report (issue #4307)', async () => {
    aws.loseNextCreateResponse = transient500();
    // Only the FIRST read after the lookup listed the pools fails: the
    // report's own. The create that follows reads the region too.
    let failed = false;
    clientRegion = () => {
      if (!failed && aws.calls.includes('ListUserPoolsCommand')) {
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

    const line = orphanLine()!;
    expect(line).toContain('aws cognito-idp describe-user-pool --user-pool-id us-east-1_pool1');
    expect(line).not.toContain('--region');
  });

  it('reports the same way for a cdkd-generated name as for a template-supplied one', async () => {
    aws.loseNextCreateResponse = transient500();

    const result = await createWithRetry({ UserPoolName: 'shared-name' });

    expect(aws.pools).toHaveLength(2);
    expect(result.physicalId).toBe('us-east-1_pool2');
    expect(orphanLine()).toContain('us-east-1_pool1');
  });

  it('still finds the orphan after a backoff far past the skew margin', async () => {
    aws.loseNextCreateResponse = transient500();

    await createWithRetry({}, { sleep: longSleep });

    expect(orphanLine()).toContain('us-east-1_pool1');
  });

  it('finds an orphan whose CreationDate the service stamped slightly BEHIND our clock', async () => {
    aws.skewMs = -2_000;
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    expect(orphanLine()).toContain('us-east-1_pool1');
  });

  it('two ambiguous attempts in a row: the lookup after the second still names the FIRST orphan', async () => {
    aws.loseNextCreateResponse = transient500();
    // Attempt 2 also creates and loses its response; attempt 3 succeeds.
    let lists = 0;
    mockSend.mockImplementation(async (command: Parameters<typeof aws.send>[0]) => {
      if (command.constructor.name === 'ListUserPoolsCommand' && lists++ === 0) {
        aws.loseNextCreateResponse = transient500();
      }
      return aws.send(command);
    });

    // 30 s apart, so attempt 2's own window (5 s margin) cannot reach pool 1.
    const result = await createWithRetry({}, { sleep: longSleep });

    expect(aws.pools).toHaveLength(3);
    expect(result.physicalId).toBe('us-east-1_pool3');
    const lines = warnLines().filter((l) => l.includes('earlier CreateUserPool attempt'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('us-east-1_pool1');
    expect(lines[1]).toContain('us-east-1_pool2');
  });

  it('does not name a same-named pool created BEFORE the window (a prior run)', async () => {
    aws.seed({
      Id: 'us-east-1_prior',
      Name: `${STACK}-Pool`,
      CreationDate: new Date(Date.now() - 60_000),
    });
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    expect(orphanLine()).not.toContain('us-east-1_prior');
  });

  it('does not name a same-named pool created AFTER the ambiguous attempt ended', async () => {
    aws.failNext.set('CreateUserPoolCommand', [transient500()]);
    await expect(
      withStackName(STACK, () => provider.create('Pool', 'AWS::Cognito::UserPool', {}))
    ).rejects.toThrow();
    vi.setSystemTime(Date.now() + 60_000);
    aws.seed({ Id: 'us-east-1_otherProcess', Name: `${STACK}-Pool` });

    const result = await withStackName(STACK, () =>
      provider.create('Pool', 'AWS::Cognito::UserPool', {})
    );

    expect(result.physicalId).not.toBe('us-east-1_otherProcess');
    expect(aws.pools.map((p) => p.Id)).toEqual(['us-east-1_otherProcess', result.physicalId]);
    expect(orphanLine()).toBeUndefined();
  });

  it('does not name a pool this process already recorded', async () => {
    const first = await withStackName(STACK, () =>
      provider.create('Pool', 'AWS::Cognito::UserPool', {})
    );
    aws.failNext.set('CreateUserPoolCommand', [transient500()]);

    const second = await createWithRetry();

    expect(aws.pools.map((p) => p.Id)).toEqual([first.physicalId, second.physicalId]);
    expect(orphanLine()).toBeUndefined();
  });

  it('names at most five candidates, then an ellipsis', async () => {
    for (let i = 0; i < 6; i++) aws.seed({ Id: `us-east-1_twin${i}`, Name: `${STACK}-Pool` });
    aws.failNext.set('CreateUserPoolCommand', [transient500()]);

    await createWithRetry();

    const line = orphanLine()!;
    expect(line).toContain('6 user pool(s)');
    expect(line).toContain('us-east-1_twin4, ...');
    expect(line).not.toContain('us-east-1_twin5');
  });

  it('masks a secret-derived pool name in the report', async () => {
    aws.loseNextCreateResponse = transient500();

    await createWithRetry(
      { UserPoolName: 'hunter2-pool' },
      { maskSecrets: (t) => t.split('hunter2-pool').join('***') }
    );

    const line = orphanLine()!;
    expect(line).toContain('us-east-1_pool1');
    expect(line).not.toContain('hunter2');
  });

  it('masks the pool name as a WHOLE value, which a substring masker misses for a short secret', async () => {
    aws.loseNextCreateResponse = transient500();

    // The real masker's whole-value arm: it matches the bare value only, so the
    // name must be masked BEFORE it joins the sentence.
    await createWithRetry({ UserPoolName: 'zq' }, { maskSecrets: (t) => (t === 'zq' ? '***' : t) });

    const line = orphanLine()!;
    expect(line).toContain('us-east-1_pool1');
    expect(line).not.toContain('named zq');
  });

  describe('the lookup itself', () => {
    it.each([
      ['TRANSIENT', transient500],
      ['THROTTLED', throttled],
    ])('a %s ListUserPools failure warns and lets the create proceed (nothing adopts)', async (_kind, failure) => {
      aws.loseNextCreateResponse = transient500();
      aws.failNext.set('ListUserPoolsCommand', [failure()]);

      const result = await createWithRetry();

      expect(aws.count('ListUserPoolsCommand')).toBe(1);
      expect(aws.count('CreateUserPoolCommand')).toBe(2);
      expect(result.physicalId).toBe('us-east-1_pool2');
      expect(warnLines().some((l) => l.includes('could not look for it'))).toBe(true);
    });

    it('a DEFINITE ListUserPools failure warns and lets the create proceed', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.failNext.set('ListUserPoolsCommand', [propagationDenied()]);

      const result = await createWithRetry();

      expect(result.physicalId).toBe('us-east-1_pool2');
      expect(warnLines().some((l) => l.includes('could not look for it'))).toBe(true);
    });

    it('follows pagination to an orphan on a later page', async () => {
      aws.pageSize = 1;
      aws.seed({ Id: 'us-east-1_a', Name: 'other-a' });
      aws.seed({ Id: 'us-east-1_b', Name: 'other-b' });
      aws.loseNextCreateResponse = transient500();

      await createWithRetry();

      expect(orphanLine()).toContain('us-east-1_pool1');
    });

    it('a listing cut at the page ceiling with NO candidate warns that the search was incomplete', async () => {
      aws.pageSize = 1;
      for (let i = 0; i < 60; i++) aws.seed({ Id: `us-east-1_x${i}`, Name: `other-${i}` });
      aws.failNext.set('CreateUserPoolCommand', [transient500()]);

      await createWithRetry();

      const line = warnLines().find((l) => l.includes('cut at 50 pages'));
      expect(line).toContain('No listed user pool');
    });

    it('an empty, complete listing says so only at debug, and only of what was listed', async () => {
      aws.failNext.set('CreateUserPoolCommand', [transient500()]);

      await createWithRetry();

      expect(orphanLine()).toBeUndefined();
      const debug = debugSpy.mock.calls.map((c) => String(c[0]));
      expect(debug.some((l) => l.startsWith('No listed user pool'))).toBe(true);
    });
  });

  describe('what arms the lookup', () => {
    it('a DEFINITE CreateUserPool failure (a 4xx) triggers no lookup', async () => {
      aws.failNext.set('CreateUserPoolCommand', [propagationDenied()]);

      await createWithRetry();

      expect(aws.count('ListUserPoolsCommand')).toBe(0);
    });

    it('a THROTTLED CreateUserPool triggers no lookup', async () => {
      aws.failNext.set('CreateUserPoolCommand', [throttled()]);

      await createWithRetry();

      expect(aws.count('ListUserPoolsCommand')).toBe(0);
      expect(aws.pools).toHaveLength(1);
    });
  });

  describe('the SDK-internal retry (#3978 layer (b))', () => {
    const createClientConfig = () => sentVia.find(([name]) => name === 'CreateUserPoolCommand')?.[1];

    it('sends CreateUserPool through a client that refuses the SDK retry of a 5xx', async () => {
      await createWithRetry();

      const strategy = (await createClientConfig()!.retryStrategy()) as typeof baseStrategy;
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
      ).rejects.toThrow();
      // A throttle keeps the SDK's own retry.
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
      ).resolves.toBe('retry-token');
    });

    it('every other call keeps the full SDK retry', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry();

      const listConfig = sentVia.find(([name]) => name === 'ListUserPoolsCommand')![1];
      expect(await listConfig.retryStrategy()).toBe(baseStrategy);
    });
  });
});
