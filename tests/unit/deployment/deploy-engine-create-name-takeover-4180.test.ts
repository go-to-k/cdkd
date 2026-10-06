/**
 * go-to-k/cdkd#4180: a plain CREATE of an explicitly named queue, topic, rule,
 * alarm, state machine, cluster or bucket — types whose SDK create hands back
 * or overwrites a resource already holding the name instead of failing —
 * recorded that resource as the stack's own, for a later `cdkd destroy` to
 * delete. The CREATE arm now looks the name up first and refuses a holder,
 * as CloudFormation's create fails with "already exists".
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  createLookupArn,
  createNameQuestion,
} from '../../../src/deployment/replacement-name-holder.js';
import { getAccountInfo } from '../../../src/deployment/intrinsic-function-resolver.js';
import { AccountIdUnavailableError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    // A name carrying SECRETVALUE stands for one resolved from a secret.
    resolve: vi
      .fn()
      .mockImplementation(
        (value: unknown, ctx?: { recordedSecretValues?: Map<string, string> }) => {
          const bag = value as { QueueName?: unknown; Name?: unknown } | null;
          const name = bag?.QueueName ?? bag?.Name;
          if (typeof name === 'string' && name.includes('SECRETVALUE')) {
            ctx?.recordedSecretValues?.set(name, '{{resolve:secretsmanager:name:SecretString}}');
          }
          return Promise.resolve(value);
        }
      ),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
  getAccountInfo: vi.fn(),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

type Inner = Error & { code?: string };

interface Harness {
  callOrder: string[];
  importResult: { physicalId: string } | null | Error;
  provider: ResourceProvider;
}

function makeHarness(opts: { withImport?: boolean } = {}): Harness {
  const h: Harness = {
    callOrder: [],
    importResult: null,
    provider: undefined as unknown as ResourceProvider,
  };
  h.provider = {
    create: vi.fn().mockImplementation(async () => {
      h.callOrder.push('create');
      return { physicalId: 'new-id', attributes: {} };
    }),
    update: vi.fn(),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    ...(opts.withImport !== false && {
      import: vi.fn().mockImplementation(async () => {
        h.callOrder.push('import');
        if (h.importResult instanceof Error) throw h.importResult;
        return h.importResult;
      }),
    }),
  };
  return h;
}

function makeEngine(
  h: Harness,
  provisionedBy: 'sdk' | 'cc-api' = 'sdk'
): InstanceType<typeof DeployEngine> {
  return new DeployEngine(
    { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') } as unknown as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as unknown as never,
    {
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    } as unknown as never,
    {
      getProvider: vi.fn().mockReturnValue(h.provider),
      getProviderFor: vi.fn().mockReturnValue({ provider: h.provider, provisionedBy }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    } as unknown as never,
    {},
    'us-east-1'
  );
}

async function create(
  engine: InstanceType<typeof DeployEngine>,
  type: string,
  props: Record<string, unknown>,
  stateResources: Record<string, unknown> = {},
  stackName = 'MyStack'
): Promise<Inner | null> {
  const change: ResourceChange = {
    logicalId: 'Res',
    changeType: 'CREATE',
    resourceType: type,
    desiredProperties: props,
  };
  const template: CloudFormationTemplate = {
    Resources: { Res: { Type: type, Properties: props } },
  };
  const run = (
    engine as unknown as {
      provisionResource: (
        logicalId: string,
        change: ResourceChange,
        stateResources: Record<string, unknown>,
        stackName: string,
        template: CloudFormationTemplate
      ) => Promise<void>;
    }
  ).provisionResource.bind(engine);
  return run('Res', change, stateResources, stackName, template).then(
    () => null,
    (e) => (e as { cause?: unknown }).cause as Inner
  );
}

const QUEUE = 'AWS::SQS::Queue';
const THEIRS = 'https://sqs.us-east-1.amazonaws.com/123456789012/their-queue';
const accountInfo = getAccountInfo as unknown as ReturnType<typeof vi.fn>;

describe('DeployEngine — a plain CREATE onto a name another resource holds (#4180)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
    accountInfo.mockReset();
  });

  it('refuses BEFORE the create when another queue holds the explicit name', async () => {
    h.importResult = { physicalId: THEIRS };

    const err = await create(makeEngine(h), QUEUE, { QueueName: 'their-queue' });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).toContain(`an existing resource (${THEIRS}) already holds that name`);
    expect(err!.message).toContain('would take that resource over');
    expect(err!.message).toContain('Nothing was created');
    expect(err!.message).toContain('cdkd import');
    expect(isMarkedNonRetryable(err)).toBe(true);
    // go-to-k/cdkd#4356: nothing was applied, so the deploy journals no failed
    // op whose `--revert-failed` line would advise deleting THEIR queue.
    expect(isRefusedBeforeApplying(err, 'Res')).toBe(true);
    // The feared shape: CreateQueue hands back theirs and state records it.
    expect(h.callOrder).toEqual(['import']);
    expect(h.provider.import).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalId: 'Res',
        resourceType: QUEUE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: expect.objectContaining({ QueueName: 'their-queue' }),
      })
    );
    expect(
      (h.provider.import as ReturnType<typeof vi.fn>).mock.calls[0]![0].knownPhysicalId
    ).toBeUndefined();
  });

  it('refuses an ELBv2 load balancer or target group whose explicit Name another one holds', async () => {
    for (const [type, kind] of [
      ['AWS::ElasticLoadBalancingV2::LoadBalancer', 'loadbalancer/net'],
      ['AWS::ElasticLoadBalancingV2::TargetGroup', 'targetgroup'],
    ] as const) {
      h = makeHarness();
      const arn = `arn:aws:elasticloadbalancing:us-east-1:123456789012:${kind}/theirs/1`;
      h.importResult = { physicalId: arn };

      const err = await create(makeEngine(h), type, { Name: 'theirs' });

      expect(err!.code, type).toBe('NAMED_CREATE_COLLISION');
      expect(err!.message, type).toContain(`an existing resource (${arn}) already holds that name`);
      expect(h.callOrder, type).toEqual(['import']);
      expect(h.provider.import, type).toHaveBeenCalledWith(
        expect.objectContaining({ resourceType: type, properties: { Name: 'theirs' } })
      );
    }
  });

  it('creates when no resource holds the name (negative control)', async () => {
    h.importResult = null;

    const err = await create(makeEngine(h), QUEUE, { QueueName: 'free-queue' });

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['import', 'create']);
  });

  it('does not look up a generated name', async () => {
    h.importResult = { physicalId: THEIRS };

    const err = await create(makeEngine(h), QUEUE, { VisibilityTimeout: 30 });

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['create']);
  });

  it('does not look up a Cloud Control create, which refuses a taken name itself', async () => {
    h.importResult = { physicalId: THEIRS };

    const err = await create(makeEngine(h, 'cc-api'), QUEUE, { QueueName: 'their-queue' });

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['create']);
  });

  it('does not look up a type whose create refuses a taken name', async () => {
    h.importResult = { physicalId: 'arn:aws:lambda:us-east-1:123456789012:function:fn' };

    const err = await create(makeEngine(h), 'AWS::Lambda::Function', { FunctionName: 'fn' });

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['create']);
  });

  it('refuses when the lookup fails, with nothing created', async () => {
    h.importResult = new Error('AccessDenied: sqs:GetQueueUrl');

    const err = await create(makeEngine(h), QUEUE, { QueueName: 'their-queue' });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).toContain('could not check whether another resource already holds it');
    expect(err!.message).toContain('AccessDenied');
    expect(err!.message).toContain('Nothing was created');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(isRefusedBeforeApplying(err, 'Res')).toBe(true);
    expect(h.callOrder).toEqual(['import']);
  });

  it("refuses S3's HeadBucket 403 with its causes named", async () => {
    h.importResult = Object.assign(new Error('Forbidden'), {
      name: 'Forbidden',
      $metadata: { httpStatusCode: 403 },
    });

    const err = await create(makeEngine(h), 'AWS::S3::Bucket', { BucketName: 'their-bucket' });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).toContain('S3 answered 403 Forbidden');
    expect(err!.message).toContain('another account owns that name');
    expect(h.callOrder).toEqual(['import']);
  });

  it('refuses a bucket this account already owns, which the provider would configure', async () => {
    h.importResult = { physicalId: 'their-bucket' };

    const err = await create(makeEngine(h), 'AWS::S3::Bucket', { BucketName: 'their-bucket' });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(h.callOrder).toEqual(['import']);
  });

  it('hands the lookup the bus of an EventBridge rule, whose name is per bus', async () => {
    h.importResult = { physicalId: 'custom-bus|their-rule' };

    const err = await create(makeEngine(h), 'AWS::Events::Rule', {
      Name: 'their-rule',
      EventBusName: 'custom-bus',
    });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(h.provider.import).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ Name: 'their-rule', EventBusName: 'custom-bus' }),
      })
    );
    expect(h.callOrder).toEqual(['import']);
  });

  it('looks a state machine up by the ARN the name would take', async () => {
    accountInfo.mockResolvedValue({
      accountId: '123456789012',
      region: 'us-east-1',
      partition: 'aws',
    });
    const arn = 'arn:aws:states:us-east-1:123456789012:stateMachine:their-sm';
    h.importResult = { physicalId: arn };

    const err = await create(makeEngine(h), 'AWS::StepFunctions::StateMachine', {
      StateMachineName: 'their-sm',
    });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(accountInfo).toHaveBeenCalledWith('us-east-1');
    expect(h.provider.import).toHaveBeenCalledWith(
      expect.objectContaining({ knownPhysicalId: arn })
    );
    expect(h.callOrder).toEqual(['import']);
  });

  it('looks an SNS topic up by the ARN the name would take, not a ListTopics walk', async () => {
    accountInfo.mockResolvedValue({
      accountId: '123456789012',
      region: 'us-east-1',
      partition: 'aws',
    });
    const arn = 'arn:aws:sns:us-east-1:123456789012:their-topic';
    h.importResult = { physicalId: arn };

    const err = await create(makeEngine(h), 'AWS::SNS::Topic', { TopicName: 'their-topic' });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(h.provider.import).toHaveBeenCalledWith(
      expect.objectContaining({ knownPhysicalId: arn })
    );
  });

  it('refuses an SNS topic when STS could not report the account (issue #1730)', async () => {
    accountInfo.mockRejectedValue(
      new AccountIdUnavailableError('Cannot determine the AWS account id: STS unreachable.')
    );

    const err = await create(makeEngine(h), 'AWS::SNS::Topic', { TopicName: 'my-topic' });

    expect(err).toBeInstanceOf(AccountIdUnavailableError);
    expect(h.callOrder).toEqual([]);
  });

  it('refuses an SNS topic when the account id is malformed', async () => {
    accountInfo.mockResolvedValue({ accountId: 'unknown', region: 'us-east-1', partition: 'aws' });

    const err = await create(makeEngine(h), 'AWS::SNS::Topic', { TopicName: 'my-topic' });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).toContain('STS did not report');
    expect(h.callOrder).toEqual([]);
  });

  it('refuses a ":" in a state machine name with its own remedy, not the STS one', async () => {
    accountInfo.mockResolvedValue({
      accountId: '123456789012',
      region: 'us-east-1',
      partition: 'aws',
    });

    const err = await create(makeEngine(h), 'AWS::StepFunctions::StateMachine', {
      StateMachineName: 'a:b',
    });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).toContain('the name contains ":"');
    expect(err!.message).not.toContain('STS');
    expect(h.callOrder).toEqual([]);
  });

  it('refuses a log group the provider would read ResourceAlreadyExists as success for', async () => {
    h.importResult = { physicalId: '/app/theirs' };

    const err = await create(makeEngine(h), 'AWS::Logs::LogGroup', {
      LogGroupName: '/app/theirs',
    });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(h.callOrder).toEqual(['import']);
  });

  it('ends on a pasteable `cdkd import` adopting the holder under this logical id', async () => {
    h.importResult = { physicalId: '/aws/lambda/MyStack-Fn' };

    const err = await create(makeEngine(h), 'AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/MyStack-Fn',
    });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).toContain('kept by an earlier `cdkd destroy` under DeletionPolicy: Retain');
    const lines = err!.message.split('\n');
    expect(lines.at(-1)).toBe(
      "Adopt with: cdkd import MyStack --resource 'Res=/aws/lambda/MyStack-Fn'"
    );
  });

  it('withholds the adopt command when the holder carries a masked secret-derived name', async () => {
    h.importResult = { physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/q-SECRETVALUE' };

    const err = await create(makeEngine(h), QUEUE, { QueueName: 'q-SECRETVALUE' });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).toContain('adopt it with `cdkd import`');
    expect(err!.message).not.toContain('Adopt with:');
  });

  it('looks up a NUMERIC explicit name, which the create sends too', async () => {
    h.importResult = { physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/42' };

    const err = await create(makeEngine(h), QUEUE, { QueueName: 42 });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(h.provider.import).toHaveBeenCalledWith(
      // A string: the providers' lookups read a string name only.
      expect.objectContaining({ properties: expect.objectContaining({ QueueName: '42' }) })
    );
  });

  it('withholds the `cdkd import` remedy from a nested-stack child, which import cannot target', async () => {
    h.importResult = { physicalId: THEIRS };

    const err = await create(makeEngine(h), QUEUE, { QueueName: 'their-queue' }, {}, 'Parent~Child');

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).toContain('delete it and re-run');
    expect(err!.message).not.toContain('cdkd import');
    expect(err!.message).not.toContain('Adopt with:');
  });

  it('refuses a state machine when the account id is malformed', async () => {
    accountInfo.mockResolvedValue({ accountId: 'unknown', region: 'us-east-1', partition: 'aws' });

    const err = await create(makeEngine(h), 'AWS::StepFunctions::StateMachine', {
      StateMachineName: 'my-sm',
    });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).toContain('STS did not report');
    expect(err!.message).toContain('Nothing was created');
    expect(h.callOrder).toEqual([]);
  });

  it("names this stack's own holder under another logical id, without import/delete advice", async () => {
    h.importResult = { physicalId: THEIRS };

    const err = await create(
      makeEngine(h),
      QUEUE,
      { QueueName: 'their-queue' },
      {
        OldQueue: {
          physicalId: THEIRS,
          resourceType: QUEUE,
          properties: { QueueName: 'their-queue' },
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        },
      }
    );

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).toContain("which this stack's OldQueue");
    expect(err!.message).toContain('deploy the removal of OldQueue first');
    expect(err!.message).not.toContain('adopt it with');
    expect(isRefusedBeforeApplying(err, 'Res')).toBe(true);
    expect(h.callOrder).toEqual(['import']);
  });

  it('the mark survives the error provisionResource wraps it in (go-to-k/cdkd#4356)', async () => {
    // `execute.ts` reads the mark off what provisionResource THROWS, not off
    // the inner refusal the helper above unwraps.
    h.importResult = { physicalId: THEIRS };
    const engine = makeEngine(h);
    const props = { QueueName: 'their-queue' };
    const outer = await (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate
        ) => Promise<void>;
      }
    )
      .provisionResource(
        'Res',
        { logicalId: 'Res', changeType: 'CREATE', resourceType: QUEUE, desiredProperties: props },
        {},
        'MyStack',
        { Resources: { Res: { Type: QUEUE, Properties: props } } }
      )
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(outer).not.toBeNull();
    expect(isRefusedBeforeApplying(outer, 'Res')).toBe(true);
  });

  it('keeps the stranger advice when the state record of that id is another type', async () => {
    h.importResult = { physicalId: THEIRS };

    const err = await create(
      makeEngine(h),
      QUEUE,
      { QueueName: 'their-queue' },
      {
        Other: {
          physicalId: THEIRS,
          resourceType: 'AWS::SNS::Topic',
          properties: {},
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        },
      }
    );

    expect(err!.message).toContain('adopt it with `cdkd import`');
    expect(err!.message).not.toContain("this stack's Other");
  });

  it("refuses S3's 301 as a bucket of that name in another region", async () => {
    h.importResult = Object.assign(new Error('UnknownError'), {
      name: 'UnknownError',
      $metadata: { httpStatusCode: 301 },
    });

    const err = await create(makeEngine(h), 'AWS::S3::Bucket', { BucketName: 'their-bucket' });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).toContain('already exists in another region');
    expect(err!.message).not.toContain('Re-run the deploy once the check can succeed');
  });

  it('masks a secret-derived name in the holder and the lookup-failure refusals', async () => {
    const holder = 'https://sqs.us-east-1.amazonaws.com/123456789012/q-SECRETVALUE';
    h.importResult = { physicalId: holder };
    const held = await create(makeEngine(h), QUEUE, { QueueName: 'q-SECRETVALUE' });

    h = makeHarness();
    h.importResult = new Error('AccessDenied for q-SECRETVALUE');
    const failed = await create(makeEngine(h), QUEUE, { QueueName: 'q-SECRETVALUE' });

    for (const err of [held!, failed!]) {
      expect(err.code).toBe('NAMED_CREATE_COLLISION');
      expect(err.message).toContain('QueueName ***');
      expect(err.message).not.toContain('SECRETVALUE');
    }
    expect(failed!.message).toContain('AccessDenied for ***');
  });

  it('masks the spelling ELBv2 sends for a secret-derived Name, which the holder ARN carries', async () => {
    // The provider sends `team_SECRETVALUE.x` as `team-SECRETVALUE-x`: not the
    // recorded plaintext, so only the derived-name mask hides it.
    const holder =
      'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/team-SECRETVALUE-x/0123456789abcdef';
    h.importResult = { physicalId: holder };
    const held = await create(makeEngine(h), 'AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'team_SECRETVALUE.x',
    });

    h = makeHarness();
    h.importResult = new Error('AccessDenied for team-SECRETVALUE-x');
    const failed = await create(makeEngine(h), 'AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'team_SECRETVALUE.x',
    });

    for (const err of [held!, failed!]) {
      expect(err.code).toBe('NAMED_CREATE_COLLISION');
      expect(err.message).not.toContain('SECRETVALUE');
    }
    expect(held!.message).toContain('targetgroup/***/0123456789abcdef');
  });

  it('masks a secret-derived name BEFORE display sanitizing rewrites it', async () => {
    // A trailing control character is what `displaySafe` strips: sanitized
    // first, the value no longer matches its needle and would print.
    h.importResult = new Error('AccessDenied');

    const err = await create(makeEngine(h), QUEUE, { QueueName: 'q-SECRETVALUE\n' });

    expect(err!.code).toBe('NAMED_CREATE_COLLISION');
    expect(err!.message).not.toContain('SECRETVALUE');
  });

  it('creates when the provider has no import() to ask (a test double)', async () => {
    h = makeHarness({ withImport: false });

    const err = await create(makeEngine(h), QUEUE, { QueueName: 'their-queue' });

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['create']);
  });
});

describe('createNameQuestion (#4180)', () => {
  it('answers the explicit name of every name-adopting type on the SDK route', () => {
    const cases: Array<[string, string]> = [
      ['AWS::CloudWatch::Alarm', 'AlarmName'],
      ['AWS::ECS::Cluster', 'ClusterName'],
      ['AWS::ElasticLoadBalancingV2::LoadBalancer', 'Name'],
      ['AWS::ElasticLoadBalancingV2::TargetGroup', 'Name'],
      ['AWS::Events::Rule', 'Name'],
      ['AWS::Logs::LogGroup', 'LogGroupName'],
      ['AWS::S3::Bucket', 'BucketName'],
      ['AWS::SNS::Topic', 'TopicName'],
      ['AWS::SQS::Queue', 'QueueName'],
      ['AWS::StepFunctions::StateMachine', 'StateMachineName'],
    ];
    for (const [resourceType, property] of cases) {
      expect(
        createNameQuestion({ resourceType, createdVia: 'sdk', properties: { [property]: 'n' } })
      ).toEqual({ property, desiredName: 'n' });
    }
  });

  it('answers nothing without an explicit name, on Cloud Control, or for another type', () => {
    expect(
      createNameQuestion({ resourceType: QUEUE, createdVia: 'sdk', properties: {} })
    ).toBeUndefined();
    expect(
      createNameQuestion({
        resourceType: QUEUE,
        createdVia: 'cc-api',
        properties: { QueueName: 'q' },
      })
    ).toBeUndefined();
    expect(
      createNameQuestion({
        resourceType: 'AWS::Lambda::Function',
        createdVia: 'sdk',
        properties: { FunctionName: 'f' },
      })
    ).toBeUndefined();
  });
});

describe('createLookupArn (#4180)', () => {
  const account = { accountId: '123456789012', region: 'eu-west-1', partition: 'aws-cn' };

  it('builds the state machine and topic ARNs from the account, region and partition', () => {
    expect(createLookupArn('AWS::StepFunctions::StateMachine', 'sm', account)).toEqual({
      arn: 'arn:aws-cn:states:eu-west-1:123456789012:stateMachine:sm',
    });
    expect(createLookupArn('AWS::SNS::Topic', 't', account)).toEqual({
      arn: 'arn:aws-cn:sns:eu-west-1:123456789012:t',
    });
  });

  it('answers nothing for a type that looks the name up itself', () => {
    expect(createLookupArn(QUEUE, 'q', account)).toBeUndefined();
  });

  it('names why it cannot build one: a malformed account, an empty region, or a ":" in the name', () => {
    const sm = 'AWS::StepFunctions::StateMachine';
    expect(createLookupArn(sm, 'sm', { ...account, region: '' })).toEqual({
      unbuildable: 'account',
    });
    expect(createLookupArn(sm, 'sm', { ...account, accountId: 'unknown' })).toEqual({
      unbuildable: 'account',
    });
    expect(createLookupArn(sm, 'a:b', account)).toEqual({ unbuildable: 'name' });
  });
});
