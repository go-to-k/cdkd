import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import {
  passedNoEchoParametersOf,
  recordNoEchoParameterFreshValue,
  recordPassedNoEchoParameters,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { getCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import {
  CustomResourceProvider,
  CR_NOECHO_PROPERTIES_SKIP_REASON,
} from '../../../src/provisioning/providers/custom-resource-provider.js';

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

/**
 * go-to-k/cdkd#4043 review round 9: a CDK NESTED CHILD declares no `NoEcho`
 * parameter, so a parent `NoEcho` value passed into a child parameter used to
 * get only the value arm. The child engine now positions such a parameter as a
 * `NoEcho` one, so every positional surface covers the child too.
 */
const REGION = 'us-east-1';
const STACK = 'Parent~Child';
const TOKEN = 'nested-noecho-token-r9';
const SHORT = 'abc';
const PLAIN = 'plain-parent-value-r10';
const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:h';

type Provider = Record<string, ReturnType<typeof vi.fn>>;

describe('DeployEngine - a nested child fed a parent NoEcho value (review round 9)', () => {
  let provider: Provider;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn((logicalId: string) =>
        Promise.resolve({ physicalId: `${logicalId}-phys`, attributes: {} })
      ),
      update: vi.fn((_id: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('e2'),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
  });

  /**
   * The bag the parent's nested-stack row binds: each value fresh (the value
   * arm, from 4 characters), and the child parameters its row fills from a
   * parent `NoEcho` parameter (what the parent records, pinned below).
   */
  function inheritedFor(passed: Record<string, string>): RecordedSecretValues {
    const inherited: RecordedSecretValues = new Map();
    for (const value of Object.values(passed)) recordNoEchoParameterFreshValue(value, inherited);
    recordPassedNoEchoParameters(
      inherited,
      Object.fromEntries(Object.keys(passed).map((name) => [name, { Ref: `Parent${name}` }])),
      { parameters: new Set(Object.keys(passed).map((name) => `Parent${name}`)) }
    );
    return inherited;
  }

  function makeEngine(
    inherited: RecordedSecretValues,
    parameters: Record<string, unknown>,
    crProvider?: CustomResourceProvider
  ): DeployEngine {
    const route = (type: string): Record<string, unknown> =>
      crProvider !== undefined && type.startsWith('Custom::') ? (crProvider as never) : provider;
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: vi.fn((type: string) => route(type)),
        getProviderFor: vi.fn((q: { resourceType: string }) => ({
          provider: route(q.resourceType),
          provisionedBy: 'sdk',
        })),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      {
        dryRun: false,
        captureObservedState: false,
        parameters,
        inheritedSecrets: inherited,
        // What `NestedStackProvider` hands the child off the same bag.
        passedNoEchoParameters: passedNoEchoParametersOf(inherited),
        parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: REGION },
      } as never,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const allSaved = (): string => JSON.stringify(stateBackend.saveState!.mock.calls);
  const lastSaved = (): StackState => stateBackend.saveState!.mock.calls.at(-1)![2] as StackState;

  it('(a) masks a pre-v11 child output and records positions in EVERY save, a short value included', async () => {
    // What a pre-v11 binary wrote for the child: plaintext everywhere.
    const state: StackState = {
      version: 10 as never,
      region: REGION,
      stackName: STACK,
      resources: {
        Reader: {
          physicalId: '/app/p',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/app/p', Type: 'String', Value: TOKEN },
          attributes: {},
          dependencies: [],
        },
        Short: {
          physicalId: '/app/s',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/app/s', Type: 'String', Value: SHORT },
          attributes: {},
          dependencies: [],
        },
        PlainReader: {
          physicalId: '/app/plain',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/app/plain', Type: 'String', Value: PLAIN },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: { TokenOut: TOKEN, ShortOut: SHORT, PlainOut: PLAIN },
      lastModified: 0,
    };
    stateBackend.getState!.mockResolvedValue({ state, etag: 'e' });
    const template = {
      Parameters: {
        Token: { Type: 'String' },
        ShortParam: { Type: 'String' },
        PlainParam: { Type: 'String' },
      },
      Resources: {
        // The over-mask control (review round 10): filled from a PLAIN parent
        // parameter, so it is not positioned.
        PlainReader: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/plain', Type: 'String', Value: { Ref: 'PlainParam' } },
        },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/p', Type: 'String', Value: { Ref: 'Token' } },
        },
        Short: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/s', Type: 'String', Value: { Ref: 'ShortParam' } },
        },
      },
      Outputs: {
        TokenOut: { Value: { Ref: 'Token' } },
        ShortOut: { Value: { Ref: 'ShortParam' } },
        PlainOut: { Value: { Ref: 'PlainParam' } },
      },
    } as unknown as CloudFormationTemplate;

    await makeEngine(inheritedFor({ Token: TOKEN, ShortParam: SHORT }), {
      Token: TOKEN,
      ShortParam: SHORT,
      PlainParam: PLAIN,
    }).deploy(
      STACK,
      template
    );

    expect(stateBackend.saveState).toHaveBeenCalled();
    // No save of the migration deploy carries either value: not the
    // per-resource saves before the outputs pass, not the last one.
    expect(allSaved()).not.toContain(TOKEN);
    expect(allSaved()).not.toContain(`"${SHORT}"`);
    const saved = lastSaved();
    expect(saved.outputs['TokenOut']).toBe('***');
    expect(saved.outputs['ShortOut']).toBe('***');
    expect(saved.resources['Reader']!.noEchoLeaves).toEqual([['Value']]);
    expect(saved.resources['Short']!.properties['Value']).toBe('***');
    expect(saved.resources['Short']!.noEchoLeaves).toEqual([['Value']]);
    expect(saved.resources['PlainReader']!.properties['Value']).toBe(PLAIN);
    expect(saved.resources['PlainReader']!.noEchoLeaves ?? []).toEqual([]);
    expect(saved.outputs['PlainOut']).toBe(PLAIN);
    // The child's success segment carries its pre-deploy outputs, which the
    // parent's revert restores (nested-child-journal.ts): masked by position.
    const segments = stateBackend.appendRollbackJournalSegment!.mock.calls.map(
      (c) => c[2] as { previousOutputs?: { outputs?: Record<string, unknown> } }
    );
    const previous = segments.find((segment) => segment.previousOutputs !== undefined);
    expect(previous?.previousOutputs?.outputs).toEqual({
      TokenOut: '***',
      ShortOut: '***',
      PlainOut: PLAIN,
    });
    expect(JSON.stringify(segments)).not.toContain(TOKEN);
  });

  it('(b) records positions on a child custom resource, so its delete is skipped rather than sent ***', async () => {
    stateBackend.getState!.mockResolvedValue({ state: null, etag: undefined });
    const cr = new CustomResourceProvider();
    vi.spyOn(cr, 'create').mockResolvedValue({ physicalId: 'cr-1', attributes: {} });
    const withCr = {
      Parameters: { Token: { Type: 'String' } },
      Resources: {
        Cr: {
          Type: 'Custom::Seed',
          Properties: { ServiceToken: SERVICE_TOKEN, Password: { Ref: 'Token' } },
        },
      },
    } as unknown as CloudFormationTemplate;
    await makeEngine(inheritedFor({ Token: TOKEN }), { Token: TOKEN }, cr).deploy(STACK, withCr);
    const created = lastSaved();
    expect(created.resources['Cr']!.properties['Password']).toBe('***');
    expect(created.resources['Cr']!.noEchoLeaves).toEqual([['Password']]);

    // The parent removes the custom resource from the child.
    stateBackend.getState!.mockResolvedValue({ state: created, etag: 'e2' });
    const crDelete = vi.spyOn(cr, 'delete');
    const result = await makeEngine(inheritedFor({ Token: TOKEN }), { Token: TOKEN }, cr).deploy(STACK, {
      Parameters: { Token: { Type: 'String' } },
      Resources: {},
    } as unknown as CloudFormationTemplate);
    expect(crDelete).toHaveBeenCalledTimes(1);
    await expect(crDelete.mock.results[0]!.value).resolves.toEqual({
      outcome: 'skipped',
      reason: CR_NOECHO_PROPERTIES_SKIP_REASON,
    });
    expect(result.deleteSkipped).toBe(1);
    expect(lastSaved().resources['Cr']).toBeDefined();
  });

  it('(c) a child resource sets, and then acts on, the echo-fidelity flag of a create-only value its parent fed (go-to-k/cdkd#4656)', async () => {
    stateBackend.getState!.mockResolvedValue({ state: null, etag: undefined });
    const child = {
      Parameters: { Token: { Type: 'String' } },
      Resources: { Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: { Ref: 'Token' } } } },
    } as unknown as CloudFormationTemplate;
    provider.create.mockImplementation((_id: string, _type: string, props: Record<string, unknown>) =>
      Promise.resolve({ physicalId: `arn:aws:sns:us-east-1:1:${String(props['TopicName'])}`, attributes: {} })
    );
    provider.readCurrentState.mockImplementation((physicalId: string) =>
      Promise.resolve({ TopicName: physicalId.split(':').pop() })
    );
    await makeEngine(inheritedFor({ Token: TOKEN }), { Token: TOKEN }).deploy(STACK, child);
    const created = lastSaved();
    expect(created.resources['Topic']!.properties['TopicName']).toBe('***');
    expect(created.resources['Topic']!.noEchoExactEchoLeaves).toEqual([['TopicName']]);

    // The parent rotates the value it passes: the child replaces the topic.
    const ROTATED = `${TOKEN}-rotated`;
    stateBackend.getState!.mockResolvedValue({ state: created, etag: 'e2' });
    await makeEngine(inheritedFor({ Token: ROTATED }), { Token: ROTATED }).deploy(STACK, child);
    const creates = provider.create.mock.calls.filter((c) => c[0] === 'Topic');
    expect(creates).toHaveLength(2);
    expect((creates[1]![2] as Record<string, unknown>)['TopicName']).toBe(ROTATED);
    expect(provider.delete.mock.calls.filter((c) => c[0] === 'Topic')).toHaveLength(1);
    expect(allSaved()).not.toContain(`"${ROTATED}"`);
  });

  it('the PARENT records which child parameters its nested-stack row fills from a NoEcho source', async () => {
    stateBackend.getState!.mockResolvedValue({ state: null, etag: undefined });
    let passed: ReadonlySet<string> | undefined;
    provider.create!.mockImplementation((logicalId: string) => {
      if (logicalId === 'Child') passed = passedNoEchoParametersOf(getCurrentResourceSecrets());
      return Promise.resolve({ physicalId: `${logicalId}-phys`, attributes: {} });
    });
    await makeEngine(new Map(), {}).deploy('Parent', {
      Parameters: {
        Secret: { Type: 'String', NoEcho: true, Default: 'abc' },
        Plain: { Type: 'String', Default: 'plain-value' },
      },
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: 'https://example.invalid/child.json',
            Parameters: {
              Token: { Ref: 'Secret' },
              Embedded: { 'Fn::Sub': 'pre-${Secret}' },
              Other: { Ref: 'Plain' },
            },
          },
        },
      },
    } as unknown as CloudFormationTemplate);
    expect([...(passed ?? [])].sort()).toEqual(['Embedded', 'Token']);
  });

  it('the PARENT records them on an UPDATE of the nested-stack row too', async () => {
    const childRow = {
      physicalId: 'Parent~Child',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: {
        TemplateURL: 'https://example.invalid/child.json',
        Parameters: { Token: '***' },
      },
      attributes: {},
      dependencies: [],
      noEchoLeaves: [['Parameters', 'Token']],
    };
    stateBackend.getState!.mockResolvedValue({
      state: {
        version: 11,
        region: REGION,
        stackName: 'Parent',
        resources: { Child: childRow },
        outputs: {},
        lastModified: 0,
      },
      etag: 'e',
    });
    let passed: ReadonlySet<string> | undefined;
    provider.update!.mockImplementation((logicalId: string, physicalId: string) => {
      if (logicalId === 'Child') passed = passedNoEchoParametersOf(getCurrentResourceSecrets());
      return Promise.resolve({ physicalId, wasReplaced: false });
    });
    await makeEngine(new Map(), {}).deploy('Parent', {
      Parameters: { Secret: { Type: 'String', NoEcho: true, Default: 'abcd-new-value' } },
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: 'https://example.invalid/child.json',
            Parameters: { Token: { Ref: 'Secret' } },
          },
        },
      },
    } as unknown as CloudFormationTemplate);
    expect(provider.update).toHaveBeenCalled();
    expect([...(passed ?? [])]).toEqual(['Token']);
  });
});
