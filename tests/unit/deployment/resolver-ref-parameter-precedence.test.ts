/**
 * A `Ref` to a PARAMETER is never answered from a state record of the same
 * name (go-to-k/cdkd#3916).
 *
 * CloudFormation cannot declare one logical id as both a Parameter and a
 * Resource, and `Ref` to a declared Parameter always yields its value. cdkd
 * read state FIRST, so a planted record `AppRoleName -> AttackerRole` beside a
 * Parameter `AppRoleName` picked the value deploy sent to AWS. Every planted
 * case below is paired with the control that the ordinary resource read still
 * serves the recorded physical id.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';

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

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: vi.fn(() =>
        Promise.reject(
          Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        )
      ),
    },
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const REGION = 'us-east-1';

const record = (physicalId: string, resourceType: string, attributes = {}): ResourceState =>
  ({
    physicalId,
    resourceType,
    properties: {},
    attributes,
    dependencies: [],
  }) as ResourceState;

/** A planted record keyed by the parameter's NAME. */
const PLANTED = { AppRoleName: record('AttackerRole', 'AWS::IAM::Role', { Arn: 'arn:attacker' }) };

describe('resolveRef: a parameter name is never answered from state (go-to-k/cdkd#3916)', () => {
  let resolver: IntrinsicFunctionResolver;
  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver(REGION);
    resetAccountInfoCache();
  });

  const ctx = (over: Partial<ResolverContext>): ResolverContext => ({
    template: { Resources: {} },
    resources: {},
    ...over,
  });

  it('answers the template-declared, bound parameter, not the planted record', async () => {
    const context = ctx({
      template: { Parameters: { AppRoleName: { Type: 'String' } }, Resources: {} },
      resources: PLANTED,
      parameters: { AppRoleName: 'AppRole' },
    });
    expect(await resolver.resolve({ Ref: 'AppRoleName' }, context)).toBe('AppRole');
  });

  it('answers a `${Param}` Fn::Sub from the parameter, not the planted record', async () => {
    const context = ctx({
      template: { Parameters: { AppRoleName: { Type: 'String' } }, Resources: {} },
      resources: PLANTED,
      parameters: { AppRoleName: 'AppRole' },
    });
    expect(await resolver.resolve({ 'Fn::Sub': 'role/${AppRoleName}' }, context)).toBe('role/AppRole');
  });

  it('reads the bound bag by own key: an unbound prototype-member name still reads its record', async () => {
    // `'toString' in {}` is true: an `in` test would call this record a parameter.
    const context = ctx({
      resources: { toString: record('topic-arn', 'AWS::SNS::Topic') },
      parameters: {},
    });
    expect(await resolver.resolve({ Ref: 'toString' }, context)).toBe('topic-arn');
  });

  it('reads Resources by own key: a bound prototype-member name answers the parameter', async () => {
    // With an `in` test on the empty `Resources`, `toString` would read as a
    // declared resource and the planted record would answer.
    const context = ctx({
      resources: { toString: record('topic-arn', 'AWS::SNS::Topic') },
      parameters: { toString: 'v' },
    });
    expect(await resolver.resolve({ Ref: 'toString' }, context)).toBe('v');
  });

  it('reads the template Parameters by own key, so a resource named like a prototype member resolves', async () => {
    // `'toString' in {}` is true: an `in` test would call this resource a parameter.
    const context = ctx({
      template: {
        Parameters: {},
        Resources: { toString: { Type: 'AWS::SNS::Topic', Properties: {} } },
      },
      resources: { toString: record('topic-arn', 'AWS::SNS::Topic') },
      parameters: {},
    });
    expect(await resolver.resolve({ Ref: 'toString' }, context)).toBe('topic-arn');
  });

  it('keeps the planted record away when the name is only in the bound bag', async () => {
    // The BAG arm alone: the template does not declare it.
    const context = ctx({ resources: PLANTED, parameters: { AppRoleName: 'AppRole' } });
    expect(await resolver.resolve({ Ref: 'AppRoleName' }, context)).toBe('AppRole');
  });

  it('keeps the planted record away when the name is only declared by the template', async () => {
    // The TEMPLATE arm alone: declared but unbound, so the Ref has no value
    // and fails, rather than quietly taking the record's physical id.
    const context = ctx({
      template: { Parameters: { AppRoleName: { Type: 'String' } }, Resources: {} },
      resources: PLANTED,
    });
    await expect(resolver.resolve({ Ref: 'AppRoleName' }, context)).rejects.toThrow(
      'Ref AppRoleName not found'
    );
  });

  it('refuses Fn::GetAtt on a parameter name instead of reading the planted record', async () => {
    const context = ctx({
      template: { Parameters: { AppRoleName: { Type: 'String' } }, Resources: {} },
      resources: PLANTED,
      parameters: { AppRoleName: 'AppRole' },
    });
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['AppRoleName', 'Arn'] }, context)
    ).rejects.toThrow('Resource AppRoleName not found for Fn::GetAtt');
  });

  it('answers a pseudo parameter, not a planted record keyed by its name', async () => {
    const context = ctx({
      resources: { 'AWS::StackName': record('AttackerStack', 'AWS::IAM::Role') },
      stackName: 'RealStack',
    });
    expect(await resolver.resolve({ Ref: 'AWS::StackName' }, context)).toBe('RealStack');
  });

  it('still serves a declared resource from its record (the control)', async () => {
    const context = ctx({
      template: {
        Parameters: { AppRoleName: { Type: 'String' } },
        Resources: { AppRole: { Type: 'AWS::IAM::Role', Properties: {} } },
      },
      resources: {
        ...PLANTED,
        AppRole: record('RealRole', 'AWS::IAM::Role', { Arn: 'arn:real' }),
      },
      parameters: { AppRoleName: 'AppRole' },
    });
    expect(await resolver.resolve({ Ref: 'AppRole' }, context)).toBe('RealRole');
    expect(await resolver.resolve({ 'Fn::GetAtt': ['AppRole', 'Arn'] }, context)).toBe('arn:real');
  });

  it('lets a bound input the template declares as a RESOURCE keep reading the record', async () => {
    // `cdkd diff --recursive` keeps a parent's raw nested inputs for names the
    // child does not declare; one that equals a child resource id must not hide it.
    const context = ctx({
      template: { Resources: { AppRole: { Type: 'AWS::IAM::Role', Properties: {} } } },
      resources: { AppRole: record('RealRole', 'AWS::IAM::Role', { Arn: 'arn:real' }) },
      parameters: { AppRole: 'raw-parent-input' },
    });
    expect(await resolver.resolve({ Ref: 'AppRole' }, context)).toBe('RealRole');
    expect(await resolver.resolve({ 'Fn::GetAtt': ['AppRole', 'Arn'] }, context)).toBe('arn:real');
  });

  it('reads a null `Resources` block as declaring no resource for a bound name', async () => {
    // A YAML `Resources:` with an empty body parses to null.
    const context = ctx({
      template: { Resources: null } as unknown as CloudFormationTemplate,
      resources: PLANTED,
      parameters: { AppRoleName: 'AppRole' },
    });
    expect(await resolver.resolve({ Ref: 'AppRoleName' }, context)).toBe('AppRole');
  });

  it('treats `${Param.Attr}` in Fn::Sub the same whether or not a record is planted', async () => {
    // A bound parameter head warns and keeps the placeholder (intrinsic-refusals.md);
    // a planted record must neither answer it nor turn that into a refusal.
    const outcome = (resources: Record<string, ResourceState>) =>
      resolver
        .resolve(
          { 'Fn::Sub': 'x-${AppRoleName.Arn}' },
          ctx({
            template: { Parameters: { AppRoleName: { Type: 'String' } }, Resources: {} },
            resources,
            parameters: { AppRoleName: 'AppRole' },
          })
        )
        .then(
          (v) => ({ value: v }),
          (e: unknown) => ({ error: (e as Error).message })
        );
    expect(await outcome({})).toEqual({ value: 'x-${AppRoleName.Arn}' });
    expect(await outcome(PLANTED)).toEqual({ value: 'x-${AppRoleName.Arn}' });
  });

  it('notes the ignored record at debug only when a record of that name exists', async () => {
    const debug = vi.mocked(getLogger().debug);
    const declared = { Parameters: { AppRoleName: { Type: 'String' } }, Resources: {} };
    const note = (): unknown[] =>
      debug.mock.calls.filter((c) => String(c[0]).startsWith('Ignoring the state record named'));
    debug.mockClear();
    await resolver.resolve(
      { Ref: 'AppRoleName' },
      ctx({ template: declared, resources: PLANTED, parameters: { AppRoleName: 'AppRole' } })
    );
    expect(note()).toEqual([
      ['Ignoring the state record named AppRoleName: that name is a parameter, not a resource'],
    ]);
    debug.mockClear();
    await resolver.resolve(
      { Ref: 'AppRoleName' },
      ctx({ template: declared, parameters: { AppRoleName: 'AppRole' } })
    );
    expect(note()).toEqual([]);
  });

  it('renders the ignored name in the debug note control-stripped and masked', async () => {
    const debug = vi.mocked(getLogger().debug);
    const lines = (): string[] =>
      debug.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith('Ignoring the state record named'));
    const plantUnder = async (name: string, over: Partial<ResolverContext> = {}) => {
      debug.mockClear();
      await resolver.resolve(
        { Ref: name },
        ctx({
          template: { Parameters: { [name]: { Type: 'String' } }, Resources: {} },
          resources: { [name]: record('AttackerRole', 'AWS::IAM::Role') },
          parameters: { [name]: 'v' },
          ...over,
        })
      );
      return lines();
    };
    const escaped = await plantUnder('App\u001b[2K\rRole');
    expect(escaped).toHaveLength(1);
    expect(escaped[0]).not.toMatch(/[\u001b\r]/);
    // A name equal to a secret the parent resolved is masked, not printed.
    const secret = 'ParentResolvedSecret3916';
    const masked = await plantUnder(secret, {
      inheritedSecrets: new Map([[secret, '{{resolve:secretsmanager:s}}']]),
    });
    expect(masked).toHaveLength(1);
    expect(masked[0]).not.toContain(secret);
  });

  it('still serves a record the template does not list when no parameter has its name', async () => {
    // Unchanged behaviour: callers pass records beside an empty `Resources`.
    const context = ctx({ resources: PLANTED, parameters: { Other: 'x' } });
    expect(await resolver.resolve({ Ref: 'AppRoleName' }, context)).toBe('AttackerRole');
  });

  it('reads a null `Parameters` block as declaring nothing', async () => {
    // A YAML `Parameters:` with an empty body parses to null.
    const context = ctx({
      template: { Parameters: null, Resources: {} } as unknown as CloudFormationTemplate,
      resources: PLANTED,
    });
    expect(await resolver.resolve({ Ref: 'AppRoleName' }, context)).toBe('AttackerRole');
  });
});

describe('DeployEngine: a planted record named like a parameter does not pick its value (go-to-k/cdkd#3916)', () => {
  const STACK = 'param-precedence-stack';

  const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:AppRole';
  const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/q';

  function setup(existingTopic = false): {
    template: CloudFormationTemplate;
    stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  } {
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      outputs: {},
      lastModified: 0,
      resources: {
        ...PLANTED,
        Queue: {
          physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: 'q' },
          observedProperties: { QueueName: 'q' },
          attributes: {},
          dependencies: [],
        },
        ...(existingTopic && {
          Topic: {
            physicalId: TOPIC_ARN,
            resourceType: 'AWS::SNS::Topic',
            properties: { TopicName: 'AppRole', DisplayName: QUEUE_URL },
            observedProperties: { TopicName: 'AppRole', DisplayName: QUEUE_URL },
            attributes: {},
            dependencies: ['Queue'],
          },
        }),
      },
    };
    const template: CloudFormationTemplate = {
      Parameters: { AppRoleName: { Type: 'String', Default: 'AppRole' } },
      Resources: {
        Queue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } },
        Topic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { Ref: 'AppRoleName' }, DisplayName: { Ref: 'Queue' } },
        },
      },
    };
    return {
      template,
      stateBackend: {
        getState: vi.fn().mockResolvedValue({ state, etag: 'e' }),
        saveState: vi.fn().mockResolvedValue('e2'),
      },
    };
  }

  beforeEach(() => vi.clearAllMocks());

  function makeProviderAndEngine(stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
  }) {
    const provider = {
      create: vi.fn((id: string, ..._rest: unknown[]) => Promise.resolve({ physicalId: `${id}-new` })),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
      update: vi.fn((_id: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
    };
    const engine = new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false },
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );

    return { provider, engine };
  }

  it('creates the reader with the parameter value, and a resource Ref still reads its record', async () => {
    const { template, stateBackend } = setup();
    const { provider, engine } = makeProviderAndEngine(stateBackend);
    await engine.deploy(STACK, template);

    const creates = provider.create.mock.calls.filter((c) => c[0] === 'Topic');
    expect(creates).toHaveLength(1);
    // (logicalId, resourceType, properties, ...)
    expect(creates[0]![2]).toMatchObject({
      TopicName: 'AppRole',
      DisplayName: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
    });
  });

  it('leaves an existing reader untouched: the parameter value equals its record (the integ 5b path)', async () => {
    // With the record answering the Ref, TopicName (create-only) would move to
    // the planted physical id and the topic would be REPLACED.
    const { template, stateBackend } = setup(true);
    const { provider, engine } = makeProviderAndEngine(stateBackend);

    await engine.deploy(STACK, template);

    expect(provider.create.mock.calls.filter((c) => c[0] === 'Topic')).toEqual([]);
    expect(provider.update.mock.calls.filter((c) => c[0] === 'Topic')).toEqual([]);
    expect(provider.delete.mock.calls.filter((c) => c[0] === 'Topic')).toEqual([]);
  });
});
