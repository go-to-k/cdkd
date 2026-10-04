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

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecs')>();
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => {
      const config = {
        region: () => Promise.resolve('us-east-1'),
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
  ECSProvider,
  resetTaskDefinitionCreateRetryStateForTests,
} from '../../../src/provisioning/providers/ecs-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';

/** The shape `isTransientServerError` / `isAmbiguousOutcomeError` classify (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('Internal failure'), {
    name: 'ServerException',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

/** A throttle identified BY NAME, on a 503 so only the name exempts it. */
const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

/** A definite refusal: ECS did nothing, and the message is an IAM-propagation retry pattern. */
const propagationDenied = (): Error =>
  Object.assign(
    new Error('User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: ecs:X'),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 400 } }
  );

/** Advance the fake clock on every backoff (issue #2080 acceptance item 3). */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

const ARN_PREFIX = 'arn:aws:ecs:us-east-1:123456789012:task-definition/';
const arnOf = (family: string, revision: number): string => `${ARN_PREFIX}${family}:${revision}`;

interface FakeRevision {
  family: string;
  revision: number;
  registeredAt: Date | undefined;
  status: 'ACTIVE' | 'INACTIVE';
}

/** A fake ECS. `revisions` counts RESOURCES, not calls (issue #2080 acceptance item 2). */
class FakeEcs {
  readonly revisions: FakeRevision[] = [];
  readonly calls: string[] = [];
  readonly failNext = new Map<string, Error[]>();
  /** RegisterTaskDefinition registers the revision, THEN throws this (a lost response). */
  loseNextCreateResponse: Error | undefined;
  /** ARNs per `ListTaskDefinitions` page. */
  pageSize = 100;
  /** Runs on every `ListTaskDefinitions`, to stage what the NEXT create does. */
  onList: (() => void) | undefined;
  /** ARNs `DescribeTaskDefinition` answers missing for (deleted after the listing). */
  readonly goneOnDescribe = new Set<string>();
  /** ARNs `DescribeTaskDefinition` reports INACTIVE for (deregistered after the listing). */
  readonly deregisteredOnDescribe = new Set<string>();

  /** `registeredAt: null` seeds a revision with no `registeredAt` at all. */
  seed(family: string, registeredAt: Date | null = new Date(Date.now())): string {
    const revision = this.revisions.filter((r) => r.family === family).length + 1;
    this.revisions.push({
      family,
      revision,
      registeredAt: registeredAt ?? undefined,
      status: 'ACTIVE',
    });
    return arnOf(family, revision);
  }

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const queued = this.failNext.get(name);
    if (queued && queued.length > 0) throw queued.shift();
    const input = command.input;
    switch (name) {
      case 'RegisterTaskDefinitionCommand': {
        const arn = this.seed(input['family'] as string);
        if (this.loseNextCreateResponse) {
          const error = this.loseNextCreateResponse;
          this.loseNextCreateResponse = undefined;
          throw error;
        }
        return { taskDefinition: { taskDefinitionArn: arn } };
      }
      case 'ListTaskDefinitionsCommand': {
        this.onList?.();
        // Like ECS, `familyPrefix` is matched as a PREFIX here, so a test can
        // prove the provider compares the family exactly.
        const prefix = input['familyPrefix'] as string;
        const matching = this.revisions
          .filter((r) => r.family.startsWith(prefix) && r.status === input['status'])
          .sort((a, b) =>
            a.family === b.family ? b.revision - a.revision : b.family.localeCompare(a.family)
          );
        const start = input['nextToken'] === undefined ? 0 : Number(input['nextToken']);
        const end = start + this.pageSize;
        return {
          taskDefinitionArns: matching.slice(start, end).map((r) => arnOf(r.family, r.revision)),
          ...(end < matching.length && { nextToken: String(end) }),
        };
      }
      case 'DescribeTaskDefinitionCommand': {
        const arn = input['taskDefinition'] as string;
        const r = this.revisions.find((x) => arnOf(x.family, x.revision) === arn);
        if (!r || this.goneOnDescribe.has(arn)) {
          throw Object.assign(new Error('Unable to describe task definition.'), {
            name: 'ClientException',
            $fault: 'client',
            $metadata: { httpStatusCode: 400 },
          });
        }
        return {
          taskDefinition: {
            taskDefinitionArn: arn,
            registeredAt: r.registeredAt,
            status: this.deregisteredOnDescribe.has(arn) ? 'INACTIVE' : r.status,
          },
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

const PROPS = {
  Family: 'web',
  ContainerDefinitions: [{ Name: 'app', Image: 'nginx' }],
};

describe('ECSProvider RegisterTaskDefinition retry safety (issue #2080, detection only)', () => {
  let provider: ECSProvider;
  let aws: FakeEcs;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    resetTaskDefinitionCreateRetryStateForTests();
    aws = new FakeEcs();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    debugSpy.mockReset();
    sentVia.length = 0;
    provider = new ECSProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createWithRetry = (props: Record<string, unknown> = PROPS, logicalId = 'TaskDef') =>
    withRetry(() => provider.create(logicalId, 'AWS::ECS::TaskDefinition', props), logicalId, {
      sleep: advancingSleep,
    });

  const warnLines = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));
  const reportLine = (): string | undefined =>
    warnLines().find((l) => l.includes('earlier RegisterTaskDefinition attempt'));

  it('names the revision a lost response registered, with a read and then a deregister command', async () => {
    aws.loseNextCreateResponse = transient500();

    const result = await createWithRetry();

    // Two revisions exist (the duplicate is REPORTED, not prevented); state gets the second.
    expect(aws.revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(result.physicalId).toBe(arnOf('web', 2));
    expect(aws.calls).not.toContain('DeregisterTaskDefinitionCommand');
    const line = reportLine()!;
    expect(line).toContain('ECS may have created a revision of task definition family web');
    expect(line).toContain(`1 task definition revision(s) were created between`);
    expect(line).toContain(
      `aws ecs describe-task-definition --task-definition ${arnOf('web', 1)} --region us-east-1`
    );
    expect(line).toContain(
      `deregister it: aws ecs deregister-task-definition --task-definition ${arnOf('web', 1)} --region us-east-1`
    );
    expect(line.indexOf('describe-task-definition')).toBeLessThan(
      line.indexOf('deregister-task-definition')
    );
    expect(line).toContain('does not adopt or delete');
  });

  it('does not report an older revision, one of a prefix-sharing family, or one this process registered', async () => {
    aws.seed('web', new Date('2026-09-01T00:00:00Z')); // web:1, before the window
    const earlier = await provider.create('Other', 'AWS::ECS::TaskDefinition', PROPS); // web:2
    aws.seed('web-admin'); // a family `familyPrefix` would also match
    aws.loseNextCreateResponse = transient500(); // web:3 lost, web:4 recorded

    await createWithRetry();

    const line = reportLine()!;
    expect(line).toContain('1 task definition revision(s) were created');
    expect(line).toContain(arnOf('web', 3));
    expect(line).not.toContain(arnOf('web', 1));
    expect(line).not.toContain(earlier.physicalId);
    expect(line).not.toContain('web-admin');
  });

  it('stops at the first revision registered before the window, newest first', async () => {
    for (let i = 0; i < 5; i++) aws.seed('web', new Date('2026-09-01T00:00:00Z'));
    aws.loseNextCreateResponse = transient500(); // web:6

    await createWithRetry();

    expect(reportLine()).toContain(arnOf('web', 6));
    // web:6 (in the window) and web:5 (before it); nothing older is described.
    expect(aws.count('DescribeTaskDefinitionCommand')).toBe(2);
  });

  it('stops at a revision with no registeredAt, which only predates the field', async () => {
    aws.seed('web', null);
    aws.seed('web', null);
    aws.loseNextCreateResponse = transient500(); // web:3

    await createWithRetry();

    expect(reportLine()).toContain(arnOf('web', 3));
    expect(aws.count('DescribeTaskDefinitionCommand')).toBe(2);
  });

  it('follows ListTaskDefinitions pagination to a candidate on a later page', async () => {
    aws.pageSize = 1;
    aws.seed('web-admin');
    aws.seed('web-admin');
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    // `web-admin` sorts first descending, so `web:1` is on the third page.
    expect(reportLine()).toContain(arnOf('web', 1));
  });

  it('a listing cut at the page ceiling says the search was incomplete', async () => {
    aws.pageSize = 1;
    // Twenty revisions of a prefix-sharing family sort first and fill every page.
    for (let i = 0; i < 20; i++) aws.seed('web-admin');
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    expect(aws.count('ListTaskDefinitionsCommand')).toBe(20);
    expect(
      warnLines().some((l) => l.includes('The search was incomplete: the list was cut at 20 pages'))
    ).toBe(true);
  });

  it('a candidate deleted between the listing and its read is skipped, not a failed lookup', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.onList = () => {
      aws.goneOnDescribe.add(arnOf('web', 1));
      aws.onList = undefined;
    };

    await createWithRetry();

    expect(warnLines().some((l) => l.includes('could not look'))).toBe(false);
    expect(reportLine()).toBeUndefined();
  });

  it('a candidate deregistered between the listing and its read is not reported', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.onList = () => {
      aws.deregisteredOnDescribe.add(arnOf('web', 1));
      aws.onList = undefined;
    };

    await createWithRetry();

    expect(warnLines().some((l) => l.includes('could not look'))).toBe(false);
    expect(reportLine()).toBeUndefined();
  });

  it('a candidate read that fails for another reason warns that cdkd could not look', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.failNext.set('DescribeTaskDefinitionCommand', [propagationDenied()]);

    const result = await createWithRetry();

    expect(result.physicalId).toBe(arnOf('web', 2));
    expect(reportLine()).toContain('cdkd could not look for it (ListTaskDefinitions');
  });

  it('does not report a revision registered after the window closed', async () => {
    aws.loseNextCreateResponse = transient500(); // web:1, inside the window
    aws.onList = () => {
      // Registered now, 30 s after the failed attempt: past its ceiling.
      aws.seed('web');
      aws.onList = undefined;
    };

    await withRetry(() => provider.create('TaskDef', 'AWS::ECS::TaskDefinition', PROPS), 'TaskDef', {
      sleep: (): Promise<void> => {
        vi.setSystemTime(Date.now() + 30_000);
        return Promise.resolve();
      },
    });

    const line = reportLine()!;
    expect(line).toContain('1 task definition revision(s) were created');
    expect(line).toContain(arnOf('web', 1));
    expect(line).not.toContain(arnOf('web', 2));
  });

  it('a revision registered exactly at the window floor is still a candidate', async () => {
    // The attempt starts at the suite's epoch; the floor is 5 s before it.
    aws.seed('web', new Date(Date.now() - 5_000)); // web:1, at the floor
    aws.loseNextCreateResponse = transient500(); // web:2

    await createWithRetry();

    const line = reportLine()!;
    expect(line).toContain('2 task definition revision(s) were created');
    expect(line).toContain(arnOf('web', 1));
    expect(line).toContain(arnOf('web', 2));
  });

  it('two ambiguous attempts in a row: the second report dates from the FIRST attempt', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.onList = () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = undefined;
    };

    await withRetry(() => provider.create('TaskDef', 'AWS::ECS::TaskDefinition', PROPS), 'TaskDef', {
      sleep: (): Promise<void> => {
        vi.setSystemTime(Date.now() + 30_000);
        return Promise.resolve();
      },
    });

    const lines = warnLines().filter((l) => l.includes('earlier RegisterTaskDefinition attempt'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('between 2026-09-30T23:59:55.000Z');
    expect(lines[1]).toContain(arnOf('web', 1));
    expect(lines[1]).toContain(arnOf('web', 2));
    expect(aws.revisions).toHaveLength(3);
  });

  it('masks a secret-derived family in the report', async () => {
    aws.loseNextCreateResponse = transient500();

    await withRetry(
      () =>
        provider.create(
          'TaskDef',
          'AWS::ECS::TaskDefinition',
          { ...PROPS, Family: 'hunter2fam' },
          { maskSecrets: (t) => t.split('hunter2fam').join('***') }
        ),
      'TaskDef',
      { sleep: advancingSleep }
    );

    const line = reportLine()!;
    expect(line).toContain('1 task definition revision(s)');
    expect(line).not.toContain('hunter2fam');
  });

  // `log.value(family)` and the derived-name needle `withDerivedNameMasks`
  // adds for a secret-derived family each mask this alone; the case pins the
  // OUTCOME for a secret below the substring masker's floor.
  it('masks a short secret-derived family, below the substring masker floor', async () => {
    aws.loseNextCreateResponse = transient500();

    await withRetry(
      () =>
        provider.create(
          'TaskDef',
          'AWS::ECS::TaskDefinition',
          { ...PROPS, Family: 'zq' },
          { maskSecrets: (t) => (t === 'zq' ? '***' : t) }
        ),
      'TaskDef',
      { sleep: advancingSleep }
    );

    const line = reportLine()!;
    expect(line).toContain('1 task definition revision(s)');
    expect(line).not.toContain('family zq');
    // The ARN in the describe / deregister commands, masked by the
    // derived-name needle alone.
    expect(line).not.toContain('task-definition/zq');
  });

  it('a throttled register (by name) triggers no lookup', async () => {
    aws.failNext.set('RegisterTaskDefinitionCommand', [throttled()]);

    await createWithRetry();

    expect(aws.count('ListTaskDefinitionsCommand')).toBe(0);
    expect(aws.revisions).toHaveLength(1);
  });

  it('a DEFINITE register failure (a 4xx) triggers no lookup', async () => {
    aws.failNext.set('RegisterTaskDefinitionCommand', [propagationDenied()]);

    await createWithRetry();

    expect(aws.count('ListTaskDefinitionsCommand')).toBe(0);
    expect(aws.revisions).toHaveLength(1);
  });

  it('sends RegisterTaskDefinition through a client that refuses the SDK retry of a 5xx, and nothing else', async () => {
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    const createConfig = sentVia.find(([name]) => name === 'RegisterTaskDefinitionCommand')![1];
    const strategy = (await createConfig.retryStrategy()) as typeof baseStrategy;
    await expect(
      strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
    ).rejects.toThrow();
    await expect(
      strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
    ).resolves.toBe('retry-token');
    for (const other of ['ListTaskDefinitionsCommand', 'DescribeTaskDefinitionCommand']) {
      const config = sentVia.find(([name]) => name === other)![1];
      expect(await config.retryStrategy()).toBe(baseStrategy);
    }
  });

  it('a failed ListTaskDefinitions warns and lets the create proceed', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.failNext.set('ListTaskDefinitionsCommand', [propagationDenied()]);

    const result = await createWithRetry();

    expect(result.physicalId).toBe(arnOf('web', 2));
    expect(
      warnLines().some((l) => l.includes('cdkd could not look for it (ListTaskDefinitions'))
    ).toBe(true);
  });

  it('takes the latch once: a later clean create of the same logical id looks nothing up', async () => {
    aws.loseNextCreateResponse = transient500();
    await createWithRetry(PROPS, 'Shared');
    warnSpy.mockReset();

    await provider.create('Shared', 'AWS::ECS::TaskDefinition', PROPS);

    expect(reportLine()).toBeUndefined();
    expect(aws.count('ListTaskDefinitionsCommand')).toBe(1);
  });
});
