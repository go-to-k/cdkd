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
  /**
   * The `$metadata.attempts` the next successful CreateUserPool reports (issue
   * #4687): each attempt past the first is an SDK replay whose earlier attempt
   * reached Cognito, so it leaves one more pool behind first.
   */
  nextCreateAttempts: number | undefined;
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
        const attempts = this.nextCreateAttempts;
        this.nextCreateAttempts = undefined;
        for (let i = 1; i < (attempts ?? 1); i++) {
          this.seed({
            Id: `us-east-1_pool${this.nextId++}`,
            Name: input['PoolName'] as string,
            CreationDate: new Date(Date.now() + this.skewMs),
          });
        }
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
        return {
          UserPool: { ...this.pools[this.pools.length - 1]! },
          ...(attempts !== undefined && { $metadata: { attempts } }),
        };
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

  describe('a create the SDK replayed inside its send (issue #4687)', () => {
    const replayLine = (): string | undefined =>
      warnLines().find((l) => l.includes('succeeded only after the AWS SDK sent it again'));
    const createOnce = (props: Record<string, unknown> = {}) =>
      withStackName(STACK, () => provider.create('Pool', 'AWS::Cognito::UserPool', props));

    it('names the pool the first attempt left, never the one the create returned; nothing adopted or deleted', async () => {
      aws.nextCreateAttempts = 2;

      const result = await createOnce();

      expect(aws.pools.map((p) => p.Id)).toEqual(['us-east-1_pool1', 'us-east-1_pool2']);
      expect(result.physicalId).toBe('us-east-1_pool2');
      expect(aws.calls).toEqual(['CreateUserPoolCommand', 'ListUserPoolsCommand']);
      const line = replayLine();
      expect(line).toContain('The CreateUserPool call for Pool succeeded only after');
      expect(line).toContain('1 user pool(s) named MyStack-Pool');
      expect(line).toContain('describe-user-pool --user-pool-id us-east-1_pool1');
      expect(line).not.toContain('us-east-1_pool2');
      expect(line).toContain(
        'The pool the create returned and the candidate(s) above are ALL named MyStack-Pool'
      );
      expect(line).not.toContain('Creating a new');
      expect(line).toContain('does not adopt or delete');
      expect(orphanLine()).toBeUndefined();
    });

    it('a single-attempt create, or one with no $metadata, sends no lookup', async () => {
      aws.nextCreateAttempts = 1;
      await createOnce();
      await withStackName(STACK, () => provider.create('Other', 'AWS::Cognito::UserPool', {}));

      expect(aws.calls).toEqual(['CreateUserPoolCommand', 'CreateUserPoolCommand']);
      expect(warnLines()).toEqual([]);
    });

    it('reports the duplicate before the follow-up call, so that call failing cannot skip it', async () => {
      aws.nextCreateAttempts = 2;
      aws.failNext.set('SetUserPoolMfaConfigCommand', [
        Object.assign(new Error('bad MFA config'), {
          name: 'InvalidParameterException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        }),
      ]);

      await expect(
        createOnce({ MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] })
      ).rejects.toThrow();

      expect(aws.calls.slice(0, 3)).toEqual([
        'CreateUserPoolCommand',
        'ListUserPoolsCommand',
        'SetUserPoolMfaConfigCommand',
      ]);
      expect(replayLine()).toContain('describe-user-pool --user-pool-id us-east-1_pool1');
    });

    it('does not name a same-named pool created before the attempt started (a prior run)', async () => {
      aws.seed({
        Id: 'us-east-1_prior',
        Name: `${STACK}-Pool`,
        CreationDate: new Date(Date.now() - 60_000),
      });
      aws.nextCreateAttempts = 2;

      await createOnce();

      const line = replayLine();
      expect(line).toContain('us-east-1_pool1');
      expect(line).not.toContain('us-east-1_prior');
    });

    it('a failed ListUserPools after the replay warns with the replay lead and still returns the pool', async () => {
      aws.nextCreateAttempts = 2;
      aws.failNext.set('ListUserPoolsCommand', [
        Object.assign(new Error('not authorized to perform: cognito-idp:ListUserPools'), {
          name: 'AccessDeniedException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        }),
      ]);

      const result = await createOnce();

      expect(result.physicalId).toBe('us-east-1_pool2');
      expect(aws.calls).toEqual(['CreateUserPoolCommand', 'ListUserPoolsCommand']);
      const line = replayLine()!;
      expect(line).toContain('The CreateUserPool call for Pool succeeded only after');
      expect(line).toContain('cdkd could not look for it');
      expect(line).toContain('Check for a pool of that name created between');
      expect(line).not.toContain('Creating a new');
      expect(orphanLine()).toBeUndefined();
    });

    it('a pool a failed rollback left behind is still named by a later replayed create', async () => {
      // First create: replayed (pool1 orphan, pool2 returned), then its MFA
      // follow-up fails AND the rollback delete fails, so pool2 is left behind.
      aws.nextCreateAttempts = 2;
      const denied = (): Error =>
        Object.assign(new Error('denied'), {
          name: 'InvalidParameterException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        });
      aws.failNext.set('SetUserPoolMfaConfigCommand', [denied()]);
      aws.failNext.set('DeleteUserPoolCommand', [denied()]);
      await expect(
        createOnce({ MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] })
      ).rejects.toThrow();
      expect(aws.pools.map((p) => p.Id)).toContain('us-east-1_pool2');
      warnSpy.mockReset();

      // Second create of the same name, replayed again: pool3 orphan, pool4 returned.
      aws.nextCreateAttempts = 2;
      const result = await createOnce();

      expect(result.physicalId).toBe('us-east-1_pool4');
      const line = replayLine()!;
      // pool2 was excluded from the first lookup by id only, never added to
      // the process set, so it stays nameable now.
      expect(line).toContain('describe-user-pool --user-pool-id us-east-1_pool2');
      expect(line).toContain('describe-user-pool --user-pool-id us-east-1_pool3');
      expect(line).not.toContain('us-east-1_pool4');
    });

    it('the window opens at the ATTEMPT start minus the skew margin, not at the send end', async () => {
      const attemptStart = Date.now();
      aws.seed({
        Id: 'us-east-1_edge',
        Name: `${STACK}-Pool`,
        CreationDate: new Date(attemptStart - 5_000),
      });
      aws.seed({
        Id: 'us-east-1_stale',
        Name: `${STACK}-Pool`,
        CreationDate: new Date(attemptStart - 5_001),
      });
      // The replayed send takes 2 s: a floor taken at the send's END would be
      // attemptStart - 3 s and miss the edge pool.
      mockSend.mockImplementation(
        async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (command.constructor.name === 'CreateUserPoolCommand') {
            vi.setSystemTime(Date.now() + 2_000);
          }
          return aws.send(command);
        }
      );
      aws.nextCreateAttempts = 2;

      await createOnce();

      const line = replayLine()!;
      expect(line).toContain('between 2026-09-30T23:59:55.000Z and 2026-10-01T00:00:07.000Z');
      expect(line).toContain('us-east-1_edge');
      expect(line).not.toContain('us-east-1_stale');
    });
  });
});
