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

vi.mock('@aws-sdk/client-dlm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dlm')>();
  return {
    ...actual,
    DLMClient: vi.fn().mockImplementation(() => {
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

import { ResourceNotFoundException } from '@aws-sdk/client-dlm';
import {
  DLMLifecyclePolicyProvider,
  resetLifecyclePolicyCreateRetryStateForTests,
} from '../../../src/provisioning/providers/dlm-lifecycle-policy-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';

/** The shape `isTransientServerError` / `isAmbiguousOutcomeError` classify (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('Internal failure'), {
    name: 'InternalServerException',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

/** DLM's modeled throttle, identified BY NAME, on a 503 so only the name exempts it. */
const throttled = (): Error =>
  Object.assign(new Error('The request was throttled.'), {
    name: 'LimitExceededException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

/** A definite refusal: DLM did nothing, and the message is an IAM-propagation retry pattern. */
const propagationDenied = (): Error =>
  Object.assign(
    new Error('User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: dlm:X'),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 400 } }
  );

/** Advance the fake clock on every backoff (issue #2080 acceptance item 3). */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

interface FakePolicy {
  id: string;
  description?: string;
  defaultPolicy: boolean;
  /** A default policy's `PolicyDetails.ResourceType` (`VOLUME` / `INSTANCE`). */
  resourceType?: string;
  created: Date;
}

/** A fake DLM. `policies` counts RESOURCES, not calls (issue #2080 acceptance item 2). */
class FakeDlm {
  readonly policies: FakePolicy[] = [];
  readonly calls: string[] = [];
  readonly failNext = new Map<string, Error[]>();
  /** CreateLifecyclePolicy creates the policy, THEN throws this (a lost response). */
  loseNextCreateResponse: Error | undefined;
  /** Runs on every `GetLifecyclePolicies`, to stage what the NEXT create does. */
  onList: (() => void) | undefined;
  /** Policy ids `GetLifecyclePolicy` answers not-found for (deleted after the listing). */
  readonly goneOnGet = new Set<string>();
  private nextId = 1;

  seed(policy: Omit<FakePolicy, 'id' | 'created'> & { created?: Date }): string {
    const id = `policy-${String(this.nextId++).padStart(17, '0')}`;
    this.policies.push({ ...policy, id, created: policy.created ?? new Date(Date.now()) });
    return id;
  }

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const queued = this.failNext.get(name);
    if (queued && queued.length > 0) throw queued.shift();
    const input = command.input;
    switch (name) {
      case 'CreateLifecyclePolicyCommand': {
        const id = this.seed({
          ...(input['Description'] !== undefined && {
            description: input['Description'] as string,
          }),
          defaultPolicy: input['DefaultPolicy'] !== undefined,
          ...(input['DefaultPolicy'] !== undefined && {
            resourceType: input['DefaultPolicy'] as string,
          }),
        });
        if (this.loseNextCreateResponse) {
          const error = this.loseNextCreateResponse;
          this.loseNextCreateResponse = undefined;
          throw error;
        }
        return { PolicyId: id };
      }
      case 'GetLifecyclePoliciesCommand': {
        this.onList?.();
        return {
          Policies: this.policies.map((p) => ({
            PolicyId: p.id,
            Description: p.description,
            DefaultPolicy: p.defaultPolicy,
          })),
        };
      }
      case 'GetLifecyclePolicyCommand': {
        const policy = this.policies.find((p) => p.id === input['PolicyId']);
        if (!policy || this.goneOnGet.has(policy.id)) {
          throw new ResourceNotFoundException({ message: 'not found', $metadata: {} });
        }
        return {
          Policy: {
            PolicyId: policy.id,
            DateCreated: policy.created,
            ...(policy.resourceType !== undefined && {
              PolicyDetails: { ResourceType: policy.resourceType },
            }),
            PolicyArn: `arn:aws:dlm:us-east-1:123456789012:policy/${policy.id}`,
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
  Description: 'nightly snapshots',
  State: 'ENABLED',
  ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
  PolicyDetails: { ResourceTypes: ['VOLUME'] },
};

describe('DLMLifecyclePolicyProvider CreateLifecyclePolicy retry safety (issue #2080, detection only)', () => {
  let provider: DLMLifecyclePolicyProvider;
  let aws: FakeDlm;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    resetLifecyclePolicyCreateRetryStateForTests();
    aws = new FakeDlm();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    debugSpy.mockReset();
    sentVia.length = 0;
    provider = new DLMLifecyclePolicyProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createWithRetry = (props: Record<string, unknown> = PROPS, logicalId = 'Policy') =>
    withRetry(() => provider.create(logicalId, 'AWS::DLM::LifecyclePolicy', props), logicalId, {
      sleep: advancingSleep,
    });

  const warnLines = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));
  const reportLine = (): string | undefined =>
    warnLines().find((l) => l.includes('earlier CreateLifecyclePolicy attempt'));

  it('names the policy a lost response created, with a read and then a delete command', async () => {
    aws.loseNextCreateResponse = transient500();

    const result = await createWithRetry();

    // Two policies exist (the duplicate is REPORTED, not prevented); state gets the second.
    expect(aws.policies.map((p) => p.id)).toEqual([
      'policy-00000000000000001',
      'policy-00000000000000002',
    ]);
    expect(result.physicalId).toBe('policy-00000000000000002');
    expect(aws.calls).not.toContain('DeleteLifecyclePolicyCommand');
    const line = reportLine()!;
    expect(line).toContain('DLM may have created a lifecycle policy described nightly snapshots');
    expect(line).toContain('1 lifecycle policy(ies) were created between');
    expect(line).toContain(
      'aws dlm get-lifecycle-policy --policy-id policy-00000000000000001 --region us-east-1'
    );
    expect(line).toContain(
      'aws dlm delete-lifecycle-policy --policy-id policy-00000000000000001 --region us-east-1'
    );
    expect(line.indexOf('get-lifecycle-policy')).toBeLessThan(
      line.indexOf('delete-lifecycle-policy')
    );
    expect(line).toContain('does not adopt or delete');
  });

  it('does not report a policy outside the window, of another description or kind, or recorded by this process', async () => {
    const earlier = await provider.create('Other', 'AWS::DLM::LifecyclePolicy', PROPS);
    aws.seed({
      description: 'nightly snapshots',
      defaultPolicy: false,
      created: new Date('2026-09-01T00:00:00Z'),
    });
    aws.seed({ description: 'weekly snapshots', defaultPolicy: false });
    aws.seed({ description: 'nightly snapshots', defaultPolicy: true });
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    const line = reportLine()!;
    expect(line).toContain('1 lifecycle policy(ies) were created');
    expect(line).toContain('policy-00000000000000005');
    for (const id of [earlier.physicalId, 'policy-00000000000000002', 'policy-00000000000000003']) {
      expect(line).not.toContain(id);
    }
    expect(line).not.toContain('policy-00000000000000004');
  });

  it('matches a default policy only against a default-policy create', async () => {
    aws.seed({ description: 'nightly snapshots', defaultPolicy: false });
    aws.loseNextCreateResponse = transient500();

    await createWithRetry({ ...PROPS, DefaultPolicy: 'VOLUME' });

    const line = reportLine()!;
    expect(line).toContain('1 lifecycle policy(ies) were created');
    expect(line).toContain('policy-00000000000000002');
    expect(line).not.toContain('policy-00000000000000001');
  });

  it('does not report a default policy of the other resource type', async () => {
    aws.seed({ description: 'nightly snapshots', defaultPolicy: true, resourceType: 'INSTANCE' });
    aws.loseNextCreateResponse = transient500();

    await createWithRetry({ ...PROPS, DefaultPolicy: 'VOLUME' });

    const line = reportLine()!;
    expect(line).toContain('DLM may have created a default lifecycle policy described');
    expect(line).toContain('1 lifecycle policy(ies) were created');
    expect(line).toContain('policy-00000000000000002');
    expect(line).not.toContain('policy-00000000000000001');
  });

  it('matches a policy with no description against a create with none, and says so', async () => {
    aws.seed({ description: 'described', defaultPolicy: true, resourceType: 'VOLUME' });
    aws.loseNextCreateResponse = transient500();
    const { Description: _omit, ...noDescription } = PROPS;

    await createWithRetry({ ...noDescription, DefaultPolicy: 'VOLUME' });

    const line = reportLine()!;
    expect(line).toContain('may have created a default lifecycle policy with no description');
    expect(line).toContain('1 lifecycle policy(ies) were created');
    expect(line).toContain('policy-00000000000000002');
    expect(line).not.toContain('policy-00000000000000001');
  });

  it('a candidate read that fails for another reason warns that cdkd could not look', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.failNext.set('GetLifecyclePolicyCommand', [propagationDenied()]);

    const result = await createWithRetry();

    expect(result.physicalId).toBe('policy-00000000000000002');
    expect(
      warnLines().some((l) => l.includes('cdkd could not look for it (GetLifecyclePolicies'))
    ).toBe(true);
    expect(reportLine()).toContain('could not look');
  });

  it('a candidate deleted between the listing and its read is skipped, not a failed lookup', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.onList = () => {
      aws.goneOnGet.add('policy-00000000000000001');
      aws.onList = undefined;
    };

    await createWithRetry();

    expect(warnLines().some((l) => l.includes('could not look'))).toBe(false);
    expect(reportLine()).toBeUndefined();
    expect(debugSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'No listed lifecycle policy(ies)'
    );
  });

  it('does not report a policy created after the window closed', async () => {
    aws.loseNextCreateResponse = transient500(); // policy 1, inside the window
    aws.onList = () => {
      // Created now, 30 s after the failed attempt: past its ceiling.
      aws.seed({ description: 'nightly snapshots', defaultPolicy: false });
      aws.onList = undefined;
    };

    await withRetry(
      () => provider.create('Policy', 'AWS::DLM::LifecyclePolicy', PROPS),
      'Policy',
      {
        sleep: (): Promise<void> => {
          vi.setSystemTime(Date.now() + 30_000);
          return Promise.resolve();
        },
      }
    );

    const line = reportLine()!;
    expect(line).toContain('1 lifecycle policy(ies) were created');
    expect(line).toContain('policy-00000000000000001');
    expect(line).not.toContain('policy-00000000000000002');
  });

  it('keeps a default-policy candidate whose read reports no resource type', async () => {
    aws.seed({ description: 'nightly snapshots', defaultPolicy: true }); // no ResourceType
    aws.loseNextCreateResponse = transient500();

    await createWithRetry({ ...PROPS, DefaultPolicy: 'VOLUME' });

    const line = reportLine()!;
    expect(line).toContain('2 lifecycle policy(ies) were created');
    expect(line).toContain('policy-00000000000000001');
  });

  it('treats an explicit null DefaultPolicy as absent: not sent, and matched as a custom policy', async () => {
    aws.loseNextCreateResponse = transient500();

    await createWithRetry({ ...PROPS, DefaultPolicy: null });

    const createInputs = mockSend.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
      .filter((c) => c.constructor.name === 'CreateLifecyclePolicyCommand')
      .map((c) => c.input);
    expect(createInputs).toHaveLength(2);
    for (const input of createInputs) expect('DefaultPolicy' in input).toBe(false);
    const line = reportLine()!;
    expect(line).toContain('may have created a lifecycle policy described nightly snapshots');
    expect(line).toContain('policy-00000000000000001');
  });

  it('two ambiguous attempts in a row: the second report dates from the FIRST attempt', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.onList = () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = undefined;
    };

    await withRetry(
      () => provider.create('Policy', 'AWS::DLM::LifecyclePolicy', PROPS),
      'Policy',
      {
        sleep: (): Promise<void> => {
          vi.setSystemTime(Date.now() + 30_000);
          return Promise.resolve();
        },
      }
    );

    const lines = warnLines().filter((l) => l.includes('earlier CreateLifecyclePolicy attempt'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('between 2026-09-30T23:59:55.000Z');
    expect(lines[1]).toContain('policy-00000000000000001');
    expect(lines[1]).toContain('policy-00000000000000002');
    expect(aws.policies).toHaveLength(3);
  });

  it('masks a secret-derived description in the report', async () => {
    aws.loseNextCreateResponse = transient500();

    await withRetry(
      () =>
        provider.create(
          'Policy',
          'AWS::DLM::LifecyclePolicy',
          { ...PROPS, Description: 'zq' },
          { maskSecrets: (t) => (t === 'zq' ? '***' : t) }
        ),
      'Policy',
      { sleep: advancingSleep }
    );

    const line = reportLine()!;
    expect(line).toContain('policy-00000000000000001');
    expect(line).not.toContain('described zq');
  });

  it('masks the policy-ARN read failure it warns about after a create', async () => {
    // Only the post-create ARN read fails: no lookup runs on a clean create.
    aws.failNext.set('GetLifecyclePolicyCommand', [
      Object.assign(new Error('denied for hunter2-key'), {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      }),
    ]);

    await provider.create(
      'Policy',
      'AWS::DLM::LifecyclePolicy',
      { ...PROPS, Description: 'hunter2-key' },
      { maskSecrets: (t) => t.split('hunter2-key').join('***') }
    );

    const line = warnLines().find((l) => l.includes('could not fetch its ARN'))!;
    expect(line).toContain('denied for ***');
    expect(line).not.toContain('hunter2');
  });

  it('a throttled create (by name) triggers no lookup', async () => {
    aws.failNext.set('CreateLifecyclePolicyCommand', [throttled()]);

    await createWithRetry();

    expect(aws.count('GetLifecyclePoliciesCommand')).toBe(0);
    expect(aws.policies).toHaveLength(1);
  });

  it('a DEFINITE create failure (a 4xx) triggers no lookup', async () => {
    aws.failNext.set('CreateLifecyclePolicyCommand', [propagationDenied()]);

    await createWithRetry();

    expect(aws.count('GetLifecyclePoliciesCommand')).toBe(0);
    expect(aws.policies).toHaveLength(1);
  });

  it('sends CreateLifecyclePolicy through a client that refuses the SDK retry of a 5xx, and nothing else', async () => {
    aws.loseNextCreateResponse = transient500();

    await createWithRetry();

    const createConfig = sentVia.find(([name]) => name === 'CreateLifecyclePolicyCommand')![1];
    const strategy = (await createConfig.retryStrategy()) as typeof baseStrategy;
    await expect(
      strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
    ).rejects.toThrow();
    await expect(
      strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
    ).resolves.toBe('retry-token');
    for (const other of ['GetLifecyclePoliciesCommand', 'GetLifecyclePolicyCommand']) {
      const config = sentVia.find(([name]) => name === other)![1];
      expect(await config.retryStrategy()).toBe(baseStrategy);
    }
  });

  it('a failed GetLifecyclePolicies warns and lets the create proceed', async () => {
    aws.loseNextCreateResponse = transient500();
    aws.failNext.set('GetLifecyclePoliciesCommand', [propagationDenied()]);

    const result = await createWithRetry();

    expect(result.physicalId).toBe('policy-00000000000000002');
    expect(
      warnLines().some((l) => l.includes('cdkd could not look for it (GetLifecyclePolicies'))
    ).toBe(true);
  });

  it('takes the latch once: a later clean create of the same logical id looks nothing up', async () => {
    aws.loseNextCreateResponse = transient500();
    await createWithRetry(PROPS, 'Shared');
    warnSpy.mockReset();

    await provider.create('Shared', 'AWS::DLM::LifecyclePolicy', PROPS);

    expect(reportLine()).toBeUndefined();
    expect(aws.count('GetLifecyclePoliciesCommand')).toBe(1);
  });
});
