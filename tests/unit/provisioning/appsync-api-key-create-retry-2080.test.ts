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

// The key's ARN is rebuilt after the create from the deploy's account.
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: async () => ({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

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
 * AppSync's modeled throttle, identified BY NAME. On a 503 so that only the
 * name exemption keeps it from arming the latch (a 4xx would never reach it).
 */
const throttled = (): Error =>
  Object.assign(new Error('The request exceeded a limit. Try your request again.'), {
    name: 'LimitExceededException',
    $fault: 'server',
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

interface FakeKey {
  id: string;
  apiId: string;
  description?: string;
  expires?: number;
}

/** Key ids shaped like AppSync's (`da2-` + 26 chars); the suffix is what the report may print. */
const keyId = (n: number): string => `da2-secretsecretsecretsec${String(n).padStart(4, '0')}`;

/** A fake AppSync. `keys` counts RESOURCES, not calls (issue #2080 acceptance item 2). */
class FakeAppSync {
  readonly keys: FakeKey[] = [];
  readonly calls: string[] = [];
  readonly failNext = new Map<string, Error[]>();
  /** CreateApiKey creates the key, THEN throws this (a lost response). */
  loseNextCreateResponse: Error | undefined;
  /** Keys per `ListApiKeys` page. */
  pageSize = 25;
  /** Runs on every `ListApiKeys`, to stage what the NEXT create does. */
  onList: (() => void) | undefined;
  /**
   * The `$metadata.attempts` the next successful CreateApiKey reports (issue
   * #4687): each attempt past the first is an SDK replay whose earlier attempt
   * reached AppSync, so it leaves one more key behind first.
   */
  nextCreateAttempts: number | undefined;
  private nextId = 1;

  seed(key: Omit<FakeKey, 'id'> & { id?: string }): string {
    const id = key.id ?? keyId(this.nextId++);
    this.keys.push({ ...key, id });
    return id;
  }

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const queued = this.failNext.get(name);
    if (queued && queued.length > 0) throw queued.shift();
    const input = command.input;
    switch (name) {
      case 'CreateApiKeyCommand': {
        const attempts = this.nextCreateAttempts;
        this.nextCreateAttempts = undefined;
        for (let i = 1; i < (attempts ?? 1); i++) {
          this.seed({
            apiId: input['apiId'] as string,
            ...(input['description'] !== undefined && {
              description: input['description'] as string,
            }),
          });
        }
        const id = this.seed({
          apiId: input['apiId'] as string,
          ...(input['description'] !== undefined && {
            description: input['description'] as string,
          }),
          // AWS's default: 7 days out, rounded down to the hour.
          expires:
            (input['expires'] as number | undefined) ??
            Math.floor((Date.now() / 1000 + 7 * 86400) / 3600) * 3600,
        });
        if (this.loseNextCreateResponse) {
          const error = this.loseNextCreateResponse;
          this.loseNextCreateResponse = undefined;
          throw error;
        }
        const key = this.keys.find((k) => k.id === id)!;
        return {
          apiKey: { id: key.id, description: key.description, expires: key.expires },
          ...(attempts !== undefined && { $metadata: { attempts } }),
        };
      }
      case 'ListApiKeysCommand': {
        this.onList?.();
        const onApi = this.keys.filter((k) => k.apiId === input['apiId']);
        const start = input['nextToken'] === undefined ? 0 : Number(input['nextToken']);
        const end = start + this.pageSize;
        return {
          apiKeys: onApi.slice(start, end).map(({ apiId: _apiId, ...k }) => ({ ...k })),
          ...(end < onApi.length && { nextToken: String(end) }),
        };
      }
      default:
        return {};
    }
  };

  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
}

const KEY_PROPS = { ApiId: 'api1', Description: 'orders key' };

describe('AppSyncProvider CreateApiKey retry safety (issue #2080, detection only)', () => {
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

  const createWithRetry = (props: Record<string, unknown> = KEY_PROPS, logicalId = 'Key') =>
    withRetry(() => provider.create(logicalId, 'AWS::AppSync::ApiKey', props), logicalId, {
      sleep: advancingSleep,
    });

  const warnLines = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));
  const reportLine = (): string | undefined =>
    warnLines().find((l) => l.includes('earlier CreateApiKey attempt'));

  it('names the key a lost response created, and neither adopts nor deletes it', async () => {
    aws.loseNextCreateResponse = transient500();

    const result = await createWithRetry();

    // Two keys exist (the duplicate is REPORTED, not prevented); state gets the second.
    expect(aws.keys.map((k) => k.id)).toEqual([keyId(1), keyId(2)]);
    expect(result.physicalId).toBe(`api1|${keyId(2)}`);
    expect(aws.calls).not.toContain('DeleteApiKeyCommand');
    const line = reportLine();
    expect(line).toContain('****0001 (expires 2026-10-08T00:00:00.000Z)');
    expect(line).toContain('AppSync may have created an API key on GraphQL API api1');
    // No creation date to attribute by, so a READ command only, never a delete.
    expect(line).toContain('aws appsync list-api-keys --api-id api1 --region us-east-1');
    expect(line).not.toContain('delete-api-key');
    expect(line).toContain('does not adopt or delete');
  });

  it('never prints a candidate key id in full: the id is the credential', async () => {
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    for (const line of [...warnLines(), ...debugSpy.mock.calls.map((c) => String(c[0]))]) {
      if (line.includes('earlier CreateApiKey attempt')) {
        expect(line).not.toContain(keyId(1));
        expect(line).not.toContain('secretsecret');
      }
    }
  });

  it('an unreadable client region drops only the --region fragment, never the report (issue #4307)', async () => {
    aws.loseNextCreateResponse = transient500();
    clientRegion = () => Promise.reject(new Error('region unavailable'));
    try {
      await createWithRetry();
    } finally {
      clientRegion = () => Promise.resolve('us-east-1');
    }

    const line = reportLine();
    expect(line).toContain('aws appsync list-api-keys --api-id api1');
    expect(line).not.toContain('--region');
  });

  it('does not report a key this process recorded, one of another description, or one on another API', async () => {
    const earlier = await provider.create('Other', 'AWS::AppSync::ApiKey', KEY_PROPS);
    aws.seed({ id: 'da2-zzzzzzzzzzzzzzzzzzzzzzOTHR', apiId: 'api1', description: 'billing key' });
    aws.seed({ id: 'da2-zzzzzzzzzzzzzzzzzzzzzzELSE', apiId: 'api2', description: 'orders key' });
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    const line = reportLine()!;
    expect(line).toContain('1 API key(s) match');
    expect(line).toContain('****0002');
    expect(line).not.toContain(`****${earlier.physicalId.slice(-4)}`);
    expect(line).not.toContain('OTHR');
    expect(line).not.toContain('ELSE');
  });

  it('matches a key with no description against a create with none', async () => {
    aws.seed({ id: 'da2-zzzzzzzzzzzzzzzzzzzzzzDESC', apiId: 'api1', description: 'described' });
    aws.loseNextCreateResponse = transient500();

    await createWithRetry({ ApiId: 'api1' });

    const line = reportLine()!;
    expect(line).toContain('1 API key(s) match');
    expect(line).toContain('****0001');
    expect(line).not.toContain('DESC');
    expect(line).not.toContain(' described ');
  });

  it('follows ListApiKeys pagination to a candidate on a later page', async () => {
    aws.pageSize = 1;
    aws.seed({ id: 'da2-zzzzzzzzzzzzzzzzzzzzzzAAAA', apiId: 'api1', description: 'a' });
    aws.seed({ id: 'da2-zzzzzzzzzzzzzzzzzzzzzzBBBB', apiId: 'api1', description: 'b' });
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    expect(reportLine()).toContain('****0001');
  });

  it('two ambiguous attempts in a row: the second report dates from the FIRST attempt', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.onList = () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = undefined;
    };

    await withRetry(() => provider.create('Key', 'AWS::AppSync::ApiKey', KEY_PROPS), 'Key', {
      sleep: (): Promise<void> => {
        vi.setSystemTime(Date.now() + 30_000);
        return Promise.resolve();
      },
    });

    const lines = warnLines().filter((l) => l.includes('earlier CreateApiKey attempt'));
    expect(lines).toHaveLength(2);
    // The first attempt started at the suite's epoch, minus the 5 s margin.
    expect(lines[1]).toContain('(at 2026-09-30T23:59:55.000Z)');
    expect(lines[1]).toContain('****0001');
    expect(lines[1]).toContain('****0002');
    expect(aws.keys).toHaveLength(3);
  });

  it('masks a secret-derived description in the report', async () => {
    aws.loseNextCreateResponse = transient500();

    await withRetry(
      () =>
        provider.create(
          'Key',
          'AWS::AppSync::ApiKey',
          { ...KEY_PROPS, Description: 'hunter2-key' },
          { maskSecrets: (t) => t.split('hunter2-key').join('***') }
        ),
      'Key',
      { sleep: advancingSleep }
    );

    const line = reportLine()!;
    expect(line).toContain('****0001');
    expect(line).not.toContain('hunter2');
  });

  it('masks the description as a WHOLE value, which a substring masker misses for a short secret', async () => {
    aws.loseNextCreateResponse = transient500();

    await withRetry(
      () =>
        provider.create(
          'Key',
          'AWS::AppSync::ApiKey',
          { ...KEY_PROPS, Description: 'zq' },
          { maskSecrets: (t) => (t === 'zq' ? '***' : t) }
        ),
      'Key',
      { sleep: advancingSleep }
    );

    const line = reportLine()!;
    expect(line).toContain('****0001');
    expect(line).not.toContain('described zq');
  });

  it('a throttled CreateApiKey (by name) triggers no lookup', async () => {
    aws.failNext.set('CreateApiKeyCommand', [throttled()]);

    await createWithRetry();

    expect(aws.count('ListApiKeysCommand')).toBe(0);
    expect(aws.keys).toHaveLength(1);
  });

  it('a DEFINITE CreateApiKey failure (a 4xx) triggers no lookup', async () => {
    aws.failNext.set('CreateApiKeyCommand', [propagationDenied()]);

    await createWithRetry();

    expect(aws.count('ListApiKeysCommand')).toBe(0);
    expect(aws.keys).toHaveLength(1);
  });

  it('sends CreateApiKey through a client that refuses the SDK retry of a 5xx, and nothing else', async () => {
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    const createConfig = sentVia.find(([name]) => name === 'CreateApiKeyCommand')![1];
    const strategy = (await createConfig.retryStrategy()) as typeof baseStrategy;
    await expect(
      strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
    ).rejects.toThrow();
    await expect(
      strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
    ).resolves.toBe('retry-token');
    const listConfig = sentVia.find(([name]) => name === 'ListApiKeysCommand')![1];
    expect(await listConfig.retryStrategy()).toBe(baseStrategy);
  });

  it('a failed ListApiKeys warns and lets the create proceed', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.failNext.set('ListApiKeysCommand', [propagationDenied()]);

    const result = await createWithRetry();

    expect(result.physicalId).toBe(`api1|${keyId(2)}`);
    expect(warnLines().some((l) => l.includes('cdkd could not look for it (ListApiKeys'))).toBe(
      true
    );
  });

  it('looks up once per ambiguous failure, not again on a later DEFINITE failure', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.onList = () => {
      aws.failNext.set('CreateApiKeyCommand', [propagationDenied()]);
      aws.onList = undefined;
    };

    await createWithRetry();

    expect(aws.count('ListApiKeysCommand')).toBe(1);
    expect(aws.keys).toHaveLength(2);
  });

  it('takes the latch once: a later clean create of the same logical id looks nothing up', async () => {
    aws.loseNextCreateResponse = transient500();
    await createWithRetry(KEY_PROPS, 'Shared');
    warnSpy.mockReset();

    // A clean key create under the same logical id reports nothing.
    await provider.create('Shared', 'AWS::AppSync::ApiKey', KEY_PROPS);

    expect(reportLine()).toBeUndefined();
    expect(aws.count('ListApiKeysCommand')).toBe(1);
  });

  describe('a create the SDK replayed inside its send (issue #4687)', () => {
    const replayLine = (): string | undefined =>
      warnLines().find((l) => l.includes('succeeded only after the AWS SDK sent it again'));

    it('names the key the first attempt left, never the one the create returned; nothing adopted or deleted', async () => {
      aws.nextCreateAttempts = 2;

      const result = await provider.create('Key', 'AWS::AppSync::ApiKey', KEY_PROPS);

      expect(aws.keys.map((k) => k.id)).toEqual([keyId(1), keyId(2)]);
      expect(result.physicalId).toBe(`api1|${keyId(2)}`);
      expect(aws.calls).toEqual(['CreateApiKeyCommand', 'ListApiKeysCommand']);
      const line = replayLine();
      expect(line).toContain('The CreateApiKey call for Key succeeded only after');
      expect(line).toContain('****0001');
      expect(line).not.toContain('****0002');
      expect(line).not.toContain(keyId(1));
      expect(line).toContain('cdkd recorded the one the create returned.');
      expect(line).not.toContain('Creating a new');
      expect(line).toContain('does not adopt or delete');
      expect(reportLine()).toBeUndefined();
    });

    it('a single-attempt create, or one with no $metadata, sends no lookup', async () => {
      aws.nextCreateAttempts = 1;
      await provider.create('Key', 'AWS::AppSync::ApiKey', KEY_PROPS);
      await provider.create('Other', 'AWS::AppSync::ApiKey', KEY_PROPS);

      expect(aws.calls).toEqual(['CreateApiKeyCommand', 'CreateApiKeyCommand']);
      expect(warnLines()).toEqual([]);
    });

    it('a failed ListApiKeys after the replay warns with the replay lead and still returns the key', async () => {
      aws.nextCreateAttempts = 2;
      aws.failNext.set('ListApiKeysCommand', [
        Object.assign(new Error('not authorized to perform: appsync:ListApiKeys'), {
          name: 'AccessDeniedException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        }),
      ]);

      const result = await provider.create('Key', 'AWS::AppSync::ApiKey', KEY_PROPS);

      expect(result.physicalId).toBe(`api1|${keyId(2)}`);
      expect(aws.calls).toEqual(['CreateApiKeyCommand', 'ListApiKeysCommand']);
      const line = replayLine()!;
      expect(line).toContain('The CreateApiKey call for Key succeeded only after');
      expect(line).toContain('cdkd could not look for it');
      expect(line).toContain('. Check for a duplicate.');
      expect(line).not.toContain('Creating it again');
    });
  });
});
